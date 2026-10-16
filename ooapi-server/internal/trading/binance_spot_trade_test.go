package trading

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

type spotCall struct {
	method string
	path   string
	query  url.Values
}

// spotTradeFake 是假的现货主机：规则、余额、下单、撤单四类端点。
type spotTradeFake struct {
	calls      []spotCall
	balances   string
	orderResp  string
	cancelCode int // 非 0 时撤单返回这个币安错误码
}

const spotTradeRules = `{"symbols":[{
	"symbol":"DOGEUSDT","baseAsset":"DOGE","quoteAsset":"USDT","status":"TRADING",
	"filters":[
		{"filterType":"LOT_SIZE","minQty":"1.00000000","stepSize":"1.00000000"},
		{"filterType":"PRICE_FILTER","tickSize":"0.00001000"},
		{"filterType":"NOTIONAL","minNotional":"1.00000000"}
	]}]}`

func (f *spotTradeFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	case r.URL.Path == "/api/v3/openOrders" && r.Method == http.MethodDelete:
		if f.cancelCode != 0 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":` + strconvItoa(f.cancelCode) + `,"msg":"Unknown order sent."}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	case r.URL.Path == "/api/v3/order" && r.Method == http.MethodPost:
		body := f.orderResp
		if body == "" {
			// 币安现货把累计成交额拼成 cummulativeQuoteQty（三个 m）。
			body = `{"orderId":42,"status":"FILLED","executedQty":"60.00000000","cummulativeQuoteQty":"4.80000000"}`
		}
		_, _ = w.Write([]byte(body))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":-1121,"msg":"Invalid symbol."}`))
	}
}

func strconvItoa(v int) string {
	neg := v < 0
	if neg {
		v = -v
	}
	if v == 0 {
		return "0"
	}
	var b []byte
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

func newSpotTradeClient(t *testing.T, fake *spotTradeFake) *USDMClient {
	t.Helper()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	// base 直接指向现货主机 —— 现货交易客户端就是这么建的。
	c := NewUSDMClient(server.URL)
	if err := c.UseCredentials(Credentials{APIKey: "sp", APISecret: "sec", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	return c
}

func (f *spotTradeFake) orderCalls() []spotCall {
	var out []spotCall
	for _, c := range f.calls {
		if c.path == "/api/v3/order" {
			out = append(out, c)
		}
	}
	return out
}

/*
均价是从 cummulativeQuoteQty / executedQty 算出来的。

现货**没有** avgPrice 字段（那是合约才有），而且累计成交额的字段名里
币安多拼了一个 m：`cummulativeQuoteQty`。写对成 cumulative 的话解析出来
恒为 0，均价就永远退回请求价 —— 账面上看不出错，但每笔成交价都是假的。
这条测试就是钉住这个字段。
*/
func TestSpotEntryComputesAvgPriceFromQuoteQty(t *testing.T) {
	fake := &spotTradeFake{}
	c := newSpotTradeClient(t, fake)
	fill, err := c.PlaceSpotEntry(EntryOrder{Symbol: "DOGEUSDT", Side: SideLong, Qty: 60, Price: 0.08})
	if err != nil {
		t.Fatalf("下单失败: %v", err)
	}
	if fill.Price != 0.08 {
		t.Fatalf("均价应为 4.8/60 = 0.08，得到 %v（字段名写错会退回请求价）", fill.Price)
	}
	if fill.Qty != 60 {
		t.Fatalf("成交量 %v", fill.Qty)
	}
	if fill.OrderID != "42" {
		t.Fatalf("订单号 %q", fill.OrderID)
	}
	if fill.Status != "FILLED" {
		t.Fatalf("状态 %q", fill.Status)
	}
	calls := fake.orderCalls()
	if len(calls) != 1 {
		t.Fatalf("应只发一单，发了 %d 张", len(calls))
	}
	q := calls[0].query
	if q.Get("side") != "BUY" || q.Get("type") != "MARKET" {
		t.Fatalf("现货开仓必须是市价买入: %v", q)
	}
	if q.Get("quantity") != "60" {
		t.Fatalf("数量没按步长对齐: %q", q.Get("quantity"))
	}
	if q.Get("newOrderRespType") != "RESULT" {
		t.Fatalf("必须请求 RESULT，否则拿不到成交量与成交额: %v", q)
	}
}

// 现货没有做空 —— 传 SideShort 必须在**发请求之前**就被拒。
func TestSpotEntryRefusesShort(t *testing.T) {
	fake := &spotTradeFake{}
	c := newSpotTradeClient(t, fake)
	if _, err := c.PlaceSpotEntry(EntryOrder{Symbol: "DOGEUSDT", Side: SideShort, Qty: 60, Price: 0.08}); err == nil {
		t.Fatal("现货做空必须被拒")
	}
	if len(fake.orderCalls()) != 0 {
		t.Fatal("被拒的请求不该发出去")
	}
}

func TestSpotEntryRefusesBelowMinNotional(t *testing.T) {
	fake := &spotTradeFake{}
	c := newSpotTradeClient(t, fake)
	// 1 张 DOGE × 0.08 = 0.08 USDT，低于 NOTIONAL 里写的 1 USDT。
	if _, err := c.PlaceSpotEntry(EntryOrder{Symbol: "DOGEUSDT", Side: SideLong, Qty: 1, Price: 0.08}); err == nil {
		t.Fatal("低于最小名义价值必须被拒")
	}
	if len(fake.orderCalls()) != 0 {
		t.Fatal("被拒的请求不该发出去")
	}
}

func TestSpotPositionSumsFreeAndLocked(t *testing.T) {
	fake := &spotTradeFake{balances: `{"balances":[{"asset":"DOGE","free":"40","locked":"20"}]}`}
	c := newSpotTradeClient(t, fake)
	pos, err := c.SpotPosition("DOGEUSDT")
	if err != nil {
		t.Fatal(err)
	}
	// 被保护单锁住的那部分仍然属于持仓 —— 只算 free 会凭空少掉一半。
	if !pos.Open || pos.Qty != 60 {
		t.Fatalf("持仓应为 free+locked=60，得到 %+v", pos)
	}
	if pos.Side != SideLong {
		t.Fatalf("现货持仓只能是多头: %q", pos.Side)
	}
}

func TestSpotPositionEmptyWhenNoBalance(t *testing.T) {
	fake := &spotTradeFake{balances: `{"balances":[{"asset":"XRP","free":"5","locked":"0"}]}`}
	c := newSpotTradeClient(t, fake)
	pos, err := c.SpotPosition("DOGEUSDT")
	if err != nil {
		t.Fatal(err)
	}
	if pos.Open {
		t.Fatalf("没有 DOGE 就不该报有持仓: %+v", pos)
	}
}

func TestSpotCloseSellsTheWholeBalance(t *testing.T) {
	fake := &spotTradeFake{balances: `{"balances":[{"asset":"DOGE","free":"40","locked":"20"}]}`}
	c := newSpotTradeClient(t, fake)
	if _, err := c.CloseSpot(CloseOrder{Symbol: "DOGEUSDT", Side: SideLong}); err != nil {
		t.Fatalf("平仓失败: %v", err)
	}
	calls := fake.orderCalls()
	if len(calls) != 1 {
		t.Fatalf("应只发一单，发了 %d 张", len(calls))
	}
	q := calls[0].query
	if q.Get("side") != "SELL" || q.Get("type") != "MARKET" {
		t.Fatalf("现货平仓必须是市价卖出: %v", q)
	}
	if q.Get("quantity") != "60" {
		t.Fatalf("应卖出全部余额 60，得到 %q", q.Get("quantity"))
	}
}

// 已经没货时按「已平」回报，不去发一张必然被拒的单。
func TestSpotCloseIsNoopWithoutBalance(t *testing.T) {
	fake := &spotTradeFake{balances: `{"balances":[]}`}
	c := newSpotTradeClient(t, fake)
	fill, err := c.CloseSpot(CloseOrder{Symbol: "DOGEUSDT", Side: SideLong, Price: 0.081})
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.orderCalls()) != 0 {
		t.Fatal("没货时不该发卖单")
	}
	if fill.Status != StatusFilled {
		t.Fatalf("应回报已平: %+v", fill)
	}
}

/*
保护单：止损是 STOP_LOSS_LIMIT，而且限价要比触发价**低一点**。

现货的止损必须先触发再以限价挂单成交；限价等于触发价时，急跌会一路穿过去
而挂单成交不了 —— 止损就形同虚设。所以这里断言 stopPrice < 触发价。
*/
func TestSpotProtectionUsesStopLimitBelowTrigger(t *testing.T) {
	fake := &spotTradeFake{balances: `{"balances":[{"asset":"DOGE","free":"60","locked":"0"}]}`}
	c := newSpotTradeClient(t, fake)
	stop, take := 0.078, 0.088
	if err := c.PlaceSpotProtection(Protection{Symbol: "DOGEUSDT", Side: SideLong, Stop: stop, Take: take}); err != nil {
		t.Fatalf("挂保护单失败: %v", err)
	}
	calls := fake.orderCalls()
	if len(calls) != 2 {
		t.Fatalf("应挂止损+止盈两张，挂了 %d 张", len(calls))
	}
	sl := calls[0].query
	if sl.Get("side") != "SELL" || sl.Get("type") != "STOP_LOSS_LIMIT" {
		t.Fatalf("止损应是 STOP_LOSS_LIMIT 卖出: %v", sl)
	}
	if sl.Get("timeInForce") != "GTC" {
		t.Fatalf("STOP_LOSS_LIMIT 必须带 timeInForce: %v", sl)
	}
	trigger := parseFloatOr0(sl.Get("stopPrice"))
	limit := parseFloatOr0(sl.Get("price"))
	if !(limit < trigger) {
		t.Fatalf("限价必须低于触发价，否则急跌时止损成交不了: trigger=%v limit=%v", trigger, limit)
	}
	// 让价幅度就是 spotStopSlippage，别让它被改掉。
	if want := stop * (1 - spotStopSlippage); !nearly(limit, want) {
		t.Fatalf("让价幅度不对: limit=%v want=%v", limit, want)
	}
	tp := calls[1].query
	if tp.Get("type") != "LIMIT" || tp.Get("side") != "SELL" {
		t.Fatalf("止盈应是普通限价卖出: %v", tp)
	}
	if !nearly(parseFloatOr0(tp.Get("price")), take) {
		t.Fatalf("止盈价不对: %v", tp.Get("price"))
	}
}

// 没有持仓时挂保护单必须被拒 —— 否则会挂出一张卖出不存在的币的单。
func TestSpotProtectionRequiresPosition(t *testing.T) {
	fake := &spotTradeFake{balances: `{"balances":[]}`}
	c := newSpotTradeClient(t, fake)
	if err := c.PlaceSpotProtection(Protection{Symbol: "DOGEUSDT", Side: SideLong, Stop: 0.078}); err == nil {
		t.Fatal("无持仓时挂保护单必须被拒")
	}
	if len(fake.orderCalls()) != 0 {
		t.Fatal("被拒的请求不该发出去")
	}
}

// 撤单：本来就没有挂单时币安回 -2011，这要当成功 —— 目标是「撤干净」。
func TestSpotCancelOpenTreatsNoOrderAsSuccess(t *testing.T) {
	fake := &spotTradeFake{cancelCode: -2011}
	c := newSpotTradeClient(t, fake)
	if err := c.CancelSpotOpen("DOGEUSDT"); err != nil {
		t.Fatalf("-2011（没有挂单）应视为成功，得到 %v", err)
	}
}

func TestSpotCancelOpenSurfacesOtherErrors(t *testing.T) {
	fake := &spotTradeFake{cancelCode: -1121} // Invalid symbol
	c := newSpotTradeClient(t, fake)
	if err := c.CancelSpotOpen("DOGEUSDT"); err == nil {
		t.Fatal("非 -2011 的错误必须透出")
	}
}

// 交易对不在现货、或状态不是 TRADING 时要明确拒绝，不能拿着空规则去下单。
func TestSpotRulesRejectBadSymbol(t *testing.T) {
	fake := &spotTradeFake{balances: `{"balances":[]}`}
	c := newSpotTradeClient(t, fake)
	if _, err := c.spotRulesFor("NOPEUSDT"); err == nil {
		t.Fatal("现货没有的交易对必须被拒")
	}
}

func TestParseSpotRulesAcceptsMinNotionalAlias(t *testing.T) {
	// 老接口用 MIN_NOTIONAL，新接口用 NOTIONAL，两个都要认。
	body := []byte(`{"symbols":[{"symbol":"XRPUSDT","baseAsset":"XRP","quoteAsset":"USDT","status":"TRADING",
		"filters":[
			{"filterType":"LOT_SIZE","minQty":"0.1","stepSize":"0.1"},
			{"filterType":"PRICE_FILTER","tickSize":"0.0001"},
			{"filterType":"MIN_NOTIONAL","minNotional":"5"}
		]}]}`)
	r, err := parseSpotRules(body, "XRPUSDT")
	if err != nil {
		t.Fatal(err)
	}
	if r.MinNotional != 5 || r.StepSize != 0.1 || r.BaseAsset != "XRP" || r.QuoteAsset != "USDT" {
		t.Fatalf("规则解析不对: %+v", r)
	}
}

func TestParseSpotRulesRejectsNonTradingStatus(t *testing.T) {
	body := []byte(`{"symbols":[{"symbol":"XRPUSDT","baseAsset":"XRP","quoteAsset":"USDT","status":"BREAK",
		"filters":[{"filterType":"LOT_SIZE","stepSize":"0.1"}]}]}`)
	if _, err := parseSpotRules(body, "XRPUSDT"); err == nil {
		t.Fatal("暂停交易的交易对必须被拒")
	}
}

// SpotExchange 必须真的满足引擎认的 Exchange 接口 —— 少一个方法编译期就该拦下，
// 但这里显式断言一次，免得将来有人"顺手"改了方法签名。
func TestSpotExchangeImplementsExchange(t *testing.T) {
	var _ Exchange = (*SpotExchange)(nil)
}

func nearly(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-9
}
