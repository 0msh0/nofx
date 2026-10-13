package binance

import (
	"context"
	"errors"
	"fmt"
	"github.com/adshao/go-binance/v2/futures"
	"math/big"
	"net/http"
	"nofx/planning/core"
	"nofx/planning/live"
	"time"
)

// PlanningBroker never changes position mode at construction, never substitutes
// a market order, and never retries an ambiguous create request.
type PlanningBroker struct {
	Client *futures.Client
	Hedge  bool
}

func (b *PlanningBroker) Venue() string { return "binance" }

func NewPlanningBroker(key, secret string) *PlanningBroker {
	c := futures.NewClient(key, secret)
	c.HTTPClient = &http.Client{Timeout: 20 * time.Second}
	return &PlanningBroker{Client: c}
}
func ratString(s string) (*big.Rat, error) {
	n, ok := new(big.Rat).SetString(s)
	if !ok {
		return nil, errors.New("invalid exchange decimal")
	}
	return n, nil
}
func sameNativeDecimal(a, b string) bool {
	x, e := ratString(a)
	if e != nil {
		return false
	}
	y, e := ratString(b)
	return e == nil && x.Cmp(y) == 0
}
func (b *PlanningBroker) Account(ctx context.Context, symbol string) (live.Account, error) {
	var out live.Account
	out.Position = "0"
	account, e := b.Client.NewGetAccountService().Do(ctx)
	if e != nil {
		return out, errors.New("Binance 账户读取失败")
	}
	if !account.CanTrade || account.MultiAssetsMargin {
		return out, errors.New("账户不可交易或为未支持的多资产保证金模式")
	}
	out.Equity = core.Decimal(account.TotalMarginBalance)
	out.Available = core.Decimal(account.AvailableBalance)
	qty := new(big.Rat)
	for _, p := range account.Positions {
		if p.Symbol == symbol {
			n, e := ratString(p.PositionAmt)
			if e != nil {
				return out, e
			}
			qty.Add(qty, n.Abs(n))
		}
	}
	out.Position = core.Decimal(qty.FloatString(12))
	orders, e := b.Client.NewListOpenOrdersService().Symbol(symbol).Do(ctx)
	if e != nil {
		return out, errors.New("Binance 未成交订单读取失败")
	}
	algos, e := b.Client.NewListOpenAlgoOrdersService().Symbol(symbol).Do(ctx)
	if e != nil {
		return out, errors.New("Binance 保护订单读取失败")
	}
	out.OpenOrders = len(orders) + len(algos)
	fee, e := b.Client.NewCommissionRateService().Symbol(symbol).Do(ctx)
	if e != nil {
		return out, errors.New("Binance 实际手续费读取失败")
	}
	maker, e := ratString(fee.MakerCommissionRate)
	if e != nil {
		return out, e
	}
	taker, e := ratString(fee.TakerCommissionRate)
	if e != nil {
		return out, e
	}
	if maker.Cmp(taker) > 0 {
		taker = maker
	}
	out.FeeBPS = core.Decimal(new(big.Rat).Mul(taker, big.NewRat(10000, 1)).FloatString(12))
	return out, nil
}
func (b *PlanningBroker) Prepare(ctx context.Context, symbol string) error {
	mode, e := b.Client.NewGetPositionModeService().Do(ctx)
	if e != nil {
		return errors.New("cannot verify Binance position mode")
	}
	b.Hedge = mode.DualSidePosition
	if _, e = b.Client.NewChangeLeverageService().Symbol(symbol).Leverage(1).Do(ctx); e != nil {
		return errors.New("cannot set the approved 1x leverage; order blocked")
	}
	return nil
}
func (b *PlanningBroker) position(side string) futures.PositionSideType {
	if !b.Hedge {
		return futures.PositionSideTypeBoth
	}
	if side == "long" {
		return futures.PositionSideTypeLong
	}
	return futures.PositionSideTypeShort
}
func (b *PlanningBroker) Place(ctx context.Context, o live.Order) (live.Order, error) {
	if len(o.ClientID) != 32 || !core.Positive(o.Price) || !core.Positive(o.Quantity) || (o.Side != "long" && o.Side != "short") {
		return o, errors.New("invalid locked order")
	}
	mode, e := b.Client.NewGetPositionModeService().Do(ctx)
	if e != nil {
		return o, errors.New("position mode unavailable")
	}
	b.Hedge = mode.DualSidePosition
	side := futures.SideTypeBuy
	if o.Side == "short" {
		side = futures.SideTypeSell
	}
	if o.Role != "entry" {
		if side == futures.SideTypeBuy {
			side = futures.SideTypeSell
		} else {
			side = futures.SideTypeBuy
		}
	}
	if o.Role == "entry" {
		r, e := b.Client.NewCreateOrderService().Symbol(o.Symbol).Side(side).PositionSide(b.position(o.Side)).Type(futures.OrderTypeLimit).TimeInForce(futures.TimeInForceTypeGTC).Price(string(o.Price)).Quantity(string(o.Quantity)).NewClientOrderID(o.ClientID).Do(ctx)
		if e != nil {
			return o, errors.New("Binance 入场回报未确认，请按 client ID 核对")
		}
		if r.OrderID <= 0 || r.ClientOrderID != o.ClientID || r.Symbol != o.Symbol || !sameNativeDecimal(r.OrigQuantity, string(o.Quantity)) || !sameNativeDecimal(r.Price, string(o.Price)) || r.Side != side || r.Type != futures.OrderTypeLimit || r.TimeInForce != futures.TimeInForceTypeGTC {
			return o, errors.New("invalid Binance order receipt")
		}
		o.OrderID = fmt.Sprint(r.OrderID)
		o.Status = string(r.Status)
		o.Filled = core.Decimal(r.ExecutedQuantity)
		o.Average = core.Decimal(r.AvgPrice)
		return o, nil
	}
	typ := futures.AlgoOrderTypeStopMarket
	if o.Role == "tp" {
		typ = futures.AlgoOrderTypeTakeProfitMarket
	} else if o.Role != "sl" {
		return o, errors.New("unsupported protective order")
	}
	service := b.Client.NewCreateAlgoOrderService().Symbol(o.Symbol).Side(side).PositionSide(b.position(o.Side)).Type(typ).Quantity(string(o.Quantity)).TriggerPrice(string(o.Price)).WorkingType(futures.WorkingTypeContractPrice).ClientAlgoId(o.ClientID)
	if !b.Hedge {
		service.ReduceOnly(true)
	}
	r, e := service.Do(ctx)
	if e != nil {
		return o, errors.New("Binance 保护订单回报未确认")
	}
	if r.AlgoId <= 0 || r.ClientAlgoId != o.ClientID || r.Symbol != o.Symbol || !sameNativeDecimal(r.Quantity, string(o.Quantity)) || !sameNativeDecimal(r.TriggerPrice, string(o.Price)) || r.Side != side || r.OrderType != typ || (!b.Hedge && !r.ReduceOnly) {
		return o, errors.New("invalid Binance protection receipt")
	}
	o.OrderID = fmt.Sprint(r.AlgoId)
	o.Status = "NEW"
	o.Filled = "0"
	return o, nil
}
func (b *PlanningBroker) Lookup(ctx context.Context, o live.Order) (live.Order, error) {
	if o.Role != "entry" {
		r, e := b.Client.NewGetAlgoOrderService().ClientAlgoID(o.ClientID).Do(ctx)
		if e != nil {
			return o, errors.New("Binance 保护订单查询未确认")
		}
		if r.AlgoId <= 0 || r.ClientAlgoId != o.ClientID || r.Symbol != o.Symbol || !sameNativeDecimal(r.Quantity, string(o.Quantity)) || !sameNativeDecimal(r.TriggerPrice, string(o.Price)) {
			return o, errors.New("protection identity mismatch")
		}
		o.OrderID = fmt.Sprint(r.AlgoId)
		if r.ActualOrderId != "" && r.ActualOrderId != "0" {
			id, ok := new(big.Int).SetString(r.ActualOrderId, 10)
			if !ok || !id.IsInt64() {
				return o, errors.New("invalid triggered order ID")
			}
			fill, e := b.Client.NewGetOrderService().Symbol(o.Symbol).OrderID(id.Int64()).Do(ctx)
			if e != nil {
				return o, errors.New("triggered fill not yet confirmed")
			}
			o.Status = string(fill.Status)
			o.Filled = core.Decimal(fill.ExecutedQuantity)
			o.Average = core.Decimal(fill.AvgPrice)
			return o, nil
		}
		switch r.AlgoStatus {
		case "NEW":
			o.Status = "NEW"
		case "CANCELED":
			o.Status = "CANCELED"
		case "REJECTED":
			o.Status = "REJECTED"
		case "EXPIRED":
			o.Status = "EXPIRED"
		default:
			return o, errors.New("unknown Binance algo state")
		}
		return o, nil
	}
	r, e := b.Client.NewGetOrderService().Symbol(o.Symbol).OrigClientOrderID(o.ClientID).Do(ctx)
	if e != nil {
		return o, errors.New("Binance 订单查询未确认；查不到不代表成交")
	}
	if r.OrderID <= 0 || r.ClientOrderID != o.ClientID || r.Symbol != o.Symbol || !sameNativeDecimal(r.OrigQuantity, string(o.Quantity)) || !sameNativeDecimal(r.Price, string(o.Price)) {
		return o, errors.New("order identity mismatch")
	}
	o.OrderID = fmt.Sprint(r.OrderID)
	o.Status = string(r.Status)
	o.Filled = core.Decimal(r.ExecutedQuantity)
	o.Average = core.Decimal(r.AvgPrice)
	return o, nil
}
func (b *PlanningBroker) Cancel(ctx context.Context, o live.Order) error {
	if o.Role == "entry" {
		r, e := b.Client.NewCancelOrderService().Symbol(o.Symbol).OrigClientOrderID(o.ClientID).Do(ctx)
		if e != nil || r.ClientOrderID != o.ClientID {
			return errors.New("Binance 撤销入场未确认")
		}
		return nil
	}
	r, e := b.Client.NewCancelAlgoOrderService().ClientAlgoID(o.ClientID).Do(ctx)
	if e != nil || r.ClientAlgoId != o.ClientID {
		return errors.New("Binance 撤销保护单未确认")
	}
	return nil
}
