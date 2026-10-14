package model

import (
	"context"
	"encoding/json"
	"errors"
	"nofx/mcp"
	"nofx/mcp/payment"
)

// NOFXAdapter reuses NOFX's provider, wallet billing and transient reasoning.
// Credentials remain in NOFX's configured client and never enter model messages.
type NOFXAdapter struct{ Client mcp.AIClient }

func (a *NOFXAdapter) Chat(ctx context.Context, messages []Message, tools []Tool) (Message, error) {
	wire := make([]mcp.Message, 0, len(messages))
	for _, m := range messages {
		v := mcp.Message{Role: m.Role, Content: m.Content, ToolCallID: m.ToolCallID, ReasoningContent: m.ReasoningContent}
		for _, t := range m.ToolCalls {
			v.ToolCalls = append(v.ToolCalls, mcp.ToolCall{ID: t.ID, Type: t.Type, Function: mcp.ToolCallFunction{Name: t.Function.Name, Arguments: t.Function.Arguments}})
		}
		wire = append(wire, v)
	}
	defs := []mcp.Tool{}
	for _, t := range tools {
		raw, e := json.Marshal(t.Function.Parameters)
		if e != nil {
			return Message{}, e
		}
		var schema map[string]any
		if e = json.Unmarshal(raw, &schema); e != nil {
			return Message{}, e
		}
		defs = append(defs, mcp.Tool{Type: "function", Function: mcp.FunctionDef{Name: t.Function.Name, Description: t.Function.Description, Parameters: schema}})
	}
	maxTokens := 8192
	request := &mcp.Request{Ctx: ctx, Messages: wire, Tools: defs, MaxTokens: &maxTokens}
	if len(defs) > 0 {
		request.ToolChoice = "auto"
	}
	result, e := a.Client.CallWithRequestFull(request)
	if e != nil {
		// Preserve the upstream paid-call safety classification without exposing
		// wrapped transport URLs, authorization headers or provider response bodies.
		var unknown *payment.PaymentOutcomeUnknownError
		if errors.As(e, &unknown) {
			return Message{}, errors.New(unknown.Error())
		}
		var rejected *payment.PaymentVerificationRejectedError
		if errors.As(e, &rejected) {
			return Message{}, errors.New("本次付费验证被拒绝，不会自动重试；请检查报价、模型费用钱包及客户端版本。此前请求仍可能已扣款。")
		}
		if ctx.Err() != nil {
			return Message{}, ctx.Err()
		}
		return Message{}, errors.New("NOFX AI 请求失败；请检查模型账户余额或连接，确认付款状态后再操作")
	}
	if result == nil || len(result.Content) > 24000 || len(result.ToolCalls) > 5 || len(result.ReasoningContent) > 256<<10 {
		return Message{}, errors.New("invalid NOFX AI response")
	}
	out := Message{Role: "assistant", Content: result.Content, ReasoningContent: result.ReasoningContent}
	for _, t := range result.ToolCalls {
		call := ToolCall{ID: t.ID, Type: t.Type}
		call.Function.Name = t.Function.Name
		call.Function.Arguments = t.Function.Arguments
		out.ToolCalls = append(out.ToolCalls, call)
	}
	if out.Content == "" && len(out.ToolCalls) == 0 {
		return Message{}, errors.New("NOFX AI did not return a final answer or a tool request")
	}
	return out, nil
}
