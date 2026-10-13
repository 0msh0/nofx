package hyperliquid

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/ethereum/go-ethereum/crypto"
	hl "github.com/sonirico/go-hyperliquid"
	"net/http"
	"net/http/httptest"
	"nofx/planning/live"
	"strings"
	"testing"
	"time"
)

func TestPlanningHyperliquidNativeReceiptsAndUnknownLookup(t *testing.T) {
	key, _ := crypto.GenerateKey()
	agent := crypto.PubkeyToAddress(key.PublicKey).Hex()
	clientID := strings.Repeat("b", 32)
	var actions []map[string]any
	unknown := false
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		json.NewDecoder(r.Body).Decode(&request)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/exchange" {
			a := request["action"].(map[string]any)
			actions = append(actions, a)
			switch a["type"] {
			case "order":
				fmt.Fprint(w, `{"status":"ok","response":{"type":"order","data":{"statuses":[{"resting":{"oid":12345}}]}}}`)
			case "cancelByCloid":
				fmt.Fprint(w, `{"status":"ok","response":{"type":"cancel","data":{"statuses":["success"]}}}`)
			default:
				t.Error(a)
			}
			return
		}
		switch request["type"] {
		case "extraAgents":
			fmt.Fprintf(w, `[{"address":%q,"validUntil":%d}]`, agent, time.Now().Add(time.Hour).UnixMilli())
		case "orderStatus":
			if unknown {
				fmt.Fprint(w, `{"status":"unknownOid"}`)
			} else {
				fmt.Fprintf(w, `{"status":"order","order":{"order":{"coin":"BTC","side":"B","limitPx":"100000","sz":"0.0005","origSz":"0.001","oid":12345,"timestamp":1,"cloid":%q},"status":"open","statusTimestamp":1}}`, "0x"+clientID)
			}
		default:
			t.Error(request)
			fmt.Fprint(w, `{}`)
		}
	}))
	defer s.Close()
	meta := &hl.Meta{Universe: []hl.AssetInfo{{Name: "BTC", SzDecimals: 5, MaxLeverage: 50}}}
	ex := hl.NewExchange(context.Background(), key, s.URL, meta, "", "owner", &hl.SpotMeta{}, nil, hl.ExchangeOptClientOptions(hl.ClientOptHTTPClient(s.Client())))
	tr := &HyperliquidTrader{ctx: context.Background(), apiURL: s.URL, privateKey: key, walletAddr: "owner", meta: meta, exchange: ex}
	b := PlanningBroker{Trader: tr}
	o := live.Order{ClientID: clientID, Symbol: "BTC", Role: "entry", Side: "long", Price: "100000", Quantity: "0.001", Status: "submitting", Filled: "0"}
	got, e := b.Place(context.Background(), o)
	if e != nil || got.OrderID != "12345" || got.Status != "NEW" {
		t.Fatalf("%+v %v", got, e)
	}
	wire := actions[0]["orders"].([]any)[0].(map[string]any)
	if wire["c"] != "0x"+clientID || wire["r"] != false || wire["p"] != "100000" || wire["s"] != "0.001" {
		t.Fatal(wire)
	}
	got, e = b.Lookup(context.Background(), o)
	if e != nil || got.Status != "PARTIALLY_FILLED" || got.Filled != "0.000500000000" {
		t.Fatalf("%+v %v", got, e)
	}
	unknown = true
	got, e = b.Lookup(context.Background(), o)
	if e == nil || got.Status == "FILLED" {
		t.Fatal("unknown order fabricated fill")
	}
	o.Role = "sl"
	o.Price = "99000"
	if _, e = b.Place(context.Background(), o); e != nil {
		t.Fatal(e)
	}
	wire = actions[1]["orders"].([]any)[0].(map[string]any)
	if wire["r"] != true || wire["b"] != false {
		t.Fatal("protection not reduce only", wire)
	}
	if e = b.Cancel(context.Background(), o); e != nil {
		t.Fatal(e)
	}
}
