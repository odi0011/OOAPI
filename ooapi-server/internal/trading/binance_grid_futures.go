package trading

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
FuturesGridExchange 是网格在 USDT-M 合约上的出口。

和现货网格出口（SpotGridExchange）的区别，全部来自合约与现货的产品差异：

	· 挂单是 GTX（post-only）限价单 —— 吃单会被交易所直接拒掉，
	  所以网格的成交一定是 maker，费率按 maker 算；
	· 平仓单必须带 reduceOnly（单向持仓）或 positionSide（双向持仓），
	  否则一张"买"会被当成开多，把网格的空头变成对冲仓；
	· 清仓不是"卖掉基础币"，而是"买回全部空头"，数量从 positionRisk 读；
	· 下单前要先设逐仓和杠杆，否则会用账户的默认设置。

方向由构造时传入。同一套方法里，SELL 在空头网格是**开仓**、在多头网格是
**平仓** —— 这个区别只体现在 reduceOnly/positionSide 上，方法名不区分。
*/
type FuturesGridExchange struct {
	c        *USDMClient
	direction GridDirection
	leverage int

	mu       sync.Mutex
	prepared bool
	symbol   string
	hedge    bool
}

// NewFuturesGridExchange 按网络建一个合约网格出口。
func NewFuturesGridExchange(network string, direction GridDirection, leverage int) (*FuturesGridExchange, error) {
	if leverage < 1 {
		leverage = 1
	}
	if leverage > MaxLeverage {
		return nil, invalid(fmt.Sprintf("杠杆不能超过 %d", MaxLeverage))
	}
	var client *USDMClient
	switch strings.ToLower(strings.TrimSpace(network)) {
	case ModeTestnet:
		client = NewUSDMTestnet()
	case ModeLive:
		if !TestnetGreen() {
			return nil, ErrLiveGateClosed
		}
		client = NewUSDMClient(BinanceUSDMLiveBase)
	default:
		return nil, ErrBadMode
	}
	return &FuturesGridExchange{
		c:         client,
		direction: NormalizeDirection(direction),
		leverage:  leverage,
	}, nil
}

// FuturesGridExchangeFor 是接口层用的工厂，签名与 GridExchangeFor 对齐。
func FuturesGridExchangeFor(network string, direction GridDirection, leverage int) (GridExchange, error) {
	return NewFuturesGridExchange(network, direction, leverage)
}

// GridExchangeFactory 按网格配置选出口。
func GridExchangeFactory(cfg GridConfig) (GridExchange, error) {
	cfg = cfg.Normalize()
	if cfg.Market == GridMarketFutures {
		return FuturesGridExchangeFor(cfg.Mode, cfg.Direction, cfg.Leverage)
	}
	return GridExchangeFor(cfg.Mode)
}

func (f *FuturesGridExchange) UseCredentials(creds Credentials) error {
	if f == nil || f.c == nil {
		return ErrKeyNotUsable
	}
	return f.c.UseCredentials(creds)
}

// positionSide 返回双向持仓下的持仓方向。单向持仓不用它。
func (f *FuturesGridExchange) positionSide() string {
	if f.direction.Short() {
		return "SHORT"
	}
	return "LONG"
}

/*
prepare 在下第一张单之前把账户设成逐仓 + 指定杠杆。

放在下单路径上而不是读规则的路径上：Rules / LastPrice 是"看一眼"，
不该改账户状态；而真正发单之前必须先设好，否则用的是账户里遗留的
杠杆和保证金模式。
*/
func (f *FuturesGridExchange) prepare(symbol string) error {
	f.mu.Lock()
	if f.prepared {
		f.mu.Unlock()
		return nil
	}
	f.mu.Unlock()

	err := f.c.ConfigureAccount(symbol, f.leverage)
	if err != nil && !errors.Is(err, errMarginUnchanged) {
		return err
	}
	hedge, herr := f.c.hedge()
	if herr != nil {
		return herr
	}

	f.mu.Lock()
	f.prepared = true
	f.symbol = symbol
	f.hedge = hedge
	f.mu.Unlock()
	return nil
}

func (f *FuturesGridExchange) PlaceLimit(symbol string, side SpotSide, qty, price float64, clientID string) (SpotOrderState, error) {
	if err := f.prepare(symbol); err != nil {
		return SpotOrderState{}, err
	}
	rules, raw, err := f.c.rulesFor(symbol)
	if err != nil {
		return SpotOrderState{}, err
	}
	qty = AlignQuantity(qty, rules.StepSize, rules.MinQty)
	if qty <= 0 {
		return SpotOrderState{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	params := url.Values{}
	params.Set("symbol", symbol)
	params.Set("side", string(side))
	params.Set("type", "LIMIT")
	params.Set("timeInForce", "GTX")
	params.Set("quantity", formatStep(qty, rules.StepSize, raw.stepRaw))
	params.Set("price", formatStep(price, 0, raw.tickRaw))
	params.Set("newOrderRespType", "RESULT")
	params.Set("newClientOrderId", ensureClientOrderID(clientID, "oo-g-"))

	f.mu.Lock()
	hedge := f.hedge
	f.mu.Unlock()
	if hedge {
		// 双向持仓：同一个 positionSide 上，反向单天然是平仓。
		params.Set("positionSide", f.positionSide())
	} else if side == f.direction.CloseSide() {
		// 单向持仓：平仓单必须 reduceOnly，否则会被当成反向开仓。
		params.Set("reduceOnly", "true")
	}

	body, err := f.c.signed(http.MethodPost, "/fapi/v1/order", params)
	if err != nil {
		return SpotOrderState{}, err
	}
	return decodeFuturesGridOrder(body)
}

func (f *FuturesGridExchange) OpenOrders(symbol string) ([]SpotOrderState, error) {
	body, err := f.c.signed(http.MethodGet, "/fapi/v1/openOrders", url.Values{"symbol": {symbol}})
	if err != nil {
		return nil, err
	}
	rows, err := parseFuturesGridOrders(body)
	if err != nil {
		return nil, err
	}
	out := make([]SpotOrderState, 0, len(rows))
	for _, row := range rows {
		if row.Symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		out = append(out, row.state())
	}
	return out, nil
}

func (f *FuturesGridExchange) QueryOrder(symbol, clientID string) (SpotOrderState, error) {
	body, err := f.c.signed(http.MethodGet, "/fapi/v1/order", url.Values{
		"symbol":           {symbol},
		"origClientOrderId": {clientID},
	})
	if err != nil {
		return SpotOrderState{}, err
	}
	return decodeFuturesGridOrder(body)
}

func (f *FuturesGridExchange) Cancel(symbol, clientID string) error {
	_, err := f.c.signed(http.MethodDelete, "/fapi/v1/order", url.Values{
		"symbol":           {symbol},
		"origClientOrderId": {clientID},
	})
	if errors.Is(err, errNoOpenOrder) {
		return nil
	}
	return err
}

func (f *FuturesGridExchange) Trades(symbol string, orderID int64) ([]GridTrade, error) {
	params := url.Values{
		"symbol":  {symbol},
		"orderId": {strconv.FormatInt(orderID, 10)},
		"limit":   {"100"},
	}
	body, err := f.c.signed(http.MethodGet, "/fapi/v1/userTrades", params)
	if err != nil {
		return nil, err
	}
	return parseFuturesGridTrades(body)
}

// MarketClose 买回（空头）或卖出（多头）指定数量，用于止损/止盈清仓。
func (f *FuturesGridExchange) MarketClose(symbol string, qty float64, clientID string) (SpotOrderState, error) {
	if err := f.prepare(symbol); err != nil {
		return SpotOrderState{}, err
	}
	rules, raw, err := f.c.rulesFor(symbol)
	if err != nil {
		return SpotOrderState{}, err
	}
	qty = AlignQuantity(qty, rules.StepSize, rules.MinQty)
	if qty <= 0 {
		return SpotOrderState{}, invalid("清仓数量必须大于 0")
	}
	params := url.Values{}
	params.Set("symbol", symbol)
	params.Set("side", string(f.direction.CloseSide()))
	params.Set("type", "MARKET")
	params.Set("quantity", formatStep(qty, rules.StepSize, raw.stepRaw))
	params.Set("newOrderRespType", "RESULT")
	params.Set("newClientOrderId", ensureClientOrderID(clientID, "oo-g-flat-"))

	f.mu.Lock()
	hedge := f.hedge
	f.mu.Unlock()
	if hedge {
		params.Set("positionSide", f.positionSide())
	} else {
		params.Set("reduceOnly", "true")
	}
	body, err := f.c.signed(http.MethodPost, "/fapi/v1/order", params)
	if err != nil {
		return SpotOrderState{}, err
	}
	return decodeFuturesGridOrder(body)
}

// PositionQty 读网格方向上的持仓量（绝对值）。
func (f *FuturesGridExchange) PositionQty(symbol string) (float64, error) {
	body, err := f.c.signed(http.MethodGet, "/fapi/v2/positionRisk", url.Values{"symbol": {symbol}})
	if err != nil {
		return 0, err
	}
	rows, err := decodeRiskRows(body)
	if err != nil {
		return 0, err
	}
	total := 0.0
	for _, row := range rows {
		if row.Symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		amt := float64(row.PositionAmt)
		side := strings.ToUpper(strings.TrimSpace(row.PositionSide))
		if side == "LONG" || side == "SHORT" {
			if f.direction.Short() != (side == "SHORT") {
				continue
			}
			total += math.Abs(amt)
			continue
		}
		// 单向持仓：空头 positionAmt 为负。
		if f.direction.Short() {
			if amt < 0 {
				total += -amt
			}
		} else if amt > 0 {
			total += amt
		}
	}
	return total, nil
}

// BaseQty 在合约上等同于 PositionQty（保留这个名字只为接口兼容）。
func (f *FuturesGridExchange) BaseQty(symbol string) (float64, error) {
	return f.PositionQty(symbol)
}

/*
EnsureProtectionStop 保证交易所上有一张 closePosition 的全平止损。

幂等：触发价已经在 tick 以内、方向一致、且是 closePosition 的条件单
就直接返回。价格变了（重启后区间被改过）则先撤掉旧的再挂新的。

用 algoOrder（CONDITIONAL）而不是普通 STOP_MARKET：合约的普通
STOP_MARKET + closePosition 在测网上会返回 -4120，趋势引擎那边
已经踩过这个坑，这里沿用同一套。
*/
func (f *FuturesGridExchange) EnsureProtectionStop(symbol string, trigger float64, clientID string) error {
	if err := f.prepare(symbol); err != nil {
		return err
	}
	rules, raw, err := f.c.rulesFor(symbol)
	if err != nil {
		return err
	}
	if trigger <= 0 {
		return invalid("保护单触发价必须大于 0")
	}
	/*
		没有持仓时不要挂 closePosition 保护单。

		币安对 closePosition 的条件单要求 TIF=GTE，而 GTE 只在
		"已有持仓"时可用 —— 空仓时下单会被 -4509 直接拒掉。
		网格在第一次卖出成交之前本来就没有可保护的对象，跳过即可；
		成交会在同一拍的 reconcile 里先入账，下一拍就会把止损挂上。
	*/
	pos, perr := f.PositionQty(symbol)
	if perr != nil {
		return perr
	}
	if pos <= 0 {
		open, oerr := f.c.openAlgoOrders(symbol)
		if oerr != nil {
			return oerr
		}
		if len(open) > 0 {
			return f.c.cancelAlgoOrders(symbol)
		}
		return nil
	}
	open, err := f.c.openAlgoOrders(symbol)
	if err != nil {
		return err
	}
	wantSide := string(f.direction.CloseSide())
	for _, o := range open {
		if !bool(o.ClosePosition) {
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(o.Side), wantSide) {
			continue
		}
		if priceWithinTick(float64(o.TriggerPrice), trigger, rules.TickSize) {
			return nil
		}
	}
	if err := f.c.cancelAlgoOrders(symbol); err != nil {
		return err
	}
	f.mu.Lock()
	hedge := f.hedge
	f.mu.Unlock()
	posSide := ""
	if hedge {
		posSide = f.positionSide()
	}
	_, err = f.c.conditional(symbol, wantSide, posSide, "STOP_MARKET", trigger, raw.tickRaw,
		ensureClientOrderID(clientID, "oo-g-sl-"))
	return err
}

// CancelProtectionStops 撤掉该交易对上的全部条件单。
func (f *FuturesGridExchange) CancelProtectionStops(symbol string) error {
	return f.c.cancelAlgoOrders(symbol)
}

// MarketSell 在合约上就是"按清仓方向市价了结"。
func (f *FuturesGridExchange) MarketSell(symbol string, qty float64, clientID string) (SpotOrderState, error) {
	return f.MarketClose(symbol, qty, clientID)
}

func (f *FuturesGridExchange) Rules(symbol string) (GridRules, error) {
	r, err := f.c.Rules(symbol)
	if err != nil {
		return GridRules{}, err
	}
	f.mu.Lock()
	f.symbol = symbol
	f.mu.Unlock()
	return GridRules{
		BaseAsset:   strings.TrimSuffix(strings.ToUpper(symbol), "USDT"),
		QuoteAsset:  "USDT",
		StepSize:    r.StepSize,
		MinQty:      r.MinQty,
		TickSize:    r.TickSize,
		MinNotional: r.MinNotional,
	}, nil
}

func (f *FuturesGridExchange) LastPrice(symbol string) (float64, error) {
	body, err := f.c.public(http.MethodGet, "/fapi/v1/ticker/price", url.Values{"symbol": {symbol}})
	if err != nil {
		return 0, err
	}
	var resp struct {
		Price flexNum `json:"price"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, errors.New("价格数据无法解析")
	}
	price := float64(resp.Price)
	if price <= 0 {
		return 0, invalid("交易所返回的价格不是正数")
	}
	return price, nil
}

/*
CommissionRate 返回 maker 费率。

网格的每一张单都是 GTX：会吃单的挂单被交易所拒掉，所以成交一定是 maker。
这里**不用 taker** —— 与现货出口刻意不同，原因见 FuturesDefaultGridFeeRate。
*/
func (f *FuturesGridExchange) CommissionRate() float64 {
	f.mu.Lock()
	symbol := f.symbol
	f.mu.Unlock()
	if symbol == "" {
		return 0
	}
	maker, _, err := f.c.CommissionRates(symbol)
	if err != nil {
		return 0
	}
	return maker
}

// ---------------------------------------------------------------------------
// 合约订单/成交的解析
// ---------------------------------------------------------------------------

type futuresGridOrder struct {
	OrderID       flexNum  `json:"orderId"`
	ClientOrderID string   `json:"clientOrderId"`
	Symbol        string   `json:"symbol"`
	Side          string   `json:"side"`
	PositionSide  string   `json:"positionSide"`
	Type          string   `json:"type"`
	Status        string   `json:"status"`
	Price         flexNum  `json:"price"`
	AvgPrice      flexNum  `json:"avgPrice"`
	OrigQty       flexNum  `json:"origQty"`
	ExecutedQty   flexNum  `json:"executedQty"`
	CumQuote      flexNum  `json:"cumQuote"`
	CumQuoteOld   flexNum  `json:"cummulativeQuoteQty"`
	UpdateTime    flexNum  `json:"updateTime"`
	Time          flexNum  `json:"time"`
	ReduceOnly    flexBool `json:"reduceOnly"`
}

func (o futuresGridOrder) state() SpotOrderState {
	cum := float64(o.CumQuote)
	if cum <= 0 {
		cum = float64(o.CumQuoteOld)
	}
	price := float64(o.Price)
	if price <= 0 {
		price = float64(o.AvgPrice)
	}
	at := int64(o.UpdateTime)
	if at <= 0 {
		at = int64(o.Time)
	}
	return SpotOrderState{
		OrderID:       int64(o.OrderID),
		ClientOrderID: o.ClientOrderID,
		Symbol:        strings.ToUpper(strings.TrimSpace(o.Symbol)),
		Side:          SpotSide(strings.ToUpper(strings.TrimSpace(o.Side))),
		Type:          strings.ToUpper(strings.TrimSpace(o.Type)),
		Price:         price,
		OrigQty:       float64(o.OrigQty),
		ExecutedQty:   float64(o.ExecutedQty),
		CumQuote:      cum,
		Status:        strings.ToUpper(strings.TrimSpace(o.Status)),
		UpdateTime:    at,
	}
}

func decodeFuturesGridOrder(body []byte) (SpotOrderState, error) {
	var raw futuresGridOrder
	if err := json.Unmarshal(bytes.TrimSpace(body), &raw); err != nil {
		return SpotOrderState{}, errors.New("订单回报无法解析")
	}
	if raw.OrderID == 0 && raw.ClientOrderID == "" {
		return SpotOrderState{}, invalid("订单回报缺少标识")
	}
	return raw.state(), nil
}

func parseFuturesGridOrders(body []byte) ([]futuresGridOrder, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	var rows []futuresGridOrder
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, errors.New("挂单列表无法解析")
	}
	return rows, nil
}

type futuresGridTrade struct {
	Price           flexNum `json:"price"`
	Qty             flexNum `json:"qty"`
	QuoteQty        flexNum `json:"quoteQty"`
	Commission      flexNum `json:"commission"`
	CommissionAsset string  `json:"commissionAsset"`
	Time            flexNum `json:"time"`
}

func parseFuturesGridTrades(body []byte) ([]GridTrade, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	var rows []futuresGridTrade
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, errors.New("成交明细无法解析")
	}
	out := make([]GridTrade, 0, len(rows))
	for _, r := range rows {
		at := time.UnixMilli(int64(r.Time)).UTC()
		out = append(out, GridTrade{
			Price:           float64(r.Price),
			Qty:             float64(r.Qty),
			QuoteQty:        float64(r.QuoteQty),
			Commission:      float64(r.Commission),
			CommissionAsset: strings.ToUpper(strings.TrimSpace(r.CommissionAsset)),
			At:              at,
		})
	}
	return out, nil
}
