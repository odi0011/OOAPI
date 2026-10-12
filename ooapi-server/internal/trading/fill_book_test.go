package trading

import (
	"net/http/httptest"
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
