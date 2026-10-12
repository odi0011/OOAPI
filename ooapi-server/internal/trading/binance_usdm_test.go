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
	if fake.count("POST", "/fapi/v1/order", "STOP_MARKET") != 1 || fake.count("POST", "/fapi/v1/order", "TAKE_PROFIT_MARKET") != 1 {
		t.Fatalf("protection replaced while holding: %#v", fake.snapshot())
	}

	closed, err := eng.Step(stepAt(now.Add(2*time.Minute), candles, snap.TakeProfitPrice+0.01, 2))
	if err != nil {
		t.Fatal(err)
	}
	if closed.State != StateArmed {
		t.Fatalf("after exit %+v", closed)
	}
	var sawCancel, sawReduce bool
	for _, call := range fake.snapshot() {
		if call.method == http.MethodDelete && call.path == "/fapi/v1/allOpenOrders" {
			sawCancel = true
		}
		if sawCancel && call.method == http.MethodPost && call.path == "/fapi/v1/order" && call.values.Get("reduceOnly") == "true" {
			sawReduce = true
			if call.values.Get("type") != "MARKET" || call.values.Get("side") != "SELL" {
				t.Fatalf("flatten %#v", call.values)
			}
		}
	}
	if !sawCancel || !sawReduce {
		t.Fatal("exit did not cancel protection and reduce the position")
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
	_, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if !errors.Is(err, ErrNotionalBelowMin) {
		t.Fatal(err)
	}
	if eng.State() != StateBlocked || eng.SecretOpens() != 0 {
		t.Fatalf("state %s opens %d", eng.State(), eng.SecretOpens())
	}
	for _, call := range fake.snapshot() {
		if call.path != "/fapi/v1/exchangeInfo" {
			t.Fatalf("unexpected call %s %s", call.method, call.path)
		}
	}
}

func TestUSDMClientRefusesLiveHostAndLiveKey(t *testing.T) {
	dialed := false
	client := NewUSDMClient(BinanceUSDMLiveBase)
	client.http.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		dialed = true
		return nil, errors.New("dialed")
	})
	if err := client.UseCredentials(Credentials{APIKey: "live-key-0123456789", APISecret: "live-secret-0123456789", Network: ModeLive}); !errors.Is(err, ErrKeyNotUsable) {
		t.Fatal(err)
	}
	if err := client.UseCredentials(Credentials{APIKey: "test-key-0123456789", APISecret: "test-secret-0123456789", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	_, err := client.PlaceEntry(EntryOrder{Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 10, Price: 1, Leverage: 3, MarginMode: MarginIsolated})
	if !errors.Is(err, ErrLiveTransportDisabled) || dialed {
		t.Fatalf("err=%v dialed=%v", err, dialed)
	}
	if NewUSDMTestnet().BaseURL() != BinanceUSDMTestnetBase {
		t.Fatal("default base")
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

type recordedCall struct {
	method string
	path   string
	values url.Values
}

type binanceFake struct {
	t       *testing.T
	apiKey  string
	secret  string
	step    string
	minQty  string
	tick    string
	minNot  string
	mu      sync.Mutex
	calls   []recordedCall
	pos     float64
	entry   float64
	orders  []string
	pending float64
	queried bool
}

func newBinanceFake(t *testing.T, step, minQty, tick, minNotional string) *binanceFake {
	t.Helper()
	return &binanceFake{
		t: t, apiKey: "test-key-0123456789", secret: "test-secret-0123456789",
		step: step, minQty: minQty, tick: tick, minNot: minNotional,
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
		if values.Get("leverage") != "3" {
			f.t.Errorf("leverage %#v", values)
		}
		_, _ = io.WriteString(w, `{"symbol":"XRPUSDT","leverage":3}`)
	case "/fapi/v1/positionSide/dual":
		_, _ = io.WriteString(w, `{"dualSidePosition":false}`)
	case "/fapi/v1/order":
		f.order(w, r.Method, values)
	case "/fapi/v2/positionRisk":
		_, _ = io.WriteString(w, f.positionJSON())
	case "/fapi/v1/openOrders":
		_, _ = io.WriteString(w, f.ordersJSON())
	case "/fapi/v1/allOpenOrders":
		f.orders = nil
		_, _ = io.WriteString(w, `{"code":200,"msg":"The operation of cancel all open order is done."}`)
	default:
		f.t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *binanceFake) order(w http.ResponseWriter, method string, values url.Values) {
	if method == http.MethodGet {
		f.queried = true
		f.pos = f.pending
		f.entry = 1.5
		_, _ = io.WriteString(w, f.orderJSON("FILLED", values.Get("orderId"), formatQty(f.pos)))
		return
	}
	switch values.Get("type") {
	case "MARKET":
		qty := parseNum(values.Get("quantity"))
		if values.Get("reduceOnly") == "true" {
			f.pos = 0
			f.orders = nil
			_, _ = io.WriteString(w, f.orderJSON("FILLED", "9", values.Get("quantity")))
			return
		}
		if values.Get("closePosition") != "" {
			f.t.Errorf("entry sent closePosition %#v", values)
		}
		f.pending = qty
		_, _ = io.WriteString(w, `{"orderId":42,"status":"NEW","avgPrice":"0","executedQty":"0","side":"BUY"}`)
	case "STOP_MARKET", "TAKE_PROFIT_MARKET":
		if values.Get("closePosition") != "true" || values.Get("reduceOnly") != "" || values.Get("quantity") != "" {
			f.t.Errorf("protection %#v", values)
		}
		if values.Get("workingType") != "MARK_PRICE" || values.Get("stopPrice") == "" {
			f.t.Errorf("stop %#v", values)
		}
		f.orders = append(f.orders, values.Get("type"))
		_, _ = io.WriteString(w, `{"orderId":7,"status":"NEW"}`)
	default:
		f.t.Errorf("order type %#v", values)
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
	return `[{"symbol":"XRPUSDT","positionAmt":"` + formatQty(f.pos) + `","entryPrice":"` + strconv.FormatFloat(f.entry, 'f', 4, 64) + `","positionSide":"BOTH"}]`
}

func (f *binanceFake) ordersJSON() string {
	items := make([]string, 0, len(f.orders))
	for _, kind := range f.orders {
		items = append(items, `{"symbol":"XRPUSDT","type":"`+kind+`","status":"NEW"}`)
	}
	return "[" + strings.Join(items, ",") + "]"
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
	if f.count("POST", "/fapi/v1/order", "STOP_MARKET") != 1 || f.count("POST", "/fapi/v1/order", "TAKE_PROFIT_MARKET") != 1 {
		t.Fatal("missing protection orders")
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

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
