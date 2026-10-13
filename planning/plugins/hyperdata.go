package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type UpstreamError struct {
	Code       string
	Message    string
	Reason     string
	RetryAfter int
}

func (e *UpstreamError) Error() string { return "Hyperdata " + e.Code + ": " + e.Message }

type Hyperdata struct {
	Offline bool
	HTTP    *http.Client
	Base    string
}

func (h Hyperdata) Definitions() []Definition {
	defs := []Definition{}
	for _, spec := range []struct{ id, name, description string }{
		{"hyperdata_cost", "成本 / 清算图", "Hyperliquid 当前持仓成本与估计清算价格分布；不是清算预测。"},
		{"hyperdata_winrate", "胜率 / 持仓图", "历史完整回合胜率与当前持仓成本热图；未知样本单列，不代表未来胜率。"},
		{"hyperdata_profit", "盈利榜", "近 7 / 30 日已采集现金净损益榜；包含费用与资金费，不含持仓浮盈和外部对冲。"},
	} {
		id := spec.id
		defs = append(defs, Definition{Manifest: Manifest{ID: id, Name: spec.name, Description: spec.description, Version: "1.0.0", Capability: "public.read", Enabled: false}, Read: func(ctx context.Context, q Request) (Result, error) { return h.Read(ctx, id, q) }})
	}
	return defs
}

type marketIdentity struct {
	Chain string `json:"chain"`
	Type  string `json:"marketType"`
	ID    string `json:"marketId"`
}

func sameMarket(m marketIdentity, q Request) bool {
	if m.Chain != "mainnet" {
		return false
	}
	if !strings.Contains(q.Symbol, ":") {
		return m.Type == "core_perp" && (m.ID == q.Symbol || m.ID == "core_perp:"+q.Symbol)
	}
	return m.Type == "hip3_perp" && (m.ID == q.Symbol || regexp.MustCompile(`^hip3_perp:0x[0-9a-fA-F]{40}:`+regexp.QuoteMeta(q.Symbol)+`$`).MatchString(m.ID))
}
func numeric(s string) (*big.Rat, bool) {
	n, ok := new(big.Rat).SetString(s)
	return n, ok && len(s) <= 100 && decimal.MatchString(s)
}
func nonnegative(s string) bool { n, ok := numeric(s); return ok && n.Sign() >= 0 }
func finite(n float64) bool     { return !math.IsNaN(n) && !math.IsInf(n, 0) }
func recent(s string, age time.Duration) bool {
	t, e := time.Parse(time.RFC3339Nano, s)
	return e == nil && time.Since(t) <= age && !t.After(time.Now().Add(10*time.Second))
}
func (h Hyperdata) Read(ctx context.Context, id string, q Request) (Result, error) {
	out := Result{Venue: q.Venue, Symbol: q.Symbol, Mode: "public", Notice: "Hyperdata / Hyperliquid 已采集数据；不同于交易所订单簿，不能替代成交验证。"}
	if h.Offline {
		return out, errors.New("演示模式不读取真实 Hyperdata；请使用公开行情模式")
	}
	if q.Venue != "hyperliquid" {
		return out, errors.New("此组件仅适用于 Hyperliquid 同名市场；不会替换为币安或 OKX 数据")
	}
	resource := map[string]string{"hyperdata_cost": "riskbins", "hyperdata_winrate": "winrate-map", "hyperdata_profit": "profit-leaderboard"}[id]
	if resource == "" {
		return out, errors.New("unknown Hyperdata component")
	}
	kind := "core_perp"
	if strings.Contains(q.Symbol, ":") {
		kind = "hip3_perp"
	}
	window := q.Window
	if window == "" {
		window = "7d"
	}
	if window != "7d" && window != "30d" {
		return out, errors.New("invalid profit window")
	}
	values := url.Values{"chain": {"mainnet"}}
	if id == "hyperdata_profit" {
		values.Set("window", window)
	}
	endpoint := strings.TrimRight(h.Base, "/") + "/api/markets/" + kind + "/" + url.PathEscape(q.Symbol) + "/" + resource + "?" + values.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return out, err
	}
	client := h.HTTP
	if client == nil {
		client = &http.Client{Timeout: 6 * time.Second}
	}
	response, err := client.Do(req)
	if err != nil {
		return out, errors.New("Hyperdata 连接失败或超时")
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(payload) > 2<<20 {
		return out, errors.New("Hyperdata response exceeds bounded size")
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
		Meta struct {
			Coverage string `json:"coverage"`
			State    string `json:"state"`
			AsOf     string `json:"asOfTime"`
		} `json:"meta"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Details struct {
				Reason string `json:"reason"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return out, errors.New("Hyperdata invalid response")
	}
	if envelope.Error != nil {
		retry, _ := strconv.Atoi(response.Header.Get("Retry-After"))
		if retry < 1 || retry > 60 {
			retry = 5
		}
		reason := envelope.Error.Details.Reason
		switch reason {
		case "map_building", "map_busy", "map_timeout":
		default:
			retry = 0
			reason = "unavailable"
		}
		return out, &UpstreamError{Code: cutPublic(envelope.Error.Code, 80), Message: cutPublic(envelope.Error.Message, 200), Reason: reason, RetryAfter: retry}
	}
	if response.StatusCode != 200 || len(envelope.Data) == 0 {
		return out, fmt.Errorf("Hyperdata HTTP %d", response.StatusCode)
	}
	visual := &Visual{Kind: resource, State: envelope.Meta.State, Coverage: envelope.Meta.Coverage, DataAt: envelope.Meta.AsOf}
	out.Source = h.Base + " · " + resource
	out.Observed = time.Now().UTC()
	out.Visual = visual
	switch id {
	case "hyperdata_cost":
		var data struct {
			Market    marketIdentity `json:"market"`
			Mark      float64        `json:"markPrice"`
			CostAddrs int            `json:"costAddrs"`
			LiqAddrs  int            `json:"liqAddrs"`
			Bins      []CostBin      `json:"bins"`
			Cost      struct {
				State string `json:"state"`
			} `json:"cost"`
			Liquidation struct {
				State string `json:"state"`
			} `json:"liquidation"`
		}
		if json.Unmarshal(envelope.Data, &data) != nil || !sameMarket(data.Market, q) || !finite(data.Mark) || data.Mark <= 0 || len(data.Bins) > 512 || data.CostAddrs < 0 || data.LiqAddrs < 0 || !recent(visual.DataAt, 15*time.Minute) {
			return out, errors.New("成本清算数据身份、数值或时间无效")
		}
		if data.Cost.State == "unavailable" || data.Liquidation.State == "unavailable" {
			return out, errors.New("成本或清算数据暂不可用；不绘制缺失数据")
		}
		visual.Mark = data.Mark
		visual.Bins = data.Bins
		for i, b := range data.Bins {
			if !finite(b.Px) || b.Px <= 0 || i > 0 && b.Px <= data.Bins[i-1].Px {
				return out, errors.New("invalid cost price bins")
			}
			for _, v := range []float64{b.LongCost, b.ShortCost, b.LongLiq, b.ShortLiq} {
				if !finite(v) || v < 0 {
					return out, errors.New("invalid cost amount")
				}
			}
		}
		out.Metrics = []Metric{{Key: "cost_addresses", Label: "成本覆盖地址", Value: strconv.Itoa(data.CostAddrs), Unit: "地址"}, {Key: "liq_addresses", Label: "清算覆盖地址", Value: strconv.Itoa(data.LiqAddrs), Unit: "地址"}, {Key: "mark_price", Label: "统计参考价", Value: strconv.FormatFloat(data.Mark, 'f', -1, 64), Unit: "USDC"}}
		// Give the model bounded concentration locations, not hundreds of chart bars.
		for _, series := range []struct {
			key, label string
			amount     func(CostBin) float64
		}{
			{"long_cost_peak", "多仓成本最大金额价格桶", func(b CostBin) float64 { return b.LongCost }},
			{"short_cost_peak", "空仓成本最大金额价格桶", func(b CostBin) float64 { return b.ShortCost }},
			{"long_liq_peak", "多仓清算最大金额价格桶", func(b CostBin) float64 { return b.LongLiq }},
			{"short_liq_peak", "空仓清算最大金额价格桶", func(b CostBin) float64 { return b.ShortLiq }},
		} {
			var peak CostBin
			for _, bin := range data.Bins {
				if series.amount(bin) > series.amount(peak) {
					peak = bin
				}
			}
			if series.amount(peak) > 0 {
				out.Metrics = append(out.Metrics, Metric{Key: series.key, Label: series.label, Value: strconv.FormatFloat(peak.Px, 'f', -1, 64), Unit: "USDC"})
			}
		}
		out.Notice += " 成本状态 " + data.Cost.State + "；清算状态 " + data.Liquidation.State + "。地址不一定代表独立主体，清算价为已有仓位估计。"
	case "hyperdata_winrate":
		var data struct {
			AsOf        string                                             `json:"asOf"`
			PositionsAt string                                             `json:"positionsAsOf"`
			Coverage    string                                             `json:"coverage"`
			Mark        string                                             `json:"markPrice"`
			Included    HeatTotal                                          `json:"included"`
			Total       HeatTotal                                          `json:"total"`
			Cells       []HeatCell                                         `json:"cells"`
			Rows        int                                                `json:"winBins"`
			Cols        int                                                `json:"costBins"`
			MinRounds   int                                                `json:"minRoundTrips"`
			Viewport    struct{ WinMin, WinMax, CostMin, CostMax float64 } `json:"viewport"`
		}
		if json.Unmarshal(envelope.Data, &data) != nil || !recent(data.PositionsAt, 15*time.Minute) || data.Rows < 1 || data.Rows > 40 || data.Cols < 1 || data.Cols > 40 || len(data.Cells) > 1600 || data.Included.Count < 0 || data.Total.Count < data.Included.Count || !nonnegative(data.Included.Notional) {
			return out, errors.New("胜率持仓数据格式、数值或时间无效")
		}
		// Identity is established by the requested immutable endpoint; maps carry no market field.
		mark, err := strconv.ParseFloat(data.Mark, 64)
		if err != nil || !finite(mark) || mark <= 0 {
			return out, errors.New("胜率持仓图缺少有效统计参考价")
		}
		visual.Mark = mark
		visual.Rows = data.Rows
		visual.Columns = data.Cols + 2
		visual.Cells = data.Cells
		visual.DataAt = data.PositionsAt
		visual.Coverage = data.Coverage
		visual.State = "observed"
		visual.WinMin = data.Viewport.WinMin
		visual.WinMax = data.Viewport.WinMax
		visual.CostMin = data.Viewport.CostMin
		visual.CostMax = data.Viewport.CostMax
		if !finite(visual.WinMin) || !finite(visual.WinMax) || visual.WinMin < 0 || visual.WinMax > 100 || visual.WinMin >= visual.WinMax || !finite(visual.CostMin) || !finite(visual.CostMax) || visual.CostMin >= visual.CostMax {
			return out, errors.New("invalid heatmap viewport")
		}
		seen := map[string]bool{}
		for _, c := range data.Cells {
			k := fmt.Sprint(c.Row, ":", c.Column)
			if c.Row < 0 || c.Row >= data.Rows || c.Column < 0 || c.Column >= data.Cols+2 || seen[k] || c.Long.Count < 0 || c.Short.Count < 0 || !nonnegative(c.Long.Notional) || !nonnegative(c.Short.Notional) {
				return out, errors.New("invalid heatmap cell")
			}
			seen[k] = true
		}
		out.Metrics = []Metric{{Key: "included", Label: "有可用历史的持仓地址", Value: strconv.Itoa(data.Included.Count), Unit: "地址"}, {Key: "total", Label: "当前持仓地址", Value: strconv.Itoa(data.Total.Count), Unit: "地址"}, {Key: "min_rounds", Label: "最少完整回合", Value: strconv.Itoa(data.MinRounds), Unit: "回合"}}
		totals := []*big.Rat{new(big.Rat), new(big.Rat), new(big.Rat), new(big.Rat)}
		for _, cell := range data.Cells {
			long, _ := numeric(cell.Long.Notional)
			short, _ := numeric(cell.Short.Notional)
			totals[0].Add(totals[0], long)
			totals[1].Add(totals[1], short)
			lower := visual.WinMin + float64(cell.Row)*(visual.WinMax-visual.WinMin)/float64(data.Rows)
			if lower >= 60 {
				totals[2].Add(totals[2], long)
				totals[3].Add(totals[3], short)
			}
		}
		for n, item := range []struct{ key, label string }{{"heat_long", "热图格内多仓金额"}, {"heat_short", "热图格内空仓金额"}, {"win60_long", "历史胜率档下界至少60%的多仓金额"}, {"win60_short", "历史胜率档下界至少60%的空仓金额"}} {
			out.Metrics = append(out.Metrics, Metric{Key: item.key, Label: item.label, Value: totals[n].FloatString(12), Unit: "USDC"})
		}
		out.Notice += " 历史胜率不含资金费、未知历史不参与；不是未来胜率。热图金额是当前仓位，不是交易方向概率。"
	case "hyperdata_profit":
		var data struct {
			Market    marketIdentity `json:"market"`
			Days      int            `json:"windowDays"`
			Limit     int            `json:"limit"`
			Minimum   string         `json:"minNetPnl"`
			State     string         `json:"state"`
			Start     string         `json:"windowStart"`
			AsOf      string         `json:"asOf"`
			Covered   int            `json:"coveredHours"`
			Expected  int            `json:"expectedHours"`
			Qualified int            `json:"qualifiedAddresses"`
			Items     []ProfitEntry  `json:"items"`
		}
		days := 7
		if window == "30d" {
			days = 30
		}
		if json.Unmarshal(envelope.Data, &data) != nil || !sameMarket(data.Market, q) || data.Days != days || data.Limit != 100 || data.Minimum != "10000" || len(data.Items) > 100 || data.Covered < 0 || data.Covered > days*24 || data.Expected != days*24 || data.Qualified < 0 || !recent(data.AsOf, 3*time.Hour) {
			return out, errors.New("盈利榜数据身份、窗口或覆盖无效")
		}
		start, e := time.Parse(time.RFC3339, data.Start)
		end, e2 := time.Parse(time.RFC3339, data.AsOf)
		if e != nil || e2 != nil || end.Sub(start) != time.Duration(days)*24*time.Hour {
			return out, errors.New("invalid profit time window")
		}
		visual.State = data.State
		visual.DataAt = data.AsOf
		visual.WindowStart = data.Start
		switch data.State {
		case "ready":
			if data.Covered != data.Expected || len(data.Items) != min(data.Qualified, 100) {
				return out, errors.New("incomplete ready profit board")
			}
		case "building", "stale", "invalid_data":
			if len(data.Items) != 0 {
				return out, errors.New("non-ready profit board contains rankings")
			}
		default:
			return out, errors.New("unknown profit state")
		}
		seen := map[string]bool{}
		var previous *big.Rat
		previousAddress := ""
		for i, r := range data.Items {
			if r.Rank != i+1 || !regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`).MatchString(r.Address) || seen[strings.ToLower(r.Address)] {
				return out, errors.New("invalid profit identity or rank")
			}
			seen[strings.ToLower(r.Address)] = true
			net, ok := numeric(r.Net)
			gross, gok := numeric(r.Realized)
			fee, fok := numeric(r.Fees)
			fund, uok := numeric(r.Funding)
			if !ok || !gok || !fok || !uok || !nonnegative(r.Volume) || net.Cmp(big.NewRat(10000, 1)) < 0 || new(big.Rat).Add(new(big.Rat).Sub(gross, fee), fund).Cmp(net) != 0 {
				return out, errors.New("profit financial amounts do not reconcile")
			}
			if previous != nil && (net.Cmp(previous) > 0 || net.Cmp(previous) == 0 && r.Address < previousAddress) {
				return out, errors.New("profit ranks out of order")
			}
			previous = net
			previousAddress = r.Address
		}
		visual.Entries = data.Items
		out.Metrics = []Metric{{Key: "covered_hours", Label: "已覆盖小时", Value: strconv.Itoa(data.Covered), Unit: "小时"}, {Key: "expected_hours", Label: "窗口小时", Value: strconv.Itoa(data.Expected), Unit: "小时"}}
		if data.State == "ready" {
			out.Metrics = append(out.Metrics, Metric{Key: "qualified", Label: "净盈利至少 10,000 的地址", Value: strconv.Itoa(data.Qualified), Unit: "地址"})
		}
		if data.State == "ready" && len(data.Items) > 0 {
			out.Metrics = append(out.Metrics, Metric{Key: "leader_net", Label: "榜首已采集现金净损益", Value: data.Items[0].Net, Unit: "USDC"})
		}
		out.Notice += " 状态 " + data.State + "；近 " + strconv.Itoa(days) + " 日净损益 = 已实现盈亏 - 费用 + 资金费；只覆盖已采集记录，不含浮盈、外部对冲或收益率。"
	}
	out.Notice += " 统计截止 " + visual.DataAt + "；覆盖 " + visual.Coverage + "。"
	return out, nil
}
func cutPublic(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
