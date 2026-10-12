package handlers

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"ooapi/internal/trading"
)

type engineTotals struct {
	Engines       int     `json:"engines"`
	OpenPositions int     `json:"openPositions"`
	UnrealizedPnl float64 `json:"unrealizedPnl"`
	RealizedPnl   float64 `json:"realizedPnl"`
	MarginInUse   float64 `json:"marginInUse"`
}

type engineListItem struct {
	StrategyID    int64                    `json:"strategyId"`
	Symbol        string                   `json:"symbol"`
	State         trading.State            `json:"state"`
	Side          trading.Side             `json:"side,omitempty"`
	Qty           float64                  `json:"qty"`
	EntryPrice    float64                  `json:"entryPrice"`
	MarkPrice     float64                  `json:"markPrice"`
	UnrealizedPnl float64                  `json:"unrealizedPnl"`
	RealizedPnl   float64                  `json:"realizedPnl"`
	LastReason    string                   `json:"lastReason,omitempty"`
	LastBacktest  *trading.BacktestSummary `json:"lastBacktest,omitempty"`
}

// ListTradingEngines 列出当前用户正在跑或已有会话的引擎，并给出合计。
func ListTradingEngines(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	rows, err := queryRows(strategyListSQL, user.ID)
	if err != nil {
		log.Printf("[trading] 查询引擎失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询引擎失败", "server_error")
		return
	}
	defer rows.Close()
	sessions := trading.DefaultHub().Sessions(user.ID)
	items := []engineListItem{}
	var totals engineTotals
	for rows.Next() {
		row, err := scanStrategy(rows)
		if err != nil {
			log.Printf("[trading] 读取引擎行失败: %v", err)
			continue
		}
		snap, found := sessions[row.ID]
		if !found && !row.Record.Running {
			continue
		}
		if !found {
			snap = trading.Snapshot{State: trading.StateIdle, Mode: row.Record.Mode}
		}
		item := engineListItem{
			StrategyID:    row.ID,
			Symbol:        row.Record.Symbol,
			State:         snap.State,
			Side:          snap.Side,
			Qty:           snap.Qty,
			EntryPrice:    snap.EntryPrice,
			MarkPrice:     snap.MarkPrice,
			UnrealizedPnl: snap.UnrealizedPnl,
			RealizedPnl:   snap.DayRealized,
			LastReason:    snap.LastReason,
			LastBacktest:  snap.LastBacktest,
		}
		items = append(items, item)
		totals.Engines++
		totals.UnrealizedPnl += snap.UnrealizedPnl
		totals.RealizedPnl += snap.DayRealized
		if engineOpen(snap) {
			totals.OpenPositions++
			if row.Record.Leverage > 0 && snap.Qty > 0 && snap.EntryPrice > 0 {
				totals.MarginInUse += snap.Qty * snap.EntryPrice / float64(row.Record.Leverage)
			}
		}
	}
	if err := rows.Err(); err != nil {
		log.Printf("[trading] 遍历引擎失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询引擎失败", "server_error")
		return
	}
	ok(c, gin.H{"items": items, "totals": totals})
}

func engineOpen(snap trading.Snapshot) bool {
	switch snap.State {
	case trading.StateInPosition, trading.StateExitSubmitted, trading.StateEntrySubmitted:
		return true
	default:
		return snap.Qty > 0 && snap.Side != ""
	}
}
