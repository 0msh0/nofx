package live

import (
	"context"
	"nofx/trader/execution"
)

// NOFXBroker adapts the finite scheduler to NOFX's shared exchange trader.
// It owns no credentials, exchange SDK, order conversion or submission logic.
type NOFXBroker struct{ execution.Trader }

func (b NOFXBroker) Account(ctx context.Context, s string) (Account, error) {
	return b.AccountSnapshot(ctx, s)
}
func (b NOFXBroker) Prepare(ctx context.Context, s string) error        { return b.PrepareExecution(ctx, s) }
func (b NOFXBroker) Place(ctx context.Context, o Order) (Order, error)  { return b.SubmitOrder(ctx, o) }
func (b NOFXBroker) Lookup(ctx context.Context, o Order) (Order, error) { return b.LookupOrder(ctx, o) }
func (b NOFXBroker) Cancel(ctx context.Context, o Order) error          { return b.CancelExecutionOrder(ctx, o) }
func (b NOFXBroker) RouteClientID(id string) (string, error) {
	if r, ok := b.Trader.(ClientIDRouter); ok {
		return r.RouteClientID(id)
	}
	return "", nil
}

var _ Broker = NOFXBroker{}
