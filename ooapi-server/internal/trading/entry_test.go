package trading

import (
	"math"
	"testing"
	"time"
)

func TestPositionOneRAndExpectancy(t *testing.T) {
	one := PositionOneRUSDT(0.5, 10, 1)
	want := 0.5 * DefaultRFraction * 10
	if math.Abs(one-want) > 1e-12 {
		t.Fatalf("oneR %v want %v", one, want)
	}
	if PositionOneRUSDT(0, 10, 1) != 0 || PositionOneRUSDT(1, 0, 1) != 0 {
		t.Fatal("empty position has no 1R")
	}
	scaled := PositionOneRUSDT(0.5, 10, 2)
	if math.Abs(scaled-want*2) > 1e-12 {
		t.Fatalf("stopR scales 1R %v", scaled)
	}
	sum := (BacktestSummary{WinRate: 0.5, Trades: 4, NetR: 2}).WithExpectancy()
	if math.Abs(sum.ExpectancyR-0.5) > 1e-12 {
		t.Fatalf("expectancy %v", sum.ExpectancyR)
	}
	if (BacktestSummary{}).WithExpectancy().ExpectancyR != 0 {
		t.Fatal("no trades should not invent expectancy")
	}
}

func TestOpenEntryCarriesScoreMinScoreAndBacktest(t *testing.T) {
	ResetForTest()
	t.Cleanup(ResetForTest)
	paper := NewPaper()
	cfg := testConfig()
	cfg.ID = 9
	cfg.MinScore = 3
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	eng.SetUser(4)
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	_, signalScore, err := ScoreTrend(cfg, candles, nil)
	if err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, candles, candles[len(candles)-1].Close, 2)
	in.Backtest = &BacktestSummary{WinRate: 0.6, Trades: 10, NetR: 5}
	snap, err := eng.Step(in)
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	if snap.Entry == nil {
		t.Fatal("open snapshot missing entry stamp")
	}
	if snap.Entry.Score != signalScore || snap.Entry.MinScore != 3 || snap.Entry.Boost || snap.Entry.Forced {
		t.Fatalf("stamp %+v score %d", snap.Entry, signalScore)
	}
	if snap.Entry.WinRate != 0.6 || snap.Entry.Trades != 10 || snap.Entry.NetR != 5 || math.Abs(snap.Entry.ExpectancyR-0.5) > 1e-12 {
		t.Fatalf("backtest %+v", snap.Entry)
	}
	one := PositionOneRUSDT(snap.EntryPrice, snap.Qty, cfg.StopR)
	if math.Abs(snap.Entry.OneRUSDT-one) > 1e-9 || math.Abs(snap.Entry.ExpectancyUSDT-0.5*one) > 1e-9 {
		t.Fatalf("usdt %+v one %v", snap.Entry, one)
	}
	if snap.LastBacktest == nil || math.Abs(snap.LastBacktest.ExpectancyR-0.5) > 1e-12 {
		t.Fatalf("backtest expectancy %+v", snap.LastBacktest)
	}
	wantDist := DefaultTakeProfitR * DefaultRFraction
	wantLive := TradeExpectancy(0.6, wantDist, DefaultStopR*DefaultRFraction, FeesFromRates(MakerFeeRate, TakerFeeRate))
	if !(wantLive > 0) || math.Abs(snap.LiveExpectancy-wantLive) > 1e-9 || math.Abs(snap.TakeProfitDist-wantDist) > 1e-12 {
		t.Fatalf("engine live %v dist %v want %v %v", snap.LiveExpectancy, snap.TakeProfitDist, wantLive, wantDist)
	}
	if math.Abs(snap.Entry.LiveExpectancy-wantLive) > 1e-9 || math.Abs(snap.Entry.TakeProfitDist-wantDist) > 1e-12 {
		t.Fatalf("stamp live %+v", snap.Entry)
	}
	if math.Abs(snap.Entry.ExpectancyR-snap.LiveExpectancy) < 1e-6 {
		t.Fatalf("live expectancy collapsed into backtest R %+v", snap.Entry)
	}
	events := RecentEvents()
	last := events[len(events)-1]
	if last.Action != "entry" || last.Entry == nil || last.Entry.MinScore != 3 || last.Entry.Trades != 10 {
		t.Fatalf("event %+v", last)
	}
	rows, err := ListEntries(4, 9, 10)
	if err != nil || len(rows) != 1 || rows[0].Score != signalScore || rows[0].ExpectancyUSDT != snap.Entry.ExpectancyUSDT {
		t.Fatalf("saved %+v err=%v", rows, err)
	}

	ResetBoostForTest()
	again := EventsWithEntries()
	if len(again) != 1 || again[0].Entry == nil || again[0].Action != "entry" || math.Abs(again[0].Entry.ExpectancyR-0.5) > 1e-12 {
		t.Fatalf("history after ring reset %+v", again)
	}
}

func TestEntryHistoryDoesNotDuplicateALiveEvent(t *testing.T) {
	ResetForTest()
	t.Cleanup(ResetForTest)
	opened := time.Date(2026, 10, 12, 1, 0, 0, 0, time.UTC)
	rec := EntryRecord{
		UserID: 1, StrategyID: 2, Symbol: "XRPUSDT", Side: "long", OpenedAt: opened,
		EntryStamp: EntryStamp{Score: 4, MinScore: 4, WinRate: 0.5, Trades: 30, NetR: 3, ExpectancyR: 0.1},
	}
	if _, err := SaveEntry(rec); err != nil {
		t.Fatal(err)
	}
	AddEvent(rec.Event())
	events := EventsWithEntries()
	n := 0
	for _, ev := range events {
		if ev.Entry != nil && ev.Symbol == "XRPUSDT" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("duplicates %d %+v", n, events)
	}
}

func TestRunnerRecomputesBacktestWhenCandleCloses(t *testing.T) {
	cfg := testConfig()
	cfg.ID = 3
	r := NewRunner(NewHub())
	base := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	closed := []Candle{
		{OpenTime: base.Add(-15 * time.Minute), Close: 1},
		{OpenTime: base.Add(-10 * time.Minute), Close: 1.01},
	}
	key := backtestDataKey(cfg, ClosedCandles(base, TimeframeDuration(cfg.Timeframe), closed), nil)
	seed := BacktestSummary{WinRate: 0.42, Trades: 30, NetR: 6, ExpectancyR: 0.2, At: base}
	r.cache[cfg.ID] = backtestCache{Sum: seed, Key: key}

	same, ok := r.backtest(cfg, Market{Candles: closed}, base.Add(time.Minute))
	if !ok || !same.At.Equal(base) || same.WinRate != 0.42 {
		t.Fatalf("same closed set should reuse %+v ok=%v", same, ok)
	}
	empty, ok := r.backtest(cfg, Market{}, base.Add(2*time.Minute))
	if !ok || !empty.At.Equal(base) {
		t.Fatalf("empty fetch should keep the fresh cache %+v ok=%v", empty, ok)
	}

	next := append(append([]Candle{}, closed...), Candle{OpenTime: base.Add(-5 * time.Minute), Close: 1.02})
	fresh, ok := r.backtest(cfg, Market{Candles: next}, base.Add(time.Minute))
	if ok && fresh.At.Equal(base) && fresh.WinRate == 0.42 {
		t.Fatal("new closed candle reused the previous backtest")
	}
	stale, ok := r.backtest(cfg, Market{Candles: closed}, base.Add(BacktestEvery+time.Minute))
	if ok && stale.At.Equal(base) && stale.WinRate == 0.42 {
		t.Fatal("cache older than BacktestEvery was reused")
	}
}
