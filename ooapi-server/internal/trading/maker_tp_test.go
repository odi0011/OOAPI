package trading

import (
	"bytes"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGTXRejectRetriesThenCloses(t *testing.T) {
	prev := protectionRetryGap
	protectionRetryGap = 0
	t.Cleanup(func() { protectionRetryGap = prev })
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.failTake = true
	server := httptest.NewServer(fake)
	defer server.Close()
	client := NewUSDMClient(server.URL)
	eng := NewEngine(testConfig(), client, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 12, 11, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if !errors.Is(err, ErrNoAutoReopen) {
		t.Fatal(err)
	}
	var reason *ReasonError
	if !errors.As(err, &reason) || reason.Reason != ReasonProtectiveOrdersFailed {
		t.Fatalf("reason %#v err=%v", reason, err)
	}
	if snap.State != StateError || snap.Running || snap.LastReason != ReasonProtectiveOrdersFailed {
		t.Fatalf("%+v", snap)
	}
	if fake.pos != 0 {
		t.Fatalf("position left open: %v", fake.pos)
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 {
		t.Fatalf("stops %d", fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET"))
	}
	gtx := 0
	for _, call := range fake.snapshot() {
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("timeInForce") == "GTX" {
			gtx++
			if call.values.Get("type") != "LIMIT" || call.values.Get("closePosition") != "" {
				t.Fatalf("gtx %#v", call.values)
			}
		}
	}
	if gtx != protectionAttempts {
		t.Fatalf("gtx posts %d", gtx)
	}
	fake.mu.Lock()
	leftAlgos, leftLimits := len(fake.algos), len(fake.limits)
	fake.mu.Unlock()
	if leftAlgos != 0 || leftLimits != 0 {
		t.Fatalf("left with protection algos=%d limits=%d", leftAlgos, leftLimits)
	}
	text := logs.String()
	for _, part := range []string{"code=-5022", "could not be executed as maker"} {
		if !strings.Contains(text, part) {
			t.Fatalf("log missing %q\n%s", part, text)
		}
	}
}

func TestPartialTakeFillKeepsClosePositionStop(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.pos = 10
	fake.entry = 1.5
	server := httptest.NewServer(fake)
	defer server.Close()
	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	if err := client.PlaceProtection(Protection{Symbol: SymbolXRPUSDT, Side: SideLong, Stop: 1.4, Take: 1.6}); err != nil {
		t.Fatal(err)
	}

	fake.mu.Lock()
	if len(fake.limits) != 1 || len(fake.algos) != 1 || !fake.algos[0].closePos {
		t.Fatalf("after place algos=%+v limits=%+v", fake.algos, fake.limits)
	}
	fake.pos = 6.4
	fake.limits[0].executed = "3.6"
	fake.mu.Unlock()
	if err := client.PlaceProtection(Protection{Symbol: SymbolXRPUSDT, Side: SideLong, Stop: 1.4, Take: 1.6}); err != nil {
		t.Fatal(err)
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 || fake.count("POST", "/fapi/v1/order", "LIMIT") != 1 {
		t.Fatalf("partial fill replaced protection stop=%d take=%d", fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET"), fake.count("POST", "/fapi/v1/order", "LIMIT"))
	}
	if fake.count("DELETE", "/fapi/v1/algoOrder", "") != 0 {
		t.Fatal("partial fill canceled the closePosition stop")
	}

	fake.mu.Lock()
	fake.pos = 4
	fake.mu.Unlock()
	if err := client.PlaceProtection(Protection{Symbol: SymbolXRPUSDT, Side: SideLong, Stop: 1.4, Take: 1.6}); err != nil {
		t.Fatal(err)
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 {
		t.Fatal("remaining qty replaced the closePosition stop with a new stop")
	}
	var replaced string
	for _, call := range fake.snapshot() {
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("type") == "LIMIT" {
			replaced = call.values.Get("quantity")
			if call.values.Get("timeInForce") != "GTX" || call.values.Get("closePosition") != "" || call.values.Get("reduceOnly") != "true" {
				t.Fatalf("replacement %#v", call.values)
			}
		}
		if call.method == http.MethodPost && call.path == "/fapi/v1/algoOrder" && call.values.Get("type") == "STOP_MARKET" {
			if call.values.Get("closePosition") != "true" || call.values.Get("quantity") != "" || call.values.Get("reduceOnly") != "" {
				t.Fatalf("stop %#v", call.values)
			}
		}
	}
	if parseNum(replaced) != 4 {
		t.Fatalf("replacement qty %s", replaced)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.algos) != 1 || !fake.algos[0].closePos || fake.algos[0].kind != "STOP_MARKET" {
		t.Fatalf("stop book %+v", fake.algos)
	}
	if len(fake.limits) != 1 || parseNum(fake.limits[0].orig) != 4 {
		t.Fatalf("limits %+v", fake.limits)
	}
}

func TestLeftoverMakerTakeCanceledWhenFlat(t *testing.T) {
	fx := enterHedgeShort(t)
	fx.fake.mu.Lock()
	var shortID int64
	for _, order := range fx.fake.limits {
		if strings.EqualFold(order.posSide, "SHORT") {
			shortID = order.id
		}
	}
	fx.fake.limits = append(fx.fake.limits, fakeLimit{
		id: 77, symbol: SymbolXRPUSDT, side: "SELL", posSide: "LONG",
		price: "1.6000", orig: "10.0", executed: "0",
	})
	fx.fake.algos = append(fx.fake.algos, fakeAlgo{
		id: 99, kind: "STOP_MARKET", posSide: "LONG", side: "SELL", trigger: "1.0", closePos: true,
	})
	fillAt := fx.now.Add(time.Minute)
	fx.fake.riskBody = `[{"symbol":"XRPUSDT","positionAmt":0,"entryPrice":0,"positionSide":"LONG"},{"symbol":"XRPUSDT","positionAmt":0,"entryPrice":1.5,"positionSide":"SHORT"}]`
	fx.fake.income = `[
		{"symbol":"XRPUSDT","incomeType":"REALIZED_PNL","income":"1.25","time":` + ms(fillAt) + `},
		{"symbol":"XRPUSDT","incomeType":"COMMISSION","income":"-0.04","time":` + ms(fillAt) + `},
		{"symbol":"XRPUSDT","incomeType":"FUNDING_FEE","income":"-0.01","time":` + ms(fillAt) + `}
	]`
	fx.fake.trades = `[
		{"symbol":"XRPUSDT","side":"SELL","positionSide":"SHORT","price":"1.5000","qty":"10","realizedPnl":"0","time":` + ms(fx.now) + `},
		{"symbol":"XRPUSDT","side":"BUY","positionSide":"SHORT","price":"1.4800","qty":"10","realizedPnl":"1.25","time":` + ms(fillAt) + `}
	]`
	fx.fake.mu.Unlock()
	if shortID == 0 {
		t.Fatal("short maker take missing")
	}

	before := len(fx.fake.snapshot())
	snap, err := fx.eng.ReconcileFlat(fx.later)
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateArmed || !snap.Running || snap.LastReason != ReasonExchangeFlat {
		t.Fatalf("after flat %+v", snap)
	}
	canceledTake := false
	for _, call := range fx.fake.snapshot()[before:] {
		if call.path == "/fapi/v1/allOpenOrders" {
			t.Fatal("reconcile canceled every open order")
		}
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" {
			t.Fatalf("reconcile sent an order %#v", call.values)
		}
		if call.method == http.MethodDelete && call.path == "/fapi/v1/order" && call.values.Get("orderId") == strconv.FormatInt(shortID, 10) {
			canceledTake = true
		}
	}
	if !canceledTake {
		t.Fatal("short maker take was not canceled")
	}
	fx.fake.mu.Lock()
	defer fx.fake.mu.Unlock()
	if len(fx.fake.limits) != 1 || fx.fake.limits[0].id != 77 || fx.fake.limits[0].posSide != "LONG" {
		t.Fatalf("limits %+v", fx.fake.limits)
	}
	if len(fx.fake.algos) != 1 || fx.fake.algos[0].id != 99 || fx.fake.algos[0].posSide != "LONG" {
		t.Fatalf("algos %+v", fx.fake.algos)
	}
}

func TestOperatorStopCancelsMakerTake(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	server := httptest.NewServer(fake)
	defer server.Close()
	client := NewUSDMClient(server.URL)
	eng := NewEngine(testConfig(), client, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	price := candles[len(candles)-1].Close
	snap, err := eng.Step(stepAt(now, candles, price, 2))
	if err != nil || snap.State != StateInPosition {
		t.Fatalf("entry %+v err=%v", snap, err)
	}
	fake.mu.Lock()
	if len(fake.limits) != 1 {
		t.Fatalf("limits %+v", fake.limits)
	}
	fake.mu.Unlock()
	if err := eng.Stop(stepAt(now.Add(time.Minute), candles, price, 2)); err != nil {
		t.Fatal(err)
	}
	if eng.State() != StateIdle || eng.Snapshot().Running {
		t.Fatalf("after stop %+v", eng.Snapshot())
	}
	if fake.count("DELETE", "/fapi/v1/allOpenOrders", "") < 1 {
		t.Fatal("operator stop did not cancel open orders")
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.limits) != 0 || fake.pos != 0 {
		t.Fatalf("left limits=%d pos=%v", len(fake.limits), fake.pos)
	}
}

func TestOrderKindTreatsGTXLimitAsTake(t *testing.T) {
	if got := orderKind("LIMIT", true, false, "GTX"); got != OrderKindTake {
		t.Fatalf("gtx kind %s", got)
	}
	if got := orderKind("LIMIT", true, false, "GTC"); got != OrderKindExit {
		t.Fatalf("reduce-only limit %s", got)
	}
}
