package live

import (
	"nofx/planning/core"
	"testing"
)

func TestAccountSizingUsesFreeMarginAndLeverage(t *testing.T) {
	a := Account{Equity: "100", Available: "40", FeeBPS: "12", Position: "0"}
	c, e := AccountLimits(a, core.Constraints{Leverage: 5, MinRewardRisk: "2", FeeBPS: "10", SlippageBPS: "10"})
	if e != nil {
		t.Fatal(e)
	}
	if cmp(c.MaxNotional, "185.909980430528") != 0 || cmp(c.MaxRisk, "1") != 0 || c.FeeBPS != "12" {
		t.Fatalf("incorrect automatic limits: %+v", c)
	}
	for _, leverage := range []int{-1, 0, 21} {
		c.Leverage = leverage
		if _, e = AccountLimits(a, c); e == nil {
			t.Fatal("invalid leverage allowed")
		}
	}
	c.Leverage = 5
	a.OpenOrders = 1
	if _, e = AccountLimits(a, c); e == nil {
		t.Fatal("existing orders allowed")
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
