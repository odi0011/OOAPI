package trading

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
gridSpotFake 是网格用到的全部现货端点：交易对规则、挂单、查单、撤单、余额。

每个端点回什么都可以单独设，而且**记下收到的请求** —— 这一层最容易出的错
不是解析，是"发出去的参数不对"（挂成市价、方向反了、数量没对齐），
那些只有回看请求才能发现。
*/
type gridSpotFake struct {
	calls []spotCall

	orderBody   string // POST /api/v3/order
	orderStatus int
	openBody    string // GET /api/v3/openOrders
	queryBody   string // GET /api/v3/order
	queryStatus int
	cancelBody  string
	cancelCode  int
	balances    string
}

func (f *gridSpotFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls = append(f.calls, spotCall{method: r.Method, path: r.URL.Path, query: r.URL.Query()})
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/api/v3/exchangeInfo":
		_, _ = w.Write([]byte(spotTradeRules))
	case r.URL.Path == "/api/v3/account":
		body := f.balances
		if body == "" {
			body = `{"balances":[]}`
		}
		_, _ = w.Write([]byte(body))
	case r.URL.Path == "/api/v3/openOrders" && r.Method == http.MethodGet:
		body := f.openBody
		if body == "" {
			body = `[]`
		}
		_, _ = w.Write([]byte(body))
	case r.URL.Path == "/api/v3/order" && r.Method == http.MethodPost:
		if f.orderStatus >= 300 {
			w.WriteHeader(f.orderStatus)
		}
		_, _ = w.Write([]byte(f.orderBody))
	case r.URL.Path == "/api/v3/order" && r.Method == http.MethodGet:
		if f.queryStatus >= 300 {
			w.WriteHeader(f.queryStatus)
		}
		_, _ = w.Write([]byte(f.queryBody))
	case r.URL.Path == "/api/v3/order" && r.Method == http.MethodDelete:
		if f.cancelCode != 0 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":` + strconvItoa(f.cancelCode) + `,"msg":"Unknown order sent."}`))
			return
		}
		body := f.cancelBody
		if body == "" {
			body = `{}`
		}
		_, _ = w.Write([]byte(body))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":-1121,"msg":"Invalid symbol."}`))
	}
}

func newGridSpotClient(t *testing.T, fake *gridSpotFake) (*USDMClient, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	c := NewUSDMClient(server.URL)
	if err := c.UseCredentials(Credentials{APIKey: "gk", APISecret: "gs", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	return c, server
}

// lastCall 找出最后一次打到某个路径的请求。找不到时给出全部调用便于排错。
func (f *gridSpotFake) lastCall(method, path string) spotCall {
	var found spotCall
	ok := false
	for _, c := range f.calls {
		if c.method == method && c.path == path {
			found, ok = c, true
		}
	}
	if !ok {
		panic("没有 " + method + " " + path + " 的调用，实际调用：" + formatCalls(f.calls))
	}
	return found
}

func formatCalls(calls []spotCall) string {
	parts := make([]string, 0, len(calls))
	for _, c := range calls {
		parts = append(parts, c.method+" "+c.path)
	}
	return strings.Join(parts, ", ")
}

/*
挂单必须是 **LIMIT_MAKER**，而且不能带 timeInForce。

理由是这个模块的收益结构：网格赚的是买卖价差，价差的一部分要交给手续费。
普通 LIMIT 在行情快速移动时会以 taker 身份立刻成交 —— 那一格我们就成了
追价的人，成交价比计划里算的差，而界面上完全看不出来。

LIMIT_MAKER（只做 maker）会把任何会立即成交的挂单直接拒掉，
于是"价格跑掉了"表现为一次干净的失败，下一拍重挂即可。
*/
func TestPlaceSpotLimitUsesMakerOrder(t *testing.T) {
	fake := &gridSpotFake{orderBody: `{"orderId":7,"status":"NEW","price":"0.07700","origQty":"13","executedQty":"0","cummulativeQuoteQty":"0"}`}
	c, _ := newGridSpotClient(t, fake)

	state, err := c.PlaceSpotLimit("DOGEUSDT", SpotBuy, 13, 0.07700, "oo-grid-1-1")
	if err != nil {
		t.Fatal(err)
	}
	if state.OrderID != 7 || state.Status != SpotStatusNew {
		t.Fatalf("订单状态没解析对: %+v", state)
	}

	call := fake.lastCall(http.MethodPost, "/api/v3/order")
	if got := call.query.Get("type"); got != SpotTypeLimitMaker {
		t.Fatalf("type=%q 必须是 %s —— 用普通 LIMIT 会以 taker 身份追价", got, SpotTypeLimitMaker)
	}
	if got := call.query.Get("timeInForce"); got != "" {
		t.Fatalf("LIMIT_MAKER 不接受 timeInForce，却发了 %q", got)
	}
	if got := call.query.Get("side"); got != "BUY" {
		t.Fatalf("side=%q", got)
	}
	if got := call.query.Get("quantity"); got != "13" {
		t.Fatalf("quantity=%q 期望 13", got)
	}
	if got := call.query.Get("price"); got != "0.07700" {
		t.Fatalf("price=%q 期望 0.07700", got)
	}
	if got := call.query.Get("newClientOrderId"); got != "oo-grid-1-1" {
		t.Fatalf("客户单号没带上: %q", got)
	}
}

/*
数量向下取整到步长、价格向下取整到精度，**且方向是"向下"**。

向下而不是四舍五入：买单取整后价格更低（更保守），数量更少（更省），
两者都不会让名义价值意外冲到账户撑不住的地方。现货 DOGE 的步长是 1，
挂 13.9 个会被币安以精度错误拒掉。
*/
func TestPlaceSpotLimitAlignsQtyAndPriceDown(t *testing.T) {
	fake := &gridSpotFake{orderBody: `{"orderId":8,"status":"NEW"}`}
	c, _ := newGridSpotClient(t, fake)

	if _, err := c.PlaceSpotLimit("DOGEUSDT", SpotBuy, 13.9, 0.07700999, "x"); err != nil {
		t.Fatal(err)
	}
	call := fake.lastCall(http.MethodPost, "/api/v3/order")
	if got := call.query.Get("quantity"); got != "13" {
		t.Fatalf("数量应向下取到 13，得到 %q", got)
	}
	if got := call.query.Get("price"); got != "0.07700" {
		t.Fatalf("价格应向下取到 0.07700（不是四舍五入的 0.07701），得到 %q", got)
	}
}

// 取整之后名义价值掉到交易所下限之下时**不发请求**：
// 发出去只会拿到 -1013，而那个错误码看不出是"钱不够"还是"单太小"。
func TestPlaceSpotLimitRejectsNotionalBelowMinAfterAlign(t *testing.T) {
	fake := &gridSpotFake{orderBody: `{"orderId":9,"status":"NEW"}`}
	c, _ := newGridSpotClient(t, fake)

	// DOGE 最小名义 1 USDT，13 个 × 0.00001 = 0.00013 USDT，远低于下限。
	_, err := c.PlaceSpotLimit("DOGEUSDT", SpotBuy, 13, 0.00001, "x")
	if err == nil {
		t.Fatal("名义价值低于下限必须被拒")
	}
	if !errors.Is(err, ErrNotionalBelowMin) {
		t.Fatalf("应是 ErrNotionalBelowMin，得到 %v", err)
	}
	for _, call := range fake.calls {
		if call.path == "/api/v3/order" && call.method == http.MethodPost {
			t.Fatal("本地就该拒掉，不该发请求")
		}
	}
}

func TestPlaceSpotLimitRejectsBadInput(t *testing.T) {
	fake := &gridSpotFake{orderBody: `{"orderId":1,"status":"NEW"}`}
	c, _ := newGridSpotClient(t, fake)
	for _, tt := range []struct {
		name       string
		side       SpotSide
		qty, price float64
	}{
		{"方向为空", "", 10, 0.08},
		{"方向拼错", "Long", 10, 0.08},
		{"数量为零", SpotBuy, 0, 0.08},
		{"数量为负", SpotBuy, -1, 0.08},
		{"价格为零", SpotBuy, 10, 0},
		{"价格为负", SpotBuy, 10, -0.08},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := c.PlaceSpotLimit("DOGEUSDT", tt.side, tt.qty, tt.price, "x"); err == nil {
				t.Fatal("非法入参必须被拒")
			}
		})
	}
}

// 挂单列表要能解析成数组，而且带得出方向、价格、已成交量。
func TestSpotOpenOrdersParsesList(t *testing.T) {
	fake := &gridSpotFake{openBody: `[
		{"orderId":11,"clientOrderId":"oo-grid-1-0","symbol":"DOGEUSDT","side":"BUY",
		 "type":"LIMIT_MAKER","price":"0.07700","origQty":"13.00000000",
		 "executedQty":"0","cummulativeQuoteQty":"0","status":"NEW","updateTime":1700000000000},
		{"orderId":12,"clientOrderId":"oo-grid-1-3","symbol":"DOGEUSDT","side":"SELL",
		 "type":"LIMIT_MAKER","price":"0.08200","origQty":"13.00000000",
		 "executedQty":"13.00000000","cummulativeQuoteQty":"1.06600000","status":"FILLED","updateTime":1700000001000}
	]`}
	c, _ := newGridSpotClient(t, fake)

	rows, err := c.SpotOpenOrders("DOGEUSDT")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("应解析出 2 张单，得到 %d", len(rows))
	}
	if rows[0].Side != SpotBuy || rows[1].Side != SpotSell {
		t.Fatalf("方向解析错了: %v / %v", rows[0].Side, rows[1].Side)
	}
	if rows[0].OrigQty != 13 || rows[0].Price != 0.077 {
		t.Fatalf("数量或价格解析错了: %+v", rows[0])
	}
	if !rows[0].Open() {
		t.Fatal("status=NEW 的单应算挂着")
	}
	if !rows[1].Filled() || rows[1].Open() {
		t.Fatal("status=FILLED 的单不该算挂着")
	}
	// 均价用累计成交额 / 成交量算：1.066 / 13 = 0.082。
	if got := rows[1].AvgPrice(); got != 0.082 {
		t.Fatalf("均价应是 0.082，得到 %v", got)
	}
}

/*
查单必须走 origClientOrderId，而且**不能猜**。

网格判断"上一拍挂着的单去哪了"完全依赖这一步：不在挂单列表里可能是成交了、
被撤了、也可能过期了。猜错只有一个方向 —— 把已成交当成没成交，
于是重复挂单、重复建仓。所以查不到就报错，不返回一个默认状态。
*/
func TestSpotQueryOrderUsesClientOrderId(t *testing.T) {
	fake := &gridSpotFake{queryBody: `{"orderId":21,"clientOrderId":"oo-grid-2-1","symbol":"DOGEUSDT",
		"side":"SELL","type":"LIMIT_MAKER","price":"0.08100","origQty":"13",
		"executedQty":"13","cummulativeQuoteQty":"1.05300000","status":"FILLED","updateTime":1700000002000}`}
	c, _ := newGridSpotClient(t, fake)

	state, err := c.SpotQueryOrder("DOGEUSDT", "oo-grid-2-1")
	if err != nil {
		t.Fatal(err)
	}
	if !state.Filled() || state.Side != SpotSell {
		t.Fatalf("状态没解析对: %+v", state)
	}
	call := fake.lastCall(http.MethodGet, "/api/v3/order")
	if got := call.query.Get("origClientOrderId"); got != "oo-grid-2-1" {
		t.Fatalf("应按客户单号查，得到 %q", got)
	}
	if call.query.Get("orderId") != "" {
		t.Fatal("不该同时带 orderId —— 两个都给会让币安报参数冲突")
	}
}

func TestSpotQueryOrderRequiresClientOrderId(t *testing.T) {
	fake := &gridSpotFake{}
	c, _ := newGridSpotClient(t, fake)
	if _, err := c.SpotQueryOrder("DOGEUSDT", "   "); err == nil {
		t.Fatal("缺客户单号必须被拒")
	}
	if len(fake.calls) != 0 {
		t.Fatalf("本地就该拒掉，不该发请求: %s", formatCalls(fake.calls))
	}
}

// 撤单同样按客户单号走，而且**撤一张不存在的单算成功**：
// 目标是"这张单不在了"，它本来就不在，报错只会让调用方做出多余的动作。
func TestSpotCancelByClientOrderId(t *testing.T) {
	fake := &gridSpotFake{cancelBody: `{"orderId":31,"status":"CANCELED"}`}
	c, _ := newGridSpotClient(t, fake)
	if err := c.SpotCancel("DOGEUSDT", "oo-grid-3-2"); err != nil {
		t.Fatal(err)
	}
	call := fake.lastCall(http.MethodDelete, "/api/v3/order")
	if got := call.query.Get("origClientOrderId"); got != "oo-grid-3-2" {
		t.Fatalf("撤单应按客户单号，得到 %q", got)
	}

	// -2011 = 这张单不存在。目标是撤掉它，它本来就没了。
	gone := &gridSpotFake{cancelCode: -2011}
	c2, _ := newGridSpotClient(t, gone)
	if err := c2.SpotCancel("DOGEUSDT", "oo-grid-3-3"); err != nil {
		t.Fatalf("撤一张不存在的单应算成功，得到 %v", err)
	}

	// 别的错误必须原样透出，不能被当成"撤干净了"。
	broken := &gridSpotFake{cancelCode: -1022}
	c3, _ := newGridSpotClient(t, broken)
	err := c3.SpotCancel("DOGEUSDT", "oo-grid-3-4")
	if err == nil {
		t.Fatal("签名错误必须透出 —— 当成成功会以为撤掉了，实际单还挂着")
	}
	var ex *ExchangeError
	if !errors.As(err, &ex) || ex.Code != -1022 {
		t.Fatalf("应保留币安错误码，得到 %v", err)
	}
}

/*
只做 maker 被拒（-2010）要能被单独认出来。

这不是故障，是网格的**正常分支**：行情在两次轮询之间跳过了这一格。
把它和"签名不对""权限不够"混在一起，要么日志被正常情况刷屏，
要么真故障被当成正常情况忽略。
*/
func TestLimitMakerRejectedRecognizesOnlyTheCrossingCase(t *testing.T) {
	crossing := &ExchangeError{Status: 400, Code: -2010,
		Msg: "Order would immediately match and take."}
	if !limitMakerRejected(crossing) {
		t.Fatal("LIMIT_MAKER 会立即成交的单必须被认出来")
	}
	other := &ExchangeError{Status: 400, Code: -2010, Msg: "Account has insufficient balance."}
	if limitMakerRejected(other) {
		t.Fatal("同样 -2010 但原因是余额不足 —— 当成正常分支会一直重试到天荒地老")
	}
	if limitMakerRejected(&ExchangeError{Code: -1022, Msg: "Signature for this request is not valid."}) {
		t.Fatal("签名错误不是正常分支")
	}
	if limitMakerRejected(nil) || limitMakerRejected(errors.New("网络断了")) {
		t.Fatal("非交易所错误不该被认成穿价")
	}
}

// 方向与反向：每一格成交后都要在对面挂一张，反向写错就是把刚买到的再买一遍。
func TestSpotSideOppositeAndValid(t *testing.T) {
	if SpotBuy.Opposite() != SpotSell || SpotSell.Opposite() != SpotBuy {
		t.Fatal("反向必须严格互换")
	}
	if SpotBuy.Opposite().Opposite() != SpotBuy {
		t.Fatal("反向两次应回到原方向")
	}
	if SpotBuy.Valid() != true || SpotSell.Valid() != true {
		t.Fatal("BUY / SELL 都是合法的")
	}
	for _, bad := range []SpotSide{"", "buy", "LONG", "SHORT", "BUY "} {
		if bad.Valid() {
			t.Fatalf("%q 不该算合法方向", bad)
		}
	}
}

// 解析币安回来的方向字符串：认不出来必须报错，不能默认成 BUY ——
// 默认成买会把一笔卖出记成买入，账就反了。
func TestSpotSideFromStringRefusesUnknown(t *testing.T) {
	if got, ok := spotSideFromString(" sell "); !ok || got != SpotSell {
		t.Fatalf("应解析成 SELL，得到 %q %v", got, ok)
	}
	for _, bad := range []string{"", "LONG", "SELLX"} {
		if _, ok := spotSideFromString(bad); ok {
			t.Fatalf("%q 不该被认出来", bad)
		}
	}
}

/*
可用余额读的是**free+locked**，不是单看 free。

locked 是被自己挂单锁住的那部分 —— 它仍然是我们的持仓。止损要清仓时
只看 free 会少卖一截，剩下的仓位就裸奔了。
*/
func TestSpotFreeQtyCountsLockedBalance(t *testing.T) {
	fake := &gridSpotFake{balances: `{"balances":[
		{"asset":"USDT","free":"12.5","locked":"0"},
		{"asset":"DOGE","free":"40.00000000","locked":"13.00000000"}
	]}`}
	c, _ := newGridSpotClient(t, fake)
	qty, err := c.SpotFreeQty("DOGEUSDT")
	if err != nil {
		t.Fatal(err)
	}
	if qty != 53 {
		t.Fatalf("可用数量应是 free+locked = 53，得到 %v（只看 free 会少卖 13 个）", qty)
	}
}

// 没有该币种时返回 0 而不是报错：空仓是正常状态，不是故障。
func TestSpotFreeQtyZeroWhenAssetAbsent(t *testing.T) {
	fake := &gridSpotFake{balances: `{"balances":[{"asset":"USDT","free":"5","locked":"0"}]}`}
	c, _ := newGridSpotClient(t, fake)
	qty, err := c.SpotFreeQty("DOGEUSDT")
	if err != nil {
		t.Fatal(err)
	}
	if qty != 0 {
		t.Fatalf("没有该币种时应是 0，得到 %v", qty)
	}
}
