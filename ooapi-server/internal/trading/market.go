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
	body, err := c.signed(http.MethodGet, "/fapi/v2/balance", nil)
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
			Close:    closePx,
			Volume:   vol,
		})
	}
	return out, nil
}
