package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ooapi/internal/trading"
)

type fakeDeskBook struct {
	mu       sync.Mutex
	opened   int
	network  string
	symbol   string
	interval string
	limit    int
	klines   []trading.DeskCandle
	mark     float64
	// quote 是 24h 统计。零值时接口返回错误 —— 与真实交易所「拿不到行情」一致，
	// 让「可选数据缺失」这条路径在测试里也被走到。
	quote     trading.Ticker24h
	risk      trading.RiskView
	orders    []trading.DeskOrder
	algos     []trading.DeskOrder
	equity    trading.AccountEquity
	positions []trading.PanelPosition
	income    []trading.IncomeEvent
	fail      error
	modes     []string
}

func (f *fakeDeskBook) install(t *testing.T) {
	t.Helper()
	prev := newDeskBook
	newDeskBook = func(network string) (trading.DeskBook, error) {
		f.mu.Lock()
		f.modes = append(f.modes, network)
		f.mu.Unlock()
		return f, nil
	}
	t.Cleanup(func() { newDeskBook = prev })
}

func (f *fakeDeskBook) Klines(symbol, interval string, limit int) ([]trading.DeskCandle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	f.symbol, f.interval, f.limit = symbol, interval, limit
	return f.klines, nil
}

func (f *fakeDeskBook) MarkPrice(string) (float64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return 0, f.fail
	}
	return f.mark, nil
}

func (f *fakeDeskBook) Ticker24h(string) (trading.Ticker24h, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return trading.Ticker24h{}, f.fail
	}
	if f.quote.LastPrice <= 0 {
		return trading.Ticker24h{}, errors.New("no quote")
	}
	return f.quote, nil
}

func (f *fakeDeskBook) PositionRisk(string) (trading.RiskView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return trading.RiskView{}, f.fail
	}
	return f.risk, nil
}

func (f *fakeDeskBook) OpenOrders(string) ([]trading.DeskOrder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	return f.orders, nil
}

func (f *fakeDeskBook) OpenAlgoOrders(string) ([]trading.DeskOrder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	return f.algos, nil
}

func (f *fakeDeskBook) UseReadCredentials(creds trading.Credentials) error {
	if creds.APIKey == "" || creds.APISecret == "" {
		return trading.ErrKeyNotUsable
	}
	f.mu.Lock()
	f.opened++
	f.network = creds.Network
	f.mu.Unlock()
	return nil
}

func (f *fakeDeskBook) ReadEquity() (trading.AccountEquity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return trading.AccountEquity{}, f.fail
	}
	return f.equity, nil
}

func (f *fakeDeskBook) ListOpenPositions() ([]trading.PanelPosition, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	out := append([]trading.PanelPosition{}, f.positions...)
	if out == nil {
		out = []trading.PanelPosition{}
	}
	return out, nil
}

func (f *fakeDeskBook) AccountIncomeHistory(since, now time.Time) ([]trading.IncomeEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	out := make([]trading.IncomeEvent, 0, len(f.income))
	for _, row := range f.income {
		if row.Time.Before(since) || row.Time.After(now) {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

func TestTradingDeskReadsStatusMarketPositionOrdersAndPnL(t *testing.T) {
	t.Setenv("TRADING_TESTNET_GREEN", "")
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)
	if trading.TestnetGreen() {
		t.Fatal("live gate opened")
	}

	useTradingDB(t)
	owner := tradingUser(11)
	other := tradingUser(12)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "主号",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	if keyRec.Code != http.StatusOK {
		t.Fatalf("key = %d %s", keyRec.Code, keyRec.Body.String())
	}
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`}`, owner, "")
	if created.Code != http.StatusOK {
		t.Fatalf("strategy = %d %s", created.Code, created.Body.String())
	}
	strategyID := int64(tradingData(t, created)["id"].(float64))
	path := "?strategyId=" + formatID(strategyID)

	book := &fakeDeskBook{
		mark: 0.53,
		klines: []trading.DeskCandle{
			{OpenTime: time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC), Open: 0.50, High: 0.55, Low: 0.48, Close: 0.52},
			{OpenTime: time.Date(2026, 10, 12, 0, 5, 0, 0, time.UTC), Open: 0.52, High: 0.56, Low: 0.51, Close: 0.54},
		},
	}
	book.install(t)

	state := callTrading(t, GetTradingEngineState, http.MethodGet, "/api/trading/engine/state"+path, "", owner, "")
	view := tradingData(t, state)
	assertNoPlainSecret(t, view)
	if view["state"] != "Idle" || view["mode"] != "testnet" || view["testnetGreen"] != false {
		t.Fatalf("status %#v", view)
	}
	if view["symbol"] != "XRPUSDT" || view["leverage"] != float64(3) || view["marginMode"] != "isolated" || view["timeframe"] != "5m" {
		t.Fatalf("strategy fields %#v", view)
	}
	if view["exchangeKeyLabel"] != "主号" || view["exchangeKeyNetwork"] != "testnet" || view["realizedNetwork"] != "testnet" {
		t.Fatalf("account %#v", view)
	}
	if view["dayRealizedUsdt"] != float64(0) || view["cumulativeRealizedUsdt"] != float64(0) {
		t.Fatalf("pnl %#v", view)
	}
	if msg, ok := view["lastError"]; ok && msg != "" {
		t.Fatalf("idle lastError %#v", msg)
	}

	market := callTrading(t, GetTradingMarket, http.MethodGet, "/api/trading/engine/market"+path, "", owner, "")
	mkt := tradingData(t, market)
	assertNoPlainSecret(t, mkt)
	if mkt["markPrice"] != 0.53 || mkt["timeframe"] != "5m" || mkt["limit"] != float64(100) {
		t.Fatalf("market %#v", mkt)
	}
	candles, _ := mkt["klines"].([]any)
	if len(candles) != 2 || candles[1].(map[string]any)["close"] != 0.54 {
		t.Fatalf("klines %#v", mkt["klines"])
	}
	if _, ok := mkt["levels"]; ok {
		t.Fatalf("flat market drew levels %#v", mkt["levels"])
	}
	if book.opened != 0 || book.symbol != "XRPUSDT" || book.interval != "5m" || book.limit != 100 {
		t.Fatalf("public read opened=%d book=%+v", book.opened, book)
	}

	flat := callTrading(t, GetTradingPosition, http.MethodGet, "/api/trading/engine/position"+path, "", owner, "")
	pos := tradingData(t, flat)
	assertNoPlainSecret(t, pos)
	if pos["open"] != false || pos["network"] != "testnet" {
		t.Fatalf("flat %#v", pos)
	}
	if _, ok := pos["qty"]; ok {
		t.Fatalf("flat position still has qty %#v", pos)
	}
	if book.opened != 1 || book.network != networkTestnet {
		t.Fatalf("signed opened=%d network=%s", book.opened, book.network)
	}

	none := callTrading(t, GetTradingOrders, http.MethodGet, "/api/trading/engine/orders"+path, "", owner, "")
	orders := tradingData(t, none)
	items, _ := orders["items"].([]any)
	if orders["empty"] != true || len(items) != 0 || orders["network"] != "testnet" {
		t.Fatalf("empty orders %#v", orders)
	}

	book.mu.Lock()
	book.risk = trading.RiskView{
		Open: true, Side: trading.SideLong, Qty: 10, EntryPrice: 0.5, MarkPrice: 0.53,
		UnrealizedPnl: 0.3, Leverage: 3, Margin: 1.7, MarginMode: "isolated",
	}
	book.orders = []trading.DeskOrder{{
		ID: "11", Source: trading.OrderSourceBook, Kind: trading.OrderKindEntry,
		Symbol: "XRPUSDT", Side: "buy", Type: "LIMIT", Status: "new", Price: 0.49, Qty: 10,
	}}
	book.algos = []trading.DeskOrder{
		{ID: "21", Source: trading.OrderSourceAlgo, Kind: trading.OrderKindStop, Type: "STOP_MARKET", Status: "new", StopPrice: 0.48, ClosePosition: true},
		{ID: "22", Source: trading.OrderSourceAlgo, Kind: trading.OrderKindTake, Type: "TAKE_PROFIT_MARKET", Status: "new", StopPrice: 0.56, ClosePosition: true},
	}
	book.mu.Unlock()

	held := tradingData(t, callTrading(t, GetTradingPosition, http.MethodGet, "/api/trading/engine/position"+path, "", owner, ""))
	if held["open"] != true || held["side"] != "long" || held["qty"] != float64(10) || held["entryPrice"] != 0.5 || held["markPrice"] != 0.53 || held["unrealizedPnl"] != 0.3 || held["leverage"] != float64(3) || held["margin"] != 1.7 {
		t.Fatalf("held %#v", held)
	}
	listed := tradingData(t, callTrading(t, GetTradingOrders, http.MethodGet, "/api/trading/engine/orders"+path, "", owner, ""))
	rows, _ := listed["items"].([]any)
	if listed["empty"] != false || len(rows) != 3 {
		t.Fatalf("orders %#v", listed)
	}
	kinds := []string{
		rows[0].(map[string]any)["kind"].(string),
		rows[1].(map[string]any)["kind"].(string),
		rows[2].(map[string]any)["kind"].(string),
	}
	if kinds[0] != "entry" || kinds[1] != "stop" || kinds[2] != "takeProfit" {
		t.Fatalf("kinds %v", kinds)
	}
	assertNoPlainSecret(t, held)
	assertNoPlainSecret(t, listed)

	cfg := trading.DefaultConfig()
	cfg.ExchangeKeyID = keyID
	eng := trading.NewEngine(cfg, trading.NewPaper(), trading.DiscardLogger())
	eng.SeedPositionForTest(trading.SideLong, 10, 0.5, 0.48, 0.56)
	trading.DefaultHub().PutForTest(owner.ID, strategyID, eng)
	withLevels := tradingData(t, callTrading(t, GetTradingMarket, http.MethodGet, "/api/trading/engine/market"+path+"&limit=2", "", owner, ""))
	levels, _ := withLevels["levels"].(map[string]any)
	if withLevels["limit"] != float64(2) || levels["entryPrice"] != 0.5 || levels["stopPrice"] != 0.48 || levels["takeProfitPrice"] != 0.56 {
		t.Fatalf("levels %#v", withLevels)
	}
	running := tradingData(t, callTrading(t, GetTradingEngineState, http.MethodGet, "/api/trading/engine/state"+path, "", owner, ""))
	if running["state"] != "InPosition" || running["exchangeKeyLabel"] != "主号" {
		t.Fatalf("running %#v", running)
	}

	stopped := trading.NewEngine(cfg, trading.NewPaper(), trading.DiscardLogger())
	stopped.Restore(trading.Runtime{
		State:      trading.StateError,
		LastError:  "保护单没有挂上",
		Realized:   -0.2,
		Cumulative: -0.5,
		Capital:    2,
		Day:        time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC),
	})
	trading.DefaultHub().PutForTest(owner.ID, strategyID, stopped)
	failed := tradingData(t, callTrading(t, GetTradingEngineState, http.MethodGet, "/api/trading/engine/state"+path, "", owner, ""))
	if failed["state"] != "Error" || failed["lastError"] != "保护单没有挂上" || failed["realizedNetwork"] != "testnet" {
		t.Fatalf("error state %#v", failed)
	}
	if !near(failed["dayRealizedUsdt"], -0.2) || !near(failed["cumulativeRealizedUsdt"], -0.5) {
		t.Fatalf("pnl %#v", failed)
	}

	badLimit := callTrading(t, GetTradingMarket, http.MethodGet, "/api/trading/engine/market"+path+"&limit=0", "", owner, "")
	if badLimit.Code != http.StatusBadRequest || tradingCode(t, badLimit) != "bad_request" {
		t.Fatalf("limit = %d %s", badLimit.Code, badLimit.Body.String())
	}
	hidden := callTrading(t, GetTradingEngineState, http.MethodGet, "/api/trading/engine/state"+path, "", other, "")
	if hidden.Code != http.StatusNotFound {
		t.Fatalf("cross user = %d %s", hidden.Code, hidden.Body.String())
	}

	revoked := callTrading(t, RevokeExchangeKey, http.MethodPost, "/api/trading/exchange-keys/1/revoke", "", owner, formatID(keyID))
	if revoked.Code != http.StatusOK {
		t.Fatalf("revoke = %d %s", revoked.Code, revoked.Body.String())
	}
	stillPublic := callTrading(t, GetTradingMarket, http.MethodGet, "/api/trading/engine/market"+path+"&limit=2", "", owner, "")
	if stillPublic.Code != http.StatusOK {
		t.Fatalf("market after revoke = %d %s", stillPublic.Code, stillPublic.Body.String())
	}
	deniedPos := callTrading(t, GetTradingPosition, http.MethodGet, "/api/trading/engine/position"+path, "", owner, "")
	if deniedPos.Code != http.StatusBadRequest || tradingCode(t, deniedPos) != "exchange_key_required" {
		t.Fatalf("revoked position = %d %s", deniedPos.Code, deniedPos.Body.String())
	}
	if trading.TestnetGreen() {
		t.Fatal("desk read opened the live gate")
	}
}

func TestTradingDeskLiveReadDoesNotOpenOrderGate(t *testing.T) {
	t.Setenv("TRADING_TESTNET_GREEN", "")
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)

	useTradingDB(t)
	owner := tradingUser(13)
	const liveKey = "live-api-key-0123456789"
	const liveSecret = "live-api-secret-abcdef9876"
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "实盘",
		"network": "live",
		"apiKey": "`+liveKey+`",
		"apiSecret": "`+liveSecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`, "mode": "live"}`, owner, "")
	if created.Code != http.StatusOK {
		t.Fatalf("live strategy = %d %s", created.Code, created.Body.String())
	}
	strategyID := int64(tradingData(t, created)["id"].(float64))
	book := &fakeDeskBook{mark: 0.5, klines: []trading.DeskCandle{{Close: 0.5}}}
	book.install(t)

	pos := callTrading(t, GetTradingPosition, http.MethodGet, "/api/trading/engine/position?strategyId="+formatID(strategyID), "", owner, "")
	body := tradingData(t, pos)
	if body["open"] != false || body["network"] != "live" || book.network != trading.ModeLive || book.opened != 1 {
		t.Fatalf("live position %#v opened=%d network=%s", body, book.opened, book.network)
	}
	if pos.Body.String() != "" && (strings.Contains(pos.Body.String(), liveKey) || strings.Contains(pos.Body.String(), liveSecret) || strings.Contains(pos.Body.String(), "enc:v1:")) {
		t.Fatalf("live read leaked secret: %s", pos.Body.String())
	}
	market := callTrading(t, GetTradingMarket, http.MethodGet, "/api/trading/engine/market?strategyId="+formatID(strategyID), "", owner, "")
	if market.Code != http.StatusOK || book.opened != 1 {
		t.Fatalf("live market signed or failed: opened=%d %s", book.opened, market.Body.String())
	}
	if len(book.modes) < 2 || book.modes[0] != "live" || book.modes[1] != "live" {
		t.Fatalf("modes %v", book.modes)
	}
	_, err := trading.NewExchange(trading.Config{Mode: trading.ModeLive})
	if !errors.Is(err, trading.ErrLiveGateClosed) || trading.TestnetGreen() {
		t.Fatalf("gate err=%v green=%v", err, trading.TestnetGreen())
	}
}

func TestTradingDeskExchangeFailureStaysGeneric(t *testing.T) {
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)
	useTradingDB(t)
	owner := tradingUser(14)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "主号",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`}`, owner, "")
	strategyID := int64(tradingData(t, created)["id"].(float64))
	book := &fakeDeskBook{fail: errors.New("Get https://exchange.example/fapi?signature=deadbeef")}
	book.install(t)
	rec := callTrading(t, GetTradingMarket, http.MethodGet, "/api/trading/engine/market?strategyId="+formatID(strategyID), "", owner, "")
	if rec.Code != http.StatusBadGateway || tradingCode(t, rec) != "exchange_unavailable" {
		t.Fatalf("failure = %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "signature") || strings.Contains(rec.Body.String(), "https://") || strings.Contains(rec.Body.String(), testAPISecret) {
		t.Fatalf("failure body leaked: %s", rec.Body.String())
	}
}

func TestTradingBalanceReturnsEquityTodayPnLAndHistory(t *testing.T) {
	trading.ResetForTest()
	trading.ResetEquityHistoryForTest()
	resetSessionEquityForTest()
	t.Cleanup(func() {
		trading.ResetForTest()
		trading.ResetEquityHistoryForTest()
		resetSessionEquityForTest()
	})
	useTradingDB(t)
	owner := tradingUser(15)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "主号",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`}`, owner, "")
	strategyID := int64(tradingData(t, created)["id"].(float64))

	now := time.Now().UTC()
	day := trading.ShanghaiDayStart(now)

	/*
		事件时间必须落在 [day, now] 之内。

		原来写死 day.Add(1h/2h/3h)，即固定落在上海时间 01:00 / 02:00 / 03:00 ——
		凌晨跑测试时后面几条还在未来，TodayTradePnL 会把它们排除掉，
		断言于是随「几点跑」时好时坏（2026-10-16 01:19 实测：一直红）。
		改成按「今天已经过去的那一段」按比例取样，任何时刻跑都在区间内。
	*/
	elapsed := now.Sub(day)
	at := func(frac float64) time.Time {
		return day.Add(time.Duration(float64(elapsed) * frac))
	}
	book := &fakeDeskBook{
		equity: trading.AccountEquity{Wallet: 8.4, Available: 7.5, Unrealized: -0.4, Equity: 8.0, MarginUsed: 0.9},
		positions: []trading.PanelPosition{{
			Symbol: "DOGEUSDT", Open: true, Side: trading.SideShort, Qty: 100,
			EntryPrice: 0.2, MarkPrice: 0.204, UnrealizedPnl: -0.4, Leverage: 5, Margin: 4,
		}},
		income: []trading.IncomeEvent{
			{Asset: "USDT", IncomeType: "REALIZED_PNL", Income: -3.0, Time: at(0.25)},
			{Asset: "USDT", IncomeType: "COMMISSION", Income: -0.5, Time: at(0.5)},
			{Asset: "USDT", IncomeType: "FUNDING_FEE", Income: -0.1, Time: at(0.75)},
			{Asset: "USDT", IncomeType: "TRANSFER", Income: 10, Time: at(0.25)},
		},
	}
	book.install(t)

	rec := callTrading(t, GetTradingBalance, http.MethodGet, "/api/trading/engine/balance?strategyId="+formatID(strategyID), "", owner, "")
	view := tradingData(t, rec)
	assertNoPlainSecret(t, view)
	if !near(view["wallet"], 8.4) || !near(view["available"], 7.5) || !near(view["unrealized"], -0.4) {
		t.Fatalf("balance %#v", view)
	}
	if !near(view["marginUsed"], 0.9) || !near(view["equity"], 8.0) {
		t.Fatalf("equity %#v", view)
	}
	// trade = -3.6, today = -4.0, base = 8.4 - 6.4 = 2, pct = -200
	if view["todaySrc"] != "income" || !near(view["todayPnl"], -4.0) || !near(view["todayBase"], 2) {
		t.Fatalf("today %#v", view)
	}
	if !near(view["todayPct"], -200) || !near(view["todayRealized"], -3.6) {
		t.Fatalf("pct %#v", view)
	}
	history, _ := view["history"].([]any)
	if len(history) < 1 {
		t.Fatalf("history %#v", view["history"])
	}
	markers, _ := view["markers"].([]any)
	if len(markers) < 1 {
		t.Fatalf("markers %#v", view["markers"])
	}
	positions, _ := view["positions"].([]any)
	if len(positions) != 1 || positions[0].(map[string]any)["symbol"] != "DOGEUSDT" {
		t.Fatalf("positions %#v", view["positions"])
	}
	if book.opened != 1 {
		t.Fatalf("opened %d", book.opened)
	}
}

func formatID(id int64) string {
	return strconv.FormatInt(id, 10)
}

func near(got any, want float64) bool {
	n, ok := got.(float64)
	if !ok {
		return false
	}
	diff := n - want
	if diff < 0 {
		diff = -diff
	}
	return diff < 1e-9
}

func TestTradingMarketBySymbolForBoardGrid(t *testing.T) {
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)
	useTradingDB(t)

	owner := tradingUser(21)
	book := &fakeDeskBook{
		mark: 62500.5,
		klines: []trading.DeskCandle{
			{OpenTime: time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC), Open: 62400, High: 62600, Low: 62350, Close: 62500.5},
		},
	}
	book.install(t)

	rec := callTrading(t, GetTradingMarket, http.MethodGet, "/api/trading/engine/market?symbol=BTCUSDT&timeframe=5m&limit=120", "", owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("market by symbol = %d %s", rec.Code, rec.Body.String())
	}
	view := tradingData(t, rec)
	if view["symbol"] != "BTCUSDT" || view["timeframe"] != "5m" || view["limit"] != float64(120) || view["markPrice"] != 62500.5 {
		t.Fatalf("market by symbol view %#v", view)
	}
	if book.symbol != "BTCUSDT" || book.interval != "5m" || book.limit != 120 {
		t.Fatalf("book query %+v", book)
	}
}
