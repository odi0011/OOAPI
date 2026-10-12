package trading

import (
	"errors"
	"net/http/httptest"
	"testing"
	"time"
)

type stubBook struct {
	open      bool
	posErr    error
	fills     []UserFill
	tradeErr  error
	parts     IncomeParts
	incomeErr error
}

func (s *stubBook) PositionSide(string, Side) (Position, error) {
	if s.posErr != nil {
		return Position{}, s.posErr
	}
	if s.open {
		return Position{Open: true, Side: SideShort, Qty: 400, Entry: 0.08404}, nil
	}
	return Position{}, nil
}

func (s *stubBook) Trades(string, time.Time, time.Time) ([]UserFill, error) {
	if s.tradeErr != nil {
		return nil, s.tradeErr
	}
	return s.fills, nil
}

func (s *stubBook) IncomeParts(string, time.Time, time.Time) (IncomeParts, error) {
	if s.incomeErr != nil {
		return IncomeParts{}, s.incomeErr
	}
	return s.parts, nil
}

func dogeFills(opened, closed time.Time) []UserFill {
	return []UserFill{
		{Symbol: "DOGEUSDT", Side: "SELL", PositionSide: "SHORT", Price: 0.08404, Qty: 400, Time: opened},
		{Symbol: "DOGEUSDT", Side: "BUY", PositionSide: "SHORT", Price: 0.08380, Qty: 250, Time: closed.Add(-time.Second)},
		{Symbol: "DOGEUSDT", Side: "BUY", PositionSide: "SHORT", Price: 0.08370, Qty: 150, Time: closed},
		{Symbol: "BTCUSDT", Side: "BUY", PositionSide: "SHORT", Price: 1, Qty: 1, Time: closed},
	}
}

func dogeIncome() IncomeParts {
	return IncomeParts{RealizedPnL: 0.112, Commission: -0.016, FundingFee: -0.004, Rows: 3, HasRealized: true}
}

func TestCloseFlatEntryUsesTradesAndIncome(t *testing.T) {
	ResetForTest()
	t.Cleanup(ResetForTest)
	opened := time.Date(2026, 10, 12, 5, 15, 0, 0, time.UTC)
	closed := time.Date(2026, 10, 12, 5, 41, 0, 0, time.UTC)
	id, err := SaveEntry(EntryRecord{
		UserID: 7, StrategyID: 2, Symbol: "DOGEUSDT", Side: "short",
		EntryPrice: 0.08417, Qty: 399, OpenedAt: opened,
	})
	if err != nil || id == 0 {
		t.Fatal(err)
	}
	kept, err := SaveEntry(EntryRecord{
		UserID: 7, StrategyID: 2, Symbol: "DOGEUSDT", Side: "long",
		EntryPrice: 0.08, Qty: 10, OpenedAt: opened,
	})
	if err != nil || kept == 0 {
		t.Fatal(err)
	}
	book := &stubBook{fills: dogeFills(opened, closed), parts: dogeIncome(), open: true}
	if n, err := CloseFlatEntries(book, mustOpen(t, 7, 2), closed.Add(time.Minute)); err != nil || n != 0 {
		t.Fatalf("open position closed n=%d err=%v", n, err)
	}
	openRows := mustOpen(t, 7, 2)
	if len(openRows) != 2 {
		t.Fatalf("open rows %+v", openRows)
	}
	for _, row := range openRows {
		if row.ID == id && (!almostEqual(row.EntryPrice, 0.08404) || !almostEqual(row.Qty, 400) || !row.ClosedAt.IsZero()) {
			t.Fatalf("open short not revised %+v", row)
		}
		if row.ID == kept && (!almostEqual(row.EntryPrice, 0.08) || !almostEqual(row.Qty, 10) || !row.ClosedAt.IsZero()) {
			t.Fatalf("long changed while the short was still open %+v", row)
		}
	}

	book.open = false
	n, err := CloseFlatEntries(book, mustOpen(t, 7, 2), closed.Add(time.Minute))
	if err != nil || n != 1 {
		t.Fatalf("closed n=%d err=%v", n, err)
	}
	left := mustOpen(t, 7, 2)
	if len(left) != 1 || left[0].ID != kept {
		t.Fatalf("long should stay open %+v", left)
	}
	rows, err := ListEntries(7, 2, 10)
	if err != nil {
		t.Fatal(err)
	}
	foundShort := false
	for _, row := range rows {
		if row.ID != id {
			continue
		}
		foundShort = true
		// 250*0.08380 + 150*0.08370 = 33.505; /400 = 0.0837625
		if !almostEqual(row.ExitPrice, 0.0837625) || !almostEqual(row.ExitQty, 400) || !row.ClosedAt.Equal(closed) {
			t.Fatalf("exit %+v", row)
		}
		if !almostEqual(row.RealizedUSDT, 0.092) || row.ExitReason != ReasonExchangeFlat {
			t.Fatalf("pnl %+v", row)
		}
		if !almostEqual(row.EntryPrice, 0.08404) || !almostEqual(row.Qty, 400) {
			t.Fatalf("entry %+v", row)
		}
	}
	if !foundShort {
		t.Fatalf("rows %+v", rows)
	}
}

func TestCloseFlatEntryWaitsForFillAndIncome(t *testing.T) {
	ResetForTest()
	t.Cleanup(ResetForTest)
	opened := time.Date(2026, 10, 12, 5, 15, 0, 0, time.UTC)
	closed := opened.Add(26 * time.Minute)
	if _, err := SaveEntry(EntryRecord{
		UserID: 7, StrategyID: 2, Symbol: "DOGEUSDT", Side: "short",
		EntryPrice: 0.08417, Qty: 400, OpenedAt: opened,
	}); err != nil {
		t.Fatal(err)
	}
	book := &stubBook{fills: dogeFills(opened, closed)}
	if n, err := CloseFlatEntries(book, mustOpen(t, 7, 2), closed.Add(time.Minute)); err != nil || n != 0 {
		t.Fatalf("missing income n=%d err=%v", n, err)
	}
	if len(mustOpen(t, 7, 2)) != 1 {
		t.Fatal("row closed without income")
	}
	book.fills = nil
	book.parts = dogeIncome()
	if n, err := CloseFlatEntries(book, mustOpen(t, 7, 2), closed.Add(time.Minute)); err != nil || n != 0 {
		t.Fatalf("missing fill n=%d err=%v", n, err)
	}
	if len(mustOpen(t, 7, 2)) != 1 {
		t.Fatal("row closed without a fill")
	}
	book.fills = dogeFills(opened, closed)
	book.parts = IncomeParts{Commission: -0.01, Rows: 1}
	if n, err := CloseFlatEntries(book, mustOpen(t, 7, 2), closed.Add(time.Minute)); err != nil || n != 0 {
		t.Fatalf("commission only n=%d err=%v", n, err)
	}
	if len(mustOpen(t, 7, 2)) != 1 {
		t.Fatal("row closed before realized pnl posted")
	}
	book.posErr = errors.New("position down")
	book.fills = dogeFills(opened, closed)
	if n, err := CloseFlatEntries(book, mustOpen(t, 7, 2), closed.Add(time.Minute)); err == nil || n != 0 {
		t.Fatalf("position error n=%d err=%v", n, err)
	}
	if len(mustOpen(t, 7, 2)) != 1 {
		t.Fatal("row closed after a position error")
	}
}

func TestRunnerBackfillsFlatEntryOnStart(t *testing.T) {
	ResetForTest()
	t.Cleanup(ResetForTest)
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.dual = true
	opened := time.Date(2026, 10, 12, 5, 15, 0, 0, time.UTC)
	closed := opened.Add(26 * time.Minute)
	fake.riskBody = `[{"symbol":"XRPUSDT","positionAmt":"0","entryPrice":"0","positionSide":"LONG"},{"symbol":"XRPUSDT","positionAmt":"0","entryPrice":"1.5","positionSide":"SHORT"}]`
	fake.trades = `[
		{"symbol":"XRPUSDT","side":"SELL","positionSide":"SHORT","price":"1.5000","qty":"10","time":` + ms(opened) + `},
		{"symbol":"XRPUSDT","side":"BUY","positionSide":"SHORT","price":"1.4800","qty":"10","time":` + ms(closed) + `}
	]`
	fake.income = `[
		{"symbol":"XRPUSDT","incomeType":"REALIZED_PNL","income":"0.20","time":` + ms(closed) + `},
		{"symbol":"XRPUSDT","incomeType":"COMMISSION","income":"-0.01","time":` + ms(closed) + `},
		{"symbol":"XRPUSDT","incomeType":"FUNDING_FEE","income":"-0.01","time":` + ms(closed) + `},
		{"symbol":"XRPUSDT","incomeType":"TRANSFER","income":"9","time":` + ms(closed) + `}
	]`
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	client := NewUSDMClient(server.URL)
	cfg := testConfig()
	cfg.ID = 2
	secrets := func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	}
	eng := NewEngine(cfg, client, DiscardLogger())
	eng.SetUser(7)
	eng.SetSecrets(secrets)
	if err := eng.Start(calmStart(opened, 2)); err != nil {
		t.Fatal(err)
	}
	if eng.State() != StateArmed {
		t.Fatalf("start left %s", eng.State())
	}
	if _, err := SaveEntry(EntryRecord{
		UserID: 7, StrategyID: cfg.ID, Symbol: cfg.Symbol, Side: string(SideShort),
		EntryPrice: 1.6, Qty: 9, OpenedAt: opened,
	}); err != nil {
		t.Fatal(err)
	}
	h := NewHub()
	h.PutForTest(7, cfg.ID, eng)
	r := NewRunner(h)
	r.SetClock(func() time.Time { return closed.Add(time.Minute) })
	r.SetMarket(func(Config, SecretOpener, time.Time) (Market, error) {
		return Market{Mark: 1.5, Wallet: 20, Available: 20, WalletKnown: true, Equity: 20, EquityKnown: true, PositionsKnown: true}, nil
	})
	r.SetStep(func(RunSpec, StepInput) (Snapshot, error) {
		return Snapshot{State: StateArmed}, nil
	})
	r.Start()
	t.Cleanup(func() { r.Remove(cfg.ID) })
	r.Ensure(RunSpec{UserID: 7, Config: cfg, Secrets: secrets})

	deadline := time.Now().Add(2 * time.Second)
	var row EntryRecord
	for time.Now().Before(deadline) {
		rows, err := ListEntries(7, cfg.ID, 5)
		if err == nil && len(rows) == 1 && !rows[0].ClosedAt.IsZero() {
			row = rows[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !row.ClosedAt.Equal(closed) || row.ExitReason != ReasonExchangeFlat {
		t.Fatalf("row %+v", row)
	}
	if !almostEqual(row.ExitPrice, 1.48) || !almostEqual(row.ExitQty, 10) || !almostEqual(row.RealizedUSDT, 0.18) {
		t.Fatalf("exit %+v", row)
	}
	if !almostEqual(row.EntryPrice, 1.5) || !almostEqual(row.Qty, 10) {
		t.Fatalf("entry price not taken from the fill %+v", row)
	}
	if eng.State() != StateArmed {
		t.Fatalf("backfill changed state %s", eng.State())
	}
}

func mustOpen(t *testing.T, userID, strategyID int64) []EntryRecord {
	t.Helper()
	rows, err := OpenEntries(userID, strategyID)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}
