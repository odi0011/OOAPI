package trading

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// FlatReconcileInterval 是持仓期间向币安核对 positionRisk 的间隔。
// 止损或止盈可以在两根 K 线之间成交。调度器平时睡到下一根收盘，
// 这段间隔让空仓核对不依赖那根 K 线，也不会改开仓、加速或风控门。
const FlatReconcileInterval = 8 * time.Second

// ReconcileFlat 在 InPosition 时读一次该合约、该持仓方向的 positionRisk。
// 仓位还在就只刷新数量。仓位已经被条件单打平，就撤掉同一方向剩下的保护单，
// 用币安账单记已实现，补上开仓记录的出场，再回到 Armed。
// 调用方一次只推进一个线程，不要和 Step 并发。
func (e *Engine) ReconcileFlat(now time.Time) (Snapshot, error) {
	if e == nil || e.State() != StateInPosition || !e.syncsPosition() {
		return e.Snapshot(), nil
	}
	e.lastDetail = ""
	e.stepAt = at(now)
	if err := e.authorize(); err != nil {
		return e.Snapshot(), err
	}
	pos, err := e.livePosition()
	if err != nil {
		log.Printf("[trading] reconcile %s: %v", e.cfg.Symbol, err)
		return e.Snapshot(), err
	}
	if pos.Open {
		e.pos.Qty = pos.Qty
		if pos.Entry > 0 {
			e.pos.Entry = pos.Entry
		}
		return e.Snapshot(), nil
	}
	snap, err := e.finishExchangeFlat(StepInput{Now: now})
	if err != nil || e.State() == StateInPosition {
		return snap, err
	}
	e.captureIncome(at(now))
	snap = e.Snapshot()
	e.recordTick(StepInput{Now: now}, snap, nil)
	return snap, nil
}

// livePosition 只看这台引擎自己的持仓方向。
// 双向持仓会同时返回 LONG 和 SHORT。另一边还有数量时，不能把本边已经归零的空单当成还在持仓。
func (e *Engine) livePosition() (Position, error) {
	if src, ok := e.ex.(interface {
		PositionSide(symbol string, side Side) (Position, error)
	}); ok {
		return src.PositionSide(e.cfg.Symbol, e.pos.Side)
	}
	pos, err := e.ex.Position(e.cfg.Symbol)
	if err != nil || !pos.Open || e.pos.Side == "" || pos.Side == e.pos.Side {
		return pos, err
	}
	return Position{}, nil
}

type flatBook struct {
	parts    IncomeParts
	price    float64
	qty      float64
	closedAt time.Time
	ready    bool
}

// finishExchangeFlat 处理交易所已经空仓、引擎还停在 InPosition 的情况。
// 以前这条路径写在 stepPosition 里，只有 Step 被调用时才会走。
// 调度器在非加速时段要睡到下一根 K 线收盘，止盈成交后引擎会一直停在 InPosition，
// 同一方向剩下的止损条件单也继续挂着。
// 这里不按标记价再发一张市价平仓单。盈亏以账单里的 REALIZED_PNL、COMMISSION、FUNDING_FEE 为准，
// 出场价和数量用来自 userTrades 的实际成交。账单或成交还没入账时保持 InPosition，下一轮再试。
func (e *Engine) finishExchangeFlat(in StepInput) (Snapshot, error) {
	if e.State() != StateInPosition {
		return e.Snapshot(), nil
	}
	if err := e.authorize(); err != nil {
		return e.Snapshot(), err
	}
	canceled, err := e.cancelOrphanProtection()
	if err != nil {
		log.Printf("[trading] reconcile %s cancel: %v", e.cfg.Symbol, err)
		return e.Snapshot(), err
	}
	now := at(in.Now)
	if e.pos.OpenedAt.IsZero() {
		if rows, oerr := OpenEntries(e.userID, e.cfg.ID); oerr == nil {
			for _, row := range rows {
				if strings.EqualFold(row.Symbol, e.cfg.Symbol) && (e.pos.Side == "" || strings.EqualFold(row.Side, string(e.pos.Side))) {
					e.openEntryID = row.ID
					e.pos.OpenedAt = row.OpenedAt.UTC()
					stamp := row.EntryStamp
					e.openEntry = &stamp
					break
				}
			}
		}
	}
	since := e.pos.OpenedAt
	if !since.IsZero() {
		since = since.Add(-tradeSinceSlack)
	} else {
		since = e.startedAt
	}
	book, err := e.readFlatBook(since, now)
	if err != nil {
		log.Printf("[trading] reconcile %s book: %v", e.cfg.Symbol, err)
		return e.Snapshot(), err
	}
	if !book.ready {
		log.Printf("[trading] exchange_flat %s %s waiting for income and fill; canceled=%s",
			e.cfg.Symbol, e.pos.Side, formatAlgoIDs(canceled))
		return e.Snapshot(), nil
	}
	return e.bookExchangeFlat(in, book, canceled)
}

func (e *Engine) cancelOrphanProtection() ([]int64, error) {
	src, ok := e.ex.(interface {
		CancelProtective(symbol string, side Side) ([]int64, error)
	})
	if !ok {
		return nil, invalid("交易所不能按持仓方向撤保护单")
	}
	return src.CancelProtective(e.cfg.Symbol, e.pos.Side)
}

func (e *Engine) readFlatBook(since, now time.Time) (flatBook, error) {
	var book flatBook
	if since.IsZero() {
		return book, invalid("缺少收益起点")
	}
	inc, ok := e.ex.(interface {
		IncomeParts(symbol string, since, now time.Time) (IncomeParts, error)
	})
	if !ok {
		return book, invalid("交易所没有已实现盈亏")
	}
	parts, err := inc.IncomeParts(e.cfg.Symbol, since, now)
	if err != nil {
		return book, err
	}
	price, qty, closedAt, found, err := e.closingLeg(since, now)
	if err != nil {
		return book, err
	}
	book.parts = parts
	book.price = price
	book.qty = qty
	book.closedAt = closedAt
	// 开仓 COMMISSION 会先入账。没有 REALIZED_PNL 时不关账，与 bookentry.closeFlatEntry 对齐。
	book.ready = parts.HasRealized && parts.Rows > 0 && found && price > 0 && qty > 0
	return book, nil
}

// closingLeg 出场价和数量用来自 userTrades 的止损/止盈成交。有成交时间时用它，不用标记价。
func (e *Engine) closingLeg(since, now time.Time) (price, qty float64, closedAt time.Time, found bool, err error) {
	if timed, ok := e.ex.(interface {
		ClosingTrade(symbol string, side Side, since, now time.Time) (TradeLeg, bool, error)
	}); ok {
		leg, okFill, err := timed.ClosingTrade(e.cfg.Symbol, e.pos.Side, since, now)
		if err != nil || !okFill {
			return 0, 0, time.Time{}, false, err
		}
		return leg.Price, leg.Qty, leg.Time, leg.Price > 0 && leg.Qty > 0, nil
	}
	fills, ok := e.ex.(interface {
		ClosingFill(symbol string, side Side, since, now time.Time) (price, qty float64, ok bool, err error)
	})
	if !ok {
		return 0, 0, time.Time{}, false, invalid("交易所没有成交明细")
	}
	price, qty, found, err = fills.ClosingFill(e.cfg.Symbol, e.pos.Side, since, now)
	return price, qty, time.Time{}, found, err
}

func (e *Engine) bookExchangeFlat(in StepInput, book flatBook, canceled []int64) (Snapshot, error) {
	now := at(in.Now)
	side := e.pos.Side
	reason := ReasonExchangeFlat
	detail := fmt.Sprintf("symbol=%s side=%s positionSide=%s exit=%.4f qty=%.4f realized_pnl=%.4f commission=%.4f funding_fee=%.4f net=%.4f canceled=%s",
		e.cfg.Symbol, side, positionSide(side), book.price, book.qty,
		book.parts.RealizedPnL, book.parts.Commission, book.parts.FundingFee, book.parts.Net(),
		formatAlgoIDs(canceled))
	e.lastDetail = detail
	e.audit = append(e.audit, reason+": "+detail)
	e.log.Printf("[trading] %s: %s", reason, detail)
	log.Printf("[trading] %s: %s", reason, detail)

	if err := e.m.Transition(Event{Kind: EventExitSignal, Reason: reason}); err != nil {
		return e.failed(err.Error())
	}
	if err := e.m.Transition(Event{Kind: EventExitFilled, Reason: reason}); err != nil {
		return e.failed(err.Error())
	}
	entryID := e.openEntryID
	userID := e.userID
	strategyID := e.cfg.ID
	symbol := e.cfg.Symbol
	tradeNet := book.parts.Net()
	closedAt := book.closedAt
	if closedAt.IsZero() {
		closedAt = now
	}
	_ = CloseEntry(entryID, userID, strategyID, symbol, string(side), ExitFill{
		Price:    book.price,
		Qty:      book.qty,
		Realized: tradeNet,
		Reason:   reason,
		ClosedAt: closedAt,
	})
	e.stampLoss(tradeNet, closedAt)
	e.captureIncome(now)
	halted := DailyHaltBreached(e.ledger.Capital, e.ledger.Realized, e.cfg.DailyLossPct)
	if halted {
		e.ledger.Halted = true
	}
	e.closedSide = side
	e.clearPos()
	e.forgetPlan()
	if halted {
		e.enterHalt()
		return e.Snapshot(), nil
	}
	if err := e.m.Transition(Event{Kind: EventBooked, Reason: reason}); err != nil {
		return e.Snapshot(), err
	}
	e.markBar(in)
	e.noteClosePnL(tradeNet, closedAt)
	e.note("exit", reason)
	if e.pausedReason != "" {
		e.note("pause", e.pausedReason)
		return e.Snapshot(), nil
	}
	if limit := e.lossLimit(); limit > 0 && e.lossStreak >= limit {
		return e.applyPause(ReasonConsecutiveLosses), nil
	}
	if e.running {
		if err := e.m.Transition(Event{Kind: EventStartOK, Reason: "rearm"}); err != nil {
			return e.Snapshot(), err
		}
		e.note("armed", reason)
	}
	return e.Snapshot(), nil
}

func formatAlgoIDs(ids []int64) string {
	if len(ids) == 0 {
		return "none"
	}
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatInt(id, 10)
	}
	return strings.Join(parts, ",")
}
