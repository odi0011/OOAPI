package handlers

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/trading"
)

// 余额看板：用策略绑定密钥读账户权益、今日盈亏和内存权益曲线。
// 密钥只在服务端签名，不下发到浏览器。

var (
	sessionEquityMu sync.Mutex
	sessionEquity   = map[int64]float64{}
)

// GetTradingBalance 返回账户级余额、今日盈亏、权益历史和当前持仓。
// strategyId 用来定位密钥与网络；曲线按 exchangeKeyId 分桶。
func GetTradingBalance(c *gin.Context) {
	user, row, okRow := deskRow(c)
	if !okRow {
		return
	}
	book, okBook := signedDesk(c, user.ID, row)
	if !okBook {
		return
	}
	account, okAccount := book.(trading.DeskAccountBook)
	if !okAccount {
		fail(c, http.StatusBadGateway, "当前交易所客户端不支持账户快照", "exchange_unavailable")
		return
	}

	now := time.Now().UTC()
	eq, err := account.ReadEquity()
	if err != nil {
		writeDeskErr(c, err)
		return
	}
	positions, err := account.ListOpenPositions()
	if err != nil {
		writeDeskErr(c, err)
		return
	}
	if positions == nil {
		positions = []trading.PanelPosition{}
	}

	dayStart := trading.ShanghaiDayStart(now)
	incomeOK := true
	tradePnL, allIncome := 0.0, 0.0
	rows, ierr := account.AccountIncomeHistory(dayStart, now)
	if ierr != nil {
		incomeOK = false
	} else {
		tradePnL, allIncome = trading.TodayTradePnL(rows, now)
	}

	keyID := row.Record.ExchangeKeyID
	sessionBase := rememberSessionEquity(keyID, eq.Equity)
	today := trading.ComputeTodayPanelPnL(eq, tradePnL, allIncome, incomeOK, sessionBase)

	points, markers := trading.RecordEquitySample(keyID, now, eq, positions)
	viewSince := now.Add(-trading.EquityHistoryDefaultView)
	viewPoints := make([]trading.EquityPoint, 0, len(points))
	for _, p := range points {
		if p.T >= viewSince.UnixMilli() {
			viewPoints = append(viewPoints, p)
		}
	}
	viewMarkers := make([]trading.EquityMarker, 0, len(markers))
	for _, m := range markers {
		if m.T >= viewSince.UnixMilli() {
			viewMarkers = append(viewMarkers, m)
		}
	}
	viewPoints = trading.SmoothEquityPoints(viewPoints, 3)

	boostUntil := trading.BoostUntil()
	var boostUntilText string
	if !boostUntil.IsZero() && now.Before(boostUntil) {
		boostUntilText = boostUntil.UTC().Format(time.RFC3339)
	}

	ok(c, gin.H{
		"strategyId":    row.ID,
		"exchangeKeyId": keyID,
		"network":       row.Record.Mode,
		"symbol":        row.Record.Symbol,
		"wallet":        eq.Wallet,
		"available":     eq.Available,
		"unrealized":    eq.Unrealized,
		"equity":        eq.Equity,
		"marginUsed":    eq.MarginUsed,
		"todayPnl":      today.TodayPnL,
		"todayRealized": today.TodayRealized,
		"todayPct":      today.TodayPct,
		"todayBase":     today.TodayBase,
		"todaySrc":      today.TodaySrc,
		"updatedAt":     now.Format(time.RFC3339),
		"history":       viewPoints,
		"markers":       viewMarkers,
		"positions":     positions,
		"boostUntil":    boostUntilText,
	})
}

func rememberSessionEquity(keyID int64, equity float64) float64 {
	sessionEquityMu.Lock()
	defer sessionEquityMu.Unlock()
	if keyID <= 0 {
		keyID = 0
	}
	if base, ok := sessionEquity[keyID]; ok {
		return base
	}
	sessionEquity[keyID] = equity
	return equity
}

func resetSessionEquityForTest() {
	sessionEquityMu.Lock()
	defer sessionEquityMu.Unlock()
	sessionEquity = map[int64]float64{}
}
