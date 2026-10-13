package trading

import (
	"math"
	"strings"
	"sync"
	"time"
)

const (
	// EquityHistoryKeep 是内存里保留的权益曲线时长。
	EquityHistoryKeep = 6 * time.Hour
	// EquityHistoryStep 是采样最小间隔。
	EquityHistoryStep = 5 * time.Second
	// EquityHistoryDefaultView 是前端默认展示窗口。
	EquityHistoryDefaultView = 2 * time.Hour
)

// EquityPoint 是权益曲线上的一个点。
type EquityPoint struct {
	T          int64   `json:"t"`
	Wallet     float64 `json:"wallet"`
	Equity     float64 `json:"equity"`
	Unrealized float64 `json:"unrealized"`
	Available  float64 `json:"available"`
	MarginUsed float64 `json:"marginUsed"`
}

// EquityMarker 是持仓开平或调仓标记。
type EquityMarker struct {
	T      int64  `json:"t"`
	Kind   string `json:"kind"`
	Side   string `json:"side,omitempty"`
	Symbol string `json:"symbol,omitempty"`
}

type equitySample struct {
	point     EquityPoint
	positions map[string]string // symbol -> long|short
}

type equityRing struct {
	mu       sync.Mutex
	points   []EquityPoint
	markers  []EquityMarker
	last     time.Time
	prevPos  map[string]string
	capacity int
}

func newEquityRing() *equityRing {
	// 6h / 5s = 4320
	return &equityRing{
		points:   make([]EquityPoint, 0, 512),
		markers:  make([]EquityMarker, 0, 64),
		prevPos:  map[string]string{},
		capacity: int(EquityHistoryKeep/EquityHistoryStep) + 8,
	}
}

var panelHistory = struct {
	mu   sync.Mutex
	byKey map[int64]*equityRing
}{byKey: map[int64]*equityRing{}}

// ResetEquityHistoryForTest 清掉内存权益曲线，避免测试互相污染。
func ResetEquityHistoryForTest() {
	panelHistory.mu.Lock()
	defer panelHistory.mu.Unlock()
	panelHistory.byKey = map[int64]*equityRing{}
}

func historyForKey(keyID int64) *equityRing {
	if keyID <= 0 {
		keyID = 0
	}
	panelHistory.mu.Lock()
	defer panelHistory.mu.Unlock()
	ring, ok := panelHistory.byKey[keyID]
	if !ok {
		ring = newEquityRing()
		panelHistory.byKey[keyID] = ring
	}
	return ring
}

// RecordEquitySample 写入一个权益采样点，并按持仓变化记开平标记。
// 距上次不足 EquityHistoryStep 时只更新最新点，不追加。
func RecordEquitySample(keyID int64, now time.Time, eq AccountEquity, positions []PanelPosition) (points []EquityPoint, markers []EquityMarker) {
	return historyForKey(keyID).record(now, eq, positions)
}

// EquityHistory 返回 since 之后的采样点与标记。since 为零则给全部。
func EquityHistory(keyID int64, since time.Time) (points []EquityPoint, markers []EquityMarker) {
	return historyForKey(keyID).snapshot(since)
}

func (r *equityRing) record(now time.Time, eq AccountEquity, positions []PanelPosition) ([]EquityPoint, []EquityMarker) {
	if r == nil {
		return nil, nil
	}
	now = now.UTC()
	point := EquityPoint{
		T:          now.UnixMilli(),
		Wallet:     eq.Wallet,
		Equity:     eq.Equity,
		Unrealized: eq.Unrealized,
		Available:  eq.Available,
		MarginUsed: eq.MarginUsed,
	}
	cur := map[string]string{}
	for _, pos := range positions {
		if !pos.Open || pos.Symbol == "" {
			continue
		}
		cur[strings.ToUpper(pos.Symbol)] = strings.ToLower(string(pos.Side))
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	r.appendMarkersLocked(now, cur)

	if !r.last.IsZero() && now.Sub(r.last) < EquityHistoryStep && len(r.points) > 0 {
		r.points[len(r.points)-1] = point
	} else {
		r.points = append(r.points, point)
		r.last = now
	}
	r.trimLocked(now)
	return r.copyLocked(time.Time{})
}

func (r *equityRing) appendMarkersLocked(now time.Time, cur map[string]string) {
	prev := r.prevPos
	if prev == nil {
		prev = map[string]string{}
	}
	for symbol, side := range cur {
		old, ok := prev[symbol]
		switch {
		case !ok:
			r.markers = append(r.markers, EquityMarker{T: now.UnixMilli(), Kind: "open", Side: side, Symbol: symbol})
		case old != side:
			r.markers = append(r.markers, EquityMarker{T: now.UnixMilli(), Kind: "adjust", Side: side, Symbol: symbol})
		}
	}
	for symbol, side := range prev {
		if _, ok := cur[symbol]; !ok {
			r.markers = append(r.markers, EquityMarker{T: now.UnixMilli(), Kind: "close", Side: side, Symbol: symbol})
		}
	}
	r.prevPos = cur
}

func (r *equityRing) trimLocked(now time.Time) {
	cut := now.Add(-EquityHistoryKeep).UnixMilli()
	i := 0
	for i < len(r.points) && r.points[i].T < cut {
		i++
	}
	if i > 0 {
		r.points = append([]EquityPoint{}, r.points[i:]...)
	}
	j := 0
	for j < len(r.markers) && r.markers[j].T < cut {
		j++
	}
	if j > 0 {
		r.markers = append([]EquityMarker{}, r.markers[j:]...)
	}
	if len(r.points) > r.capacity {
		r.points = append([]EquityPoint{}, r.points[len(r.points)-r.capacity:]...)
	}
	if len(r.markers) > 200 {
		r.markers = append([]EquityMarker{}, r.markers[len(r.markers)-200:]...)
	}
}

func (r *equityRing) snapshot(since time.Time) ([]EquityPoint, []EquityMarker) {
	if r == nil {
		return []EquityPoint{}, []EquityMarker{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.copyLocked(since)
}

func (r *equityRing) copyLocked(since time.Time) ([]EquityPoint, []EquityMarker) {
	cut := int64(0)
	if !since.IsZero() {
		cut = since.UTC().UnixMilli()
	}
	points := make([]EquityPoint, 0, len(r.points))
	for _, p := range r.points {
		if p.T >= cut {
			points = append(points, p)
		}
	}
	markers := make([]EquityMarker, 0, len(r.markers))
	for _, m := range r.markers {
		if m.T >= cut {
			markers = append(markers, m)
		}
	}
	if points == nil {
		points = []EquityPoint{}
	}
	if markers == nil {
		markers = []EquityMarker{}
	}
	return points, markers
}

// SmoothEquityPoints 对权益做轻量滑动平均，默认窗口约 3 个点。
func SmoothEquityPoints(points []EquityPoint, window int) []EquityPoint {
	if window < 2 || len(points) < 2 {
		out := append([]EquityPoint{}, points...)
		if out == nil {
			out = []EquityPoint{}
		}
		return out
	}
	out := make([]EquityPoint, len(points))
	for i := range points {
		start := i - window + 1
		if start < 0 {
			start = 0
		}
		var sumW, sumE, sumU, sumA, sumM float64
		n := float64(i - start + 1)
		for j := start; j <= i; j++ {
			sumW += points[j].Wallet
			sumE += points[j].Equity
			sumU += points[j].Unrealized
			sumA += points[j].Available
			sumM += points[j].MarginUsed
		}
		out[i] = EquityPoint{
			T:          points[i].T,
			Wallet:     sumW / n,
			Equity:     sumE / n,
			Unrealized: sumU / n,
			Available:  sumA / n,
			MarginUsed: sumM / n,
		}
	}
	return out
}

// TodayPanelPnL 按 my-panel 口径：交易盈亏 + 浮盈，百分比相对日初钱包。
type TodayPanelPnL struct {
	TodayPnL      float64 `json:"todayPnl"`
	TodayRealized float64 `json:"todayRealized"`
	TodayPct      float64 `json:"todayPct"`
	TodayBase     float64 `json:"todayBase"`
	TodaySrc      string  `json:"todaySrc"`
}

// ComputeTodayPanelPnL 用收入流水和当前权益算今日涨跌。
// income 不可用时回退为相对 sessionEquity 的「启动以来」。
func ComputeTodayPanelPnL(eq AccountEquity, tradePnL, allIncome float64, incomeOK bool, sessionEquity float64) TodayPanelPnL {
	if incomeOK {
		base := eq.Wallet - allIncome
		today := tradePnL + eq.Unrealized
		pct := 0.0
		if math.Abs(base) > 1e-12 {
			pct = today / base * 100
		}
		return TodayPanelPnL{
			TodayPnL:      today,
			TodayRealized: tradePnL,
			TodayPct:      pct,
			TodayBase:     base,
			TodaySrc:      "income",
		}
	}
	today := eq.Equity - sessionEquity
	pct := 0.0
	if math.Abs(sessionEquity) > 1e-12 {
		pct = today / sessionEquity * 100
	}
	return TodayPanelPnL{
		TodayPnL:      today,
		TodayRealized: 0,
		TodayPct:      pct,
		TodayBase:     sessionEquity,
		TodaySrc:      "session",
	}
}
