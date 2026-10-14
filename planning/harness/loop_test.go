package harness

import (
	"context"
	"errors"
	"fmt"
	"nofx/planning/core"
	"nofx/planning/market"
	"nofx/planning/model"
	"testing"
	"time"
)

type loopFixture struct {
	reads int
	chats int
}

func (f *loopFixture) Snapshot(context.Context, string, string) (core.Snapshot, error) {
	return core.Snapshot{}, nil
}
func (f *loopFixture) Candles(_ context.Context, q market.CandleQuery) ([]market.Candle, error) {
	f.reads++
	return []market.Candle{{Time: time.Now().Add(-time.Hour).Unix(), Open: "100", High: "101", Low: "99", Close: "100", Volume: "1"}}, nil
}
func (f *loopFixture) Chat(_ context.Context, _ []model.Message, tools []model.Tool) (model.Message, error) {
	f.chats++
	if len(tools) == 0 {
		return model.Message{Role: "assistant", Content: "No validated plan was saved. No trade."}, nil
	}
	c := model.ToolCall{ID: fmt.Sprint("call_", f.chats), Type: "function"}
	c.Function.Name = "get_candles"
	if f.chats%2 == 0 {
		c.Function.Arguments = `{ "limit": 1, "interval":"1h" }`
	} else {
		c.Function.Arguments = `{"interval":"1h","limit":1}`
	}
	return model.Message{Role: "assistant", ToolCalls: []model.ToolCall{c}}, nil
}
func TestRepeatedReadLoopTerminatesWithOutcome(t *testing.T) {
	f := &loopFixture{}
	engine := Engine{Market: f, Charts: f, Model: f, Limits: core.Constraints{Equity: "1000", MaxRisk: "10", MaxNotional: "100", MinRewardRisk: "2", FeeBPS: "10", SlippageBPS: "10"}}
	events := []string{}
	err := engine.Run(context.Background(), Input{Message: "plan a trade", Venue: "binance", Symbol: "BTCUSDT", Interval: "1h"}, func(e Event) error { events = append(events, e.Type); return nil })
	if err != nil {
		t.Fatal(err)
	}
	// Four context reads (including a pagination check), then one additional raw request; duplicate requests
	// with reordered JSON must not fetch again or consume all eight model rounds.
	if f.reads != 5 || f.chats != 4 {
		t.Fatalf("unexpected loop: reads=%d chats=%d", f.reads, f.chats)
	}
	if len(events) < 2 || events[len(events)-1] != "outcome" {
		t.Fatal("missing terminal explanation", events)
	}
}

type stalledModel struct{}

func (stalledModel) Chat(ctx context.Context, _ []model.Message, _ []model.Tool) (model.Message, error) {
	<-ctx.Done()
	return model.Message{}, ctx.Err()
}
func TestStalledModelRespectsCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err := chatWithProgress(ctx, stalledModel{}, nil, nil, func(Event) error { return nil })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
