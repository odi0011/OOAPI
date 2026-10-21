package handlers

import (
	"database/sql"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/trading"
)

// 策略字段与验收表 / 前端壳一致：
// symbol, leverage, marginMode, emaFast, emaSlow, timeframe,
// stopR, takeProfitR, dailyLossPct, maxMarginUsdt, exchangeKeyId, mode.
//
// 省略的字段在创建时用首发默认值。交易对是 USDT 永续，逐仓，杠杆不超过 trading.MaxLeverage。
// entryMode 新建默认 trend；库列默认 cross，已有行不会被迁移改掉。
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
	"1s": {}, "1m": {}, "3m": {}, "5m": {}, "15m": {},
}

const strategySelectCols = `
s.id, s.symbol, s.leverage, s.margin_mode, s.ema_fast, s.ema_slow, s.timeframe,
s.stop_r, s.take_profit_r, s.daily_loss_pct, s.max_margin_usdt, s.exchange_key_id, s.mode, s.market,
s.entry_mode, s.min_score, s.min_win_rate, s.min_trades,
s.max_margin_per_trade_usdt, s.max_consecutive_losses, s.pause_balance_usdt, s.pause_reason, s.pause_entries,
s.max_open_positions,
s.rsi_long_min, s.rsi_long_max, s.rsi_short_min, s.rsi_short_max,
s.gamble_mode, s.scalp_tp_pct, s.scalp_sl_pct,
s.r_fraction, s.expectancy_tp_cap_r, s.taker_fee_rate, s.maker_fee_rate, s.expectancy_gate,
s.reverse_min_hold_bars, s.reverse_min_gap_pct, s.cooldown_bars_after_loss,
s.sl_noise_mult, s.tp_atr_mult, s.fee_edge_mult,
s.running,
s.created_at, s.updated_at, k.network, k.status, k.label`

const strategyInsertSQL = `
INSERT INTO trading_strategies (
	user_id, symbol, leverage, margin_mode, ema_fast, ema_slow, timeframe,
	stop_r, take_profit_r, daily_loss_pct, max_margin_usdt, exchange_key_id, mode, market,
	entry_mode, min_score, min_win_rate, min_trades,
	max_margin_per_trade_usdt, max_consecutive_losses, pause_balance_usdt, pause_reason,
	max_open_positions,
	rsi_long_min, rsi_long_max, rsi_short_min, rsi_short_max,
	gamble_mode, scalp_tp_pct, scalp_sl_pct,
	r_fraction, expectancy_tp_cap_r, taker_fee_rate, maker_fee_rate, expectancy_gate,
	reverse_min_hold_bars, reverse_min_gap_pct, cooldown_bars_after_loss,
	sl_noise_mult, tp_atr_mult, fee_edge_mult,
	running
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

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
	exchange_key_id = ?, mode = ?, market = ?, entry_mode = ?, min_score = ?, min_win_rate = ?, min_trades = ?,
	max_margin_per_trade_usdt = ?, max_consecutive_losses = ?, pause_balance_usdt = ?, pause_reason = ?,
	max_open_positions = ?,
	rsi_long_min = ?, rsi_long_max = ?, rsi_short_min = ?, rsi_short_max = ?,
	gamble_mode = ?, scalp_tp_pct = ?, scalp_sl_pct = ?,
	r_fraction = ?, expectancy_tp_cap_r = ?, taker_fee_rate = ?, maker_fee_rate = ?, expectancy_gate = ?,
	reverse_min_hold_bars = ?, reverse_min_gap_pct = ?, cooldown_bars_after_loss = ?,
	sl_noise_mult = ?, tp_atr_mult = ?, fee_edge_mult = ?
WHERE id = ? AND user_id = ?`

const strategyRunningSQL = `
UPDATE trading_strategies SET running = ? WHERE id = ? AND user_id = ?`

const strategyRunningByIDSQL = `
UPDATE trading_strategies SET running = ? WHERE id = ?`

const strategyPauseByIDSQL = `
UPDATE trading_strategies SET running = 0, pause_reason = ? WHERE id = ?`

const strategyClearPauseSQL = `
UPDATE trading_strategies SET pause_reason = '' WHERE id = ? AND user_id = ?`

const strategyPauseEntriesSQL = `
UPDATE trading_strategies SET pause_entries = ? WHERE id = ? AND user_id = ?`

const strategyRunningDupSQL = `
SELECT s.id FROM trading_strategies s
WHERE s.user_id = ? AND s.exchange_key_id = ? AND s.symbol = ? AND s.running = 1 AND s.id <> ?
LIMIT 1`

const strategyDeleteSQL = `
DELETE FROM trading_strategies WHERE id = ? AND user_id = ?`

type strategyWrite struct {
	Symbol                *string  `json:"symbol"`
	Leverage              *int     `json:"leverage"`
	MarginMode            *string  `json:"marginMode"`
	EmaFast               *int     `json:"emaFast"`
	EmaSlow               *int     `json:"emaSlow"`
	Timeframe             *string  `json:"timeframe"`
	StopR                 *float64 `json:"stopR"`
	TakeProfitR           *float64 `json:"takeProfitR"`
	DailyLossPct          *float64 `json:"dailyLossPct"`
	MaxMarginUsdt         *float64 `json:"maxMarginUsdt"`
	ExchangeKeyID         *int64   `json:"exchangeKeyId"`
	Mode                  *string  `json:"mode"`
	Market                *string  `json:"market"`
	EntryMode             *string  `json:"entryMode"`
	MinScore              *int     `json:"minScore"`
	MinWinRate            *float64 `json:"minWinRate"`
	MinTrades             *int     `json:"minTrades"`
	MaxMarginPerTradeUsdt *float64 `json:"maxMarginPerTradeUsdt"`
	MaxConsecutiveLosses  *int     `json:"maxConsecutiveLosses"`
	PauseBalanceUsdt      *float64 `json:"pauseBalanceUsdt"`
	MaxOpenPositions      *int     `json:"maxOpenPositions"`
	RSILongMin            *float64 `json:"rsiLongMin"`
	RSILongMax            *float64 `json:"rsiLongMax"`
	RSIShortMin           *float64 `json:"rsiShortMin"`
	RSIShortMax           *float64 `json:"rsiShortMax"`
	GambleMode            *bool    `json:"gambleMode"`
	ScalpTpPct            *float64 `json:"scalpTpPct"`
	ScalpSlPct            *float64 `json:"scalpSlPct"`
	RFraction             *float64 `json:"rFraction"`
	ExpectancyTpCapR      *float64 `json:"expectancyTpCapR"`
	TakerFeeRate          *float64 `json:"takerFeeRate"`
	MakerFeeRate          *float64 `json:"makerFeeRate"`
	ExpectancyGate        *bool    `json:"expectancyGate"`
	ReverseMinHoldBars    *int     `json:"reverseMinHoldBars"`
	ReverseMinGapPct      *float64 `json:"reverseMinGapPct"`
	CooldownBarsAfterLoss *int     `json:"cooldownBarsAfterLoss"`
	SlNoiseMult           *float64 `json:"slNoiseMult"`
	TpAtrMult             *float64 `json:"tpAtrMult"`
	FeeEdgeMult           *float64 `json:"feeEdgeMult"`
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
	// Market 是「合约还是现货」这个轴，与 Mode（测网/实盘）正交。
	// 空串按合约处理 —— 老库补列前的行读出来就是空的。
	Market                string
	EntryMode             string
	MinScore              int
	MinWinRate            float64
	MinTrades             int
	MaxMarginPerTradeUsdt float64
	MaxConsecutiveLosses  int
	PauseBalanceUsdt      float64
	PauseReason           string
	PauseEntries          bool
	MaxOpenPositions      int
	RSILongMin            float64
	RSILongMax            float64
	RSIShortMin           float64
	RSIShortMax           float64
	GambleMode            bool
	ScalpTpPct            float64
	ScalpSlPct            float64
	RFraction             float64
	ExpectancyTpCapR      float64
	TakerFeeRate          float64
	MakerFeeRate          float64
	ExpectancyGate        bool
	ReverseMinHoldBars    int
	ReverseMinGapPct      float64
	CooldownBarsAfterLoss int
	SlNoiseMult           float64
	TpAtrMult             float64
	FeeEdgeMult           float64
	Running               bool
}

type strategyView struct {
	ID            int64   `json:"id"`
	Symbol        string  `json:"symbol"`
	Leverage      int     `json:"leverage"`
	MarginMode    string  `json:"marginMode"`
	EmaFast       int     `json:"emaFast"`
	EmaSlow       int     `json:"emaSlow"`
	Timeframe     string  `json:"timeframe"`
	StopR         float64 `json:"stopR"`
	TakeProfitR   float64 `json:"takeProfitR"`
	DailyLossPct  float64 `json:"dailyLossPct"`
	MaxMarginUsdt float64 `json:"maxMarginUsdt"`
	ExchangeKeyID int64   `json:"exchangeKeyId"`
	Mode          string  `json:"mode"`
	// Market 是 futures 或 spot。归一过 —— 前端拿到的永远是这两个值之一。
	Market                string   `json:"market"`
	EntryMode             string   `json:"entryMode"`
	MinScore              int      `json:"minScore"`
	MinWinRate            float64  `json:"minWinRate"`
	MinTrades             int      `json:"minTrades"`
	MaxMarginPerTradeUsdt float64  `json:"maxMarginPerTradeUsdt"`
	MaxConsecutiveLosses  int      `json:"maxConsecutiveLosses"`
	PauseBalanceUsdt      float64  `json:"pauseBalanceUsdt"`
	PauseReason           string   `json:"pauseReason,omitempty"`
	PauseEntries          bool     `json:"pauseEntries"`
	MaxOpenPositions      int      `json:"maxOpenPositions"`
	RSILongMin            float64  `json:"rsiLongMin"`
	RSILongMax            float64  `json:"rsiLongMax"`
	RSIShortMin           float64  `json:"rsiShortMin"`
	RSIShortMax           float64  `json:"rsiShortMax"`
	GambleMode            bool     `json:"gambleMode"`
	ScalpTpPct            float64  `json:"scalpTpPct"`
	ScalpSlPct            float64  `json:"scalpSlPct"`
	RFraction             float64  `json:"rFraction"`
	ExpectancyTpCapR      float64  `json:"expectancyTpCapR"`
	TakerFeeRate          float64  `json:"takerFeeRate"`
	MakerFeeRate          float64  `json:"makerFeeRate"`
	ExpectancyGate        bool     `json:"expectancyGate"`
	ReverseMinHoldBars    int      `json:"reverseMinHoldBars"`
	ReverseMinGapPct      float64  `json:"reverseMinGapPct"`
	CooldownBarsAfterLoss int      `json:"cooldownBarsAfterLoss"`
	SlNoiseMult           float64  `json:"slNoiseMult"`
	TpAtrMult             float64  `json:"tpAtrMult"`
	FeeEdgeMult           float64  `json:"feeEdgeMult"`
	Running               bool     `json:"running"`
	ExchangeKeyActive     bool     `json:"exchangeKeyActive"`
	ExchangeKeyNetwork    string   `json:"exchangeKeyNetwork,omitempty"`
	Warnings              []string `json:"warnings"`
	CreatedAt             string   `json:"createdAt"`
	UpdatedAt             string   `json:"updatedAt"`
}

type strategyRow struct {
	ID                 int64
	Record             strategyRecord
	CreatedAt          string
	UpdatedAt          string
	ExchangeKeyNetwork string
	ExchangeKeyLabel   string
	ExchangeKeyActive  bool
}

func defaultStrategy() strategyRecord {
	return strategyRecord{
		Symbol:                strategySymbol,
		Leverage:              defaultLeverage,
		MarginMode:            strategyMarginMode,
		EmaFast:               defaultEmaFast,
		EmaSlow:               defaultEmaSlow,
		Timeframe:             defaultTimeframe,
		StopR:                 defaultStopR,
		TakeProfitR:           defaultTakeProfitR,
		DailyLossPct:          defaultDailyLossPct,
		MaxMarginUsdt:         defaultMaxMarginUsdt,
		Mode:                  networkTestnet,
		EntryMode:             trading.EntryModeTrend,
		MinScore:              trading.DefaultMinScore,
		MinWinRate:            trading.DefaultMinWinRate,
		MinTrades:             trading.DefaultMinTrades,
		MaxMarginPerTradeUsdt: trading.DefaultMaxMarginPerTradeUSDT,
		MaxConsecutiveLosses:  trading.DefaultMaxConsecutiveLosses,
		PauseBalanceUsdt:      trading.DefaultPauseBalanceUSDT,
		MaxOpenPositions:      0,
		RSILongMin:            50,
		RSILongMax:            70,
		RSIShortMin:           30,
		RSIShortMax:           50,
		GambleMode:            false,
		ScalpTpPct:            trading.DefaultScalpPct,
		ScalpSlPct:            trading.DefaultScalpPct,
		RFraction:             trading.DefaultRFraction,
		ExpectancyTpCapR:      float64(trading.ExpectancyTpCapR),
		TakerFeeRate:          trading.TakerFeeRate,
		MakerFeeRate:          trading.MakerFeeRate,
		ExpectancyGate:        true,
		ReverseMinHoldBars:    0,
		ReverseMinGapPct:      trading.DefaultReverseMinGapPct,
		CooldownBarsAfterLoss: trading.DefaultCooldownBarsAfterLoss,
		SlNoiseMult:           trading.DefaultSlNoiseMult,
		TpAtrMult:             trading.DefaultTpAtrMult,
		FeeEdgeMult:           trading.DefaultFeeEdgeMult,
	}
}

func (row strategyRow) view() strategyView {
	rec := row.Record
	return strategyView{
		ID:                    row.ID,
		Symbol:                rec.Symbol,
		Leverage:              rec.Leverage,
		MarginMode:            rec.MarginMode,
		EmaFast:               rec.EmaFast,
		EmaSlow:               rec.EmaSlow,
		Timeframe:             rec.Timeframe,
		StopR:                 rec.StopR,
		TakeProfitR:           rec.TakeProfitR,
		DailyLossPct:          rec.DailyLossPct,
		MaxMarginUsdt:         rec.MaxMarginUsdt,
		ExchangeKeyID:         rec.ExchangeKeyID,
		Mode:                  rec.Mode,
		Market:                trading.NormalizeMarket(rec.Market),
		EntryMode:             rec.EntryMode,
		MinScore:              rec.MinScore,
		MinWinRate:            rec.MinWinRate,
		MinTrades:             rec.MinTrades,
		MaxMarginPerTradeUsdt: rec.MaxMarginPerTradeUsdt,
		MaxConsecutiveLosses:  rec.MaxConsecutiveLosses,
		PauseBalanceUsdt:      rec.PauseBalanceUsdt,
		PauseReason:           rec.PauseReason,
		PauseEntries:          rec.PauseEntries,
		MaxOpenPositions:      rec.MaxOpenPositions,
		RSILongMin:            rec.RSILongMin,
		RSILongMax:            rec.RSILongMax,
		RSIShortMin:           rec.RSIShortMin,
		RSIShortMax:           rec.RSIShortMax,
		GambleMode:            rec.GambleMode,
		ScalpTpPct:            rec.ScalpTpPct,
		ScalpSlPct:            rec.ScalpSlPct,
		RFraction:             rec.RFraction,
		ExpectancyTpCapR:      rec.ExpectancyTpCapR,
		TakerFeeRate:          rec.TakerFeeRate,
		MakerFeeRate:          rec.MakerFeeRate,
		ExpectancyGate:        rec.ExpectancyGate,
		ReverseMinHoldBars:    rec.ReverseMinHoldBars,
		ReverseMinGapPct:      rec.ReverseMinGapPct,
		CooldownBarsAfterLoss: rec.CooldownBarsAfterLoss,
		SlNoiseMult:           rec.SlNoiseMult,
		TpAtrMult:             rec.TpAtrMult,
		FeeEdgeMult:           rec.FeeEdgeMult,
		Running:               rec.Running,
		ExchangeKeyActive:     row.ExchangeKeyActive,
		ExchangeKeyNetwork:    row.ExchangeKeyNetwork,
		Warnings:              strategyWarnings(rec.Mode, row.ExchangeKeyNetwork, row.ExchangeKeyActive),
		CreatedAt:             row.CreatedAt,
		UpdatedAt:             row.UpdatedAt,
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
	if taken, fieldErr := runningSymbolTaken(user.ID, rec.ExchangeKeyID, rec.Symbol, 0); fieldErr != nil {
		writeTradingError(c, fieldErr)
		return
	} else if taken {
		fail(c, http.StatusConflict, "同一交易所密钥下该交易对已有运行中的策略", "symbol_in_use")
		return
	}
	res, err := exec(strategyInsertSQL,
		user.ID, rec.Symbol, rec.Leverage, rec.MarginMode, rec.EmaFast, rec.EmaSlow, rec.Timeframe,
		rec.StopR, rec.TakeProfitR, rec.DailyLossPct, rec.MaxMarginUsdt, rec.ExchangeKeyID, rec.Mode, rec.Market,
		rec.EntryMode, rec.MinScore, rec.MinWinRate, rec.MinTrades,
		rec.MaxMarginPerTradeUsdt, rec.MaxConsecutiveLosses, rec.PauseBalanceUsdt, rec.PauseReason,
		rec.MaxOpenPositions,
		rec.RSILongMin, rec.RSILongMax, rec.RSIShortMin, rec.RSIShortMax,
		boolInt(rec.GambleMode), rec.ScalpTpPct, rec.ScalpSlPct,
		rec.RFraction, rec.ExpectancyTpCapR, rec.TakerFeeRate, rec.MakerFeeRate, boolInt(rec.ExpectancyGate),
		rec.ReverseMinHoldBars, rec.ReverseMinGapPct, rec.CooldownBarsAfterLoss,
		rec.SlNoiseMult, rec.TpAtrMult, rec.FeeEdgeMult,
		0,
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
	if taken, fieldErr := runningSymbolTaken(user.ID, rec.ExchangeKeyID, rec.Symbol, id); fieldErr != nil {
		writeTradingError(c, fieldErr)
		return
	} else if taken {
		fail(c, http.StatusConflict, "同一交易所密钥下该交易对已有运行中的策略", "symbol_in_use")
		return
	}
	res, err := exec(strategyUpdateSQL,
		rec.Symbol, rec.Leverage, rec.MarginMode, rec.EmaFast, rec.EmaSlow, rec.Timeframe,
		rec.StopR, rec.TakeProfitR, rec.DailyLossPct, rec.MaxMarginUsdt, rec.ExchangeKeyID, rec.Mode, rec.Market,
		rec.EntryMode, rec.MinScore, rec.MinWinRate, rec.MinTrades,
		rec.MaxMarginPerTradeUsdt, rec.MaxConsecutiveLosses, rec.PauseBalanceUsdt, rec.PauseReason,
		rec.MaxOpenPositions,
		rec.RSILongMin, rec.RSILongMax, rec.RSIShortMin, rec.RSIShortMax,
		boolInt(rec.GambleMode), rec.ScalpTpPct, rec.ScalpSlPct,
		rec.RFraction, rec.ExpectancyTpCapR, rec.TakerFeeRate, rec.MakerFeeRate, boolInt(rec.ExpectancyGate),
		rec.ReverseMinHoldBars, rec.ReverseMinGapPct, rec.CooldownBarsAfterLoss,
		rec.SlNoiseMult, rec.TpAtrMult, rec.FeeEdgeMult,
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
	reloadStrategyConfig(user.ID, row)
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
	stopStrategyRunner(id)
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
		label   sql.NullString
	)
	var running, gamble, pauseEntries, expectancyGate int
	err := s.Scan(
		&row.ID, &row.Record.Symbol, &row.Record.Leverage, &row.Record.MarginMode,
		&row.Record.EmaFast, &row.Record.EmaSlow, &row.Record.Timeframe,
		&row.Record.StopR, &row.Record.TakeProfitR, &row.Record.DailyLossPct, &row.Record.MaxMarginUsdt,
		&row.Record.ExchangeKeyID, &row.Record.Mode, &row.Record.Market,
		&row.Record.EntryMode, &row.Record.MinScore, &row.Record.MinWinRate, &row.Record.MinTrades,
		&row.Record.MaxMarginPerTradeUsdt, &row.Record.MaxConsecutiveLosses, &row.Record.PauseBalanceUsdt, &row.Record.PauseReason,
		&pauseEntries,
		&row.Record.MaxOpenPositions,
		&row.Record.RSILongMin, &row.Record.RSILongMax, &row.Record.RSIShortMin, &row.Record.RSIShortMax,
		&gamble, &row.Record.ScalpTpPct, &row.Record.ScalpSlPct,
		&row.Record.RFraction, &row.Record.ExpectancyTpCapR, &row.Record.TakerFeeRate, &row.Record.MakerFeeRate, &expectancyGate,
		&row.Record.ReverseMinHoldBars, &row.Record.ReverseMinGapPct, &row.Record.CooldownBarsAfterLoss,
		&row.Record.SlNoiseMult, &row.Record.TpAtrMult, &row.Record.FeeEdgeMult,
		&running,
		&row.CreatedAt, &row.UpdatedAt,
		&network, &status, &label,
	)
	if err != nil {
		return strategyRow{}, err
	}
	if network.Valid {
		row.ExchangeKeyNetwork = network.String
	}
	if label.Valid {
		row.ExchangeKeyLabel = label.String
	}
	row.ExchangeKeyActive = status.Valid && status.Int64 == exchangeKeyActive
	row.Record.GambleMode = gamble == 1
	row.Record.Running = running == 1
	row.Record.PauseEntries = pauseEntries != 0
	row.Record.ExpectancyGate = expectancyGate != 0
	return row, nil
}

type pauseEntriesBody struct {
	Paused       *bool `json:"paused"`
	PauseEntries *bool `json:"pauseEntries"`
}

func pauseEntriesView(id int64, paused bool) gin.H {
	return gin.H{"strategyId": id, "pauseEntries": paused}
}

// GetStrategyPauseEntries 读取这条策略是否暂停新开仓。
func GetStrategyPauseEntries(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
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
		log.Printf("[trading] 读取暂停开仓失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取暂停开仓失败", "server_error")
		return
	}
	ok(c, pauseEntriesView(row.ID, row.Record.PauseEntries))
}

// PostStrategyPauseEntries 立刻把暂停新开仓写入数据库，并通知正在跑的引擎。
// 已有仓和止损止盈不动。这不是 pauseBalanceUsdt。
func PostStrategyPauseEntries(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	var body pauseEntriesBody
	if err := c.ShouldBindJSON(&body); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	paused, okFlag := pauseEntriesFlag(body)
	if !okFlag {
		fail(c, http.StatusBadRequest, "请用 pauseEntries 标明是否暂停新开仓", "bad_request")
		return
	}
	current, err := loadStrategy(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "策略不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[trading] 读取策略失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新暂停开仓失败", "server_error")
		return
	}
	if _, err := exec(strategyPauseEntriesSQL, boolInt(paused), id, user.ID); err != nil {
		log.Printf("[trading] 更新暂停开仓失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新暂停开仓失败", "server_error")
		return
	}
	current.Record.PauseEntries = paused
	reloadStrategyConfig(user.ID, current)
	trading.DefaultHub().SetPauseEntries(user.ID, id, paused)
	log.Printf("[trading] 用户 %s 策略 %d 暂停新开仓=%t", user.Username, id, paused)
	ok(c, pauseEntriesView(id, paused))
}

func pauseEntriesFlag(body pauseEntriesBody) (bool, bool) {
	if body.PauseEntries != nil {
		return *body.PauseEntries, true
	}
	if body.Paused != nil {
		return *body.Paused, true
	}
	return false, false
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func setStrategyPaused(id int64, reason string) error {
	_, err := exec(strategyPauseByIDSQL, reason, id)
	return err
}

func clearStrategyPause(id, userID int64) error {
	_, err := exec(strategyClearPauseSQL, id, userID)
	return err
}

func setStrategyRunning(id, userID int64, running bool) error {
	flag := 0
	if running {
		flag = 1
	}
	if userID > 0 {
		_, err := exec(strategyRunningSQL, flag, id, userID)
		return err
	}
	_, err := exec(strategyRunningByIDSQL, flag, id)
	return err
}

func runningSymbolTaken(userID, keyID int64, symbol string, exceptID int64) (bool, *tradingError) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if trading.DefaultHub().SymbolRunning(keyID, symbol, exceptID) {
		return true, nil
	}
	var id int64
	err := queryRow(strategyRunningDupSQL, userID, keyID, symbol, exceptID).Scan(&id)
	if isNotFound(err) {
		return false, nil
	}
	if err != nil {
		log.Printf("[trading] 检查重复交易对失败: %v", err)
		return false, &tradingError{http.StatusInternalServerError, "检查策略失败", "server_error"}
	}
	return id > 0, nil
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
	if in.Market != nil {
		/*
			先看**原值**再归一。

			归一放在此处之后（函数末尾），如果这里直接 Normalize，未知取值会
			当场被兜成 futures —— 等 validateStrategy 再去看时原值已经没了，
			拼错一个词就变成"跑在合约上"，而那是要下真单的。
		*/
		raw := strings.TrimSpace(*in.Market)
		if raw != "" && !strings.EqualFold(raw, trading.MarketFutures) && !strings.EqualFold(raw, trading.MarketSpot) {
			return out, &tradingError{http.StatusBadRequest, "market 只能是 futures 或 spot", "invalid_market"}
		}
		out.Market = trading.NormalizeMarket(raw)
	}
	if in.EntryMode != nil {
		out.EntryMode = strings.ToLower(strings.TrimSpace(*in.EntryMode))
	}
	if in.MinScore != nil {
		out.MinScore = *in.MinScore
	}
	if in.MinWinRate != nil {
		out.MinWinRate = round4(*in.MinWinRate)
	}
	if in.MinTrades != nil {
		out.MinTrades = *in.MinTrades
	}
	if in.MaxMarginPerTradeUsdt != nil {
		out.MaxMarginPerTradeUsdt = round4(*in.MaxMarginPerTradeUsdt)
	}
	if in.MaxConsecutiveLosses != nil {
		out.MaxConsecutiveLosses = *in.MaxConsecutiveLosses
	}
	if in.PauseBalanceUsdt != nil {
		out.PauseBalanceUsdt = round4(*in.PauseBalanceUsdt)
	}
	if in.MaxOpenPositions != nil {
		out.MaxOpenPositions = *in.MaxOpenPositions
	}
	if in.RSILongMin != nil {
		out.RSILongMin = round4(*in.RSILongMin)
	}
	if in.RSILongMax != nil {
		out.RSILongMax = round4(*in.RSILongMax)
	}
	if in.RSIShortMin != nil {
		out.RSIShortMin = round4(*in.RSIShortMin)
	}
	if in.RSIShortMax != nil {
		out.RSIShortMax = round4(*in.RSIShortMax)
	}
	if in.GambleMode != nil {
		out.GambleMode = *in.GambleMode
	}
	if in.ScalpTpPct != nil {
		out.ScalpTpPct = round4(*in.ScalpTpPct)
	}
	if in.ScalpSlPct != nil {
		out.ScalpSlPct = round4(*in.ScalpSlPct)
	}
	if in.RFraction != nil {
		out.RFraction = round8(*in.RFraction)
	}
	if in.ExpectancyTpCapR != nil {
		out.ExpectancyTpCapR = round4(*in.ExpectancyTpCapR)
	}
	if in.TakerFeeRate != nil {
		out.TakerFeeRate = round8(*in.TakerFeeRate)
	}
	if in.MakerFeeRate != nil {
		out.MakerFeeRate = round8(*in.MakerFeeRate)
	}
	if in.ExpectancyGate != nil {
		out.ExpectancyGate = *in.ExpectancyGate
	}
	if in.ReverseMinHoldBars != nil {
		out.ReverseMinHoldBars = *in.ReverseMinHoldBars
	}
	if in.ReverseMinGapPct != nil {
		out.ReverseMinGapPct = round8(*in.ReverseMinGapPct)
	}
	if in.CooldownBarsAfterLoss != nil {
		out.CooldownBarsAfterLoss = *in.CooldownBarsAfterLoss
	}
	if in.SlNoiseMult != nil {
		out.SlNoiseMult = round8(*in.SlNoiseMult)
	}
	if in.TpAtrMult != nil {
		out.TpAtrMult = round8(*in.TpAtrMult)
	}
	if in.FeeEdgeMult != nil {
		out.FeeEdgeMult = round8(*in.FeeEdgeMult)
	}
	if out.ScalpTpPct <= 0 {
		out.ScalpTpPct = trading.DefaultScalpPct
	}
	if out.ScalpSlPct <= 0 {
		out.ScalpSlPct = trading.DefaultScalpPct
	}
	if out.ReverseMinGapPct <= 0 {
		out.ReverseMinGapPct = trading.DefaultReverseMinGapPct
	}
	if out.SlNoiseMult <= 0 {
		out.SlNoiseMult = trading.DefaultSlNoiseMult
	}
	if out.TpAtrMult <= 0 {
		out.TpAtrMult = trading.DefaultTpAtrMult
	}
	if out.FeeEdgeMult <= 0 {
		out.FeeEdgeMult = trading.DefaultFeeEdgeMult
	}
	if err := validateStrategy(out, creating && in.ExchangeKeyID == nil); err != nil {
		return strategyRecord{}, err
	}
	/*
		现货没有杠杆：**落库前**就把杠杆钉成 1。

		引擎侧也会归一（NewEngine 里那次），所以不钉也不会下错单；但库里留着
		用户填的 20，界面上就会显示"现货 20 倍杠杆" —— 一个不存在的设置，
		比多写三行更容易误导人。
	*/
	out.Market = trading.NormalizeMarket(out.Market)
	if out.Market == trading.MarketSpot {
		out.Leverage = 1
	}
	return out, nil
}

func validateStrategy(rec strategyRecord, missingKey bool) *tradingError {
	if !trading.AllowedSymbol(rec.Symbol) {
		return &tradingError{http.StatusBadRequest, "交易对必须是 USDT 永续代码，例如 XRPUSDT、DOGEUSDT", "invalid_symbol"}
	}
	if rec.MarginMode != strategyMarginMode {
		return &tradingError{http.StatusBadRequest, "v1 只允许逐仓（isolated）", "invalid_margin_mode"}
	}
	if rec.Leverage < 1 || rec.Leverage > trading.MaxLeverage {
		return &tradingError{http.StatusBadRequest, fmt.Sprintf("杠杆必须是 1 到 %d 的整数", trading.MaxLeverage), "invalid_leverage"}
	}
	if _, ok := strategyTimeframes[rec.Timeframe]; !ok {
		return &tradingError{http.StatusBadRequest, "K 线周期只支持 " + trading.SupportedTimeframes, "invalid_timeframe"}
	}
	if rec.EmaFast < 2 || rec.EmaFast > 50 || rec.EmaSlow < 3 || rec.EmaSlow > 200 || rec.EmaFast >= rec.EmaSlow {
		return &tradingError{http.StatusBadRequest, "快线要小于慢线，且落在允许范围内", "invalid_ema"}
	}
	if !validRisk(rec.StopR, 20) || !validRisk(rec.TakeProfitR, 20) {
		return &tradingError{http.StatusBadRequest, "止损和止盈要大于 0 且不超过 20", "invalid_risk"}
	}
	if !validRisk(rec.DailyLossPct, trading.DailyLossOffPct) {
		return &tradingError{http.StatusBadRequest, fmt.Sprintf("日亏停机阈值要大于 0 且不超过 %g", float64(trading.DailyLossOffPct)), "invalid_risk"}
	}
	if !validRisk(rec.MaxMarginUsdt, 1_000_000) {
		return &tradingError{http.StatusBadRequest, "单笔保证金上限要大于 0", "invalid_risk"}
	}
	if rec.RFraction <= 0 || rec.RFraction > 0.2 {
		return &tradingError{http.StatusBadRequest, "1R 比例要大于 0 且不超过 20%", "rFraction"}
	}
	if rec.ExpectancyTpCapR <= 0 || rec.ExpectancyTpCapR > 20 {
		return &tradingError{http.StatusBadRequest, "期望止盈上限要大于 0 且不超过 20R", "expectancyTpCapR"}
	}
	if rec.TakerFeeRate <= 0 || rec.TakerFeeRate > 0.01 {
		return &tradingError{http.StatusBadRequest, "taker 手续费回退要大于 0 且不超过 1%", "takerFeeRate"}
	}
	if rec.MakerFeeRate <= 0 || rec.MakerFeeRate > 0.01 {
		return &tradingError{http.StatusBadRequest, "maker 手续费回退要大于 0 且不超过 1%", "makerFeeRate"}
	}
	if rec.Mode != networkTestnet && rec.Mode != networkLive {
		return &tradingError{http.StatusBadRequest, "mode 只能是 testnet 或 live", "invalid_mode"}
	}
	// market 是「合约还是现货」，与 mode 正交。空值按合约处理（老策略）。
	// 这里显式拒绝未知取值，而不是让 NormalizeMarket 悄悄兜成 futures ——
	// 拼错一个词就变成"跑在合约上"，那是要下真单的。
	if v := strings.TrimSpace(rec.Market); v != "" &&
		!strings.EqualFold(v, trading.MarketFutures) && !strings.EqualFold(v, trading.MarketSpot) {
		return &tradingError{http.StatusBadRequest, "market 只能是 futures 或 spot", "invalid_market"}
	}
	if missingKey || rec.ExchangeKeyID <= 0 {
		return &tradingError{http.StatusBadRequest, "请先绑定一把未作废的交易所密钥", "exchange_key_required"}
	}
	if rec.EntryMode != trading.EntryModeCross && rec.EntryMode != trading.EntryModeTrend {
		return &tradingError{http.StatusBadRequest, "entryMode 只能是 cross 或 trend", "invalid_entry_mode"}
	}
	if rec.MinScore < 1 || rec.MinScore > trading.MaxTrendScore {
		return &tradingError{http.StatusBadRequest, fmt.Sprintf("minScore 要在 1 到 %d 之间", trading.MaxTrendScore), "invalid_score"}
	}
	if rec.MinWinRate < 0 || rec.MinWinRate > 1 {
		return &tradingError{http.StatusBadRequest, "minWinRate 要在 0 到 1 之间", "invalid_win_rate"}
	}
	if rec.MinTrades < 1 || rec.MinTrades > 10000 {
		return &tradingError{http.StatusBadRequest, "minTrades 要在 1 到 10000 之间", "invalid_min_trades"}
	}
	if rec.ScalpTpPct <= 0 || rec.ScalpTpPct > 0.2 || rec.ScalpSlPct <= 0 || rec.ScalpSlPct > 0.2 {
		return &tradingError{http.StatusBadRequest, "剥头皮止损和止盈要大于 0 且不超过 20%", "scalpPct"}
	}
	if rec.Mode == networkLive && !rec.GambleMode && rec.MinWinRate < trading.DefaultMinWinRate {
		return &tradingError{http.StatusBadRequest, fmt.Sprintf("实盘 minWinRate 不能低于 %g", trading.DefaultMinWinRate), "minWinRate"}
	}
	if rec.Mode == networkLive && !rec.GambleMode && rec.MinTrades < trading.DefaultMinTrades {
		return &tradingError{http.StatusBadRequest, fmt.Sprintf("实盘 minTrades 不能低于 %d", trading.DefaultMinTrades), "minTrades"}
	}
	if rec.MaxMarginPerTradeUsdt < 0 || rec.MaxMarginPerTradeUsdt > 1_000_000 {
		return &tradingError{http.StatusBadRequest, "单笔保证金上限要在 0 到 1000000 之间，0 表示关闭", "maxMarginPerTradeUsdt"}
	}
	if rec.MaxConsecutiveLosses < 0 || rec.MaxConsecutiveLosses > 1000 {
		return &tradingError{http.StatusBadRequest, "连亏暂停次数要在 0 到 1000 之间，0 表示关闭", "maxConsecutiveLosses"}
	}
	if rec.PauseBalanceUsdt < trading.BalanceFloorUSDT || rec.PauseBalanceUsdt > 1_000_000 {
		return &tradingError{http.StatusBadRequest, "暂停余额不能低于 0.5", "pauseBalanceUsdt"}
	}
	if rec.MaxOpenPositions < 0 || rec.MaxOpenPositions > 10000 {
		return &tradingError{http.StatusBadRequest, "同时持仓上限要在 0 到 10000 之间，0 表示关闭", "maxOpenPositions"}
	}
	if rec.RSILongMin < 0 || rec.RSILongMax > 100 || rec.RSILongMin >= rec.RSILongMax {
		return &tradingError{http.StatusBadRequest, "做多 RSI 区间要落在 0 到 100，且下限小于上限", "rsiLongMin"}
	}
	if rec.RSIShortMin < 0 || rec.RSIShortMax > 100 || rec.RSIShortMin >= rec.RSIShortMax {
		return &tradingError{http.StatusBadRequest, "做空 RSI 区间要落在 0 到 100，且下限小于上限", "rsiShortMin"}
	}
	if rec.ReverseMinHoldBars < 0 || rec.ReverseMinHoldBars > 10000 {
		return &tradingError{http.StatusBadRequest, "反向最少持仓 K 线要在 0 到 10000 之间", "reverseMinHoldBars"}
	}
	if rec.ReverseMinGapPct <= 0 || rec.ReverseMinGapPct > 0.2 {
		return &tradingError{http.StatusBadRequest, "反向最小张开要大于 0 且不超过 20%", "reverseMinGapPct"}
	}
	if rec.CooldownBarsAfterLoss < 0 || rec.CooldownBarsAfterLoss > 10000 {
		return &tradingError{http.StatusBadRequest, "亏损冷却 K 线要在 0 到 10000 之间，0 表示关闭", "cooldownBarsAfterLoss"}
	}
	if rec.SlNoiseMult <= 0 || rec.SlNoiseMult > 1000 || rec.TpAtrMult <= 0 || rec.TpAtrMult > 1000 || rec.FeeEdgeMult <= 0 || rec.FeeEdgeMult > 1000 {
		return &tradingError{http.StatusBadRequest, "波动和手续费倍数要大于 0 且不超过 1000", "entryFilterMult"}
	}
	return nil
}

func validRisk(v, max float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0 && v <= max
}

func round4(v float64) float64 {
	return math.Round(v*10000) / 10000
}

func round8(v float64) float64 {
	return math.Round(v*1e8) / 1e8
}
