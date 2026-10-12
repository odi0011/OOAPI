package trading

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// 交易台只读行情和账户。实现不得发单，也不得把密钥写进日志。
// 公开 K 线、标记价不签名；持仓和挂单走已绑定账户的签名 GET。

const (
	OrderSourceBook = "order"
	OrderSourceAlgo = "algo"
	OrderKindEntry  = "entry"
	OrderKindStop   = "stop"
	OrderKindTake   = "takeProfit"
	OrderKindExit   = "exit"

	deskKlineDefault = 100
	deskKlineMax     = 500
)

// DeskCandle 是一根给折线或蜡烛用的 K 线。价格取交易所公开行情，不在这里补点。
type DeskCandle struct {
	OpenTime time.Time `json:"openTime"`
	Open     float64   `json:"open"`
	High     float64   `json:"high"`
	Low      float64   `json:"low"`
	Close    float64   `json:"close"`
}

// KeyPosition 是一把交易所密钥的 positionRisk 里仍开着的仓。
// 保证金是初始保证金（名义价值 / 杠杆），不是名义价值，也不是含浮盈的逐仓保证金。
type KeyPosition struct {
	Symbol   string
	Side     Side
	Qty      float64
	Entry    float64
	Leverage int
	Margin   float64
}

// InitialMargin 用数量、开仓价和该仓杠杆计算初始保证金。
// 数量为 0 的已平仓行不占额度。没有杠杆时才退回解析时记下的保证金。
func (p KeyPosition) InitialMargin() float64 {
	if p.Qty <= 0 {
		return 0
	}
	if p.Entry > 0 && p.Leverage >= 1 {
		return p.Qty * p.Entry / float64(p.Leverage)
	}
	if p.Margin > 0 {
		return p.Margin
	}
	return 0
}

// RiskView 是 positionRisk 里交易台要画的持仓。Open 为假表示空仓。
type RiskView struct {
	Open          bool
	Side          Side
	Qty           float64
	EntryPrice    float64
	MarkPrice     float64
	UnrealizedPnl float64
	Leverage      int
	Margin        float64
	MarginMode    string
}

// DeskOrder 是一张未完成的普通单或条件单。Kind 把入场、止损、止盈分开。
type DeskOrder struct {
	ID            string  `json:"id,omitempty"`
	Source        string  `json:"source"`
	Kind          string  `json:"kind"`
	Symbol        string  `json:"symbol,omitempty"`
	Side          string  `json:"side,omitempty"`
	Type          string  `json:"type,omitempty"`
	Status        string  `json:"status,omitempty"`
	Price         float64 `json:"price,omitempty"`
	StopPrice     float64 `json:"stopPrice,omitempty"`
	Qty           float64 `json:"qty,omitempty"`
	ReduceOnly    bool    `json:"reduceOnly,omitempty"`
	ClosePosition bool    `json:"closePosition,omitempty"`
}

// DeskBook 是交易台读取行情和账户的边界。只读客户端和测试假交易所都实现它。
type DeskBook interface {
	Klines(symbol, interval string, limit int) ([]DeskCandle, error)
	MarkPrice(symbol string) (float64, error)
	PositionRisk(symbol string) (RiskView, error)
	OpenOrders(symbol string) ([]DeskOrder, error)
	OpenAlgoOrders(symbol string) ([]DeskOrder, error)
	UseReadCredentials(Credentials) error
}

// NewDeskBook 按策略 mode 打开只读客户端。测网和实盘都只发 GET。
// 实盘下单要另走 NewExchange，并且测网门闩必须已经打开。这里不打开那道门。
func NewDeskBook(network string) (DeskBook, error) {
	network = strings.ToLower(strings.TrimSpace(network))
	var base string
	switch network {
	case ModeTestnet:
		base = BinanceUSDMTestnetBase
	case ModeLive:
		base = BinanceUSDMLiveBase
	default:
		return nil, ErrBadMode
	}
	client := NewUSDMClient(base)
	client.readOnly = true
	return client, nil
}

// UseReadCredentials 收下只读签名要用的密钥。交易客户端拒绝从这里收密钥。
// 实盘主机只接受 live 密钥，测网主机只接受 testnet 密钥。
func (c *USDMClient) UseReadCredentials(creds Credentials) error {
	if c == nil || !c.readOnly {
		return ErrKeyNotUsable
	}
	if creds.APIKey == "" || creds.APISecret == "" {
		return ErrKeyNotUsable
	}
	if creds.Network != ModeTestnet && creds.Network != ModeLive {
		return ErrKeyNotUsable
	}
	switch c.baseNetwork() {
	case ModeLive:
		if creds.Network != ModeLive {
			return ErrKeyNotUsable
		}
	case ModeTestnet:
		if creds.Network != ModeTestnet {
			return ErrKeyNotUsable
		}
	}
	c.mu.Lock()
	c.creds = creds
	c.mu.Unlock()
	return nil
}

func (c *USDMClient) baseNetwork() string {
	if c == nil {
		return ""
	}
	u, err := url.Parse(c.base)
	if err != nil {
		return ""
	}
	switch strings.ToLower(u.Hostname()) {
	case "fapi.binance.com":
		return ModeLive
	case "testnet.binancefuture.com":
		return ModeTestnet
	default:
		return ""
	}
}

// Klines 读公开 K 线。limit 缺省 100，上限 500。
func (c *USDMClient) Klines(symbol, interval string, limit int) ([]DeskCandle, error) {
	if err := c.readGuard(); err != nil {
		return nil, err
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	interval = strings.TrimSpace(interval)
	if symbol == "" || interval == "" {
		return nil, invalid("缺少交易对或周期")
	}
	if limit <= 0 {
		limit = deskKlineDefault
	}
	if limit > deskKlineMax {
		limit = deskKlineMax
	}
	body, err := c.public(http.MethodGet, "/fapi/v1/klines", url.Values{
		"symbol":   {symbol},
		"interval": {interval},
		"limit":    {strconv.Itoa(limit)},
	})
	if err != nil {
		return nil, redactNetErr(err)
	}
	bars, err := parseKlines(body)
	if err != nil {
		return nil, errors.New("K 线数据无法解析")
	}
	if bars == nil {
		bars = []DeskCandle{}
	}
	return bars, nil
}

// MarkPrice 读公开标记价。没有有效价格时返回错误，调用方不要用收盘价冒充。
func (c *USDMClient) MarkPrice(symbol string) (float64, error) {
	if err := c.readGuard(); err != nil {
		return 0, err
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return 0, invalid("缺少交易对")
	}
	body, err := c.public(http.MethodGet, "/fapi/v1/premiumIndex", url.Values{"symbol": {symbol}})
	if err != nil {
		return 0, redactNetErr(err)
	}
	price, err := parseMarkPrice(body)
	if err != nil {
		return 0, errors.New("标记价无法解析")
	}
	return price, nil
}

// PositionRisk 读签名后的持仓。没有仓位时 Open 为假，数量和盈亏留空。
func (c *USDMClient) PositionRisk(symbol string) (RiskView, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	body, err := c.signedRead("/fapi/v2/positionRisk", url.Values{"symbol": {symbol}})
	if err != nil {
		return RiskView{}, err
	}
	view, err := parsePositionRisk(symbol, body)
	if err != nil {
		return RiskView{}, errors.New("持仓数据无法解析")
	}
	return view, nil
}

// OpenOrders 读普通挂单，入场单在这里。
func (c *USDMClient) OpenOrders(symbol string) ([]DeskOrder, error) {
	return c.readOrders(OrderSourceBook, "/fapi/v1/openOrders", symbol)
}

// OpenAlgoOrders 读条件单。止损和止盈挂在 algo 服务上时走这里。
func (c *USDMClient) OpenAlgoOrders(symbol string) ([]DeskOrder, error) {
	return c.readOrders(OrderSourceAlgo, "/fapi/v1/openAlgoOrders", symbol)
}

func (c *USDMClient) readOrders(source, path, symbol string) ([]DeskOrder, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	body, err := c.signedRead(path, url.Values{"symbol": {symbol}})
	if err != nil {
		return nil, err
	}
	var orders []DeskOrder
	var parseErr error
	if source == OrderSourceAlgo {
		orders, parseErr = parseAlgoOrders(body)
	} else {
		orders, parseErr = parseOpenOrders(body)
	}
	if parseErr != nil {
		return nil, errors.New("委托数据无法解析")
	}
	if orders == nil {
		orders = []DeskOrder{}
	}
	return orders, nil
}

func (c *USDMClient) readGuard() error {
	if c == nil || c.base == "" {
		return invalid("缺少行情客户端")
	}
	return c.validateBase()
}

func (c *USDMClient) signedRead(path string, params url.Values) ([]byte, error) {
	if err := c.readGuard(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	creds := c.creds
	readOnly := c.readOnly
	c.mu.Unlock()
	if creds.APIKey == "" || creds.APISecret == "" {
		return nil, ErrKeyNotUsable
	}
	if !readOnly {
		if err := c.guard(); err != nil {
			return nil, err
		}
	}
	body, err := c.do(http.MethodGet, path, params, creds)
	if err != nil {
		return nil, redactNetErr(err)
	}
	return body, nil
}

func redactNetErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrKeyNotUsable) || errors.Is(err, ErrLiveTransportDisabled) || errors.Is(err, ErrBadMode) {
		return err
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "://") || strings.Contains(msg, "signature") || strings.Contains(msg, "x-mbx") {
		return errors.New("交易所请求失败")
	}
	return err
}

func parseKlines(body []byte) ([]DeskCandle, error) {
	var rows [][]json.RawMessage
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	out := make([]DeskCandle, 0, len(rows))
	for _, row := range rows {
		if len(row) < 5 {
			return nil, errors.New("short kline")
		}
		openMs, err := rawFloat(row[0])
		if err != nil {
			return nil, err
		}
		open, err := rawFloat(row[1])
		if err != nil {
			return nil, err
		}
		high, err := rawFloat(row[2])
		if err != nil {
			return nil, err
		}
		low, err := rawFloat(row[3])
		if err != nil {
			return nil, err
		}
		closePx, err := rawFloat(row[4])
		if err != nil {
			return nil, err
		}
		out = append(out, DeskCandle{
			OpenTime: time.UnixMilli(int64(openMs)).UTC(),
			Open:     open,
			High:     high,
			Low:      low,
			Close:    closePx,
		})
	}
	return out, nil
}

func parseMarkPrice(body []byte) (float64, error) {
	var row struct {
		MarkPrice string `json:"markPrice"`
	}
	if err := json.Unmarshal(body, &row); err != nil {
		return 0, err
	}
	price := parseNum(row.MarkPrice)
	if price <= 0 {
		return 0, errors.New("mark")
	}
	return price, nil
}

type riskRow struct {
	Symbol                string  `json:"symbol"`
	PositionAmt           flexNum `json:"positionAmt"`
	EntryPrice            flexNum `json:"entryPrice"`
	MarkPrice             flexNum `json:"markPrice"`
	UnRealizedProfit      flexNum `json:"unRealizedProfit"`
	UnrealizedProfit      flexNum `json:"unrealizedProfit"`
	Leverage              flexNum `json:"leverage"`
	IsolatedMargin        flexNum `json:"isolatedMargin"`
	PositionInitialMargin flexNum `json:"positionInitialMargin"`
	Notional              flexNum `json:"notional"`
	MarginType            string  `json:"marginType"`
	PositionSide          string  `json:"positionSide"`
}

func parsePositionRisk(symbol string, body []byte) (RiskView, error) {
	rows, err := decodeRiskRows(body)
	if err != nil {
		return RiskView{}, err
	}
	var best *riskRow
	bestAbs := 0.0
	for i := range rows {
		row := &rows[i]
		if row.Symbol != "" && symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		amt := float64(row.PositionAmt)
		if amt < 0 {
			amt = -amt
		}
		if amt == 0 || amt < bestAbs {
			continue
		}
		best = row
		bestAbs = amt
	}
	if best == nil {
		return RiskView{}, nil
	}
	amt := float64(best.PositionAmt)
	side := SideLong
	switch strings.ToUpper(best.PositionSide) {
	case "SHORT":
		side = SideShort
	case "LONG":
		side = SideLong
	default:
		if amt < 0 {
			side = SideShort
		}
	}
	if amt < 0 {
		amt = -amt
	}
	upl := float64(best.UnRealizedProfit)
	if upl == 0 {
		upl = float64(best.UnrealizedProfit)
	}
	margin := float64(best.IsolatedMargin)
	if margin == 0 {
		margin = float64(best.PositionInitialMargin)
	}
	return RiskView{
		Open:          true,
		Side:          side,
		Qty:           amt,
		EntryPrice:    float64(best.EntryPrice),
		MarkPrice:     float64(best.MarkPrice),
		UnrealizedPnl: upl,
		Leverage:      int(best.Leverage),
		Margin:        margin,
		MarginMode:    normalizeMargin(best.MarginType),
	}, nil
}

// parseAccountPositions 读整把密钥的 positionRisk。持仓量为 0 的行是已平仓，
// 即使还留着开仓价或逐仓保证金也不计入。
func parseAccountPositions(body []byte) ([]KeyPosition, error) {
	rows, err := decodeRiskRows(body)
	if err != nil {
		return nil, err
	}
	out := make([]KeyPosition, 0)
	for i := range rows {
		pos, ok := keyPositionFromRow(rows[i])
		if !ok {
			continue
		}
		out = append(out, pos)
	}
	return out, nil
}

func keyPositionFromRow(row riskRow) (KeyPosition, bool) {
	amt := float64(row.PositionAmt)
	if amt == 0 {
		return KeyPosition{}, false
	}
	side := SideLong
	switch strings.ToUpper(row.PositionSide) {
	case "SHORT":
		side = SideShort
	case "LONG":
		side = SideLong
	default:
		if amt < 0 {
			side = SideShort
		}
	}
	if amt < 0 {
		amt = -amt
	}
	lev := int(row.Leverage)
	entry := float64(row.EntryPrice)
	margin := 0.0
	switch {
	case entry > 0 && lev >= 1:
		margin = amt * entry / float64(lev)
	case row.Notional != 0 && lev >= 1:
		notional := float64(row.Notional)
		if notional < 0 {
			notional = -notional
		}
		margin = notional / float64(lev)
	case row.PositionInitialMargin > 0:
		margin = float64(row.PositionInitialMargin)
	case row.IsolatedMargin > 0:
		margin = float64(row.IsolatedMargin)
	}
	return KeyPosition{
		Symbol:   strings.ToUpper(strings.TrimSpace(row.Symbol)),
		Side:     side,
		Qty:      amt,
		Entry:    entry,
		Leverage: lev,
		Margin:   margin,
	}, true
}

func decodeRiskRows(body []byte) ([]riskRow, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	if body[0] == '{' {
		var one riskRow
		if err := json.Unmarshal(body, &one); err != nil {
			return nil, err
		}
		return []riskRow{one}, nil
	}
	var rows []riskRow
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

type rawDeskOrder struct {
	OrderID       flexNum `json:"orderId"`
	AlgoID        flexNum `json:"algoId"`
	Symbol        string  `json:"symbol"`
	Status        string  `json:"status"`
	AlgoStatus    string  `json:"algoStatus"`
	Type          string  `json:"type"`
	OrderType     string  `json:"orderType"`
	Side          string  `json:"side"`
	Price         flexNum `json:"price"`
	StopPrice     flexNum `json:"stopPrice"`
	TriggerPrice  flexNum `json:"triggerPrice"`
	OrigQty       flexNum `json:"origQty"`
	Quantity      flexNum `json:"quantity"`
	ReduceOnly    bool    `json:"reduceOnly"`
	ClosePosition bool    `json:"closePosition"`
}

func parseOpenOrders(body []byte) ([]DeskOrder, error) {
	rows, err := decodeOrderRows(body, false)
	if err != nil {
		return nil, err
	}
	return mapDeskOrders(OrderSourceBook, rows), nil
}

func parseAlgoOrders(body []byte) ([]DeskOrder, error) {
	rows, err := decodeOrderRows(body, true)
	if err != nil {
		return nil, err
	}
	return mapDeskOrders(OrderSourceAlgo, rows), nil
}

func decodeOrderRows(body []byte, algo bool) ([]rawDeskOrder, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	if body[0] == '{' {
		var wrap struct {
			Orders []rawDeskOrder `json:"orders"`
		}
		if err := json.Unmarshal(body, &wrap); err != nil {
			return nil, err
		}
		if wrap.Orders == nil && !algo {
			return nil, errors.New("orders")
		}
		return wrap.Orders, nil
	}
	var rows []rawDeskOrder
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func mapDeskOrders(source string, rows []rawDeskOrder) []DeskOrder {
	out := make([]DeskOrder, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.deskOrder(source))
	}
	return out
}

func (row rawDeskOrder) deskOrder(source string) DeskOrder {
	id := row.OrderID
	kindType := row.Type
	status := row.Status
	qty := row.OrigQty
	stop := row.StopPrice
	if source == OrderSourceAlgo {
		id = row.AlgoID
		if row.OrderType != "" {
			kindType = row.OrderType
		}
		if row.AlgoStatus != "" {
			status = row.AlgoStatus
		}
		if row.Quantity != 0 {
			qty = row.Quantity
		}
		if row.TriggerPrice != 0 {
			stop = row.TriggerPrice
		}
	}
	return DeskOrder{
		ID:            formatID(float64(id)),
		Source:        source,
		Kind:          orderKind(kindType, row.ReduceOnly, row.ClosePosition),
		Symbol:        strings.ToUpper(row.Symbol),
		Side:          strings.ToLower(row.Side),
		Type:          strings.ToUpper(kindType),
		Status:        strings.ToLower(status),
		Price:         float64(row.Price),
		StopPrice:     float64(stop),
		Qty:           float64(qty),
		ReduceOnly:    row.ReduceOnly,
		ClosePosition: row.ClosePosition,
	}
}

func orderKind(orderType string, reduceOnly, closePosition bool) string {
	switch strings.ToUpper(orderType) {
	case "STOP", "STOP_MARKET", "STOP_LOSS", "STOP_LOSS_LIMIT":
		return OrderKindStop
	case "TAKE_PROFIT", "TAKE_PROFIT_MARKET", "TAKE_PROFIT_LIMIT":
		return OrderKindTake
	default:
		if reduceOnly || closePosition {
			return OrderKindExit
		}
		return OrderKindEntry
	}
}

func normalizeMargin(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "isolated":
		return MarginIsolated
	case "cross", "crossed":
		return "cross"
	default:
		return ""
	}
}

func formatID(n float64) string {
	if n == 0 {
		return ""
	}
	return strconv.FormatInt(int64(n), 10)
}

func rawFloat(m json.RawMessage) (float64, error) {
	m = bytes.TrimSpace(m)
	if len(m) == 0 || string(m) == "null" {
		return 0, nil
	}
	if m[0] == '"' {
		var s string
		if err := json.Unmarshal(m, &s); err != nil {
			return 0, err
		}
		if strings.TrimSpace(s) == "" {
			return 0, nil
		}
		return strconv.ParseFloat(s, 64)
	}
	return strconv.ParseFloat(string(m), 64)
}

// flexNum 同时接受币安返回的字符串和数字。
type flexNum float64

func (n *flexNum) UnmarshalJSON(b []byte) error {
	if n == nil {
		return errors.New("nil")
	}
	v, err := rawFloat(b)
	if err != nil {
		return err
	}
	*n = flexNum(v)
	return nil
}
