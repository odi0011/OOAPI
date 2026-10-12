package handlers

import (
	"time"

	"ooapi/internal/db"
	"ooapi/internal/trading"
)

const orderUpsertSQL = `
INSERT INTO trading_orders (
	user_id, strategy_id, symbol, order_id, role, side,
	price, qty, realized_pnl, commission, funding_fee, filled_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	symbol = VALUES(symbol),
	role = VALUES(role),
	side = VALUES(side),
	price = VALUES(price),
	qty = VALUES(qty),
	realized_pnl = VALUES(realized_pnl),
	commission = VALUES(commission),
	funding_fee = VALUES(funding_fee),
	filled_at = VALUES(filled_at)`

type dbOrderBook struct{}

func (dbOrderBook) Upsert(userID, strategyID int64, rows []trading.OrderRow) error {
	if db.DB == nil {
		return nil
	}
	for _, row := range rows {
		if row.OrderID == "" {
			continue
		}
		filled := row.FilledAt.UTC()
		if filled.IsZero() {
			filled = time.Now().UTC()
		}
		if _, err := db.DB.Exec(orderUpsertSQL,
			userID, strategyID, row.Symbol, row.OrderID, row.Role, row.Side,
			row.Price, row.Qty, row.RealizedPnL, row.Commission, row.FundingFee, filled,
		); err != nil {
			return err
		}
	}
	return nil
}

func installOrderBook() {
	trading.SetOrderBook(dbOrderBook{})
}
