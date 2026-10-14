package binance

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"nofx/planning/live"
	"strings"
	"testing"
)

func planningOrder() live.Order {
	o := live.Order{ClientID: strings.Repeat("a", 32), Role: "entry", Symbol: "BTCUSDT", Side: "long", Price: "100000", Quantity: "0.001", Status: "submitting", Filled: "0"}
	o.VenueClientID, _ = (&PlanningBroker{}).RouteClientID(o.ClientID)
	return o
}
func TestPlanningBinanceExactLimitAndProtection(t *testing.T) {
	var sent []url.Values
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/fapi/v1/positionSide/dual":
			fmt.Fprint(w, `{"dualSidePosition":false}`)
		case "/fapi/v1/order":
			sent = append(sent, r.Form)
			fmt.Fprintf(w, `{"orderId":123,"clientOrderId":%q,"symbol":"BTCUSDT","price":"100000","origQty":"0.001","side":"BUY","type":"LIMIT","timeInForce":"GTC","status":"NEW","executedQty":"0","avgPrice":"0"}`, r.Form.Get("newClientOrderId"))
		case "/fapi/v1/algoOrder":
			sent = append(sent, r.Form)
			fmt.Fprintf(w, `{"algoId":456,"clientAlgoId":%q,"symbol":"BTCUSDT","quantity":"0.001","triggerPrice":"99000","side":"SELL","orderType":"STOP_MARKET","reduceOnly":true}`, r.Form.Get("clientAlgoId"))
		default:
			t.Error(r.URL.Path)
		}
	}))
	defer s.Close()
	b := NewPlanningBroker("test-key", "test-secret")
	b.Client.BaseURL = s.URL
	b.Client.HTTPClient = s.Client()
	o := planningOrder()
	r, e := b.Place(context.Background(), o)
	if e != nil || r.OrderID != "123" {
		t.Fatalf("%+v %v", r, e)
	}
	o.Role = "sl"
	o.Price = "99000"
	r, e = b.Place(context.Background(), o)
	if e != nil || r.OrderID != "456" {
		t.Fatalf("%+v %v", r, e)
	}
	if sent[0].Get("type") != "LIMIT" || sent[0].Get("timeInForce") != "GTC" || sent[0].Get("quantity") != "0.001" || sent[0].Get("newClientOrderId") != o.VenueClientID {
		t.Fatal(sent[0])
	}
	if sent[1].Get("clientAlgoId") != o.VenueClientID || sent[1].Get("reduceOnly") != "true" || sent[1].Get("side") != "SELL" || sent[1].Get("triggerPrice") != "99000" || sent[1].Get("type") != "STOP_MARKET" {
		t.Fatal(sent[1])
	}
}
func TestPlanningBinanceMissingOrderNeverFilled(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		fmt.Fprint(w, `{"code":-2013,"msg":"Order does not exist."}`)
	}))
	defer s.Close()
	b := NewPlanningBroker("test", "test")
	b.Client.BaseURL = s.URL
	b.Client.HTTPClient = s.Client()
	o := planningOrder()
	got, e := b.Lookup(context.Background(), o)
	if e == nil || got.Status == "FILLED" {
		t.Fatal(got, e)
	}
}
func TestPlanningBinanceLeverageFailureAndCancelledContext(t *testing.T) {
	orders := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fapi/v1/positionSide/dual" {
			fmt.Fprint(w, `{"dualSidePosition":false}`)
			return
		}
		if r.URL.Path == "/fapi/v1/leverage" {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"code":-2015,"msg":"denied"}`)
			return
		}
		orders++
		t.Error("unexpected order mutation")
	}))
	defer s.Close()
	b := NewPlanningBroker("test", "test")
	b.Client.BaseURL = s.URL
	b.Client.HTTPClient = s.Client()
	if b.Prepare(context.Background(), "BTCUSDT") == nil {
		t.Fatal("failed leverage accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := b.Place(ctx, planningOrder()); e == nil {
		t.Fatal("cancelled request accepted")
	}
	if orders != 0 {
		t.Fatal("ordered after failure")
	}
}

func TestPlanningBrokerIDStableLosslessAndLegacyLookup(t *testing.T) {
	b := &PlanningBroker{}
	raw := "0123456789abcdef0123456789abcdef"
	native, e := b.RouteClientID(raw)
	if e != nil || len(native) != 32 || !strings.HasPrefix(native, futuresBrokerPrefix) {
		t.Fatal(native, e)
	}
	again, _ := b.RouteClientID(raw)
	if again != native {
		t.Fatal("broker attribution broke idempotency")
	}
	decoded, e := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(native, futuresBrokerPrefix))
	if e != nil || hex.EncodeToString(decoded) != raw {
		t.Fatal("durable ID was truncated")
	}
	for _, role := range []string{"entry", "sl", "tp"} {
		t.Run(role, func(t *testing.T) {
			var gotID string
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.ParseForm()
				body, _ := io.ReadAll(r.Body)
				values, _ := url.ParseQuery(string(body))
				for k, vs := range values {
					if r.Form.Get(k) == "" {
						for _, v := range vs {
							r.Form.Add(k, v)
						}
					}
				}
				if role == "entry" {
					gotID = r.Form.Get("origClientOrderId")
				} else {
					gotID = r.Form.Get("clientAlgoId")
				}
				w.WriteHeader(400)
				fmt.Fprint(w, `{"code":-2013,"msg":"not confirmed"}`)
			}))
			defer s.Close()
			broker := NewPlanningBroker("test", "test")
			broker.Client.BaseURL = s.URL
			broker.Client.HTTPClient = s.Client()
			o := planningOrder()
			o.Role = role
			broker.Lookup(context.Background(), o)
			if gotID != o.VenueClientID {
				t.Fatal("lookup lost persisted broker ID", gotID)
			}
			broker.Cancel(context.Background(), o)
			if gotID != o.VenueClientID {
				t.Fatal("cancel lost persisted broker ID", gotID)
			}
			o.VenueClientID = ""
			broker.Lookup(context.Background(), o)
			if gotID != o.ClientID {
				t.Fatal("legacy order identity changed", gotID)
			}
		})
	}
}
func TestPlanningRejectsMissingOrChangedPersistedBrokerRoute(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; t.Error("invalid route reached exchange") }))
	defer s.Close()
	b := NewPlanningBroker("test", "test")
	b.Client.BaseURL = s.URL
	b.Client.HTTPClient = s.Client()
	for _, route := range []string{"", "x-other-broker"} {
		o := planningOrder()
		o.VenueClientID = route
		if _, e := b.Place(context.Background(), o); e == nil {
			t.Fatal("invalid broker route accepted")
		}
	}
	if calls != 0 {
		t.Fatal("invalid route sent network request")
	}
}
