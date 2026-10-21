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

// PublicClient 按策略 mode 选公开行情主机。测网走 testnet，实盘走 fapi。
func PublicClient(mode string) *USDMClient {
	if strings.EqualFold(strings.TrimSpace(mode), ModeLive) {
		return NewUSDMClient(BinanceUSDMLiveBase)
	}
	return NewUSDMTestnet()
}

// Candles 拉公开 K 线，含成交量。startMs 为 0 时由交易所从最近一根往前给。
func (c *USDMClient) Candles(symbol, interval string, startMs int64, limit int) ([]Candle, error) {
	if err := c.readGuard(); err != nil {
		return nil, err
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	interval = strings.TrimSpace(interval)
	if symbol == "" || interval == "" {
		return nil, invalid("缺少交易对或周期")
	}
	if limit <= 0 || limit > 1500 {
		limit = 1500
	}
	q := url.Values{
		"symbol":   {symbol},
		"interval": {interval},
		"limit":    {strconv.Itoa(limit)},
	}
	if startMs > 0 {
		q.Set("startTime", strconv.FormatInt(startMs, 10))
	}
	body, err := c.public(http.MethodGet, "/fapi/v1/klines", q)
	if err != nil {
		return nil, redactNetErr(err)
	}
	bars, err := parseCandles(body)
	if err != nil {
		return nil, errors.New("K 线数据无法解析")
	}
	if bars == nil {
		bars = []Candle{}
	}
	return bars, nil
}

// USDTBalance 读签名账户里的 USDT 钱包余额和可用余额。
func (c *USDMClient) USDTBalance() (wallet, available float64, err error) {
	body, err := c.signedGET("/fapi/v2/balance", nil)
	if err != nil {
		return 0, 0, err
	}
	var rows []struct {
		Asset     string `json:"asset"`
		Balance   string `json:"balance"`
		Available string `json:"availableBalance"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return 0, 0, errors.New("余额数据无法解析")
	}
	for _, row := range rows {
		if strings.EqualFold(row.Asset, "USDT") {
			return parseNum(row.Balance), parseNum(row.Available), nil
		}
	}
	return 0, 0, invalid("账户里没有 USDT 余额")
}

// AccountEquity 是钱包余额加上全部持仓的未实现盈亏。
type AccountEquity struct {
	Wallet     float64
	Available  float64
	Unrealized float64
	Equity     float64
	MarginUsed float64
}

// ReadEquity 优先读 /fapi/v2/account 的 totalWalletBalance + totalUnrealizedProfit。
// 账户接口失败时，用 USDT 钱包余额加上 positionRisk 里每一笔未实现盈亏。
//
// 走账户缓存：看板轮询和引擎暂停线判定都调它，账户接口权重不低，
// 没有缓存时请求量随「在线人数 × 刷新频率」线性增长。
// 键里带凭据指纹 —— 权益是账户私有数据，不带会串号。
func (c *USDMClient) ReadEquity() (AccountEquity, error) {
	key := marketCacheKey(c.base, "equity", c.credentialFingerprint())
	value, err := accountCache.get(key, func() (accountCacheValue, error) {
		eq, err := c.readEquityUncached()
		if err != nil {
			return accountCacheValue{}, err
		}
		return accountCacheValue{Equity: &eq}, nil
	})
	if err != nil {
		return AccountEquity{}, err
	}
	if value.Equity == nil {
		return AccountEquity{}, errors.New("账户权益无法解析")
	}
	return *value.Equity, nil
}

func (c *USDMClient) readEquityUncached() (AccountEquity, error) {
	body, err := c.signedGET("/fapi/v2/account", nil)
	if err == nil {
		eq, perr := parseAccountEquity(body)
		if perr == nil {
			return eq, nil
		}
		err = perr
	}
	wallet, available, werr := c.USDTBalance()
	riskBody, rerr := c.signedGET("/fapi/v2/positionRisk", nil)
	if werr != nil || rerr != nil {
		if err != nil {
			return AccountEquity{}, err
		}
		if werr != nil {
			return AccountEquity{}, werr
		}
		return AccountEquity{}, rerr
	}
	unrealized, perr := parseUnrealizedSum(riskBody)
	if perr != nil {
		return AccountEquity{}, perr
	}
	margin, _ := parseMarginUsed(riskBody)
	return AccountEquity{
		Wallet:     wallet,
		Available:  available,
		Unrealized: unrealized,
		Equity:     wallet + unrealized,
		MarginUsed: margin,
	}, nil
}

func parseAccountEquity(body []byte) (AccountEquity, error) {
	var resp struct {
		TotalWalletBalance         string `json:"totalWalletBalance"`
		TotalUnrealizedProfit      string `json:"totalUnrealizedProfit"`
		AvailableBalance           string `json:"availableBalance"`
		TotalPositionInitialMargin string `json:"totalPositionInitialMargin"`
		TotalInitialMargin         string `json:"totalInitialMargin"`
		Assets                     []struct {
			Asset            string `json:"asset"`
			WalletBalance    string `json:"walletBalance"`
			UnrealizedProfit string `json:"unrealizedProfit"`
			AvailableBalance string `json:"availableBalance"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return AccountEquity{}, errors.New("账户权益无法解析")
	}
	if strings.TrimSpace(resp.TotalWalletBalance) == "" && strings.TrimSpace(resp.TotalUnrealizedProfit) == "" {
		return AccountEquity{}, errors.New("账户权益缺少 totalWalletBalance")
	}
	wallet := parseNum(resp.TotalWalletBalance)
	unrealized := parseNum(resp.TotalUnrealizedProfit)
	available := parseNum(resp.AvailableBalance)
	if available == 0 {
		for _, asset := range resp.Assets {
			if strings.EqualFold(asset.Asset, "USDT") {
				available = parseNum(asset.AvailableBalance)
				break
			}
		}
	}
	margin := parseNum(resp.TotalPositionInitialMargin)
	if margin == 0 {
		margin = parseNum(resp.TotalInitialMargin)
	}
	return AccountEquity{
		Wallet:     wallet,
		Available:  available,
		Unrealized: unrealized,
		Equity:     wallet + unrealized,
		MarginUsed: margin,
	}, nil
}

func parseMarginUsed(body []byte) (float64, error) {
	rows, err := decodeRiskRows(body)
	if err != nil {
		return 0, err
	}
	var sum float64
	for _, row := range rows {
		pos, ok := keyPositionFromRow(row)
		if !ok {
			continue
		}
		sum += pos.InitialMargin()
	}
	return sum, nil
}

func parseUnrealizedSum(body []byte) (float64, error) {
	rows, err := decodeRiskRows(body)
	if err != nil {
		return 0, errors.New("持仓盈亏无法解析")
	}
	var sum float64
	for _, row := range rows {
		if float64(row.PositionAmt) == 0 {
			continue
		}
		upl := float64(row.UnRealizedProfit)
		if upl == 0 {
			upl = float64(row.UnrealizedProfit)
		}
		sum += upl
	}
	return sum, nil
}

// LoadCandles 按时间窗口分页拉取已收盘 K 线。
func LoadCandles(mode, symbol, interval string, since, now time.Time) ([]Candle, error) {
	return loadCandles(mode, symbol, interval, since, now, false)
}

func loadCandles(mode, symbol, interval string, since, now time.Time, includeOpen bool) ([]Candle, error) {
	client := PublicClient(mode)
	tf := TimeframeDuration(interval)
	var all []Candle
	cursor := since.UTC().UnixMilli()
	for page := 0; page < 8; page++ {
		batch, err := client.Candles(symbol, interval, cursor, 1500)
		if err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			break
		}
		all = append(all, batch...)
		last := batch[len(batch)-1].OpenTime.UnixMilli()
		if last <= cursor {
			break
		}
		cursor = last + 1
		if len(batch) < 1500 {
			break
		}
	}
	return scanCandles(now, tf, all, includeOpen), nil
}

// scanCandles 平时丢掉未收盘的最后一根。实盘加速时保留，分数才能跟着正在走的这根变。
func scanCandles(now time.Time, tf time.Duration, candles []Candle, includeOpen bool) []Candle {
	if includeOpen {
		out := make([]Candle, len(candles))
		copy(out, candles)
		return out
	}
	return ClosedCandles(now, tf, candles)
}

func parseCandles(body []byte) ([]Candle, error) {
	var rows [][]json.RawMessage
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	out := make([]Candle, 0, len(rows))
	for _, row := range rows {
		if len(row) < 5 {
			return nil, errors.New("short kline")
		}
		openMs, err := rawFloat(row[0])
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
		var vol float64
		if len(row) > 5 {
			vol, _ = rawFloat(row[5])
		}
		out = append(out, Candle{
			OpenTime: time.UnixMilli(int64(openMs)).UTC(),
			High:     high,
			Low:      low,
			Close:    closePx,
			Volume:   vol,
		})
	}
	return out, nil
}
