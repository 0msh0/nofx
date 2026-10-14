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
		return fmt.Sprintf("Saved %d unapproved drafts. Review the chart and child orders; separate explicit approval is required to execute.", o.Drafts)
	}
	text := "No trade plan passed validation. No trade will be placed."
	if len(o.Rejections) > 0 {
		text += "\nConstraints checked:\n" + strings.Join(o.Rejections[max(0, len(o.Rejections)-4):], "\n")
	}
	if o.StopReason == "model_unavailable" {
		text += "\nThe model did not complete its explanation. Validated results are retained for further discussion."
	}
	if o.StopReason == "budget" {
		text += "\nThe planning budget is exhausted. Results are retained. Continue with more context if needed; risk standards are unchanged and no orders are placed automatically."
	}
	return text
}
func finishTurn(ctx context.Context, planner model.ChatPlanner, messages []model.Message, result outcome, emit Emit, explain bool) error {
	if explain && ctx.Err() == nil {
		messages = append(messages, model.Message{Role: "user", Content: "Planning is finished. Briefly explain validated results, assumptions and rejection reasons in English. Do not call tools, promise profit or claim approval/execution. If no draft passed, explicitly state no trade."})
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
			m.Content = "Prior market payload was compacted. Historical prices are not current quotes. Draft compilation and execution must validate a fresh order book."
		}
	}
	return copyMessages
}
