package trading

import (
	"errors"
	"math"
	"testing"
	"time"
)

func testConfig() Config {
	cfg := DefaultConfig()
	cfg.ExchangeKeyID = 1
	return cfg
}

func withSecrets(eng *Engine) *Engine {
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: "test-api-key-0123", APISecret: "test-api-secret-0123"}, nil
	})
	return eng
}

func calmStart(now time.Time, equity float64) StartInput {
	return StartInput{
		Now:            now,
		FundingRate:    0.0001,
		LiqDistancePct: -1,
		EquityUSDT:     equity,
	}
}

func TestPaperGoldenCrossTakeProfitDoesNotReenterSameBar(t *testing.T) {
	paper := NewPaper()
	eng := withSecrets(NewEngine(testConfig(), paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	mark := candles[len(candles)-1].Close
	snap, err := eng.Step(stepAt(now, candles, mark, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || snap.Side != SideLong {
		t.Fatalf("entry snap %+v", snap)
	}
	if paper.Leverage != 3 || paper.MarginMode != MarginIsolated {
		t.Fatalf("paper leverage=%d margin=%s", paper.Leverage, paper.MarginMode)
	}
	trace := eng.Trace()
	for _, want := range []State{StateEntrySubmitted, StateInPosition} {
		if !hasState(trace, want) {
			t.Fatalf("trace %v missing %s", trace, want)
		}
	}

	snap, err = eng.Step(stepAt(now, candles, snap.TakeProfitPrice+0.0001, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateArmed || snap.Qty != 0 || snap.Side != "" {
		t.Fatalf("after tp %+v", snap)
	}
	if snap.DayRealized <= 0 || snap.CumulativeRealized != snap.DayRealized {
		t.Fatalf("tp should realize profit, got day %v cumulative %v", snap.DayRealized, snap.CumulativeRealized)
	}
	trace = eng.Trace()
	for _, want := range []State{StateExitSubmitted, StateSettled, StateIdle, StateArmed} {
		if !hasState(trace, want) {
			t.Fatalf("trace %v missing %s", trace, want)
		}
	}
	if _, err := eng.Step(stepAt(now, candles, mark, 2)); err != nil {
		t.Fatal(err)
	}
	if paper.Entries != 1 || eng.State() != StateArmed {
		t.Fatalf("same bar reentered entries=%d state=%s", paper.Entries, eng.State())
	}
}

func TestReverseSignalExitsWithoutFlipping(t *testing.T) {
	paper := NewPaper()
	eng := withSecrets(NewEngine(testConfig(), paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	entry := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, entry, entry[len(entry)-1].Close, 2))
	if err != nil || snap.Side != SideLong {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	death := candlesUntil(t, CrossDeath)
	snap, err = eng.Step(stepAt(now, death, snap.EntryPrice, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.LastReason != "reverse_signal" || snap.Side != "" || snap.State != StateArmed {
		t.Fatalf("reverse %+v", snap)
	}
	pos, err := paper.Position(SymbolXRPUSDT)
	if err != nil || pos.Open {
		t.Fatalf("position still open: %+v err=%v", pos, err)
	}
	if paper.Entries != 1 {
		t.Fatalf("flipped into a new entry: %d", paper.Entries)
	}
}

func TestDeathCrossOpensShort(t *testing.T) {
	eng := withSecrets(NewEngine(testConfig(), NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossDeath)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || snap.Side != SideShort {
		t.Fatalf("%+v", snap)
	}
	if snap.StopPrice <= snap.EntryPrice || snap.TakeProfitPrice >= snap.EntryPrice {
		t.Fatalf("short protection %+v", snap)
	}
}

func TestStopLossHaltsUntilNextUTCDay(t *testing.T) {
	eng := withSecrets(NewEngine(testConfig(), NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 3, 0, 0, 0, time.UTC)
	// 1U 资本的 4% 是 0.04。1R 亏损约为 0.008*5.1=0.0408，一笔就停机。
	if err := eng.Start(calmStart(now, 1)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 1))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	snap, err = eng.Step(stepAt(now, candles, snap.StopPrice, 1))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateDailyHalt || !snap.Halted || snap.DayRealized >= 0 || snap.CumulativeRealized != snap.DayRealized {
		t.Fatalf("halt %+v", snap)
	}
	if err := eng.Start(calmStart(now.Add(time.Hour), 1)); !errors.Is(err, ErrDailyHalt) {
		t.Fatalf("same day start err=%v", err)
	}
	if eng.State() != StateDailyHalt {
		t.Fatalf("state %s", eng.State())
	}
	if err := eng.Start(calmStart(now.Add(24*time.Hour), 1)); err != nil {
		t.Fatal(err)
	}
	next := eng.Snapshot()
	if eng.State() != StateArmed || next.Halted || next.DayRealized != 0 || next.CumulativeRealized >= 0 {
		t.Fatalf("next day %+v", next)
	}
}

func TestRestoreKeepsCumulativeRealized(t *testing.T) {
	eng := withSecrets(NewEngine(testConfig(), NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := eng.Step(stepAt(now, candles, snap.TakeProfitPrice+0.0001, 2)); err != nil {
		t.Fatal(err)
	}
	rt := eng.Runtime()
	if rt.Cumulative <= 0 || rt.Cumulative != rt.Realized {
		t.Fatalf("runtime %+v", rt)
	}
	restored := NewEngine(testConfig(), NewPaper(), DiscardLogger())
	restored.Restore(rt)
	got := restored.Snapshot()
	if got.DayRealized != rt.Realized || got.CumulativeRealized != rt.Cumulative {
		t.Fatalf("restored %+v runtime %+v", got, rt)
	}
	legacy := NewEngine(testConfig(), NewPaper(), DiscardLogger())
	legacy.Restore(Runtime{State: StateIdle, Realized: -0.2, Capital: 2, Day: now})
	if legacy.Snapshot().CumulativeRealized != -0.2 || legacy.Snapshot().DayRealized != -0.2 {
		t.Fatalf("legacy %+v", legacy.Snapshot())
	}
}

func TestFundingAndLiquidationBlockStart(t *testing.T) {
	paper := NewPaper()
	eng := withSecrets(NewEngine(testConfig(), paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	err := eng.Start(StartInput{Now: now, EquityUSDT: 2, FundingRate: 0.002, LiqDistancePct: -1})
	if !errors.Is(err, ErrBlocked) || eng.State() != StateBlocked {
		t.Fatalf("funding err=%v state=%s", err, eng.State())
	}
	err = eng.Start(StartInput{Now: now, EquityUSDT: 2, FundingRate: 0, LiqDistancePct: 0.01})
	if !errors.Is(err, ErrBlocked) || eng.State() != StateBlocked {
		t.Fatalf("liq err=%v state=%s", err, eng.State())
	}
	if paper.Entries != 0 {
		t.Fatalf("blocked start placed %d entries", paper.Entries)
	}
	if err := eng.Start(calmStart(now, 2)); err != nil || eng.State() != StateArmed {
		t.Fatalf("clearance err=%v state=%s", err, eng.State())
	}
}

func TestLiveGateRefusesUntilTestnetGreen(t *testing.T) {
	ResetTestnetGreen()
	t.Cleanup(ResetTestnetGreen)
	cfg := testConfig()
	cfg.Mode = ModeLive
	spy := NewLiveStub()
	eng := withSecrets(NewEngine(cfg, spy, DiscardLogger()))
	err := eng.Start(calmStart(time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC), 2))
	if !errors.Is(err, ErrLiveGateClosed) {
		t.Fatal(err)
	}
	if eng.State() != StateIdle || spy.Entries != 0 || eng.SecretOpens() != 0 {
		t.Fatalf("state=%s entries=%d opens=%d", eng.State(), spy.Entries, eng.SecretOpens())
	}
	ex, err := NewExchange(cfg)
	if !errors.Is(err, ErrLiveGateClosed) || ex != nil {
		t.Fatalf("factory ex=%v err=%v", ex, err)
	}
}

func TestNewExchangeReturnsLiveUSDMClientWhenGateOpens(t *testing.T) {
	ResetTestnetGreen()
	SetTestnetGreen(true)
	t.Cleanup(ResetTestnetGreen)
	cfg := testConfig()
	cfg.Mode = ModeLive
	ex, err := NewExchange(cfg)
	if err != nil {
		t.Fatal(err)
	}
	client, ok := ex.(*USDMClient)
	if !ok {
		t.Fatalf("exchange %T", ex)
	}
	if client.BaseURL() != BinanceUSDMLiveBase || client.readOnly {
		t.Fatalf("base %s readOnly %v", client.BaseURL(), client.readOnly)
	}
	if err := client.UseCredentials(Credentials{
		APIKey: "live-key-0123456789", APISecret: "live-secret-0123456789", Network: ModeLive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := client.guard(); err != nil {
		t.Fatalf("live guard: %v", err)
	}
	if err := client.UseCredentials(Credentials{
		APIKey: "test-key-0123456789", APISecret: "test-secret-0123456789", Network: ModeTestnet,
	}); !errors.Is(err, ErrKeyNotUsable) {
		t.Fatalf("testnet key on live client err=%v", err)
	}
	if NewUSDMTestnet().BaseURL() != BinanceUSDMTestnetBase {
		t.Fatal("testnet base url")
	}
}

func TestEngineOpens20xWhenStopSitsInsideLiquidation(t *testing.T) {
	paper := NewPaper()
	cfg := testConfig()
	cfg.Leverage = MaxLeverage
	cfg.DailyLossPct = DailyLossOffPct
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	snap, err := eng.Step(stepAt(now, candles, price, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || snap.Side != SideLong || paper.Leverage != MaxLeverage || paper.MarginMode != MarginIsolated {
		t.Fatalf("20x entry %+v leverage=%d margin=%s", snap, paper.Leverage, paper.MarginMode)
	}
	if snap.StopPrice <= 0 || snap.LiqPrice <= 0 || !(snap.LiqPrice < snap.StopPrice && snap.StopPrice < snap.EntryPrice) {
		t.Fatalf("prices %+v", snap)
	}
	if !StopWithinLiquidation(SideLong, snap.EntryPrice, snap.StopPrice, snap.LiqPrice) {
		t.Fatalf("guard let a bad stop through %+v", snap)
	}
	wantLiq := snap.EntryPrice * (1 - 1/float64(MaxLeverage) + DefaultMaintMarginRate)
	if math.Abs(snap.LiqPrice-wantLiq) > 1e-9 {
		t.Fatalf("liq %v want %v", snap.LiqPrice, wantLiq)
	}
}

func TestEngineRefusesStopBeyondLiquidation(t *testing.T) {
	paper := NewPaper()
	cfg := testConfig()
	cfg.Leverage = MaxLeverage
	cfg.StopR = 20
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if !errors.Is(err, ErrBlocked) {
		t.Fatal(err)
	}
	var reason *ReasonError
	if !errors.As(err, &reason) || reason.Reason != ReasonStopBeyondLiquidation {
		t.Fatalf("reason %#v err=%v", reason, err)
	}
	if snap.State != StateBlocked || snap.LastReason != ReasonStopBeyondLiquidation || paper.Entries != 0 || eng.SecretOpens() != 0 {
		t.Fatalf("opened anyway %+v entries=%d opens=%d", snap, paper.Entries, eng.SecretOpens())
	}
	if snap.StopPrice <= 0 || snap.LiqPrice <= 0 || snap.EntryPrice <= 0 {
		t.Fatalf("missing prices %+v", snap)
	}
	if StopWithinLiquidation(SideLong, snap.EntryPrice, snap.StopPrice, snap.LiqPrice) {
		t.Fatalf("refused a stop that was inside liquidation %+v", snap)
	}
}

func TestFetchedBracketTightensLiquidation(t *testing.T) {
	paper := NewPaper()
	ex := bracketPaper{Paper: paper, rate: 0.045}
	cfg := testConfig()
	cfg.Leverage = MaxLeverage
	eng := withSecrets(NewEngine(cfg, ex, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if !errors.Is(err, ErrBlocked) || snap.LastReason != ReasonStopBeyondLiquidation || paper.Entries != 0 {
		t.Fatalf("bracket rate should pull liquidation inside the stop: %+v err=%v entries=%d", snap, err, paper.Entries)
	}
	want := snap.EntryPrice * (1 - 1/float64(MaxLeverage) + ex.rate)
	if math.Abs(snap.LiqPrice-want) > 1e-9 {
		t.Fatalf("liq %v want %v", snap.LiqPrice, want)
	}
}

type failProtect struct {
	*Paper
	closes int
	reason string
}

func (f *failProtect) PlaceProtection(Protection) error {
	return errors.New("take profit rejected")
}

func (f *failProtect) Close(req CloseOrder) (Fill, error) {
	f.closes++
	f.reason = req.Reason
	return f.Paper.Close(req)
}

func TestProtectiveOrderFailureFlattens(t *testing.T) {
	paper := NewPaper()
	ex := &failProtect{Paper: paper}
	eng := withSecrets(NewEngine(testConfig(), ex, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if !errors.Is(err, ErrNoAutoReopen) {
		t.Fatal(err)
	}
	var reason *ReasonError
	if !errors.As(err, &reason) || reason.Reason != ReasonProtectiveOrdersFailed {
		t.Fatalf("reason %#v err=%v", reason, err)
	}
	pos, posErr := paper.Position(SymbolXRPUSDT)
	if posErr != nil || pos.Open || ex.closes != 1 || ex.reason != ReasonProtectiveOrdersFailed {
		t.Fatalf("flat=%v closes=%d reason=%s err=%v", pos, ex.closes, ex.reason, posErr)
	}
	if snap.State != StateError || snap.LastReason != ReasonProtectiveOrdersFailed || snap.StopPrice <= 0 || snap.LiqPrice <= 0 {
		t.Fatalf("snap %+v", snap)
	}
}

type bracketPaper struct {
	*Paper
	rate float64
}

func (b bracketPaper) MaintMarginRate(string, int) (float64, bool) {
	if b.rate <= 0 {
		return 0, false
	}
	return b.rate, true
}

func stepAt(now time.Time, candles []Candle, mark, equity float64) StepInput {
	return StepInput{
		Now:            now,
		Candles:        candles,
		MarkPrice:      mark,
		FundingRate:    0.0001,
		LiqDistancePct: -1,
		EquityUSDT:     equity,
	}
}

func hasState(trace []State, want State) bool {
	for _, st := range trace {
		if st == want {
			return true
		}
	}
	return false
}
