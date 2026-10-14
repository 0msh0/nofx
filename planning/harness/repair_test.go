package harness

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"nofx/planning/core"
	"nofx/planning/model"
)

type repairDraftStore struct {
	textDraftFixture
	revisions int
}

func (s *repairDraftStore) Revise(_ string, plans []core.Plan, _ time.Time) error {
	s.revisions++
	return s.Add(plans)
}
func TestPartialProposalCanRepairRejectedStructuresWithoutDuplicates(t *testing.T) {
	source := textMarketFixture{}
	store := &repairDraftStore{}
	engine := Engine{Market: source, Store: store}
	limits := core.Constraints{Equity: "10000", MaxRisk: "100", MaxNotional: "1000", MinRewardRisk: "2", FeeBPS: "10", SlippageBPS: "10"}
	input := Input{proposals: &proposalState{saved: map[string]string{}}}
	selected := &core.Record{State: "draft", Plan: core.Plan{ID: "original"}}
	limit := core.Idea{Name: "Limit", Side: "long", Entry: "1000", Stop: "990", Target: "1040", Execution: &core.Execution{Kind: "limit"}}
	ladder := limit
	ladder.Name = "Ladder"
	ladder.Execution = &core.Execution{Kind: "ladder", Levels: []core.Level{{Price: "998", Weight: "0.5"}, {Price: "1020", Weight: "0.5"}}}
	twap := limit
	twap.Name = "TWAP"
	twap.Execution = &core.Execution{Kind: "twap", Slices: 2, IntervalSeconds: 30}
	proposed := false
	var events []Event
	invoke := func(ideas ...core.Idea) (map[string]any, error) {
		args, _ := json.Marshal(map[string]any{"ideas": ideas})
		call := model.ToolCall{}
		call.Function.Name = "propose_plans"
		call.Function.Arguments = string(args)
		value, err := engine.invoke(context.Background(), input, limits, selected, call, &proposed, func(event Event) error { events = append(events, event); return nil })
		if err != nil {
			return nil, err
		}
		return value.(map[string]any), nil
	}
	first, err := invoke(limit, ladder, twap)
	if err != nil || len(first["plans"].([]core.Plan)) != 2 || len(first["rejected"].([]string)) != 1 {
		t.Fatalf("partial batch: %v %+v", err, first)
	}
	ladder.Execution.Levels[1].Price = "1000"
	second, err := invoke(ladder, limit)
	if err != nil || len(second["plans"].([]core.Plan)) != 1 || len(store.plans) != 3 || store.revisions != 1 {
		t.Fatalf("repair failed: %v %+v store=%+v", err, second, store)
	}
	limit.Name = "Renamed duplicate"
	limit.Rationale = "Different wording"
	third, err := invoke(limit)
	if err != nil || len(third["plans"].([]core.Plan)) != 0 || len(store.plans) != 3 || third["no_trade"] != false {
		t.Fatal("duplicate resaved or accepted drafts lost", err, third)
	}
	if _, err = invoke(twap); err == nil {
		t.Fatal("proposal retry budget ignored")
	}
	for _, plan := range store.plans {
		if plan.Constraints != limits {
			t.Fatal("risk limits changed")
		}
	}
	rejectedEvents := 0
	for _, event := range events {
		if event.Type == "candidate_result" && event.Data.(map[string]any)["status"] == "rejected" {
			rejectedEvents++
		}
	}
	if rejectedEvents != 1 {
		t.Fatal("rejection was not streamed", rejectedEvents)
	}
}
