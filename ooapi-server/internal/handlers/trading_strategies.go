package handlers

import (
	"database/sql"
	"log"
	"math"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// 策略字段与验收表 / 前端壳一致：
// symbol, leverage, marginMode, emaFast, emaSlow, timeframe,
// stopR, takeProfitR, dailyLossPct, maxMarginUsdt, exchangeKeyId, mode.
//
// 省略的字段在创建时用首发默认值。v1 只接受 XRPUSDT、逐仓、杠杆不超过 3。
// mode=live 允许写入，并在响应里警告：运行时必须测网全绿，由策略引擎强制，本接口不下单。

const (
	strategySymbol       = "XRPUSDT"
	strategyMarginMode   = "isolated"
	defaultLeverage      = 3
	defaultEmaFast       = 9
	defaultEmaSlow       = 21
	defaultTimeframe     = "5m"
	defaultStopR         = 1.0
	defaultTakeProfitR   = 1.5
	defaultDailyLossPct  = 4.0
	defaultMaxMarginUsdt = 1.7

	liveModeWarning        = "mode=live 已保存。运行时必须先确认测网全绿，由策略引擎强制；本接口只保存配置，不会下单。"
	networkMismatchWarning = "策略 mode 与所绑密钥的 network 不一致。配置已保存，运行前请改成同一环境。"
	revokedKeyWarning      = "所绑交易所密钥已作废或不存在，运行前请重新选择。"
)

var strategyTimeframes = map[string]struct{}{
	"1m": {}, "3m": {}, "5m": {}, "15m": {},
}

const strategySelectCols = `
s.id, s.symbol, s.leverage, s.margin_mode, s.ema_fast, s.ema_slow, s.timeframe,
s.stop_r, s.take_profit_r, s.daily_loss_pct, s.max_margin_usdt, s.exchange_key_id, s.mode,
s.created_at, s.updated_at, k.network, k.status`

const strategyInsertSQL = `
INSERT INTO trading_strategies (
	user_id, symbol, leverage, margin_mode, ema_fast, ema_slow, timeframe,
	stop_r, take_profit_r, daily_loss_pct, max_margin_usdt, exchange_key_id, mode
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const strategyListSQL = `
SELECT ` + strategySelectCols + `
FROM trading_strategies s
LEFT JOIN exchange_keys k ON k.id = s.exchange_key_id AND k.user_id = s.user_id
WHERE s.user_id = ?
ORDER BY s.updated_at DESC, s.id DESC`

const strategyByIDSQL = `
SELECT ` + strategySelectCols + `
FROM trading_strategies s
LEFT JOIN exchange_keys k ON k.id = s.exchange_key_id AND k.user_id = s.user_id
WHERE s.id = ? AND s.user_id = ?`

const strategyUpdateSQL = `
UPDATE trading_strategies
SET symbol = ?, leverage = ?, margin_mode = ?, ema_fast = ?, ema_slow = ?, timeframe = ?,
	stop_r = ?, take_profit_r = ?, daily_loss_pct = ?, max_margin_usdt = ?,
	exchange_key_id = ?, mode = ?
WHERE id = ? AND user_id = ?`

const strategyDeleteSQL = `
DELETE FROM trading_strategies WHERE id = ? AND user_id = ?`

type strategyWrite struct {
	Symbol        *string  `json:"symbol"`
	Leverage      *int     `json:"leverage"`
	MarginMode    *string  `json:"marginMode"`
	EmaFast       *int     `json:"emaFast"`
	EmaSlow       *int     `json:"emaSlow"`
	Timeframe     *string  `json:"timeframe"`
	StopR         *float64 `json:"stopR"`
	TakeProfitR   *float64 `json:"takeProfitR"`
	DailyLossPct  *float64 `json:"dailyLossPct"`
	MaxMarginUsdt *float64 `json:"maxMarginUsdt"`
	ExchangeKeyID *int64   `json:"exchangeKeyId"`
	Mode          *string  `json:"mode"`
}

type strategyRecord struct {
	Symbol        string
	Leverage      int
	MarginMode    string
	EmaFast       int
	EmaSlow       int
	Timeframe     string
	StopR         float64
	TakeProfitR   float64
	DailyLossPct  float64
	MaxMarginUsdt float64
	ExchangeKeyID int64
	Mode          string
}

type strategyView struct {
	ID                 int64    `json:"id"`
	Symbol             string   `json:"symbol"`
	Leverage           int      `json:"leverage"`
	MarginMode         string   `json:"marginMode"`
	EmaFast            int      `json:"emaFast"`
	EmaSlow            int      `json:"emaSlow"`
	Timeframe          string   `json:"timeframe"`
	StopR              float64  `json:"stopR"`
	TakeProfitR        float64  `json:"takeProfitR"`
	DailyLossPct       float64  `json:"dailyLossPct"`
	MaxMarginUsdt      float64  `json:"maxMarginUsdt"`
	ExchangeKeyID      int64    `json:"exchangeKeyId"`
	Mode               string   `json:"mode"`
	ExchangeKeyActive  bool     `json:"exchangeKeyActive"`
	ExchangeKeyNetwork string   `json:"exchangeKeyNetwork,omitempty"`
	Warnings           []string `json:"warnings"`
	CreatedAt          string   `json:"createdAt"`
	UpdatedAt          string   `json:"updatedAt"`
}

type strategyRow struct {
	ID                 int64
	Record             strategyRecord
	CreatedAt          string
	UpdatedAt          string
	ExchangeKeyNetwork string
	ExchangeKeyActive  bool
}

func defaultStrategy() strategyRecord {
	return strategyRecord{
		Symbol:        strategySymbol,
		Leverage:      defaultLeverage,
		MarginMode:    strategyMarginMode,
		EmaFast:       defaultEmaFast,
		EmaSlow:       defaultEmaSlow,
		Timeframe:     defaultTimeframe,
		StopR:         defaultStopR,
		TakeProfitR:   defaultTakeProfitR,
		DailyLossPct:  defaultDailyLossPct,
		MaxMarginUsdt: defaultMaxMarginUsdt,
		Mode:          networkTestnet,
	}
}

func (row strategyRow) view() strategyView {
	rec := row.Record
	return strategyView{
		ID:                 row.ID,
		Symbol:             rec.Symbol,
		Leverage:           rec.Leverage,
		MarginMode:         rec.MarginMode,
		EmaFast:            rec.EmaFast,
		EmaSlow:            rec.EmaSlow,
		Timeframe:          rec.Timeframe,
		StopR:              rec.StopR,
		TakeProfitR:        rec.TakeProfitR,
		DailyLossPct:       rec.DailyLossPct,
		MaxMarginUsdt:      rec.MaxMarginUsdt,
		ExchangeKeyID:      rec.ExchangeKeyID,
		Mode:               rec.Mode,
		ExchangeKeyActive:  row.ExchangeKeyActive,
		ExchangeKeyNetwork: row.ExchangeKeyNetwork,
		Warnings:           strategyWarnings(rec.Mode, row.ExchangeKeyNetwork, row.ExchangeKeyActive),
		CreatedAt:          row.CreatedAt,
		UpdatedAt:          row.UpdatedAt,
	}
}

func strategyWarnings(mode, keyNetwork string, keyActive bool) []string {
	out := []string{}
	if mode == networkLive {
		out = append(out, liveModeWarning)
	}
	if keyNetwork != "" && keyNetwork != mode {
		out = append(out, networkMismatchWarning)
	}
	if !keyActive {
		out = append(out, revokedKeyWarning)
	}
	return out
}

// ListTradingStrategies 列出当前用户的策略，最新修改的在前。
func ListTradingStrategies(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	rows, err := queryRows(strategyListSQL, user.ID)
	if err != nil {
		log.Printf("[trading] 查询策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询策略失败", "server_error")
		return
	}
	defer rows.Close()

	items := []strategyView{}
	for rows.Next() {
		row, err := scanStrategy(rows)
		if err != nil {
			log.Printf("[trading] 读取策略行失败: %v", err)
			continue
		}
		items = append(items, row.view())
	}
	if err := rows.Err(); err != nil {
		log.Printf("[trading] 遍历策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询策略失败", "server_error")
		return
	}
	ok(c, gin.H{"items": items})
}

// GetTradingStrategy 读取一条属于当前用户的策略。
func GetTradingStrategy(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	row, err := loadStrategy(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "策略不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[trading] 读取策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取策略失败", "server_error")
		return
	}
	ok(c, row.view())
}

// CreateTradingStrategy 创建策略。省略的字段使用首发默认值。
func CreateTradingStrategy(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	var req strategyWrite
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	rec, fieldErr := applyStrategyWrite(defaultStrategy(), req, true)
	if fieldErr != nil {
		writeTradingError(c, fieldErr)
		return
	}
	if fieldErr = ensureSelectableKey(user.ID, rec.ExchangeKeyID); fieldErr != nil {
		writeTradingError(c, fieldErr)
		return
	}
	res, err := exec(strategyInsertSQL,
		user.ID, rec.Symbol, rec.Leverage, rec.MarginMode, rec.EmaFast, rec.EmaSlow, rec.Timeframe,
		rec.StopR, rec.TakeProfitR, rec.DailyLossPct, rec.MaxMarginUsdt, rec.ExchangeKeyID, rec.Mode,
	)
	if err != nil {
		log.Printf("[trading] 写入策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存策略失败", "server_error")
		return
	}
	id, err := res.LastInsertId()
	if err != nil || id <= 0 {
		fail(c, http.StatusInternalServerError, "保存策略失败", "server_error")
		return
	}
	row, err := loadStrategy(id, user.ID)
	if err != nil {
		log.Printf("[trading] 回读策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存策略失败", "server_error")
		return
	}
	log.Printf("[trading] 用户 %s 创建策略 id=%d mode=%s", user.Username, id, rec.Mode)
	ok(c, row.view())
}

// UpdateTradingStrategy 局部更新。未出现的字段保持原值，结果整份重新校验。
func UpdateTradingStrategy(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	current, err := loadStrategy(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "策略不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[trading] 读取策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新策略失败", "server_error")
		return
	}
	var req strategyWrite
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	rec, fieldErr := applyStrategyWrite(current.Record, req, false)
	if fieldErr != nil {
		writeTradingError(c, fieldErr)
		return
	}
	if fieldErr = ensureSelectableKey(user.ID, rec.ExchangeKeyID); fieldErr != nil {
		writeTradingError(c, fieldErr)
		return
	}
	res, err := exec(strategyUpdateSQL,
		rec.Symbol, rec.Leverage, rec.MarginMode, rec.EmaFast, rec.EmaSlow, rec.Timeframe,
		rec.StopR, rec.TakeProfitR, rec.DailyLossPct, rec.MaxMarginUsdt, rec.ExchangeKeyID, rec.Mode,
		id, user.ID,
	)
	if err != nil {
		log.Printf("[trading] 更新策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新策略失败", "server_error")
		return
	}
	n, err := res.RowsAffected()
	if err != nil || n == 0 {
		fail(c, http.StatusNotFound, "策略不存在", "not_found")
		return
	}
	row, err := loadStrategy(id, user.ID)
	if err != nil {
		log.Printf("[trading] 回读策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新策略失败", "server_error")
		return
	}
	log.Printf("[trading] 用户 %s 更新策略 id=%d mode=%s", user.Username, id, rec.Mode)
	ok(c, row.view())
}

// DeleteTradingStrategy 删除当前用户的一条策略。
func DeleteTradingStrategy(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	res, err := exec(strategyDeleteSQL, id, user.ID)
	if err != nil {
		log.Printf("[trading] 删除策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "删除策略失败", "server_error")
		return
	}
	n, err := res.RowsAffected()
	if err != nil || n == 0 {
		fail(c, http.StatusNotFound, "策略不存在", "not_found")
		return
	}
	log.Printf("[trading] 用户 %s 删除策略 id=%d", user.Username, id)
	ok(c, gin.H{"id": id, "deleted": true})
}

func loadStrategy(id, userID int64) (strategyRow, error) {
	return scanStrategy(queryRow(strategyByIDSQL, id, userID))
}

func scanStrategy(s scanner) (strategyRow, error) {
	var (
		row     strategyRow
		network sql.NullString
		status  sql.NullInt64
	)
	err := s.Scan(
		&row.ID, &row.Record.Symbol, &row.Record.Leverage, &row.Record.MarginMode,
		&row.Record.EmaFast, &row.Record.EmaSlow, &row.Record.Timeframe,
		&row.Record.StopR, &row.Record.TakeProfitR, &row.Record.DailyLossPct, &row.Record.MaxMarginUsdt,
		&row.Record.ExchangeKeyID, &row.Record.Mode, &row.CreatedAt, &row.UpdatedAt,
		&network, &status,
	)
	if err != nil {
		return strategyRow{}, err
	}
	if network.Valid {
		row.ExchangeKeyNetwork = network.String
	}
	row.ExchangeKeyActive = status.Valid && status.Int64 == exchangeKeyActive
	return row, nil
}

func ensureSelectableKey(userID, keyID int64) *tradingError {
	var (
		id      int64
		network string
		status  int
	)
	err := queryRow(exchangeKeyMetaSQL, keyID, userID).Scan(&id, &network, &status)
	if isNotFound(err) {
		return &tradingError{http.StatusBadRequest, "请选择一把属于自己的交易所密钥", "exchange_key_not_found"}
	}
	if err != nil {
		log.Printf("[trading] 校验交易所密钥失败: %v", err)
		return &tradingError{http.StatusInternalServerError, "校验交易所密钥失败", "server_error"}
	}
	if status != exchangeKeyActive {
		return &tradingError{http.StatusBadRequest, "这把交易所密钥已作废，不能用于策略", "exchange_key_revoked"}
	}
	return nil
}

func applyStrategyWrite(base strategyRecord, in strategyWrite, creating bool) (strategyRecord, *tradingError) {
	out := base
	if in.Symbol != nil {
		out.Symbol = strings.ToUpper(strings.TrimSpace(*in.Symbol))
	}
	if in.Leverage != nil {
		out.Leverage = *in.Leverage
	}
	if in.MarginMode != nil {
		out.MarginMode = strings.ToLower(strings.TrimSpace(*in.MarginMode))
	}
	if in.EmaFast != nil {
		out.EmaFast = *in.EmaFast
	}
	if in.EmaSlow != nil {
		out.EmaSlow = *in.EmaSlow
	}
	if in.Timeframe != nil {
		out.Timeframe = strings.TrimSpace(*in.Timeframe)
	}
	if in.StopR != nil {
		out.StopR = round4(*in.StopR)
	}
	if in.TakeProfitR != nil {
		out.TakeProfitR = round4(*in.TakeProfitR)
	}
	if in.DailyLossPct != nil {
		out.DailyLossPct = round4(*in.DailyLossPct)
	}
	if in.MaxMarginUsdt != nil {
		out.MaxMarginUsdt = round4(*in.MaxMarginUsdt)
	}
	if in.ExchangeKeyID != nil {
		out.ExchangeKeyID = *in.ExchangeKeyID
	}
	if in.Mode != nil {
		out.Mode = strings.ToLower(strings.TrimSpace(*in.Mode))
	}
	if err := validateStrategy(out, creating && in.ExchangeKeyID == nil); err != nil {
		return strategyRecord{}, err
	}
	return out, nil
}

func validateStrategy(rec strategyRecord, missingKey bool) *tradingError {
	if rec.Symbol != strategySymbol {
		return &tradingError{http.StatusBadRequest, "v1 交易对只支持 XRPUSDT", "invalid_symbol"}
	}
	if rec.MarginMode != strategyMarginMode {
		return &tradingError{http.StatusBadRequest, "v1 只允许逐仓（isolated）", "invalid_margin_mode"}
	}
	if rec.Leverage < 1 || rec.Leverage > 3 {
		return &tradingError{http.StatusBadRequest, "杠杆必须是 1 到 3 的整数", "invalid_leverage"}
	}
	if _, ok := strategyTimeframes[rec.Timeframe]; !ok {
		return &tradingError{http.StatusBadRequest, "K 线周期只支持 1m、3m、5m、15m", "invalid_timeframe"}
	}
	if rec.EmaFast < 2 || rec.EmaFast > 50 || rec.EmaSlow < 3 || rec.EmaSlow > 200 || rec.EmaFast >= rec.EmaSlow {
		return &tradingError{http.StatusBadRequest, "快线要小于慢线，且落在允许范围内", "invalid_ema"}
	}
	if !validRisk(rec.StopR, 20) || !validRisk(rec.TakeProfitR, 20) {
		return &tradingError{http.StatusBadRequest, "止损和止盈要大于 0 且不超过 20", "invalid_risk"}
	}
	if !validRisk(rec.DailyLossPct, 100) {
		return &tradingError{http.StatusBadRequest, "日亏停机阈值要大于 0 且不超过 100", "invalid_risk"}
	}
	if !validRisk(rec.MaxMarginUsdt, 1_000_000) {
		return &tradingError{http.StatusBadRequest, "单笔保证金上限要大于 0", "invalid_risk"}
	}
	if rec.Mode != networkTestnet && rec.Mode != networkLive {
		return &tradingError{http.StatusBadRequest, "mode 只能是 testnet 或 live", "invalid_mode"}
	}
	if missingKey || rec.ExchangeKeyID <= 0 {
		return &tradingError{http.StatusBadRequest, "请先绑定一把未作废的交易所密钥", "exchange_key_required"}
	}
	return nil
}

func validRisk(v, max float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0 && v <= max
}

func round4(v float64) float64 {
	return math.Round(v*10000) / 10000
}
