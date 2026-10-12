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
	dist, reason := ResolveTakeProfit(p, true, sl, base, fees)
	if reason != "" || !(dist > base) || dist > expectancyTpCap(base)+1e-12 {
		t.Fatalf("dist %v reason %s", dist, reason)
	}
	if !(TradeExpectancy(p, dist, sl, fees) > 0) {
		t.Fatalf("widened ev %v dist %v", TradeExpectancy(p, dist, sl, fees), dist)
	}
	if !(dist > zero) {
		t.Fatalf("slack missing: dist %v zero %v", dist, zero)
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
	cfg.GambleMode = true
	cfg.ScalpSlPct = 0.003
	cfg.ScalpTpPct = MinScalpTpPct
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, candles, price, 20)
	in.Backtest = &BacktestSummary{WinRate: 0.53, Trades: 8, NetR: -1}
	snap, err := eng.Step(in)
	if err != nil || snap.State != StateInPosition || paper.Entries != 1 {
		t.Fatalf("widen %+v entries=%d err=%v", snap, paper.Entries, err)
	}
	wantDist, reason := ResolveTakeProfit(0.53, true, 0.003, MinScalpTpPct, fees)
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

	skipPaper := NewPaper()
	skip := withSecrets(NewEngine(cfg, skipPaper, DiscardLogger()))
	if err := skip.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	bad := in
	bad.Backtest = &BacktestSummary{WinRate: 0.1, Trades: 4, NetR: -1}
	snap, err = skip.Step(bad)
	if err != nil || skipPaper.Entries != 0 || snap.State != StateArmed || snap.LastReason != ReasonNegativeExpectancy || !snap.Running {
		t.Fatalf("skip %+v entries=%d err=%v", snap, skipPaper.Entries, err)
	}

	plainPaper := NewPaper()
	plainCfg := testConfig()
	plainCfg.GambleMode = true
	plainCfg.ScalpTpPct = 0.001
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
	in := passingStep(now, candles, price, 0.1)
	in.Backtest.Trades = 4
	in.Backtest.NetR = -1
	in.LivePeerIDs = []int64{11}
	snap, err := eng.Step(in)
	if err != nil || paper.Entries != 0 || snap.LastReason != ReasonNegativeExpectancy || snap.State != StateArmed {
		t.Fatalf("early %+v entries=%d err=%v", snap, paper.Entries, err)
	}
	in.Now = now.Add(BoostForceAfter)
	snap, err = eng.Step(in)
	if err != nil || paper.Entries != 0 || snap.LastReason != ReasonNegativeExpectancy || snap.State != StateArmed || !snap.Running {
		t.Fatalf("forced %+v entries=%d err=%v", snap, paper.Entries, err)
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

	down := &ratePaper{Paper: NewPaper(), err: errors.New("commission down")}
	eng := withSecrets(NewEngine(cfg, down, DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, candles, price, 20)
	in.Backtest = &BacktestSummary{WinRate: 0.53, Trades: 3, NetR: -1}
	snap, err := eng.Step(in)
	if err != nil || snap.State != StateInPosition || down.calls != 1 {
		t.Fatalf("fallback %+v calls=%d err=%v", snap, down.calls, err)
	}
	fallback, reason := ResolveTakeProfit(0.53, true, 0.003, MinScalpTpPct, FeesFromRates(MakerFeeRate, TakerFeeRate))
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
	zeroFee, reason := ResolveTakeProfit(0.53, true, 0.003, MinScalpTpPct, FeesFromRates(0, 0))
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
