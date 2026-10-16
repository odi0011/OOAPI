package trading

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

/*
现货下单。

与合约的差别，每一条都必须在代码里显式体现，不能靠默认值蒙混：

  · **只能做多**。现货没有做空，卖出只可能是平掉已持有的现货。
  · **没有杠杆**。名义 = 花掉的钱，1R 的口径随之缩小。
  · **没有「仓位」**。持有量就是该币种的现货余额（free + locked）——
    locked 是被挂单锁住的那部分，仍然属于持仓。
  · **没有强平**。IsolatedLiqPrice 在 leverage=1 时算出的 liq ≈ entry×0.005，
    几乎为零，于是 StopWithinLiquidation 天然通过 —— 风控数学不用为现货改。
  · **保护单不是 closePosition 的 STOP_MARKET**（那是合约独有），
    现货用 STOP_LOSS_LIMIT（触发价 + 限价）与普通 LIMIT。

方法名都带 Spot 前缀：同一个类型上并存两套语义（合约 / 现货），
名字必须一眼看出是哪一套，否则哪天在合约客户端上误调现货方法就是真事故。
*/

// spotStopSlippage 是止损触发价到限价之间的让步比例。
//
// 现货的 STOP_LOSS_LIMIT 必须先触发、再以限价挂出去成交；限价等于触发价时，
// 行情急跌会一路穿过去而挂单成交不了 —— 止损形同虚设。
// 往下让一点，牺牲一点成交价换「止损真的会成交」。
const spotStopSlippage = 0.005

// spotSymbolRules 是现货 exchangeInfo 里与下单有关的过滤器。
type spotSymbolRules struct {
	MarketRules
	stepRaw    string
	tickRaw    string
	BaseAsset  string
	QuoteAsset string
}

// spotOrderResp 是现货下单的回报。
//
// 字段名与合约不同：现货没有 avgPrice，均价要自己用
// 累计成交额 / 成交数量 算；而且累计成交额叫 `cummulativeQuoteQty`
// —— 币安在这里多拼了一个 m，不能"顺手改对"，改了就是解析到 0。
type spotOrderResp struct {
	OrderID     int64  `json:"orderId"`
	Status      string `json:"status"`
	ExecutedQty string `json:"executedQty"`
	CumQuote    string `json:"cummulativeQuoteQty"`
	Side        string `json:"side"`
}

// avgPrice 用累计成交额除以成交量得到均价。
// 成交量为 0（没成交/被拒）时返回 0，调用方据此判断。
func (r spotOrderResp) avgPrice() float64 {
	qty, errQ := strconv.ParseFloat(strings.TrimSpace(r.ExecutedQty), 64)
	quote, errP := strconv.ParseFloat(strings.TrimSpace(r.CumQuote), 64)
	if errQ != nil || errP != nil || qty <= 0 || quote <= 0 {
		return 0
	}
	return quote / qty
}

func (r spotOrderResp) filledQty() float64 {
	qty, err := strconv.ParseFloat(strings.TrimSpace(r.ExecutedQty), 64)
	if err != nil || qty <= 0 {
		return 0
	}
	return qty
}

// spotRulesFor 读并缓存某交易对的现货规则。
func (c *USDMClient) spotRulesFor(symbol string) (spotSymbolRules, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return spotSymbolRules{}, invalid("缺少交易对")
	}
	c.mu.Lock()
	if cached, ok := c.spotRules[symbol]; ok {
		c.mu.Unlock()
		return cached, nil
	}
	c.mu.Unlock()

	params := url.Values{}
	params.Set("symbol", symbol)
	body, err := c.public(http.MethodGet, "/api/v3/exchangeInfo", params)
	if err != nil {
		return spotSymbolRules{}, err
	}
	rules, err := parseSpotRules(body, symbol)
	if err != nil {
		return spotSymbolRules{}, err
	}
	c.mu.Lock()
	if c.spotRules == nil {
		c.spotRules = map[string]spotSymbolRules{}
	}
	c.spotRules[symbol] = rules
	c.mu.Unlock()
	return rules, nil
}

// parseSpotRules 从 /api/v3/exchangeInfo 里取出某交易对的数量与价格规则。
//
// 现货的过滤器名字与合约不同：最小名义在 `NOTIONAL`（老接口是 `MIN_NOTIONAL`），
// 两者都认。数量步长在 `LOT_SIZE`、价格步长在 `PRICE_FILTER`，这两处与合约同名。
func parseSpotRules(body []byte, symbol string) (spotSymbolRules, error) {
	var resp struct {
		Symbols []struct {
			Symbol     string `json:"symbol"`
			BaseAsset  string `json:"baseAsset"`
			QuoteAsset string `json:"quoteAsset"`
			Status     string `json:"status"`
			Filters    []struct {
				FilterType  string `json:"filterType"`
				MinQty      string `json:"minQty"`
				StepSize    string `json:"stepSize"`
				TickSize    string `json:"tickSize"`
				MinNotional string `json:"minNotional"`
				Notional    string `json:"notional"`
			} `json:"filters"`
		} `json:"symbols"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return spotSymbolRules{}, errors.New("现货交易规则无法解析")
	}
	for _, s := range resp.Symbols {
		if !strings.EqualFold(s.Symbol, symbol) {
			continue
		}
		if s.Status != "" && !strings.EqualFold(s.Status, "TRADING") {
			return spotSymbolRules{}, invalid(fmt.Sprintf("现货交易对 %s 当前不可交易（%s）", symbol, s.Status))
		}
		out := spotSymbolRules{BaseAsset: strings.ToUpper(s.BaseAsset), QuoteAsset: strings.ToUpper(s.QuoteAsset)}
		for _, f := range s.Filters {
			switch f.FilterType {
			case "LOT_SIZE":
				out.StepSize = parseFloatOr0(f.StepSize)
				out.MinQty = parseFloatOr0(f.MinQty)
				out.stepRaw = f.StepSize
			case "PRICE_FILTER":
				out.TickSize = parseFloatOr0(f.TickSize)
				out.tickRaw = f.TickSize
			case "NOTIONAL", "MIN_NOTIONAL":
				if v := parseFloatOr0(f.Notional); v > 0 {
					out.MinNotional = v
				} else if v := parseFloatOr0(f.MinNotional); v > 0 {
					out.MinNotional = v
				}
			}
		}
		if out.BaseAsset == "" || out.QuoteAsset == "" {
			return spotSymbolRules{}, invalid(fmt.Sprintf("现货交易对 %s 缺少基础/计价资产", symbol))
		}
		if out.StepSize <= 0 {
			out.StepSize = 1e-8
		}
		return out, nil
	}
	return spotSymbolRules{}, invalid(fmt.Sprintf("现货没有这个交易对：%s", symbol))
}

func parseFloatOr0(text string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

/*
SpotPosition 读某交易对的现货持仓。

现货没有「仓位」这个概念 —— 持仓就是**该币种的余额**：
free 是可用，locked 是被挂单锁住的（挂着的止盈止损会锁住一部分），
两者之和才是真正持有的数量。

注意口径：这读的是整个现货钱包里该币种的全部余额，不只是本策略买的那部分。
用同一个币安账户手工买过同一个币的话，那些也会算进来。这是现货的固有性质，
不是实现偷懒 —— 要隔离得用子账户。
*/
func (c *USDMClient) SpotPosition(symbol string) (Position, error) {
	rules, err := c.spotRulesFor(symbol)
	if err != nil {
		return Position{}, err
	}
	balances, err := c.SpotBalances()
	if err != nil {
		return Position{}, err
	}
	for _, b := range balances {
		if b.Asset != rules.BaseAsset {
			continue
		}
		total := b.Free + b.Locked
		if total <= 0 {
			break
		}
		// 现货没有入场价的概念 —— 引擎手里那份（entryPrice）才是权威。
		// 这里只回数量与方向，价格留给调用方。
		return Position{Open: true, Side: SideLong, Qty: total}, nil
	}
	return Position{Open: false, Qty: 0}, nil
}

/*
PlaceSpotEntry 现货市价买入。**只做多** —— 现货没有做空，传 SideShort 直接拒绝。

数量按 base 资产给（与合约一致），调用方用 SizePosition(名义, 1, 价, 最小名义) 算。
市价买没有杠杆，名义就是花掉的钱。
*/
func (c *USDMClient) PlaceSpotEntry(req EntryOrder) (Fill, error) {
	if c == nil {
		return Fill{}, invalid("交易所客户端未初始化")
	}
	if req.Side != SideLong {
		return Fill{}, invalid("现货只能做多：不支持做空")
	}
	rules, err := c.spotRulesFor(req.Symbol)
	if err != nil {
		return Fill{}, err
	}
	qty := AlignQuantity(req.Qty, rules.StepSize, rules.MinQty)
	if qty <= 0 {
		return Fill{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	if rules.MinNotional > 0 && qty*req.Price < rules.MinNotional {
		return Fill{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	params := url.Values{}
	params.Set("symbol", strings.ToUpper(req.Symbol))
	params.Set("side", "BUY")
	params.Set("type", "MARKET")
	params.Set("quantity", formatStep(qty, rules.StepSize, rules.stepRaw))
	params.Set("newOrderRespType", "RESULT")
	if req.ClientOrderID != "" {
		params.Set("newClientOrderId", req.ClientOrderID)
	}
	return c.spotOrder(params, SideLong, req.Price, qty)
}

/*
CloseSpot 现货市价卖出，平掉持仓。

**数量以当前余额为准**，不看请求里的。理由是现货的"平仓"只有一种含义：
把持有的卖掉；而 CloseOrder 里没有数量字段（合约那边也不需要 —— 它读
positionRisk）。照余额卖，就不存在"卖多卖少"的歧义。

卖出不需要 reduceOnly —— 现货没有这个概念。卖多了会因余额不足被拒，
天然不会反手做空。
*/
func (c *USDMClient) CloseSpot(req CloseOrder) (Fill, error) {
	if c == nil {
		return Fill{}, invalid("交易所客户端未初始化")
	}
	rules, err := c.spotRulesFor(req.Symbol)
	if err != nil {
		return Fill{}, err
	}
	pos, err := c.SpotPosition(req.Symbol)
	if err != nil {
		return Fill{}, err
	}
	if !pos.Open {
		// 已经没货了：按已平回报，不去发一张必然被拒的单。
		return Fill{Status: StatusFilled, Price: req.Price, Qty: 0, Side: SideLong, At: time.Now().UTC()}, nil
	}
	qty := pos.Qty
	qty = AlignQuantity(qty, rules.StepSize, rules.MinQty)
	if qty <= 0 {
		return Fill{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	params := url.Values{}
	params.Set("symbol", strings.ToUpper(req.Symbol))
	params.Set("side", "SELL")
	params.Set("type", "MARKET")
	params.Set("quantity", formatStep(qty, rules.StepSize, rules.stepRaw))
	params.Set("newOrderRespType", "RESULT")
	if req.ClientOrderID != "" {
		params.Set("newClientOrderId", req.ClientOrderID)
	}
	return c.spotOrder(params, SideLong, req.Price, qty)
}

// spotOrder 发单并解析回报。
func (c *USDMClient) spotOrder(params url.Values, side Side, fallbackPrice, wantQty float64) (Fill, error) {
	body, err := c.signed(http.MethodPost, "/api/v3/order", params)
	if err != nil {
		return Fill{}, err
	}
	var resp spotOrderResp
	if json.Unmarshal(body, &resp) != nil {
		return Fill{}, errors.New("现货下单返回无法解析")
	}
	fill := Fill{
		OrderID: strconv.FormatInt(resp.OrderID, 10),
		Status:  resp.Status,
		Side:    side,
		At:      time.Now().UTC(),
	}
	fill.Qty = resp.filledQty()
	fill.Price = resp.avgPrice()
	if fill.Qty <= 0 {
		fill.Qty = wantQty
	}
	// 均价读不到时用请求价兜底，账本留给对账回补 —— 与合约同一条口径。
	if fill.Price <= 0 {
		fill.Price = fallbackPrice
	}
	return fill, nil
}

/*
PlaceSpotProtection 给现货持仓挂保护单：止损 STOP_LOSS_LIMIT + 止盈 LIMIT。

现货的止损必须先触发、再以限价成交，所以限价要比触发价再让一点
（spotStopSlippage）—— 限价等于触发价时，急跌会直接穿过去而成交不了。

不动已有的挂单：这个方法只负责"挂上"。要换价先 CancelSpotOpen。
*/
func (c *USDMClient) PlaceSpotProtection(req Protection) error {
	if c == nil {
		return invalid("交易所客户端未初始化")
	}
	rules, err := c.spotRulesFor(req.Symbol)
	if err != nil {
		return err
	}
	pos, err := c.SpotPosition(req.Symbol)
	if err != nil {
		return err
	}
	if !pos.Open || pos.Qty <= 0 {
		return invalid("没有现货持仓，不能挂保护单")
	}
	qty := AlignQuantity(pos.Qty, rules.StepSize, rules.MinQty)
	if qty <= 0 {
		return withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	amount := formatStep(qty, rules.StepSize, rules.stepRaw)

	if req.Stop > 0 {
		/*
			触发价与限价是两个不同的数：
			  · stopPrice 是**行情触到就挂单**的价 —— 用策略算出来的止损位；
			  · price 是**挂出去之后能成交的价** —— 要比触发价再低一点。
			两者写成同一个值，急跌时会直接穿过限价而成交不了，止损形同虚设。
		*/
		trigger := req.Stop
		limit := req.Stop * (1 - spotStopSlippage)
		params := url.Values{}
		params.Set("symbol", strings.ToUpper(req.Symbol))
		params.Set("side", "SELL")
		params.Set("type", "STOP_LOSS_LIMIT")
		params.Set("timeInForce", "GTC")
		params.Set("quantity", amount)
		params.Set("stopPrice", formatStep(trigger, rules.TickSize, rules.tickRaw))
		params.Set("price", formatStep(limit, rules.TickSize, rules.tickRaw))
		if req.StopClientID != "" {
			params.Set("newClientOrderId", req.StopClientID)
		}
		if _, err := c.signed(http.MethodPost, "/api/v3/order", params); err != nil {
			return err
		}
	}
	if req.Take > 0 {
		params := url.Values{}
		params.Set("symbol", strings.ToUpper(req.Symbol))
		params.Set("side", "SELL")
		params.Set("type", "LIMIT")
		params.Set("timeInForce", "GTC")
		params.Set("quantity", amount)
		params.Set("price", formatStep(req.Take, rules.TickSize, rules.tickRaw))
		if req.TakeClientID != "" {
			params.Set("newClientOrderId", req.TakeClientID)
		}
		if _, err := c.signed(http.MethodPost, "/api/v3/order", params); err != nil {
			return err
		}
	}
	return nil
}

// CancelSpotOpen 撤掉该交易对的全部挂单。
//
// 没有挂单时币安回 -2011，这里当成功处理 —— 目标是"撤干净"，本来就干净
// 不该算失败（合约那边 errNoOpenOrder 是同样的处理）。
func (c *USDMClient) CancelSpotOpen(symbol string) error {
	if c == nil {
		return invalid("交易所客户端未初始化")
	}
	params := url.Values{}
	params.Set("symbol", strings.ToUpper(strings.TrimSpace(symbol)))
	_, err := c.signed(http.MethodDelete, "/api/v3/openOrders", params)
	if err != nil && !errors.Is(err, errNoOpenOrder) {
		return err
	}
	return nil
}

/*
SpotExchange 把现货方法适配成 Exchange 接口，好让引擎的状态机复用。

为什么要有这层薄壳：引擎认的是 PlaceEntry/Close/Position 这组名字，
而那组名字在 USDMClient 上已经是**合约**语义了。同一个类型上不能有
两组同名方法，所以现货用带 Spot 后缀的方法 + 这层适配器 ——
名字区分开，误调就不可能发生。
*/
type SpotExchange struct {
	c *USDMClient
}

func NewSpotExchange(network string) (*SpotExchange, error) {
	base, err := spotBaseFor(network)
	if err != nil {
		return nil, err
	}
	return &SpotExchange{c: NewUSDMClient(base)}, nil
}

// UseCredentials 装填密钥。网络必须与主机一致（见 acceptsNetwork）。
func (s *SpotExchange) UseCredentials(creds Credentials) error {
	if s == nil || s.c == nil {
		return ErrKeyNotUsable
	}
	return s.c.UseCredentials(creds)
}

func (s *SpotExchange) PlaceEntry(req EntryOrder) (Fill, error)  { return s.c.PlaceSpotEntry(req) }
func (s *SpotExchange) PlaceProtection(req Protection) error     { return s.c.PlaceSpotProtection(req) }
func (s *SpotExchange) Close(req CloseOrder) (Fill, error)       { return s.c.CloseSpot(req) }
func (s *SpotExchange) CancelOpen(symbol string) error           { return s.c.CancelSpotOpen(symbol) }
func (s *SpotExchange) Position(symbol string) (Position, error) { return s.c.SpotPosition(symbol) }
func (s *SpotExchange) Rules(symbol string) (MarketRules, error) {
	r, err := s.c.spotRulesFor(symbol)
	return r.MarketRules, err
}

// spotBaseFor 按网络返回现货主机。
//
// 现货测网（testnet.binance.vision）与合约测网是**两套独立系统**，
// 各有各的主机与密钥；这里给出对应网络的那一个。
func spotBaseFor(network string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(network)) {
	case ModeTestnet:
		return BinanceSpotTestnetBase, nil
	case ModeLive:
		return BinanceSpotLiveBase, nil
	default:
		return "", ErrBadMode
	}
}
