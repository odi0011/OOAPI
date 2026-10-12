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

func TestIncomeParserIgnoresBlank(t *testing.T) {
	rows, err := parseIncome([]byte(`[]`))
	if err != nil || len(rows) != 0 {
		t.Fatalf("%+v %v", rows, err)
	}
	if _, err := parseIncome([]byte(`{"no":"array"}`)); err == nil || !strings.Contains(err.Error(), "无法解析") {
		t.Fatal(err)
	}
}
