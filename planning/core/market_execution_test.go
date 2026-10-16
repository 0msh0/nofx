package core

import "testing"

func TestMarketUsesExecutableBookAndConservativeRisk(t *testing.T) {
	for _, side := range []string{"long", "short"} {
		t.Run(side, func(t *testing.T) {
			s, c, i, now := fixture()
			s.Kind = "perpetual"
			i.Side = side
			i.Entry = "1"
			i.Execution = &Execution{Kind: "market"}
			reference, bound := s.Ask, Decimal("100100.000000000000")
			if side == "short" {
				i.Stop = "101000"
				i.Target = "95000"
				reference = s.Bid
				bound = "99900.000000000000"
			}
			p, err := Compile(s, c, i, now)
			if err != nil {
				t.Fatal(err)
			}
			if p.Idea.Entry != reference || len(p.Orders) != 1 || p.Orders[0].Price != bound || p.Orders[0].OffsetSeconds != 0 {
				t.Fatalf("wrong market intent: %+v", p)
			}
			if err = p.Verify(now); err != nil {
				t.Fatal(err)
			}
			estimate := i
			estimate.Execution = nil
			estimate.Entry = bound
			riskPlan, err := Compile(s, c, estimate, now)
			if err != nil || riskPlan.Risk != p.Risk || riskPlan.Quantity != p.Quantity {
				t.Fatal("market risk is not sized from the conservative execution estimate", err)
			}
			p.Idea.Execution.Kind = "limit"
			if p.Verify(now) == nil {
				t.Fatal("execution type changed without invalidating approval")
			}
		})
	}
}
func TestMarketRejectsInvalidContextAndUnsupportedExecution(t *testing.T) {
	for _, change := range []func(*Snapshot, *Constraints, *Idea){
		func(s *Snapshot, c *Constraints, i *Idea) { s.Venue = "okx" },
		func(s *Snapshot, c *Constraints, i *Idea) { s.Kind = "spot" },
		func(s *Snapshot, c *Constraints, i *Idea) { s.Ask = "invalid" },
		func(s *Snapshot, c *Constraints, i *Idea) { c.SlippageBPS = "invalid" },
		func(s *Snapshot, c *Constraints, i *Idea) { i.Execution.Slices = 2 },
		func(s *Snapshot, c *Constraints, i *Idea) { i.Stop = "100200" },
	} {
		s, c, i, now := fixture()
		s.Kind = "perpetual"
		i.Execution = &Execution{Kind: "market"}
		change(&s, &c, &i)
		if _, err := Compile(s, c, i, now); err == nil {
			t.Fatal("invalid market execution accepted")
		}
	}
}
