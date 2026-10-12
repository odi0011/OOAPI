package trading

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// TestShanghaiIncomeAndPerOrderRowsMatchBinance 用一份币安 income / userTrades 夹具
// 证明：上海 0 点到现在的当日盈亏、自策略创建起的累计盈亏，以及按 orderId 拆开的行，
// 都和账单、成交的合计一致。标记价不会写进成交价。同一张单的多笔成交只占一行。
func TestShanghaiIncomeAndPerOrderRowsMatchBinance(t *testing.T) {
	loc := time.FixedZone("Asia/Shanghai", 8*60*60)
	created := time.Date(2026, 10, 10, 1, 0, 0, 0, loc)
	midnight := time.Date(2026, 10, 12, 0, 0, 0, 0, loc)
	now := time.Date(2026, 10, 12, 0, 30, 0, 0, loc)
	before := midnight.Add(-time.Millisecond)
	entry1 := created.Add(time.Hour)
	fill2 := entry1.Add(time.Second)
	funding1 := before.Add(-2 * time.Hour)
	exit1 := before
	entry2 := midnight
	funding2 := midnight.Add(10 * time.Minute)
	exit2 := midnight.Add(20 * time.Minute)
	tooEarly := created.Add(-time.Hour)

	tradesJSON := `[
		{"symbol":"DOGEUSDT","id":1,"orderId":100,"side":"BUY","positionSide":"BOTH","price":"1.5","qty":"4","commission":"0.0625","commissionAsset":"USDT","realizedPnl":"0","markPrice":"99","time":` + ms(entry1) + `},
		{"symbol":"DOGEUSDT","id":2,"orderId":100,"side":"BUY","positionSide":"BOTH","price":"1.25","qty":"4","commission":"0.0625","commissionAsset":"USDT","realizedPnl":"0","markPrice":"99","time":` + ms(fill2) + `},
		{"symbol":"DOGEUSDT","id":3,"orderId":200,"side":"SELL","positionSide":"BOTH","price":"1","qty":"8","commission":"0.25","commissionAsset":"USDT","realizedPnl":"-1.5","markPrice":"99","time":` + ms(exit1) + `},
		{"symbol":"DOGEUSDT","id":4,"orderId":300,"side":"BUY","positionSide":"BOTH","price":"2","qty":"2","commission":"0.125","commissionAsset":"USDT","realizedPnl":"0","markPrice":"99","time":` + ms(entry2) + `},
		{"symbol":"DOGEUSDT","id":5,"orderId":400,"side":"SELL","positionSide":"BOTH","price":"2.5","qty":"2","commission":"0.125","commissionAsset":"USDT","realizedPnl":"0.5","markPrice":"99","time":` + ms(exit2) + `}
	]`
	incomeJSON := `[
		{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-4","time":` + ms(tooEarly) + `},
		{"symbol":"DOGEUSDT","incomeType":"COMMISSION","income":"-0.0625","time":` + ms(entry1) + `},
		{"symbol":"DOGEUSDT","incomeType":"COMMISSION","income":"-0.0625","time":` + ms(fill2) + `},
		{"symbol":"DOGEUSDT","incomeType":"FUNDING_FEE","income":"-0.125","time":` + ms(funding1) + `},
		{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"-1.5","time":` + ms(exit1) + `},
		{"symbol":"DOGEUSDT","incomeType":"COMMISSION","income":"-0.25","time":` + ms(exit1) + `},
		{"symbol":"DOGEUSDT","incomeType":"COMMISSION","income":"-0.125","time":` + ms(entry2) + `},
		{"symbol":"DOGEUSDT","incomeType":"FUNDING_FEE","income":"-0.0625","time":` + ms(funding2) + `},
		{"symbol":"DOGEUSDT","incomeType":"REALIZED_PNL","income":"0.5","time":` + ms(exit2) + `},
		{"symbol":"DOGEUSDT","incomeType":"COMMISSION","income":"-0.125","time":` + ms(exit2) + `},
		{"symbol":"DOGEUSDT","incomeType":"TRANSFER","income":"8","time":` + ms(now) + `},
		{"symbol":"BTCUSDT","incomeType":"REALIZED_PNL","income":"-9","time":` + ms(now) + `}
	]`

	var sawSymbol, sawStart string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/fapi/v1/income":
			sawSymbol = r.URL.Query().Get("symbol")
			sawStart = r.URL.Query().Get("startTime")
			_, _ = io.WriteString(w, incomeJSON)
		case "/fapi/v1/userTrades":
			_, _ = io.WriteString(w, tradesJSON)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: "key", APISecret: "secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	day, cumulative, err := client.RealizedIncome("DOGEUSDT", created, now)
	if err != nil {
		t.Fatal(err)
	}
	if sawSymbol != "DOGEUSDT" || sawStart != strconv.FormatInt(created.UTC().UnixMilli(), 10) {
		t.Fatalf("income query symbol=%s start=%s", sawSymbol, sawStart)
	}
	events, err := parseIncome([]byte(incomeJSON))
	if err != nil {
		t.Fatal(err)
	}
	incomeEvents := make([]IncomeEvent, len(events))
	for i, row := range events {
		incomeEvents[i] = IncomeEvent{Symbol: row.Symbol, IncomeType: row.IncomeType, Income: row.Income, Time: row.Time}
	}
	wantDay, wantCum := SumSymbolIncome(incomeEvents, "DOGEUSDT", created, now)
	if !almostEqual(day, wantDay) || !almostEqual(cumulative, wantCum) {
		t.Fatalf("client day %v cum %v sum day %v cum %v", day, cumulative, wantDay, wantCum)
	}
	if !almostEqual(day, 0.1875) || !almostEqual(cumulative, -1.8125) {
		t.Fatalf("shanghai totals day %v cumulative %v", day, cumulative)
	}
	dayStart := ShanghaiDayStart(now)
	if !exit1.Before(dayStart) || entry2.Before(dayStart) {
		t.Fatalf("shanghai boundary dayStart=%s exit1=%s entry2=%s", dayStart, exit1, entry2)
	}
	atMidnight, _ := SumSymbolIncome(incomeEvents, "DOGEUSDT", created, midnight)
	if !almostEqual(atMidnight, -0.125) {
		t.Fatalf("income at Shanghai midnight belongs to the new day, got %v", atMidnight)
	}

	trades, err := parseOrderTrades([]byte(tradesJSON))
	if err != nil {
		t.Fatal(err)
	}
	fetched, err := client.UserTrades("DOGEUSDT", created, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(fetched) != len(trades) {
		t.Fatalf("fetched %d parsed %d", len(fetched), len(trades))
	}
	rows := BuildOrderRows(trades, incomeEvents, 99)
	if len(rows) != 4 {
		t.Fatalf("orders merged or split: %+v", rows)
	}
	want := []OrderRow{
		{OrderID: "100", Role: "entry", Side: "long", Price: 1.375, Qty: 8, Commission: 0.125, FundingFee: -0.125, RealizedPnL: 0},
		{OrderID: "200", Role: "exit", Side: "long", Price: 1, Qty: 8, Commission: 0.25, FundingFee: 0, RealizedPnL: -1.5},
		{OrderID: "300", Role: "entry", Side: "long", Price: 2, Qty: 2, Commission: 0.125, FundingFee: -0.0625, RealizedPnL: 0},
		{OrderID: "400", Role: "exit", Side: "long", Price: 2.5, Qty: 2, Commission: 0.125, FundingFee: 0, RealizedPnL: 0.5},
	}
	var tradeCommission, rowCommission, rowFunding, rowRealized float64
	for _, trade := range trades {
		tradeCommission += trade.Commission
		if trade.Price == 99 {
			t.Fatal("mark price became a fill")
		}
	}
	var incomeFunding, incomeRealized float64
	for _, event := range incomeEvents {
		if event.Symbol != "DOGEUSDT" || event.Time.Before(created) || event.Time.After(now) {
			continue
		}
		switch event.IncomeType {
		case "FUNDING_FEE":
			incomeFunding += event.Income
		case "REALIZED_PNL":
			incomeRealized += event.Income
		}
	}
	for i, row := range rows {
		if row.Price == 99 {
			t.Fatalf("row used mark price %+v", row)
		}
		got := want[i]
		if row.OrderID != got.OrderID || row.Role != got.Role || row.Side != got.Side ||
			!almostEqual(row.Price, got.Price) || !almostEqual(row.Qty, got.Qty) ||
			!almostEqual(row.Commission, got.Commission) || !almostEqual(row.FundingFee, got.FundingFee) ||
			!almostEqual(row.RealizedPnL, got.RealizedPnL) {
			t.Fatalf("row %d %+v want %+v", i, row, got)
		}
		rowCommission += row.Commission
		rowFunding += row.FundingFee
		rowRealized += row.RealizedPnL
	}
	if !almostEqual(rowCommission, tradeCommission) || !almostEqual(tradeCommission, 0.625) {
		t.Fatalf("commission rows %v trades %v", rowCommission, tradeCommission)
	}
	if !almostEqual(rowFunding, incomeFunding) || !almostEqual(incomeFunding, -0.1875) {
		t.Fatalf("funding rows %v income %v", rowFunding, incomeFunding)
	}
	if !almostEqual(rowRealized, incomeRealized) || !almostEqual(incomeRealized, -1) {
		t.Fatalf("realized rows %v income %v", rowRealized, incomeRealized)
	}
	if !almostEqual(rowRealized+incomeCommission(incomeEvents, created, now)+rowFunding, cumulative) {
		t.Fatalf("order pieces %v do not add up to cumulative %v", rowRealized+incomeCommission(incomeEvents, created, now)+rowFunding, cumulative)
	}
}

func incomeCommission(rows []IncomeEvent, since, now time.Time) float64 {
	var sum float64
	for _, row := range rows {
		if row.IncomeType != "COMMISSION" || row.Symbol != "DOGEUSDT" {
			continue
		}
		if row.Time.Before(since) || row.Time.After(now) {
			continue
		}
		sum += row.Income
	}
	return sum
}
