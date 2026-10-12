package trading

import (
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// OrderRow 是按币安 orderId 记的一行。同一张单的多笔成交合成这一行的均价和手续费，
// 不同 orderId 不会并成一笔。价格来自 userTrades，不用标记价。
// 资金费来自 income 的 FUNDING_FEE，记在持仓期间对应的开仓单上。
type OrderRow struct {
	Symbol      string
	OrderID     string
	Role        string
	Side        string
	Price       float64
	Qty         float64
	RealizedPnL float64
	Commission  float64
	FundingFee  float64
	FilledAt    time.Time
}

// OrderBook 把对账结果落库。实现不得在持锁时再进引擎。
type OrderBook interface {
	Upsert(userID, strategyID int64, rows []OrderRow) error
}

var (
	orderBookMu sync.Mutex
	orderBook   OrderBook
)

// SetOrderBook 安装成交账本。重复调用会换掉上一个。
func SetOrderBook(book OrderBook) {
	orderBookMu.Lock()
	orderBook = book
	orderBookMu.Unlock()
}

func currentOrderBook() OrderBook {
	orderBookMu.Lock()
	defer orderBookMu.Unlock()
	return orderBook
}

// BuildOrderRows 把 userTrades 收成每个 orderId 一行。
// 均价是成交量加权，手续费是这些成交的 commission 之和。
// 已实现盈亏为 0 的单记成 entry，其余记成 exit。
// FUNDING_FEE 加到当时仍开着的那张开仓单上；对不上的尾数加到最后一张开仓单，
// 这样各行资金费之和与账单资金费之和相同。
// mark 参数只为了测试能证明标记价不会写进行情。函数不使用它。
func BuildOrderRows(trades []UserTrade, income []IncomeEvent, mark float64) []OrderRow {
	_ = mark
	grouped := map[string]*OrderRow{}
	order := make([]string, 0)
	for _, trade := range trades {
		id := strings.TrimSpace(trade.OrderID)
		if id == "" || id == "0" || trade.Qty <= 0 || trade.Price <= 0 {
			continue
		}
		row := grouped[id]
		if row == nil {
			row = &OrderRow{
				Symbol:   strings.ToUpper(strings.TrimSpace(trade.Symbol)),
				OrderID:  id,
				FilledAt: trade.Time.UTC(),
			}
			grouped[id] = row
			order = append(order, id)
		}
		row.Qty += trade.Qty
		row.Price += trade.Price * trade.Qty
		row.Commission += trade.Commission
		row.RealizedPnL += trade.RealizedPnl
		if !trade.Time.IsZero() && (row.FilledAt.IsZero() || trade.Time.Before(row.FilledAt)) {
			row.FilledAt = trade.Time.UTC()
		}
	}
	rows := make([]OrderRow, 0, len(order))
	for _, id := range order {
		row := grouped[id]
		if row.Qty <= 0 {
			continue
		}
		quote := row.Price
		row.Price = quote / row.Qty
		if math.Abs(row.RealizedPnL) < 1e-12 {
			row.RealizedPnL = 0
			row.Role = "entry"
		} else {
			row.Role = "exit"
		}
		rows = append(rows, *row)
	}
	rows = applySides(rows, trades)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].FilledAt.Equal(rows[j].FilledAt) {
			return rows[i].OrderID < rows[j].OrderID
		}
		return rows[i].FilledAt.Before(rows[j].FilledAt)
	})
	attributeFunding(rows, income)
	return rows
}

func applySides(rows []OrderRow, trades []UserTrade) []OrderRow {
	type hint struct {
		side string
		pos  string
	}
	hints := map[string]hint{}
	for _, trade := range trades {
		id := strings.TrimSpace(trade.OrderID)
		if _, ok := hints[id]; ok {
			continue
		}
		hints[id] = hint{side: trade.Side, pos: trade.PositionSide}
	}
	for i := range rows {
		got := hints[rows[i].OrderID]
		rows[i].Side = bookSide(got.side, rows[i].Role, got.pos)
	}
	return rows
}

func bookSide(orderSide, role, positionSide string) string {
	switch strings.ToUpper(strings.TrimSpace(positionSide)) {
	case "LONG":
		return string(SideLong)
	case "SHORT":
		return string(SideShort)
	}
	orderSide = strings.ToUpper(strings.TrimSpace(orderSide))
	if role == "entry" {
		if orderSide == "SELL" {
			return string(SideShort)
		}
		return string(SideLong)
	}
	if orderSide == "BUY" {
		return string(SideShort)
	}
	return string(SideLong)
}

func attributeFunding(rows []OrderRow, income []IncomeEvent) {
	if len(rows) == 0 {
		return
	}
	type span struct {
		idx   int
		start time.Time
		end   time.Time
	}
	var spans []span
	openIdx := -1
	var openStart time.Time
	for i := range rows {
		if rows[i].Role == "entry" {
			if openIdx >= 0 {
				spans = append(spans, span{idx: openIdx, start: openStart, end: rows[i].FilledAt})
			}
			openIdx = i
			openStart = rows[i].FilledAt
			continue
		}
		if rows[i].Role == "exit" && openIdx >= 0 {
			spans = append(spans, span{idx: openIdx, start: openStart, end: rows[i].FilledAt})
			openIdx = -1
		}
	}
	if openIdx >= 0 {
		spans = append(spans, span{idx: openIdx, start: openStart})
	}
	var leftover float64
	for _, event := range income {
		if strings.ToUpper(strings.TrimSpace(event.IncomeType)) != "FUNDING_FEE" {
			continue
		}
		when := event.Time.UTC()
		placed := false
		for _, sp := range spans {
			if when.Before(sp.start) {
				continue
			}
			if !sp.end.IsZero() && !when.Before(sp.end) {
				continue
			}
			rows[sp.idx].FundingFee += event.Income
			placed = true
			break
		}
		if !placed {
			leftover += event.Income
		}
	}
	if leftover == 0 {
		return
	}
	target := -1
	for i := range rows {
		if rows[i].Role == "entry" {
			target = i
		}
	}
	if target < 0 {
		target = len(rows) - 1
	}
	rows[target].FundingFee += leftover
}
