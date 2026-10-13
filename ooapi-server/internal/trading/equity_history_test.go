package trading

import (
	"testing"
	"time"
)

func TestTodayTradePnLExcludesTransfersAndNonUSDT(t *testing.T) {
	now := time.Date(2026, 10, 13, 4, 0, 0, 0, time.UTC) // Shanghai 12:00
	day := ShanghaiDayStart(now)
	rows := []IncomeEvent{
		{Asset: "USDT", IncomeType: "REALIZED_PNL", Income: -3.0, Time: day.Add(time.Hour)},
		{Asset: "USDT", IncomeType: "COMMISSION", Income: -0.5, Time: day.Add(2 * time.Hour)},
		{Asset: "USDT", IncomeType: "FUNDING_FEE", Income: -0.1, Time: day.Add(3 * time.Hour)},
		{Asset: "USDT", IncomeType: "TRANSFER", Income: 10, Time: day.Add(time.Hour)},
		{Asset: "BNB", IncomeType: "COMMISSION", Income: -0.01, Time: day.Add(time.Hour)},
		{Asset: "USDT", IncomeType: "REALIZED_PNL", Income: -9, Time: day.Add(-time.Hour)},
	}
	trade, all := TodayTradePnL(rows, now)
	if !almostEqual(trade, -3.6) {
		t.Fatalf("trade %v", trade)
	}
	if !almostEqual(all, 6.4) {
		t.Fatalf("all %v", all)
	}
	eq := AccountEquity{Wallet: 8.4, Unrealized: -0.4, Equity: 8.0}
	today := ComputeTodayPanelPnL(eq, trade, all, true, 0)
	if today.TodaySrc != "income" || !almostEqual(today.TodayPnL, -4.0) {
		t.Fatalf("today %#v", today)
	}
	// day start wallet = 8.4 - 6.4 = 2
	if !almostEqual(today.TodayBase, 2) || !almostEqual(today.TodayPct, -200) {
		t.Fatalf("base/pct %#v", today)
	}
}

func TestEquityHistoryRecordsMarkersAndSmooths(t *testing.T) {
	ResetEquityHistoryForTest()
	t.Cleanup(ResetEquityHistoryForTest)
	now := time.Date(2026, 10, 13, 5, 0, 0, 0, time.UTC)
	eq := AccountEquity{Wallet: 2, Available: 1.5, Unrealized: -0.2, Equity: 1.8, MarginUsed: 0.5}
	pos := []PanelPosition{{Symbol: "DOGEUSDT", Open: true, Side: SideShort, Qty: 10}}
	points, markers := RecordEquitySample(7, now, eq, pos)
	if len(points) != 1 || len(markers) != 1 || markers[0].Kind != "open" {
		t.Fatalf("first points=%d markers=%#v", len(points), markers)
	}
	eq.Equity = 1.7
	points, _ = RecordEquitySample(7, now.Add(time.Second), eq, pos)
	if len(points) != 1 {
		t.Fatalf("debounce got %d", len(points))
	}
	points, markers = RecordEquitySample(7, now.Add(6*time.Second), eq, nil)
	if len(points) != 2 {
		t.Fatalf("second sample %d", len(points))
	}
	foundClose := false
	for _, m := range markers {
		if m.Kind == "close" && m.Symbol == "DOGEUSDT" {
			foundClose = true
		}
	}
	if !foundClose {
		t.Fatalf("missing close %#v", markers)
	}
	smooth := SmoothEquityPoints([]EquityPoint{
		{T: 1, Equity: 1}, {T: 2, Equity: 2}, {T: 3, Equity: 3},
	}, 3)
	if !almostEqual(smooth[2].Equity, 2) {
		t.Fatalf("smooth %#v", smooth)
	}
}

func TestComputeTodayPanelPnLFallsBackToSession(t *testing.T) {
	eq := AccountEquity{Wallet: 3, Unrealized: 0.5, Equity: 3.5}
	today := ComputeTodayPanelPnL(eq, 0, 0, false, 4)
	if today.TodaySrc != "session" || !almostEqual(today.TodayPnL, -0.5) {
		t.Fatalf("%#v", today)
	}
}
