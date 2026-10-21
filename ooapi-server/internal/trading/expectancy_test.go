package trading

import (
	"errors"
	"math"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFeesAndExpectancyMath(t *testing.T) {
	fees := FeesFromRates(MakerFeeRate, TakerFeeRate)
	if math.Abs(fees.Win-(TakerFeeRate+MakerFeeRate)) > 1e-15 || math.Abs(fees.Loss-2*TakerFeeRate) > 1e-15 {
		t.Fatalf("fees %+v", fees)
	}
	if got := FeesFromRates(-1, -1); got.Win != 0 || got.Loss != 0 {
		t.Fatalf("negative rates %+v", got)
	}

	p, sl, base := 0.53, 0.003, MinScalpTpPct
	if !(TradeExpectancy(p, base, sl, fees) < 0) {
		t.Fatalf("min tp should lose money at 53%%: %v", TradeExpectancy(p, base, sl, fees))
	}
	zero := fees.Win + ((1-p)/p)*(sl+fees.Loss)
	if math.Abs(TradeExpectancy(p, zero, sl, fees)) > 1e-12 {
		t.Fatalf("boundary ev %v", TradeExpectancy(p, zero, sl, fees))
	}
	// 按原胜率放宽能让 EV 为正，但新距离上的胜率更低，期望不再为正，必须跳过。
	fixed := positiveTpDistance(p, sl, fees)
	if !(fixed <= expectancyTpCap(base)+1e-12) || !(TradeExpectancy(p, fixed, sl, fees) > 0) {
		t.Fatalf("constant-p distance %v ev %v", fixed, TradeExpectancy(p, fixed, sl, fees))
	}
	adjusted := WinRateAtDistance(p, base, sl, fixed)
	if !(adjusted < p) || !(TradeExpectancy(adjusted, fixed, sl, fees) <= 0) {
		t.Fatalf("recomputed win rate %v ev %v should reject the constant-p widen", adjusted, TradeExpectancy(adjusted, fixed, sl, fees))
	}
	dist, live, reason := ResolveLiveTakeProfit(p, true, sl, base, fees)
	if reason != ReasonNegativeExpectancy || dist != 0 || !(live <= 0) {
		t.Fatalf("53%% dist %v live %v reason %s", dist, live, reason)
	}
	if got, gotReason := ResolveTakeProfit(p, true, sl, base, fees); gotReason != ReasonNegativeExpectancy || got != 0 {
		t.Fatalf("resolve %v %s", got, gotReason)
	}
	if !(TradeExpectancy(p, expectancyTpCap(base), sl, fees) > 0) {
		t.Fatal("cap should still look positive if the win rate is not recomputed")
	}

	wideP := 0.75
	if !(TradeExpectancy(wideP, base, sl, fees) < 0) {
		t.Fatal("75% at the floor should need a widen")
	}
	fixedWide := positiveTpDistance(wideP, sl, fees)
	fixedAdj := WinRateAtDistance(wideP, base, sl, fixedWide)
	if !(TradeExpectancy(wideP, fixedWide, sl, fees) > 0) || !(TradeExpectancy(fixedAdj, fixedWide, sl, fees) <= 0) {
		t.Fatalf("fixture fixed %v adj %v ev %v", fixedWide, fixedAdj, TradeExpectancy(fixedAdj, fixedWide, sl, fees))
	}
	dist, live, reason = ResolveLiveTakeProfit(wideP, true, sl, base, fees)
	if reason != "" || !(dist > fixedWide) || dist > expectancyTpCap(base)+1e-12 {
		t.Fatalf("widened dist %v reason %s cap %v", dist, reason, expectancyTpCap(base))
	}
	wp := WinRateAtDistance(wideP, base, sl, dist)
	if !(wp < wideP) {
		t.Fatalf("win rate was not recomputed: %v", wp)
	}
	if !(live > 0) || math.Abs(live-TradeExpectancy(wp, dist, sl, fees)) > 1e-12 {
		t.Fatalf("live %v want %v", live, TradeExpectancy(wp, dist, sl, fees))
	}
	if math.Abs(WinRateAtDistance(wideP, base, sl, base)-wideP) > 1e-15 {
		t.Fatal("base distance changed the sample win rate")
	}

	kept, reason := ResolveTakeProfit(0.9, true, sl, base, fees)
	if reason != "" || math.Abs(kept-base) > 1e-15 {
		t.Fatalf("high win rate widened to %v reason %s", kept, reason)
	}
	plain, reason := ResolveTakeProfit(0.5, true, DefaultRFraction, DefaultTakeProfitR*DefaultRFraction, fees)
	if reason != "" || math.Abs(plain-DefaultTakeProfitR*DefaultRFraction) > 1e-15 {
		t.Fatalf("default geometry %v reason %s", plain, reason)
	}
	wide := 0.05
	keptWide, reason := ResolveTakeProfit(0.9, true, sl, wide, fees)
	if reason != "" || math.Abs(keptWide-wide) > 1e-15 {
		t.Fatalf("positive wide tp shrunk to %v reason %s", keptWide, reason)
	}

	_, reason = ResolveTakeProfit(0.1, true, sl, base, fees)
	if reason != ReasonNegativeExpectancy {
		t.Fatalf("low win rate reason %s", reason)
	}
	_, reason = ResolveTakeProfit(0, true, sl, base, fees)
	if reason != ReasonNegativeExpectancy {
		t.Fatalf("zero win rate reason %s", reason)
	}
	floor, reason := ResolveTakeProfit(0.1, false, sl, 0.001, fees)
	if reason != "" || math.Abs(floor-MinScalpTpPct) > 1e-15 {
		t.Fatalf("missing sample dist %v reason %s", floor, reason)
	}
}

func TestExpectancyGateWidensOrSkipsEntry(t *testing.T) {
	now := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	fees := FeesFromRates(MakerFeeRate, TakerFeeRate)

	paper := NewPaper()
	cfg := testConfig()
	cfg.ID = 41
	cfg.GambleMode = true
	cfg.ScalpSlPct = 0.003
	cfg.ScalpTpPct = MinScalpTpPct
	cfg.FeeEdgeMult = 1e-6
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	eng.SetUser(41)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, candles, price, 20)
	in.Backtest = &BacktestSummary{WinRate: 0.75, Trades: 8, NetR: -1}
	snap, err := eng.Step(in)
	if err != nil || snap.State != StateInPosition || paper.Entries != 1 {
		t.Fatalf("widen %+v entries=%d err=%v", snap, paper.Entries, err)
	}
	wantDist, wantLive, reason := ResolveLiveTakeProfit(0.75, true, 0.003, MinScalpTpPct, fees)
	if reason != "" {
		t.Fatal(reason)
	}
	wantTake := price * (1 + wantDist)
	if snap.Side == SideShort {
		wantTake = price * (1 - wantDist)
	}
	if math.Abs(snap.TakeProfitPrice-wantTake) > 1e-8 {
		t.Fatalf("take %v want %v entry %v", snap.TakeProfitPrice, wantTake, snap.EntryPrice)
	}
	if math.Abs(math.Abs(snap.TakeProfitPrice-snap.EntryPrice)/snap.EntryPrice-MinScalpTpPct) < 1e-8 {
		t.Fatal("take stayed at the 0.15% floor")
	}
	if math.Abs(snap.TakeProfitDist-wantDist) > 1e-12 || math.Abs(snap.LiveExpectancy-wantLive) > 1e-12 || !(snap.LiveExpectancy > 0) {
		t.Fatalf("engine state dist %v live %v", snap.TakeProfitDist, snap.LiveExpectancy)
	}
	if snap.Entry == nil || math.Abs(snap.Entry.TakeProfitDist-wantDist) > 1e-12 || math.Abs(snap.Entry.LiveExpectancy-wantLive) > 1e-12 {
		t.Fatalf("entry stamp %+v", snap.Entry)
	}
	if snap.LastBacktest == nil || math.Abs(snap.Entry.ExpectancyR-snap.LastBacktest.ExpectancyR) > 1e-12 || math.Abs(snap.Entry.ExpectancyR-(-1.0/8)) > 1e-12 {
		t.Fatalf("backtest expectancy overwritten %+v backtest %+v", snap.Entry, snap.LastBacktest)
	}
	if snap.Entry.WinRate != 0.75 {
		t.Fatalf("sample win rate overwritten %+v", snap.Entry)
	}
	rows, err := ListEntries(eng.userID, eng.cfg.ID, 5)
	if err != nil || len(rows) != 1 || math.Abs(rows[0].LiveExpectancy-wantLive) > 1e-12 || math.Abs(rows[0].TakeProfitDist-wantDist) > 1e-12 || math.Abs(rows[0].ExpectancyR-snap.Entry.ExpectancyR) > 1e-12 {
		t.Fatalf("saved %+v err=%v", rows, err)
	}

	skipPaper := NewPaper()
	skip := withSecrets(NewEngine(cfg, skipPaper, DiscardLogger()))
	if err := skip.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	bad := in
	bad.Backtest = &BacktestSummary{WinRate: 0.53, Trades: 4, NetR: -1}
	snap, err = skip.Step(bad)
	if err != nil || skipPaper.Entries != 0 || snap.State != StateArmed || snap.LastReason != ReasonNegativeExpectancy || !snap.Running {
		t.Fatalf("skip %+v entries=%d err=%v", snap, skipPaper.Entries, err)
	}
	if !(TradeExpectancy(0.53, expectancyTpCap(MinScalpTpPct), 0.003, fees) > 0) {
		t.Fatal("53% would pass if the win rate stayed constant")
	}
	if snap.TakeProfitDist != 0 || !(snap.LiveExpectancy <= 0) || snap.Entry != nil {
		t.Fatalf("skipped state %+v", snap)
	}
	if snap.LastBacktest == nil || math.Abs(snap.LastBacktest.ExpectancyR-(-0.25)) > 1e-12 {
		t.Fatalf("backtest expectancy %+v", snap.LastBacktest)
	}

	plainPaper := NewPaper()
	plainCfg := testConfig()
	plainCfg.GambleMode = true
	plainCfg.ScalpTpPct = 0.001
	plainCfg.FeeEdgeMult = 1e-6
	plainEng := withSecrets(NewEngine(plainCfg, plainPaper, DiscardLogger()))
	if err := plainEng.Start(calmStart(now.Add(time.Hour), 20)); err != nil {
		t.Fatal(err)
	}
	plainIn := stepAt(now.Add(time.Hour), candles, price, 20)
	snap, err = plainEng.Step(plainIn)
	if err != nil || snap.State != StateInPosition || plainPaper.Entries != 1 {
		t.Fatalf("no sample %+v entries=%d err=%v", snap, plainPaper.Entries, err)
	}
	floorTake := price * (1 + MinScalpTpPct)
	if snap.Side == SideShort {
		floorTake = price * (1 - MinScalpTpPct)
	}
	if math.Abs(snap.TakeProfitPrice-floorTake) > 1e-8 {
		t.Fatalf("floor take %v want %v", snap.TakeProfitPrice, floorTake)
	}
	if math.Abs(snap.TakeProfitDist-MinScalpTpPct) > 1e-12 || snap.LiveExpectancy != 0 {
		t.Fatalf("no-sample state dist %v live %v", snap.TakeProfitDist, snap.LiveExpectancy)
	}
}

func TestStrategyCapAndGateToggle(t *testing.T) {
	now := time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close

	tight := NewPaper()
	cfg := testConfig()
	cfg.GambleMode = true
	cfg.ScalpSlPct = 0.003
	cfg.ScalpTpPct = MinScalpTpPct
	cfg.FeeEdgeMult = 1e-6
	cfg.ExpectancyGate = true
	cfg.ExpectancyTpCapR = 0.01
	eng := withSecrets(NewEngine(cfg, tight, DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, candles, price, 20)
	in.Backtest = &BacktestSummary{WinRate: 0.75, Trades: 8, NetR: -1}
	snap, err := eng.Step(in)
	if err != nil || tight.Entries != 0 || snap.LastReason != ReasonNegativeExpectancy || snap.State != StateArmed {
		t.Fatalf("strategy cap %+v entries=%d err=%v", snap, tight.Entries, err)
	}
	if _, _, reason := ResolveLiveTakeProfit(0.75, true, 0.003, MinScalpTpPct, FeesFromRates(MakerFeeRate, TakerFeeRate)); reason != "" {
		t.Fatalf("default cap should still widen, reason %s", reason)
	}

	open := NewPaper()
	cfg.ExpectancyGate = false
	cfg.ExpectancyTpCapR = float64(ExpectancyTpCapR)
	off := withSecrets(NewEngine(cfg, open, DiscardLogger()))
	if err := off.Start(calmStart(now.Add(time.Hour), 20)); err != nil {
		t.Fatal(err)
	}
	bad := stepAt(now.Add(time.Hour), candles, price, 20)
	bad.Backtest = &BacktestSummary{WinRate: 0.53, Trades: 4, NetR: -1}
	snap, err = off.Step(bad)
	if err != nil || snap.State != StateInPosition || open.Entries != 1 {
		t.Fatalf("gate off %+v entries=%d err=%v", snap, open.Entries, err)
	}
	floor := price * (1 + MinScalpTpPct)
	if snap.Side == SideShort {
		floor = price * (1 - MinScalpTpPct)
	}
	if math.Abs(snap.TakeProfitPrice-floor) > 1e-8 || snap.LiveExpectancy != 0 {
		t.Fatalf("gate off take %v live %v floor %v", snap.TakeProfitPrice, snap.LiveExpectancy, floor)
	}
}

func TestForcedEntryObeysExpectancyGate(t *testing.T) {
	ResetTestnetGreen()
	SetTestnetGreen(true)
	ResetBoostForTest()
	t.Cleanup(func() {
		ResetTestnetGreen()
		ResetBoostForTest()
	})
	now := time.Date(2026, 10, 12, 18, 0, 0, 0, time.UTC)
	GrantBoost(now)
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	paper := NewPaper()
	eng := liveTrendEngine(t, 11, "DOGEUSDT", paper, now)
	eng.cfg.GambleMode = true
	eng.cfg.ScalpTpPct = MinScalpTpPct
	eng.cfg.ScalpSlPct = 0.003
	in := passingStep(now, candles, price, 0.53)
	in.Backtest.Trades = 4
	in.Backtest.NetR = -1
	in.LivePeerIDs = []int64{11}
	snap, err := eng.Step(in)
	if err != nil || paper.Entries != 0 || snap.LastReason != ReasonNegativeExpectancy || snap.State != StateArmed {
		t.Fatalf("early %+v entries=%d err=%v", snap, paper.Entries, err)
	}
	if !(TradeExpectancy(0.53, expectancyTpCap(MinScalpTpPct), 0.003, FeesFromRates(MakerFeeRate, TakerFeeRate)) > 0) {
		t.Fatal("forced fixture would pass a constant win rate")
	}
	in.Now = now.Add(BoostForceAfter)
	snap, err = eng.Step(in)
	if err != nil || paper.Entries != 0 || snap.LastReason != ReasonNegativeExpectancy || snap.State != StateArmed || !snap.Running {
		t.Fatalf("forced %+v entries=%d err=%v", snap, paper.Entries, err)
	}
	if snap.TakeProfitDist != 0 || !(snap.LiveExpectancy <= 0) {
		t.Fatalf("forced state %+v", snap)
	}
	if snap.LastBacktest == nil || math.Abs(snap.LastBacktest.ExpectancyR-(-0.25)) > 1e-12 {
		t.Fatalf("forced backtest %+v", snap.LastBacktest)
	}
}

type ratePaper struct {
	*Paper
	maker float64
	taker float64
	err   error
	calls int
}

func (r *ratePaper) CommissionRates(string) (float64, float64, error) {
	r.calls++
	if r.err != nil {
		return 0, 0, r.err
	}
	return r.maker, r.taker, nil
}

func TestCommissionRatesDriveTakeDistance(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	cfg := testConfig()
	cfg.GambleMode = true
	cfg.ScalpSlPct = 0.003
	cfg.ScalpTpPct = MinScalpTpPct
	cfg.FeeEdgeMult = 1e-6

	down := &ratePaper{Paper: NewPaper(), err: errors.New("commission down")}
	eng := withSecrets(NewEngine(cfg, down, DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, candles, price, 20)
	in.Backtest = &BacktestSummary{WinRate: 0.75, Trades: 3, NetR: -1}
	snap, err := eng.Step(in)
	if err != nil || snap.State != StateInPosition || down.calls != 1 {
		t.Fatalf("fallback %+v calls=%d err=%v", snap, down.calls, err)
	}
	fallback, reason := ResolveTakeProfit(0.75, true, 0.003, MinScalpTpPct, FeesFromRates(MakerFeeRate, TakerFeeRate))
	if reason != "" || math.Abs(math.Abs(snap.TakeProfitPrice-price)/price-fallback) > 1e-8 {
		t.Fatalf("take dist %v want %v", math.Abs(snap.TakeProfitPrice-price)/price, fallback)
	}

	cheap := &ratePaper{Paper: NewPaper(), maker: 0, taker: 0}
	cheapEng := withSecrets(NewEngine(cfg, cheap, DiscardLogger()))
	if err := cheapEng.Start(calmStart(now.Add(time.Hour), 20)); err != nil {
		t.Fatal(err)
	}
	cheapIn := stepAt(now.Add(time.Hour), candles, price, 20)
	cheapIn.Backtest = in.Backtest
	snap, err = cheapEng.Step(cheapIn)
	if err != nil || snap.State != StateInPosition || cheap.calls != 1 {
		t.Fatalf("zero fee %+v calls=%d err=%v", snap, cheap.calls, err)
	}
	zeroFee, reason := ResolveTakeProfit(0.75, true, 0.003, MinScalpTpPct, FeesFromRates(0, 0))
	if reason != "" || math.Abs(zeroFee-fallback) < 1e-8 {
		t.Fatalf("zero-fee distance %v did not differ from fallback %v (%s)", zeroFee, fallback, reason)
	}
	if math.Abs(math.Abs(snap.TakeProfitPrice-price)/price-zeroFee) > 1e-8 {
		t.Fatalf("take dist %v want %v", math.Abs(snap.TakeProfitPrice-price)/price, zeroFee)
	}
}

func TestCommissionRateParseAndCache(t *testing.T) {
	if _, _, err := parseCommissionRates([]byte(`{"makerCommissionRate":"0.0002"}`)); err == nil {
		t.Fatal("missing taker accepted")
	}
	if _, _, err := parseCommissionRates([]byte(`{"makerCommissionRate":"0.2","takerCommissionRate":"0.0005"}`)); err == nil {
		t.Fatal("absurd maker accepted")
	}
	maker, taker, err := parseCommissionRates([]byte(`{"makerCommissionRate":"0.00018","takerCommissionRate":"0.00045"}`))
	if err != nil || math.Abs(maker-0.00018) > 1e-15 || math.Abs(taker-0.00045) > 1e-15 {
		t.Fatalf("parse %v %v err=%v", maker, taker, err)
	}

	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	server := httptest.NewServer(fake)
	defer server.Close()
	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	maker, taker, err = client.CommissionRates(SymbolXRPUSDT)
	if err != nil || math.Abs(maker-0.0002) > 1e-15 || math.Abs(taker-0.0005) > 1e-15 {
		t.Fatalf("live %v %v err=%v", maker, taker, err)
	}
	before := fake.count("GET", "/fapi/v1/commissionRate", "")
	if before != 1 {
		t.Fatalf("reads %d", before)
	}
	if _, _, err := client.CommissionRates("xrpusdt"); err != nil {
		t.Fatal(err)
	}
	if fake.count("GET", "/fapi/v1/commissionRate", "") != before {
		t.Fatal("commission rate was not cached")
	}
}
