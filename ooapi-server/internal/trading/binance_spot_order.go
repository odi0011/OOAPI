package trading

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

/*
现货限价单原语：挂单、查挂单、查单、撤单。

网格需要的是**一批同时挂着的限价单**，而趋势引擎要的是"开仓/平仓"两个动作 ——
所以这一组方法不复用 PlaceSpotEntry / CloseSpot（那两个是市价单），
而是直接对着 /api/v3/order 说话。

下单类型一律用 **LIMIT_MAKER（只做 maker）**，不是普通 LIMIT：

网格的全部收益来自买卖价差，而为价差付账的是手续费。普通 LIMIT 在价格快速
变动时会以 taker 身份立刻成交 —— 那一格我们就变成了"追价的人"，成交价比
计划里算的差。LIMIT_MAKER 会**直接拒绝**任何会立即成交的挂单（-2010），
于是"价格跑掉了"这件事表现为一次干净的失败，而不是一笔悄悄变贵的成交。

网格自己的逻辑本来就不会挂出会成交的单：买单只挂在下一条已知成交价之下、
卖单只挂在之上。真被拒了，说明行情在两次轮询之间跑掉了 —— 下一拍重挂即可。
*/

// SpotOrderType 是现货单类型常量。只用到这两个。
const (
	SpotTypeLimitMaker = "LIMIT_MAKER"
	SpotTypeMarket     = "MARKET"
)

// 现货订单状态。与合约的名字不同（合约叫 NEW / PARTIALLY_FILLED / FILLED / CANCELED / EXPIRED），
// 这里原样保留币安的字符串，不做归一 —— 归一要挑一个"标准"，而两套 API 的
// 状态机并不完全一样，硬凑会把差异藏起来。
const (
	SpotStatusNew             = "NEW"
	SpotStatusPartial         = "PARTIALLY_FILLED"
	SpotStatusFilled          = "FILLED"
	SpotStatusCanceled        = "CANCELED"
	SpotStatusPendingCancel   = "PENDING_CANCEL"
	SpotStatusRejected        = "REJECTED"
	SpotStatusExpired         = "EXPIRED"
	SpotStatusExpiredInMatch  = "EXPIRED_IN_MATCH"
)

// SpotSide 是现货订单的方向。
//
// 刻意**不用** Side（long/short）：现货没有做空，"买"和"卖"是两个动作，
// 不是两个方向。共用一个枚举的代价是有一天会把 SELL 当成"做空"处理，
// 而现货上那是"卖掉已经持有的"。类型不同，编译器就替我们挡住这类错。
type SpotSide string

const (
	SpotBuy  SpotSide = "BUY"
	SpotSell SpotSide = "SELL"
)

// Valid 只接受买和卖。空串与拼错的值一律拒绝。
func (s SpotSide) Valid() bool { return s == SpotBuy || s == SpotSell }

// Opposite 返回反向。网格每成交一格就要在对面挂一张 —— 方向写反就是把
// 刚买到的立刻再买一遍，所以这个函数只此一处实现。
func (s SpotSide) Opposite() SpotSide {
	if s == SpotBuy {
		return SpotSell
	}
	return SpotBuy
}

/*
SpotOrderState 是一张现货订单在某个时刻的样子。

带 json tag 是因为它会直接进 API 响应和事件流。
数量字段用 float64 而不是字符串：币安回的是字符串，但解析进来的都是
有限小数，而且所有比较（够不够成交、还剩多少）都在数值上做。
*/
type SpotOrderState struct {
	OrderID       int64    `json:"orderId"`
	ClientOrderID string   `json:"clientOrderId"`
	Symbol        string   `json:"symbol"`
	Side          SpotSide `json:"side"`
	Type          string   `json:"type"`
	Price         float64  `json:"price"`
	OrigQty       float64  `json:"origQty"`
	ExecutedQty   float64  `json:"executedQty"`
	CumQuote      float64  `json:"cummulativeQuoteQty"`
	Status        string   `json:"status"`
	// UpdateTime 是币安给的毫秒时间戳，成交时刻用它。
	UpdateTime int64 `json:"updateTime"`
}

// AvgPrice 用累计成交额除以成交量。成交量为 0（还没成交）时返回挂单价 ——
// 调用方据此区分"挂了还没动"和"成交了"。
func (o SpotOrderState) AvgPrice() float64 {
	if o.ExecutedQty > 0 && o.CumQuote > 0 {
		return o.CumQuote / o.ExecutedQty
	}
	return o.Price
}

// Filled 报告这张单是否已经完全成交。
func (o SpotOrderState) Filled() bool { return o.Status == SpotStatusFilled }

// Open 报告这张单是否还挂在盘口上（可以撤、还可能继续成交）。
func (o SpotOrderState) Open() bool {
	switch o.Status {
	case SpotStatusNew, SpotStatusPartial, SpotStatusPendingCancel:
		return true
	default:
		return false
	}
}

// spotOrderJSON 是币安现货订单的原始形状。数量与价格都是字符串。
type spotOrderJSON struct {
	OrderID       int64  `json:"orderId"`
	ClientOrderID string `json:"clientOrderId"`
	Symbol        string `json:"symbol"`
	Side          string `json:"side"`
	Type          string `json:"type"`
	Price         string `json:"price"`
	OrigQty       string `json:"origQty"`
	ExecutedQty   string `json:"executedQty"`
	CumQuote      string `json:"cummulativeQuoteQty"`
	Status        string `json:"status"`
	UpdateTime    int64  `json:"updateTime"`
	Time          int64  `json:"time"`
	TransactTime  int64  `json:"transactTime"`
}

func (r spotOrderJSON) state() SpotOrderState {
	st := SpotOrderState{
		OrderID:       r.OrderID,
		ClientOrderID: r.ClientOrderID,
		Symbol:        strings.ToUpper(strings.TrimSpace(r.Symbol)),
		Side:          SpotSide(strings.ToUpper(strings.TrimSpace(r.Side))),
		Type:          r.Type,
		Price:         parseFloatOr0(r.Price),
		OrigQty:       parseFloatOr0(r.OrigQty),
		ExecutedQty:   parseFloatOr0(r.ExecutedQty),
		CumQuote:      parseFloatOr0(r.CumQuote),
		Status:        strings.ToUpper(strings.TrimSpace(r.Status)),
		UpdateTime:    r.UpdateTime,
	}
	if st.UpdateTime == 0 {
		st.UpdateTime = r.TransactTime
	}
	if st.UpdateTime == 0 {
		st.UpdateTime = r.Time
	}
	return st
}

/*
PlaceSpotLimit 挂一张只做 maker 的限价单。

返回的是**下单后的订单状态**：只做 maker 的单要么挂成 NEW，要么被拒。
真回 FILLED 也不是不可能（对手方在同一个 tick 里吃掉了它），所以返回状态
而不是假定"挂上了"—— 网格要靠这个状态决定接下来在哪一格挂对面。

数量按交易所步长向下取整，取整后不够最小数量就直接拒绝，不发请求。
*/
func (c *USDMClient) PlaceSpotLimit(symbol string, side SpotSide, qty, price float64, clientID string) (SpotOrderState, error) {
	if c == nil {
		return SpotOrderState{}, invalid("交易所客户端未初始化")
	}
	if !side.Valid() {
		return SpotOrderState{}, invalid("现货下单方向只能是 BUY 或 SELL")
	}
	if !finitePositive(qty) || !finitePositive(price) {
		return SpotOrderState{}, invalid("现货限价单的数量和价格都必须大于 0")
	}
	rules, err := c.spotRulesFor(symbol)
	if err != nil {
		return SpotOrderState{}, err
	}
	aligned := AlignQuantity(qty, rules.StepSize, rules.MinQty)
	if aligned <= 0 {
		return SpotOrderState{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	price = alignPriceDown(price, rules.TickSize)
	if !finitePositive(price) {
		return SpotOrderState{}, invalid("现货限价单价格取整后不是正数")
	}
	// 价格取整之后名义可能掉到线下（尤其是低价币）。宁可拒单也不发一张
	// 会被币安以 -1013 打回来的请求 —— 那个错误码看不出是"钱不够"还是"太小"。
	if rules.MinNotional > 0 && aligned*price < rules.MinNotional {
		return SpotOrderState{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}

	params := url.Values{}
	params.Set("symbol", strings.ToUpper(strings.TrimSpace(symbol)))
	params.Set("side", string(side))
	params.Set("type", SpotTypeLimitMaker)
	params.Set("quantity", formatStep(aligned, rules.StepSize, rules.stepRaw))
	params.Set("price", formatStep(price, rules.TickSize, rules.tickRaw))
	if clientID != "" {
		params.Set("newClientOrderId", clientID)
	}
	body, err := c.signed(http.MethodPost, "/api/v3/order", params)
	if err != nil {
		return SpotOrderState{}, err
	}
	return decodeSpotOrder(body)
}

// SpotOpenOrders 列出某交易对当前挂在盘口上的全部订单。
//
// 只查一个交易对：网格只关心自己那一个。查全量会把别的策略（甚至用户
// 手工挂的单）混进来，而网格需要的恰恰是"这个交易对上现在有什么"。
func (c *USDMClient) SpotOpenOrders(symbol string) ([]SpotOrderState, error) {
	if c == nil {
		return nil, invalid("交易所客户端未初始化")
	}
	params := url.Values{}
	params.Set("symbol", strings.ToUpper(strings.TrimSpace(symbol)))
	body, err := c.signed(http.MethodGet, "/api/v3/openOrders", params)
	if err != nil {
		return nil, err
	}
	var rows []spotOrderJSON
	if json.Unmarshal(body, &rows) != nil {
		return nil, errors.New("现货挂单返回无法解析")
	}
	out := make([]SpotOrderState, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.state())
	}
	return out, nil
}

/*
SpotQueryOrder 按 clientOrderId 查一张单的当前状态。

网格用它判断"上一拍还挂着的单去哪了"：不在挂单列表里，可能是成交了、
可能被撤了、也可能过期了，而**只有查一次才知道是哪种**。
猜错的方向只有一个 —— 把已成交当成没成交，于是重复挂单、重复持有，
所以这里不猜。
*/
func (c *USDMClient) SpotQueryOrder(symbol, clientOrderID string) (SpotOrderState, error) {
	if c == nil {
		return SpotOrderState{}, invalid("交易所客户端未初始化")
	}
	clientOrderID = strings.TrimSpace(clientOrderID)
	if clientOrderID == "" {
		return SpotOrderState{}, invalid("按客户单号查询时该单号不能为空")
	}
	params := url.Values{}
	params.Set("symbol", strings.ToUpper(strings.TrimSpace(symbol)))
	params.Set("origClientOrderId", clientOrderID)
	body, err := c.signed(http.MethodGet, "/api/v3/order", params)
	if err != nil {
		return SpotOrderState{}, err
	}
	return decodeSpotOrder(body)
}

// SpotCancel 按 clientOrderId 撤掉一张单。
//
// 撤一张不存在的单返回 errNoOpenOrder（-2011）时当成功处理：目标是
// "这张单不在了"，而它本来就不在了 —— 与 CancelSpotOpen 同一口径。
func (c *USDMClient) SpotCancel(symbol, clientOrderID string) error {
	if c == nil {
		return invalid("交易所客户端未初始化")
	}
	clientOrderID = strings.TrimSpace(clientOrderID)
	if clientOrderID == "" {
		return invalid("撤单需要客户单号")
	}
	params := url.Values{}
	params.Set("symbol", strings.ToUpper(strings.TrimSpace(symbol)))
	params.Set("origClientOrderId", clientOrderID)
	_, err := c.signed(http.MethodDelete, "/api/v3/order", params)
	if err != nil && !errors.Is(err, errNoOpenOrder) {
		return err
	}
	return nil
}

func decodeSpotOrder(body []byte) (SpotOrderState, error) {
	var raw spotOrderJSON
	if json.Unmarshal(body, &raw) != nil {
		return SpotOrderState{}, errors.New("现货订单返回无法解析")
	}
	state := raw.state()
	if state.Status == "" {
		return SpotOrderState{}, errors.New("现货订单返回里没有状态")
	}
	return state, nil
}

/*
SpotFreeQty 读某币种的可用余额。

网格平仓（止损/上沿止盈）要卖掉"手里还剩多少"，而这个数只有账户知道 ——
本地记的数量会因为手工干预、其它策略、手续费扣减而与实际不符。
卖了超过余额的单会被币安以 -2010 拒掉，所以宁可先问一次。
*/
func (c *USDMClient) SpotFreeQty(symbol string) (float64, error) {
	rules, err := c.spotRulesFor(symbol)
	if err != nil {
		return 0, err
	}
	balances, err := c.SpotBalances()
	if err != nil {
		return 0, err
	}
	for _, b := range balances {
		if b.Asset == rules.BaseAsset {
			return b.Free + b.Locked, nil
		}
	}
	return 0, nil
}

// SpotRulesFor 把交易对规则开放给同一包内的网格代码。
func (c *USDMClient) SpotRulesFor(symbol string) (spotSymbolRules, error) {
	return c.spotRulesFor(symbol)
}

/*
limitMakerRejected 判断错误是不是"这张只做 maker 的单会立即成交"。

币安回 -2010（NEW_ORDER_REJECTED），原因是订单会吃单。这不是故障，
是网格的**正常分支**：行情在两次轮询之间跳过了这一格，这一格这一拍就不该挂。
把它和"请求被拒/签名不对"区分开，才能在日志里留下有意义的痕迹
（前者刷屏是正常的，后者刷屏是真出事了）。
*/
func limitMakerRejected(err error) bool {
	var ex *ExchangeError
	if !errors.As(err, &ex) || ex == nil {
		return false
	}
	if ex.Code != -2010 {
		return false
	}
	msg := strings.ToUpper(ex.Error())
	return strings.Contains(msg, "LIMIT_MAKER") || strings.Contains(msg, "IMMEDIATELY")
}

// spotSideFromString 解析币安回的方向字符串。认不出来时报错，
// 而不是默认成 BUY —— 默认成买会把一笔卖出记成买入，账就反了。
func spotSideFromString(v string) (SpotSide, bool) {
	switch SpotSide(strings.ToUpper(strings.TrimSpace(v))) {
	case SpotBuy:
		return SpotBuy, true
	case SpotSell:
		return SpotSell, true
	default:
		return "", false
	}
}

// spotOrderIDString 把订单号转成字符串，用于日志与事件。0 回空串。
func spotOrderIDString(id int64) string {
	if id <= 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}

/*
SpotOrderTrades 读某张单的成交明细。

**网格的账必须建立在这上面，不是订单回执。** 订单回执只给"累计成交额"
和"成交数量"，看不出手续费收在哪个币种、扣了多少 —— 而现货买入时
手续费是从**基础币**里扣的，所以"成交了多少"和"到账了多少"不是同一个数。
拿前者当持仓，手上的货会永远比记录多一点点，而那个差额会在下一次
挂卖单时变成"余额不足"（-2010），非常难查。

一张单可能被拆成几笔成交（对手方的量不够拿走整张），所以返回的是数组。
调用方要按总额加权平均，不能只看第一笔。
*/
func (c *USDMClient) SpotOrderTrades(symbol string, orderID int64) ([]GridTrade, error) {
	if c == nil {
		return nil, invalid("交易所客户端未初始化")
	}
	if orderID <= 0 {
		return nil, invalid("查成交明细需要订单号")
	}
	params := url.Values{}
	params.Set("symbol", strings.ToUpper(strings.TrimSpace(symbol)))
	params.Set("orderId", strconv.FormatInt(orderID, 10))
	body, err := c.signed(http.MethodGet, "/api/v3/myTrades", params)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Price           string `json:"price"`
		Qty             string `json:"qty"`
		QuoteQty        string `json:"quoteQty"`
		Commission      string `json:"commission"`
		CommissionAsset string `json:"commissionAsset"`
		Time            int64  `json:"time"`
	}
	if json.Unmarshal(body, &rows) != nil {
		return nil, errors.New("现货成交明细无法解析")
	}
	out := make([]GridTrade, 0, len(rows))
	for _, r := range rows {
		t := GridTrade{
			Price:           parseFloatOr0(r.Price),
			Qty:             parseFloatOr0(r.Qty),
			QuoteQty:        parseFloatOr0(r.QuoteQty),
			Commission:      parseFloatOr0(r.Commission),
			CommissionAsset: strings.ToUpper(strings.TrimSpace(r.CommissionAsset)),
		}
		if r.Time > 0 {
			t.At = time.UnixMilli(r.Time).UTC()
		}
		out = append(out, t)
	}
	return out, nil
}

/*
SpotMarketSell 市价卖掉指定数量。清仓（止损 / 上沿止盈）走它。

用市价而不是限价：需要清仓的时候行情正在快速移动 —— 止损尤其如此。
挂限价单很可能挂不上，而那一刻最不需要的就是"再等一拍"。

数量按步长向下取整；取整后不够最小数量时返回错误，调用方据此
知道"这点零头卖不出去"，而不是发一张必然被拒的单。
*/
func (c *USDMClient) SpotMarketSell(symbol string, qty float64, clientID string) (SpotOrderState, error) {
	if c == nil {
		return SpotOrderState{}, invalid("交易所客户端未初始化")
	}
	if !finitePositive(qty) {
		return SpotOrderState{}, invalid("市价卖出数量必须大于 0")
	}
	rules, err := c.spotRulesFor(symbol)
	if err != nil {
		return SpotOrderState{}, err
	}
	aligned := AlignQuantity(qty, rules.StepSize, rules.MinQty)
	if aligned <= 0 {
		return SpotOrderState{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	params := url.Values{}
	params.Set("symbol", strings.ToUpper(strings.TrimSpace(symbol)))
	params.Set("side", string(SpotSell))
	params.Set("type", SpotTypeMarket)
	params.Set("quantity", formatStep(aligned, rules.StepSize, rules.stepRaw))
	// RESULT 而不是 ACK：清仓要立刻知道成交了没有、成交了多少，
	// 因为紧接着就要停机。
	params.Set("newOrderRespType", "RESULT")
	if clientID != "" {
		params.Set("newClientOrderId", clientID)
	}
	body, err := c.signed(http.MethodPost, "/api/v3/order", params)
	if err != nil {
		return SpotOrderState{}, err
	}
	return decodeSpotOrder(body)
}

/*
SpotLastPrice 读最新成交价。公开接口，不需要密钥。

成交价而不是买一卖一中间价：网格判断"哪些线在当前价之下"用的是
挂单口径，而挂单是和**盘口对手价**成交的。用中间价会算出偏乐观的
"价格在线上"，于是挂出一张会立即成交的买单 —— LIMIT_MAKER 会拒掉它，
每一拍都白跑一次。
*/
func (c *USDMClient) SpotLastPrice(symbol string) (float64, error) {
	if c == nil {
		return 0, invalid("交易所客户端未初始化")
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return 0, invalid("缺少交易对")
	}
	params := url.Values{}
	params.Set("symbol", symbol)
	body, err := c.public(http.MethodGet, "/api/v3/ticker/price", params)
	if err != nil {
		return 0, err
	}
	var resp struct {
		Price string `json:"price"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return 0, errors.New("现货价格返回无法解析")
	}
	price := parseFloatOr0(resp.Price)
	if !finitePositive(price) {
		return 0, invalid("现货价格不是正数")
	}
	return price, nil
}
