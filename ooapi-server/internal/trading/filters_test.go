package trading

import (
	"math"
	"testing"
	"time"
)

func TestATRPctUsesTrueRange(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	candles := make([]Candle, 0, 20)
	price := 100.0
	for i := 0; i < 20; i++ {
		candles = append(candles, Candle{
			OpenTime: base.Add(time.Duration(i) * time.Minute),
			High:     price + 1,
			Low:      price - 1,
			Close:    price,
		})
	}
	got, ok := ATRPct(candles, ATRPeriod)
	if !ok {
		t.Fatal("atr not ready")
	}
	// 高低差恒为 2，收盘不变，ATR = 2，ATR% = 0.02。
	if math.Abs(got-0.02) > 1e-9 {
		t.Fatalf("atr%% %v", got)
	}
	bare := append([]Candle(nil), candles...)
	for i := range bare {
		bare[i].High, bare[i].Low = 0, 0
	}
	if _, ok := ATRPct(bare, ATRPeriod); ok {
		t.Fatal("close-only candles should not invent an ATR")
	}
}

func TestEntryVolFeeReasons(t *testing.T) {
	cfg := DefaultConfig()
	cfg.GambleMode = true
	cfg.ScalpSlPct = 0.003
	cfg.ScalpTpPct = 0.01
	cfg.SlNoiseMult = DefaultSlNoiseMult
	cfg.TpAtrMult = DefaultTpAtrMult
	cfg.FeeEdgeMult = DefaultFeeEdgeMult
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	noise := make([]Candle, 0, 20)
	price := 100.0
	for i := 0; i < 20; i++ {
		// ATR ≈ 1，ATR% ≈ 0.01。1.2×ATR% = 0.012 > 止损 0.003。
		noise = append(noise, Candle{
			OpenTime: base.Add(time.Duration(i) * time.Minute),
			High:     price + 0.5,
			Low:      price - 0.5,
			Close:    price,
		})
	}
	if got := entryVolFeeReason(cfg, noise, 2*TakerFeeRate); got != ReasonSLInsideNoise {
		t.Fatalf("noise %s", got)
	}

	quiet := make([]Candle, len(noise))
	for i := range quiet {
		quiet[i] = Candle{
			OpenTime: noise[i].OpenTime,
			High:     price + 0.01,
			Low:      price - 0.01,
			Close:    price,
		}
	}
	// ATR ≈ 0.02，ATR% ≈ 0.0002。止盈 0.01 > 8×0.0002。
	cfg.ScalpSlPct = 0.02
	if got := entryVolFeeReason(cfg, quiet, 2*TakerFeeRate); got != ReasonTPUnreachable {
		t.Fatalf("unreachable %s", got)
	}

	cfg.ScalpTpPct = 0.001
	cfg.ScalpSlPct = 0.02
	flat := make([]Candle, 0, 5)
	for i := 0; i < 5; i++ {
		flat = append(flat, Candle{OpenTime: base.Add(time.Duration(i) * time.Minute), Close: price})
	}
	if got := entryVolFeeReason(cfg, flat, 2*TakerFeeRate); got != ReasonFeeEdgeTooSmall {
		t.Fatalf("fee %s", got)
	}
	cfg.FeeEdgeMult = 1e-6
	if got := entryVolFeeReason(cfg, flat, 2*TakerFeeRate); got != "" {
		t.Fatalf("relaxed fee %s", got)
	}
}

func TestReverseExitHoldAndGap(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeframe = Timeframe5m
	cfg.ReverseMinHoldBars = 0
	cfg.ReverseMinGapPct = 0.0005
	opened := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := opened
	price := 100.0
	// 0.04 / 100 = 0.04%，小于默认张开 0.05%。
	if allowReverseExit(cfg, SideLong, CrossDeath, price, opened, now, 99.96, 100, true) {
		t.Fatal("gap below 0.05% should stay with the exchange stop")
	}
	if !allowReverseExit(cfg, SideLong, CrossDeath, price, opened, now, 99.9, 100, true) {
		t.Fatal("hold 0 and a wide death gap should exit")
	}
	if allowReverseExit(cfg, SideLong, CrossGolden, price, opened, now, 99.9, 100, true) {
		t.Fatal("same-direction cross is not a reverse")
	}
	cfg.ReverseMinHoldBars = 3
	if allowReverseExit(cfg, SideLong, CrossDeath, price, opened, opened.Add(10*time.Minute), 99.9, 100, true) {
		t.Fatal("two bars is shorter than a 3-bar hold")
	}
	if !allowReverseExit(cfg, SideLong, CrossDeath, price, opened, opened.Add(15*time.Minute), 99.9, 100, true) {
		t.Fatal("three bars of 5m should clear the hold")
	}
	if allowReverseExit(cfg, SideShort, CrossGolden, price, time.Time{}, opened.Add(time.Hour), 100.2, 100, true) {
		t.Fatal("missing open time cannot prove the hold")
	}
}

func TestClosedBarsSinceCountsCompletedBars(t *testing.T) {
	tf := 5 * time.Minute
	loss := time.Date(2026, 1, 1, 0, 5, 0, 0, time.UTC)
	if closedBarsSince(loss, loss, tf) != 0 {
		t.Fatal("the bar that just closed does not count")
	}
	if closedBarsSince(loss, loss.Add(5*time.Minute), tf) != 1 {
		t.Fatal("one later close")
	}
	// 00:10 和 00:15 已收盘，00:20 还在走，不能算第三根。
	if closedBarsSince(loss, loss.Add(14*time.Minute), tf) != 2 {
		t.Fatal("partial bar")
	}
	if closedBarsSince(loss, loss.Add(15*time.Minute), tf) != 3 {
		t.Fatal("three closes")
	}
}

func TestNetRealizedSubtractsRoundTripTaker(t *testing.T) {
	gross := RealizedPnL(SideLong, 100, 101, 2)
	net := NetRealized(SideLong, 100, 101, 2, 0.0005)
	fees := 0.0005 * 2 * (100 + 101)
	if math.Abs(net-(gross-fees)) > 1e-9 || !(net < gross) {
		t.Fatalf("net %v gross %v", net, gross)
	}
}

func TestReverseHoldLeavesStopToExchange(t *testing.T) {
	cfg := testConfig()
	cfg.ID = 71
	cfg.ReverseMinHoldBars = 15
	cfg.ReverseMinGapPct = 1e-8
	cfg.DailyLossPct = DailyLossOffPct
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	eng.SetUser(7)
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	entry := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, entry, entry[len(entry)-1].Close, 20))
	if err != nil || snap.Side != SideLong || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	death := candlesUntil(t, CrossDeath)
	held, err := eng.Step(stepAt(now.Add(5*time.Minute), death, snap.EntryPrice, 20))
	if err != nil || held.State != StateInPosition || held.Side != SideLong || held.LastAction != "hold" {
		t.Fatalf("should keep the position %+v err=%v", held, err)
	}
	if !held.Running || held.PauseEntries {
		t.Fatalf("hold must not pause %+v", held)
	}
	pos, err := paper.Position(cfg.Symbol)
	if err != nil || !pos.Open {
		t.Fatalf("exchange position %+v err=%v", pos, err)
	}
	released, err := eng.Step(stepAt(now.Add(15*5*time.Minute), death, snap.EntryPrice, 20))
	if err != nil || released.LastReason != "reverse_signal" || released.State != StateArmed || released.Side != "" {
		t.Fatalf("after hold %+v err=%v", released, err)
	}
	if !released.Running || released.PauseEntries {
		t.Fatalf("reverse must keep running %+v", released)
	}
}

func TestReverseGapSkipsWeakCross(t *testing.T) {
	cfg := testConfig()
	cfg.ID = 72
	cfg.ReverseMinHoldBars = 0
	// 合成死叉的快慢线大约张开 1%，2% 的门槛会把它留在交易所止损上。
	cfg.ReverseMinGapPct = 0.02
	cfg.DailyLossPct = DailyLossOffPct
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	entry := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, entry, entry[len(entry)-1].Close, 20))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	death := candlesUntil(t, CrossDeath)
	held, err := eng.Step(stepAt(now.Add(time.Hour), death, snap.EntryPrice, 20))
	if err != nil || held.State != StateInPosition || held.LastAction != "hold" || paper.Entries != 1 {
		t.Fatalf("weak gap %+v entries=%d err=%v", held, paper.Entries, err)
	}
}

func TestLossCooldownSkipsEntriesWithoutPausing(t *testing.T) {
	cfg := testConfig()
	cfg.ID = 73
	cfg.DailyLossPct = DailyLossOffPct
	cfg.CooldownBarsAfterLoss = 3
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 5, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 100)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 100))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	stopped, err := eng.Step(stepAt(now, candles, snap.StopPrice, 100))
	if err != nil || stopped.State != StateArmed || stopped.LastReason != "stop_loss" {
		t.Fatalf("stop %+v err=%v", stopped, err)
	}
	if !stopped.Running || stopped.PauseEntries || stopped.PauseReason != "" {
		t.Fatalf("loss must not pause %+v", stopped)
	}
	next := appendBar(candles, 1.001)
	cool, err := eng.Step(stepAt(now.Add(5*time.Minute), next, next[len(next)-1].Close, 100))
	if err != nil || cool.LastReason != ReasonLossCooldown || cool.State != StateArmed || paper.Entries != 1 {
		t.Fatalf("cooldown %+v entries=%d err=%v", cool, paper.Entries, err)
	}
	if !cool.Running || cool.PauseEntries {
		t.Fatalf("cooldown changed the engine mode %+v", cool)
	}
	still := appendBar(next, 1.001)
	cool, err = eng.Step(stepAt(now.Add(10*time.Minute), still, still[len(still)-1].Close, 100))
	if err != nil || cool.LastReason != ReasonLossCooldown || paper.Entries != 1 {
		t.Fatalf("second bar %+v entries=%d err=%v", cool, paper.Entries, err)
	}
	later := appendBar(still, 1.001)
	done, err := eng.Step(stepAt(now.Add(15*time.Minute), later, later[len(later)-1].Close, 100))
	if err != nil || done.LastReason == ReasonLossCooldown {
		t.Fatalf("cooldown should be over %+v err=%v", done, err)
	}
	if !done.Running || done.PauseEntries {
		t.Fatalf("after cooldown %+v", done)
	}
}

func TestReverseSignalRealizedIsNetOfFees(t *testing.T) {
	ResetForTest()
	t.Cleanup(ResetForTest)
	cfg := testConfig()
	cfg.ID = 74
	cfg.ReverseMinHoldBars = 0
	cfg.ReverseMinGapPct = 1e-8
	cfg.DailyLossPct = DailyLossOffPct
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	eng.SetUser(7)
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	entry := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, entry, entry[len(entry)-1].Close, 20))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	death := candlesUntil(t, CrossDeath)
	exitAt := now.Add(time.Hour)
	closed, err := eng.Step(stepAt(exitAt, death, snap.EntryPrice, 20))
	if err != nil || closed.LastReason != "reverse_signal" {
		t.Fatalf("reverse %+v err=%v", closed, err)
	}
	rows, err := ListEntries(7, cfg.ID, 5)
	if err != nil || len(rows) != 1 || rows[0].ExitReason != "reverse_signal" {
		t.Fatalf("rows %+v err=%v", rows, err)
	}
	gross := RealizedPnL(SideLong, rows[0].EntryPrice, rows[0].ExitPrice, rows[0].ExitQty)
	want := NetRealized(SideLong, rows[0].EntryPrice, rows[0].ExitPrice, rows[0].ExitQty, cfg.takerFee())
	if math.Abs(rows[0].RealizedUSDT-want) > 1e-8 || math.Abs(rows[0].RealizedUSDT-gross) < 1e-8 {
		t.Fatalf("realized %v want net %v gross %v", rows[0].RealizedUSDT, want, gross)
	}
	if !(rows[0].RealizedUSDT < 0) || eng.lossStreak != 1 || !eng.running || eng.cfg.PauseEntries {
		t.Fatalf("loss bookkeeping realized %v streak %d running %v pause %v", rows[0].RealizedUSDT, eng.lossStreak, eng.running, eng.cfg.PauseEntries)
	}
}

func TestBacktestHoldComparison(t *testing.T) {
	// 这段是 9/21 会来回交叉、但价格走不出默认 0.8% 止损 / 1.2% 止盈的碎行情。
	// 反向平仓是唯一出场。建议的持仓根数只在比较里用，不写进策略默认值。
	choppy := holdCompareCandles()
	base := testConfig()
	base.Symbol = "XRPUSDT"
	base.ReverseMinGapPct = DefaultReverseMinGapPct
	type spec struct {
		name string
		hold int
		gap  float64
	}
	runs := []spec{
		{name: "choppy_legacy_hold0_gap0", hold: 0, gap: 1e-12},
		{name: "choppy_hold0", hold: 0, gap: DefaultReverseMinGapPct},
		{name: "choppy_DOGE_hold2", hold: 2, gap: DefaultReverseMinGapPct},
		{name: "choppy_XRP_XAU_hold3", hold: 3, gap: DefaultReverseMinGapPct},
		{name: "choppy_BTC_hold15", hold: 15, gap: DefaultReverseMinGapPct},
		{name: "choppy_hold2_gap0", hold: 2, gap: 1e-12},
		{name: "choppy_hold3_gap0", hold: 3, gap: 1e-12},
		{name: "choppy_hold15_gap0", hold: 15, gap: 1e-12},
	}
	seen := map[string]int{}
	for _, run := range runs {
		cfg := base
		cfg.ReverseMinHoldBars = run.hold
		cfg.ReverseMinGapPct = run.gap
		n, _ := logBacktest(t, run.name, cfg, choppy)
		seen[run.name] = n
	}
	if seen["choppy_legacy_hold0_gap0"] == 0 {
		t.Fatal("choppy series produced no reverse exits")
	}
	if seen["choppy_hold15_gap0"] >= seen["choppy_legacy_hold0_gap0"] {
		t.Fatalf("hold 15 did not reduce reverse exits: legacy %d hold15 %d", seen["choppy_legacy_hold0_gap0"], seen["choppy_hold15_gap0"])
	}
	if seen["choppy_hold0"] != 0 || seen["choppy_BTC_hold15"] != 0 {
		t.Fatalf("default 0.05%% gap should leave this chop to the exchange stop: hold0=%d hold15=%d", seen["choppy_hold0"], seen["choppy_BTC_hold15"])
	}

	// 趋势段里默认止盈先到，反向交叉碰不到，持仓根数不改变成交。
	trend := oscillatingCandles(480, 5*time.Minute)
	trendLegacy := base
	trendLegacy.ReverseMinHoldBars = 0
	trendLegacy.ReverseMinGapPct = 1e-12
	trendHold := base
	trendHold.ReverseMinHoldBars = 15
	legacyRev, legacyTrades := logBacktest(t, "trend_legacy_hold0_gap0", trendLegacy, trend)
	holdRev, holdTrades := logBacktest(t, "trend_BTC_hold15", trendHold, trend)
	if legacyRev != 0 || holdRev != 0 || legacyTrades == 0 || legacyTrades != holdTrades {
		t.Fatalf("trend sample should keep the same take-profit exits: legacy trades=%d rev=%d hold15 trades=%d rev=%d", legacyTrades, legacyRev, holdTrades, holdRev)
	}
}

func logBacktest(t *testing.T, name string, cfg Config, candles []Candle) (reverses, trades int) {
	t.Helper()
	res, err := Backtest(cfg, candles, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, trade := range res.Trades {
		if trade.Reason == "reverse_signal" {
			reverses++
		}
	}
	t.Logf("%s trades=%d wins=%d winRate=%.4f netR=%.4f expectancyR=%.4f reverses=%d",
		name, res.TradeCount, res.Wins, res.WinRate, res.NetR, res.ExpectancyR, reverses)
	return reverses, res.TradeCount
}

// holdCompareCandles 先阴一段，再交替 20 根微涨和 4 根小回撤。
// 快慢线会在十几根内反向交叉，不利波动停在默认止损内侧，所以出场只看反向规则。
func holdCompareCandles() []Candle {
	price := 100.0
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var out []Candle
	push := func(n int, mult float64) {
		for i := 0; i < n; i++ {
			price *= mult
			out = append(out, Candle{
				OpenTime: base.Add(time.Duration(len(out)) * 5 * time.Minute),
				High:     price * 1.0005,
				Low:      price * 0.9995,
				Close:    price,
			})
		}
	}
	push(40, 0.999)
	for k := 0; k < 10; k++ {
		push(20, 1.0004)
		push(4, 0.998)
	}
	return out
}

func oscillatingCandles(n int, tf time.Duration) []Candle {
	price := 100.0
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	out := make([]Candle, 0, n)
	for i := 0; i < n; i++ {
		if i%80 < 40 {
			price *= 0.996
		} else {
			price *= 1.0065
		}
		out = append(out, Candle{
			OpenTime: base.Add(time.Duration(i) * tf),
			High:     price * 1.001,
			Low:      price * 0.999,
			Close:    price,
		})
	}
	return out
}
