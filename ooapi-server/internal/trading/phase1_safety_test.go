package trading

import (
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestReadFlatBookRequiresHasRealized(t *testing.T) {
	ResetBoostForTest()
	t.Cleanup(ResetBoostForTest)
	now := time.Date(2026, 10, 13, 4, 0, 0, 0, time.UTC)
	since := now.Add(-time.Hour)
	book := &incomePartsStub{parts: IncomeParts{
		Commission: -0.02, Rows: 1, HasRealized: false,
	}}
	eng := NewEngine(testConfig(), book, DiscardLogger())
	eng.pos = position{Side: SideLong, Qty: 10, Entry: 1, OpenedAt: since}
	got, err := eng.readFlatBook(since, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.ready {
		t.Fatalf("ready without REALIZED_PNL: %+v", got)
	}
	book.parts = IncomeParts{
		RealizedPnL: -0.25, Commission: -0.02, Rows: 2, HasRealized: true,
	}
	book.price, book.qty, book.found = 1.1, 10, true
	got, err = eng.readFlatBook(since, now)
	if err != nil || !got.ready {
		t.Fatalf("ready with realized %+v err=%v", got, err)
	}
}

type incomePartsStub struct {
	Paper
	parts IncomeParts
	price float64
	qty   float64
	found bool
}

func (s *incomePartsStub) SyncsPosition() bool { return true }

func (s *incomePartsStub) IncomeParts(string, time.Time, time.Time) (IncomeParts, error) {
	return s.parts, nil
}

func (s *incomePartsStub) ClosingFill(string, Side, time.Time, time.Time) (float64, float64, bool, error) {
	return s.price, s.qty, s.found, nil
}

func TestResolveLiveTakeProfitUsesObservedDistanceForTheta(t *testing.T) {
	fees := FeesFromRates(TakerFeeRate, MakerFeeRate)
	// 样本在极近止盈上测到的高胜率；若错误地用 floor 反解会得到正漂移并放行。
	p, sl, base := 0.9, 0.008, 0.0001
	dist, live, reason := ResolveLiveTakeProfit(p, true, sl, base, fees)
	if reason != ReasonNegativeExpectancy || dist != 0 {
		t.Fatalf("geometry mismatch should reject: dist=%v live=%v reason=%s", dist, live, reason)
	}
	if live > 0 {
		t.Fatalf("optimistic live EV %v", live)
	}
	// 观测距离本身已在 floor 之上时行为与旧逻辑一致：高胜率保留 floor。
	kept, reason := ResolveTakeProfit(0.9, true, 0.003, MinScalpTpPct, fees)
	if reason != "" || math.Abs(kept-MinScalpTpPct) > 1e-15 {
		t.Fatalf("floor sample %v %s", kept, reason)
	}
}

func TestFinitePositiveRejectsNaNAndInf(t *testing.T) {
	if finitePositive(math.NaN()) || finitePositive(math.Inf(1)) || finitePositive(0) || finitePositive(-1) {
		t.Fatal("finitePositive accepted non-positive")
	}
	if !finitePositive(1.5) {
		t.Fatal("finitePositive rejected 1.5")
	}
	_, _, qty, err := SizePosition(math.NaN(), 3, 1, 5)
	if err == nil || qty != 0 {
		t.Fatalf("NaN margin sized qty=%v err=%v", qty, err)
	}
	led := &Ledger{Capital: 100}
	if led.Add(math.NaN(), 4) {
		t.Fatal("NaN pnl halted ledger")
	}
	if led.Realized != 0 || led.Cumulative != 0 {
		t.Fatalf("NaN polluted ledger %+v", led)
	}
	t.Setenv(EnvMaxMarginPerTradeUSDT, "NaN")
	if envPositiveFloat(EnvMaxMarginPerTradeUSDT) != 0 {
		t.Fatal("env accepted NaN")
	}
	t.Setenv(EnvMaxMarginPerTradeUSDT, "+Inf")
	if envPositiveFloat(EnvMaxMarginPerTradeUSDT) != 0 {
		t.Fatal("env accepted Inf")
	}
}

func TestClientOrderIDOnEntryStopTakeAndClose(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]string{}
	algoHung := false
	takeHung := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.URL.Path == "/fapi/v1/exchangeInfo":
			_, _ = w.Write([]byte(`{"symbols":[{"symbol":"XRPUSDT","filters":[
				{"filterType":"LOT_SIZE","stepSize":"0.1","minQty":"0.1"},
				{"filterType":"PRICE_FILTER","tickSize":"0.0001"},
				{"filterType":"MIN_NOTIONAL","notional":"5"}
			]}]}`))
		case r.URL.Path == "/fapi/v1/positionSide/dual":
			_, _ = w.Write([]byte(`{"dualSidePosition":false}`))
		case r.URL.Path == "/fapi/v1/leverageBracket":
			_, _ = w.Write([]byte(`[{"brackets":[{"initialLeverage":125,"maintMarginRatio":0.005}]}]`))
		case r.Method == http.MethodPost && r.URL.Path == "/fapi/v1/marginType":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodPost && r.URL.Path == "/fapi/v1/leverage":
			_, _ = w.Write([]byte(`{"leverage":3}`))
		case r.Method == http.MethodPost && r.URL.Path == "/fapi/v1/order":
			cid := q.Get("newClientOrderId")
			if cid == "" {
				t.Errorf("missing newClientOrderId on %s", q.Get("type"))
			}
			key := q.Get("type")
			if tif := q.Get("timeInForce"); tif != "" {
				key += "|" + tif
			}
			if reduce := q.Get("reduceOnly"); reduce != "" {
				key += "|reduce"
			}
			seen[key] = cid
			if q.Get("type") == "LIMIT" {
				takeHung = true
			}
			_, _ = w.Write([]byte(`{"orderId":1,"status":"FILLED","avgPrice":"1.0","executedQty":"10","cumQuote":"10"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/fapi/v1/algoOrder":
			cid := q.Get("clientAlgoId")
			if cid == "" || !strings.HasPrefix(cid, "oo-sl-") {
				t.Errorf("bad clientAlgoId %q", cid)
			}
			seen["STOP_MARKET"] = cid
			algoHung = true
			_, _ = w.Write([]byte(`{"algoId":99}`))
		case r.URL.Path == "/fapi/v2/positionRisk":
			_, _ = w.Write([]byte(`[{"symbol":"XRPUSDT","positionAmt":"10","entryPrice":"1","positionSide":"BOTH"}]`))
		case r.URL.Path == "/fapi/v1/openAlgoOrders":
			if algoHung {
				_, _ = w.Write([]byte(`[{"algoId":99,"symbol":"XRPUSDT","side":"SELL","orderType":"STOP_MARKET","triggerPrice":"0.992","closePosition":true,"algoStatus":"NEW"}]`))
			} else {
				_, _ = w.Write([]byte(`[]`))
			}
		case r.URL.Path == "/fapi/v1/openOrders":
			if takeHung {
				_, _ = w.Write([]byte(`[{"orderId":2,"symbol":"XRPUSDT","side":"SELL","type":"LIMIT","price":"1.015","origQty":"10","timeInForce":"GTX","reduceOnly":true,"status":"NEW"}]`))
			} else {
				_, _ = w.Write([]byte(`[]`))
			}
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: "k", APISecret: "s", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	entryID := "oo-ent-deadbeefdeadbeef"
	if _, err := client.PlaceEntry(EntryOrder{
		Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 10, Price: 1, Leverage: 3, MarginMode: MarginIsolated,
		ClientOrderID: entryID,
	}); err != nil {
		t.Fatal(err)
	}
	if seen["MARKET"] != entryID {
		t.Fatalf("entry id %q", seen["MARKET"])
	}
	stopID, takeID := "oo-sl-aaaaaaaaaaaaaaaa", "oo-tp-bbbbbbbbbbbbbbbb"
	if err := client.PlaceProtection(Protection{
		Symbol: SymbolXRPUSDT, Side: SideLong, Stop: 0.992, Take: 1.015,
		StopClientID: stopID, TakeClientID: takeID,
	}); err != nil {
		t.Fatal(err)
	}
	if seen["STOP_MARKET"] != stopID {
		t.Fatalf("stop id %q map=%v", seen["STOP_MARKET"], seen)
	}
	takeGot := seen["LIMIT|GTX|reduce"]
	if takeGot == "" {
		takeGot = seen["LIMIT|GTX"]
	}
	if takeGot != takeID {
		t.Fatalf("take id %q map=%v", takeGot, seen)
	}
	closeID := "oo-cls-cccccccccccccccc"
	if _, err := client.Close(CloseOrder{Symbol: SymbolXRPUSDT, Price: 1, ClientOrderID: closeID}); err != nil {
		t.Fatal(err)
	}
	if seen["MARKET|reduce"] != closeID {
		t.Fatalf("close id want %q got %q map=%v", closeID, seen["MARKET|reduce"], seen)
	}
}

func TestAdoptOrphanPositionHangsProtection(t *testing.T) {
	protectionRetryGap = 0
	t.Cleanup(func() { protectionRetryGap = 300 * time.Millisecond })
	ex := &adoptExchange{
		Paper: Paper{pos: Position{Open: true, Side: SideLong, Qty: 10, Entry: 1}},
	}
	ex.Syncs = true
	cfg := testConfig()
	cfg.Mode = ModeTestnet
	eng := NewEngine(cfg, ex, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: "k", APISecret: "s", Network: ModeTestnet}, nil
	})
	now := time.Now().UTC()
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, []Candle{{OpenTime: now, Close: 1}}, 1, 20)
	in.PositionsKnown = true
	in.Positions = []KeyPosition{{Symbol: cfg.Symbol, Qty: 10, Entry: 1, Leverage: cfg.Leverage}}
	snap, err := eng.Step(in)
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || snap.Side != SideLong || snap.LastReason != ReasonAdoptPosition {
		t.Fatalf("adopt snap %+v protects=%d", snap, ex.protects)
	}
	if ex.protects < 1 || ex.closes != 0 {
		t.Fatalf("protects=%d closes=%d", ex.protects, ex.closes)
	}
}

func TestAdoptOrphanFlattensWhenProtectionFails(t *testing.T) {
	protectionRetryGap = 0
	t.Cleanup(func() { protectionRetryGap = 300 * time.Millisecond })
	ex := &adoptExchange{
		Paper:    Paper{pos: Position{Open: true, Side: SideLong, Qty: 10, Entry: 1}},
		failProt: true,
	}
	ex.Syncs = true
	cfg := testConfig()
	eng := NewEngine(cfg, ex, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: "k", APISecret: "s", Network: ModeTestnet}, nil
	})
	now := time.Now().UTC()
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, []Candle{{OpenTime: now, Close: 1}}, 1, 20)
	in.PositionsKnown = true
	in.Positions = []KeyPosition{{Symbol: cfg.Symbol, Qty: 10, Entry: 1, Leverage: cfg.Leverage}}
	snap, err := eng.Step(in)
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateArmed {
		t.Fatalf("state %+v", snap)
	}
	if ex.closes < 1 || ex.Paper.pos.Open {
		t.Fatalf("closes=%d open=%v", ex.closes, ex.Paper.pos.Open)
	}
}

type adoptExchange struct {
	Paper
	Syncs    bool
	protects int
	closes   int
	failProt bool
}

func (a *adoptExchange) SyncsPosition() bool { return a.Syncs }

func (a *adoptExchange) PlaceProtection(req Protection) error {
	a.protects++
	if a.failProt {
		return invalid("protection refused")
	}
	return a.Paper.PlaceProtection(req)
}

func (a *adoptExchange) Close(req CloseOrder) (Fill, error) {
	a.closes++
	return a.Paper.Close(req)
}
