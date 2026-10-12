package trading

import (
	"bytes"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProtectionAckDoesNotDuplicateWhenListIsEmpty(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.emptyAfterPlace = 1
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
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 || fake.count("POST", "/fapi/v1/order", "LIMIT") != 1 {
		t.Fatalf("duplicated protection %#v", fake.snapshot())
	}
	if fake.emptyAfterPlace != 0 {
		t.Fatal("verification did not re-read open algo orders")
	}
}

func TestStaleStopIsReplacedOnEntry(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.algos = []fakeAlgo{{
		id: 7, kind: "STOP_MARKET", side: "SELL", trigger: "0.5000", closePos: true,
	}}
	fake.algoSeq = 7
	server := httptest.NewServer(fake)
	defer server.Close()

	client := NewUSDMClient(server.URL)
	eng := NewEngine(testConfig(), client, DiscardLogger())
	eng.SetSecrets(func() (Credentials, error) {
		return Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}, nil
	})
	now := time.Date(2026, 10, 12, 7, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || snap.Side != SideLong {
		t.Fatalf("after entry %+v", snap)
	}
	if !StopWithinLiquidation(snap.Side, snap.EntryPrice, snap.StopPrice, snap.LiqPrice) {
		t.Fatalf("new stop is not before liquidation %+v", snap)
	}

	canceled := false
	newStop := ""
	for _, call := range fake.snapshot() {
		if call.method == http.MethodDelete && call.path == "/fapi/v1/algoOrder" && call.values.Get("algoId") == "7" {
			canceled = true
		}
		if call.method == http.MethodPost && call.path == "/fapi/v1/algoOrder" && call.values.Get("type") == "STOP_MARKET" {
			if !canceled {
				t.Fatal("fresh stop was posted before the stale stop was canceled")
			}
			if call.values.Get("closePosition") != "true" || call.values.Get("side") != "SELL" {
				t.Fatalf("fresh stop %#v", call.values)
			}
			newStop = call.values.Get("triggerPrice")
		}
	}
	if newStop == "" || newStop == "0.5000" {
		t.Fatalf("replacement trigger %q", newStop)
	}
	posted := parseNum(newStop)
	if math.Abs(posted-0.5) <= parseNum(fake.tick) {
		t.Fatalf("replacement trigger %s is still the stale price", newStop)
	}
	if math.Abs(posted-snap.StopPrice) > parseNum(fake.tick) {
		t.Fatalf("posted %s engine stop %v", newStop, snap.StopPrice)
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 || fake.count("POST", "/fapi/v1/order", "LIMIT") != 1 {
		t.Fatalf("protection posts stop=%d take=%d", fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET"), fake.count("POST", "/fapi/v1/order", "LIMIT"))
	}
	fake.mu.Lock()
	var stops []fakeAlgo
	for _, order := range fake.algos {
		if order.kind == "STOP_MARKET" {
			stops = append(stops, order)
		}
	}
	fake.mu.Unlock()
	if len(stops) != 1 || stops[0].id == 7 || stops[0].trigger != newStop || !stops[0].closePos {
		t.Fatalf("open stops %+v", stops)
	}

	held, err := eng.Step(stepAt(now.Add(time.Minute), candles, snap.EntryPrice, 2))
	if err != nil || held.State != StateInPosition {
		t.Fatalf("hold %+v err=%v", held, err)
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 1 || fake.count("POST", "/fapi/v1/order", "LIMIT") != 1 {
		t.Fatal("holding the new position placed a second protection set")
	}
}

func TestStopWithinOneTickIsReused(t *testing.T) {
	fake := newBinanceFake(t, "0.1", "0.1", "0.0001", "5")
	fake.pos = 10
	fake.entry = 1.5
	tick := parseNum(fake.tick)
	stop := roundToTick(1.4, tick)
	fake.algos = []fakeAlgo{{
		id: 3, kind: "STOP_MARKET", side: "SELL",
		trigger: formatStep(stop+tick, 0, fake.tick), closePos: true,
	}}
	fake.algoSeq = 3
	server := httptest.NewServer(fake)
	defer server.Close()
	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: fake.apiKey, APISecret: fake.secret, Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	if err := client.PlaceProtection(Protection{Symbol: SymbolXRPUSDT, Side: SideLong, Stop: stop, Take: 1.6}); err != nil {
		t.Fatal(err)
	}
	if fake.count("DELETE", "/fapi/v1/algoOrder", "") != 0 {
		t.Fatal("a stop within one tick was canceled")
	}
	if fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET") != 0 || fake.count("POST", "/fapi/v1/order", "LIMIT") != 1 {
		t.Fatalf("stop posts=%d take posts=%d", fake.count("POST", "/fapi/v1/algoOrder", "STOP_MARKET"), fake.count("POST", "/fapi/v1/order", "LIMIT"))
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.algos) != 1 || fake.algos[0].id != 3 || !fake.algos[0].closePos {
		t.Fatalf("algos %+v", fake.algos)
	}
	if len(fake.limits) != 1 || !fake.limits[0].reduceOnly || fake.limits[0].price == "" {
		t.Fatalf("limits %+v", fake.limits)
	}
}

func TestEnsureProtectionRetriesThenFlattens(t *testing.T) {
	prev := protectionRetryGap
	protectionRetryGap = 0
	t.Cleanup(func() { protectionRetryGap = prev })
	ResetBoostForTest()
	t.Cleanup(ResetBoostForTest)
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	ex := &flakyProtect{Paper: NewPaper()}
	eng := withSecrets(NewEngine(testConfig(), ex, DiscardLogger()))
	now := time.Date(2026, 10, 12, 5, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err == nil {
		t.Fatal("expected protection failure")
	}
	if ex.places != protectionAttempts || ex.closes != 1 {
		t.Fatalf("places=%d closes=%d", ex.places, ex.closes)
	}
	if snap.State != StateError || snap.LastReason != ReasonProtectiveOrdersFailed {
		t.Fatalf("%+v", snap)
	}
	text := logs.String()
	for _, part := range []string{"status=400", "code=-2021", "Order would immediately trigger.", `{"code":-2021,"msg":"Order would immediately trigger."}`} {
		if !strings.Contains(text, part) {
			t.Fatalf("log missing %q\n%s", part, text)
		}
	}
	found := false
	for _, ev := range RecentEvents() {
		if ev.Action != "error" {
			continue
		}
		ok := true
		for _, part := range []string{"status=400", "code=-2021", "Order would immediately trigger.", "body="} {
			if !strings.Contains(ev.Msg, part) {
				ok = false
			}
		}
		if ok {
			found = true
		}
	}
	if !found {
		t.Fatalf("events %+v", RecentEvents())
	}
}

func TestEnsureProtectionKeepsStopBeforeLiquidation(t *testing.T) {
	prev := protectionRetryGap
	protectionRetryGap = 0
	t.Cleanup(func() { protectionRetryGap = prev })
	ex := &flakyProtect{Paper: NewPaper()}
	eng := NewEngine(testConfig(), ex, DiscardLogger())
	err := eng.ensureProtection(SideLong, 1, 0.5, 1.2, 0.9)
	if err == nil || ex.places != 0 {
		t.Fatalf("places=%d err=%v", ex.places, err)
	}
	err = eng.ensureProtection(SideShort, 0.0851, 0.0852, 0.084, 0.09)
	if err == nil || ex.places != protectionAttempts {
		t.Fatalf("retry places=%d err=%v", ex.places, err)
	}
}

func TestHedgeShortAlgoParamsRoundToTick(t *testing.T) {
	var posts []url.Values
	var takes []url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		switch r.URL.Path {
		case "/fapi/v1/exchangeInfo":
			_, _ = io.WriteString(w, `{"symbols":[{"symbol":"DOGEUSDT","filters":[
				{"filterType":"PRICE_FILTER","tickSize":"0.00001"},
				{"filterType":"LOT_SIZE","minQty":"1","stepSize":"1"},
				{"filterType":"MIN_NOTIONAL","notional":"5"}
			]}]}`)
		case "/fapi/v2/positionRisk":
			_, _ = io.WriteString(w, `[{"symbol":"DOGEUSDT","positionAmt":"-399","entryPrice":"0.08510","positionSide":"SHORT"}]`)
		case "/fapi/v1/positionSide/dual":
			_, _ = io.WriteString(w, `{"dualSidePosition":true}`)
		case "/fapi/v1/openAlgoOrders":
			if len(posts) == 0 {
				_, _ = io.WriteString(w, `[]`)
				return
			}
			items := make([]string, 0, len(posts))
			for i, post := range posts {
				items = append(items, `{"algoId":`+strconv.Itoa(i+1)+`,"symbol":"DOGEUSDT","orderType":"`+post.Get("type")+`","side":"`+post.Get("side")+`","positionSide":"`+post.Get("positionSide")+`","triggerPrice":"`+post.Get("triggerPrice")+`","closePosition":true}`)
			}
			_, _ = io.WriteString(w, `[`+strings.Join(items, ",")+`]`)
		case "/fapi/v1/openOrders":
			if len(takes) == 0 {
				_, _ = io.WriteString(w, `[]`)
				return
			}
			items := make([]string, 0, len(takes))
			for i, post := range takes {
				items = append(items, `{"orderId":`+strconv.Itoa(i+1)+`,"symbol":"DOGEUSDT","type":"LIMIT","timeInForce":"GTX","side":"`+post.Get("side")+`","positionSide":"`+post.Get("positionSide")+`","price":"`+post.Get("price")+`","origQty":"`+post.Get("quantity")+`","executedQty":"0","reduceOnly":false}`)
			}
			_, _ = io.WriteString(w, `[`+strings.Join(items, ",")+`]`)
		case "/fapi/v1/algoOrder":
			posts = append(posts, cloneValues(q))
			_, _ = io.WriteString(w, `{"algoId":`+strconv.Itoa(len(posts))+`,"algoStatus":"NEW"}`)
		case "/fapi/v1/order":
			takes = append(takes, cloneValues(q))
			_, _ = io.WriteString(w, `{"orderId":`+strconv.Itoa(len(takes))+`,"status":"NEW"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := NewUSDMClient(server.URL)
	if err := client.UseCredentials(Credentials{APIKey: "key", APISecret: "secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	if err := client.PlaceProtection(Protection{Symbol: "DOGEUSDT", Side: SideShort, Stop: 0.085903, Take: 0.084007}); err != nil {
		t.Fatal(err)
	}
	if len(posts) != 1 || len(takes) != 1 {
		t.Fatalf("stops %d takes %d", len(posts), len(takes))
	}
	stop := posts[0]
	if stop.Get("algoType") != "CONDITIONAL" || stop.Get("type") != "STOP_MARKET" || stop.Get("side") != "BUY" || stop.Get("positionSide") != "SHORT" || stop.Get("closePosition") != "true" || stop.Get("workingType") != "MARK_PRICE" {
		t.Fatalf("stop %#v", stop)
	}
	if stop.Get("quantity") != "" || stop.Get("reduceOnly") != "" || stop.Get("triggerPrice") != "0.08590" {
		t.Fatalf("stop tick %#v", stop)
	}
	take := takes[0]
	if take.Get("type") != "LIMIT" || take.Get("timeInForce") != "GTX" || take.Get("side") != "BUY" || take.Get("positionSide") != "SHORT" || take.Get("reduceOnly") != "" || take.Get("closePosition") != "" {
		t.Fatalf("take %#v", take)
	}
	if take.Get("price") != "0.08401" || take.Get("quantity") != "399" {
		t.Fatalf("take tick %#v", take)
	}
}

func TestBoostEndSaysOpenedThenFlattened(t *testing.T) {
	prev := protectionRetryGap
	protectionRetryGap = 0
	t.Cleanup(func() { protectionRetryGap = prev })
	ResetTestnetGreen()
	SetTestnetGreen(true)
	ResetBoostForTest()
	t.Cleanup(func() {
		ResetTestnetGreen()
		ResetBoostForTest()
	})
	now := time.Date(2026, 10, 12, 6, 0, 0, 0, time.UTC)
	GrantBoost(now)
	ex := &flakyProtect{Paper: NewPaper()}
	cfg := testConfig()
	cfg.Mode = ModeLive
	cfg.ID = 44
	cfg.Symbol = "DOGEUSDT"
	eng := withSecrets(NewEngine(cfg, ex, DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	in := passingStep(now, candles, candles[len(candles)-1].Close, 0.8)
	in.LivePeerIDs = []int64{44}
	snap, err := eng.Step(in)
	if err == nil || snap.LastReason != ReasonProtectiveOrdersFailed || ex.closes != 1 || ex.places != protectionAttempts {
		t.Fatalf("snap %+v places=%d closes=%d err=%v", snap, ex.places, ex.closes, err)
	}
	if !emitBoostEnd(now.Add(BoostWindow)) {
		t.Fatal("missing boost end")
	}
	last := RecentEvents()[len(RecentEvents())-1]
	if last.Action != "boost_end" || last.Msg != "opened then flattened ("+ReasonProtectiveOrdersFailed+")" {
		t.Fatalf("%+v", last)
	}
}

type flakyProtect struct {
	*Paper
	places int
	closes int
}

func (f *flakyProtect) PlaceProtection(Protection) error {
	f.places++
	return &ExchangeError{
		Status: 400,
		Code:   -2021,
		Msg:    "Order would immediately trigger.",
		Body:   `{"code":-2021,"msg":"Order would immediately trigger."}`,
	}
}

func (f *flakyProtect) Close(req CloseOrder) (Fill, error) {
	f.closes++
	return f.Paper.Close(req)
}
