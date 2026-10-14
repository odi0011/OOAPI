package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/trading"
)

// GetTradingBacktest 用币安 USDT-M 实盘公开 K 线重放 trend 开平规则。
// 胜率和 netR 已计入 taker 手续费（单边 0.05%）和滑点（单边 0.02%）。
func GetTradingBacktest(c *gin.Context) {
	if _, okUser := requireTradingUser(c); !okUser {
		return
	}
	symbol := strings.ToUpper(strings.TrimSpace(c.Query("symbol")))
	if symbol == "" {
		symbol = trading.SymbolXRPUSDT
	}
	if !trading.AllowedSymbol(symbol) {
		fail(c, http.StatusBadRequest, "交易对只支持 2–12 位大写字母或数字加 USDT（如 XRPUSDT）", "invalid_symbol")
		return
	}
	tf := strings.TrimSpace(c.DefaultQuery("timeframe", trading.Timeframe5m))
	if !trading.AllowedTimeframe(tf) {
		fail(c, http.StatusBadRequest, "K 线周期只支持 "+trading.SupportedTimeframes, "invalid_timeframe")
		return
	}
	days := 7
	if raw := strings.TrimSpace(c.Query("days")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 30 {
			fail(c, http.StatusBadRequest, "days 要在 1 到 30 之间", "bad_request")
			return
		}
		days = n
	}
	now := time.Now().UTC()
	since := now.Add(-time.Duration(days+2) * 24 * time.Hour)
	candles, err := trading.LoadCandles(trading.ModeLive, symbol, tf, since, now)
	if err != nil {
		fail(c, http.StatusBadGateway, "拉取 K 线失败", "market_unavailable")
		return
	}
	higher, err := trading.LoadCandles(trading.ModeLive, symbol, trading.HigherTimeframe, since, now)
	if err != nil {
		fail(c, http.StatusBadGateway, "拉取高周期 K 线失败", "market_unavailable")
		return
	}
	cfg := trading.DefaultConfig()
	cfg.Symbol = symbol
	cfg.Timeframe = tf
	cfg.EntryMode = trading.EntryModeTrend
	cfg.MinScore = trading.DefaultMinScore
	cfg.MinWinRate = trading.DefaultMinWinRate
	cfg.ExchangeKeyID = 1
	res, err := trading.Backtest(cfg, candles, higher)
	if err != nil {
		fail(c, http.StatusInternalServerError, "回测失败", "server_error")
		return
	}
	from := now.Add(-time.Duration(days) * 24 * time.Hour)
	res = clipBacktest(res, from)
	res.Symbol = symbol
	res.Timeframe = tf
	res.Days = days
	ok(c, res)
}

func clipBacktest(res trading.BacktestResult, from time.Time) trading.BacktestResult {
	kept := make([]trading.BacktestTrade, 0, len(res.Trades))
	res.Wins = 0
	res.NetR = 0
	for _, trade := range res.Trades {
		if trade.OpenedAt.Before(from) {
			continue
		}
		kept = append(kept, trade)
		res.NetR += trade.NetR
		if trade.NetR > 0 {
			res.Wins++
		}
	}
	res.Trades = kept
	res.TradeCount = len(kept)
	res.WinRate = 0
	if res.TradeCount > 0 {
		res.WinRate = float64(res.Wins) / float64(res.TradeCount)
	}
	return res
}
