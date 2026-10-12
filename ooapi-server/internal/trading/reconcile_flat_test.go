package trading

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPositionSideFlatShortIgnoresTheOtherLeg(t *testing.T) {
	flatBody := []byte(`[
		{"symbol":"DOGEUSDT","positionAmt":0,"entryPrice":0,"positionSide":"LONG"},
		{"symbol":"DOGEUSDT","positionAmt":0,"entryPrice":"0.0851","positionSide":"SHORT"}
	]`)
	rows, err := decodeRiskRows(flatBody)
	if err != nil {
		t.Fatal(err)
	}
	if got := positionFromRisk("DOGEUSDT", SideShort, rows); got.Open {
		t.Fatalf("numeric flat short looked open: %+v", got)
	}
	if got := positionFromRisk("DOGEUSDT", "", rows); got.Open {
		t.Fatalf("both legs flat looked open: %+v", got)
	}

	openHedge := mustRiskRows(t, `[{"symbol":"DOGEUSDT","positionAmt":"399","positionSide":"SHORT"}]`)
	got := positionFromRisk("DOGEUSDT", SideShort, openHedge)
	if !got.Open || got.Side != SideShort || got.Qty != 399 {
		t.Fatalf("positive hedge short %+v", got)
	}
	signed := mustRiskRows(t, `[{"symbol":"DOGEUSDT","positionAmt":-399,"positionSide":"SHORT"}]`)
	got = positionFromRisk("DOGEUSDT", SideShort, signed)
	if !got.Open || got.Side != SideShort || got.Qty != 399 {
		t.Fatalf("signed hedge short %+v", got)
	}

	dust := mustRiskRows(t, `[
		{"symbol":"DOGEUSDT","positionAmt":"1","positionSide":"LONG"},
		{"symbol":"DOGEUSDT","positionAmt":"0","positionSide":"SHORT"}
	]`)
	if got := positionFromRisk("DOGEUSDT", SideShort, dust); got.Open {
		t.Fatalf("long dust hid a flat short: %+v", got)
	}
	if got := positionFromRisk("DOGEUSDT", "", dust); !got.Open || got.Side != SideLong {
		t.Fatalf("unfiltered position %+v", got)
	}

	oneWayShort := mustRiskRows(t, `[{"symbol":"DOGEUSDT","positionAmt":"-399","positionSide":"BOTH"}]`)
	got = positionFromRisk("DOGEUSDT", SideShort, oneWayShort)
	if !got.Open || got.Side != SideShort || got.Qty != 399 {
		t.Fatalf("one-way short %+v", got)
	}
	oneWayLong := mustRiskRows(t, `[{"symbol":"DOGEUSDT","positionAmt":"399","positionSide":"BOTH"}]`)
	if got := positionFromRisk("DOGEUSDT", SideShort, oneWayLong); got.Open {
		t.Fatalf("one-way long counted as the short: %+v", got)
	}
}

func mustRiskRows(t *testing.T, body string) []riskRow {
	t.Helper()
	rows, err := decodeRiskRows([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

type shortFixture struct {
	eng     *Engine
	fake    *binanceFake
	cfg     Config
	now     time.Time
	later   time.Time
	secrets SecretOpener
}

func enterHedgeShort(t *testing.T) shortFixture {
	t.Helper()
	ResetForTest()
	t.Cleanup(ResetForTest)
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.dual = true
	server := httptest.NewServer(fake)
	t.Cleanup(func() {
		time.Sleep(30 * time.Millisecond)
		server.Close()
	})
	client := NewUSDMClient(server.URL)
	cfg := testConfig()
	cfg.ID = 41
	cfg.Timeframe = "15m"
	secrets := func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	}
	eng := NewEngine(cfg, client, DiscardLogger())
	eng.SetUser(7)
	eng.SetSecrets(secrets)
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossDeath)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil || snap.State != StateInPosition || snap.Side != SideShort {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 || fake.count("POST", "/fapi/v1/algoOrder", "TAKE_PROFIT_MARKET") != 1 {
		t.Fatalf("protection %#v", fake.snapshot())
	}
	return shortFixture{eng: eng, fake: fake, cfg: cfg, now: now, later: now.Add(2 * time.Minute), secrets: secrets}
}

// flattenShortTakeProfit 模拟止盈条件单已在币安成交：空单归零，止盈单消失，止损单还挂着。
// 引擎自己没有收到这笔成交。
func flattenShortTakeProfit(t *testing.T, fake *binanceFake, now time.Time) int64 {
	t.Helper()
	fillAt := now.Add(time.Minute)
	fake.mu.Lock()
	var slID int64
	kept := fake.algos[:0]
	for _, order := range fake.algos {
		if order.kind == "TAKE_PROFIT_MARKET" && strings.EqualFold(order.posSide, "SHORT") {
			continue
		}
		if order.kind == "STOP_MARKET" && strings.EqualFold(order.posSide, "SHORT") {
			slID = order.id
		}
		kept = append(kept, order)
	}
	fake.algos = append(kept, fakeAlgo{
		id: 99, kind: "STOP_MARKET", posSide: "LONG", side: "SELL", trigger: "1.0", closePos: true,
	})
	fake.riskBody = `[{"symbol":"XRPUSDT","positionAmt":0,"entryPrice":0,"positionSide":"LONG"},{"symbol":"XRPUSDT","positionAmt":0,"entryPrice":1.5,"positionSide":"SHORT"}]`
	fake.income = `[
		{"symbol":"XRPUSDT","incomeType":"REALIZED_PNL","income":"1.25","time":` + ms(fillAt) + `},
		{"symbol":"XRPUSDT","incomeType":"COMMISSION","income":"-0.04","time":` + ms(fillAt) + `},
		{"symbol":"XRPUSDT","incomeType":"FUNDING_FEE","income":"-0.01","time":` + ms(fillAt) + `},
		{"symbol":"XRPUSDT","incomeType":"TRANSFER","income":"9","time":` + ms(fillAt) + `},
		{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-3","time":` + ms(fillAt) + `}
	]`
	fake.trades = `[
		{"symbol":"XRPUSDT","side":"SELL","positionSide":"SHORT","price":"1.5000","qty":"10","realizedPnl":"0","time":` + ms(now) + `},
		{"symbol":"XRPUSDT","side":"BUY","positionSide":"SHORT","price":"1.4800","qty":"10","realizedPnl":"1.25","time":` + ms(fillAt) + `}
	]`
	fake.mu.Unlock()
	if slID == 0 {
		t.Fatal("short stop algo missing")
	}
	return slID
}

func TestReconcileFlatWhenTakeProfitFills(t *testing.T) {
	fx := enterHedgeShort(t)

	held, err := fx.eng.ReconcileFlat(fx.now.Add(30 * time.Second))
	if err != nil || held.State != StateInPosition || held.Side != SideShort {
		t.Fatalf("open reconcile %+v err=%v", held, err)
	}
	if fx.fake.count("DELETE", "/fapi/v1/algoOrder", "") != 0 {
		t.Fatal("reconcile canceled protection while the short was still open")
	}

	slID := flattenShortTakeProfit(t, fx.fake, fx.now)
	before := len(fx.fake.snapshot())
	snap, err := fx.eng.ReconcileFlat(fx.later)
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateArmed || !snap.Running || snap.LastReason != ReasonExchangeFlat {
		t.Fatalf("after flat %+v", snap)
	}
	if !almostEqual(snap.DayRealized, 1.20) || !almostEqual(snap.CumulativeRealized, 1.20) {
		t.Fatalf("pnl day %v cumulative %v", snap.DayRealized, snap.CumulativeRealized)
	}
	for _, call := range fx.fake.snapshot()[before:] {
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" {
			t.Fatalf("reconcile sent an order %#v", call.values)
		}
		if call.path == "/fapi/v1/allOpenOrders" {
			t.Fatal("reconcile canceled every open order")
		}
	}
	fx.fake.mu.Lock()
	var left []fakeAlgo
	left = append(left, fx.fake.algos...)
	fx.fake.mu.Unlock()
	if len(left) != 1 || left[0].id != 99 || left[0].posSide != "LONG" {
		t.Fatalf("orphan legs %+v", left)
	}
	canceled := false
	for _, call := range fx.fake.snapshot()[before:] {
		if call.method == http.MethodDelete && call.path == "/fapi/v1/algoOrder" && call.values.Get("algoId") == formatAlgoID(slID) {
			canceled = true
		}
	}
	if !canceled {
		t.Fatalf("short stop %d not canceled in %#v", slID, fx.fake.snapshot()[before:])
	}
	rows, err := ListEntries(7, fx.cfg.ID, 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("entries %+v err=%v", rows, err)
	}
	row := rows[0]
	if row.ExitReason != ReasonExchangeFlat || !almostEqual(row.ExitPrice, 1.48) || !almostEqual(row.ExitQty, 10) || !almostEqual(row.RealizedUSDT, 1.20) || row.ClosedAt.IsZero() {
		t.Fatalf("exit record %+v", row)
	}
	found := false
	for _, ev := range RecentEvents() {
		if ev.Action != "armed" || ev.Side != string(SideShort) || !strings.Contains(ev.Msg, ReasonExchangeFlat) {
			continue
		}
		for _, part := range []string{"positionSide=SHORT", "exit=1.4800", "realized_pnl=1.2500", "commission=-0.0400", "funding_fee=-0.0100", "net=1.2000", "canceled=" + formatAlgoID(slID)} {
			if !strings.Contains(ev.Msg, part) {
				t.Fatalf("event missing %s in %s", part, ev.Msg)
			}
		}
		if !almostEqual(ev.DayRealized, 1.20) || !almostEqual(ev.CumulativeRealized, 1.20) {
			t.Fatalf("event pnl %+v", ev)
		}
		found = true
	}
	if !found {
		t.Fatalf("events %+v", RecentEvents())
	}
}

func TestRunnerReconcilesFlatBeforeCandleClose(t *testing.T) {
	fx := enterHedgeShort(t)
	slID := flattenShortTakeProfit(t, fx.fake, fx.now)

	h := NewHub()
	h.PutForTest(7, fx.cfg.ID, fx.eng)
	r := NewRunner(h)
	r.SetClock(func() time.Time { return fx.later })
	r.SetFlatEvery(20 * time.Millisecond)
	var mu sync.Mutex
	steps := 0
	r.SetMarket(func(Config, SecretOpener, time.Time) (Market, error) {
		return Market{Mark: 1.5, Wallet: 20, Available: 20, WalletKnown: true, Equity: 20, EquityKnown: true}, nil
	})
	r.SetStep(func(RunSpec, StepInput) (Snapshot, error) {
		mu.Lock()
		steps++
		mu.Unlock()
		return Snapshot{State: StateInPosition}, nil
	})
	r.Start()
	t.Cleanup(func() { r.Remove(fx.cfg.ID) })
	started := time.Now()
	r.Ensure(RunSpec{UserID: 7, Config: fx.cfg, Secrets: fx.secrets})

	deadline := time.Now().Add(2 * time.Second)
	var snap Snapshot
	var ok bool
	for time.Now().Before(deadline) {
		snap, ok = h.State(7, fx.cfg.ID)
		if ok && snap.State == StateArmed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ok || snap.State != StateArmed {
		t.Fatalf("runner left the engine %+v", snap)
	}
	if time.Since(started) >= time.Second {
		t.Fatalf("reconcile waited %s, which is the candle timer", time.Since(started))
	}
	mu.Lock()
	gotSteps := steps
	mu.Unlock()
	if gotSteps != 1 {
		t.Fatalf("candle steps %d", gotSteps)
	}
	fx.fake.mu.Lock()
	left := append([]fakeAlgo(nil), fx.fake.algos...)
	fx.fake.mu.Unlock()
	if len(left) != 1 || left[0].id != 99 {
		t.Fatalf("legs %+v", left)
	}
	canceled := false
	for _, call := range fx.fake.snapshot() {
		if call.method == http.MethodDelete && call.path == "/fapi/v1/algoOrder" && call.values.Get("algoId") == formatAlgoID(slID) {
			canceled = true
		}
	}
	if !canceled {
		t.Fatal("runner did not cancel the leftover stop")
	}
	rows, err := ListEntries(7, fx.cfg.ID, 10)
	if err != nil || len(rows) != 1 || !almostEqual(rows[0].RealizedUSDT, 1.20) || rows[0].ExitReason != ReasonExchangeFlat {
		t.Fatalf("entries %+v err=%v", rows, err)
	}
}

func formatAlgoID(id int64) string {
	return strconv.FormatInt(id, 10)
}
