package handlers

import (
	"database/sql"
	"log"
	"time"

	"ooapi/internal/db"
	"ooapi/internal/trading"
)

// dbEntryLog 把开仓记录写进 trading_entries。列由启动时的自动迁移补齐。
type dbEntryLog struct{}

const entryInsertSQL = `
INSERT INTO trading_entries (
	user_id, strategy_id, symbol, side, score, min_score, boost, forced,
	win_rate, trade_count, net_r, expectancy_r, expectancy_usdt, one_r_usdt,
	live_expectancy, take_profit_dist,
	entry_price, qty, opened_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const entrySelectCols = `
id, user_id, strategy_id, symbol, side, score, min_score, boost, forced,
win_rate, trade_count, net_r, expectancy_r, expectancy_usdt, one_r_usdt,
live_expectancy, take_profit_dist,
entry_price, qty, opened_at, exit_price, exit_qty, realized_usdt, exit_reason, closed_at`

const entryCloseSQL = `
UPDATE trading_entries
SET exit_price = ?, exit_qty = ?, realized_usdt = ?, exit_reason = ?, closed_at = ?
WHERE id = ? AND user_id = ? AND strategy_id = ? AND closed_at IS NULL`

const entryCloseLatestSQL = `
UPDATE trading_entries
SET exit_price = ?, exit_qty = ?, realized_usdt = ?, exit_reason = ?, closed_at = ?
WHERE user_id = ? AND strategy_id = ? AND symbol = ? AND side = ? AND closed_at IS NULL
ORDER BY opened_at DESC, id DESC
LIMIT 1`

const entryReviseSQL = `
UPDATE trading_entries
SET entry_price = ?, qty = ?
WHERE id = ? AND closed_at IS NULL`

const entryOpenSQL = `
SELECT ` + entrySelectCols + `
FROM trading_entries
WHERE user_id = ? AND strategy_id = ? AND closed_at IS NULL
ORDER BY opened_at ASC, id ASC`

const entryListSQL = `
SELECT ` + entrySelectCols + `
FROM trading_entries
WHERE user_id = ? AND strategy_id = ?
ORDER BY opened_at DESC, id DESC
LIMIT ?`

const entryRecentSQL = `
SELECT ` + entrySelectCols + `
FROM trading_entries
ORDER BY opened_at DESC, id DESC
LIMIT ?`

func (dbEntryLog) Save(rec trading.EntryRecord) (int64, error) {
	if db.DB == nil {
		return 0, sql.ErrConnDone
	}
	opened := rec.OpenedAt.UTC()
	if opened.IsZero() {
		opened = time.Now().UTC()
	}
	res, err := db.DB.Exec(entryInsertSQL,
		rec.UserID, rec.StrategyID, rec.Symbol, rec.Side, rec.Score, rec.MinScore,
		boolInt(rec.Boost), boolInt(rec.Forced),
		rec.WinRate, rec.Trades, rec.NetR, rec.ExpectancyR, rec.ExpectancyUSDT, rec.OneRUSDT,
		rec.LiveExpectancy, rec.TakeProfitDist,
		rec.EntryPrice, rec.Qty, opened,
	)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return id, nil
}

func (dbEntryLog) ReviseOpen(id int64, price, qty float64) error {
	if db.DB == nil {
		return sql.ErrConnDone
	}
	if id <= 0 || price <= 0 || qty <= 0 {
		return nil
	}
	_, err := db.DB.Exec(entryReviseSQL, price, qty, id)
	return err
}

func (dbEntryLog) Open(userID, strategyID int64) ([]trading.EntryRecord, error) {
	return queryEntries(entryOpenSQL, userID, strategyID)
}

func (dbEntryLog) Close(id, userID, strategyID int64, symbol, side string, exit trading.ExitFill) error {
	if db.DB == nil {
		return sql.ErrConnDone
	}
	closed := exit.ClosedAt.UTC()
	if closed.IsZero() {
		closed = time.Now().UTC()
	}
	if id > 0 {
		_, err := db.DB.Exec(entryCloseSQL,
			exit.Price, exit.Qty, exit.Realized, exit.Reason, closed,
			id, userID, strategyID,
		)
		return err
	}
	_, err := db.DB.Exec(entryCloseLatestSQL,
		exit.Price, exit.Qty, exit.Realized, exit.Reason, closed,
		userID, strategyID, symbol, side,
	)
	return err
}

func (dbEntryLog) List(userID, strategyID int64, limit int) ([]trading.EntryRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	return queryEntries(entryListSQL, userID, strategyID, limit)
}

func (dbEntryLog) Recent(limit int) ([]trading.EntryRecord, error) {
	if limit <= 0 {
		limit = trading.EventCapacity
	}
	return queryEntries(entryRecentSQL, limit)
}

func queryEntries(query string, args ...any) ([]trading.EntryRecord, error) {
	if db.DB == nil {
		return []trading.EntryRecord{}, nil
	}
	rows, err := db.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []trading.EntryRecord{}
	for rows.Next() {
		rec, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func scanEntry(s scanner) (trading.EntryRecord, error) {
	var (
		rec     trading.EntryRecord
		boost   int
		forced  int
		opened  sql.NullTime
		closed  sql.NullTime
		exitWhy sql.NullString
	)
	err := s.Scan(
		&rec.ID, &rec.UserID, &rec.StrategyID, &rec.Symbol, &rec.Side,
		&rec.Score, &rec.MinScore, &boost, &forced,
		&rec.WinRate, &rec.Trades, &rec.NetR, &rec.ExpectancyR, &rec.ExpectancyUSDT, &rec.OneRUSDT,
		&rec.LiveExpectancy, &rec.TakeProfitDist,
		&rec.EntryPrice, &rec.Qty, &opened,
		&rec.ExitPrice, &rec.ExitQty, &rec.RealizedUSDT, &exitWhy, &closed,
	)
	if err != nil {
		return trading.EntryRecord{}, err
	}
	rec.Boost = boost != 0
	rec.Forced = forced != 0
	if opened.Valid {
		rec.OpenedAt = opened.Time.UTC()
	}
	if exitWhy.Valid {
		rec.ExitReason = exitWhy.String
	}
	if closed.Valid {
		rec.ClosedAt = closed.Time.UTC()
	}
	return rec, nil
}

func strategyEntries(userID, strategyID int64) []trading.EntryRecord {
	rows, err := trading.ListEntries(userID, strategyID, 50)
	if err != nil {
		log.Printf("[trading] 读取开仓记录失败: %v", err)
		return []trading.EntryRecord{}
	}
	if rows == nil {
		return []trading.EntryRecord{}
	}
	return rows
}

// installEntryLog 让开仓记录落到库里。调度器关掉时手工 step 仍然要能记下。
func installEntryLog() {
	trading.SetEntryLog(dbEntryLog{})
}
