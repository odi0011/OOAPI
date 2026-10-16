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
	// Volume 是基础资产成交量（币安 klines 第 6 列）。
	// 多因子画像的「量能」项要用它；不参与下单，缺了也不影响交易。
	Volume float64 `json:"volume,omitempty"`
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
	// Entry 是这张入场单对应的开仓快照。止损止盈不带。
	Entry *EntryStamp `json:"entry,omitempty"`
}

// PanelPosition 是账户级持仓一行，给余额看板用。
type PanelPosition struct {
	Symbol        string  `json:"symbol"`
	Open          bool    `json:"open"`
	Side          Side    `json:"side,omitempty"`
	Qty           float64 `json:"qty,omitempty"`
	EntryPrice    float64 `json:"entryPrice,omitempty"`
	MarkPrice     float64 `json:"markPrice,omitempty"`
	UnrealizedPnl float64 `json:"unrealizedPnl,omitempty"`
	Leverage      int     `json:"leverage,omitempty"`
	Margin        float64 `json:"margin,omitempty"`
	MarginMode    string  `json:"marginMode,omitempty"`
}

// DeskBook 是交易台读取行情和账户的边界。只读客户端和测试假交易所都实现它。
type DeskBook interface {
	Klines(symbol, interval string, limit int) ([]DeskCandle, error)
	MarkPrice(symbol string) (float64, error)
	// Ticker24h 读 24h 统计。看板的涨跌幅/成交量只能用交易所的真实值 ——
	// 早先前端拿实时价除一个写死的旧开盘价，页面显示的是假涨跌。
	Ticker24h(symbol string) (Ticker24h, error)
	PositionRisk(symbol string) (RiskView, error)
	OpenOrders(symbol string) ([]DeskOrder, error)
	OpenAlgoOrders(symbol string) ([]DeskOrder, error)
	UseReadCredentials(Credentials) error
}

// DeskAccountBook 是余额看板额外需要的账户快照。旧假交易所可以不实现。
type DeskAccountBook interface {
	DeskBook
	ReadEquity() (AccountEquity, error)
	ListOpenPositions() ([]PanelPosition, error)
	AccountIncomeHistory(since, now time.Time) ([]IncomeEvent, error)
}

// NewDeskBook 按策略 mode 打开只读客户端。测网和实盘都只发 GET。
// 实盘下单要另走 NewExchange，并且测网门闩必须已经打开。这里不打开那道门。
func NewDeskBook(network string) (DeskBook, error) {
	base, err := usdmBaseFor(network)
	if err != nil {
		return nil, err
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

// spotHostNetwork 返回币安现货主机对应的网络；不是现货主机时返回空串。
// 现货测网（testnet.binance.vision）与合约测网是两套独立系统，各有自己的主机。
func spotHostNetwork(host string) string {
	switch strings.ToLower(strings.TrimSpace(host)) {
	case "api.binance.com":
		return ModeLive
	case "testnet.binance.vision":
		return ModeTestnet
	default:
		return ""
	}
}

func (c *USDMClient) baseNetwork() string {
	if c == nil {
		return ""
	}
	u, err := url.Parse(c.base)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "fapi.binance.com":
		return ModeLive
	case "testnet.binancefuture.com":
		return ModeTestnet
	}
	// 现货主机也认：现货客户端（划转 / 现货交易）的 base 就是这些主机，
	// 不认的话 UseCredentials 会把该网络下合法的密钥判成不可用。
	return spotHostNetwork(host)
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
	/*
		走共享缓存：看板每轮刷新会对每个币种各拉一次 K 线，
		全部直连币安会打满权重配额（实测把服务器 IP 打成 418 封禁）。
		缓存 3 秒，短于页面轮询周期，展示上感觉不到差别。
	*/
	key := marketCacheKey(c.base, symbol, interval, strconv.Itoa(limit))
	return klineCache.get(key, func() ([]DeskCandle, error) {
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
	})
}

// MarkPrice 读公开标记价。没有有效价格时返回错误，调用方不要用收盘价冒充。
func (c *USDMClient) MarkPrice(symbol string) (float64, error) {
	upper := strings.ToUpper(strings.TrimSpace(symbol))
	if err := c.readGuard(); err != nil {
		return 0, err
	}
	if upper == "" {
		return 0, invalid("缺少交易对")
	}
	// 与 K 线同样走缓存：标记价被高频读取（每轮刷新每币一次）
	key := marketCacheKey(c.base, upper, "mark")
	return markPriceCache.get(key, func() (float64, error) {
		price, _, err := c.MarkQuote(upper)
		return price, err
	})
}

// Ticker24h 是交易所 24 小时统计（公开接口，不需要密钥）。
//
// 这些数字**必须**从交易所读：界面上的涨跌幅、成交量、持仓量只有来自同一份
// 快照才自洽。早先前端把「24h 开盘价」写死在资产档案里当基准，再拿实时价去除 ——
// 算出来的是「相对几周前某个时刻」的涨跌，页面上却是 -42% 这种数字，
// 与真实的 24 小时波动（±2% 以内）差了二十倍，属于看起来像真数据的假数据。
type Ticker24h struct {
	Symbol        string
	LastPrice     float64
	OpenPrice     float64
	HighPrice     float64
	LowPrice      float64
	PriceChange   float64
	ChangePercent float64
	QuoteVolume   float64
	Volume        float64
}

// Ticker24h 读公开的 24 小时行情统计。
func (c *USDMClient) Ticker24h(symbol string) (Ticker24h, error) {
	if err := c.readGuard(); err != nil {
		return Ticker24h{}, err
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return Ticker24h{}, invalid("缺少交易对")
	}
	// 同样走缓存（24h 涨跌幅本身是分钟级变化的量）
	key := marketCacheKey(c.base, symbol, "ticker24h")
	return tickerCache.get(key, func() (Ticker24h, error) {
		body, err := c.public(http.MethodGet, "/fapi/v1/ticker/24hr", url.Values{"symbol": {symbol}})
		if err != nil {
			return Ticker24h{}, redactNetErr(err)
		}
		return parseTicker24h(body)
	})
}

// parseTicker24h 解析币安 24h 统计。
//
// 字段是字符串（币安所有行情接口都这样），且价格类字段可能为空串 ——
// 空串不能当 0，否则「没有数据」会被画成「价格归零」。
func parseTicker24h(body []byte) (Ticker24h, error) {
	var raw struct {
		Symbol             string `json:"symbol"`
		LastPrice          string `json:"lastPrice"`
		OpenPrice          string `json:"openPrice"`
		HighPrice          string `json:"highPrice"`
		LowPrice           string `json:"lowPrice"`
		PriceChange        string `json:"priceChange"`
		PriceChangePercent string `json:"priceChangePercent"`
		QuoteVolume        string `json:"quoteVolume"`
		Volume             string `json:"volume"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return Ticker24h{}, errors.New("24h 行情无法解析")
	}
	out := Ticker24h{
		Symbol:        strings.ToUpper(strings.TrimSpace(raw.Symbol)),
		LastPrice:     parseNum(raw.LastPrice),
		OpenPrice:     parseNum(raw.OpenPrice),
		HighPrice:     parseNum(raw.HighPrice),
		LowPrice:      parseNum(raw.LowPrice),
		PriceChange:   parseNum(raw.PriceChange),
		QuoteVolume:   parseNum(raw.QuoteVolume),
		Volume:        parseNum(raw.Volume),
		ChangePercent: parseNum(raw.PriceChangePercent),
	}
	if out.LastPrice <= 0 {
		return Ticker24h{}, errors.New("24h 行情没有有效价格")
	}
	return out, nil
}

// MarkQuote 读公开标记价与最新资金费率（/fapi/v1/premiumIndex）。
func (c *USDMClient) MarkQuote(symbol string) (float64, float64, error) {
	if err := c.readGuard(); err != nil {
		return 0, 0, err
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return 0, 0, invalid("缺少交易对")
	}
	body, err := c.public(http.MethodGet, "/fapi/v1/premiumIndex", url.Values{"symbol": {symbol}})
	if err != nil {
		return 0, 0, redactNetErr(err)
	}
	price, funding, err := parseMarkQuote(body)
	if err != nil {
		return 0, 0, errors.New("标记价无法解析")
	}
	return price, funding, nil
}

// PositionRisk 读签名后的持仓。没有仓位时 Open 为假，数量和盈亏留空。
func (c *USDMClient) PositionRisk(symbol string) (RiskView, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	// 走账户缓存：键里带凭据指纹 —— 不带就会把 A 账号的持仓给 B 账号。
	key := marketCacheKey(c.base, "risk", c.credentialFingerprint(), symbol)
	value, err := accountCache.get(key, func() (accountCacheValue, error) {
		body, err := c.signedRead("/fapi/v2/positionRisk", url.Values{"symbol": {symbol}})
		if err != nil {
			return accountCacheValue{}, err
		}
		view, err := parsePositionRisk(symbol, body)
		if err != nil {
			return accountCacheValue{}, errors.New("持仓数据无法解析")
		}
		return accountCacheValue{Risk: &view}, nil
	})
	if err != nil {
		return RiskView{}, err
	}
	if value.Risk == nil {
		return RiskView{}, errors.New("持仓数据无法解析")
	}
	return *value.Risk, nil
}

// OpenOrders 读普通挂单，入场单在这里。
func (c *USDMClient) OpenOrders(symbol string) ([]DeskOrder, error) {
	return c.readOrders(OrderSourceBook, "/fapi/v1/openOrders", symbol)
}

// OpenAlgoOrders 读条件单。止损和止盈挂在 algo 服务上时走这里。
func (c *USDMClient) OpenAlgoOrders(symbol string) ([]DeskOrder, error) {
	return c.readOrders(OrderSourceAlgo, "/fapi/v1/openAlgoOrders", symbol)
}

// ListOpenPositions 读整账户仍开着的仓。
//
// 走账户缓存：看板每轮刷新都会调它，键里带凭据指纹 ——
// 整账户持仓是私有数据，不带指纹会把 A 账号的仓返回给 B 账号。
func (c *USDMClient) ListOpenPositions() ([]PanelPosition, error) {
	key := marketCacheKey(c.base, "positions", c.credentialFingerprint())
	value, err := accountCache.get(key, func() (accountCacheValue, error) {
		body, err := c.signedRead("/fapi/v2/positionRisk", nil)
		if err != nil {
			return accountCacheValue{}, err
		}
		rows, err := decodeRiskRows(body)
		if err != nil {
			return accountCacheValue{}, errors.New("持仓数据无法解析")
		}
		out := make([]PanelPosition, 0)
		for i := range rows {
			view, ok := panelPositionFromRow(rows[i])
			if !ok {
				continue
			}
			out = append(out, view)
		}
		if out == nil {
			out = []PanelPosition{}
		}
		return accountCacheValue{OpenPositions: out}, nil
	})
	if err != nil {
		return nil, err
	}
	if value.OpenPositions == nil {
		return []PanelPosition{}, nil
	}
	return value.OpenPositions, nil
}

func panelPositionFromRow(row riskRow) (PanelPosition, bool) {
	pos, ok := keyPositionFromRow(row)
	if !ok {
		return PanelPosition{}, false
	}
	upl := float64(row.UnRealizedProfit)
	if upl == 0 {
		upl = float64(row.UnrealizedProfit)
	}
	return PanelPosition{
		Symbol:        pos.Symbol,
		Open:          true,
		Side:          pos.Side,
		Qty:           pos.Qty,
		EntryPrice:    pos.Entry,
		MarkPrice:     float64(row.MarkPrice),
		UnrealizedPnl: upl,
		Leverage:      pos.Leverage,
		Margin:        pos.InitialMargin(),
		MarginMode:    normalizeMargin(row.MarginType),
	}, true
}

func (c *USDMClient) readOrders(source, path, symbol string) ([]DeskOrder, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	// 账户私有数据：缓存键必须带凭据指纹，否则会串号
	key := marketCacheKey(c.base, "orders", source, c.credentialFingerprint(), symbol)
	value, err := accountCache.get(key, func() (accountCacheValue, error) {
		body, err := c.signedRead(path, url.Values{"symbol": {symbol}})
		if err != nil {
			return accountCacheValue{}, err
		}
		var orders []DeskOrder
		var parseErr error
		if source == OrderSourceAlgo {
			orders, parseErr = parseAlgoOrders(body)
		} else {
			orders, parseErr = parseOpenOrders(body)
		}
		if parseErr != nil {
			return accountCacheValue{}, errors.New("委托数据无法解析")
		}
		if orders == nil {
			orders = []DeskOrder{}
		}
		if source == OrderSourceAlgo {
			return accountCacheValue{AlgoOrders: orders}, nil
		}
		return accountCacheValue{BookOrders: orders}, nil
	})
	if err != nil {
		return nil, err
	}
	if source == OrderSourceAlgo {
		if value.AlgoOrders == nil {
			return []DeskOrder{}, nil
		}
		return value.AlgoOrders, nil
	}
	if value.BookOrders == nil {
		return []DeskOrder{}, nil
	}
	return value.BookOrders, nil
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
		// 成交量是可选列：老版本上游或测试桩可能只给到收盘价。
		// 缺列时留 0，不报错 —— 量能因子会因此算不出来，那是如实反映。
		volume := 0.0
		if len(row) > 5 {
			if v, vErr := rawFloat(row[5]); vErr == nil {
				volume = v
			}
		}
		out = append(out, DeskCandle{
			OpenTime: time.UnixMilli(int64(openMs)).UTC(),
			Open:     open,
			High:     high,
			Low:      low,
			Close:    closePx,
			Volume:   volume,
		})
	}
	return out, nil
}

func parseMarkPrice(body []byte) (float64, error) {
	price, _, err := parseMarkQuote(body)
	return price, err
}

func parseMarkQuote(body []byte) (float64, float64, error) {
	var row struct {
		MarkPrice       string `json:"markPrice"`
		LastFundingRate string `json:"lastFundingRate"`
	}
	if err := json.Unmarshal(body, &row); err != nil {
		return 0, 0, err
	}
	price := parseNum(row.MarkPrice)
	if price <= 0 {
		return 0, 0, errors.New("mark")
	}
	funding := parseNum(row.LastFundingRate)
	return price, funding, nil
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
	TimeInForce   string  `json:"timeInForce"`
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
		Kind:          orderKind(kindType, row.ReduceOnly, row.ClosePosition, row.TimeInForce),
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

func orderKind(orderType string, reduceOnly, closePosition bool, tif string) string {
	switch strings.ToUpper(orderType) {
	case "STOP", "STOP_MARKET", "STOP_LOSS", "STOP_LOSS_LIMIT":
		return OrderKindStop
	case "TAKE_PROFIT", "TAKE_PROFIT_MARKET", "TAKE_PROFIT_LIMIT":
		return OrderKindTake
	default:
		if strings.EqualFold(tif, "GTX") {
			return OrderKindTake
		}
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

/*
AllTickers 一次拉回全市场 24h 统计（不带 symbol 参数）。

**为什么要批量**：单个币种查 ticker/24hr 的权重是 40；看板有 8 个币种，
逐个查一轮就是 320 权重。批量端点一次拿回全部 793 个交易对，总权重也是 40 ——
差 8 倍。实测中这个差别决定了服务器 IP 会不会被币安限流封禁。

返回按交易对（大写）索引的映射，调用方直接查表。
*/
func (c *USDMClient) AllTickers() (map[string]Ticker24h, error) {
	if err := c.readGuard(); err != nil {
		return nil, err
	}
	key := marketCacheKey(c.base, "all-tickers")
	return bulkTickerCache.get(key, func() (map[string]Ticker24h, error) {
		body, err := c.public(http.MethodGet, "/fapi/v1/ticker/24hr", nil)
		if err != nil {
			return nil, redactNetErr(err)
		}
		return parseAllTickers(body)
	})
}

// parseAllTickers 解析批量 24h 统计（数组形式，字段为字符串）。
func parseAllTickers(body []byte) (map[string]Ticker24h, error) {
	var rows []struct {
		Symbol             string `json:"symbol"`
		LastPrice          string `json:"lastPrice"`
		OpenPrice          string `json:"openPrice"`
		HighPrice          string `json:"highPrice"`
		LowPrice           string `json:"lowPrice"`
		PriceChange        string `json:"priceChange"`
		PriceChangePercent string `json:"priceChangePercent"`
		QuoteVolume        string `json:"quoteVolume"`
		Volume             string `json:"volume"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, errors.New("批量 24h 行情无法解析")
	}
	out := make(map[string]Ticker24h, len(rows))
	for _, row := range rows {
		symbol := strings.ToUpper(strings.TrimSpace(row.Symbol))
		if symbol == "" {
			continue
		}
		last := parseNum(row.LastPrice)
		if last <= 0 {
			// 没有有效价格的行跳过：宁可不给，也不用 0 冒充
			continue
		}
		out[symbol] = Ticker24h{
			Symbol:        symbol,
			LastPrice:     last,
			OpenPrice:     parseNum(row.OpenPrice),
			HighPrice:     parseNum(row.HighPrice),
			LowPrice:      parseNum(row.LowPrice),
			PriceChange:   parseNum(row.PriceChange),
			ChangePercent: parseNum(row.PriceChangePercent),
			QuoteVolume:   parseNum(row.QuoteVolume),
			Volume:        parseNum(row.Volume),
		}
	}
	return out, nil
}

/*
AllMarkQuotes 一次拉回全市场标记价与资金费率。

批量端点（不带 symbol）总量不大且权重固定，比逐币查询省得多。
返回按交易对（大写）索引的映射。
*/
func (c *USDMClient) AllMarkQuotes() (map[string]MarkQuoteView, error) {
	if err := c.readGuard(); err != nil {
		return nil, err
	}
	key := marketCacheKey(c.base, "all-marks")
	return bulkMarkCache.get(key, func() (map[string]MarkQuoteView, error) {
		body, err := c.public(http.MethodGet, "/fapi/v1/premiumIndex", nil)
		if err != nil {
			return nil, redactNetErr(err)
		}
		return parseAllMarkQuotes(body)
	})
}

// parseAllMarkQuotes 解析批量标记价。上游可能返回单对象（带 symbol）或数组。
func parseAllMarkQuotes(body []byte) (map[string]MarkQuoteView, error) {
	trimmed := bytes.TrimSpace(body)
	out := map[string]MarkQuoteView{}
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var rows []struct {
			Symbol          string `json:"symbol"`
			MarkPrice       string `json:"markPrice"`
			LastFundingRate string `json:"lastFundingRate"`
		}
		if err := json.Unmarshal(trimmed, &rows); err != nil {
			return nil, errors.New("批量标记价无法解析")
		}
		for _, row := range rows {
			symbol := strings.ToUpper(strings.TrimSpace(row.Symbol))
			price := parseNum(row.MarkPrice)
			if symbol == "" || price <= 0 {
				continue
			}
			out[symbol] = MarkQuoteView{MarkPrice: price, Funding: parseNum(row.LastFundingRate)}
		}
		return out, nil
	}
	// 单对象
	var one struct {
		Symbol          string `json:"symbol"`
		MarkPrice       string `json:"markPrice"`
		LastFundingRate string `json:"lastFundingRate"`
	}
	if err := json.Unmarshal(trimmed, &one); err != nil {
		return nil, errors.New("批量标记价无法解析")
	}
	symbol := strings.ToUpper(strings.TrimSpace(one.Symbol))
	price := parseNum(one.MarkPrice)
	if symbol == "" || price <= 0 {
		return out, nil
	}
	out[symbol] = MarkQuoteView{MarkPrice: price, Funding: parseNum(one.LastFundingRate)}
	return out, nil
}
