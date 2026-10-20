package trading

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFillFromOrderUsesAvgAndExecutedQty(t *testing.T) {
	fill := fillFromOrder(binanceOrder{
		OrderID: 7, Status: "FILLED", AvgPrice: "0.08404", ExecutedQty: "400",
	}, SideShort, 0.08417, 1)
	if !fill.FromExchange || !almostEqual(fill.Price, 0.08404) || !almostEqual(fill.Qty, 400) {
		t.Fatalf("avg fill %+v", fill)
	}
	quote := fillFromOrder(binanceOrder{
		OrderID: 7, Status: "FILLED", AvgPrice: "0", ExecutedQty: "400", CumQuote: "33.616",
	}, SideShort, 0.08417, 1)
	if !quote.FromExchange || !almostEqual(quote.Price, 0.08404) || !almostEqual(quote.Qty, 400) {
		t.Fatalf("quote fill %+v", quote)
	}
	mark := fillFromOrder(binanceOrder{
		OrderID: 7, Status: "FILLED", AvgPrice: "0", ExecutedQty: "400", CumQuote: "0",
	}, SideShort, 0.08417, 1)
	if mark.FromExchange {
		t.Fatalf("mark was treated as a fill %+v", mark)
	}
}

func TestPlaceEntryUsesUserTradesWhenAvgPriceMissing(t *testing.T) {
	fake := newBinanceFake(t, "1", "1", "0.00001", "5")
	fake.blankAvg = true
	fillAt := time.Date(2026, 10, 12, 5, 15, 1, 0, time.UTC)
	fake.trades = `[{"symbol":"XRPUSDT","orderId":42,"side":"BUY","positionSide":"LONG","price":"0.08404","qty":"400","time":` + ms(fillAt) + `}]`
	server := httptest.NewServer(fake)
	defer server.Close()
	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	prevGap := fillLookupGap
	fillLookupGap = 0
	t.Cleanup(func() { fillLookupGap = prevGap })

	fill, err := client.PlaceEntry(EntryOrder{
		Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 400, Price: 0.08417,
		Leverage: 3, MarginMode: MarginIsolated,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !fill.FromExchange || !almostEqual(fill.Price, 0.08404) || !almostEqual(fill.Qty, 400) || !fill.At.Equal(fillAt) {
		t.Fatalf("fill %+v", fill)
	}
	if almostEqual(fill.Price, 0.08417) {
		t.Fatal("entry price stayed on the mark")
	}
	saw := false
	for _, call := range fake.snapshot() {
		if call.path == "/fapi/v1/userTrades" && call.values.Get("orderId") == "42" && call.values.Get("symbol") == SymbolXRPUSDT {
			saw = true
		}
	}
	if !saw {
		t.Fatalf("userTrades by orderId missing in %#v", fake.snapshot())
	}
}

func zeroFillLookup(t *testing.T) {
	t.Helper()
	prev := fillLookupGap
	fillLookupGap = 0
	t.Cleanup(func() { fillLookupGap = prev })
}

func testUSDM(t *testing.T, fake *binanceFake) *USDMClient {
	t.Helper()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	return client
}

// RESULT 先回到 FILLED 且均价为 0。旧逻辑看到 FILLED 就不再查单，这里必须重查到均价出现。
func TestPlaceEntryRequeriesFilledOrderUntilAvgAppears(t *testing.T) {
	zeroFillLookup(t)
	fake := newBinanceFake(t, "1", "1", "0.00001", "5")
	fake.postFilledBlank = true
	fake.avgAfter = 3
	client := testUSDM(t, fake)

	fill, err := client.PlaceEntry(EntryOrder{
		Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 400, Price: 0.08417,
		Leverage: 3, MarginMode: MarginIsolated,
		ClientOrderID: "oo-ent-requeryavg0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !fill.FromExchange || !almostEqual(fill.Price, 1.5) || !almostEqual(fill.Qty, 400) {
		t.Fatalf("fill %+v", fill)
	}
	if almostEqual(fill.Price, 0.08417) {
		t.Fatal("entry price stayed on the mark")
	}
	if fake.orderGets < 3 {
		t.Fatalf("order gets %d, want at least 3", fake.orderGets)
	}
	for _, call := range fake.snapshot() {
		if call.method == http.MethodDelete {
			t.Fatalf("recovered fill was canceled %#v", call)
		}
	}
}

// userTrades 前几次是空的，之后才出现。不能在第一次空结果上进 Error。
func TestPlaceEntryWaitsForDelayedUserTrades(t *testing.T) {
	zeroFillLookup(t)
	fake := newBinanceFake(t, "1", "1", "0.00001", "5")
	fake.postFilledBlank = true
	fake.blankAvg = true
	fake.tradesAfter = 3
	fillAt := time.Date(2026, 10, 21, 0, 0, 1, 0, time.UTC)
	fake.trades = `[{"symbol":"XRPUSDT","orderId":42,"side":"BUY","positionSide":"BOTH","price":"0.08404","qty":"400","time":` + ms(fillAt) + `}]`
	client := testUSDM(t, fake)

	fill, err := client.PlaceEntry(EntryOrder{
		Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 400, Price: 0.08417,
		Leverage: 3, MarginMode: MarginIsolated,
		ClientOrderID: "oo-ent-delayedtrade01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !fill.FromExchange || !almostEqual(fill.Price, 0.08404) || !almostEqual(fill.Qty, 400) || !fill.At.Equal(fillAt) {
		t.Fatalf("fill %+v", fill)
	}
	if fake.tradeHits < 4 {
		t.Fatalf("userTrades hits %d, want at least 4", fake.tradeHits)
	}
	if fake.orderGets < 1 {
		t.Fatal("filled blank response was not re-queried")
	}
}

// 订单和 userTrades 一直没有均价，但这笔 oo-ent 已经开出仓。用持仓均价，不用标记价。
func TestPlaceEntryUsesPositionEntryWhenAvgAndTradesMissing(t *testing.T) {
	zeroFillLookup(t)
	fake := newBinanceFake(t, "1", "1", "0.00001", "5")
	fake.postFilledBlank = true
	fake.blankAvg = true
	fake.echoOwnOrder = true
	fake.entryPx = 0.0912
	client := testUSDM(t, fake)

	fill, err := client.PlaceEntry(EntryOrder{
		Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 400, Price: 0.08417,
		Leverage: 3, MarginMode: MarginIsolated,
		ClientOrderID: "oo-ent-positionfill01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !fill.FromExchange || !almostEqual(fill.Price, 0.0912) || !almostEqual(fill.Qty, 400) || fill.OrderID != "42" {
		t.Fatalf("fill %+v", fill)
	}
	if almostEqual(fill.Price, 0.08417) {
		t.Fatal("entry price stayed on the mark")
	}
	for _, call := range fake.snapshot() {
		if call.method == http.MethodDelete {
			t.Fatalf("own fill was canceled %#v", call)
		}
	}
}

// 同数量的手动仓不能被当成这次开仓，也不能被平掉。
func TestPlaceEntryDoesNotAdoptManualPositionWhenAvgMissing(t *testing.T) {
	zeroFillLookup(t)
	fake := newBinanceFake(t, "1", "1", "0.00001", "5")
	fake.postFilledBlank = true
	fake.blankAvg = true
	fake.freezePos = true
	fake.pos = 400
	fake.entry = 9.99
	fake.allOrdersBody = `[{"clientOrderId":"web_usdt_manualxrp01","side":"BUY","positionSide":"BOTH","status":"FILLED","type":"MARKET","executedQty":"400","reduceOnly":false,"time":30,"updateTime":30}]`
	client := testUSDM(t, fake)

	fill, err := client.PlaceEntry(EntryOrder{
		Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 400, Price: 0.08417,
		Leverage: 3, MarginMode: MarginIsolated,
		ClientOrderID: "oo-ent-notmanual0001",
	})
	if !errors.Is(err, ErrEntryUnfilled) {
		t.Fatalf("fill %+v err=%v", fill, err)
	}
	if fill.Price != 0 || fill.FromExchange {
		t.Fatalf("manual entry was synthesized %+v", fill)
	}
	if fake.pos != 400 || fake.entry != 9.99 {
		t.Fatalf("manual position changed pos=%v entry=%v", fake.pos, fake.entry)
	}
	for _, call := range fake.snapshot() {
		if call.method == http.MethodPost && call.values.Get("reduceOnly") == "true" {
			t.Fatal("manual position was flattened")
		}
		if call.method == http.MethodDelete && call.path == "/fapi/v1/allOpenOrders" {
			t.Fatal("canceled every open order on the symbol")
		}
	}
}

func TestMissingAvgRecoversPositionWithoutEngineError(t *testing.T) {
	zeroFillLookup(t)
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.postFilledBlank = true
	fake.blankAvg = true
	fake.echoOwnOrder = true
	fake.entryPx = 1.2345
	server := httptest.NewServer(fake)
	defer server.Close()
	eng := NewEngine(testConfig(), NewUSDMClient(server.URL), DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || !snap.Running || snap.LastError != "" {
		t.Fatalf("%+v", snap)
	}
	if !almostEqual(snap.EntryPrice, 1.2345) {
		t.Fatalf("entry %v want position 1.2345 mark %v", snap.EntryPrice, candles[len(candles)-1].Close)
	}
	for _, st := range eng.Trace() {
		if st == StateError {
			t.Fatalf("trace %v", eng.Trace())
		}
	}
	if fake.count(http.MethodPost, "/fapi/v1/algoOrder", "STOP_MARKET") != 1 {
		t.Fatal("recovered entry did not hang protection")
	}
}

func TestMissingAvgFlatReturnsToArmed(t *testing.T) {
	zeroFillLookup(t)
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.postFilledBlank = true
	fake.keepFlat = true
	server := httptest.NewServer(fake)
	defer server.Close()
	eng := NewEngine(testConfig(), NewUSDMClient(server.URL), DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 21, 0, 5, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateArmed || !snap.Running || snap.LastReason != ReasonEntryUnfilled || snap.LastError != "" {
		t.Fatalf("%+v", snap)
	}
	if fake.pos != 0 {
		t.Fatalf("position opened pos=%v", fake.pos)
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
	if !sawSubmitted {
		t.Fatalf("trace %v", eng.Trace())
	}
	logged := false
	for _, line := range eng.Audit() {
		if strings.Contains(line, "entry rejected, nothing filled, back to armed") && strings.Contains(line, "成交没有返回均价") {
			logged = true
		}
	}
	if !logged {
		t.Fatalf("audit %v", eng.Audit())
	}
	if fake.count(http.MethodPost, "/fapi/v1/algoOrder", "STOP_MARKET") != 0 || fake.count(http.MethodPost, "/fapi/v1/order", "LIMIT") != 0 {
		t.Fatal("unfilled entry hung protection")
	}
	if fake.count(http.MethodDelete, "/fapi/v1/allOpenOrders", "") != 0 {
		t.Fatal("unfilled entry canceled every open order")
	}
}

func TestMissingAvgDoesNotFlattenManualPosition(t *testing.T) {
	zeroFillLookup(t)
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.postFilledBlank = true
	fake.blankAvg = true
	fake.freezePos = true
	fake.pos = 10
	fake.entry = 9.99
	fake.allOrdersBody = `[{"clientOrderId":"web_usdt_manualxrp01","side":"BUY","positionSide":"BOTH","status":"FILLED","type":"MARKET","executedQty":"10","reduceOnly":false,"time":30,"updateTime":30}]`
	server := httptest.NewServer(fake)
	defer server.Close()
	eng := NewEngine(testConfig(), NewUSDMClient(server.URL), DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 21, 0, 10, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateArmed || !snap.Running || snap.LastReason != ReasonEntryUnfilled {
		t.Fatalf("%+v", snap)
	}
	for _, st := range eng.Trace() {
		if st == StateError || st == StateInPosition {
			t.Fatalf("trace %v", eng.Trace())
		}
	}
	if fake.pos != 10 || fake.entry != 9.99 {
		t.Fatalf("manual position changed pos=%v entry=%v", fake.pos, fake.entry)
	}
	for _, call := range fake.snapshot() {
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("reduceOnly") == "true" {
			t.Fatal("manual position was flattened")
		}
		if call.method == http.MethodDelete && call.path == "/fapi/v1/allOpenOrders" {
			t.Fatal("manual orders were canceled")
		}
	}
	if fake.count(http.MethodPost, "/fapi/v1/algoOrder", "STOP_MARKET") != 0 {
		t.Fatal("manual position received engine protection")
	}
}
