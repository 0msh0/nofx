package live

import (
	"context"
	"testing"
)

func TestCheckStatusOnlyReleasesVerifiedClosedTrade(t *testing.T) {
	for _, scenario := range []string{"closed", "position", "open_order", "unknown", "triggered", "bad_position", "other_user"} {
		t.Run(scenario, func(t *testing.T) {
			c, b, _, p := setup(t, "limit")
			v := started(t, c, p)
			c.step(context.Background(), "alice", v.ID)
			v, _ = c.Get("alice", v.ID)
			entry := b.orders[v.Orders[0].ClientID]
			entry.Status, entry.Filled = "FILLED", entry.Quantity
			b.orders[entry.ClientID] = entry
			b.account.Position = entry.Quantity
			c.step(context.Background(), "alice", v.ID)
			v, _ = c.Get("alice", v.ID)
			v.State = "needs_attention"
			if err := c.save(&v); err != nil {
				t.Fatal(err)
			}
			for id, order := range b.orders {
				if order.Role != "entry" {
					order.Status = "CANCELED"
					b.orders[id] = order
				}
			}
			b.account.Position = "0"
			user := "alice"
			switch scenario {
			case "position":
				b.account.Position = entry.Quantity
			case "open_order":
				b.account.OpenOrders = 1
			case "unknown":
				b.lookupErr = true
			case "triggered":
				o := b.orders[v.Orders[1].ClientID]
				o.Status = "TRIGGERED"
				b.orders[o.ClientID] = o
			case "bad_position":
				b.account.Position = ""
			case "other_user":
				user = "bob"
			}
			placed, cancelled := len(b.placed), len(b.cancelled)
			out, err := c.CheckStatus(context.Background(), user, v.ID)
			var leases int64
			c.DB.Model(&Lease{}).Count(&leases)
			if scenario == "closed" {
				if err != nil || out.State != "completed" || leases != 0 {
					t.Fatalf("not released: %s %v leases=%d", out.State, err, leases)
				}
			} else if err == nil || leases != 1 {
				t.Fatalf("unsafe release: %v leases=%d", err, leases)
			}
			if len(b.placed) != placed || len(b.cancelled) != cancelled || len(c.workers) != 0 {
				t.Fatal("status check changed exchange orders or started execution")
			}
		})
	}
}

func TestCheckStatusKeepsUnusedApproval(t *testing.T) {
	c, b, _, p := setup(t, "limit")
	v := approved(t, c, p)
	out, err := c.CheckStatus(context.Background(), "alice", v.ID)
	var leases int64
	c.DB.Model(&Lease{}).Count(&leases)
	if err != nil || out.State != "approved" || leases != 1 || len(b.placed) != 0 {
		t.Fatal("unused approval was altered")
	}
}
