package market

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"nofx/planning/plugins"
	"strconv"
	"strings"
	"time"
)

func (c *Client) PluginData(ctx context.Context, id string, q plugins.Request) (plugins.Result, error) {
	out := plugins.Result{Venue: q.Venue, Symbol: q.Symbol, Observed: time.Now().UTC(), Mode: "public", Notice: "只读数据快照；不是方向预测或成交依据。资金费率不计入当前风险估计，持仓量快照不代表持仓变化。"}
	if id != "funding" && id != "open_interest" {
		return out, errors.New("unknown public data plugin")
	}
	switch q.Venue {
	case "binance":
		if !strings.HasSuffix(q.Symbol, "USDT") {
			return out, errors.New("插件仅支持 Binance USDT 合约")
		}
		if id == "funding" {
			var r struct {
				Symbol  string `json:"symbol"`
				Funding string `json:"lastFundingRate"`
				Mark    string `json:"markPrice"`
				Time    int64  `json:"time"`
			}
			out.Source = "https://fapi.binance.com/fapi/v1/premiumIndex"
			if err := c.request(ctx, http.MethodGet, c.BinanceFutures+"/fapi/v1/premiumIndex?symbol="+url.QueryEscape(q.Symbol), nil, &r); err != nil {
				return out, err
			}
			if r.Symbol != q.Symbol || r.Time <= 0 {
				return out, errors.New("invalid funding instrument or timestamp")
			}
			out.SourceTime = time.UnixMilli(r.Time).UTC()
			out.Metrics = []plugins.Metric{{Key: "funding_rate", Label: "最新资金费率", Value: r.Funding, Unit: "fraction"}, {Key: "mark_price", Label: "标记价格", Value: r.Mark, Unit: "USDT"}}
		} else {
			var r struct {
				Symbol string `json:"symbol"`
				OI     string `json:"openInterest"`
				Time   int64  `json:"time"`
			}
			out.Source = "https://fapi.binance.com/fapi/v1/openInterest"
			if err := c.request(ctx, http.MethodGet, c.BinanceFutures+"/fapi/v1/openInterest?symbol="+url.QueryEscape(q.Symbol), nil, &r); err != nil {
				return out, err
			}
			if r.Symbol != q.Symbol || r.Time <= 0 {
				return out, errors.New("invalid OI instrument or timestamp")
			}
			out.SourceTime = time.UnixMilli(r.Time).UTC()
			out.Metrics = []plugins.Metric{{Key: "open_interest", Label: "未平仓数量", Value: r.OI, Unit: strings.TrimSuffix(q.Symbol, "USDT")}}
		}
	case "okx":
		if !strings.HasSuffix(q.Symbol, "-USDT-SWAP") {
			return out, errors.New("插件仅支持 OKX USDT 永续")
		}
		path := "/api/v5/public/open-interest?instType=SWAP&instId="
		if id == "funding" {
			path = "/api/v5/public/funding-rate?instId="
		}
		var r struct {
			Code string `json:"code"`
			Data []struct {
				Instrument string `json:"instId"`
				Funding    string `json:"fundingRate"`
				OI         string `json:"oi"`
				Time       string `json:"ts"`
			} `json:"data"`
		}
		out.Source = "https://www.okx.com" + strings.Split(path, "?")[0]
		if err := c.request(ctx, http.MethodGet, c.OKX+path+url.QueryEscape(q.Symbol), nil, &r); err != nil {
			return out, err
		}
		if r.Code != "0" || len(r.Data) != 1 || r.Data[0].Instrument != q.Symbol {
			return out, errors.New("invalid OKX plugin response")
		}
		row := r.Data[0]
		ms, err := strconv.ParseInt(row.Time, 10, 64)
		if err != nil || ms <= 0 {
			return out, errors.New("invalid OKX plugin timestamp")
		}
		out.SourceTime = time.UnixMilli(ms).UTC()
		if id == "funding" {
			out.Metrics = []plugins.Metric{{Key: "funding_rate", Label: "当前资金费率", Value: row.Funding, Unit: "fraction"}}
		} else {
			out.Metrics = []plugins.Metric{{Key: "open_interest", Label: "未平仓合约", Value: row.OI, Unit: "张"}}
		}
	case "hyperliquid":
		var response []json.RawMessage
		out.Source = "https://api.hyperliquid.xyz/info · metaAndAssetCtxs"
		if err := c.request(ctx, http.MethodPost, c.Hyperliquid+"/info", hyperMetaRequest("metaAndAssetCtxs", q.Symbol), &response); err != nil {
			return out, err
		}
		if len(response) != 2 {
			return out, errors.New("invalid Hyperliquid plugin response")
		}
		var meta struct {
			Universe []struct {
				Name string `json:"name"`
			} `json:"universe"`
		}
		var rows []struct {
			Funding string `json:"funding"`
			OI      string `json:"openInterest"`
			Mark    string `json:"markPx"`
		}
		if json.Unmarshal(response[0], &meta) != nil || json.Unmarshal(response[1], &rows) != nil || len(meta.Universe) != len(rows) {
			return out, errors.New("invalid asset contexts")
		}
		index := -1
		for n, u := range meta.Universe {
			if u.Name == q.Symbol {
				index = n
				break
			}
		}
		if index < 0 {
			return out, errors.New("unknown perpetual instrument")
		}
		row := rows[index]
		out.Notice += " Hyperliquid 本响应没有源时间戳，时间仅为本机接收时间；费率为交易所当前小时口径。"
		if id == "funding" {
			out.Metrics = []plugins.Metric{{Key: "funding_rate", Label: "当前小时资金费率", Value: row.Funding, Unit: "fraction"}, {Key: "mark_price", Label: "标记价格", Value: row.Mark, Unit: "USDC"}}
		} else {
			out.Metrics = []plugins.Metric{{Key: "open_interest", Label: "未平仓数量", Value: row.OI, Unit: q.Symbol}}
		}
	default:
		return out, errors.New("unsupported plugin venue")
	}
	out.Observed = time.Now().UTC()
	return out, nil
}
