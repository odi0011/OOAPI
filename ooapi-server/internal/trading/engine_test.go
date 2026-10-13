package trading

import (
	"context"
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
	cfg.Leverage = 20
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
	if snap.State != StateInPosition || snap.Side != SideLong || paper.Leverage != 20 || paper.MarginMode != MarginIsolated {
		t.Fatalf("20x entry %+v leverage=%d margin=%s", snap, paper.Leverage, paper.MarginMode)
	}
	if snap.StopPrice <= 0 || snap.LiqPrice <= 0 || !(snap.LiqPrice < snap.StopPrice && snap.StopPrice < snap.EntryPrice) {
		t.Fatalf("prices %+v", snap)
	}
	if !StopWithinLiquidation(SideLong, snap.EntryPrice, snap.StopPrice, snap.LiqPrice) {
		t.Fatalf("guard let a bad stop through %+v", snap)
	}
	wantLiq := snap.EntryPrice * (1 - 1/float64(20) + DefaultMaintMarginRate)
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

func TestEntryRejectedWhenLiquidationTooCloseForStop(t *testing.T) {
	paper := NewPaper()
	cfg := testConfig()
	cfg.Leverage = MaxLeverage
	cfg.RFraction = DefaultRFraction
	cfg.StopR = DefaultStopR
	cfg.ExpectancyGate = true
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	liq, err := IsolatedLiqPrice(SideLong, price, cfg.Leverage, DefaultMaintMarginRate)
	if err != nil {
		t.Fatal(err)
	}
	stop, _, err := ProtectionPrices(SideLong, price, price*cfg.RFraction, cfg.StopR, cfg.TakeProfitR)
	if err != nil {
		t.Fatal(err)
	}
	if StopWithinLiquidation(SideLong, price, stop, liq) {
		t.Fatal("fixture stop fits before liquidation; pick a tighter bracket")
	}
	snap, err := eng.Step(stepAt(now, candles, price, 20))
	if !errors.Is(err, ErrBlocked) {
		t.Fatal(err)
	}
	var reason *ReasonError
	if !errors.As(err, &reason) || reason.Reason != ReasonStopBeyondLiquidation {
		t.Fatalf("reason %#v err=%v", reason, err)
	}
	if snap.LastReason != ReasonStopBeyondLiquidation || paper.Entries != 0 || snap.State != StateBlocked {
		t.Fatalf("opened anyway %+v entries=%d", snap, paper.Entries)
	}
}

func TestNextTickUsesSavedRFraction(t *testing.T) {
	cfg := testConfig()
	cfg.ExpectancyGate = false
	eng := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	next := cfg
	next.RFraction = 0.004
	next.StopR = 1
	next.Revision = 3
	if err := eng.UpdateConfig(next); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 20))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("%+v err=%v", snap, err)
	}
	dist := math.Abs(snap.EntryPrice-snap.StopPrice) / snap.EntryPrice
	if math.Abs(dist-0.004) > 1e-6 {
		t.Fatalf("stop distance %v entry %v stop %v", dist, snap.EntryPrice, snap.StopPrice)
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

type bookProbe struct {
	*Paper
	trades int
	income int
}

func (b *bookProbe) CredentialsReady() bool { return true }

func (b *bookProbe) UserTrades(symbol string, since, now time.Time) ([]UserTrade, error) {
	b.trades++
	return []UserTrade{{
		Symbol: symbol, OrderID: "77", Side: "BUY", PositionSide: "BOTH",
		Price: 1.5, Qty: 4, Commission: 0.0625, RealizedPnl: 0, Time: since,
	}}, nil
}

func (b *bookProbe) IncomeHistory(symbol string, since, now time.Time) ([]IncomeEvent, error) {
	b.income++
	return []IncomeEvent{{
		Symbol: symbol, IncomeType: "COMMISSION", Income: -0.0625, Time: since,
	}}, nil
}

type memOrderBook struct {
	rows []OrderRow
}

func (m *memOrderBook) Upsert(userID, strategyID int64, rows []OrderRow) error {
	m.rows = append([]OrderRow(nil), rows...)
	return nil
}

func TestPauseEntriesSkipsOpenKeepsPositionAndBackfill(t *testing.T) {
	paper := NewPaper()
	probe := &bookProbe{Paper: paper}
	book := &memOrderBook{}
	SetOrderBook(book)
	t.Cleanup(func() { SetOrderBook(nil) })
	cfg := testConfig()
	cfg.ID = 9
	cfg.CreatedAt = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	eng := withSecrets(NewEngine(cfg, probe, DiscardLogger()))
	eng.SetUser(3)
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	eng.cfg.PauseEntries = true
	candles := candlesUntil(t, CrossGolden)
	mark := candles[len(candles)-1].Close
	snap, err := eng.Step(stepAt(now, candles, mark, 2))
	if err != nil {
		t.Fatal(err)
	}
	if paper.Entries != 0 || snap.State != StateArmed || !snap.PauseEntries || snap.LastReason != ReasonEntriesPaused {
		t.Fatalf("paused open entries=%d snap=%+v", paper.Entries, snap)
	}
	if probe.trades == 0 || probe.income == 0 || len(book.rows) != 1 || book.rows[0].OrderID != "77" || book.rows[0].Price != 1.5 || book.rows[0].Commission != 0.0625 {
		t.Fatalf("backfill trades=%d income=%d rows=%+v", probe.trades, probe.income, book.rows)
	}
	eng.cfg.PauseEntries = false
	snap, err = eng.Step(stepAt(now, candles, mark, 2))
	if err != nil {
		t.Fatal(err)
	}
	if paper.Entries != 1 || snap.State != StateInPosition {
		t.Fatalf("resume entries=%d snap=%+v", paper.Entries, snap)
	}
	eng.cfg.PauseEntries = true
	held := paper.Cancels
	snap, err = eng.Step(stepAt(now, candles, mark, 2))
	if err != nil {
		t.Fatal(err)
	}
	pos, posErr := paper.Position(cfg.Symbol)
	if posErr != nil || !pos.Open || snap.State != StateInPosition || paper.Entries != 1 || paper.Cancels != held {
		t.Fatalf("held pos=%+v entries=%d cancels=%d snap=%+v err=%v", pos, paper.Entries, paper.Cancels, snap, posErr)
	}
}

// countingSync 像实盘一样以交易所持仓为准，并记下保护单、平仓和撤单次数。
type countingSync struct {
	*Paper
	protects int
	closes   int
	cancels  int
	flat     bool
}

func (c *countingSync) SyncsPosition() bool { return true }

func (c *countingSync) PlaceProtection(req Protection) error {
	c.protects++
	return c.Paper.PlaceProtection(req)
}

func (c *countingSync) Close(req CloseOrder) (Fill, error) {
	c.closes++
	return c.Paper.Close(req)
}

func (c *countingSync) CancelOpen(symbol string) error {
	c.cancels++
	return c.Paper.CancelOpen(symbol)
}

func (c *countingSync) Position(symbol string) (Position, error) {
	if c.flat {
		return Position{}, nil
	}
	return c.Paper.Position(symbol)
}

func TestPauseEntriesLeavesProtectiveOrdersUntouched(t *testing.T) {
	paper := NewPaper()
	ex := &countingSync{Paper: paper}
	cfg := testConfig()
	eng := withSecrets(NewEngine(cfg, ex, DiscardLogger()))
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
	if snap.State != StateInPosition || snap.StopPrice <= 0 || ex.protects == 0 {
		t.Fatalf("open snap=%+v protects=%d", snap, ex.protects)
	}
	protects, closes, cancels := ex.protects, ex.closes, ex.cancels
	eng.cfg.PauseEntries = true
	snap, err = eng.Step(stepAt(now, candles, snap.StopPrice-0.01, 2))
	if err != nil {
		t.Fatal(err)
	}
	pos, posErr := paper.Position(cfg.Symbol)
	if posErr != nil || !pos.Open || snap.State != StateInPosition || snap.LastReason != ReasonEntriesPaused {
		t.Fatalf("held pos=%+v snap=%+v err=%v", pos, snap, posErr)
	}
	if ex.protects != protects || ex.closes != closes || ex.cancels != cancels {
		t.Fatalf("orders moved protects=%d closes=%d cancels=%d", ex.protects, ex.closes, ex.cancels)
	}
	ex.flat = true
	snap, err = eng.Step(stepAt(now, candles, mark, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateArmed || ex.protects != protects || ex.closes != closes || ex.cancels != cancels {
		t.Fatalf("flat settle snap=%+v protects=%d closes=%d cancels=%d", snap, ex.protects, ex.closes, ex.cancels)
	}
}

type incomePaper struct {
	*Paper
	events []IncomeEvent
	flat   bool
}

func (p *incomePaper) CredentialsReady() bool { return true }

func (p *incomePaper) SyncsPosition() bool { return true }

func (p *incomePaper) IncomeHistory(string, time.Time, time.Time) ([]IncomeEvent, error) {
	return p.events, nil
}

func (p *incomePaper) UserTrades(string, time.Time, time.Time) ([]UserTrade, error) {
	return nil, nil
}

func (p *incomePaper) Position(symbol string) (Position, error) {
	if p.flat {
		return Position{}, nil
	}
	return p.Paper.Position(symbol)
}

func (p *incomePaper) CancelProtective(string, Side) ([]int64, error) {
	return nil, nil
}

func (p *incomePaper) IncomeParts(symbol string, since, now time.Time) (IncomeParts, error) {
	var parts IncomeParts
	for _, event := range p.events {
		if event.Symbol != "" && event.Symbol != symbol {
			continue
		}
		if event.Time.Before(since) || event.Time.After(now) {
			continue
		}
		switch event.IncomeType {
		case "REALIZED_PNL":
			parts.RealizedPnL += event.Income
			parts.HasRealized = true
		case "COMMISSION":
			parts.Commission += event.Income
		case "FUNDING_FEE":
			parts.FundingFee += event.Income
		default:
			continue
		}
		parts.Rows++
	}
	return parts, nil
}

func (p *incomePaper) ClosingFill(string, Side, time.Time, time.Time) (float64, float64, bool, error) {
	return 1, 1, true, nil
}

func TestDailyLossUsesShanghaiIncomeNotRestartedMemory(t *testing.T) {
	paper := NewPaper()
	ex := &incomePaper{Paper: paper}
	now := time.Date(2026, 10, 12, 1, 30, 0, 0, shanghai)
	midnight := ShanghaiDayStart(now)
	ex.events = []IncomeEvent{
		{Symbol: SymbolXRPUSDT, IncomeType: "REALIZED_PNL", Income: -1, Time: midnight.Add(-time.Millisecond)},
		{Symbol: SymbolXRPUSDT, IncomeType: "COMMISSION", Income: -0.0625, Time: midnight},
	}
	cfg := testConfig()
	cfg.CreatedAt = time.Date(2026, 10, 10, 0, 0, 0, 0, shanghai)
	eng := withSecrets(NewEngine(cfg, ex, DiscardLogger()))
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	mark := candles[len(candles)-1].Close
	snap, err := eng.Step(stepAt(now, candles, mark, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.Halted || snap.State != StateInPosition || snap.DayRealized != -0.0625 || snap.CumulativeRealized != -1.0625 {
		t.Fatalf("yesterday loss must stay out of the shanghai day: %+v", snap)
	}
	if paper.Entries != 1 {
		t.Fatalf("entries %d", paper.Entries)
	}

	restartPaper := NewPaper()
	restartEx := &incomePaper{Paper: restartPaper, events: []IncomeEvent{
		{Symbol: SymbolXRPUSDT, IncomeType: "REALIZED_PNL", Income: -1, Time: midnight.Add(-time.Millisecond)},
		{Symbol: SymbolXRPUSDT, IncomeType: "REALIZED_PNL", Income: -0.125, Time: now},
	}}
	restart := withSecrets(NewEngine(cfg, restartEx, DiscardLogger()))
	if err := restart.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	snap, err = restart.Step(stepAt(now, candles, mark, 2))
	if err != nil && !errors.Is(err, ErrDailyHalt) {
		t.Fatal(err)
	}
	if snap.State != StateDailyHalt || snap.LastReason != "daily_loss" || snap.DayRealized != -0.125 || snap.CumulativeRealized != -1.125 || restartPaper.Entries != 0 {
		t.Fatalf("restart halt %+v entries=%d err=%v", snap, restartPaper.Entries, err)
	}
}

func TestReconcileFlatHaltReasonIsDailyLoss(t *testing.T) {
	paper := NewPaper()
	ex := &incomePaper{Paper: paper}
	now := time.Date(2026, 10, 12, 1, 30, 0, 0, shanghai)
	midnight := ShanghaiDayStart(now)
	ex.events = []IncomeEvent{
		{Symbol: SymbolXRPUSDT, IncomeType: "COMMISSION", Income: -0.03125, Time: midnight},
	}
	cfg := testConfig()
	cfg.CreatedAt = time.Date(2026, 10, 10, 0, 0, 0, 0, shanghai)
	eng := withSecrets(NewEngine(cfg, ex, DiscardLogger()))
	if err := eng.Start(calmStart(now, 1)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	mark := candles[len(candles)-1].Close
	snap, err := eng.Step(stepAt(now, candles, mark, 1))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("open %+v err=%v", snap, err)
	}
	ex.flat = true
	ex.events = []IncomeEvent{
		{Symbol: SymbolXRPUSDT, IncomeType: "REALIZED_PNL", Income: -5, Time: midnight.Add(-time.Millisecond)},
		{Symbol: SymbolXRPUSDT, IncomeType: "REALIZED_PNL", Income: -0.125, Time: now},
	}
	later := now.Add(IncomeRefresh + time.Second)
	snap, err = eng.Step(stepAt(later, candles, snap.StopPrice, 1))
	if err != nil && !errors.Is(err, ErrDailyHalt) {
		t.Fatal(err)
	}
	if snap.State != StateDailyHalt || snap.LastReason != "daily_loss" || snap.DayRealized != -0.125 || snap.CumulativeRealized != -5.125 {
		t.Fatalf("reconcile halt %+v err=%v", snap, err)
	}
}

func TestPauseBalanceAppliesWhilePositionIsOpen(t *testing.T) {
	cfg := testConfig()
	cfg.ID = 8
	cfg.PauseBalanceUsdt = 0.5
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	mark := candles[len(candles)-1].Close
	snap, err := eng.Step(stepAt(now, candles, mark, 20))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("open %+v err=%v", snap, err)
	}
	held := paper.Cancels
	next := cfg
	next.PauseBalanceUsdt = 3
	eng.noteLiveFlags(next)
	in := stepAt(now, candles, mark, 20)
	in.WalletKnown = true
	in.Wallet = 2
	in.Available = 2
	snap, err = eng.Step(in)
	if err != nil || snap.PauseReason != ReasonBalanceBelowPause || snap.Running || snap.State != StateInPosition {
		t.Fatalf("live pause %+v err=%v", snap, err)
	}
	pos, posErr := paper.Position(cfg.Symbol)
	if posErr != nil || !pos.Open || paper.Cancels != held {
		t.Fatalf("position pos=%+v cancels=%d held=%d err=%v", pos, paper.Cancels, held, posErr)
	}
}

func TestRunnerReadsPauseBalanceEachTick(t *testing.T) {
	r := NewRunner(NewHub())
	cfg := testConfig()
	cfg.ID = 21
	cfg.PauseBalanceUsdt = 0.5
	r.mu.Lock()
	r.specs[cfg.ID] = RunSpec{UserID: 1, Config: cfg}
	r.mu.Unlock()
	var seen float64
	r.SetMarket(func(Config, SecretOpener, time.Time) (Market, error) {
		return Market{Wallet: 20, Available: 20, WalletKnown: true, Equity: 20, EquityKnown: true, Mark: 1}, nil
	})
	r.SetStep(func(spec RunSpec, _ StepInput) (Snapshot, error) {
		seen = spec.Config.PauseBalanceUsdt
		return Snapshot{}, nil
	})
	r.SetPauseBalance(func(id int64) (float64, error) {
		if id != cfg.ID {
			t.Fatalf("id %d", id)
		}
		return 2.5, nil
	})
	r.runOnce(context.Background(), RunSpec{UserID: 1, Config: cfg})
	if seen != 2.5 {
		t.Fatalf("seen %v", seen)
	}
	r.SetPauseBalance(func(int64) (float64, error) {
		return 0, errors.New("db down")
	})
	r.runOnce(context.Background(), RunSpec{UserID: 1, Config: cfg})
	if seen != 2.5 {
		t.Fatalf("kept %v", seen)
	}
	r.SetPauseBalance(func(int64) (float64, error) {
		return 0.2, nil
	})
	r.runOnce(context.Background(), RunSpec{UserID: 1, Config: cfg})
	if seen != BalanceFloorUSDT {
		t.Fatalf("floor %v", seen)
	}
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
