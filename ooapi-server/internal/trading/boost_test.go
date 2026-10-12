package trading

import (
	"errors"
	"testing"
	"time"
)

func TestMatchTokenRejectsUnsetAndMismatched(t *testing.T) {
	if MatchToken("", "") || MatchToken("secret", "") || MatchToken("", "secret") {
		t.Fatal("empty token must not match")
	}
	if !MatchToken("boost-secret", "boost-secret") {
		t.Fatal("expected match")
	}
	if MatchToken("boost-secret", "boost-secretx") || MatchToken("short", "boost-secret") {
		t.Fatal("mismatched token")
	}
}

func TestGrantBoostRateLimitsForTwoMinutes(t *testing.T) {
	ResetBoostForTest()
	t.Cleanup(ResetBoostForTest)
	now := time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)
	until, limited := GrantBoost(now)
	if limited || !until.Equal(now.Add(BoostWindow)) {
		t.Fatalf("until=%s limited=%v", until, limited)
	}
	again, limited := GrantBoost(now.Add(time.Minute))
	if !limited || !again.Equal(until) {
		t.Fatalf("again=%s limited=%v", again, limited)
	}
	next, limited := GrantBoost(until)
	if limited || !next.Equal(until.Add(BoostWindow)) {
		t.Fatalf("next=%s limited=%v", next, limited)
	}
}

func TestLiveBoostShortensScanAndPicksHighestWinRate(t *testing.T) {
	ResetTestnetGreen()
	SetTestnetGreen(true)
	ResetBoostForTest()
	t.Cleanup(func() {
		ResetTestnetGreen()
		ResetBoostForTest()
	})
	now := time.Date(2026, 10, 12, 4, 30, 0, 0, time.UTC)
	slow := scanWait(now, "5m", true)
	if slow < time.Minute {
		t.Fatalf("bar wait %s", slow)
	}
	if _, limited := GrantBoost(now); limited {
		t.Fatal("grant")
	}
	if got := scanWait(now, "5m", true); got != BoostScanInterval {
		t.Fatalf("live scan %s", got)
	}
	if got := scanWait(now, "5m", false); got == BoostScanInterval {
		t.Fatal("testnet scan should stay on bar close")
	}

	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	lowPaper := NewPaper()
	highPaper := NewPaper()
	low := liveBoostEngine(t, 1, "XRPUSDT", lowPaper, now)
	high := liveBoostEngine(t, 2, "DOGEUSDT", highPaper, now)
	peers := []int64{1, 2}
	lowIn := passingStep(now, candles, price, 0.55)
	lowIn.LivePeerIDs = peers
	highIn := passingStep(now, candles, price, 0.91)
	highIn.LivePeerIDs = peers

	snap, err := low.Step(lowIn)
	if err != nil || snap.LastReason != ReasonBoostWait || lowPaper.Entries != 0 {
		t.Fatalf("low %+v entries=%d err=%v", snap, lowPaper.Entries, err)
	}
	snap, err = high.Step(highIn)
	if err != nil || snap.State != StateInPosition || highPaper.Entries != 1 {
		t.Fatalf("high %+v entries=%d err=%v", snap, highPaper.Entries, err)
	}
	snap, err = low.Step(lowIn)
	if err != nil || snap.LastReason != ReasonBoostFilled || lowPaper.Entries != 0 || snap.State != StateArmed {
		t.Fatalf("filled %+v entries=%d err=%v", snap, lowPaper.Entries, err)
	}
	events := RecentEvents()
	if len(events) < 3 {
		t.Fatalf("events %d", len(events))
	}
	last := events[len(events)-1]
	if last.Symbol != "XRPUSDT" || last.Action != "skip" || last.Msg != ReasonBoostFilled || last.WinRate != 0.55 {
		t.Fatalf("event %+v", last)
	}
}

func TestBoostDoesNotOpenSignalThatFailsBacktest(t *testing.T) {
	ResetTestnetGreen()
	SetTestnetGreen(true)
	ResetBoostForTest()
	t.Cleanup(func() {
		ResetTestnetGreen()
		ResetBoostForTest()
	})
	now := time.Date(2026, 10, 12, 5, 0, 0, 0, time.UTC)
	GrantBoost(now)
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	weakPaper := NewPaper()
	goodPaper := NewPaper()
	weak := liveBoostEngine(t, 11, "XRPUSDT", weakPaper, now)
	good := liveBoostEngine(t, 12, "DOGEUSDT", goodPaper, now)
	peers := []int64{11, 12}
	weakIn := passingStep(now, candles, price, 0.2)
	weakIn.LivePeerIDs = peers
	goodIn := passingStep(now, candles, price, 0.6)
	goodIn.LivePeerIDs = peers

	snap, err := weak.Step(weakIn)
	if err != nil || snap.LastReason != ReasonWinRateBelow || weakPaper.Entries != 0 {
		t.Fatalf("weak %+v entries=%d err=%v", snap, weakPaper.Entries, err)
	}
	snap, err = good.Step(goodIn)
	if err != nil || snap.State != StateInPosition || goodPaper.Entries != 1 {
		t.Fatalf("good %+v entries=%d err=%v", snap, goodPaper.Entries, err)
	}
}

func TestBoostStillFlattensWhenProtectionFails(t *testing.T) {
	ResetTestnetGreen()
	SetTestnetGreen(true)
	ResetBoostForTest()
	t.Cleanup(func() {
		ResetTestnetGreen()
		ResetBoostForTest()
	})
	now := time.Date(2026, 10, 12, 5, 30, 0, 0, time.UTC)
	GrantBoost(now)
	cfg := testConfig()
	cfg.Mode = ModeLive
	cfg.ID = 21
	paper := NewPaper()
	ex := &failProtect{Paper: paper}
	eng := withSecrets(NewEngine(cfg, ex, DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	in := passingStep(now, candles, candles[len(candles)-1].Close, 0.8)
	in.LivePeerIDs = []int64{cfg.ID}
	snap, err := eng.Step(in)
	if !errors.Is(err, ErrNoAutoReopen) {
		t.Fatal(err)
	}
	var reason *ReasonError
	if !errors.As(err, &reason) || reason.Reason != ReasonProtectiveOrdersFailed {
		t.Fatalf("reason %#v err=%v", reason, err)
	}
	pos, posErr := paper.Position(cfg.Symbol)
	if posErr != nil || pos.Open || ex.closes != 1 || ex.reason != ReasonProtectiveOrdersFailed {
		t.Fatalf("flat=%v closes=%d reason=%s err=%v", pos, ex.closes, ex.reason, posErr)
	}
	if snap.State != StateError || snap.LastReason != ReasonProtectiveOrdersFailed {
		t.Fatalf("snap %+v", snap)
	}
}

func TestBoostDoesNotBypassBalanceFloor(t *testing.T) {
	ResetBoostForTest()
	t.Cleanup(ResetBoostForTest)
	now := time.Date(2026, 10, 12, 6, 0, 0, 0, time.UTC)
	GrantBoost(now)
	h := NewHub()
	var stopped []int64
	h.SetRunHook(func(id int64, running bool) {
		if !running {
			stopped = append(stopped, id)
		}
	})
	cfg := testConfig()
	armed := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	if err := armed.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	h.PutForTest(1, 31, armed)
	heldCfg := cfg
	heldCfg.ID = 32
	held := withSecrets(NewEngine(heldCfg, NewPaper(), DiscardLogger()))
	if err := held.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	held.SeedPositionForTest(SideLong, 10, 1, 0.9, 1.2)
	h.PutForTest(1, 32, held)
	otherCfg := cfg
	otherCfg.ID = 33
	otherCfg.ExchangeKeyID = 2
	other := withSecrets(NewEngine(otherCfg, NewPaper(), DiscardLogger()))
	if err := other.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	h.PutForTest(1, 33, other)

	snap, err := h.Step(1, 32, heldCfg, StepInput{
		Now: now, MarkPrice: 1, WalletKnown: true, Wallet: BalanceFloorUSDT, Available: BalanceFloorUSDT,
	}, held.secrets)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Running || snap.State != StateInPosition {
		t.Fatalf("held %+v", snap)
	}
	if armed.running || armed.State() != StateIdle {
		t.Fatalf("armed running=%v state=%s", armed.running, armed.State())
	}
	if !other.running || other.State() != StateArmed {
		t.Fatalf("other key running=%v state=%s", other.running, other.State())
	}
	if len(stopped) != 2 {
		t.Fatalf("stopped %v", stopped)
	}
}

func TestEventRingKeepsLast200(t *testing.T) {
	ResetBoostForTest()
	t.Cleanup(ResetBoostForTest)
	for i := 0; i < EventCapacity+5; i++ {
		AddEvent(DetectionEvent{Symbol: "XRPUSDT", Score: i, Action: "tick"})
	}
	got := RecentEvents()
	if len(got) != EventCapacity {
		t.Fatalf("len %d", len(got))
	}
	if got[0].Score != 5 || got[len(got)-1].Score != EventCapacity+4 {
		t.Fatalf("range %d .. %d", got[0].Score, got[len(got)-1].Score)
	}
}

func TestEngineTickAppendsDetection(t *testing.T) {
	ResetBoostForTest()
	t.Cleanup(ResetBoostForTest)
	eng := withSecrets(NewEngine(testConfig(), NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 6, 30, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	if _, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 20)); err != nil {
		t.Fatal(err)
	}
	got := RecentEvents()
	if len(got) != 1 {
		t.Fatalf("%d %+v", len(got), got)
	}
	ev := got[0]
	if ev.Symbol != SymbolXRPUSDT || ev.Action == "" || ev.TS.IsZero() {
		t.Fatalf("%+v", ev)
	}
}

func TestBoostGateWaitsForPeersThenBreaksTiesByID(t *testing.T) {
	ResetBoostForTest()
	t.Cleanup(ResetBoostForTest)
	now := time.Date(2026, 10, 12, 7, 0, 0, 0, time.UTC)
	GrantBoost(now)
	boostState.note(2, 0.7, true)
	allow, reason := boostState.allow(2, []int64{1, 2}, now)
	if allow || reason != ReasonBoostWait {
		t.Fatalf("early allow=%v reason=%s", allow, reason)
	}
	boostState.note(1, 0.7, true)
	allow, reason = boostState.allow(2, []int64{1, 2}, now)
	if allow || reason != ReasonBoostWait {
		t.Fatalf("tie allow=%v reason=%s", allow, reason)
	}
	allow, reason = boostState.allow(1, []int64{1, 2}, now)
	if !allow || reason != "" {
		t.Fatalf("lower id allow=%v reason=%s", allow, reason)
	}
}

func liveBoostEngine(t *testing.T, id int64, symbol string, paper *Paper, now time.Time) *Engine {
	t.Helper()
	cfg := testConfig()
	cfg.Mode = ModeLive
	cfg.ID = id
	cfg.Symbol = symbol
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	return eng
}

func passingStep(now time.Time, candles []Candle, price, winrate float64) StepInput {
	in := stepAt(now, candles, price, 20)
	in.Backtest = &BacktestSummary{WinRate: winrate, Trades: DefaultMinTrades, NetR: 1}
	return in
}
