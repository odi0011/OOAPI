package trading

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRealizedIncomeNetsFeesSinceStart(t *testing.T) {
	now := time.Date(2026, 10, 12, 3, 0, 0, 0, time.UTC)
	since := now.Add(-48 * time.Hour)
	var symbol string
	var startMs int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fapi/v1/income" {
			http.NotFound(w, r)
			return
		}
		symbol = r.URL.Query().Get("symbol")
		startMs, _ = strconv.ParseInt(r.URL.Query().Get("startTime"), 10, 64)
		_, _ = io.WriteString(w, `[
			{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-4","time":`+ms(since.Add(-time.Hour))+`},
			{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-0.10","time":`+ms(now.Add(-30*time.Hour))+`},
			{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-0.25","time":`+ms(now.Add(-time.Hour))+`},
			{"symbol":"DOGEUSDT","incomeType":"COMMISSION","income":"-0.02","time":`+ms(now.Add(-time.Hour))+`},
			{"symbol":"DOGEUSDT","incomeType":"FUNDING_FEE","income":"-0.01","time":`+ms(now.Add(-time.Hour))+`},
			{"symbol":"DOGEUSDT","incomeType":"TRANSFER","income":"5","time":`+ms(now.Add(-time.Hour))+`},
			{"symbol":"BTCUSDT","incomeType":"REALIZED_PNL","income":"-9","time":`+ms(now.Add(-time.Hour))+`}
		]`)
	}))
	defer server.Close()
	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: "key", APISecret: "secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	day, cumulative, err := client.RealizedIncome("DOGEUSDT", since, now)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "DOGEUSDT" || startMs != since.UnixMilli() {
		t.Fatalf("symbol %s start %d", symbol, startMs)
	}
	if !almostEqual(day, -0.28) || !almostEqual(cumulative, -0.38) {
		t.Fatalf("day %v cumulative %v", day, cumulative)
	}
}

func TestAlgoFillIncomeReachesStateAndEvents(t *testing.T) {
	ResetBoostForTest()
	t.Cleanup(ResetBoostForTest)
	now := time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	booked := now.Add(-time.Hour)
	fake.income = `[
		{"symbol":"XRPUSDT","incomeType":"REALIZED_PNL","income":"-0.25","time":` + ms(booked) + `},
		{"symbol":"XRPUSDT","incomeType":"COMMISSION","income":"-0.02","time":` + ms(booked) + `},
		{"symbol":"XRPUSDT","incomeType":"FUNDING_FEE","income":"-0.01","time":` + ms(booked) + `},
		{"symbol":"XRPUSDT","incomeType":"TRANSFER","income":"8","time":` + ms(booked) + `},
		{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-3","time":` + ms(booked) + `}
	]`
	server := httptest.NewServer(fake)
	defer server.Close()
	client := NewUSDMClient(server.URL)
	eng := NewEngine(testConfig(), client, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	if err := eng.Start(calmStart(now.Add(-2*time.Hour), 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	if !almostEqual(snap.DayRealized, -0.28) || !almostEqual(snap.CumulativeRealized, -0.28) {
		t.Fatalf("pnl day %v cumulative %v", snap.DayRealized, snap.CumulativeRealized)
	}
	found := false
	for _, ev := range RecentEvents() {
		if ev.Symbol == SymbolXRPUSDT && almostEqual(ev.CumulativeRealized, -0.28) && almostEqual(ev.DayRealized, -0.28) {
			found = true
		}
	}
	if !found {
		t.Fatalf("events %+v", RecentEvents())
	}
}

func ms(t time.Time) string {
	return strconv.FormatInt(t.UTC().UnixMilli(), 10)
}

func almostEqual(got, want float64) bool {
	if got < want {
		return want-got < 1e-9
	}
	return got-want < 1e-9
}

func TestRealizedIncomeUsesShanghaiDayAndStrategyStart(t *testing.T) {
	created := time.Date(2026, 10, 10, 1, 0, 0, 0, time.UTC)
	now := time.Date(2026, 10, 12, 16, 30, 0, 0, time.UTC) // 2026-10-13 00:30 Asia/Shanghai
	yesterday := time.Date(2026, 10, 12, 15, 0, 0, 0, time.UTC)
	midnight := time.Date(2026, 10, 12, 16, 0, 0, 0, time.UTC)
	today := time.Date(2026, 10, 12, 16, 10, 0, 0, time.UTC)
	hits := 0
	var symbol string
	var startMs int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fapi/v1/income" {
			http.NotFound(w, r)
			return
		}
		hits++
		symbol = r.URL.Query().Get("symbol")
		startMs, _ = strconv.ParseInt(r.URL.Query().Get("startTime"), 10, 64)
		_, _ = io.WriteString(w, `[
			{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-9","time":`+ms(created.Add(-time.Hour))+`},
			{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-1.50","time":`+ms(yesterday)+`},
			{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"0.10","time":`+ms(midnight)+`},
			{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-0.25","time":`+ms(today)+`},
			{"symbol":"DOGEUSDT","incomeType":"COMMISSION","income":"-0.02","time":`+ms(today)+`},
			{"symbol":"DOGEUSDT","incomeType":"FUNDING_FEE","income":"-0.01","time":`+ms(today)+`},
			{"symbol":"DOGEUSDT","incomeType":"TRANSFER","income":"5","time":`+ms(today)+`},
			{"symbol":"BTCUSDT","incomeType":"REALIZED_PNL","income":"-4","time":`+ms(today)+`}
		]`)
	}))
	defer server.Close()
	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: "key", APISecret: "secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig()
	cfg.Symbol = "DOGEUSDT"
	cfg.CreatedAt = created
	eng := NewEngine(cfg, client, DiscardLogger())
	eng.ledger.Realized = 999
	eng.ledger.Cumulative = 999
	eng.captureIncome(now)
	snap := eng.Snapshot()
	if symbol != "DOGEUSDT" || startMs != created.UnixMilli() {
		t.Fatalf("symbol %s start %d", symbol, startMs)
	}
	// 上海 0 点是 16:00 UTC。15:00 UTC 的 -1.50 只进累计。
	if !almostEqual(snap.DayRealized, -0.18) || !almostEqual(snap.CumulativeRealized, -1.68) {
		t.Fatalf("day %v cumulative %v", snap.DayRealized, snap.CumulativeRealized)
	}
	if hits != 1 {
		t.Fatalf("hits %d", hits)
	}
	eng.ledger.Realized = 999
	eng.captureIncome(now.Add(20 * time.Second))
	if hits != 1 || !almostEqual(eng.Snapshot().DayRealized, -0.18) {
		t.Fatalf("cache hits %d day %v", hits, eng.Snapshot().DayRealized)
	}
	eng.captureIncome(now.Add(IncomeRefresh + time.Second))
	if hits != 2 {
		t.Fatalf("refresh hits %d", hits)
	}

	fresh := NewEngine(cfg, client, DiscardLogger())
	fresh.captureIncome(now.Add(2 * time.Minute))
	if !almostEqual(fresh.Snapshot().DayRealized, -0.18) || !almostEqual(fresh.Snapshot().CumulativeRealized, -1.68) {
		t.Fatalf("restart day %v cumulative %v", fresh.Snapshot().DayRealized, fresh.Snapshot().CumulativeRealized)
	}
}

func TestIncomeParserIgnoresBlank(t *testing.T) {
	rows, err := parseIncome([]byte(`[]`))
	if err != nil || len(rows) != 0 {
		t.Fatalf("%+v %v", rows, err)
	}
	if _, err := parseIncome([]byte(`{"no":"array"}`)); err == nil || !strings.Contains(err.Error(), "无法解析") {
		t.Fatal(err)
	}
}
