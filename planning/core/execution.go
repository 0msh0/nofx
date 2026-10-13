package core

import (
	"errors"
	"fmt"
	"math/big"
	"time"
)

// Execution describes a finite, user-approved order basket, never a strategy.
// Weights apply to base quantity. TWAP uses a fixed limit cap, never market orders.
type Execution struct {
	Kind            string  `json:"kind"` // limit, ladder, twap
	Levels          []Level `json:"levels,omitempty"`
	Slices          int     `json:"slices,omitempty"`
	IntervalSeconds int     `json:"interval_seconds,omitempty"`
}
type Level struct {
	Price  Decimal `json:"price"`
	Weight Decimal `json:"weight"`
}
type OrderSpec struct {
	Index         int     `json:"index"`
	Price         Decimal `json:"price"`
	Quantity      Decimal `json:"quantity"`
	OffsetSeconds int     `json:"offset_seconds"`
	VenueQuantity Decimal `json:"venue_quantity,omitempty"`
}
type ChildOrder struct {
	Index   int       `json:"index"`
	State   string    `json:"state"` // scheduled, pending, filled, cancelled, expired
	Updated time.Time `json:"updated"`
}

func compileExecution(s Snapshot, c Constraints, i Idea, now time.Time) (Plan, error) {
	x := *i.Execution
	x.Levels = append([]Level(nil), x.Levels...)
	i.Execution = &x
	var levels []Level
	switch x.Kind {
	case "limit":
		if len(x.Levels) != 0 || x.Slices != 0 || x.IntervalSeconds != 0 {
			return Plan{}, errors.New("single limit does not accept levels or schedule")
		}
		levels = []Level{{i.Entry, "1"}}
	case "ladder":
		if len(x.Levels) < 2 || len(x.Levels) > 8 || x.Slices != 0 || x.IntervalSeconds != 0 {
			return Plan{}, errors.New("分批限价需要 2–8 档价格和数量权重，不能附带时间参数")
		}
		levels = x.Levels
		sum := new(big.Rat)
		seen := map[Decimal]bool{}
		for _, l := range levels {
			if !Positive(l.Weight) || must(l.Weight).Cmp(big.NewRat(1, 1)) > 0 || !Positive(l.Price) {
				return Plan{}, errors.New("invalid ladder weight or price")
			}
			if seen[number(must(l.Price))] {
				return Plan{}, errors.New("duplicate ladder price")
			}
			seen[number(must(l.Price))] = true
			sum = add(sum, must(l.Weight))
		}
		if sum.Cmp(big.NewRat(1, 1)) != 0 {
			return Plan{}, errors.New("分批数量权重之和必须为 1")
		}
	case "twap":
		if len(x.Levels) != 0 || x.Slices < 2 || x.Slices > 24 || x.IntervalSeconds < 5 || x.IntervalSeconds > 300 || (x.Slices-1)*x.IntervalSeconds > 3600 {
			return Plan{}, errors.New("TWAP 需要 2–24 笔，间隔 5–300 秒，总时长不超过 1 小时")
		}
		// Rational equal weights avoid approximation in base quantity allocation.
		for n := 0; n < x.Slices; n++ {
			levels = append(levels, Level{i.Entry, "1"})
		}
	default:
		return Plan{}, errors.New("unknown execution kind")
	}
	// Validate the declared chart entry and every child's stop/target and net ratio.
	base := i
	base.Execution = nil
	if _, err := Compile(s, c, base, now); err != nil {
		return Plan{}, err
	}
	lossSum, gainSum, notional := new(big.Rat), new(big.Rat), new(big.Rat)
	cost := div(add(must(c.FeeBPS), must(c.SlippageBPS)), big.NewRat(10000, 1))
	weights := []*big.Rat{}
	for n, l := range levels {
		leg := base
		leg.Entry = l.Price
		if _, err := Compile(s, c, leg, now); err != nil {
			return Plan{}, fmt.Errorf("第 %d 笔订单：%w", n+1, err)
		}
		w := must(l.Weight)
		if x.Kind == "twap" {
			w = big.NewRat(1, int64(x.Slices))
		}
		weights = append(weights, w)
		loss := add(abs(sub(must(l.Price), must(i.Stop))), mul(add(must(l.Price), must(i.Stop)), cost))
		gain := sub(abs(sub(must(i.Target), must(l.Price))), mul(add(must(l.Price), must(i.Target)), cost))
		lossSum = add(lossSum, mul(w, loss))
		gainSum = add(gainSum, mul(w, gain))
		notional = add(notional, mul(w, mul(must(l.Price), add(big.NewRat(1, 1), cost))))
	}
	liquidity := must(s.AskSize)
	if i.Side == "short" {
		liquidity = must(s.BidSize)
	}
	total := floorStep(min(min(div(must(c.MaxRisk), lossSum), div(must(c.MaxNotional), notional)), div(liquidity, big.NewRat(10, 1))), must(s.Step))
	p := Plan{Snapshot: s, Constraints: c, Idea: i, Created: now, Expires: now.Add(5 * time.Minute)}
	risk, reward, qty := new(big.Rat), new(big.Rat), new(big.Rat)
	for n, l := range levels {
		q := floorStep(mul(total, weights[n]), must(s.Step))
		if q.Cmp(must(s.MinQty)) < 0 || mul(q, must(l.Price)).Cmp(must(s.MinNotional)) < 0 {
			return Plan{}, fmt.Errorf("第 %d 笔拆分后低于交易所最小数量或金额；减少分批数或调整预算", n+1)
		}
		loss := add(abs(sub(must(l.Price), must(i.Stop))), mul(add(must(l.Price), must(i.Stop)), cost))
		gain := sub(abs(sub(must(i.Target), must(l.Price))), mul(add(must(l.Price), must(i.Target)), cost))
		offset := 0
		if x.Kind == "twap" {
			offset = n * x.IntervalSeconds
		}
		p.Orders = append(p.Orders, OrderSpec{Index: n + 1, Price: l.Price, Quantity: number(q), OffsetSeconds: offset})
		risk = add(risk, mul(q, loss))
		reward = add(reward, mul(q, gain))
		qty = add(qty, q)
	}
	p.Quantity = number(qty)
	p.Risk = number(risk)
	p.Reward = number(reward)
	p.RewardRisk = number(div(reward, risk))
	for _, d := range []Decimal{p.Quantity, p.Risk, p.Reward, p.RewardRisk} {
		if !Positive(d) {
			return Plan{}, errors.New("derived execution amount exceeds decimal limits")
		}
	}
	if s.ContractValue != "" {
		p.VenueQuantity = number(div(must(p.Quantity), must(s.ContractValue)))
		for n := range p.Orders {
			p.Orders[n].VenueQuantity = number(div(must(p.Orders[n].Quantity), must(s.ContractValue)))
		}
	}
	p.Hash = p.Digest()
	p.ID = p.Hash[:16]
	return p, nil
}
