package harness

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"nofx/planning/model"
)

// Budget bounds user-initiated deliberation, not the number of risk failures.
// The final model round is reserved for a tool-free explanation.
type Budget struct {
	MaxRounds    int `json:"max_rounds"`
	MaxToolCalls int `json:"max_tool_calls"`
}

func (b Budget) normalized() (Budget, error) {
	if b.MaxRounds == 0 {
		b.MaxRounds = 8
	}
	if b.MaxToolCalls == 0 {
		b.MaxToolCalls = 24
	}
	if b.MaxRounds < 2 || b.MaxRounds > 12 || b.MaxToolCalls < 1 || b.MaxToolCalls > 40 {
		return b, errors.New("invalid harness resource budget")
	}
	return b, nil
}

type outcome struct {
	Drafts     int      `json:"drafts"`
	Rejections []string `json:"rejections"`
	StopReason string   `json:"stop_reason"`
}

func (o outcome) summary() string {
	if o.Drafts > 0 {
		return fmt.Sprintf("已保存 %d 个未批准草案。请在图表和子订单表中复核；需要你另行明确批准并提交。", o.Drafts)
	}
	text := "当前没有通过约束的交易方案，本次不交易。"
	if len(o.Rejections) > 0 {
		text += "\n已检查的限制：\n" + strings.Join(o.Rejections[max(0, len(o.Rejections)-4):], "\n")
	}
	if o.StopReason == "model_unavailable" {
		text += "\n模型暂未完成进一步解释，以上验证结果已保留，可继续讨论。"
	}
	if o.StopReason == "budget" {
		text += "\n本次推演资源已用完，以上结果已保留。你可以补充想法继续；不会自动降低风险标准或下单。"
	}
	return text
}
func finishTurn(ctx context.Context, planner model.ChatPlanner, messages []model.Message, result outcome, emit Emit, explain bool) error {
	if explain && ctx.Err() == nil {
		messages = append(messages, model.Message{Role: "user", Content: "推演阶段结束。仅根据已验证的工具结果，简短解释当前行情假设、失败原因或已保存草案。禁止继续调用工具、承诺获利或声称已批准/执行。没有通过的草案就明确不交易。"})
		answer, err := chatWithProgress(ctx, planner, messages, nil, emit)
		if err == nil && len(answer.ToolCalls) == 0 && answer.Content != "" {
			if err = emit(Event{"assistant", map[string]string{"message": answer.Content}}); err != nil {
				return err
			}
			return emit(Event{"outcome", result})
		}
	}
	if err := emit(Event{"assistant", map[string]string{"message": result.summary()}}); err != nil {
		return err
	}
	return emit(Event{"outcome", result})
}

// Remove stale read payloads while keeping assistant-call/tool-result pairing.
// Validation feedback is never removed here; exact plan authority stays outside LLM context.
func compactToolContext(messages []model.Message) []model.Message {
	total := 0
	for _, m := range messages {
		total += len(m.Content)
	}
	if total < 64000 {
		return messages
	}
	copyMessages := append([]model.Message(nil), messages...)
	names := map[string]string{}
	for _, m := range messages {
		for _, call := range m.ToolCalls {
			names[call.ID] = call.Function.Name
		}
	}
	keep := 0
	for n := len(copyMessages) - 1; n >= 0; n-- {
		m := &copyMessages[n]
		if m.Role != "tool" {
			continue
		}
		name := names[m.ToolCallID]
		if name != "get_market" && name != "get_candles" {
			continue
		}
		keep++
		if keep > 2 {
			m.Content = "此前读取的行情载荷已清理。历史价格不是当前报价；草案编译和执行必须重新验证当前订单簿。"
		}
	}
	return copyMessages
}
