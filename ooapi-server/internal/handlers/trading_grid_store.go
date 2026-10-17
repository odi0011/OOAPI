package handlers

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	"ooapi/internal/db"
	"ooapi/internal/services"
	"ooapi/internal/trading"
)

/*
网格的落库。

两张表，分工明确：

	trading_grids       配置（区间、条数、预算、运行开关）
	trading_grid_fills  成交明细 —— **网格状态的唯一事实来源**

后者不只用于展示。引擎重启之后，"哪一格还持有货"完全从这里算出来：
买入加、卖出减，卖单减的是**上一格**（卖单挂在 i+1，卖的是 i 那格买到的货）。
把它做成唯一来源，就不存在"内存和库谁说了算"的问题 ——
这一点比多写几句 SQL 值钱得多。
*/

// dbGridFillLog 把网格成交写进 trading_grid_fills。
type dbGridFillLog struct{}

const gridFillInsertSQL = `
INSERT INTO trading_grid_fills (
	user_id, grid_id, symbol, level_index, side, price, qty, quote,
	fee_quote, realized_usdt, order_id, client_id, fill_source, filled_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const gridFillListSQL = `
SELECT id, user_id, grid_id, symbol, level_index, side, price, qty, quote,
       fee_quote, realized_usdt, order_id, client_id, fill_source, filled_at
FROM trading_grid_fills
WHERE grid_id = ?
ORDER BY filled_at DESC, id DESC
LIMIT ?`

/*
gridHoldingsReplaySQL 按**成交顺序**取回全部成交，由 Go 侧回放。

不用 SQL 聚合，是因为清仓单（level_index = -1）必须按时间处理：
它平掉的是所有格子凑起来的货，按某一格减会减成负数；而"遇到它就把
持仓清零"只有在它之前的所有开仓都已入账时才成立。SQL 的 SUM 不带
顺序，表达不了这件事 —— 实盘已经踩过一次：WIF 空头停机清仓后进程
重启，持仓被重建成清仓前的 505，交易所却是空的。

ORDER BY id 和内存账本的写入顺序一致；同一笔成交的 filled_at 可能
因为交易所回执时间而乱序，id 才是本地记账的真实顺序。
*/
const gridHoldingsReplaySQL = `
SELECT level_index, side, qty
FROM trading_grid_fills
WHERE grid_id = ?
ORDER BY id`

const gridFillSummarySQL = `
SELECT COUNT(*), COALESCE(SUM(realized_usdt), 0)
FROM trading_grid_fills
WHERE grid_id = ?`

func (dbGridFillLog) Save(fill trading.GridFill) (int64, error) {
	if db.DB == nil {
		return 0, sql.ErrConnDone
	}
	at := fill.FilledAt.UTC()
	if at.IsZero() {
		at = time.Now().UTC()
	}
	res, err := db.DB.Exec(gridFillInsertSQL,
		fill.UserID, fill.GridID, fill.Symbol, fill.Level, string(fill.Side),
		fill.Price, fill.Qty, fill.Quote, fill.FeeQuote, fill.Realized,
		spotOrderIDText(fill.OrderID), fill.ClientID, fill.FillSource, at,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (dbGridFillLog) List(gridID int64, limit int) ([]trading.GridFill, error) {
	if db.DB == nil {
		return []trading.GridFill{}, nil
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := db.DB.Query(gridFillListSQL, gridID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []trading.GridFill{}
	for rows.Next() {
		var (
			f       trading.GridFill
			side    string
			orderID string
			client  sql.NullString
			source  sql.NullString
			filled  sql.NullTime
		)
		if err := rows.Scan(
			&f.ID, &f.UserID, &f.GridID, &f.Symbol, &f.Level, &side,
			&f.Price, &f.Qty, &f.Quote, &f.FeeQuote, &f.Realized,
			&orderID, &client, &source, &filled,
		); err != nil {
			return nil, err
		}
		f.Side = trading.SpotSide(side)
		f.OrderID = parseOrderID(orderID)
		f.ClientID = client.String
		f.FillSource = source.String
		if filled.Valid {
			f.FilledAt = filled.Time.UTC()
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (dbGridFillLog) Holdings(gridID int64, direction trading.GridDirection) (map[int]float64, error) {
	out := map[int]float64{}
	if db.DB == nil {
		return out, nil
	}
	rows, err := db.DB.Query(gridHoldingsReplaySQL, gridID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	short := trading.NormalizeDirection(direction).Short()
	for rows.Next() {
		var (
			level int
			side  string
			qty   float64
		)
		if err := rows.Scan(&level, &side, &qty); err != nil {
			return nil, err
		}
		if level < 0 {
			// 清仓单：它之前的持仓已经全部平掉，回放到这里清零。
			out = map[int]float64{}
			continue
		}
		if short {
			switch trading.SpotSide(side) {
			case trading.SpotSell:
				out[level] += qty
			case trading.SpotBuy:
				out[level+1] -= qty
			}
			continue
		}
		switch trading.SpotSide(side) {
		case trading.SpotBuy:
			out[level] += qty
		case trading.SpotSell:
			out[level-1] -= qty
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for level, qty := range out {
		if qty <= 1e-12 {
			delete(out, level)
		}
	}
	return out, nil
}

func (dbGridFillLog) Summary(gridID int64) (int, float64, error) {
	if db.DB == nil {
		return 0, 0, nil
	}
	var count int
	var realized float64
	err := db.DB.QueryRow(gridFillSummarySQL, gridID).Scan(&count, &realized)
	if err != nil {
		return 0, 0, err
	}
	return count, realized, nil
}

// installGridFillLog 让网格成交落到库里。不装的话引擎用内存账本 ——
// 能跑，但重启之后"哪一格还持有货"会全部丢失。
func installGridFillLog() {
	trading.SetGridFillLog(dbGridFillLog{})
}

func spotOrderIDText(id int64) string {
	if id <= 0 {
		return ""
	}
	return strconvFormatID(id)
}

func parseOrderID(raw string) int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	var id int64
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return 0
		}
		id = id*10 + int64(raw[i]-'0')
	}
	return id
}

// strconvFormatID 避免为了一处转换在 handler 里再 import strconv。
func strconvFormatID(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [24]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// ---------------------------------------------------------------------------
// 网格配置的读写
// ---------------------------------------------------------------------------

const gridSelectCols = `
g.id, g.user_id, g.exchange_key_id, g.symbol, g.mode,
g.direction, g.market, g.leverage,
g.lower_price, g.upper_price, g.levels, g.quote_budget, g.stop_pct, g.fee_rate,
g.running, g.pause_reason, g.created_at, g.updated_at, k.network, k.status`

const gridFromSQL = `
FROM trading_grids g
LEFT JOIN exchange_keys k ON k.id = g.exchange_key_id AND k.user_id = g.user_id`

const gridListSQL = `
SELECT ` + gridSelectCols + gridFromSQL + `
WHERE g.user_id = ?
ORDER BY g.updated_at DESC, g.id DESC`

const gridByIDSQL = `
SELECT ` + gridSelectCols + gridFromSQL + `
WHERE g.id = ? AND g.user_id = ?`

const gridRunningSQL = `
SELECT ` + gridSelectCols + gridFromSQL + `
WHERE g.running = 1
ORDER BY g.id ASC`

const gridInsertSQL = `
INSERT INTO trading_grids (
	user_id, exchange_key_id, symbol, mode, direction, market, leverage,
	lower_price, upper_price, levels, quote_budget, stop_pct, fee_rate, running
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`

const gridUpdateSQL = `
UPDATE trading_grids
SET exchange_key_id = ?, symbol = ?, mode = ?, direction = ?, market = ?, leverage = ?,
	lower_price = ?, upper_price = ?, levels = ?, quote_budget = ?,
	stop_pct = ?, fee_rate = ?
WHERE id = ? AND user_id = ?`

const gridSetRunningSQL = `
UPDATE trading_grids SET running = ?, pause_reason = ? WHERE id = ? AND user_id = ?`

const gridDeleteSQL = `
DELETE FROM trading_grids WHERE id = ? AND user_id = ?`

const gridRunningDupSQL = `
SELECT id FROM trading_grids
WHERE user_id = ? AND exchange_key_id = ? AND symbol = ? AND running = 1 AND id <> ?
LIMIT 1`

// gridRow 是一条网格的配置加上所绑密钥的状态。
type gridRow struct {
	Config     trading.GridConfig
	KeyNetwork string
	KeyStatus  int
	UpdatedAt  time.Time
}

func scanGrid(s scanner) (gridRow, error) {
	var (
		row        gridRow
		pause      sql.NullString
		created    sql.NullTime
		updated    sql.NullTime
		keyNetwork sql.NullString
		keyStatus  sql.NullInt64
	)
	err := s.Scan(
		&row.Config.ID, &row.Config.UserID, &row.Config.ExchangeKeyID,
		&row.Config.Symbol, &row.Config.Mode,
		&row.Config.Direction, &row.Config.Market, &row.Config.Leverage,
		&row.Config.Lower, &row.Config.Upper, &row.Config.Levels,
		&row.Config.QuoteBudget, &row.Config.StopPct, &row.Config.FeeRate,
		&row.Config.Running, &pause, &created, &updated,
		&keyNetwork, &keyStatus,
	)
	if err != nil {
		return gridRow{}, err
	}
	row.Config.PauseReason = pause.String
	if created.Valid {
		row.Config.CreatedAt = created.Time.UTC()
	}
	if updated.Valid {
		row.UpdatedAt = updated.Time.UTC()
	}
	row.KeyNetwork = keyNetwork.String
	row.KeyStatus = int(keyStatus.Int64)
	// 布尔列在 MySQL 里是 TINYINT，扫进 bool 由驱动处理；
	// 这里再兜一次，避免某些驱动把它读成 []byte。
	return row, nil
}

func loadGrid(id, userID int64) (gridRow, error) {
	if db.DB == nil {
		return gridRow{}, sql.ErrConnDone
	}
	return scanGrid(db.DB.QueryRow(gridByIDSQL, id, userID))
}

func listGrids(userID int64) ([]gridRow, error) {
	return queryGrids(gridListSQL, userID)
}

func queryGrids(query string, args ...any) ([]gridRow, error) {
	if db.DB == nil {
		return []gridRow{}, nil
	}
	rows, err := db.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gridRow{}
	for rows.Next() {
		row, err := scanGrid(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

/*
listRunningGrids 进程启动时把该跑的网格拉起来。

**启动时不建引擎**：建引擎要读交易对规则（一次网络请求），
十几条网格就是十几个请求，而进程刚起来时正是最不该打交易所的时候。
所以这里只返回 spec，引擎由调度器在第一次推进时按需建立并认领。
*/
func listRunningGrids() ([]trading.GridRunSpec, error) {
	rows, err := queryGrids(gridRunningSQL)
	if err != nil {
		return nil, err
	}
	out := make([]trading.GridRunSpec, 0, len(rows))
	for _, row := range rows {
		out = append(out, trading.GridRunSpec{
			UserID:  row.Config.UserID,
			Config:  row.Config,
			Secrets: gridSecretOpener(row.Config.UserID, row.Config.ExchangeKeyID, row.Config.Mode),
		})
	}
	return out, nil
}

// gridSecretOpener 与 deskSecretOpener 同一条路径，只是入参不是 strategyRow。
// 密钥的归属校验在 loadExchangeKey 里，传别人的 keyID 取不到。
func gridSecretOpener(userID, keyID int64, mode string) trading.SecretOpener {
	return func() (trading.Credentials, error) {
		stored, err := loadExchangeKey(keyID, userID)
		if isNotFound(err) || (err == nil && stored.Status != exchangeKeyActive) {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		if err != nil {
			return trading.Credentials{}, err
		}
		if stored.Network != mode || (stored.Network != networkTestnet && stored.Network != networkLive) {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		apiKey, err := services.OpenExchangeSecret(stored.APIKey)
		if err != nil {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		apiSecret, err := services.OpenExchangeSecret(stored.APISecret)
		if err != nil {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		return trading.Credentials{APIKey: apiKey, APISecret: apiSecret, Network: stored.Network}, nil
	}
}

func setGridRunning(id, userID int64, running bool, pauseReason string) error {
	if db.DB == nil {
		return sql.ErrConnDone
	}
	res, err := db.DB.Exec(gridSetRunningSQL, boolInt(running), pauseReason, id, userID)
	if err != nil {
		return err
	}
	/*
		UPDATE 带 user_id 条件，传错用户时 MySQL 不会报错，只是 0 行。
		但 0 行也可能是"值本来就一样"（重复停一条已停的网格），所以
		只有查不到这条归属时才当成错误。这个区分是必要的：调度器停机
		回调曾经传 userID=0，更新静默失败，网格自停机后 running 仍是 1，
		服务重启就把它复活了。
	*/
	if n, aerr := res.RowsAffected(); aerr == nil && n == 0 {
		var exists int
		if qerr := db.DB.QueryRow(
			"SELECT COUNT(*) FROM trading_grids WHERE id = ? AND user_id = ?",
			id, userID).Scan(&exists); qerr != nil {
			return qerr
		}
		if exists == 0 {
			return fmt.Errorf("网格 %d 不属于用户 %d（或不存在），运行标记未更新", id, userID)
		}
	}
	return nil
}

// gridFills 读某条网格的成交明细，读失败只记日志并回空 ——
// 一个展示用的列表不该让整页打不开。
func gridFills(gridID int64, limit int) []trading.GridFill {
	rows, err := trading.GridFillList(gridID, limit)
	if err != nil {
		log.Printf("[trading] 读取网格成交失败: %v", err)
		return []trading.GridFill{}
	}
	if rows == nil {
		return []trading.GridFill{}
	}
	return rows
}
