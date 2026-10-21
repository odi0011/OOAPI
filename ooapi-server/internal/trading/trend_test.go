package trading

import (
	"context"
	"errors"
	"math"
	"os"
	"testing"
	"time"
)

func TestTrendEntersWithoutFreshCrossAndReentersNextBar(t *testing.T) {
	cfg := testConfig()
	cfg.EntryMode = EntryModeTrend
	cfg.MinScore = 1
	cfg.DailyLossPct = DailyLossOffPct
	candles := appendBar(candlesUntil(t, CrossGolden), 1.001)
	cross, err := LastCross(closesOf(candles), cfg.EmaFast, cfg.EmaSlow)
	if err != nil || cross != CrossNone {
		t.Fatalf("fixture cross=%s err=%v", cross, err)
	}
	side, score, err := ScoreTrend(cfg, candles, nil)
	if err != nil || side != SideLong || score < 1 {
		t.Fatalf("score side=%s score=%d err=%v", side, score, err)
	}
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	price := candles[len(candles)-1].Close
	snap, err := eng.Step(stepAt(now, candles, price, 20))
	if err != nil || snap.Side != SideLong || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	if _, err := eng.Step(stepAt(now, candles, price, 20)); err != nil {
		t.Fatal(err)
	}
	if paper.Entries != 1 {
		t.Fatalf("double step entries=%d", paper.Entries)
	}
	snap, err = eng.Step(stepAt(now, candles, snap.TakeProfitPrice+0.01, 20))
	if err != nil || snap.State != StateArmed || snap.LastReason != "take_profit" {
		t.Fatalf("tp %+v err=%v", snap, err)
	}
	if _, err := eng.Step(stepAt(now, candles, price, 20)); err != nil {
		t.Fatal(err)
	}
	if paper.Entries != 1 || eng.State() != StateArmed {
		t.Fatalf("same bar reentry entries=%d state=%s", paper.Entries, eng.State())
	}
	later := appendBar(candles, 1.001)
	snap, err = eng.Step(stepAt(now, later, later[len(later)-1].Close, 20))
	if err != nil || snap.Side != SideLong || paper.Entries != 2 {
		t.Fatalf("next bar %+v entries=%d err=%v", snap, paper.Entries, err)
	}
}

func TestTrendShortAndFlipExit(t *testing.T) {
	cfg := testConfig()
	cfg.EntryMode = EntryModeTrend
	cfg.MinScore = 1
	cfg.DailyLossPct = DailyLossOffPct
	candles := appendBar(candlesUntil(t, CrossDeath), 0.999)
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 20))
	if err != nil || snap.Side != SideShort {
		t.Fatalf("short %+v err=%v", snap, err)
	}
	up := candlesUntil(t, CrossGolden)
	snap, err = eng.Step(stepAt(now, up, snap.EntryPrice, 20))
	if err != nil || snap.LastReason != "reverse_signal" || snap.Side != "" {
		t.Fatalf("flip %+v err=%v", snap, err)
	}
}

func TestBelowMinNotionalSkips(t *testing.T) {
	cfg := testConfig()
	cfg.MaxMarginUsdt = 1
	cfg.Leverage = 3
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 20))
	if err != nil || snap.LastReason != ReasonBelowMinNotional || snap.State != StateArmed || paper.Entries != 0 {
		t.Fatalf("snap %+v entries=%d err=%v", snap, paper.Entries, err)
	}
}

func TestWinRateGateSkipsUntilBacktestPasses(t *testing.T) {
	cfg := testConfig()
	cfg.MinWinRate = 0.5
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	in := stepAt(now, candles, candles[len(candles)-1].Close, 20)
	in.Backtest = &BacktestSummary{WinRate: 0.4, Trades: 8, NetR: -0.5}
	snap, err := eng.Step(in)
	if err != nil || snap.LastReason != ReasonWinRateBelow || paper.Entries != 0 {
		t.Fatalf("blocked %+v entries=%d err=%v", snap, paper.Entries, err)
	}
	in.Backtest = &BacktestSummary{WinRate: 0.5, Trades: DefaultMinTrades, NetR: 1}
	snap, err = eng.Step(in)
	if err != nil || snap.Side != SideLong || paper.Entries != 1 {
		t.Fatalf("pass %+v entries=%d err=%v", snap, paper.Entries, err)
	}
}

func TestWindowStatsAndSweepPass(t *testing.T) {
	base := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	trades := []BacktestTrade{
		{OpenedAt: base.Add(24 * time.Hour), NetR: 1},
		{OpenedAt: base.Add(6 * 24 * time.Hour), NetR: -0.5},
	}
	in := WindowStats(trades, base, base.Add(5*24*time.Hour))
	out := WindowStats(trades, base.Add(5*24*time.Hour), base.Add(8*24*time.Hour))
	if in.Trades != 1 || in.WinRate != 1 || in.NetR != 1 || out.Trades != 1 || out.NetR != -0.5 {
		t.Fatalf("in %+v out %+v", in, out)
	}
	if SweepPass(BacktestSummary{WinRate: 1, Trades: 8, NetR: 4}, BacktestSummary{NetR: 1}) {
		t.Fatal("8 trades passed the sweep flag")
	}
	good := BacktestSummary{WinRate: 0.5, Trades: DefaultMinTrades, NetR: 0.2}
	if !SweepPass(good, BacktestSummary{NetR: 0.1}) {
		t.Fatal("expected pass")
	}
	if SweepPass(good, BacktestSummary{NetR: 0}) {
		t.Fatal("flat out-of-sample passed")
	}
}

func TestLiveBacktestGateKeepsWinRateFloor(t *testing.T) {
	cfg := testConfig()
	cfg.Mode = ModeLive
	cfg.MinWinRate = 0
	cfg.MinTrades = 1
	pass := BacktestSummary{WinRate: DefaultMinWinRate, Trades: DefaultMinTrades, NetR: 0.1}
	if got := BacktestGate(cfg, &pass); got != "" {
		t.Fatalf("live floor %g/%d should pass, got %s", DefaultMinWinRate, DefaultMinTrades, got)
	}
	if got := BacktestGate(cfg, &BacktestSummary{WinRate: 1, Trades: DefaultMinTrades - 1, NetR: 3}); got != ReasonInsufficientSamples {
		t.Fatalf("samples %s", got)
	}
	if got := BacktestGate(cfg, &BacktestSummary{WinRate: DefaultMinWinRate - 0.01, Trades: 40, NetR: 1}); got != ReasonWinRateBelow {
		t.Fatalf("win rate %s", got)
	}
	if got := BacktestGate(cfg, nil); got != ReasonWinRateBelow {
		t.Fatalf("missing %s", got)
	}
	// 策略把门槛设得更高时仍用策略值，不会被默认地板放行。
	cfg.MinWinRate = 0.6
	cfg.MinTrades = 20
	if got := BacktestGate(cfg, &pass); got != ReasonWinRateBelow {
		t.Fatalf("configured floor %s", got)
	}
}

func TestMarginPerTradeCapsEntry(t *testing.T) {
	cfg := testConfig()
	cfg.EntryMode = EntryModeTrend
	cfg.MinScore = 1
	cfg.DailyLossPct = DailyLossOffPct
	cfg.Leverage = 20
	cfg.MaxMarginUsdt = 10
	cfg.MaxMarginPerTradeUsdt = 1
	candles := appendBar(candlesUntil(t, CrossGolden), 1.001)
	price := candles[len(candles)-1].Close
	eng := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 50)); err != nil {
		t.Fatal(err)
	}
	snap, err := eng.Step(stepAt(now, candles, price, 50))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	_, _, want, err := SizePosition(1, 20, price, MinNotionalUSDT)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(snap.Qty-want) > 1e-9 {
		t.Fatalf("qty=%v want=%v", snap.Qty, want)
	}
}

func TestConsecutiveLossesPauseAndStayPaused(t *testing.T) {
	cfg := testConfig()
	cfg.EntryMode = EntryModeTrend
	cfg.MinScore = 1
	cfg.DailyLossPct = DailyLossOffPct
	cfg.CooldownBarsAfterLoss = 0
	cfg.MaxConsecutiveLosses = 3
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	var saved string
	eng.SetPauseHook(func(reason string) { saved = reason })
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 50)); err != nil {
		t.Fatal(err)
	}
	candles := appendBar(candlesUntil(t, CrossGolden), 1.001)
	var snap Snapshot
	for i := 0; i < 3; i++ {
		if i > 0 {
			candles = appendBar(candles, 1.001)
		}
		var err error
		snap, err = eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 50))
		if err != nil || snap.State != StateInPosition {
			t.Fatalf("entry %d %+v err=%v", i, snap, err)
		}
		snap, err = eng.Step(stepAt(now, candles, snap.StopPrice, 50))
		if err != nil {
			t.Fatalf("exit %d %v", i, err)
		}
	}
	if snap.LastReason != ReasonConsecutiveLosses || snap.PauseReason != ReasonConsecutiveLosses || snap.Running || snap.State != StateIdle {
		t.Fatalf("pause %+v", snap)
	}
	if saved != ReasonConsecutiveLosses || paper.Entries != 3 {
		t.Fatalf("saved=%s entries=%d", saved, paper.Entries)
	}
	runner := NewRunner(NewHub())
	runner.Start()
	cfg.ID = 4
	cfg.PauseReason = ReasonConsecutiveLosses
	runner.Sync([]RunSpec{{UserID: 1, Config: cfg}})
	if _, ok := runner.hub.State(1, 4); ok {
		t.Fatal("paused strategy resumed")
	}
}

func TestBalanceBelowPauseStopsEngine(t *testing.T) {
	cfg := testConfig()
	cfg.PauseBalanceUsdt = 1.5
	eng := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	var saved string
	eng.SetPauseHook(func(reason string) { saved = reason })
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, nil, 1, 20)
	in.WalletKnown = true
	in.Wallet = 1.2
	in.Available = 1.2
	snap, err := eng.Step(in)
	if err != nil || snap.LastReason != ReasonBalanceBelowPause || snap.PauseReason != ReasonBalanceBelowPause || snap.Running {
		t.Fatalf("pause %+v err=%v saved=%s", snap, err, saved)
	}
	if saved != ReasonBalanceBelowPause {
		t.Fatalf("saved %s", saved)
	}
	if err := eng.Start(calmStart(now, 20)); !errors.Is(err, ErrPaused) {
		t.Fatalf("start while paused err=%v", err)
	}
	eng.ClearPause()
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatalf("resume %v", err)
	}
}

func TestEightTradesBlockedDespiteHighWinRate(t *testing.T) {
	cfg := testConfig()
	cfg.MinWinRate = 0.5
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	in := stepAt(now, candles, candles[len(candles)-1].Close, 20)
	in.Backtest = &BacktestSummary{WinRate: 1, Trades: 8, NetR: 4}
	snap, err := eng.Step(in)
	if err != nil || snap.LastReason != ReasonInsufficientSamples || paper.Entries != 0 || snap.State != StateArmed {
		t.Fatalf("samples %+v entries=%d err=%v", snap, paper.Entries, err)
	}
	in.Backtest = &BacktestSummary{WinRate: 1, Trades: DefaultMinTrades, NetR: 0}
	snap, err = eng.Step(in)
	if err != nil || snap.LastReason != ReasonNetRNotPositive || paper.Entries != 0 {
		t.Fatalf("netR %+v entries=%d err=%v", snap, paper.Entries, err)
	}
}

func TestBacktestFeesAndSlippageReduceNetR(t *testing.T) {
	cfg := testConfig()
	cfg.EntryMode = EntryModeCross
	cfg.DailyLossPct = DailyLossOffPct
	candles := candlesUntil(t, CrossGolden)
	last := candles[len(candles)-1]
	fill := last.Close * (1 + SlippageRate)
	_, take, err := ProtectionPrices(SideLong, fill, fill*DefaultRFraction, cfg.StopR, cfg.TakeProfitR)
	if err != nil {
		t.Fatal(err)
	}
	jump := last
	jump.OpenTime = last.OpenTime.Add(5 * time.Minute)
	jump.Close = take * 1.02
	candles = append(candles, jump)

	got, err := Backtest(cfg, candles, nil)
	if err != nil {
		t.Fatal(err)
	}
	bare, err := backtest(cfg, candles, nil, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.TradeCount != 1 || bare.TradeCount != 1 {
		t.Fatalf("trades got=%d bare=%d", got.TradeCount, bare.TradeCount)
	}
	if got.WinRate != 1 || got.Trades[0].Reason != "take_profit" || got.Trades[0].NetR <= 0 {
		t.Fatalf("trade %+v win=%v", got.Trades[0], got.WinRate)
	}
	if got.NetR >= bare.NetR-1e-9 {
		t.Fatalf("fees did not reduce netR got=%v bare=%v", got.NetR, bare.NetR)
	}
	if got.TakerFee != TakerFeeRate || got.Slippage != SlippageRate {
		t.Fatalf("rates %+v", got)
	}
}

func TestPortfolioLimitAndBalanceFloorShareTheHubLock(t *testing.T) {
	h := NewHub()
	cfg := testConfig()
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	// 笔数只数 positionRisk。内存里多出来的旧仓不占名额，保证金为 0 时也不碰到总额上限。
	h.SetAccount(cfg.ExchangeKeyID, 100, 100)
	h.SetPositions(cfg.ExchangeKeyID, []KeyPosition{
		{Symbol: "XRPUSDT", Qty: 1},
		{Symbol: "DOGEUSDT", Qty: 1},
		{Symbol: "BTCUSDT", Qty: 1},
	})
	stale := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	if err := stale.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	stale.SeedPositionForTest(SideShort, 1000, 1, 1.1, 0.8)
	h.PutForTest(1, 99, stale)
	fourth := cfg
	fourth.ID = 4
	if got := h.EntrySkip(fourth); got != "" {
		t.Fatalf("open positions are not capped by default: %s", got)
	}
	fourth.MaxOpenPositions = 2
	if got := h.EntrySkip(fourth); got != ReasonPortfolioLimit {
		t.Fatalf("configured cap: %s", got)
	}
	fourth.MaxOpenPositions = 0
	t.Setenv(EnvMaxOpenPositions, "2")
	if got := h.EntrySkip(fourth); got != ReasonPortfolioLimit {
		t.Fatalf("env cap: %s", got)
	}

	h2 := NewHub()
	h2.SetAccount(cfg.ExchangeKeyID, 2.06, 2.06)
	// 20 倍名义价值是 20，初始保证金是 1。总额上限 1.7，单笔 1，已用 1 再加 1 会超。
	h2.SetPositions(cfg.ExchangeKeyID, []KeyPosition{
		{Symbol: "XRPUSDT", Qty: 20, Entry: 1, Leverage: 20},
	})
	one := cfg
	one.ID = 4
	one.MaxMarginUsdt = 1.7
	one.MaxMarginPerTradeUsdt = 1
	one.Leverage = 20
	if got := h2.EntrySkip(one); got != ReasonPortfolioLimit {
		t.Fatalf("margin cap: %s", got)
	}
	h2.SetPositions(cfg.ExchangeKeyID, []KeyPosition{
		{Symbol: "XRPUSDT", Qty: 10, Entry: 1, Leverage: 20},
	})
	if got := h2.EntrySkip(one); got != "" {
		t.Fatalf("room: %s", got)
	}

	floor := NewHub()
	var stopped []int64
	floor.SetRunHook(func(id int64, running bool) {
		if !running {
			stopped = append(stopped, id)
		}
	})
	eng := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	floor.PutForTest(7, 8, eng)
	other := cfg
	other.ID = 9
	otherEng := withSecrets(NewEngine(other, NewPaper(), DiscardLogger()))
	if err := otherEng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	floor.PutForTest(7, 9, otherEng)
	snap, err := floor.Step(7, 8, cfg, StepInput{WalletKnown: true, Wallet: 0.4, Available: 0.2, EquityKnown: true, AccountEquity: 0.4}, eng.secrets)
	if err != nil {
		t.Fatal(err)
	}
	if snap.LastReason != ReasonBalanceFloor || snap.Running || snap.State != StateIdle {
		t.Fatalf("floor %+v", snap)
	}
	if otherEng.running || otherEng.State() != StateIdle {
		t.Fatalf("peer running=%v state=%s", otherEng.running, otherEng.State())
	}
	if len(stopped) != 2 {
		t.Fatalf("stopped %v", stopped)
	}
}

func TestHubOneRunningStrategyPerKeyAndSymbol(t *testing.T) {
	h := NewHub()
	cfg := testConfig()
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	secrets := func() (Credentials, error) {
		return Credentials{APIKey: "test-api-key-0123", APISecret: "test-api-secret-0123"}, nil
	}
	if _, err := h.Start(1, 1, cfg, calmStart(now, 20), secrets); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Start(1, 2, cfg, calmStart(now, 20), secrets); !errors.Is(err, ErrSymbolInUse) {
		t.Fatalf("duplicate err=%v", err)
	}
	if _, ok := h.State(1, 1); !ok {
		t.Fatal("missing first")
	}
	if _, ok := h.State(1, 2); ok {
		t.Fatal("duplicate strategy was stored")
	}
}

func TestRunnerBalanceFloorStopsSpec(t *testing.T) {
	h := NewHub()
	r := NewRunner(h)
	var steps int
	var stopped int64
	r.SetMarket(func(Config, SecretOpener, time.Time) (Market, error) {
		return Market{Wallet: 0.4, Available: 0.4, WalletKnown: true, Equity: 0.4, EquityKnown: true}, nil
	})
	r.SetStep(func(RunSpec, StepInput) (Snapshot, error) {
		steps++
		return Snapshot{LastReason: ReasonBalanceFloor}, nil
	})
	r.SetStop(func(id int64) { stopped = id })
	cfg := testConfig()
	cfg.ID = 11
	r.runOnce(context.Background(), RunSpec{UserID: 1, Config: cfg})
	if steps != 1 || stopped != 11 {
		t.Fatalf("steps=%d stopped=%d", steps, stopped)
	}
}

func TestScoreTrendCountsEachSignal(t *testing.T) {
	cfg := testConfig()
	cfg.EntryMode = EntryModeTrend
	base := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	price := 100.0
	candles := make([]Candle, 0, 90)
	for i := 0; i < 90; i++ {
		switch i % 5 {
		case 4:
			price *= 0.997
		default:
			price *= 1.0015
		}
		vol := 10.0
		if i == 89 {
			vol = 40
		}
		candles = append(candles, Candle{
			OpenTime: base.Add(time.Duration(i) * 5 * time.Minute),
			Close:    price,
			Volume:   vol,
		})
	}
	higher := make([]Candle, 0, 40)
	hp := 100.0
	for i := 0; i < 40; i++ {
		hp *= 1.004
		higher = append(higher, Candle{
			OpenTime: base.Add(time.Duration(i) * 15 * time.Minute),
			Close:    hp,
			Volume:   10,
		})
	}
	rsi, ok := LastRSI(closesOf(candles), RSIPeriod)
	side, score, err := ScoreTrend(cfg, candles, higher)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || side != SideLong || score != 4 {
		t.Fatalf("side=%s score=%d rsi=%v ok=%v", side, score, rsi, ok)
	}
	quiet := append([]Candle(nil), candles...)
	quiet[len(quiet)-1].Volume = 1
	if _, score, err = ScoreTrend(cfg, quiet, higher); err != nil || score != 3 {
		t.Fatalf("volume score=%d err=%v", score, err)
	}
	down := make([]Candle, len(higher))
	copy(down, higher)
	for i := range down {
		down[i].Close = 200 - float64(i)
	}
	if _, score, err = ScoreTrend(cfg, candles, down); err != nil || score != 3 {
		t.Fatalf("htf score=%d err=%v", score, err)
	}
}

func TestLiveXRPBacktestReport(t *testing.T) {
	if os.Getenv("LIVE_BACKTEST") == "" {
		t.Skip("set LIVE_BACKTEST=1 to fetch Binance klines")
	}
	now := time.Now().UTC()
	since := now.Add(-9 * 24 * time.Hour)
	candles, err := LoadCandles(ModeLive, SymbolXRPUSDT, Timeframe5m, since, now)
	if err != nil {
		t.Fatal(err)
	}
	higher, err := LoadCandles(ModeLive, SymbolXRPUSDT, HigherTimeframe, since, now)
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig()
	cfg.EntryMode = EntryModeTrend
	cfg.MinScore = DefaultMinScore
	cfg.MinWinRate = DefaultMinWinRate
	res, err := Backtest(cfg, candles, higher)
	if err != nil {
		t.Fatal(err)
	}
	from := now.Add(-7 * 24 * time.Hour)
	wins := 0
	net := 0.0
	n := 0
	for _, trade := range res.Trades {
		if trade.OpenedAt.Before(from) {
			continue
		}
		n++
		net += trade.NetR
		if trade.NetR > 0 {
			wins++
		}
	}
	winRate := 0.0
	if n > 0 {
		winRate = float64(wins) / float64(n)
	}
	t.Logf("XRPUSDT 5m days=7 trades=%d winRate=%.4f netR=%.4f candles=%d higher=%d", n, winRate, net, len(candles), len(higher))
}

func appendBar(candles []Candle, mult float64) []Candle {
	last := candles[len(candles)-1]
	out := append([]Candle(nil), candles...)
	out = append(out, Candle{
		OpenTime: last.OpenTime.Add(5 * time.Minute),
		Close:    last.Close * mult,
		Volume:   last.Volume,
	})
	return out
}
