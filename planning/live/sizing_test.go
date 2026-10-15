package live

import (
	"nofx/planning/core"
	"testing"
	"time"
)

func TestAccountSizingUsesFreeMarginAndLeverage(t *testing.T) {
	a := Account{Equity: "100", Available: "40", FeeBPS: "12", Position: "0"}
	c, e := AccountLimits(a, core.Constraints{Leverage: 5, MinRewardRisk: "2", FeeBPS: "10", SlippageBPS: "10"})
	if e != nil {
		t.Fatal(e)
	}
	if cmp(c.MaxNotional, "195.694716242661") != 0 || cmp(c.MaxRisk, "100") != 0 || c.FeeBPS != "12" || cmp(c.AvailableMargin, "40") != 0 {
		t.Fatalf("incorrect automatic limits: %+v", c)
	}
	for _, leverage := range []int{-1, 0, 21} {
		c.Leverage = leverage
		if _, e = AccountLimits(a, c); e == nil {
			t.Fatal("invalid leverage allowed")
		}
	}
	c.Leverage = 5
	for _, position := range []core.Decimal{"0.01", "-0.02", "0"} {
		a.Position, a.OpenOrders = position, 2
		got, err := AccountLimits(a, c)
		if err != nil {
			t.Fatalf("existing exposure blocked a draft: %v", err)
		}
		if got.MaxNotional != c.MaxNotional || got.MaxRisk != c.MaxRisk {
			t.Fatal("existing exposure increased the free-margin planning budget")
		}
	}
}

func TestAutoSizingAllocatesMarginAcrossEntryStructures(t *testing.T) {
	for _, kind := range []string{"limit", "ladder", "twap"} {
		t.Run(kind, func(t *testing.T) {
			_, b, m, base := setup(t, kind)
			b.account.Equity, b.account.Available = "283.22", "283.22"
			limits, err := AccountLimits(b.account, core.Constraints{Leverage: 5, MinRewardRisk: "2", FeeBPS: "10", SlippageBPS: "10"})
			if err != nil {
				t.Fatal(err)
			}
			p, err := core.Compile(m.book, limits, base.Idea, time.Now().UTC())
			if err != nil {
				t.Fatal(err)
			}
			if cmp(p.Quantity, "0.013") < 0 || cmp(p.Risk, "2.8322") <= 0 || p.SizingLimit != "budget" {
				t.Fatalf("margin sizing still capped by a hidden risk budget: %+v", p)
			}
			if err := CheckAccountCapacity(p, b.account); err != nil {
				t.Fatal(err)
			}
			m.book.AskSize = "0.01"
			limited, err := core.Compile(m.book, limits, base.Idea, time.Now().UTC())
			if err != nil || limited.SizingLimit != "liquidity" || cmp(limited.Quantity, "0.001") > 0 {
				t.Fatalf("liquidity cap missing or unexplained: %+v %v", limited, err)
			}
		})
	}
}

func TestCapacityChecksActualOrdersInsteadOfUnusedBudget(t *testing.T) {
	p := core.Plan{Constraints: core.Constraints{Equity: "10000", MaxNotional: "1000", FeeBPS: "10", SlippageBPS: "10", Leverage: 5}, Risk: "1", Orders: []core.OrderSpec{{Price: "100", Quantity: "1"}, {Price: "100", Quantity: "1"}}}
	a := Account{Equity: "50", Available: "41"}
	if e := CheckAccountCapacity(p, a); e != nil {
		t.Fatal(e)
	}
	a.Available = "40"
	if e := CheckAccountCapacity(p, a); e == nil {
		t.Fatal("missing fee reserve accepted")
	}
	a.Available = "41"
	p.Constraints.Leverage = 1
	if e := CheckAccountCapacity(p, a); e == nil {
		t.Fatal("1x capacity exceeded")
	}
}

func TestLegacyLeverageAndBounds(t *testing.T) {
	c := core.Constraints{Equity: "100", MaxRisk: "1", MaxNotional: "500", MinRewardRisk: "2", FeeBPS: "10", SlippageBPS: "10"}
	if c.EffectiveLeverage() != 1 || c.Validate() == nil {
		t.Fatal("legacy plan changed leverage")
	}
	c.Leverage = 5
	if e := c.Validate(); e != nil {
		t.Fatal(e)
	}
	c.Leverage = 21
	if c.Validate() == nil {
		t.Fatal("leverage bound bypassed")
	}
}

func TestLegacyPlanStillVerifiesWithoutSizingMetadata(t *testing.T) {
	_, _, _, p := setup(t, "limit")
	p.SizingLimit = ""
	p.Hash = p.Digest()
	p.ID = p.Hash[:16]
	if err := p.Verify(time.Now().UTC()); err != nil {
		t.Fatal("previously saved plan no longer verifies", err)
	}
}
