package trading

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEngineSendsIsolatedMarketAndProtectionToTestnet(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	server := httptest.NewServer(fake)
	defer server.Close()

	client := NewUSDMClient(server.URL)
	cfg := testConfig()
	eng := NewEngine(cfg, client, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	if len(fake.snapshot()) != 0 || eng.SecretOpens() != 0 {
		t.Fatal("start touched the exchange or opened the key")
	}
	if _, err := eng.Step(stepAt(now, []Candle{{OpenTime: now, Close: 1}}, 1, 2)); err != nil {
		t.Fatal(err)
	}
	if len(fake.snapshot()) != 0 || eng.SecretOpens() != 0 {
		t.Fatal("no-cross step touched the exchange")
	}

	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || snap.Side != SideLong {
		t.Fatalf("after entry %+v", snap)
	}
	if eng.SecretOpens() != 1 {
		t.Fatalf("secret opens %d", eng.SecretOpens())
	}
	fake.assertEntrySequence(t)

	held, err := eng.Step(stepAt(now.Add(time.Minute), candles, snap.EntryPrice, 2))
	if err != nil {
		t.Fatal(err)
	}
	if held.State != StateInPosition {
		t.Fatalf("hold %+v", held)
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 || fake.count("POST", "/fapi/v1/order", "LIMIT") != 1 {
		t.Fatalf("protection replaced while holding: %#v", fake.snapshot())
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "TAKE_PROFIT_MARKET") != 0 || fake.count("POST", "/fapi/v1/order", "TAKE_PROFIT_MARKET") != 0 {
		t.Fatal("take profit still uses a market conditional")
	}

	closed, err := eng.Step(stepAt(now.Add(2*time.Minute), candles, snap.TakeProfitPrice+0.01, 2))
	if err != nil {
		t.Fatal(err)
	}
	if closed.State != StateArmed {
		t.Fatalf("after exit %+v", closed)
	}
	// 记录三类调用各自第一次出现的次序：撤普通挂单 / 撤条件单 / 减仓市价单。
	//
	// 断言的是**先减仓、后撤单**：反过来（先撤保护单再平仓）时，撤单成功、
	// 市价单却超时或 5xx，仓位就留在交易所上且没有任何止损 —— 而重试路径
	// 在同一个网络故障下同样打不通。止损是 closePosition 的 STOP_MARKET，
	// 由交易所随仓位撤销，所以后撤不会留下会反手的挂单。
	reduceAt, cancelAt, algoAt := -1, -1, -1
	var canceledAlgo []string
	for i, call := range fake.snapshot() {
		if call.method == http.MethodDelete && call.path == "/fapi/v1/allOpenOrders" && cancelAt < 0 {
			cancelAt = i
		}
		if call.method == http.MethodDelete && call.path == "/fapi/v1/algoOrder" {
			if call.values.Get("algoId") == "" {
				t.Fatal("algo cancel missing algoId")
			}
			canceledAlgo = append(canceledAlgo, call.values.Get("algoId"))
			if algoAt < 0 {
				algoAt = i
			}
		}
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("reduceOnly") == "true" && call.values.Get("type") == "MARKET" {
			if reduceAt < 0 {
				reduceAt = i
			}
			if call.values.Get("side") != "SELL" {
				t.Fatalf("flatten %#v", call.values)
			}
		}
	}
	if reduceAt < 0 || cancelAt < 0 || algoAt < 0 {
		t.Fatalf("exit reduce=%d cancel=%d algo=%d", reduceAt, cancelAt, algoAt)
	}
	if cancelAt < reduceAt || algoAt < reduceAt {
		t.Fatalf("撤单发生在减仓之前（cancel=%d algo=%d reduce=%d）—— 平仓一旦失败，仓位会裸奔", cancelAt, algoAt, reduceAt)
	}
	if len(canceledAlgo) != 1 {
		t.Fatalf("条件单撤销次数 = %v", canceledAlgo)
	}
	fake.mu.Lock()
	leftLimits := len(fake.limits)
	fake.mu.Unlock()
	if leftLimits != 0 {
		t.Fatalf("maker take left open: %d", leftLimits)
	}
	if fake.count("GET", "/fapi/v1/openOrders", "") < 1 {
		t.Fatal("maker take was not read from openOrders")
	}
	if fake.count("GET", "/fapi/v1/openAlgoOrders", "") < 1 {
		t.Fatal("hung protection was not read from openAlgoOrders")
	}
}

func TestEngineBlocksWhenStepSizeBreaksMinNotional(t *testing.T) {
	fake := newBinanceFake(t, "1000", "1000", "0.0001", "5")
	server := httptest.NewServer(fake)
	defer server.Close()
	client := NewUSDMClient(server.URL)
	eng := NewEngine(testConfig(), client, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil || snap.LastReason != ReasonBelowMinNotional || snap.State != StateArmed || eng.SecretOpens() != 0 {
		t.Fatalf("snap %+v state %s opens %d err=%v", snap, eng.State(), eng.SecretOpens(), err)
	}
	for _, call := range fake.snapshot() {
		if call.path != "/fapi/v1/exchangeInfo" {
			t.Fatalf("unexpected call %s %s", call.method, call.path)
		}
	}
}

func TestEngineFlattensWhenTakeProfitFails(t *testing.T) {
	prev := protectionRetryGap
	protectionRetryGap = 0
	t.Cleanup(func() { protectionRetryGap = prev })
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.failTake = true
	server := httptest.NewServer(fake)
	defer server.Close()

	client := NewUSDMClient(server.URL)
	eng := NewEngine(testConfig(), client, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
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
	if snap.State != StateError || snap.LastReason != ReasonProtectiveOrdersFailed || snap.StopPrice <= 0 || snap.LiqPrice <= 0 {
		t.Fatalf("snap %+v", snap)
	}
	if fake.pos != 0 {
		t.Fatalf("position left open: %v", fake.pos)
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 || fake.count("POST", "/fapi/v1/order", "LIMIT") != protectionAttempts {
		t.Fatalf("protection calls stop=%d take=%d", fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET"), fake.count("POST", "/fapi/v1/order", "LIMIT"))
	}
	gtxRejects := 0
	for _, call := range fake.snapshot() {
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("timeInForce") == "GTX" {
			gtxRejects++
		}
	}
	if gtxRejects != protectionAttempts {
		t.Fatalf("gtx posts %d", gtxRejects)
	}
	reduces := 0
	canceledStop := false
	for _, call := range fake.snapshot() {
		if call.method == http.MethodDelete && call.path == "/fapi/v1/algoOrder" {
			canceledStop = true
		}
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("reduceOnly") == "true" && call.values.Get("type") == "MARKET" {
			if !canceledStop {
				t.Fatal("flatten reduced before the placed stop was canceled")
			}
			reduces++
		}
	}
	if reduces != 1 {
		t.Fatalf("reduce-only closes = %d", reduces)
	}
	fake.mu.Lock()
	left := len(fake.algos)
	fake.mu.Unlock()
	if left != 0 {
		t.Fatalf("orphan algo orders %d", left)
	}
}

func TestMaintMarginRateUsesTightestFetchedBracket(t *testing.T) {
	client := NewUSDMTestnet()
	if _, ok := client.MaintMarginRate(SymbolXRPUSDT, 20); ok {
		t.Fatal("missing brackets should not invent a rate")
	}
	client.StoreLeverageBrackets("xrpusdt", []LeverageBracket{
		{InitialLeverage: 75, MaintMarginRate: 0.004},
		{InitialLeverage: 20, MaintMarginRate: 0.01},
		{InitialLeverage: 10, MaintMarginRate: 0.025},
	})
	rate, ok := client.MaintMarginRate(SymbolXRPUSDT, 20)
	if !ok || rate != 0.01 {
		t.Fatalf("20x rate=%v ok=%v", rate, ok)
	}
	rate, ok = client.MaintMarginRate(SymbolXRPUSDT, 50)
	if !ok || rate != 0.004 {
		t.Fatalf("50x rate=%v ok=%v", rate, ok)
	}
	rate, ok = client.MaintMarginRate(SymbolXRPUSDT, 100)
	if !ok || rate != 0.025 {
		t.Fatalf("above every bracket rate=%v ok=%v", rate, ok)
	}
}

func TestUSDMClientMatchesKeyNetworkToHost(t *testing.T) {
	dialed := false
	client := NewUSDMClient(BinanceUSDMLiveBase)
	client.http.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		dialed = true
		return nil, errors.New("dialed")
	})
	if err := client.UseCredentials(Credentials{APIKey: "test-key-0123456789", APISecret: "test-secret-0123456789", Network: ModeTestnet}); !errors.Is(err, ErrKeyNotUsable) {
		t.Fatalf("testnet key on live host err=%v", err)
	}
	if err := client.UseCredentials(Credentials{APIKey: "live-key-0123456789", APISecret: "live-secret-0123456789", Network: ModeLive}); err != nil {
		t.Fatal(err)
	}
	_, err := client.PlaceEntry(EntryOrder{Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 10, Price: 1, Leverage: 3, MarginMode: MarginIsolated})
	if errors.Is(err, ErrLiveTransportDisabled) || errors.Is(err, ErrKeyNotUsable) || !dialed {
		t.Fatalf("err=%v dialed=%v", err, dialed)
	}

	testnet := NewUSDMTestnet()
	if testnet.BaseURL() != BinanceUSDMTestnetBase {
		t.Fatal("default base")
	}
	if err := testnet.UseCredentials(Credentials{APIKey: "live-key-0123456789", APISecret: "live-secret-0123456789", Network: ModeLive}); !errors.Is(err, ErrKeyNotUsable) {
		t.Fatalf("live key on testnet host err=%v", err)
	}
	if err := testnet.UseCredentials(Credentials{APIKey: "test-key-0123456789", APISecret: "test-secret-0123456789", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
}

func TestUSDMClientSignsRequests(t *testing.T) {
	var got string
	var key string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		key = r.Header.Get("X-MBX-APIKEY")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"dualSidePosition":false}`)
	}))
	defer server.Close()
	client := NewUSDMClient(server.URL)
	secret := "test-secret-0123456789"
	if err := client.UseCredentials(Credentials{APIKey: "test-key-0123456789", APISecret: secret, Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.hedge(); err != nil {
		t.Fatal(err)
	}
	payload, sig, ok := strings.Cut(got, "&signature=")
	if !ok || key != "test-key-0123456789" || strings.Contains(payload, secret) {
		t.Fatalf("query %s", got)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(payload))
	if hex.EncodeToString(mac.Sum(nil)) != sig {
		t.Fatalf("signature mismatch %s", got)
	}
	values, _ := url.ParseQuery(payload)
	if values.Get("recvWindow") != "5000" || values.Get("timestamp") == "" {
		t.Fatalf("payload %s", payload)
	}
}

func TestConditionalOrdersUseAlgoAPI(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.mu.Lock()
	fake.dual = true
	fake.pos = 10
	fake.entry = 1.5
	fake.posSide = "LONG"
	fake.mu.Unlock()
	server := httptest.NewServer(fake)
	defer server.Close()

	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	if err := client.PlaceProtection(Protection{Symbol: SymbolXRPUSDT, Side: SideLong, Stop: 1.4, Take: 1.6}); err != nil {
		t.Fatal(err)
	}
	var stop, take bool
	for _, call := range fake.snapshot() {
		if call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("type") == "LIMIT" {
			if call.values.Get("timeInForce") != "GTX" || call.values.Get("closePosition") != "" || call.values.Get("reduceOnly") != "" {
				t.Fatalf("hedge take %#v", call.values)
			}
			if call.values.Get("positionSide") != "LONG" || call.values.Get("side") != "SELL" || call.values.Get("quantity") == "" || call.values.Get("price") == "" {
				t.Fatalf("hedge take params %#v", call.values)
			}
			take = true
			continue
		}
		if call.method != http.MethodPost || call.path != "/fapi/v1/algoOrder" {
			continue
		}
		if call.values.Get("algoType") != "CONDITIONAL" || call.values.Get("closePosition") != "true" {
			t.Fatalf("algo %#v", call.values)
		}
		if call.values.Get("triggerPrice") == "" || call.values.Get("stopPrice") != "" || call.values.Get("quantity") != "" || call.values.Get("reduceOnly") != "" {
			t.Fatalf("algo params %#v", call.values)
		}
		if call.values.Get("positionSide") != "LONG" || call.values.Get("side") != "SELL" || call.values.Get("workingType") != "MARK_PRICE" {
			t.Fatalf("hedge algo %#v", call.values)
		}
		if call.values.Get("type") != "STOP_MARKET" {
			t.Fatalf("algo type %#v", call.values)
		}
		stop = true
	}
	if !stop || !take {
		t.Fatal("missing stop algo or maker take")
	}
	if err := client.CancelOpen(SymbolXRPUSDT); err != nil {
		t.Fatal(err)
	}
	canceled := map[string]bool{}
	sawRegular := false
	for _, call := range fake.snapshot() {
		if call.method == http.MethodDelete && call.path == "/fapi/v1/allOpenOrders" {
			sawRegular = true
		}
		if call.method == http.MethodDelete && call.path == "/fapi/v1/algoOrder" {
			canceled[call.values.Get("algoId")] = true
		}
	}
	if !sawRegular || !canceled["1"] || canceled["2"] {
		t.Fatalf("cancel regular=%v algo=%v", sawRegular, canceled)
	}
	fake.mu.Lock()
	leftLimits := len(fake.limits)
	fake.mu.Unlock()
	if leftLimits != 0 {
		t.Fatalf("maker take left %d", leftLimits)
	}
	fake.mu.Lock()
	left := len(fake.algos)
	fake.mu.Unlock()
	if left != 0 {
		t.Fatalf("algo orders left %d", left)
	}
}

type recordedCall struct {
	method string
	path   string
	values url.Values
}

type binanceFake struct {
	t               *testing.T
	apiKey          string
	secret          string
	step            string
	minQty          string
	tick            string
	minNot          string
	mu              sync.Mutex
	calls           []recordedCall
	pos             float64
	entry           float64
	posSide         string
	dual            bool
	algos           []fakeAlgo
	algoSeq         int64
	pending         float64
	queried         bool
	failTake        bool
	rejectEntry     bool
	emptyAfterPlace int
	limits          []fakeLimit
	orderSeq        int64
	income          string
	riskBody        string
	trades          string
	pendingSide     string
	pendingPosSide  string
	// blankAvg 让查单回报的均价和成交额都是 0，逼开仓去读 userTrades。
	blankAvg bool
	// postFilledBlank 让下单回报本身就是 FILLED 且均价为 0。旧逻辑看到 FILLED 就不会再查单。
	postFilledBlank bool
	// avgAfter 大于 0 时，前 avgAfter-1 次查单仍返回空均价，之后才给出成交价。
	avgAfter  int
	orderGets int
	// tradesAfter 大于 0 时，前 tradesAfter 次 userTrades 返回空数组。
	tradesAfter int
	tradeHits   int
	// keepFlat 让查单不要把持仓写成刚下的数量，并继续返回空成交。
	keepFlat bool
	// freezePos 让查单不要覆盖测试预设的持仓。
	freezePos bool
	// entryPx 大于 0 时，查单写下的持仓均价用它，不再写死 1.5。
	entryPx float64
	// echoOwnOrder 让 allOrders 回放这次 oo-ent 的 clientOrderId。
	echoOwnOrder  bool
	entryClientID string
	allOrdersBody string
}

type fakeAlgo struct {
	id       int64
	kind     string
	posSide  string
	side     string
	trigger  string
	closePos bool
}

type fakeLimit struct {
	id         int64
	symbol     string
	side       string
	posSide    string
	price      string
	orig       string
	executed   string
	reduceOnly bool
}

func newBinanceFake(t *testing.T, step, minQty, tick, minNotional string) *binanceFake {
	t.Helper()
	return &binanceFake{
		t: t, apiKey: "test-key-0123456789", secret: "test-secret-0123456789",
		step: step, minQty: minQty, tick: tick, minNot: minNotional,
		posSide: "BOTH",
	}
}

func (f *binanceFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path != "/fapi/v1/exchangeInfo" {
		f.checkSig(r)
	}
	values := r.URL.Query()
	f.calls = append(f.calls, recordedCall{method: r.Method, path: r.URL.Path, values: values})
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/fapi/v1/exchangeInfo":
		_, _ = io.WriteString(w, f.exchangeInfo())
	case "/fapi/v1/marginType":
		if values.Get("marginType") != "ISOLATED" || values.Get("symbol") != SymbolXRPUSDT {
			f.t.Errorf("margin %#v", values)
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"code":-4046,"msg":"No need to change margin type."}`)
	case "/fapi/v1/leverage":
		lev, convErr := strconv.Atoi(values.Get("leverage"))
		if convErr != nil || lev < 1 || lev > MaxLeverage || values.Get("symbol") != SymbolXRPUSDT {
			f.t.Errorf("leverage %#v", values)
		}
		_, _ = io.WriteString(w, `{"symbol":"XRPUSDT","leverage":`+strconv.Itoa(lev)+`}`)
	case "/fapi/v1/positionSide/dual":
		_, _ = io.WriteString(w, `{"dualSidePosition":`+strconv.FormatBool(f.dual)+`}`)
	case "/fapi/v1/order":
		f.order(w, r.Method, values)
	case "/fapi/v1/algoOrder":
		f.algo(w, r.Method, values)
	case "/fapi/v2/positionRisk":
		if f.riskBody != "" {
			_, _ = io.WriteString(w, f.riskBody)
			break
		}
		_, _ = io.WriteString(w, f.positionJSON())
	case "/fapi/v1/userTrades":
		f.tradeHits++
		if f.tradesAfter > 0 && f.tradeHits <= f.tradesAfter {
			_, _ = io.WriteString(w, `[]`)
			break
		}
		if f.trades == "" {
			_, _ = io.WriteString(w, `[]`)
			break
		}
		_, _ = io.WriteString(w, f.trades)
	case "/fapi/v1/allOrders":
		if f.allOrdersBody != "" {
			_, _ = io.WriteString(w, f.allOrdersBody)
			break
		}
		if f.echoOwnOrder && engineEntryClientID(f.entryClientID) {
			qty := formatQty(f.pending)
			if parseNum(qty) == 0 {
				qty = formatQty(absQty(f.pos))
			}
			side := f.entrySide()
			_, _ = io.WriteString(w, `[{"clientOrderId":"`+f.entryClientID+`","side":"`+side+`","positionSide":"BOTH","status":"FILLED","type":"MARKET","executedQty":"`+qty+`","reduceOnly":false,"time":20,"updateTime":20}]`)
			break
		}
		_, _ = io.WriteString(w, `[]`)
	case "/fapi/v1/openOrders":
		_, _ = io.WriteString(w, f.limitsJSON())
	case "/fapi/v1/commissionRate":
		_, _ = io.WriteString(w, `{"symbol":"`+values.Get("symbol")+`","makerCommissionRate":"0.0002","takerCommissionRate":"0.0005"}`)
	case "/fapi/v1/openAlgoOrders":
		if f.emptyAfterPlace > 0 && len(f.algos) > 0 {
			f.emptyAfterPlace--
			_, _ = io.WriteString(w, `[]`)
			break
		}
		_, _ = io.WriteString(w, f.algoOrdersJSON())
	case "/fapi/v1/income":
		if f.income == "" {
			_, _ = io.WriteString(w, `[]`)
			break
		}
		_, _ = io.WriteString(w, f.income)
	case "/fapi/v1/allOpenOrders":
		f.limits = nil
		_, _ = io.WriteString(w, `{"code":200,"msg":"The operation of cancel all open order is done."}`)
	default:
		f.t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *binanceFake) order(w http.ResponseWriter, method string, values url.Values) {
	if method == http.MethodDelete {
		id := values.Get("orderId")
		kept := f.limits[:0]
		found := false
		for _, order := range f.limits {
			if strconv.FormatInt(order.id, 10) == id {
				found = true
				continue
			}
			kept = append(kept, order)
		}
		f.limits = kept
		if !found {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"code":-2011,"msg":"Unknown order sent."}`)
			return
		}
		_, _ = io.WriteString(w, `{"orderId":`+id+`,"status":"CANCELED"}`)
		return
	}
	if method == http.MethodGet {
		f.queried = true
		f.orderGets++
		if f.avgAfter > 0 && f.orderGets < f.avgAfter {
			_, _ = io.WriteString(w, `{"orderId":`+values.Get("orderId")+`,"status":"FILLED","avgPrice":"0","executedQty":"0","cumQuote":"0","side":"`+f.entrySide()+`"}`)
			return
		}
		if !f.freezePos && !f.keepFlat {
			f.pos = f.pending
			f.entry = 1.5
			if f.entryPx > 0 {
				f.entry = f.entryPx
			}
			if f.pendingPosSide != "" {
				f.posSide = f.pendingPosSide
			}
			if strings.EqualFold(f.pendingSide, "SELL") && f.pos > 0 {
				f.pos = -f.pos
			}
		}
		if f.keepFlat {
			_, _ = io.WriteString(w, `{"orderId":`+values.Get("orderId")+`,"status":"FILLED","avgPrice":"0","executedQty":"0","cumQuote":"0","side":"`+f.entrySide()+`"}`)
			return
		}
		if f.blankAvg {
			qty := formatQty(absQty(f.pos))
			if qty == "" || qty == "0.0" || parseNum(qty) == 0 {
				qty = formatQty(f.pending)
			}
			_, _ = io.WriteString(w, `{"orderId":`+values.Get("orderId")+`,"status":"FILLED","avgPrice":"0","executedQty":"`+qty+`","cumQuote":"0","side":"`+f.pendingSide+`"}`)
			return
		}
		_, _ = io.WriteString(w, f.orderJSON("FILLED", values.Get("orderId"), formatQty(absQty(f.pos))))
		return
	}
	switch values.Get("type") {
	case "LIMIT":
		f.limitOrder(w, values)
	case "MARKET":
		if f.rejectEntry {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"code":-2019,"msg":"Margin is insufficient."}`)
			return
		}
		qty := parseNum(values.Get("quantity"))
		if values.Get("reduceOnly") == "true" {
			f.pos = 0
			_, _ = io.WriteString(w, f.orderJSON("FILLED", "9", values.Get("quantity")))
			return
		}
		f.pendingSide = values.Get("side")
		f.pendingPosSide = values.Get("positionSide")
		if id := values.Get("newClientOrderId"); id != "" {
			f.entryClientID = id
		}
		if values.Get("closePosition") != "" {
			f.t.Errorf("entry sent closePosition %#v", values)
		}
		f.pending = qty
		if f.postFilledBlank {
			_, _ = io.WriteString(w, `{"orderId":42,"status":"FILLED","avgPrice":"0","executedQty":"0","cumQuote":"0","side":"`+f.entrySide()+`"}`)
			return
		}
		_, _ = io.WriteString(w, `{"orderId":42,"status":"NEW","avgPrice":"0","executedQty":"0","side":"BUY"}`)
	default:
		f.t.Errorf("classic order type %#v", values)
		w.WriteHeader(http.StatusBadRequest)
	}
}

func (f *binanceFake) algo(w http.ResponseWriter, method string, values url.Values) {
	if method == http.MethodDelete {
		id := values.Get("algoId")
		if id == "" {
			f.t.Errorf("cancel algo missing algoId %#v", values)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		kept := f.algos[:0]
		found := false
		for _, order := range f.algos {
			if strconv.FormatInt(order.id, 10) == id {
				found = true
				continue
			}
			kept = append(kept, order)
		}
		f.algos = kept
		if !found {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"code":-2011,"msg":"Unknown order sent."}`)
			return
		}
		_, _ = io.WriteString(w, `{"algoId":`+id+`,"code":"200","msg":"success"}`)
		return
	}
	if method != http.MethodPost {
		f.t.Errorf("algo method %s", method)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if values.Get("algoType") != "CONDITIONAL" {
		f.t.Errorf("algoType %#v", values)
	}
	switch values.Get("type") {
	case "STOP_MARKET", "TAKE_PROFIT_MARKET":
		if values.Get("closePosition") != "true" || values.Get("reduceOnly") != "" || values.Get("quantity") != "" {
			f.t.Errorf("protection %#v", values)
		}
		if values.Get("workingType") != "MARK_PRICE" || values.Get("triggerPrice") == "" || values.Get("stopPrice") != "" {
			f.t.Errorf("trigger %#v", values)
		}
		if values.Get("type") == "TAKE_PROFIT_MARKET" && f.failTake {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"code":-2021,"msg":"Order would immediately trigger."}`)
			return
		}
		if f.dual {
			if values.Get("positionSide") == "" {
				f.t.Errorf("hedge algo missing positionSide %#v", values)
			}
		} else if values.Get("positionSide") != "" {
			f.t.Errorf("one-way algo sent positionSide %#v", values)
		}
		f.algoSeq++
		f.algos = append(f.algos, fakeAlgo{
			id: f.algoSeq, kind: values.Get("type"), posSide: values.Get("positionSide"),
			side: values.Get("side"), trigger: values.Get("triggerPrice"), closePos: values.Get("closePosition") == "true",
		})
		_, _ = io.WriteString(w, `{"algoId":`+strconv.FormatInt(f.algoSeq, 10)+`,"algoStatus":"NEW","orderType":"`+values.Get("type")+`"}`)
	default:
		f.t.Errorf("algo type %#v", values)
		w.WriteHeader(http.StatusBadRequest)
	}
}

func (f *binanceFake) checkSig(r *http.Request) {
	f.t.Helper()
	if r.Header.Get("X-MBX-APIKEY") != f.apiKey {
		f.t.Errorf("api key %q", r.Header.Get("X-MBX-APIKEY"))
	}
	payload, sig, ok := strings.Cut(r.URL.RawQuery, "&signature=")
	if !ok || strings.Contains(payload, f.secret) {
		f.t.Errorf("query %s", r.URL.RawQuery)
		return
	}
	mac := hmac.New(sha256.New, []byte(f.secret))
	_, _ = mac.Write([]byte(payload))
	if hex.EncodeToString(mac.Sum(nil)) != sig {
		f.t.Errorf("bad signature %s", r.URL.RawQuery)
	}
}

func (f *binanceFake) exchangeInfo() string {
	payload := map[string]any{
		"symbols": []any{map[string]any{
			"symbol": SymbolXRPUSDT,
			"filters": []any{
				map[string]string{"filterType": "PRICE_FILTER", "tickSize": f.tick},
				map[string]string{"filterType": "LOT_SIZE", "minQty": f.minQty, "stepSize": f.step},
				map[string]string{"filterType": "MARKET_LOT_SIZE", "minQty": f.minQty, "stepSize": f.step},
				map[string]string{"filterType": "MIN_NOTIONAL", "notional": f.minNot},
			},
		}},
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func (f *binanceFake) positionJSON() string {
	side := f.posSide
	if side == "" {
		side = "BOTH"
	}
	return `[{"symbol":"XRPUSDT","positionAmt":"` + formatQty(f.pos) + `","entryPrice":"` + strconv.FormatFloat(f.entry, 'f', 4, 64) + `","positionSide":"` + side + `"}]`
}

func (f *binanceFake) algoOrdersJSON() string {
	items := make([]string, 0, len(f.algos))
	for _, order := range f.algos {
		extra := ""
		if order.posSide != "" {
			extra += `,"positionSide":"` + order.posSide + `"`
		}
		if order.side != "" {
			extra += `,"side":"` + order.side + `"`
		}
		if order.trigger != "" {
			extra += `,"triggerPrice":"` + order.trigger + `"`
		}
		closePos := "false"
		if order.closePos {
			closePos = "true"
		}
		items = append(items, `{"algoId":`+strconv.FormatInt(order.id, 10)+`,"symbol":"XRPUSDT","orderType":"`+order.kind+`","algoStatus":"NEW","closePosition":`+closePos+extra+`}`)
	}
	return "[" + strings.Join(items, ",") + "]"
}

func (f *binanceFake) limitOrder(w http.ResponseWriter, values url.Values) {
	if values.Get("timeInForce") != "GTX" || values.Get("closePosition") != "" || values.Get("price") == "" || values.Get("quantity") == "" {
		f.t.Errorf("maker take %#v", values)
	}
	if f.dual {
		if values.Get("positionSide") == "" || values.Get("reduceOnly") != "" {
			f.t.Errorf("hedge maker take %#v", values)
		}
	} else if values.Get("reduceOnly") != "true" || values.Get("positionSide") != "" {
		f.t.Errorf("one-way maker take %#v", values)
	}
	if f.failTake {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"code":-5022,"msg":"Due to the order could not be executed as maker, the Post Only order will be rejected. The order will not be recorded in the order history"}`)
		return
	}
	f.orderSeq++
	f.limits = append(f.limits, fakeLimit{
		id: f.orderSeq, symbol: values.Get("symbol"), side: values.Get("side"), posSide: values.Get("positionSide"),
		price: values.Get("price"), orig: values.Get("quantity"), executed: "0",
		reduceOnly: values.Get("reduceOnly") == "true",
	})
	_, _ = io.WriteString(w, `{"orderId":`+strconv.FormatInt(f.orderSeq, 10)+`,"status":"NEW","type":"LIMIT","timeInForce":"GTX","price":"`+values.Get("price")+`","origQty":"`+values.Get("quantity")+`","executedQty":"0"}`)
}

func (f *binanceFake) limitsJSON() string {
	if len(f.limits) == 0 {
		return "[]"
	}
	items := make([]string, 0, len(f.limits))
	for _, order := range f.limits {
		executed := order.executed
		if executed == "" {
			executed = "0"
		}
		status := "NEW"
		if parseNum(executed) > 0 {
			status = "PARTIALLY_FILLED"
		}
		reduce := "false"
		if order.reduceOnly {
			reduce = "true"
		}
		items = append(items, `{"orderId":`+strconv.FormatInt(order.id, 10)+`,"symbol":"`+order.symbol+`","status":"`+status+`","type":"LIMIT","timeInForce":"GTX","side":"`+order.side+`","positionSide":"`+order.posSide+`","price":"`+order.price+`","origQty":"`+order.orig+`","executedQty":"`+executed+`","reduceOnly":`+reduce+`}`)
	}
	return "[" + strings.Join(items, ",") + "]"
}

func (f *binanceFake) entrySide() string {
	if f.pendingSide != "" {
		return f.pendingSide
	}
	return "BUY"
}

func (f *binanceFake) orderJSON(status, id, qty string) string {
	return `{"orderId":` + id + `,"status":"` + status + `","avgPrice":"1.5000","executedQty":"` + qty + `","side":"BUY"}`
}

func (f *binanceFake) snapshot() []recordedCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]recordedCall, len(f.calls))
	copy(out, f.calls)
	return out
}

func (f *binanceFake) count(method, path, orderType string) int {
	n := 0
	for _, call := range f.snapshot() {
		if call.method == method && call.path == path && (orderType == "" || call.values.Get("type") == orderType) {
			n++
		}
	}
	return n
}

func (f *binanceFake) assertEntrySequence(t *testing.T) {
	t.Helper()
	var qty float64
	sawInfo, sawMargin, sawLeverage, sawQuery := false, false, false, false
	for _, call := range f.snapshot() {
		switch call.path {
		case "/fapi/v1/exchangeInfo":
			sawInfo = true
		case "/fapi/v1/marginType":
			if !sawInfo {
				t.Fatal("margin before exchangeInfo")
			}
			sawMargin = true
		case "/fapi/v1/leverage":
			if !sawMargin {
				t.Fatal("leverage before margin")
			}
			sawLeverage = true
		case "/fapi/v1/order":
			if call.method == http.MethodGet {
				sawQuery = true
				continue
			}
			if call.values.Get("type") != "MARKET" {
				continue
			}
			if !sawLeverage {
				t.Fatal("market before leverage")
			}
			qty = parseNum(call.values.Get("quantity"))
			if call.values.Get("side") != "BUY" || call.values.Get("reduceOnly") != "" {
				t.Fatalf("entry %#v", call.values)
			}
			if mathMod(qty, parseNum(f.step)) > 1e-8 {
				t.Fatalf("qty %v is not on step %s", qty, f.step)
			}
			if qty*1+1e-9 < parseNum(f.minNot) && qty <= 0 {
				t.Fatalf("qty %v", qty)
			}
		}
	}
	if !sawInfo || !sawMargin || !sawLeverage || !sawQuery || !f.queried {
		t.Fatalf("sequence info=%v margin=%v leverage=%v query=%v calls=%#v", sawInfo, sawMargin, sawLeverage, sawQuery, f.snapshot())
	}
	if f.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 || f.count("POST", "/fapi/v1/order", "LIMIT") != 1 {
		t.Fatal("missing protection orders")
	}
	if f.count("POST", "/fapi/v1/algoOrder", "TAKE_PROFIT_MARKET") != 0 {
		t.Fatal("take profit used the algo endpoint")
	}
	if f.count("POST", "/fapi/v1/order", "MARKET") < 1 {
		t.Fatal("market entry left the classic order endpoint")
	}
}

func mathMod(qty, step float64) float64 {
	if step <= 0 {
		return 0
	}
	n := qty / step
	return (n - float64(int(n+1e-9))) * step
}

func formatQty(qty float64) string {
	return strconv.FormatFloat(qty, 'f', 1, 64)
}

func absQty(qty float64) float64 {
	if qty < 0 {
		return -qty
	}
	return qty
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
