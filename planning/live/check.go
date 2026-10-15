package live

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"nofx/planning"
)

// CheckStatus only reads the exchange. It never starts a worker, submits an
// order, or cancels an exchange order. A flat, fully resolved basket can release
// its account reservation, including after an externally closed position.
func (c *Controller) CheckStatus(ctx context.Context, user, id string) (View, error) {
	lock := c.runLock(id)
	lock.Lock()
	defer lock.Unlock()
	v, err := c.Get(user, id)
	if err != nil {
		return v, err
	}
	if v.State != "needs_attention" && v.State != "position_open" && v.State != "stopping" {
		return v, nil
	}
	broker, key, err := c.Factory(ctx, user, v.ExchangeID)
	if err != nil || key != v.AccountKey || broker.Venue() != v.Plan.Snapshot.Venue {
		return v, errors.New("Could not verify the original trading account. Check its connection in Config.")
	}
	for i, order := range v.Orders {
		if order.Status == "scheduled" {
			continue // Persisted intent has never been sent to the exchange.
		}
		observed, lookupErr := broker.Lookup(ctx, order)
		if lookupErr != nil || (order.OrderID != "" && order.OrderID != observed.OrderID) || !validReceipt(order, observed) || cmp(observed.Filled, order.Filled) < 0 {
			return v, fmt.Errorf("Could not confirm %s order %s. The account remains reserved; check this order at the exchange.", order.Role, order.OrderID)
		}
		v.Orders[i] = observed
	}
	account, err := broker.Account(ctx, v.Plan.Snapshot.Symbol)
	if err != nil {
		return v, errors.New("Could not read live positions and open orders. The account remains reserved. Try checking again.")
	}
	_, positionErr := decimal(account.Position)
	_, equityErr := decimal(account.Equity)
	_, availableErr := decimal(account.Available)
	if positionErr != nil || equityErr != nil || availableErr != nil || account.OpenOrders < 0 {
		return v, errors.New("The exchange returned incomplete position or order data. The account remains reserved.")
	}
	resolved := cmp(account.Position, "0") == 0 && account.OpenOrders == 0
	for _, order := range v.Orders {
		switch order.Status {
		case "scheduled", "FILLED", "CANCELED", "REJECTED", "EXPIRED":
		default:
			resolved = false
		}
	}
	if !resolved {
		if err = c.save(&v); err != nil {
			return v, err
		}
		return v, errors.New("This trade still has a position, an open order, or an unconfirmed order. Review Positions & orders below; new orders remain blocked.")
	}
	for i := range v.Orders {
		if v.Orders[i].Status == "scheduled" {
			v.Orders[i].Status = "CANCELED"
		}
	}
	v.State, v.Error, v.UpdatedAt = "completed", "", time.Now().UTC()
	raw, err := json.Marshal(v.Orders)
	if err != nil {
		return v, err
	}
	err = c.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&Run{}).Where("id = ? AND user_id = ?", v.ID, user).Updates(map[string]any{"state": v.State, "orders_json": string(raw), "error": "", "updated_at": v.UpdatedAt}).Error; err != nil {
			return err
		}
		if err := tx.Where("run_id = ? AND user_id = ?", v.ID, user).Delete(&Lease{}).Error; err != nil {
			return err
		}
		return tx.Model(&planning.Draft{}).Where("user_id = ? AND id = ?", user, v.PlanID).Update("status", "completed").Error
	})
	return v, err
}
