package hyperliquid

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	hl "github.com/sonirico/go-hyperliquid"
	"math/big"
	"nofx/planning/core"
	"nofx/planning/live"
	"strconv"
	"strings"
)

type PlanningBroker struct{ Trader *HyperliquidTrader }

func (b *PlanningBroker) Venue() string { return "hyperliquid" }

func (b *PlanningBroker) exchange(symbol string) (*hl.Exchange, string, error) {
	coin := convertSymbolToHyperliquid(symbol)
	if strings.Contains(coin, ":") && !strings.HasPrefix(coin, "xyz:") {
		return nil, coin, errors.New("planning execution supports core perps and xyz HIP-3 only")
	}
	ex, e := b.Trader.leverageExchange(coin)
	return ex, coin, e
}
func (b *PlanningBroker) Account(ctx context.Context, symbol string) (live.Account, error) {
	out := live.Account{Position: "0"}
	ex, coin, e := b.exchange(symbol)
	if e != nil {
		return out, e
	}
	request := map[string]any{"type": "clearinghouseState", "user": b.Trader.walletAddr}
	if strings.HasPrefix(coin, "xyz:") {
		request["dex"] = "xyz"
	}
	raw, e := b.Trader.directPlanningInfo(ctx, request)
	if e != nil {
		return out, e
	}
	var state struct {
		MarginSummary struct {
			AccountValue string `json:"accountValue"`
		} `json:"marginSummary"`
		Withdrawable   string `json:"withdrawable"`
		AssetPositions []struct {
			Position struct {
				Coin string `json:"coin"`
				Size string `json:"szi"`
			} `json:"position"`
		} `json:"assetPositions"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return out, errors.New("invalid Hyperliquid account state")
	}
	out.Equity = core.Decimal(state.MarginSummary.AccountValue)
	out.Available = core.Decimal(state.Withdrawable)
	qty := new(big.Rat)
	for _, p := range state.AssetPositions {
		if p.Position.Coin == coin {
			n, ok := new(big.Rat).SetString(p.Position.Size)
			if !ok {
				return out, errors.New("invalid Hyperliquid position size")
			}
			qty.Add(qty, n.Abs(n))
		}
	}
	out.Position = core.Decimal(qty.FloatString(12))
	orders, e := ex.Info().OpenOrders(ctx, b.Trader.walletAddr, func() string {
		if strings.HasPrefix(coin, "xyz:") {
			return "xyz"
		}
		return ""
	}())
	if e != nil {
		return out, errors.New("Hyperliquid open orders unavailable")
	}
	for _, o := range orders {
		if o.Coin == coin {
			out.OpenOrders++
		}
	}
	fees, e := ex.Info().UserFees(ctx, b.Trader.walletAddr)
	if e != nil {
		return out, errors.New("Hyperliquid fee rate unavailable")
	}
	a, ok := new(big.Rat).SetString(fees.UserCrossRate)
	if !ok {
		return out, errors.New("invalid Hyperliquid fee rate")
	}
	m, ok := new(big.Rat).SetString(fees.UserAddRate)
	if !ok {
		return out, errors.New("invalid Hyperliquid maker fee")
	}
	if m.Cmp(a) > 0 {
		a = m
	}
	a.Mul(a, big.NewRat(10000, 1))
	a.Add(a, big.NewRat(5, 1))
	out.FeeBPS = core.Decimal(a.FloatString(12))
	return out, nil
}
func (b *PlanningBroker) Prepare(ctx context.Context, symbol string) error {
	if e := b.Trader.CheckTradingAuthorization(); e != nil {
		return e
	}
	ex, coin, e := b.exchange(symbol)
	if e != nil {
		return e
	}
	_, e = ex.UpdateLeverage(ctx, 1, coin, true)
	return e
}
func (b *PlanningBroker) Place(ctx context.Context, o live.Order) (live.Order, error) {
	if e := b.Trader.CheckTradingAuthorization(); e != nil {
		return o, e
	}
	ex, coin, e := b.exchange(o.Symbol)
	if e != nil {
		return o, e
	}
	if len(o.ClientID) != 32 || !core.Positive(o.Price) || !core.Positive(o.Quantity) || (o.Side != "long" && o.Side != "short") {
		return o, errors.New("invalid locked order")
	}
	qty, e := strconv.ParseFloat(string(o.Quantity), 64)
	if e != nil {
		return o, e
	}
	price, e := strconv.ParseFloat(string(o.Price), 64)
	if e != nil {
		return o, e
	}
	rounded, e := b.Trader.roundOrderPrice(coin, price)
	if e != nil || rounded != price || b.Trader.roundToSzDecimals(coin, qty) != qty {
		return o, errors.New("exchange rounding would change the approved price or quantity")
	}
	client := "0x" + o.ClientID
	buy := o.Side == "long"
	typ := hl.OrderType{Limit: &hl.LimitOrderType{Tif: hl.TifGtc}}
	reduce := false
	if o.Role != "entry" {
		buy = !buy
		reduce = true
		if o.Role != "sl" && o.Role != "tp" {
			return o, errors.New("invalid protective role")
		}
		typ = hl.OrderType{Trigger: &hl.TriggerOrderType{TriggerPx: price, IsMarket: true, Tpsl: hl.Tpsl(o.Role)}}
	}
	receipt, e := ex.Order(ctx, hl.CreateOrderRequest{Coin: coin, IsBuy: buy, Price: price, Size: qty, ReduceOnly: reduce, ClientOrderID: &client, OrderType: typ}, defaultBuilder)
	if e != nil {
		return o, errors.New("Hyperliquid 提交回报未确认，请按 cloid 核对，不重发")
	}
	if receipt.Error != nil {
		return o, fmt.Errorf("Hyperliquid rejected locked %s order", o.Role)
	}
	if receipt.Resting != nil && receipt.Resting.Oid > 0 {
		o.OrderID = fmt.Sprint(receipt.Resting.Oid)
		o.Status = "NEW"
		o.Filled = "0"
		return o, nil
	}
	if receipt.Filled != nil && receipt.Filled.Oid > 0 {
		o.OrderID = fmt.Sprint(receipt.Filled.Oid)
		o.Status = "FILLED"
		o.Filled = core.Decimal(receipt.Filled.TotalSz)
		o.Average = core.Decimal(receipt.Filled.AvgPx)
		return o, nil
	}
	return o, errors.New("Hyperliquid acknowledgement has no native order ID")
}
func (b *PlanningBroker) Lookup(ctx context.Context, o live.Order) (live.Order, error) {
	ex, coin, e := b.exchange(o.Symbol)
	if e != nil {
		return o, e
	}
	r, e := ex.Info().QueryOrderByCloid(ctx, b.Trader.walletAddr, "0x"+o.ClientID)
	if e != nil || r.Status != hl.OrderQueryStatusSuccess {
		return o, errors.New("Hyperliquid 订单尚未确认；unknownOid 不能当成已成交")
	}
	native := r.Order.Order
	if native.Oid <= 0 || native.Coin != coin || native.Cloid == nil || *native.Cloid != "0x"+o.ClientID {
		return o, errors.New("Hyperliquid order identity mismatch")
	}
	o.OrderID = fmt.Sprint(native.Oid)
	total, ok := new(big.Rat).SetString(native.OrigSz)
	expected, expectedOK := new(big.Rat).SetString(string(o.Quantity))
	if !ok || !expectedOK || total.Cmp(expected) != 0 {
		return o, errors.New("invalid original size")
	}
	left, ok := new(big.Rat).SetString(native.Sz)
	if !ok {
		return o, errors.New("invalid remaining size")
	}
	filled := new(big.Rat).Sub(total, left)
	if filled.Sign() < 0 {
		return o, errors.New("inconsistent Hyperliquid fill size")
	}
	previousFilled := o.Filled
	o.Filled = core.Decimal(filled.FloatString(12))
	switch string(r.Order.Status) {
	case "open":
		o.Status = "NEW"
		if filled.Sign() > 0 {
			o.Status = "PARTIALLY_FILLED"
		}
	case "filled":
		o.Status = "FILLED"
		o.Filled = core.Decimal(total.FloatString(12))
	case "canceled", "marginCanceled", "vaultWithdrawalCanceled", "openInterestCapCanceled", "selfTradeCanceled", "reduceOnlyCanceled", "siblingFilledCanceled", "delistedCanceled":
		o.Status = "CANCELED"
	case "triggered":
		o.Status = "TRIGGERED"
		o.Filled = previousFilled // Trigger acknowledgement is not a confirmed fill.
	default:
		if strings.HasSuffix(string(r.Order.Status), "Rejected") {
			o.Status = "REJECTED"
		} else {
			return o, errors.New("unknown Hyperliquid order state")
		}
	}
	return o, nil
}
func (b *PlanningBroker) Cancel(ctx context.Context, o live.Order) error {
	ex, coin, e := b.exchange(o.Symbol)
	if e != nil {
		return e
	}
	r, e := ex.CancelByCloid(ctx, coin, "0x"+o.ClientID)
	if e != nil || r == nil || !r.Ok {
		return errors.New("Hyperliquid cancellation not confirmed")
	}
	for _, s := range r.Data.Statuses {
		if value, ok := s.String(); !ok || value != "success" {
			return errors.New("Hyperliquid cancellation rejected")
		}
	}
	if len(r.Data.Statuses) != 1 {
		return errors.New("missing cancellation receipt")
	}
	return nil
}
