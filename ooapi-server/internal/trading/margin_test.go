package trading

import (
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMarginForBalanceClampsToAvailable(t *testing.T) {
	t.Setenv(EnvMaxMarginPerTradeUSDT, "")
	cfg := testConfig()
	cfg.MaxMarginUsdt = 1.7
	cfg.Leverage = 20
	if got := plannedMargin(cfg); math.Abs(got-1.7) > 1e-12 {
		t.Fatalf("unknown wallet planned %v", got)
	}
	if got := marginForBalance(cfg, 1.70, false, TakerFeeRate); math.Abs(got-1.7) > 1e-12 {
		t.Fatalf("unknown flag still clamped %v", got)
	}
	want := (1.70*MarginAvailableFraction - MarginBalanceBufferUSDT) / (1 + TakerFeeRate*20)
	got := marginForBalance(cfg, 1.70, true, TakerFeeRate)
	if math.Abs(got-want) > 1e-12 || !(got < 1.7) {
		t.Fatalf("room %v want %v", got, want)
	}
	cfg.MaxMarginPerTradeUsdt = 1
	if got := plannedMargin(cfg); math.Abs(got-1) > 1e-12 {
		t.Fatalf("per-trade cap %v", got)
	}
	if got := marginForBalance(cfg, 2.06, true, TakerFeeRate); math.Abs(got-1) > 1e-12 {
		t.Fatalf("room above the per-trade cap %v", got)
	}
	cfg.MaxMarginPerTradeUsdt = 0
	if got := marginForBalance(cfg, 1.70, true, TakerFeeRate); math.Abs(got-want) > 1e-12 {
		t.Fatalf("zero per-trade cap %v", got)
	}
	if got := balanceMarginRoom(0.01, 20, TakerFeeRate); got != 0 {
		t.Fatalf("buffer ate the balance: %v", got)
	}
}

func TestEntryQtyFloorsToStepWhenBalanceShrinks(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	server := httptest.NewServer(fake)
	defer server.Close()
	cfg := testConfig()
	cfg.Leverage = 20
	cfg.MaxMarginUsdt = 1.7
	eng := NewEngine(cfg, NewUSDMClient(server.URL), DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 12, 13, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 1.70)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	in := stepAt(now, candles, price, 1.70)
	in.Wallet = 1.70
	in.Available = 1.70
	in.WalletKnown = true
	snap, err := eng.Step(in)
	if err != nil || snap.State != StateInPosition || !snap.Running {
		t.Fatalf("%+v err=%v", snap, err)
	}
	budget := marginForBalance(cfg, 1.70, true, TakerFeeRate)
	_, _, raw, err := SizePosition(budget, cfg.Leverage, price, 5)
	if err != nil {
		t.Fatal(err)
	}
	want := AlignQuantity(raw, 0.1, 0.1)
	_, _, fullRaw, err := SizePosition(cfg.MaxMarginUsdt, cfg.Leverage, price, 5)
	if err != nil {
		t.Fatal(err)
	}
	full := AlignQuantity(fullRaw, 0.1, 0.1)
	if !(want > 0) || !(want < full) || want*price+1e-9 < 5 {
		t.Fatalf("want %v full %v price %v", want, full, price)
	}
	var posted float64
	for _, call := range fake.snapshot() {
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("type") == "MARKET" && call.values.Get("reduceOnly") == "" {
			posted = parseNum(call.values.Get("quantity"))
		}
	}
	if math.Abs(posted-want) > 1e-8 || math.Abs(snap.Qty-want) > 1e-8 {
		t.Fatalf("posted %v snap %v want %v full %v", posted, snap.Qty, want, full)
	}
}

func TestShrunkNotionalSkipsInsteadOfErroring(t *testing.T) {
	cfg := testConfig()
	cfg.Leverage = 3
	cfg.MaxMarginUsdt = 1.7
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 14, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 1.70)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	in := stepAt(now, candles, candles[len(candles)-1].Close, 1.70)
	in.Wallet = 1.70
	in.Available = 1.70
	in.WalletKnown = true
	snap, err := eng.Step(in)
	if err != nil || paper.Entries != 0 || snap.State != StateArmed || !snap.Running || snap.LastReason != ReasonInsufficientMargin {
		t.Fatalf("%+v entries=%d err=%v", snap, paper.Entries, err)
	}
	for _, st := range eng.Trace() {
		if st == StateError || st == StateEntrySubmitted {
			t.Fatalf("trace %v", eng.Trace())
		}
	}
}

func TestMarginRejectReturnsToArmed(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.rejectEntry = true
	server := httptest.NewServer(fake)
	defer server.Close()
	eng := NewEngine(testConfig(), NewUSDMClient(server.URL), DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 12, 15, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateArmed || !snap.Running || snap.LastReason != ReasonInsufficientMargin {
		t.Fatalf("%+v", snap)
	}
	if fake.pos != 0 || fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 0 || fake.count("POST", "/fapi/v1/order", "LIMIT") != 0 {
		t.Fatalf("filled or protected pos=%v calls=%#v", fake.pos, fake.snapshot())
	}
	sawSubmitted := false
	for _, st := range eng.Trace() {
		if st == StateError {
			t.Fatalf("trace %v", eng.Trace())
		}
		if st == StateEntrySubmitted {
			sawSubmitted = true
		}
	}
	if !sawSubmitted || eng.State() != StateArmed {
		t.Fatalf("trace %v state %s", eng.Trace(), eng.State())
	}
	logged := false
	for _, line := range eng.Audit() {
		if strings.Contains(line, "entry rejected, nothing filled, back to armed") && strings.Contains(line, "code=-2019") && strings.Contains(line, "Margin is insufficient.") {
			logged = true
		}
	}
	if !logged {
		t.Fatalf("audit %v", eng.Audit())
	}
}
