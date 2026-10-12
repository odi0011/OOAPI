package trading

import (
	"log"
	"strings"
	"time"
)

// EntryBookInterval 是回补未平开仓记录的间隔。
// 和持仓期间的空仓核对分开：引擎重启后不再处于 InPosition，那条核对不会看见旧行。
const EntryBookInterval = 45 * time.Second

// incomePostGrace 给止盈成交之后才入账的手续费留一点时间。
const incomePostGrace = 5 * time.Second

// tradeSinceSlack 弥补开仓时间只存到秒、成交时间带到毫秒的差别。
const tradeSinceSlack = 2 * time.Second

// TradeLeg 是同一方向多笔成交合成的价格、数量和时间。
type TradeLeg struct {
	Price float64
	Qty   float64
	Time  time.Time
}

// UserFill 是 /fapi/v1/userTrades 里的一笔。
type UserFill struct {
	Symbol       string
	OrderID      int64
	Side         string
	PositionSide string
	Price        float64
	Qty          float64
	Time         time.Time
}

// EntryBook 是回补开仓记录要用的只读交易所接口。不发单，也不改引擎状态。
type EntryBook interface {
	PositionSide(symbol string, side Side) (Position, error)
	Trades(symbol string, since, now time.Time) ([]UserFill, error)
	IncomeParts(symbol string, since, now time.Time) (IncomeParts, error)
}

// CloseFlatEntries 把交易所上已经空仓、库里 closed_at 仍为空的开仓补上出场。
// 出场价和时间来自平仓方向的 userTrades，净盈亏来自这窗口里的 income。
// 仓位还在、成交或账单还没到时留着，下一轮再试。
func CloseFlatEntries(book EntryBook, rows []EntryRecord, now time.Time) (int, error) {
	if book == nil {
		return 0, invalid("没有交易所可对账")
	}
	now = at(now)
	closed := 0
	var first error
	for _, row := range rows {
		if !row.ClosedAt.IsZero() {
			continue
		}
		n, err := closeFlatEntry(book, row, now)
		if err != nil {
			log.Printf("[trading] book entry %d %s %s: %v", row.ID, row.Symbol, row.Side, err)
			if first == nil {
				first = err
			}
			continue
		}
		closed += n
	}
	return closed, first
}

func closeFlatEntry(book EntryBook, row EntryRecord, now time.Time) (int, error) {
	side, ok := sideOf(row.Side)
	if !ok || strings.TrimSpace(row.Symbol) == "" || row.OpenedAt.IsZero() {
		return 0, nil
	}
	pos, err := book.PositionSide(row.Symbol, side)
	if err != nil {
		return 0, err
	}
	since := row.OpenedAt.Add(-tradeSinceSlack)
	if pos.Open {
		reviseEntryFromFills(book, row, side, since, now)
		return 0, nil
	}
	fills, err := book.Trades(row.Symbol, since, now)
	if err != nil {
		return 0, err
	}
	opened, openOK := openingLeg(fills, row.Symbol, side, since, now)
	if openOK {
		reviseOpen(row, opened)
	}
	closed, closeOK := closingLeg(fills, row.Symbol, side, since, now)
	if !closeOK || closed.Price <= 0 || closed.Qty <= 0 || closed.Time.IsZero() {
		return 0, nil
	}
	end := closed.Time.Add(incomePostGrace)
	if end.After(now) {
		end = now
	}
	if end.Before(since) {
		end = now
	}
	parts, err := book.IncomeParts(row.Symbol, since, end)
	if err != nil {
		return 0, err
	}
	// 开仓手续费会先入账。没有 REALIZED_PNL 时先不关行，避免把净盈亏写成只有手续费。
	if !parts.HasRealized {
		return 0, nil
	}
	if err := CloseEntry(row.ID, row.UserID, row.StrategyID, row.Symbol, row.Side, ExitFill{
		Price:    closed.Price,
		Qty:      closed.Qty,
		Realized: parts.Net(),
		Reason:   ReasonExchangeFlat,
		ClosedAt: closed.Time,
	}); err != nil {
		return 0, err
	}
	return 1, nil
}

func reviseEntryFromFills(book EntryBook, row EntryRecord, side Side, since, now time.Time) {
	fills, err := book.Trades(row.Symbol, since, now)
	if err != nil || len(fills) == 0 {
		return
	}
	opened, ok := openingLeg(fills, row.Symbol, side, since, now)
	if !ok {
		return
	}
	reviseOpen(row, opened)
}

func reviseOpen(row EntryRecord, opened TradeLeg) {
	if opened.Price <= 0 || opened.Qty <= 0 {
		return
	}
	if !differs(row.EntryPrice, opened.Price) && !differs(row.Qty, opened.Qty) {
		return
	}
	if err := ReviseOpenEntry(row.ID, opened.Price, opened.Qty); err != nil {
		log.Printf("[trading] revise entry %d: %v", row.ID, err)
	}
}

func differs(a, b float64) bool {
	if a > b {
		return a-b > 1e-8
	}
	return b-a > 1e-8
}

func sideOf(raw string) (Side, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(SideLong), "buy":
		return SideLong, true
	case string(SideShort), "sell":
		return SideShort, true
	default:
		return "", false
	}
}

func openingLeg(fills []UserFill, symbol string, side Side, since, now time.Time) (TradeLeg, bool) {
	return legFromFills(fills, symbol, side, orderSide(side), since, now)
}

func closingLeg(fills []UserFill, symbol string, side Side, since, now time.Time) (TradeLeg, bool) {
	return legFromFills(fills, symbol, side, oppositeSide(side), since, now)
}

func legFromFills(fills []UserFill, symbol string, side Side, wantOrder string, since, now time.Time) (TradeLeg, bool) {
	wantPos := positionSide(side)
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	since = since.UTC()
	now = now.UTC()
	var qty, quote float64
	var last time.Time
	for _, tr := range fills {
		if tr.Symbol != "" && symbol != "" && !strings.EqualFold(tr.Symbol, symbol) {
			continue
		}
		when := tr.Time.UTC()
		if !when.IsZero() && (when.Before(since) || when.After(now)) {
			continue
		}
		ps := strings.ToUpper(strings.TrimSpace(tr.PositionSide))
		if ps == "LONG" || ps == "SHORT" {
			if ps != wantPos {
				continue
			}
		}
		if !strings.EqualFold(tr.Side, wantOrder) {
			continue
		}
		if tr.Price <= 0 || tr.Qty <= 0 {
			continue
		}
		qty += tr.Qty
		quote += tr.Price * tr.Qty
		if last.IsZero() || when.After(last) {
			last = when
		}
	}
	if qty <= 0 {
		return TradeLeg{}, false
	}
	return TradeLeg{Price: quote / qty, Qty: qty, Time: last}, true
}
