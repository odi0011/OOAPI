package trading

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// USDMClient 向币安 USDT-M 测试网发单。默认主机是 testnet.binancefuture.com。
// 实盘主机在发单路径上直接拒绝，不会拨号。密钥只接受 network=testnet。
// readOnly 为真时只允许 GET：交易台用它读行情、持仓和挂单，实盘主机也只开这一条只读路径。
type USDMClient struct {
	base     string
	http     *http.Client
	mu       sync.Mutex
	creds    Credentials
	rules    map[string]symbolRules
	dual     *bool
	readOnly bool
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

// UseCredentials 只收下测试网密钥。调用发生在发单或同步持仓之前。
func (c *USDMClient) UseCredentials(creds Credentials) error {
	if creds.Network != ModeTestnet || creds.APIKey == "" || creds.APISecret == "" {
		return ErrKeyNotUsable
	}
	c.mu.Lock()
	c.creds = creds
	c.mu.Unlock()
	return nil
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
		return Fill{}, invalid("测网只接受逐仓且杠杆不超过 3")
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
	if err := c.setIsolated(req.Symbol); err != nil {
		return Fill{}, err
	}
	if err := c.setLeverage(req.Symbol, req.Leverage); err != nil {
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
	if mapStatus(resp.Status) != StatusFilled && resp.OrderID != 0 {
		body, err = c.signed(http.MethodGet, "/fapi/v1/order", url.Values{
			"symbol":  {req.Symbol},
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
	return fillFromOrder(resp, req.Side, req.Price, qty), nil
}

func (c *USDMClient) PlaceProtection(req Protection) error {
	if err := c.guard(); err != nil {
		return err
	}
	if req.Stop <= 0 || req.Take <= 0 {
		return invalid("保护单价格必须大于 0")
	}
	pos, err := c.Position(req.Symbol)
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
	open, err := c.openOrders(req.Symbol)
	if err != nil {
		return err
	}
	if hasType(open, "STOP_MARKET") && hasType(open, "TAKE_PROFIT_MARKET") {
		return nil
	}
	if len(open) > 0 {
		if err := c.CancelOpen(req.Symbol); err != nil {
			return err
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
	// closePosition 会平掉整个仓位。币安不允许它和 reduceOnly、quantity 同时出现。
	exit := oppositeSide(side)
	if err := c.conditional(req.Symbol, exit, posSide, "STOP_MARKET", stop, raw.tickRaw); err != nil {
		return err
	}
	if err := c.conditional(req.Symbol, exit, posSide, "TAKE_PROFIT_MARKET", take, raw.tickRaw); err != nil {
		return err
	}
	open, err = c.openOrders(req.Symbol)
	if err != nil {
		return err
	}
	if !hasType(open, "STOP_MARKET") || !hasType(open, "TAKE_PROFIT_MARKET") {
		return invalid("保护单没有在测网挂上")
	}
	return nil
}

func (c *USDMClient) Close(req CloseOrder) (Fill, error) {
	if err := c.guard(); err != nil {
		return Fill{}, err
	}
	if err := c.CancelOpen(req.Symbol); err != nil {
		return Fill{}, err
	}
	pos, err := c.Position(req.Symbol)
	if err != nil {
		return Fill{}, err
	}
	if !pos.Open {
		price := req.Price
		if price <= 0 {
			price = pos.Entry
		}
		return Fill{Status: StatusFilled, Price: price, Qty: pos.Qty, Side: pos.Side}, nil
	}
	rules, raw, err := c.rulesFor(req.Symbol)
	if err != nil {
		return Fill{}, err
	}
	qty := AlignQuantity(pos.Qty, rules.StepSize, rules.MinQty)
	if qty <= 0 {
		return Fill{}, invalid("持仓数量无法按步长平仓")
	}
	hedge, err := c.hedge()
	if err != nil {
		return Fill{}, err
	}
	params := url.Values{}
	params.Set("symbol", req.Symbol)
	params.Set("side", oppositeSide(pos.Side))
	params.Set("type", "MARKET")
	params.Set("quantity", formatStep(qty, rules.StepSize, raw.stepRaw))
	params.Set("newOrderRespType", "RESULT")
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
	return fillFromOrder(resp, pos.Side, req.Price, qty), nil
}

func (c *USDMClient) CancelOpen(symbol string) error {
	if err := c.guard(); err != nil {
		return err
	}
	_, err := c.signed(http.MethodDelete, "/fapi/v1/allOpenOrders", url.Values{"symbol": {symbol}})
	if err == nil || errors.Is(err, errNoOpenOrder) {
		return nil
	}
	return err
}

func (c *USDMClient) Position(symbol string) (Position, error) {
	if err := c.guard(); err != nil {
		return Position{}, err
	}
	body, err := c.signed(http.MethodGet, "/fapi/v2/positionRisk", url.Values{"symbol": {symbol}})
	if err != nil {
		return Position{}, err
	}
	var rows []struct {
		Symbol       string `json:"symbol"`
		PositionAmt  string `json:"positionAmt"`
		EntryPrice   string `json:"entryPrice"`
		PositionSide string `json:"positionSide"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return Position{}, err
	}
	for _, row := range rows {
		if row.Symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		amt, err := strconv.ParseFloat(row.PositionAmt, 64)
		if err != nil || amt == 0 {
			continue
		}
		entry, _ := strconv.ParseFloat(row.EntryPrice, 64)
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
		return Position{Open: true, Side: side, Qty: amt, Entry: entry}, nil
	}
	return Position{}, nil
}

func (c *USDMClient) conditional(symbol, side, posSide, orderType string, price float64, tickRaw string) error {
	params := url.Values{}
	params.Set("symbol", symbol)
	params.Set("side", side)
	params.Set("type", orderType)
	params.Set("stopPrice", formatStep(price, 0, tickRaw))
	params.Set("closePosition", "true")
	params.Set("workingType", "MARK_PRICE")
	if posSide != "" {
		params.Set("positionSide", posSide)
	}
	_, err := c.signed(http.MethodPost, "/fapi/v1/order", params)
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

func (c *USDMClient) openOrders(symbol string) ([]string, error) {
	body, err := c.signed(http.MethodGet, "/fapi/v1/openOrders", url.Values{"symbol": {symbol}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Type)
	}
	return out, nil
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
	if creds.Network != ModeTestnet || creds.APIKey == "" || creds.APISecret == "" {
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
	if host == "testnet.binancefuture.com" {
		return nil
	}
	if host == "fapi.binance.com" {
		if c.readOnly {
			return nil
		}
		return ErrLiveTransportDisabled
	}
	if strings.Contains(host, "binance") {
		return ErrLiveTransportDisabled
	}
	return nil
}

func (c *USDMClient) public(method, path string, params url.Values) ([]byte, error) {
	return c.do(method, path, params, Credentials{})
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

func (c *USDMClient) do(method, path string, params url.Values, creds Credentials) ([]byte, error) {
	if c != nil && c.readOnly && method != http.MethodGet {
		return nil, ErrLiveTransportDisabled
	}
	if err := c.validateBase(); err != nil {
		return nil, err
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
	return interpretBinance(resp.StatusCode, body)
}

var (
	errMarginUnchanged = errors.New("margin unchanged")
	errNoOpenOrder     = errors.New("no open order")
)

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
	if probe.Code < 0 {
		return nil, fmt.Errorf("币安测网 %d：%s", probe.Code, probe.Msg)
	}
	if status >= 300 {
		return nil, fmt.Errorf("币安测网 HTTP %d", status)
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

func fillFromOrder(resp binanceOrder, side Side, fallback, qty float64) Fill {
	price := parseNum(resp.AvgPrice)
	if price <= 0 {
		executed := parseNum(resp.ExecutedQty)
		quote := parseNum(resp.CumQuote)
		if executed > 0 && quote > 0 {
			price = quote / executed
		}
	}
	if price <= 0 {
		price = fallback
	}
	if filled := parseNum(resp.ExecutedQty); filled > 0 {
		qty = filled
	}
	return Fill{
		OrderID: strconv.FormatInt(resp.OrderID, 10),
		Price:   price,
		Qty:     qty,
		Status:  mapStatus(resp.Status),
		Side:    side,
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
