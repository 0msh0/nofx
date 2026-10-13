package model

import (
	"context"
	"encoding/json"
	"nofx/mcp"
	"strings"
	"testing"
)

type fakeNOFX struct {
	mcp.AIClient
	req      *mcp.Request
	response *mcp.LLMResponse
}

func (f *fakeNOFX) CallWithRequestFull(r *mcp.Request) (*mcp.LLMResponse, error) {
	f.req = r
	return f.response, nil
}
func TestNOFXAdapterPreservesToolRoundTripAndPrivateReasoning(t *testing.T) {
	f := &fakeNOFX{response: &mcp.LLMResponse{Content: "answer", ReasoningContent: "private reasoning", ToolCalls: []mcp.ToolCall{{ID: "call1", Type: "function", Function: mcp.ToolCallFunction{Name: "read_market", Arguments: `{}`}}}}}
	a := NOFXAdapter{Client: f}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out, e := a.Chat(ctx, []Message{{Role: "assistant", ReasoningContent: "prior private"}, {Role: "tool", ToolCallID: "call0", Content: "observed"}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	if f.req.Ctx != ctx || f.req.Messages[0].ReasoningContent != "prior private" || f.req.Messages[1].ToolCallID != "call0" || out.ToolCalls[0].ID != "call1" {
		t.Fatal("tool protocol lost")
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "private reasoning") {
		t.Fatal("reasoning leaked to persisted chat")
	}
}
func TestNOFXAdapterRejectsEmptyAndOversizedResponses(t *testing.T) {
	for _, r := range []*mcp.LLMResponse{nil, {}, {Content: strings.Repeat("x", 24001)}} {
		a := NOFXAdapter{Client: &fakeNOFX{response: r}}
		if _, e := a.Chat(context.Background(), nil, nil); e == nil {
			t.Fatal("invalid response accepted")
		}
	}
}
