package trading

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MarketRules 是 exchangeInfo 里和数量、价格有关的过滤器。
type MarketRules struct {
	MinNotional float64
	StepSize    float64
	MinQty      float64
	TickSize    float64
}

type symbolRules struct {
	MarketRules
	stepRaw string
	tickRaw string
}

// USDMClient 向币安 USDT-M 发单。测网主机是 testnet.binancefuture.com，实盘主机是 fapi.binance.com。
// 密钥 network 必须和主机一致。readOnly 为真时只允许 GET：交易台用它读行情、持仓和挂单。
type USDMClient struct {
	base     string
	http     *http.Client
	mu       sync.Mutex
	creds    Credentials
	rules    map[string]symbolRules
	brackets map[string][]LeverageBracket
	dual     *bool
	readOnly bool
	fees     map[string]commissionQuote
}

type commissionQuote struct {
	maker float64
	taker float64
}

func NewUSDMTestnet() *USDMClient {
	return NewUSDMClient(BinanceUSDMTestnetBase)
}

func NewUSDMClient(base string) *USDMClient {
	return &USDMClient{
		base: strings.TrimRight(strings.TrimSpace(base), "/"),
		http: &http.Client{
			Timeout: 15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		rules: map[string]symbolRules{},
	}
}

func (c *USDMClient) BaseURL() string {
	if c == nil {
		return ""
	}
	return c.base
}

// SyncsPosition 表示持仓和挂单以交易所回报为准，而不是本地记账。
func (c *USDMClient) SyncsPosition() bool { return true }

// UseCredentials 收下与当前主机匹配的密钥。调用发生在发单或同步持仓之前。
func (c *USDMClient) UseCredentials(creds Credentials) error {
	if creds.APIKey == "" || creds.APISecret == "" || !c.acceptsNetwork(creds.Network) {
		return ErrKeyNotUsable
	}
	c.mu.Lock()
	c.creds = creds
	c.mu.Unlock()
	return nil
}

// acceptsNetwork 要求密钥 network 和主机一致。
// 测试网主机只收 testnet，fapi.binance.com 只收 live。单测用的非币安主机仍只收 testnet。
func (c *USDMClient) acceptsNetwork(network string) bool {
	switch c.baseNetwork() {
	case ModeLive:
		return network == ModeLive
	case ModeTestnet:
		return network == ModeTestnet
	default:
		return network == ModeTestnet
	}
}

// LeverageBracket 是已拉到的杠杆档位。InitialLeverage 是该档允许的最大杠杆。
type LeverageBracket struct {
	InitialLeverage int
	MaintMarginRate float64
}

// StoreLeverageBrackets 记下已经拉到的档位。开仓前的强平估算会用它，没有记录时用默认维持保证金率。
func (c *USDMClient) StoreLeverageBrackets(symbol string, rows []LeverageBracket) {
	if c == nil {
		return
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	copied := append([]LeverageBracket(nil), rows...)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.brackets == nil {
		c.brackets = map[string][]LeverageBracket{}
	}
	c.brackets[symbol] = copied
}

// MaintMarginRate 返回已拉到的档位里，仍允许该杠杆的最紧一档的维持保证金率。
// 没有档位时 ok 为 false，调用方改用 DefaultMaintMarginRate。
func (c *USDMClient) MaintMarginRate(symbol string, leverage int) (float64, bool) {
	if c == nil || leverage < 1 {
		return 0, false
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	c.mu.Lock()
	rows := append([]LeverageBracket(nil), c.brackets[symbol]...)
	c.mu.Unlock()
	if len(rows) == 0 {
		return 0, false
	}
	best := -1
	for i, row := range rows {
		if row.MaintMarginRate <= 0 || row.InitialLeverage < leverage {
			continue
		}
		if best < 0 || row.InitialLeverage < rows[best].InitialLeverage {
			best = i
		}
	}
	if best < 0 {
		best = 0
		for i, row := range rows {
			if row.MaintMarginRate > rows[best].MaintMarginRate {
				best = i
			}
		}
	}
	if rows[best].MaintMarginRate <= 0 {
		return 0, false
	}
	return rows[best].MaintMarginRate, true
}

func (c *USDMClient) Rules(symbol string) (MarketRules, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	c.mu.Lock()
	if row, ok := c.rules[symbol]; ok {
		c.mu.Unlock()
		return row.MarketRules, nil
	}
	c.mu.Unlock()
	row, err := c.fetchRules(symbol)
	if err != nil {
		return MarketRules{}, err
	}
	c.mu.Lock()
	c.rules[symbol] = row
	c.mu.Unlock()
	return row.MarketRules, nil
}

func (c *USDMClient) PlaceEntry(req EntryOrder) (Fill, error) {
	if err := c.guard(); err != nil {
		return Fill{}, err
	}
	if req.MarginMode != MarginIsolated || req.Leverage < 1 || req.Leverage > MaxLeverage {
		return Fill{}, invalid(fmt.Sprintf("测网只接受逐仓且杠杆不超过 %d", MaxLeverage))
	}
	if req.Side != SideLong && req.Side != SideShort {
		return Fill{}, invalid("开仓方向只能是 long 或 short")
	}
	rules, raw, err := c.rulesFor(req.Symbol)
	if err != nil {
		return Fill{}, err
	}
	qty := AlignQuantity(req.Qty, rules.StepSize, rules.MinQty)
	if qty <= 0 || req.Price <= 0 || qty*req.Price+1e-9 < rules.MinNotional {
		return Fill{}, withReason(ErrNotionalBelowMin, "notional_below_minimum")
	}
	if err := c.ConfigureAccount(req.Symbol, req.Leverage); err != nil {
		return Fill{}, err
	}
	hedge, err := c.hedge()
	if err != nil {
		return Fill{}, err
	}
	params := url.Values{}
	params.Set("symbol", req.Symbol)
	params.Set("side", orderSide(req.Side))
	params.Set("type", "MARKET")
	params.Set("quantity", formatStep(qty, rules.StepSize, raw.stepRaw))
	params.Set("newOrderRespType", "RESULT")
	params.Set("newClientOrderId", ensureClientOrderID(req.ClientOrderID, "oo-ent-"))
	if hedge {
		params.Set("positionSide", positionSide(req.Side))
	}
	body, err := c.signed(http.MethodPost, "/fapi/v1/order", params)
	if err != nil {
		return Fill{}, err
	}
	resp, err := decodeOrder(body)
	if err != nil {
		return Fill{}, err
	}
	// 开仓价只认成交均价。标记价只用来算数量，不能写进 trading_entries。
	return c.settleFill(req.Symbol, resp, req.Side, qty)
}

func (c *USDMClient) PlaceProtection(req Protection) error {
	if err := c.guard(); err != nil {
		return err
	}
	if req.Stop <= 0 || req.Take <= 0 {
		return invalid("保护单价格必须大于 0")
	}
	req.StopClientID = ensureClientOrderID(req.StopClientID, "oo-sl-")
	req.TakeClientID = ensureClientOrderID(req.TakeClientID, "oo-tp-")
	var (
		pos Position
		err error
	)
	if req.Side == SideLong || req.Side == SideShort {
		pos, err = c.PositionSide(req.Symbol, req.Side)
	} else {
		pos, err = c.Position(req.Symbol)
	}
	if err != nil {
		return err
	}
	if !pos.Open {
		return invalid("没有持仓，不能挂保护单")
	}
	side := req.Side
	if side == "" {
		side = pos.Side
	}
	rules, raw, err := c.rulesFor(req.Symbol)
	if err != nil {
		return err
	}
	stop := roundToTick(req.Stop, rules.TickSize)
	take := roundToTick(req.Take, rules.TickSize)
	if pos.Entry > 0 {
		if side == SideLong && !(stop < pos.Entry && take > pos.Entry) {
			return invalid("多单的止损必须低于入场价，止盈必须高于入场价")
		}
		if side == SideShort && !(stop > pos.Entry && take < pos.Entry) {
			return invalid("空单的止损必须高于入场价，止盈必须低于入场价")
		}
	}
	hedge, err := c.hedge()
	if err != nil {
		return err
	}
	posSide := ""
	if hedge {
		posSide = positionSide(side)
	}
	exit := oppositeSide(side)
	open, err := c.openAlgoOrders(req.Symbol)
	if err != nil {
		return err
	}
	// 止损仍是 closePosition 的 STOP_MARKET，部分止盈之后剩下的数量也由它盖住。
	// 止盈改成 GTX 限价，数量等于当时的持仓量。GTX 被拒或挂不上都算止盈没挂上，调用方重试，不能只留止损。
	ackedStop, err := c.ensureLeg(req.Symbol, exit, posSide, "STOP_MARKET", stop, rules.TickSize, raw.tickRaw, open, req.StopClientID)
	if err != nil {
		return err
	}
	qty := AlignQuantity(pos.Qty, rules.StepSize, rules.MinQty)
	if qty <= 0 {
		return invalid("持仓数量无法按步长挂止盈")
	}
	limits, err := c.openOrders(req.Symbol)
	if err != nil {
		return err
	}
	ackedTake, err := c.ensureMakerTake(req.Symbol, exit, posSide, take, qty, rules, raw, limits, req.TakeClientID)
	if err != nil {
		return err
	}
	return c.confirmProtection(req.Symbol, exit, posSide, stop, take, rules.TickSize, ackedStop, ackedTake)
}

// ensureLeg 复用触发价落在一个 tick 内、且平仓语义一致的条件单。
// 同一合约、同一持仓方向上对不上的止损或止盈先撤掉，再补一张新的。
func (c *USDMClient) ensureLeg(symbol, exit, posSide, orderType string, price, tick float64, tickRaw string, open []algoOrder, clientID string) (bool, error) {
	kept := false
	for _, order := range open {
		if !sameProtectionLeg(order, symbol, posSide, orderType) {
			continue
		}
		if !kept && legFits(order, exit, price, tick) {
			kept = true
			continue
		}
		if err := c.cancelAlgo(order.AlgoID); err != nil {
			return false, err
		}
	}
	if kept {
		return true, nil
	}
	id, err := c.conditional(symbol, exit, posSide, orderType, price, tickRaw, clientID)
	if err != nil {
		return false, err
	}
	if id <= 0 {
		return false, invalid("保护单没有返回 algoId")
	}
	return true, nil
}

// protectionConfirmWait 是挂单回执已经成功、但条件单列表还没跟上时的复查窗口。
const protectionConfirmWait = 2 * time.Second

// protectionConfirmGap 是两次复查 openAlgoOrders 的间隔。
const protectionConfirmGap = 200 * time.Millisecond

// confirmProtection 先等挂单响应，再读 openAlgoOrders 和 openOrders。
// 列表会晚于回执出现。止损和止盈都拿到回执时，空列表不算失败，也不再补单。
// 止损必须仍是 closePosition，止盈必须是同一价格的 GTX 限价。只有止损不算挂上。
func (c *USDMClient) confirmProtection(symbol, exit, posSide string, stop, take, tick float64, ackedStop, ackedTake bool) error {
	deadline := time.Now().Add(protectionConfirmWait)
	for {
		open, err := c.openAlgoOrders(symbol)
		if err != nil {
			return err
		}
		limits, err := c.openOrders(symbol)
		if err != nil {
			return err
		}
		hasStop := hasMatchingLeg(open, symbol, exit, posSide, "STOP_MARKET", stop, tick)
		hasTake := hasMakerTake(limits, symbol, exit, posSide, take, tick)
		if hasStop && hasTake {
			return nil
		}
		if !time.Now().Before(deadline) {
			if ackedStop && ackedTake {
				return nil
			}
			return invalid("保护单没有在测网挂上")
		}
		time.Sleep(protectionConfirmGap)
	}
}

// ensureMakerTake 复用价格和剩余数量都对得上的 GTX 限价止盈。
// 对不上的先撤再挂。GTX 会立刻吃单时币安直接拒绝，这里把错误交回去，不改成市价。
func (c *USDMClient) ensureMakerTake(symbol, exit, posSide string, price, qty float64, rules MarketRules, raw symbolRules, open []bookOrder, clientID string) (bool, error) {
	kept := false
	for _, order := range open {
		if !makerTakeMatches(order, symbol, exit, posSide) {
			continue
		}
		if !kept && takeFits(order, price, rules.TickSize, qty, rules.StepSize) {
			kept = true
			continue
		}
		if err := c.cancelOrder(symbol, order.OrderID); err != nil {
			return false, err
		}
	}
	if kept {
		return true, nil
	}
	id, err := c.placeMakerTake(symbol, exit, posSide, price, qty, raw, clientID)
	if err != nil {
		return false, err
	}
	if id <= 0 {
		return false, invalid("止盈单没有返回 orderId")
	}
	return true, nil
}

func (c *USDMClient) placeMakerTake(symbol, exit, posSide string, price, qty float64, raw symbolRules, clientID string) (int64, error) {
	params := url.Values{}
	params.Set("symbol", symbol)
	params.Set("side", exit)
	params.Set("type", "LIMIT")
	params.Set("timeInForce", "GTX")
	params.Set("quantity", formatStep(qty, raw.StepSize, raw.stepRaw))
	params.Set("price", formatStep(price, 0, raw.tickRaw))
	params.Set("newOrderRespType", "RESULT")
	params.Set("newClientOrderId", ensureClientOrderID(clientID, "oo-tp-"))
	if posSide != "" {
		params.Set("positionSide", posSide)
	} else {
		params.Set("reduceOnly", "true")
	}
	body, err := c.signed(http.MethodPost, "/fapi/v1/order", params)
	if err != nil {
		return 0, err
	}
	resp, err := decodeOrder(body)
	if err != nil {
		return 0, err
	}
	if resp.OrderID <= 0 {
		return 0, invalid("止盈单没有返回 orderId")
	}
	return resp.OrderID, nil
}

func hasMakerTake(orders []bookOrder, symbol, exit, posSide string, price, tick float64) bool {
	for _, order := range orders {
		if makerTakeMatches(order, symbol, exit, posSide) && priceWithinTick(order.Price, price, tick) {
			return true
		}
	}
	return false
}

func makerTakeMatches(order bookOrder, symbol, exit, posSide string) bool {
	if order.Symbol != "" && symbol != "" && !strings.EqualFold(order.Symbol, symbol) {
		return false
	}
	if !strings.EqualFold(order.Type, "LIMIT") || !strings.EqualFold(order.TimeInForce, "GTX") {
		return false
	}
	if exit != "" && order.Side != "" && !strings.EqualFold(order.Side, exit) {
		return false
	}
	if posSide != "" {
		return strings.EqualFold(order.PositionSide, posSide)
	}
	if order.PositionSide != "" && !strings.EqualFold(order.PositionSide, "BOTH") {
		return false
	}
	return order.ReduceOnly
}

func takeFits(order bookOrder, price, tick, qty, step float64) bool {
	if !priceWithinTick(order.Price, price, tick) {
		return false
	}
	return qtyWithinStep(order.remaining(), qty, step)
}

func qtyWithinStep(got, want, step float64) bool {
	slack := step
	if slack <= 0 {
		slack = 1e-8
	}
	return math.Abs(got-want) <= slack+1e-8
}

func hasMatchingLeg(orders []algoOrder, symbol, exit, posSide, orderType string, price, tick float64) bool {
	for _, order := range orders {
		if sameProtectionLeg(order, symbol, posSide, orderType) && legFits(order, exit, price, tick) {
			return true
		}
	}
	return false
}

func sameProtectionLeg(order algoOrder, symbol, posSide, orderType string) bool {
	if order.Symbol != "" && symbol != "" && !strings.EqualFold(order.Symbol, symbol) {
		return false
	}
	if order.kind() != orderType {
		return false
	}
	return legMatches(order, posSide)
}

// legFits 要求 closePosition 平仓、方向一致，并且触发价落在新价格的一个 tick 以内。
func legFits(order algoOrder, exitSide string, price, tick float64) bool {
	if !order.ClosePosition {
		return false
	}
	if exitSide != "" && order.Side != "" && !strings.EqualFold(order.Side, exitSide) {
		return false
	}
	trigger := float64(order.TriggerPrice)
	if trigger <= 0 {
		trigger = float64(order.StopPrice)
	}
	return priceWithinTick(trigger, price, tick)
}

func priceWithinTick(got, want, tick float64) bool {
	if got <= 0 || want <= 0 {
		return false
	}
	slack := tick
	if slack < 0 {
		slack = 0
	}
	return math.Abs(got-want) <= slack+1e-8
}

func legMatches(order algoOrder, posSide string) bool {
	if posSide == "" {
		return true
	}
	return strings.EqualFold(order.PositionSide, posSide)
}

func (c *USDMClient) Close(req CloseOrder) (Fill, error) {
	if err := c.guard(); err != nil {
		return Fill{}, err
	}
	hedge, err := c.hedge()
	if err != nil {
		return Fill{}, err
	}
	/*
		顺序很重要：**先读仓位、发平仓单，确认发出去之后才清理残留挂单。**

		反过来（先撤保护单再平仓）留了一个能吃掉整笔保证金的窗口：
		撤单成功、紧接着的市价单超时或 5xx 时，仓位还在交易所上，
		而它已经没有任何止损了 —— 引擎的失败路径（failed → cancelAndFlatten）
		在同一个网络故障下同样打不通，仓位就这么裸露到被强平。

		注意「超时」不等于「没成交」：先发平仓单的时候，即使读不到回执，
		止损单也还挂在那里；等确认平仓成交后再撤，两种结果都不会裸仓。

		止损是 closePosition 的 STOP_MARKET，仓位一平由交易所自动撤掉，
		所以「后撤」不会留下会反手的挂单；要清理的只是同一价格的
		GTX 止盈限价单。清理失败只记日志，不让整次平仓算失败。
	*/
	var pos Position
	if req.Side == SideLong || req.Side == SideShort {
		pos, err = c.PositionSide(req.Symbol, req.Side)
	} else {
		pos, err = c.Position(req.Symbol)
	}
	if err != nil {
		return Fill{}, err
	}
	if !pos.Open {
		// 仓位已经没了：顺手把残留挂单清掉，再按「已平」回报。
		c.cancelLeftoverOrders(hedge, req.Symbol, pos.Side, req.Side)
		price := req.Price
		if price <= 0 {
			price = pos.Entry
		}
		side := pos.Side
		if side == "" {
			side = req.Side
		}
		return Fill{Status: StatusFilled, Price: price, Qty: pos.Qty, Side: side}, nil
	}
	rules, raw, err := c.rulesFor(req.Symbol)
	if err != nil {
		return Fill{}, err
	}
	qty := AlignQuantity(pos.Qty, rules.StepSize, rules.MinQty)
	if qty <= 0 {
		return Fill{}, invalid("持仓数量无法按步长平仓")
	}
	params := url.Values{}
	params.Set("symbol", req.Symbol)
	params.Set("side", oppositeSide(pos.Side))
	params.Set("type", "MARKET")
	params.Set("quantity", formatStep(qty, rules.StepSize, raw.stepRaw))
	params.Set("newOrderRespType", "RESULT")
	params.Set("newClientOrderId", ensureClientOrderID(req.ClientOrderID, "oo-cls-"))
	if hedge {
		params.Set("positionSide", positionSide(pos.Side))
	} else {
		params.Set("reduceOnly", "true")
	}
	body, err := c.signed(http.MethodPost, "/fapi/v1/order", params)
	if err != nil {
		return Fill{}, err
	}
	resp, err := decodeOrder(body)
	if err != nil {
		return Fill{}, err
	}
	fill, err := c.settleFill(req.Symbol, resp, pos.Side, qty)
	if err != nil {
		// 平仓单已经发出。均价暂时读不到时，引擎内部的盈亏仍用请求价，账本留给回补。
		fb := fillFromOrder(resp, pos.Side, req.Price, qty)
		if fb.Price <= 0 || fb.Qty <= 0 {
			// 发出去了却读不到成交：不敢在这里清挂单 —— 交给对账去收尾。
			return Fill{}, err
		}
		fill = fb
	}
	// 平仓单确实发出去了，这时才清残留（止损是 closePosition，随仓位自动撤销）。
	c.cancelLeftoverOrders(hedge, req.Symbol, pos.Side, req.Side)
	return fill, nil
}

/*
cancelLeftoverOrders 清掉平仓之后还挂在交易所的挂单。

只做收尾、不往上抛错：调用点都已经确认平仓成交，这里失败不该把整次平仓
判成失败、让引擎去重试。hedge 模式按持仓方向撤，不动反方向的仓位；
单向模式撤该合约全部挂单。
*/
func (c *USDMClient) cancelLeftoverOrders(hedge bool, symbol string, posSide, reqSide Side) {
	side := reqSide
	if side != SideLong && side != SideShort {
		side = posSide
	}
	if hedge && (side == SideLong || side == SideShort) {
		if _, err := c.CancelProtective(symbol, side); err != nil {
			log.Printf("[trading] 平仓后清理保护单失败 %s %s: %v", symbol, side, err)
		}
		return
	}
	if err := c.CancelOpen(symbol); err != nil {
		log.Printf("[trading] 平仓后清理挂单失败 %s: %v", symbol, err)
	}
}

// CancelOpen 撤掉该合约的普通挂单，再按 algoId 撤掉条件单。
// 条件单不出现在 allOpenOrders 里。
func (c *USDMClient) CancelOpen(symbol string) error {
	if err := c.guard(); err != nil {
		return err
	}
	_, err := c.signed(http.MethodDelete, "/fapi/v1/allOpenOrders", url.Values{"symbol": {symbol}})
	if err != nil && !errors.Is(err, errNoOpenOrder) {
		return err
	}
	return c.cancelAlgoOrders(symbol)
}

// AccountPositions 读这把密钥下全部合约的 positionRisk，不按交易对过滤。
// 已平仓的行（持仓量为 0）不会出现在结果里。
func (c *USDMClient) AccountPositions() ([]KeyPosition, error) {
	if err := c.guard(); err != nil {
		return nil, err
	}
	body, err := c.signed(http.MethodGet, "/fapi/v2/positionRisk", nil)
	if err != nil {
		return nil, err
	}
	positions, err := parseAccountPositions(body)
	if err != nil {
		return nil, errors.New("持仓数据无法解析")
	}
	if positions == nil {
		positions = []KeyPosition{}
	}
	return positions, nil
}

func (c *USDMClient) Position(symbol string) (Position, error) {
	return c.position(symbol, "")
}

// PositionSide 只看 symbol 上这一个持仓方向。双向持仓里另一边还有数量时，本边归零也是空仓。
// positionAmt 同时接受字符串和数字。双向持仓的空单数量可以是正数，方向看 positionSide。
func (c *USDMClient) PositionSide(symbol string, side Side) (Position, error) {
	return c.position(symbol, side)
}

func (c *USDMClient) position(symbol string, want Side) (Position, error) {
	if err := c.guard(); err != nil {
		return Position{}, err
	}
	body, err := c.signed(http.MethodGet, "/fapi/v2/positionRisk", url.Values{"symbol": {symbol}})
	if err != nil {
		return Position{}, err
	}
	rows, err := decodeRiskRows(body)
	if err != nil {
		return Position{}, err
	}
	return positionFromRisk(symbol, want, rows), nil
}

// positionFromRisk 从 positionRisk 里挑出要看的那一行。
// want 为空时沿用旧行为：返回该合约第一笔非零持仓。
// want 有方向时只认这一边。单向持仓的 positionSide 是 BOTH，空单数量为负；双向持仓用 LONG/SHORT，数量经常是绝对值。
func positionFromRisk(symbol string, want Side, rows []riskRow) Position {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	var chosen *riskRow
	for i := range rows {
		row := &rows[i]
		if row.Symbol != "" && symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		if !riskRowMatchesSide(row, want) {
			continue
		}
		if want == "" && float64(row.PositionAmt) == 0 {
			continue
		}
		chosen = row
		break
	}
	if chosen == nil {
		return Position{}
	}
	amt := float64(chosen.PositionAmt)
	if amt == 0 {
		return Position{}
	}
	side := sideFromRisk(chosen.PositionSide, amt)
	if want != "" && side != want {
		return Position{}
	}
	if amt < 0 {
		amt = -amt
	}
	return Position{Open: true, Side: side, Qty: amt, Entry: float64(chosen.EntryPrice)}
}

func riskRowMatchesSide(row *riskRow, want Side) bool {
	if row == nil || want == "" {
		return row != nil
	}
	ps := strings.ToUpper(strings.TrimSpace(row.PositionSide))
	amt := float64(row.PositionAmt)
	switch want {
	case SideShort:
		if ps == "SHORT" {
			return true
		}
		if ps == "LONG" {
			return false
		}
		return amt <= 0
	case SideLong:
		if ps == "LONG" {
			return true
		}
		if ps == "SHORT" {
			return false
		}
		return amt >= 0
	default:
		return true
	}
}

func sideFromRisk(positionSide string, amt float64) Side {
	switch strings.ToUpper(strings.TrimSpace(positionSide)) {
	case "SHORT":
		return SideShort
	case "LONG":
		return SideLong
	default:
		if amt < 0 {
			return SideShort
		}
		return SideLong
	}
}

// CancelProtective 撤掉该合约、该持仓方向上还挂着的止损和止盈条件单。
// 双向持仓只撤 positionSide 对得上的那一腿，避免拆掉另一边的保护单。
// 单向持仓的条件单没有 LONG/SHORT，撤该合约上全部保护单。
func (c *USDMClient) CancelProtective(symbol string, side Side) ([]int64, error) {
	if err := c.guard(); err != nil {
		return nil, err
	}
	orders, err := c.openAlgoOrders(symbol)
	if err != nil {
		return nil, err
	}
	hedge, err := c.hedge()
	if err != nil {
		return nil, err
	}
	posSide := ""
	if hedge {
		posSide = positionSide(side)
	}
	var canceled []int64
	for _, order := range orders {
		if !protectiveAlgo(order.kind()) {
			continue
		}
		if posSide != "" && !strings.EqualFold(order.PositionSide, posSide) {
			continue
		}
		if order.AlgoID == 0 {
			continue
		}
		if err := c.cancelAlgo(order.AlgoID); err != nil {
			return canceled, err
		}
		canceled = append(canceled, order.AlgoID)
	}
	limits, err := c.openOrders(symbol)
	if err != nil {
		return canceled, err
	}
	exit := oppositeSide(side)
	for _, order := range limits {
		if !makerTakeMatches(order, symbol, exit, posSide) || order.OrderID == 0 {
			continue
		}
		if err := c.cancelOrder(symbol, order.OrderID); err != nil {
			return canceled, err
		}
		canceled = append(canceled, order.OrderID)
	}
	return canceled, nil
}

type bookOrder struct {
	OrderID      int64
	Symbol       string
	Side         string
	PositionSide string
	Type         string
	TimeInForce  string
	Price        float64
	OrigQty      float64
	ExecutedQty  float64
	ReduceOnly   bool
}

func (o bookOrder) remaining() float64 {
	rem := o.OrigQty - o.ExecutedQty
	if rem < 0 {
		return 0
	}
	return rem
}

func (c *USDMClient) openOrders(symbol string) ([]bookOrder, error) {
	body, err := c.signed(http.MethodGet, "/fapi/v1/openOrders", url.Values{"symbol": {symbol}})
	if err != nil {
		return nil, err
	}
	rows, err := parseBookOrders(body)
	if err != nil {
		return nil, err
	}
	out := make([]bookOrder, 0, len(rows))
	for _, row := range rows {
		if row.Symbol != "" && symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

type rawBookOrder struct {
	OrderID      flexNum  `json:"orderId"`
	Symbol       string   `json:"symbol"`
	Side         string   `json:"side"`
	PositionSide string   `json:"positionSide"`
	Type         string   `json:"type"`
	TimeInForce  string   `json:"timeInForce"`
	Price        flexNum  `json:"price"`
	OrigQty      flexNum  `json:"origQty"`
	ExecutedQty  flexNum  `json:"executedQty"`
	ReduceOnly   flexBool `json:"reduceOnly"`
}

func parseBookOrders(body []byte) ([]bookOrder, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	var raw []rawBookOrder
	if body[0] == '{' {
		var wrap struct {
			Orders []rawBookOrder `json:"orders"`
		}
		if err := json.Unmarshal(body, &wrap); err != nil {
			return nil, err
		}
		raw = wrap.Orders
	} else if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	out := make([]bookOrder, 0, len(raw))
	for _, row := range raw {
		out = append(out, bookOrder{
			OrderID:      int64(row.OrderID),
			Symbol:       strings.ToUpper(strings.TrimSpace(row.Symbol)),
			Side:         strings.ToUpper(strings.TrimSpace(row.Side)),
			PositionSide: strings.ToUpper(strings.TrimSpace(row.PositionSide)),
			Type:         strings.ToUpper(strings.TrimSpace(row.Type)),
			TimeInForce:  strings.ToUpper(strings.TrimSpace(row.TimeInForce)),
			Price:        float64(row.Price),
			OrigQty:      float64(row.OrigQty),
			ExecutedQty:  float64(row.ExecutedQty),
			ReduceOnly:   bool(row.ReduceOnly),
		})
	}
	return out, nil
}

func (c *USDMClient) cancelOrder(symbol string, id int64) error {
	if id == 0 {
		return invalid("止盈单缺少 orderId")
	}
	_, err := c.signed(http.MethodDelete, "/fapi/v1/order", url.Values{
		"symbol":  {symbol},
		"orderId": {strconv.FormatInt(id, 10)},
	})
	if err != nil && !errors.Is(err, errNoOpenOrder) {
		return err
	}
	return nil
}

// CommissionRates 读取该合约的 maker/taker。成功后缓存在客户端上。
func (c *USDMClient) CommissionRates(symbol string) (float64, float64, error) {
	if err := c.guard(); err != nil {
		return 0, 0, err
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return 0, 0, invalid("缺少交易对")
	}
	c.mu.Lock()
	if c.fees != nil {
		if row, ok := c.fees[symbol]; ok {
			c.mu.Unlock()
			return row.maker, row.taker, nil
		}
	}
	c.mu.Unlock()
	body, err := c.signed(http.MethodGet, "/fapi/v1/commissionRate", url.Values{"symbol": {symbol}})
	if err != nil {
		return 0, 0, err
	}
	maker, taker, err := parseCommissionRates(body)
	if err != nil {
		return 0, 0, err
	}
	c.mu.Lock()
	if c.fees == nil {
		c.fees = map[string]commissionQuote{}
	}
	c.fees[symbol] = commissionQuote{maker: maker, taker: taker}
	c.mu.Unlock()
	return maker, taker, nil
}

func parseCommissionRates(body []byte) (float64, float64, error) {
	var resp struct {
		Maker *flexNum `json:"makerCommissionRate"`
		Taker *flexNum `json:"takerCommissionRate"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, 0, errors.New("手续费数据无法解析")
	}
	if resp.Maker == nil || resp.Taker == nil {
		return 0, 0, invalid("手续费回报缺少 commissionRate")
	}
	maker, taker := float64(*resp.Maker), float64(*resp.Taker)
	if maker < 0 || taker < 0 || maker > 0.05 || taker > 0.05 {
		return 0, 0, invalid("手续费回报不合理")
	}
	return maker, taker, nil
}

func protectiveAlgo(kind string) bool {
	switch kind {
	case "STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT":
		return true
	default:
		return false
	}
}

// ClosingFill 把开仓之后、平掉这一方向的成交合成一个出场价和数量。
// 空单的平仓成交是 BUY，多单是 SELL。开仓那一笔不拿来当出场价。
func (c *USDMClient) ClosingFill(symbol string, side Side, since, now time.Time) (price, qty float64, ok bool, err error) {
	leg, ok, err := c.ClosingTrade(symbol, side, since, now)
	if err != nil || !ok {
		return 0, 0, false, err
	}
	return leg.Price, leg.Qty, true, nil
}

// ClosingTrade 是止损或止盈的实际成交。Time 取最后一笔的成交时间，不用调度器醒来的时间。
func (c *USDMClient) ClosingTrade(symbol string, side Side, since, now time.Time) (TradeLeg, bool, error) {
	fills, err := c.Trades(symbol, since, now)
	if err != nil {
		return TradeLeg{}, false, err
	}
	leg, ok := closingLeg(fills, symbol, side, since, now)
	return leg, ok, nil
}

// Trades 读取 since 到 now 的 userTrades。区间按 7 天切开，和 income 一样。
func (c *USDMClient) Trades(symbol string, since, now time.Time) ([]UserFill, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	since = since.UTC()
	now = now.UTC()
	if symbol == "" || since.IsZero() {
		return nil, invalid("缺少成交起点")
	}
	if now.Before(since) {
		now = since
	}
	rows, err := c.listUserTrades(symbol, since, now, 0)
	if err != nil {
		return nil, err
	}
	out := make([]UserFill, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.asFill())
	}
	return out, nil
}

func (c *USDMClient) listUserTrades(symbol string, since, now time.Time, orderID int64) ([]userTrade, error) {
	if orderID > 0 {
		q := url.Values{}
		q.Set("symbol", strings.ToUpper(strings.TrimSpace(symbol)))
		q.Set("orderId", strconv.FormatInt(orderID, 10))
		q.Set("limit", "1000")
		body, err := c.signed(http.MethodGet, "/fapi/v1/userTrades", q)
		if err != nil {
			return nil, err
		}
		return parseUserTrades(body)
	}
	var all []userTrade
	for win := since; !win.After(now); {
		end := win.Add(incomeWindow)
		if end.After(now) {
			end = now
		}
		cursor := win
		for page := 0; page < 20; page++ {
			q := url.Values{}
			q.Set("symbol", symbol)
			q.Set("startTime", strconv.FormatInt(cursor.UnixMilli(), 10))
			q.Set("endTime", strconv.FormatInt(end.UnixMilli(), 10))
			q.Set("limit", "1000")
			body, err := c.signed(http.MethodGet, "/fapi/v1/userTrades", q)
			if err != nil {
				return nil, err
			}
			rows, err := parseUserTrades(body)
			if err != nil {
				return nil, err
			}
			if len(rows) == 0 {
				break
			}
			all = append(all, rows...)
			if len(rows) < 1000 {
				break
			}
			next := rows[len(rows)-1].Time.Add(time.Millisecond)
			if !next.After(cursor) {
				break
			}
			cursor = next
		}
		if !end.Before(now) {
			break
		}
		win = end.Add(time.Millisecond)
	}
	return all, nil
}

type userTrade struct {
	ID           int64
	OrderID      int64
	Symbol       string
	Side         string
	PositionSide string
	Price        float64
	Qty          float64
	Time         time.Time
}

func (t userTrade) asFill() UserFill {
	return UserFill{
		Symbol:       t.Symbol,
		OrderID:      t.OrderID,
		Side:         t.Side,
		PositionSide: t.PositionSide,
		Price:        t.Price,
		Qty:          t.Qty,
		Time:         t.Time,
	}
}

func parseUserTrades(body []byte) ([]userTrade, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	var raw []struct {
		ID           flexNum `json:"id"`
		OrderID      flexNum `json:"orderId"`
		Symbol       string  `json:"symbol"`
		Side         string  `json:"side"`
		PositionSide string  `json:"positionSide"`
		Price        flexNum `json:"price"`
		Qty          flexNum `json:"qty"`
		Time         flexNum `json:"time"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, errors.New("成交数据无法解析")
	}
	out := make([]userTrade, 0, len(raw))
	for _, row := range raw {
		out = append(out, userTrade{
			ID:           int64(row.ID),
			OrderID:      int64(row.OrderID),
			Symbol:       strings.ToUpper(strings.TrimSpace(row.Symbol)),
			Side:         strings.ToUpper(strings.TrimSpace(row.Side)),
			PositionSide: strings.ToUpper(strings.TrimSpace(row.PositionSide)),
			Price:        float64(row.Price),
			Qty:          float64(row.Qty),
			Time:         time.UnixMilli(int64(row.Time)).UTC(),
		})
	}
	return out, nil
}

// conditional 把止损挂到 Algo Order。止盈不走这里，改用 GTX 限价。
// 测网对经典 POST /fapi/v1/order 的 STOP_MARKET 返回 -4120。
// closePosition 会平掉整个仓位，不能和 quantity、reduceOnly 一起发。
func (c *USDMClient) conditional(symbol, side, posSide, orderType string, price float64, tickRaw, clientID string) (int64, error) {
	params := url.Values{}
	params.Set("algoType", "CONDITIONAL")
	params.Set("symbol", symbol)
	params.Set("side", side)
	params.Set("type", orderType)
	params.Set("triggerPrice", formatStep(price, 0, tickRaw))
	params.Set("closePosition", "true")
	params.Set("workingType", "MARK_PRICE")
	params.Set("clientAlgoId", ensureClientOrderID(clientID, "oo-sl-"))
	if posSide != "" {
		params.Set("positionSide", posSide)
	}
	body, err := c.signed(http.MethodPost, "/fapi/v1/algoOrder", params)
	if err != nil {
		return 0, err
	}
	return parseAlgoAck(body)
}

func parseAlgoAck(body []byte) (int64, error) {
	var resp struct {
		AlgoID flexNum `json:"algoId"`
		Code   int     `json:"code"`
		Msg    string  `json:"msg"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, &ExchangeError{Status: 200, Msg: "algo ack", Body: string(body)}
	}
	if resp.AlgoID <= 0 {
		return 0, &ExchangeError{Status: 200, Code: resp.Code, Msg: resp.Msg, Body: string(body)}
	}
	return int64(resp.AlgoID), nil
}

func (c *USDMClient) ConfigureAccount(symbol string, leverage int) error {
	if err := c.setIsolated(symbol); err != nil {
		return err
	}
	if err := c.setLeverage(symbol, leverage); err != nil {
		return err
	}
	_, err := c.hedge()
	return err
}

func (c *USDMClient) setIsolated(symbol string) error {
	_, err := c.signed(http.MethodPost, "/fapi/v1/marginType", url.Values{
		"symbol":     {symbol},
		"marginType": {"ISOLATED"},
	})
	if err == nil || errors.Is(err, errMarginUnchanged) {
		return nil
	}
	return err
}

func (c *USDMClient) setLeverage(symbol string, leverage int) error {
	_, err := c.signed(http.MethodPost, "/fapi/v1/leverage", url.Values{
		"symbol":   {symbol},
		"leverage": {strconv.Itoa(leverage)},
	})
	return err
}

func (c *USDMClient) hedge() (bool, error) {
	c.mu.Lock()
	if c.dual != nil {
		value := *c.dual
		c.mu.Unlock()
		return value, nil
	}
	c.mu.Unlock()
	body, err := c.signed(http.MethodGet, "/fapi/v1/positionSide/dual", url.Values{})
	if err != nil {
		return false, err
	}
	var resp struct {
		Dual bool `json:"dualSidePosition"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return false, err
	}
	c.mu.Lock()
	c.dual = &resp.Dual
	c.mu.Unlock()
	return resp.Dual, nil
}

type algoOrder struct {
	AlgoID        int64    `json:"algoId"`
	Symbol        string   `json:"symbol"`
	OrderType     string   `json:"orderType"`
	Type          string   `json:"type"`
	Side          string   `json:"side"`
	PositionSide  string   `json:"positionSide"`
	TriggerPrice  flexNum  `json:"triggerPrice"`
	StopPrice     flexNum  `json:"stopPrice"`
	ClosePosition flexBool `json:"closePosition"`
}

// flexBool 同时接受币安返回的 true 和 "true"。
type flexBool bool

func (b *flexBool) UnmarshalJSON(data []byte) error {
	if b == nil {
		return errors.New("nil")
	}
	text := strings.Trim(strings.TrimSpace(string(data)), `"`)
	switch strings.ToLower(text) {
	case "true", "1":
		*b = true
	case "false", "0", "null", "":
		*b = false
	default:
		return fmt.Errorf("closePosition %s", data)
	}
	return nil
}

func (o algoOrder) kind() string {
	if o.OrderType != "" {
		return o.OrderType
	}
	return o.Type
}

func (c *USDMClient) openAlgoOrders(symbol string) ([]algoOrder, error) {
	body, err := c.signed(http.MethodGet, "/fapi/v1/openAlgoOrders", url.Values{"symbol": {symbol}})
	if err != nil {
		return nil, err
	}
	rows, err := parseAlgoOrderList(body)
	if err != nil {
		return nil, err
	}
	out := make([]algoOrder, 0, len(rows))
	for _, row := range rows {
		if row.Symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

func (c *USDMClient) cancelAlgoOrders(symbol string) error {
	orders, err := c.openAlgoOrders(symbol)
	if err != nil {
		return err
	}
	for _, order := range orders {
		if order.AlgoID == 0 {
			continue
		}
		if err := c.cancelAlgo(order.AlgoID); err != nil {
			return err
		}
	}
	return nil
}

func (c *USDMClient) cancelAlgo(id int64) error {
	if id == 0 {
		return invalid("条件单缺少 algoId")
	}
	_, err := c.signed(http.MethodDelete, "/fapi/v1/algoOrder", url.Values{
		"algoId": {strconv.FormatInt(id, 10)},
	})
	if err != nil && !errors.Is(err, errNoOpenOrder) {
		return err
	}
	return nil
}

func parseAlgoOrderList(body []byte) ([]algoOrder, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	if body[0] == '{' {
		var wrap struct {
			Orders []algoOrder `json:"orders"`
		}
		if err := json.Unmarshal(body, &wrap); err != nil {
			return nil, err
		}
		return wrap.Orders, nil
	}
	var rows []algoOrder
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func algoTypes(orders []algoOrder) []string {
	out := make([]string, 0, len(orders))
	for _, order := range orders {
		if kind := order.kind(); kind != "" {
			out = append(out, kind)
		}
	}
	return out
}

func (c *USDMClient) rulesFor(symbol string) (MarketRules, symbolRules, error) {
	if _, err := c.Rules(symbol); err != nil {
		return MarketRules{}, symbolRules{}, err
	}
	c.mu.Lock()
	row := c.rules[strings.ToUpper(strings.TrimSpace(symbol))]
	c.mu.Unlock()
	if row.MinNotional <= 0 {
		row.MinNotional = MinNotionalUSDT
	}
	return row.MarketRules, row, nil
}

func (c *USDMClient) fetchRules(symbol string) (symbolRules, error) {
	body, err := c.public(http.MethodGet, "/fapi/v1/exchangeInfo", nil)
	if err != nil {
		return symbolRules{}, err
	}
	var info struct {
		Symbols []struct {
			Symbol  string `json:"symbol"`
			Filters []struct {
				FilterType  string `json:"filterType"`
				StepSize    string `json:"stepSize"`
				MinQty      string `json:"minQty"`
				TickSize    string `json:"tickSize"`
				Notional    string `json:"notional"`
				MinNotional string `json:"minNotional"`
			} `json:"filters"`
		} `json:"symbols"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return symbolRules{}, err
	}
	for _, item := range info.Symbols {
		if !strings.EqualFold(item.Symbol, symbol) {
			continue
		}
		var row symbolRules
		for _, filter := range item.Filters {
			switch filter.FilterType {
			case "MARKET_LOT_SIZE":
				row.StepSize = parseNum(filter.StepSize)
				row.MinQty = parseNum(filter.MinQty)
				row.stepRaw = filter.StepSize
			case "LOT_SIZE":
				if row.stepRaw == "" {
					row.StepSize = parseNum(filter.StepSize)
					row.MinQty = parseNum(filter.MinQty)
					row.stepRaw = filter.StepSize
				}
			case "PRICE_FILTER":
				row.TickSize = parseNum(filter.TickSize)
				row.tickRaw = filter.TickSize
			case "MIN_NOTIONAL":
				raw := filter.Notional
				if raw == "" {
					raw = filter.MinNotional
				}
				row.MinNotional = parseNum(raw)
			}
		}
		if row.MinNotional <= 0 {
			row.MinNotional = MinNotionalUSDT
		}
		return row, nil
	}
	return symbolRules{}, invalid("测网 exchangeInfo 里没有 " + symbol)
}

func (c *USDMClient) guard() error {
	if c != nil && c.readOnly {
		return ErrLiveTransportDisabled
	}
	if err := c.validateBase(); err != nil {
		return err
	}
	c.mu.Lock()
	creds := c.creds
	c.mu.Unlock()
	if creds.APIKey == "" || creds.APISecret == "" || !c.acceptsNetwork(creds.Network) {
		return ErrKeyNotUsable
	}
	return nil
}

func (c *USDMClient) validateBase() error {
	u, err := url.Parse(c.base)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return invalid("测网地址不正确")
	}
	host := strings.ToLower(u.Hostname())
	if host == "testnet.binancefuture.com" || host == "fapi.binance.com" {
		return nil
	}
	if strings.Contains(host, "binance") {
		return ErrLiveTransportDisabled
	}
	return nil
}

func (c *USDMClient) public(method, path string, params url.Values) ([]byte, error) {
	return c.do(method, path, params, Credentials{})
}

/*
credentialFingerprint 返回当前凭据的短指纹，用于账户读缓存的键。

**为什么必须有**：账户读（持仓/挂单/权益）是私有数据 —— 缓存键里
不带凭据指纹就会把 A 账号的持仓返回给 B 账号。这里只取 API Key 的
哈希前缀（不回传可识别的明文），足以区分不同账号。

未配置凭据时返回 "anon"：那种情况下签名请求本来就会失败，不会进缓存。
*/
func (c *USDMClient) credentialFingerprint() string {
	if c == nil {
		return "anon"
	}
	c.mu.Lock()
	key := c.creds.APIKey
	c.mu.Unlock()
	if strings.TrimSpace(key) == "" {
		return "anon"
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:8])
}

func (c *USDMClient) signed(method, path string, params url.Values) ([]byte, error) {
	if err := c.guard(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	creds := c.creds
	c.mu.Unlock()
	return c.do(method, path, params, creds)
}

// signedGET 读签名账户。只读客户端走 signedRead，交易客户端仍走 guard。
func (c *USDMClient) signedGET(path string, params url.Values) ([]byte, error) {
	if c != nil && c.readOnly {
		return c.signedRead(path, params)
	}
	return c.signed(http.MethodGet, path, params)
}

func (c *USDMClient) do(method, path string, params url.Values, creds Credentials) ([]byte, error) {
	if c != nil && c.readOnly && method != http.MethodGet {
		return nil, ErrLiveTransportDisabled
	}
	if err := c.validateBase(); err != nil {
		return nil, err
	}
	// 熔断期间直接返回，不碰网络 —— 对币安来说「封禁期间再发请求」就是续封。
	if until, blocked := banGate.blockedUntil(c.base); blocked {
		return nil, &UpstreamBanError{Base: c.base, Until: until}
	}
	query := cloneValues(params)
	if creds.APISecret != "" {
		query.Set("timestamp", strconv.FormatInt(time.Now().UnixMilli(), 10))
		query.Set("recvWindow", "5000")
		payload := query.Encode()
		mac := hmac.New(sha256.New, []byte(creds.APISecret))
		_, _ = mac.Write([]byte(payload))
		query = nil
		endpoint := c.base + path + "?" + payload + "&signature=" + hex.EncodeToString(mac.Sum(nil))
		return c.roundTrip(method, endpoint, creds.APIKey)
	}
	endpoint := c.base + path
	if encoded := query.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}
	return c.roundTrip(method, endpoint, "")
}

func (c *USDMClient) roundTrip(method, endpoint, apiKey string) ([]byte, error) {
	req, err := http.NewRequest(method, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		req.Header.Set("X-MBX-APIKEY", apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("币安测网请求失败: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	out, err := interpretBinance(resp.StatusCode, body)
	// 418/429 记入熔断：解封前不再发任何请求（见 upstream_gate.go）。
	c.noteUpstreamBan(resp.StatusCode, body, err)
	return out, err
}

var (
	errMarginUnchanged = errors.New("margin unchanged")
	errNoOpenOrder     = errors.New("no open order")
)

// ExchangeError 保留币安错误的 HTTP 状态、错误码、msg 和原始响应。
// 引擎把它写进事件流和进程日志，不丢字段。
type ExchangeError struct {
	Status int
	Code   int
	Msg    string
	Body   string
}

func (e *ExchangeError) Error() string {
	if e == nil {
		return ""
	}
	body := e.Body
	if len(body) > 2048 {
		body = body[:2048]
	}
	return fmt.Sprintf("binance status=%d code=%d msg=%s body=%s", e.Status, e.Code, e.Msg, body)
}

func interpretBinance(status int, body []byte) ([]byte, error) {
	var probe struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	_ = json.Unmarshal(body, &probe)
	switch probe.Code {
	case -4046:
		return body, errMarginUnchanged
	case -2011:
		return body, errNoOpenOrder
	}
	if probe.Code < 0 || status >= 300 {
		err := &ExchangeError{Status: status, Code: probe.Code, Msg: probe.Msg, Body: string(body)}
		log.Printf("[trading] %s", err.Error())
		return nil, err
	}
	return body, nil
}

type binanceOrder struct {
	OrderID     int64  `json:"orderId"`
	Status      string `json:"status"`
	AvgPrice    string `json:"avgPrice"`
	ExecutedQty string `json:"executedQty"`
	CumQuote    string `json:"cumQuote"`
	Side        string `json:"side"`
}

func decodeOrder(body []byte) (binanceOrder, error) {
	var resp binanceOrder
	if err := json.Unmarshal(body, &resp); err != nil {
		return binanceOrder{}, err
	}
	return resp, nil
}

// fillLookupTries 是订单回报没有均价时，改查 userTrades 的次数。第一次不等待。
var fillLookupTries = 5

// fillLookupGap 是两次 userTrades 查询之间的间隔。测试可以改成 0。
var fillLookupGap = 200 * time.Millisecond

// settleFill 用订单的 avgPrice 和 executedQty。两者都没有时查这笔 orderId 的 userTrades。
// 不用调用方传入的标记价。读不到成交就返回错误。
func (c *USDMClient) settleFill(symbol string, resp binanceOrder, side Side, qty float64) (Fill, error) {
	if mapStatus(resp.Status) != StatusFilled && resp.OrderID != 0 {
		body, err := c.signed(http.MethodGet, "/fapi/v1/order", url.Values{
			"symbol":  {symbol},
			"orderId": {strconv.FormatInt(resp.OrderID, 10)},
		})
		if err != nil {
			return Fill{}, err
		}
		resp, err = decodeOrder(body)
		if err != nil {
			return Fill{}, err
		}
	}
	fill := fillFromOrder(resp, side, 0, qty)
	if fill.FromExchange && fill.Price > 0 && fill.Qty > 0 {
		if fill.Status != StatusFilled {
			fill.Status = StatusFilled
		}
		return fill, nil
	}
	if resp.OrderID == 0 {
		return Fill{}, invalid("成交没有返回均价")
	}
	var last error
	tries := fillLookupTries
	if tries < 1 {
		tries = 1
	}
	for attempt := 0; attempt < tries; attempt++ {
		if attempt > 0 && fillLookupGap > 0 {
			time.Sleep(fillLookupGap)
		}
		rows, err := c.listUserTrades(symbol, time.Time{}, time.Time{}, resp.OrderID)
		if err != nil {
			last = err
			continue
		}
		got := vwapTrades(rows)
		if got.Price > 0 && got.Qty > 0 {
			return Fill{
				OrderID:      strconv.FormatInt(resp.OrderID, 10),
				Price:        got.Price,
				Qty:          got.Qty,
				Status:       StatusFilled,
				Side:         side,
				At:           got.Time,
				FromExchange: true,
			}, nil
		}
	}
	if last != nil {
		return Fill{}, last
	}
	return Fill{}, invalid("成交没有返回均价")
}

func vwapTrades(rows []userTrade) TradeLeg {
	var qty, quote float64
	var last time.Time
	for _, row := range rows {
		if row.Price <= 0 || row.Qty <= 0 {
			continue
		}
		qty += row.Qty
		quote += row.Price * row.Qty
		if last.IsZero() || row.Time.After(last) {
			last = row.Time
		}
	}
	if qty <= 0 {
		return TradeLeg{}
	}
	return TradeLeg{Price: quote / qty, Qty: qty, Time: last.UTC()}
}

func fillFromOrder(resp binanceOrder, side Side, fallback, qty float64) Fill {
	avg := parseNum(resp.AvgPrice)
	executed := parseNum(resp.ExecutedQty)
	quote := parseNum(resp.CumQuote)
	price := 0.0
	fromExchange := false
	if avg > 0 && executed > 0 {
		price = avg
		qty = executed
		fromExchange = true
	} else if executed > 0 && quote > 0 {
		price = quote / executed
		qty = executed
		fromExchange = true
	} else if fallback > 0 {
		price = fallback
	}
	if executed > 0 {
		qty = executed
	}
	status := mapStatus(resp.Status)
	if fromExchange && status != StatusFilled {
		status = StatusFilled
	}
	return Fill{
		OrderID:      strconv.FormatInt(resp.OrderID, 10),
		Price:        price,
		Qty:          qty,
		Status:       status,
		Side:         side,
		FromExchange: fromExchange,
	}
}

func mapStatus(status string) string {
	if strings.EqualFold(status, "FILLED") {
		return StatusFilled
	}
	return StatusSubmitted
}

func orderSide(side Side) string {
	if side == SideShort {
		return "SELL"
	}
	return "BUY"
}

func oppositeSide(side Side) string {
	if side == SideLong {
		return "SELL"
	}
	return "BUY"
}

func positionSide(side Side) string {
	if side == SideShort {
		return "SHORT"
	}
	return "LONG"
}

func hasType(types []string, want string) bool {
	for _, item := range types {
		if item == want {
			return true
		}
	}
	return false
}

func formatStep(value, step float64, raw string) string {
	if step > 0 {
		value = math.Floor((value/step)+1e-9) * step
	} else if raw != "" {
		tick := parseNum(raw)
		if tick > 0 {
			value = math.Round(value/tick) * tick
		}
	}
	prec := 8
	if places := decimalPlaces(raw); raw != "" {
		prec = places
	}
	return strconv.FormatFloat(value, 'f', prec, 64)
}

func roundToTick(price, tick float64) float64 {
	if tick <= 0 {
		return price
	}
	return math.Round(price/tick) * tick
}

func decimalPlaces(raw string) int {
	raw = strings.TrimSpace(raw)
	dot := strings.IndexByte(raw, '.')
	if dot < 0 {
		return 0
	}
	frac := strings.TrimRight(raw[dot+1:], "0")
	return len(frac)
}

func parseNum(raw string) float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return 0
	}
	return value
}

func cloneValues(in url.Values) url.Values {
	out := url.Values{}
	for key, values := range in {
		for _, value := range values {
			out.Add(key, value)
		}
	}
	return out
}
