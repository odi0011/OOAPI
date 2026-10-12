package trading

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseAccountEquityAddsUnrealized(t *testing.T) {
	eq, err := parseAccountEquity([]byte(`{
		"totalWalletBalance":"2.00",
		"totalUnrealizedProfit":"-1.60",
		"availableBalance":"0.40"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	near(t, eq.Wallet, 2)
	near(t, eq.Unrealized, -1.6)
	near(t, eq.Equity, 0.4)
	near(t, eq.Available, 0.4)
	sum, err := parseUnrealizedSum([]byte(`[
		{"symbol":"DOGEUSDT","positionAmt":"-399","unRealizedProfit":"-1.60"},
		{"symbol":"XRPUSDT","positionAmt":"0","unRealizedProfit":"9"}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	near(t, sum, -1.6)
}

func TestReadEquityUsesAccountThenPositionRisk(t *testing.T) {
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fapi/v2/account" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, `{"totalWalletBalance":"0.40","totalUnrealizedProfit":"2.00","availableBalance":"0.10"}`)
	}))
	defer account.Close()
	client := NewUSDMClient(account.URL)
	if err := client.UseCredentials(Credentials{APIKey: "key", APISecret: "secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	eq, err := client.ReadEquity()
	if err != nil {
		t.Fatal(err)
	}
	near(t, eq.Equity, 2.4)
	near(t, eq.Wallet, 0.4)

	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/fapi/v2/account":
			http.NotFound(w, r)
		case "/fapi/v2/balance":
			_, _ = io.WriteString(w, `[{"asset":"USDT","balance":"2.00","availableBalance":"1.00"}]`)
		case "/fapi/v2/positionRisk":
			_, _ = io.WriteString(w, `[{"symbol":"DOGEUSDT","positionAmt":"-10","unRealizedProfit":"-1.60"}]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer fallback.Close()
	client = NewUSDMClient(fallback.URL)
	if err := client.UseCredentials(Credentials{APIKey: "key", APISecret: "secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	eq, err = client.ReadEquity()
	if err != nil {
		t.Fatalf("fallback %+v err=%v", eq, err)
	}
	near(t, eq.Wallet, 2)
	near(t, eq.Unrealized, -1.6)
	near(t, eq.Equity, 0.4)
	near(t, eq.Available, 1)
}

func TestEquityHaltUsesUnrealizedNotWallet(t *testing.T) {
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	cfg := testConfig()
	healthy := NewHub()
	eng := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	healthy.PutForTest(1, 8, eng)
	snap, err := healthy.Step(1, 8, cfg, StepInput{
		FundingRate: 0.0001, LiqDistancePct: -1,
		WalletKnown: true, Wallet: 0.4, Available: 0.2,
		EquityKnown: true, AccountEquity: 2.4,
	}, eng.secrets)
	if err != nil {
		t.Fatal(err)
	}
	if snap.LastReason == ReasonBalanceFloor || !snap.Running || snap.State != StateArmed {
		t.Fatalf("wallet below the floor but equity above should keep running: %+v", snap)
	}

	floor := NewHub()
	var stopped []int64
	floor.SetRunHook(func(id int64, running bool) {
		if !running {
			stopped = append(stopped, id)
		}
	})
	heldCfg := cfg
	heldCfg.ID = 8
	held := withSecrets(NewEngine(heldCfg, NewPaper(), DiscardLogger()))
	if err := held.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	held.SeedPositionForTest(SideShort, 399, 0.0851, 0.086, 0.084)
	floor.PutForTest(1, 8, held)
	other := cfg
	other.ID = 9
	otherEng := withSecrets(NewEngine(other, NewPaper(), DiscardLogger()))
	if err := otherEng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	floor.PutForTest(1, 9, otherEng)
	snap, err = floor.Step(1, 8, heldCfg, StepInput{
		Now: now, MarkPrice: 0.0851,
		WalletKnown: true, Wallet: 2, Available: 2,
		EquityKnown: true, AccountEquity: 0.4,
	}, held.secrets)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Running || snap.State != StateInPosition {
		t.Fatalf("open position should stay, running should stop: %+v", snap)
	}
	if otherEng.running || otherEng.State() != StateIdle {
		t.Fatalf("peer running=%v state=%s", otherEng.running, otherEng.State())
	}
	if len(stopped) != 2 {
		t.Fatalf("stopped %v", stopped)
	}
}

func TestUnknownEquityDoesNotOpen(t *testing.T) {
	h := NewHub()
	r := NewRunner(h)
	var got StepInput
	var steps int
	r.SetMarket(func(Config, SecretOpener, time.Time) (Market, error) {
		return Market{Wallet: 10, Available: 10, WalletKnown: true}, nil
	})
	r.SetStep(func(_ RunSpec, in StepInput) (Snapshot, error) {
		steps++
		got = in
		return Snapshot{State: StateArmed, Running: true}, nil
	})
	cfg := testConfig()
	cfg.ID = 4
	now := time.Date(2026, 10, 12, 1, 0, 0, 0, time.UTC)
	eng := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	if err := eng.Start(calmStart(now, 10)); err != nil {
		t.Fatal(err)
	}
	h.PutForTest(1, cfg.ID, eng)
	r.runOnce(context.Background(), RunSpec{UserID: 1, Config: cfg})
	if steps != 1 || got.EquityKnown || got.SkipReason != ReasonEquityUnknown {
		t.Fatalf("steps=%d equityKnown=%v skip=%s", steps, got.EquityKnown, got.SkipReason)
	}

	fresh := NewRunner(NewHub())
	var started int
	fresh.SetMarket(func(Config, SecretOpener, time.Time) (Market, error) {
		return Market{Wallet: 10, Available: 10, WalletKnown: true}, nil
	})
	fresh.SetStep(func(RunSpec, StepInput) (Snapshot, error) {
		started++
		return Snapshot{}, nil
	})
	fresh.runOnce(context.Background(), RunSpec{UserID: 1, Config: cfg})
	if started != 0 {
		t.Fatalf("unknown equity started a new engine: %d", started)
	}
}

func TestHubEngineKeepsARealLogger(t *testing.T) {
	h := NewHub()
	cfg := testConfig()
	now := time.Date(2026, 10, 12, 2, 0, 0, 0, time.UTC)
	if _, err := h.Start(1, cfg.ID, cfg, calmStart(now, 2), func() (Credentials, error) {
		return Credentials{APIKey: "test-api-key-0123", APISecret: "test-api-secret-0123", Network: ModeTestnet}, nil
	}); err != nil {
		t.Fatal(err)
	}
	eng := h.engines[sessionKey(1, cfg.ID)]
	if eng == nil {
		t.Fatal("missing engine")
	}
	if _, ok := eng.log.(stdLog); !ok {
		t.Fatalf("logger %T", eng.log)
	}
}
