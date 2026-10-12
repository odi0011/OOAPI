package trading

import (
	"context"
	"errors"
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
	first := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	if err := first.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	first.SeedPositionForTest(SideLong, 10, 1, 0.9, 1.2)
	h.PutForTest(1, 1, first)
	secondCfg := cfg
	second := withSecrets(NewEngine(secondCfg, NewPaper(), DiscardLogger()))
	if err := second.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	second.SeedPositionForTest(SideShort, 10, 1, 1.1, 0.8)
	h.PutForTest(1, 2, second)
	h.SetAccount(cfg.ExchangeKeyID, 100, 100)

	third := cfg
	third.ID = 3
	if got := h.EntrySkip(third); got != ReasonPortfolioLimit {
		t.Fatalf("two positions: %s", got)
	}

	h2 := NewHub()
	wide := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	if err := wide.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	wide.SeedPositionForTest(SideLong, 1000, 1, 0.9, 1.2)
	h2.PutForTest(1, 1, wide)
	h2.SetAccount(cfg.ExchangeKeyID, 100, 100)
	one := cfg
	one.ID = 4
	if got := h2.EntrySkip(one); got != ReasonPortfolioLimit {
		t.Fatalf("margin cap: %s", got)
	}
	h2.SetAccount(cfg.ExchangeKeyID, 10000, 10000)
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
	snap, err := floor.Step(7, 8, cfg, StepInput{WalletKnown: true, Wallet: 0.4, Available: 0.2}, eng.secrets)
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
		return Market{Wallet: 0.4, Available: 0.4, WalletKnown: true}, nil
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
