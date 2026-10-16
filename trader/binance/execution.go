package binance

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/adshao/go-binance/v2/futures"
	"math/big"
	"net/http"
	"nofx/hook"
	"nofx/trader/execution"
	"time"
)

// RouteClientID retains all 128 bits of the durable ID and shares NOFX's
// Binance attribution prefix. Raw URL base64 needs 22 characters, so the
// complete tagged ID fits the existing 32-character bound without truncation.
func (b *FuturesTrader) RouteClientID(id string) (string, error) {
	raw, e := hex.DecodeString(id)
	if e != nil || len(raw) != 16 {
		return "", errors.New("invalid execution client ID")
	}
	return futuresBrokerPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
}
func (b *FuturesTrader) nativeClientID(o execution.Order) (string, error) {
	if o.VenueClientID == "" {
		return o.ClientID, nil
	} // Historical untagged orders: query their original ID only.
	expected, e := b.RouteClientID(o.ClientID)
	if e != nil || expected != o.VenueClientID {
		return "", errors.New("persisted Broker route mismatch")
	}
	return expected, nil
}

func (b *FuturesTrader) Venue() string { return "binance" }

// NewExecutionTrader initializes NOFX without changing exchange account settings.
func NewExecutionTrader(key, secret, userID string) *FuturesTrader {
	c := futures.NewClient(key, secret)
	c.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	if result := hook.HookExec[hook.NewBinanceTraderResult](hook.NEW_BINANCE_TRADER, userID, c); result != nil && result.GetResult() != nil {
		c = result.GetResult()
	}
	return &FuturesTrader{client: c, cacheDuration: 15 * time.Second}
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
func (b *FuturesTrader) AccountSnapshot(ctx context.Context, symbol string) (execution.Account, error) {
	var out execution.Account
	out.Position = "0"
	account, e := b.client.NewGetAccountService().Do(ctx)
	if e != nil {
		return out, errors.New("Could not read the Binance account")
	}
	if !account.CanTrade || account.MultiAssetsMargin {
		return out, errors.New("Account cannot trade or uses unsupported multi-asset margin")
	}
	out.Equity = execution.Decimal(account.TotalMarginBalance)
	out.Available = execution.Decimal(account.AvailableBalance)
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
	out.Position = execution.Decimal(qty.FloatString(12))
	orders, e := b.client.NewListOpenOrdersService().Symbol(symbol).Do(ctx)
	if e != nil {
		return out, errors.New("Could not read Binance open orders")
	}
	algos, e := b.client.NewListOpenAlgoOrdersService().Symbol(symbol).Do(ctx)
	if e != nil {
		return out, errors.New("Could not read Binance protective orders")
	}
	out.OpenOrders = len(orders) + len(algos)
	fee, e := b.client.NewCommissionRateService().Symbol(symbol).Do(ctx)
	if e != nil {
		return out, errors.New("Could not read Binance actual fees")
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
	out.FeeBPS = execution.Decimal(new(big.Rat).Mul(taker, big.NewRat(10000, 1)).FloatString(12))
	return out, nil
}
func (b *FuturesTrader) PrepareExecution(ctx context.Context, symbol string) error {
	return b.PrepareExecutionLeverage(ctx, symbol, 1)
}
func (b *FuturesTrader) PrepareExecutionLeverage(ctx context.Context, symbol string, leverage int) error {
	if leverage < 1 || leverage > 20 {
		return errors.New("unsupported planning leverage")
	}
	_, e := b.client.NewGetPositionModeService().Do(ctx)
	if e != nil {
		return errors.New("cannot verify Binance position mode")
	}
	result, e := b.client.NewChangeLeverageService().Symbol(symbol).Leverage(leverage).Do(ctx)
	if e != nil || result == nil || result.Leverage != leverage {
		return errors.New("cannot set the approved leverage; order blocked")
	}
	return nil
}
func executionPosition(side string, hedge bool) futures.PositionSideType {
	if !hedge {
		return futures.PositionSideTypeBoth
	}
	if side == "long" {
		return futures.PositionSideTypeLong
	}
	return futures.PositionSideTypeShort
}
func (b *FuturesTrader) SubmitOrder(ctx context.Context, o execution.Order) (execution.Order, error) {
	if o.Type != "" && (o.Type != "market" || o.Role != "entry" || o.PostOnly || o.ReduceOnly) {
		return o, errors.New("unsupported execution order type")
	}
	nativeID, err := b.nativeClientID(o)
	if err != nil {
		return o, err
	}
	if o.VenueClientID == "" {
		return o, errors.New("Broker route must be persisted before submitting a new order")
	}

	if len(o.ClientID) != 32 || !execution.Positive(o.Price) || !execution.Positive(o.Quantity) || (o.Side != "long" && o.Side != "short") {
		return o, errors.New("invalid locked order")
	}
	mode, e := b.client.NewGetPositionModeService().Do(ctx)
	if e != nil {
		return o, errors.New("position mode unavailable")
	}
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
		tif := futures.TimeInForceTypeGTC
		if o.PostOnly {
			tif = futures.TimeInForceTypeGTX
		}
		positionSide := executionPosition(o.Side, mode.DualSidePosition)
		if o.ReduceOnly && mode.DualSidePosition {
			if o.Side == "long" {
				positionSide = futures.PositionSideTypeShort
			} else {
				positionSide = futures.PositionSideTypeLong
			}
		}
		orderType := futures.OrderTypeLimit
		service := b.client.NewCreateOrderService().Symbol(o.Symbol).Side(side).PositionSide(positionSide).Quantity(string(o.Quantity)).NewClientOrderID(nativeID)
		if o.Type == "market" {
			orderType = futures.OrderTypeMarket
		} else {
			service.TimeInForce(tif).Price(string(o.Price))
		}
		service.Type(orderType)
		if o.ReduceOnly && !mode.DualSidePosition {
			service.ReduceOnly(true)
		}
		r, e := service.Do(ctx)
		if e != nil {
			return o, errors.New("Binance entry submission is unconfirmed; reconcile by client ID")
		}
		limitMismatch := o.Type != "market" && (!sameNativeDecimal(r.Price, string(o.Price)) || r.TimeInForce != tif)
		if r.OrderID <= 0 || r.ClientOrderID != nativeID || r.Symbol != o.Symbol || !sameNativeDecimal(r.OrigQuantity, string(o.Quantity)) || limitMismatch || r.Side != side || r.Type != orderType || r.PositionSide != positionSide || (o.ReduceOnly && !mode.DualSidePosition && !r.ReduceOnly) {
			return o, errors.New("invalid Binance order receipt")
		}
		o.OrderID = fmt.Sprint(r.OrderID)
		o.Status = string(r.Status)
		o.Filled = execution.Decimal(r.ExecutedQuantity)
		o.Average = execution.Decimal(r.AvgPrice)
		return o, nil
	}
	typ := futures.AlgoOrderTypeStopMarket
	if o.Role == "tp" {
		typ = futures.AlgoOrderTypeTakeProfitMarket
	} else if o.Role != "sl" {
		return o, errors.New("unsupported protective order")
	}
	service := b.client.NewCreateAlgoOrderService().Symbol(o.Symbol).Side(side).PositionSide(executionPosition(o.Side, mode.DualSidePosition)).Type(typ).Quantity(string(o.Quantity)).TriggerPrice(string(o.Price)).WorkingType(futures.WorkingTypeContractPrice).ClientAlgoId(nativeID)
	if !mode.DualSidePosition {
		service.ReduceOnly(true)
	}
	r, e := service.Do(ctx)
	if e != nil {
		return o, errors.New("Binance protective order submission is unconfirmed")
	}
	if r.AlgoId <= 0 || r.ClientAlgoId != nativeID || r.Symbol != o.Symbol || !sameNativeDecimal(r.Quantity, string(o.Quantity)) || !sameNativeDecimal(r.TriggerPrice, string(o.Price)) || r.Side != side || r.OrderType != typ || (!mode.DualSidePosition && !r.ReduceOnly) {
		return o, errors.New("invalid Binance protection receipt")
	}
	o.OrderID = fmt.Sprint(r.AlgoId)
	o.Status = "NEW"
	o.Filled = "0"
	return o, nil
}
func (b *FuturesTrader) LookupOrder(ctx context.Context, o execution.Order) (execution.Order, error) {
	nativeID, err := b.nativeClientID(o)
	if err != nil {
		return o, err
	}

	if o.Role != "entry" {
		r, e := b.client.NewGetAlgoOrderService().ClientAlgoID(nativeID).Do(ctx)
		if e != nil {
			return o, errors.New("Binance protective order lookup is unconfirmed")
		}
		if r.AlgoId <= 0 || r.ClientAlgoId != nativeID || r.Symbol != o.Symbol || !sameNativeDecimal(r.Quantity, string(o.Quantity)) || !sameNativeDecimal(r.TriggerPrice, string(o.Price)) {
			return o, errors.New("protection identity mismatch")
		}
		o.OrderID = fmt.Sprint(r.AlgoId)
		if r.ActualOrderId != "" && r.ActualOrderId != "0" {
			id, ok := new(big.Int).SetString(r.ActualOrderId, 10)
			if !ok || !id.IsInt64() {
				return o, errors.New("invalid triggered order ID")
			}
			fill, e := b.client.NewGetOrderService().Symbol(o.Symbol).OrderID(id.Int64()).Do(ctx)
			if e != nil {
				return o, errors.New("triggered fill not yet confirmed")
			}
			o.Status = string(fill.Status)
			o.Filled = execution.Decimal(fill.ExecutedQuantity)
			o.Average = execution.Decimal(fill.AvgPrice)
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
	r, e := b.client.NewGetOrderService().Symbol(o.Symbol).OrigClientOrderID(nativeID).Do(ctx)
	if e != nil {
		return o, errors.New("Binance order lookup is unconfirmed; missing does not mean filled")
	}
	priceMismatch := o.Type != "market" && !sameNativeDecimal(r.Price, string(o.Price))
	marketMismatch := o.Type == "market" && (r.Type != futures.OrderTypeMarket || (o.Side == "long" && r.Side != futures.SideTypeBuy) || (o.Side == "short" && r.Side != futures.SideTypeSell))
	if r.OrderID <= 0 || r.ClientOrderID != nativeID || r.Symbol != o.Symbol || !sameNativeDecimal(r.OrigQuantity, string(o.Quantity)) || priceMismatch || marketMismatch {
		return o, errors.New("order identity mismatch")
	}
	o.OrderID = fmt.Sprint(r.OrderID)
	o.Status = string(r.Status)
	o.Filled = execution.Decimal(r.ExecutedQuantity)
	o.Average = execution.Decimal(r.AvgPrice)
	return o, nil
}
func (b *FuturesTrader) CancelExecutionOrder(ctx context.Context, o execution.Order) error {
	nativeID, err := b.nativeClientID(o)
	if err != nil {
		return err
	}

	if o.Role == "entry" {
		r, e := b.client.NewCancelOrderService().Symbol(o.Symbol).OrigClientOrderID(nativeID).Do(ctx)
		if e != nil || r.ClientOrderID != nativeID {
			return errors.New("Binance entry cancellation is unconfirmed")
		}
		return nil
	}
	r, e := b.client.NewCancelAlgoOrderService().ClientAlgoID(nativeID).Do(ctx)
	if e != nil || r.ClientAlgoId != nativeID {
		return errors.New("Binance protective order cancellation is unconfirmed")
	}
	return nil
}

var _ execution.Trader = (*FuturesTrader)(nil)
