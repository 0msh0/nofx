// Package core owns deterministic planning and the approval boundary.
package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"nofx/trader/execution"
	"strconv"
	"strings"
	"time"
)

// Decimal is an exact base-10 number encoded as a JSON string. No binary floats
// participate in risk calculations or quantity rounding.
type Decimal = execution.Decimal

func rat(d Decimal) (*big.Rat, error) {
	if len(d) == 0 || len(d) > 40 {
		return nil, errors.New("invalid decimal length")
	}
	for i, c := range d {
		if (c < '0' || c > '9') && c != '.' && !(i == 0 && c == '-') {
			return nil, errors.New("invalid decimal")
		}
	}
	if parts := strings.Split(string(d), "."); len(parts) > 2 || (len(parts) == 2 && len(parts[1]) > 12) {
		return nil, errors.New("decimal precision exceeds 12 places")
	}
	r, ok := new(big.Rat).SetString(string(d))
	if !ok {
		return nil, errors.New("invalid decimal")
	}
	return r, nil
}
func Positive(d Decimal) bool    { r, e := rat(d); return e == nil && r.Sign() > 0 }
func number(r *big.Rat) Decimal  { return Decimal(r.FloatString(12)) }
func add(a, b *big.Rat) *big.Rat { return new(big.Rat).Add(a, b) }
func sub(a, b *big.Rat) *big.Rat { return new(big.Rat).Sub(a, b) }
func mul(a, b *big.Rat) *big.Rat { return new(big.Rat).Mul(a, b) }
func div(a, b *big.Rat) *big.Rat { return new(big.Rat).Quo(a, b) }
func abs(a *big.Rat) *big.Rat    { return new(big.Rat).Abs(a) }
func min(a, b *big.Rat) *big.Rat {
	if a.Cmp(b) < 0 {
		return a
	}
	return b
}
func must(d Decimal) *big.Rat {
	r, e := rat(d)
	if e != nil {
		panic(e)
	}
	return r
}

// Snapshot is a single observed book, not a prediction. Rules are retrieved
// from venue instrument metadata rather than guessed from a symbol name.
type Snapshot struct {
	Venue         string    `json:"venue"`
	Symbol        string    `json:"symbol"`
	Kind          string    `json:"kind"`
	BaseAsset     string    `json:"base_asset,omitempty"`
	QuoteAsset    string    `json:"quote_asset,omitempty"`
	ContractValue Decimal   `json:"contract_value,omitempty"`
	Bid           Decimal   `json:"bid"`
	Ask           Decimal   `json:"ask"`
	BidSize       Decimal   `json:"bid_size"`
	AskSize       Decimal   `json:"ask_size"`
	Tick          Decimal   `json:"tick"`
	Step          Decimal   `json:"step"`
	MinQty        Decimal   `json:"min_qty"`
	MinNotional   Decimal   `json:"min_notional"`
	Observed      time.Time `json:"observed"`
	SourceTime    time.Time `json:"source_time,omitempty"`
}

func (s Snapshot) Validate(now time.Time) error {
	if s.Venue != "binance" && s.Venue != "okx" && s.Venue != "hyperliquid" {
		return errors.New("unsupported venue")
	}
	if s.Symbol == "" || (s.Kind != "spot" && s.Kind != "perpetual") {
		return errors.New("invalid instrument")
	}
	for _, d := range []Decimal{s.Bid, s.Ask, s.BidSize, s.AskSize, s.Tick, s.Step, s.MinQty, s.MinNotional} {
		if !Positive(d) {
			return errors.New("invalid market numbers")
		}
	}
	if s.ContractValue != "" && (!Positive(s.ContractValue) || s.Kind != "perpetual") {
		return errors.New("invalid contract value")
	}
	if must(s.Bid).Cmp(must(s.Ask)) > 0 {
		return errors.New("crossed book")
	}
	if s.Observed.IsZero() || now.Sub(s.Observed) > 15*time.Second || s.Observed.After(now.Add(time.Second)) {
		return errors.New("stale market snapshot")
	}
	if !s.SourceTime.IsZero() && now.Sub(s.SourceTime) > 15*time.Second {
		return errors.New("交易所订单簿超过 15 秒，不能用于规划或成交")
	}
	// A small forward clock difference is distinct from stale data. The local
	// machine measured ~7s behind exchange clocks; still bound the tolerance.
	if !s.SourceTime.IsZero() && s.SourceTime.After(now.Add(10*time.Second)) {
		return errors.New("交易所时间领先本机超过 10 秒，请校准系统时钟；不能用于规划或成交")
	}
	return nil
}

type Constraints struct {
	Equity        Decimal `json:"equity"`
	MaxRisk       Decimal `json:"max_risk"`
	MaxNotional   Decimal `json:"max_notional"`
	MinRewardRisk Decimal `json:"min_reward_risk"`
	FeeBPS        Decimal `json:"fee_bps"`
	SlippageBPS   Decimal `json:"slippage_bps"`
}

func (c Constraints) Validate() error {
	for _, d := range []Decimal{c.Equity, c.MaxRisk, c.MaxNotional, c.MinRewardRisk, c.FeeBPS, c.SlippageBPS} {
		if !Positive(d) {
			return errors.New("all constraints must be positive decimal strings")
		}
	}
	if must(c.MaxRisk).Cmp(must(c.Equity)) > 0 || must(c.MaxNotional).Cmp(must(c.Equity)) > 0 {
		return errors.New("MVP requires unleveraged notional and risk <= equity")
	}
	if must(c.FeeBPS).Cmp(big.NewRat(1000, 1)) > 0 || must(c.SlippageBPS).Cmp(big.NewRat(1000, 1)) > 0 {
		return errors.New("cost assumption exceeds 1000 bps")
	}
	return nil
}

type Idea struct {
	Name      string     `json:"name"`
	Side      string     `json:"side"`
	Entry     Decimal    `json:"entry"`
	Stop      Decimal    `json:"stop"`
	Target    Decimal    `json:"target"`
	Rationale string     `json:"rationale"`
	Execution *Execution `json:"execution,omitempty"`
}
type Plan struct {
	ID            string      `json:"id"`
	Hash          string      `json:"hash"`
	Snapshot      Snapshot    `json:"snapshot"`
	Constraints   Constraints `json:"constraints"`
	Idea          Idea        `json:"idea"`
	Quantity      Decimal     `json:"quantity"`
	VenueQuantity Decimal     `json:"venue_quantity,omitempty"`
	Risk          Decimal     `json:"risk"`
	Reward        Decimal     `json:"reward"`
	RewardRisk    Decimal     `json:"reward_risk"`
	Created       time.Time   `json:"created"`
	Expires       time.Time   `json:"expires"`
	Orders        []OrderSpec `json:"orders,omitempty"`
	Analysis      *Analysis   `json:"analysis,omitempty"`
}

func aligned(v, step *big.Rat) bool { return div(v, step).IsInt() }
func floorStep(v, step *big.Rat) *big.Rat {
	q := div(v, step)
	n := new(big.Int).Quo(q.Num(), q.Denom())
	return mul(new(big.Rat).SetInt(n), step)
}
func Compile(s Snapshot, c Constraints, i Idea, now time.Time) (Plan, error) {
	if i.Execution != nil {
		return compileExecution(s, c, i, now)
	}
	var p Plan
	if err := s.Validate(now); err != nil {
		return p, err
	}
	if err := c.Validate(); err != nil {
		return p, err
	}
	if i.Side != "long" && i.Side != "short" {
		return p, errors.New("side must be long or short")
	}
	if s.Kind == "spot" && i.Side == "short" {
		return p, errors.New("spot short requires inventory/margin; unsupported")
	}
	for _, d := range []Decimal{i.Entry, i.Stop, i.Target} {
		if !Positive(d) {
			return p, errors.New("invalid idea price")
		}
		if !aligned(must(d), must(s.Tick)) {
			return p, errors.New("price violates tick size")
		}
	}
	e, st, tp := must(i.Entry), must(i.Stop), must(i.Target)
	if (i.Side == "long" && (st.Cmp(e) >= 0 || tp.Cmp(e) <= 0)) || (i.Side == "short" && (st.Cmp(e) <= 0 || tp.Cmp(e) >= 0)) {
		return p, errors.New("invalid stop/target direction")
	}
	mid := div(add(must(s.Bid), must(s.Ask)), big.NewRat(2, 1))
	if div(abs(sub(e, mid)), mid).Cmp(big.NewRat(1, 10)) > 0 {
		return p, errors.New("entry more than 10% from book")
	}
	cost := div(add(must(c.FeeBPS), must(c.SlippageBPS)), big.NewRat(10000, 1))
	loss := add(abs(sub(e, st)), mul(add(e, st), cost))
	gain := sub(abs(sub(tp, e)), mul(add(e, tp), cost))
	if gain.Sign() <= 0 || div(gain, loss).Cmp(must(c.MinRewardRisk)) < 0 {
		return p, fmt.Errorf("净盈亏比 %s 低于要求 %s（已扣手续费与滑点；每单位风险 %s、净收益 %s）", number(div(gain, loss)), c.MinRewardRisk, number(loss), number(gain))
	}
	// Cap to 10% of top-level visible size: conservative instantaneous liquidity
	// constraint; this is not a guarantee of future execution or stop loss.
	liquidity := must(s.AskSize)
	if i.Side == "short" {
		liquidity = must(s.BidSize)
	}
	q := floorStep(min(min(div(must(c.MaxRisk), loss), div(must(c.MaxNotional), mul(e, add(big.NewRat(1, 1), cost)))), div(liquidity, big.NewRat(10, 1))), must(s.Step))
	if q.Cmp(must(s.MinQty)) < 0 || mul(q, e).Cmp(must(s.MinNotional)) < 0 {
		return p, fmt.Errorf("当前风险/投入/流动性约束仅允许数量 %s（金额 %s），低于交易所最小数量 %s 或最小金额 %s；当前买卖侧顶层量 %s，仅按其 10%% 限制容量。调整止盈不能解除流动性或最小订单限制", number(q), number(mul(q, e)), s.MinQty, s.MinNotional, number(liquidity))
	}
	p = Plan{Snapshot: s, Constraints: c, Idea: i, Quantity: number(q), Risk: number(mul(q, loss)), Reward: number(mul(q, gain)), RewardRisk: number(div(gain, loss)), Created: now, Expires: now.Add(60 * time.Second)}
	for _, d := range []Decimal{p.Quantity, p.Risk, p.Reward, p.RewardRisk} {
		if !Positive(d) {
			return Plan{}, errors.New("derived amount exceeds supported decimal magnitude/precision")
		}
	}
	if s.ContractValue != "" {
		p.VenueQuantity = number(div(must(p.Quantity), must(s.ContractValue)))
	}
	p.Hash = p.Digest()
	p.ID = p.Hash[:16]
	return p, nil
}
func (p Plan) Digest() string {
	p.ID = ""
	p.Hash = ""
	b, _ := json.Marshal(p)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func (p Plan) Verify(now time.Time) error {
	if p.Hash != p.Digest() || p.ID != p.Hash[:16] {
		return errors.New("plan integrity failure")
	}
	if !now.Before(p.Expires) {
		return errors.New("plan expired; replan and approve again")
	}
	rebuilt, err := Compile(p.Snapshot, p.Constraints, p.Idea, p.Created)
	if err != nil {
		return err
	}
	rebuilt, err = rebuilt.WithAnalysis(p.Analysis)
	if err != nil {
		return err
	}
	if rebuilt.Hash != p.Hash {
		return errors.New("plan calculation mismatch")
	}
	return nil
}

// Price rounds down to a valid price tick for deterministic demonstration ideas.
func Price(d Decimal, factor float64, tick Decimal) Decimal {
	if math.IsNaN(factor) || math.IsInf(factor, 0) {
		return "0"
	}
	f := must(Decimal(strconv.FormatFloat(factor, 'f', 8, 64)))
	return number(floorStep(mul(must(d), f), must(tick)))
}
func CheckBook(p Plan, s Snapshot, now time.Time) error {
	if err := s.Validate(now); err != nil {
		return err
	}
	a := p.Snapshot
	if s.Venue != a.Venue || s.Symbol != a.Symbol || s.Kind != a.Kind || s.Tick != a.Tick || s.Step != a.Step || s.MinQty != a.MinQty || s.MinNotional != a.MinNotional || s.ContractValue != a.ContractValue {
		return errors.New("instrument rules changed; replan")
	}
	quote, size := s.Ask, s.AskSize
	if p.Idea.Side == "short" {
		quote, size = s.Bid, s.BidSize
	}
	if div(abs(sub(must(quote), must(originalQuote(p)))), must(originalQuote(p))).Cmp(div(must(p.Constraints.SlippageBPS), big.NewRat(10000, 1))) > 0 {
		return fmt.Errorf("market moved beyond approved slippage; replan")
	}
	if must(p.Quantity).Cmp(div(must(size), big.NewRat(10, 1))) > 0 {
		return errors.New("insufficient visible liquidity")
	}
	return nil
}

func originalQuote(p Plan) Decimal {
	if p.Idea.Side == "short" {
		return p.Snapshot.Bid
	}
	return p.Snapshot.Ask
}
