package trading

import (
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// 实盘 DOGE 引擎：组合上限 1.7，单笔 1，权益约 2.06，交易所空仓。
// 手动平掉的 DOGE 空单仍留在 positionRisk 里（持仓量为 0），XRP 策略没在跑。
func TestFlatDogeBookDoesNotTripPortfolioLimit(t *testing.T) {
	positions, err := parseAccountPositions([]byte(`[
		{"symbol":"DOGEUSDT","positionAmt":"0","entryPrice":"0.18","leverage":"20","notional":"0","isolatedMargin":"1.7","positionInitialMargin":"1.7","positionSide":"SHORT"},
		{"symbol":"XRPUSDT","positionAmt":"0","entryPrice":"0.50","leverage":"3","isolatedMargin":"0","positionSide":"BOTH"}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(positions) != 0 {
		t.Fatalf("closed rows counted %+v", positions)
	}

	h := NewHub()
	const keyID = int64(2)
	h.SetAccount(keyID, 2.06, 2.06)
	h.SetPositions(keyID, positions)

	staleCfg := testConfig()
	staleCfg.ID = 9
	staleCfg.Symbol = "DOGEUSDT"
	staleCfg.ExchangeKeyID = keyID
	staleCfg.Mode = ModeLive
	staleCfg.Leverage = 20
	staleCfg.MaxMarginUsdt = 1.7
	stale := withSecrets(NewEngine(staleCfg, NewPaper(), DiscardLogger()))
	stale.SeedPositionForTest(SideShort, 1000, 0.2, 0.22, 0.16)
	h.PutForTest(1, staleCfg.ID, stale)

	idle := testConfig()
	idle.ID = 1
	idle.Symbol = "XRPUSDT"
	idle.ExchangeKeyID = keyID
	idle.MaxMarginUsdt = 1.7
	idle.MaxMarginPerTradeUsdt = 1
	h.PutForTest(1, idle.ID, NewEngine(idle, NewPaper(), DiscardLogger()))

	doge := idle
	doge.ID = 2
	doge.Symbol = "DOGEUSDT"
	doge.Mode = ModeLive
	doge.Leverage = 20
	doge.MaxMarginUsdt = 1.7
	doge.MaxMarginPerTradeUsdt = 1
	if got := plannedMargin(doge); math.Abs(got-1) > 1e-9 {
		t.Fatalf("planned margin %v", got)
	}
	if got := h.EntrySkip(doge); got != "" {
		t.Fatalf("flat book skipped with %s", got)
	}
}

func TestPortfolioLimitUsesInitialMarginNotNotional(t *testing.T) {
	positions, err := parseAccountPositions([]byte(`[
		{"symbol":"DOGEUSDT","positionAmt":"-20","entryPrice":"1","leverage":"20","notional":"-20","isolatedMargin":"20","positionSide":"SHORT"}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(positions) != 1 || positions[0].Side != SideShort || math.Abs(positions[0].InitialMargin()-1) > 1e-9 {
		t.Fatalf("margin %+v", positions)
	}

	h := NewHub()
	const keyID = int64(2)
	h.SetAccount(keyID, 2.06, 2.06)
	h.SetPositions(keyID, positions)
	cfg := testConfig()
	cfg.ID = 2
	cfg.Symbol = "DOGEUSDT"
	cfg.ExchangeKeyID = keyID
	cfg.Mode = ModeLive
	cfg.Leverage = 20
	cfg.MaxMarginUsdt = 1.7
	cfg.MaxMarginPerTradeUsdt = 0.5
	if got := h.EntrySkip(cfg); got != "" {
		t.Fatalf("1 + 0.5 inside 1.7: %s", got)
	}
	cfg.MaxMarginPerTradeUsdt = 1
	if got := h.EntrySkip(cfg); got != ReasonPortfolioLimit {
		t.Fatalf("1 + 1 over 1.7: %s", got)
	}
}

func TestStepSkipsWhenLiveMarginExceedsPortfolioCap(t *testing.T) {
	h := NewHub()
	cfg := testConfig()
	cfg.Symbol = "DOGEUSDT"
	cfg.ExchangeKeyID = 2
	cfg.MaxMarginUsdt = 1.7
	cfg.MaxMarginPerTradeUsdt = 1
	cfg.Leverage = 20
	cfg.DailyLossPct = DailyLossOffPct
	cfg.MinWinRate = 0
	now := time.Date(2026, 10, 12, 4, 30, 0, 0, time.UTC)
	secrets := func() (Credentials, error) {
		return Credentials{APIKey: "test-api-key-0123", APISecret: "test-api-secret-0123", Network: ModeTestnet}, nil
	}
	if _, err := h.Start(1, 2, cfg, calmStart(now, 2.06), secrets); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	in := stepAt(now, candles, candles[len(candles)-1].Close, 2.06)
	in.Wallet = 2.06
	in.Available = 2.06
	in.WalletKnown = true
	in.PositionsKnown = true
	in.Positions = []KeyPosition{{Symbol: "DOGEUSDT", Qty: 20, Entry: 1, Leverage: 20}}
	snap, err := h.Step(1, 2, cfg, in, secrets)
	if err != nil {
		t.Fatal(err)
	}
	if snap.LastReason != ReasonPortfolioLimit || snap.State != StateArmed {
		t.Fatalf("%+v", snap)
	}
}

func TestAccountPositionsReadsTheWholeKey(t *testing.T) {
	var symbol string
	saw := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fapi/v2/positionRisk" {
			http.NotFound(w, r)
			return
		}
		saw = true
		symbol = r.URL.Query().Get("symbol")
		_, _ = io.WriteString(w, `[
			{"symbol":"DOGEUSDT","positionAmt":"0","entryPrice":"0.18","leverage":"20","isolatedMargin":"1.7","positionSide":"SHORT"},
			{"symbol":"XRPUSDT","positionAmt":"6","entryPrice":"0.5","leverage":"3","notional":"3","isolatedMargin":"3","positionSide":"LONG"}
		]`)
	}))
	defer server.Close()

	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: "key", APISecret: "secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	positions, err := client.AccountPositions()
	if err != nil {
		t.Fatal(err)
	}
	if !saw || symbol != "" || len(positions) != 1 || positions[0].Symbol != "XRPUSDT" {
		t.Fatalf("saw=%v symbol=%q positions=%+v", saw, symbol, positions)
	}
	if math.Abs(positions[0].InitialMargin()-1) > 1e-9 {
		t.Fatalf("xrp margin %v", positions[0].InitialMargin())
	}
}
