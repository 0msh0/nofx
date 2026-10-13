package harness

import (
	"context"
	"math/big"
	"time"

	"nofx/planning/core"
	"nofx/planning/market"
)

func macroIntervals(interval string) []string {
	switch interval {
	case "1m", "5m", "15m":
		return []string{"1h", "4h"}
	case "1h":
		return []string{"4h", "1d"}
	case "4h":
		return []string{"1h", "1d"}
	default:
		return []string{"1h", "4h"}
	}
}

// Visible context is bounded, paginated, and explicitly distinguished from fresh
// executable quotes. The full range is summarized; large raw series are sampled.
func (e *Engine) chartContext(ctx context.Context, input *Input, emit Emit) (map[string]any, error) {
	now := time.Now().Unix()
	requestedFrom := input.VisibleFrom
	from, to := input.VisibleFrom, input.VisibleTo
	if to == 0 || to > now+1 {
		to = now + 1
	}
	// Older/native clients may include an all-future viewport. There are no
	// candles there: use the documented latest-window fallback and disclose it.
	futureOnly := from >= to && from > 0
	if futureOnly {
		from = 0
	}
	count := 240
	if from > 0 {
		count = int((to-from)/market.IntervalSeconds(input.Interval)) + 2
		if count < 1 {
			count = 1
		}
		if count > 1200 {
			count = 1200
		}
	}
	q := market.CandleQuery{Venue: input.Venue, Symbol: input.Symbol, Interval: input.Interval, To: to, Limit: min(300, count)}
	if err := emit(Event{"tool_start", map[string]any{"name": "get_candles", "id": "context"}}); err != nil {
		return nil, err
	}
	rows := []market.Candle{}
	var fetchErr error
	for len(rows) < count {
		q.Limit = min(300, count-len(rows))
		page, err := e.Charts.Candles(ctx, q)
		if err != nil {
			fetchErr = err
			break
		}
		if len(page) == 0 {
			break
		}
		previous := q.To
		q.To = page[0].Time
		if q.To >= previous {
			break
		}
		rows = append(page, rows...)
		if from > 0 && page[0].Time <= from {
			break
		}
	}
	filtered := []market.Candle{}
	for _, row := range rows {
		if row.Time < to && (from == 0 || row.Time >= from) {
			filtered = append(filtered, row)
		}
	}
	rows = filtered
	primary := window(input.Interval, rows)
	if from > 0 {
		primary.Truncated = int64(len(rows))*market.IntervalSeconds(input.Interval) < to-from-market.IntervalSeconds(input.Interval)
	}
	input.Analysis = &core.Analysis{Interval: input.Interval, VisibleFrom: from, VisibleTo: input.VisibleTo, Windows: []core.DataWindow{primary}}
	data := map[string]any{"active_interval": input.Interval, "visible_range_requested": map[string]int64{"from": requestedFrom, "to": input.VisibleTo}, "primary": series(rows, primary), "received": time.Now().UTC()}
	data["effective_data_range"] = map[string]int64{"from": from, "to": to}
	if futureOnly {
		data["viewport_note"] = "图表位于未来留白，已读取当前周期最近240根实际K线。"
	}
	if fetchErr != nil {
		data["primary_error"] = fetchErr.Error()
	}
	if err := emit(Event{"tool_result", map[string]any{"name": "get_candles", "id": "context", "ok": fetchErr == nil, "count": len(rows), "interval": input.Interval, "scope": map[bool]string{true: "最近240根（图表留白）", false: "可见区间"}[futureOnly], "from": primary.From, "to": primary.To, "truncated": primary.Truncated}}); err != nil {
		return nil, err
	}
	// A historical viewport never substitutes for the latest active-interval data.
	if input.VisibleTo > 0 && input.VisibleTo < now-market.IntervalSeconds(input.Interval) {
		latest, err := e.Charts.Candles(ctx, market.CandleQuery{Venue: input.Venue, Symbol: input.Symbol, Interval: input.Interval, Limit: 120})
		if err == nil {
			w := window(input.Interval, latest)
			data["latest_active_interval"] = series(latest, w)
			input.Analysis.Windows = append(input.Analysis.Windows, w)
		} else {
			data["latest_error"] = err.Error()
		}
	}
	macro := []any{}
	for _, interval := range macroIntervals(input.Interval) {
		id := "macro_" + interval
		if err := emit(Event{"tool_start", map[string]any{"name": "get_candles", "id": id}}); err != nil {
			return nil, err
		}
		bars, err := e.Charts.Candles(ctx, market.CandleQuery{Venue: input.Venue, Symbol: input.Symbol, Interval: interval, Limit: 120})
		w := window(interval, bars)
		if err != nil {
			macro = append(macro, map[string]string{"interval": interval, "error": err.Error()})
		} else {
			macro = append(macro, series(bars, w))
			input.Analysis.Windows = append(input.Analysis.Windows, w)
		}
		if emitErr := emit(Event{"tool_result", map[string]any{"name": "get_candles", "id": id, "ok": err == nil, "count": len(bars), "interval": interval, "scope": "较大/对照周期", "from": w.From, "to": w.To}}); emitErr != nil {
			return nil, emitErr
		}
	}
	data["comparison_timeframes"] = macro
	if err := emit(Event{"context", input.Analysis}); err != nil {
		return nil, err
	}
	return data, nil
}
func window(interval string, bars []market.Candle) core.DataWindow {
	w := core.DataWindow{Interval: interval, Count: len(bars)}
	if len(bars) > 0 {
		w.From = bars[0].Time
		w.To = bars[len(bars)-1].Time
		w.Sampled = len(bars) > 240
	}
	return w
}
func series(rows []market.Candle, w core.DataWindow) any {
	if len(rows) == 0 {
		return map[string]any{"window": w, "candles": []market.Candle{}}
	}
	high, low := new(big.Rat), new(big.Rat)
	high.SetString(string(rows[0].High))
	low.SetString(string(rows[0].Low))
	for _, row := range rows {
		h, _ := new(big.Rat).SetString(string(row.High))
		l, _ := new(big.Rat).SetString(string(row.Low))
		if h.Cmp(high) > 0 {
			high = h
		}
		if l.Cmp(low) < 0 {
			low = l
		}
	}
	sample := rows
	if len(rows) > 240 {
		sample = []market.Candle{}
		for n := 0; n < 240; n++ {
			sample = append(sample, rows[n*(len(rows)-1)/239])
		}
	}
	return map[string]any{"window": w, "candles": sample, "sample_is_noncontiguous": w.Sampled, "range_high": high.FloatString(12), "range_low": low.FloatString(12), "first_close": rows[0].Close, "last_close": rows[len(rows)-1].Close, "notice": "市场上下文，不是历史策略测试；抽样序列不能当作连续K线计算指标"}
}
