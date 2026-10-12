package trading

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseDeskReads(t *testing.T) {
	bars, err := parseKlines([]byte(`[[1499040000000,"0.50","0.55","0.48","0.52","100"]]`))
	if err != nil || len(bars) != 1 || bars[0].Close != 0.52 || bars[0].Open != 0.50 {
		t.Fatalf("klines %+v err=%v", bars, err)
	}
	mark, err := parseMarkPrice([]byte(`{"symbol":"XRPUSDT","markPrice":"0.5300"}`))
	if err != nil || mark != 0.53 {
		t.Fatalf("mark %v err=%v", mark, err)
	}
	flat, err := parsePositionRisk("XRPUSDT", []byte(`[{"symbol":"XRPUSDT","positionAmt":"0","entryPrice":"0","leverage":"3","marginType":"isolated","positionSide":"BOTH"}]`))
	if err != nil || flat.Open {
		t.Fatalf("flat %+v err=%v", flat, err)
	}
	held, err := parsePositionRisk("XRPUSDT", []byte(`[{"symbol":"XRPUSDT","positionAmt":"-10","entryPrice":"0.50","markPrice":"0.47","unRealizedProfit":"0.30","leverage":"3","isolatedMargin":"1.70","marginType":"isolated","positionSide":"SHORT"}]`))
	if err != nil || !held.Open || held.Side != SideShort || held.Qty != 10 || held.EntryPrice != 0.5 || held.MarkPrice != 0.47 || held.UnrealizedPnl != 0.3 || held.Leverage != 3 || held.Margin != 1.7 || held.MarginMode != MarginIsolated {
		t.Fatalf("held %+v err=%v", held, err)
	}
	orders, err := parseOpenOrders([]byte(`[{"orderId":11,"symbol":"XRPUSDT","status":"NEW","type":"LIMIT","side":"BUY","price":"0.49","origQty":"10"}]`))
	if err != nil || len(orders) != 1 || orders[0].Kind != OrderKindEntry || orders[0].Source != OrderSourceBook || orders[0].ID != "11" || orders[0].Side != "buy" || orders[0].Status != "new" {
		t.Fatalf("orders %+v err=%v", orders, err)
	}
	algos, err := parseAlgoOrders([]byte(`[
		{"algoId":21,"symbol":"XRPUSDT","algoStatus":"NEW","orderType":"STOP_MARKET","side":"SELL","triggerPrice":"0.48","closePosition":true},
		{"algoId":22,"symbol":"XRPUSDT","algoStatus":"NEW","orderType":"TAKE_PROFIT_MARKET","side":"SELL","triggerPrice":"0.56","closePosition":true}
	]`))
	if err != nil || len(algos) != 2 || algos[0].Kind != OrderKindStop || algos[1].Kind != OrderKindTake || algos[0].StopPrice != 0.48 || !algos[0].ClosePosition {
		t.Fatalf("algos %+v err=%v", algos, err)
	}
	empty, err := parseAlgoOrders([]byte(`{"orders":[]}`))
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty algo %+v err=%v", empty, err)
	}
}

func TestDeskBookIsReadOnlyAndKeepsLiveGate(t *testing.T) {
	t.Setenv("TRADING_TESTNET_GREEN", "")
	ResetForTest()
	if TestnetGreen() {
		t.Fatal("live gate opened")
	}
	book, err := NewDeskBook(ModeLive)
	if err != nil {
		t.Fatal(err)
	}
	client := book.(*USDMClient)
	if client.BaseURL() != BinanceUSDMLiveBase || !client.readOnly {
		t.Fatalf("base %s readOnly %v", client.BaseURL(), client.readOnly)
	}
	if _, err := client.PlaceEntry(EntryOrder{Symbol: SymbolXRPUSDT, Side: SideLong, Qty: 1, Price: 1, Leverage: 3, MarginMode: MarginIsolated}); !errors.Is(err, ErrLiveTransportDisabled) {
		t.Fatalf("place entry err=%v", err)
	}
	if err := client.UseReadCredentials(Credentials{APIKey: "k", APISecret: "s", Network: ModeTestnet}); !errors.Is(err, ErrKeyNotUsable) {
		t.Fatalf("testnet key on live book err=%v", err)
	}
	if _, err := NewExchange(Config{Mode: ModeLive}); !errors.Is(err, ErrLiveGateClosed) {
		t.Fatalf("live exchange err=%v", err)
	}
	if TestnetGreen() {
		t.Fatal("read path flipped the gate")
	}
}

func TestDeskBookReadsPublicAndSignedWithoutLoggingSecrets(t *testing.T) {
	const apiKey = "desk-api-key-0123456789"
	const apiSecret = "desk-api-secret-abcdef"
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if strings.Contains(r.URL.RawQuery, apiSecret) || strings.Contains(r.Header.Get("X-MBX-APIKEY"), apiSecret) {
			t.Errorf("secret leaked onto the wire header or query")
		}
		switch r.URL.Path {
		case "/fapi/v1/klines":
			if r.Header.Get("X-MBX-APIKEY") != "" || strings.Contains(r.URL.RawQuery, "signature=") {
				t.Errorf("public kline was signed: %s", r.URL.RawQuery)
			}
			if r.URL.Query().Get("symbol") != "XRPUSDT" || r.URL.Query().Get("interval") != "5m" || r.URL.Query().Get("limit") != "100" {
				t.Errorf("kline query %s", r.URL.RawQuery)
			}
			_, _ = io.WriteString(w, `[[1499040000000,"0.50","0.55","0.48","0.52","1"]]`)
		case "/fapi/v1/premiumIndex":
			_, _ = io.WriteString(w, `{"markPrice":"0.53"}`)
		case "/fapi/v2/positionRisk":
			if r.Header.Get("X-MBX-APIKEY") != apiKey || !strings.Contains(r.URL.RawQuery, "signature=") {
				t.Errorf("position was not signed")
			}
			_, _ = io.WriteString(w, `[{"symbol":"XRPUSDT","positionAmt":"0","positionSide":"BOTH"}]`)
		case "/fapi/v1/openOrders":
			_, _ = io.WriteString(w, `[]`)
		case "/fapi/v1/openAlgoOrders":
			_, _ = io.WriteString(w, `{"orders":[{"algoId":9,"orderType":"STOP_MARKET","side":"SELL","algoStatus":"NEW","triggerPrice":"0.4","closePosition":true}]}`)
		default:
			if r.Method != http.MethodGet {
				t.Errorf("read client sent %s %s", r.Method, r.URL.Path)
			}
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewUSDMClient(server.URL)
	client.readOnly = true
	if _, err := client.do(http.MethodPost, "/fapi/v1/order", nil, Credentials{}); !errors.Is(err, ErrLiveTransportDisabled) {
		t.Fatalf("post err=%v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("rejected post still dialed: %v", calls)
	}
	bars, err := client.Klines("xrpusdt", "5m", 0)
	if err != nil || len(bars) != 1 || bars[0].Close != 0.52 {
		t.Fatalf("klines %+v err=%v", bars, err)
	}
	mark, err := client.MarkPrice("XRPUSDT")
	if err != nil || mark != 0.53 {
		t.Fatalf("mark %v err=%v", mark, err)
	}
	if err := client.UseReadCredentials(Credentials{APIKey: apiKey, APISecret: apiSecret, Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	pos, err := client.PositionRisk("XRPUSDT")
	if err != nil || pos.Open {
		t.Fatalf("position %+v err=%v", pos, err)
	}
	orders, err := client.OpenOrders("XRPUSDT")
	if err != nil || len(orders) != 0 {
		t.Fatalf("orders %+v err=%v", orders, err)
	}
	algos, err := client.OpenAlgoOrders("XRPUSDT")
	if err != nil || len(algos) != 1 || algos[0].Kind != OrderKindStop {
		t.Fatalf("algos %+v err=%v", algos, err)
	}
	for _, call := range calls {
		if !strings.HasPrefix(call, http.MethodGet+" ") {
			t.Fatalf("non-get call %s", call)
		}
	}
	server.Close()
	_, err = client.Klines("XRPUSDT", "5m", 10)
	if err == nil || strings.Contains(err.Error(), "://") || strings.Contains(strings.ToLower(err.Error()), "signature") || strings.Contains(err.Error(), apiSecret) {
		t.Fatalf("redacted err=%v", err)
	}
}
