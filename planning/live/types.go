// Package live executes only finite, immutable, human-approved order baskets.
// Its broker interface has no autonomous strategy or AI capability.
package live

import (
	"context"
	"nofx/planning/core"
	"time"
)

type Order struct {
	ParentID string       `json:"parent_id,omitempty"`
	ClientID string       `json:"client_id"`
	OrderID  string       `json:"order_id"`
	Role     string       `json:"role"`
	Symbol   string       `json:"symbol"`
	Side     string       `json:"side"`
	Price    core.Decimal `json:"price"`
	Quantity core.Decimal `json:"quantity"`
	Status   string       `json:"status"`
	Filled   core.Decimal `json:"filled"`
	Average  core.Decimal `json:"average,omitempty"`
	Error    string       `json:"error,omitempty"`
}
type Account struct {
	Equity, Available, FeeBPS core.Decimal
	Position                  core.Decimal
	OpenOrders                int
}

// Broker preserves exact approved decimal strings and stable client IDs.
// Lookup must return actual exchange state; absence is never a fill or a retry permit.
type Broker interface {
	Venue() string
	Account(context.Context, string) (Account, error)
	Prepare(context.Context, string) error
	Place(context.Context, Order) (Order, error)
	Lookup(context.Context, Order) (Order, error)
	Cancel(context.Context, Order) error
}
type Run struct {
	ID           string     `gorm:"primaryKey" json:"id"`
	UserID       string     `gorm:"index;not null" json:"-"`
	ExchangeID   string     `gorm:"index;not null" json:"exchange_id"`
	AccountKey   string     `json:"-"`
	PlanID       string     `gorm:"index;not null" json:"plan_id"`
	PlanHash     string     `json:"plan_hash"`
	ApprovalHash string     `json:"approval_hash"`
	State        string     `gorm:"index" json:"state"`
	PlanJSON     string     `gorm:"type:text" json:"-"`
	OrdersJSON   string     `gorm:"type:text" json:"-"`
	ApprovedAt   time.Time  `json:"approved_at"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	Deadline     *time.Time `json:"deadline,omitempty"`
	UpdatedAt    time.Time  `json:"updated_at"`
	Error        string     `json:"error,omitempty"`
}

func (Run) TableName() string { return "planning_live_runs" }

type Lease struct {
	AccountKey string `gorm:"primaryKey"`
	RunID      string `gorm:"uniqueIndex"`
	UserID     string
	ExchangeID string `gorm:"index"`
}

func (Lease) TableName() string { return "planning_live_leases" }

type View struct {
	Run
	Plan   core.Plan `json:"plan"`
	Orders []Order   `json:"orders"`
}
type Factory func(context.Context, string, string) (Broker, string, error)
