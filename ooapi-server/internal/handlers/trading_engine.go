package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
	"ooapi/internal/trading"
)

// 引擎读已上线的 trading_strategies / exchange_keys，不另存一份配置。
// 密钥只在发单、平仓或交易台签名读盘时解开。测网撮合在内存里完成；实盘默认被门闩挡住。

type engineRequest struct {
	StrategyID     *int64           `json:"strategyId"`
	Now            string           `json:"now"`
	Candles        []trading.Candle `json:"candles"`
	Higher         []trading.Candle `json:"higherCandles"`
	MarkPrice      float64          `json:"markPrice"`
	FundingRate    float64          `json:"fundingRate"`
	LiqDistancePct *float64         `json:"liqDistancePct"`
	EquityUSDT     float64          `json:"equityUsdt"`
}

type testnetGreenRequest struct {
	Passed *bool `json:"passed"`
}

type engineStateView struct {
	trading.Snapshot
	StrategyID         int64                 `json:"strategyId"`
	Symbol             string                `json:"symbol"`
	Leverage           int                   `json:"leverage"`
	MarginMode         string                `json:"marginMode"`
	Timeframe          string                `json:"timeframe"`
	ExchangeKeyID      int64                 `json:"exchangeKeyId"`
	ExchangeKeyLabel   string                `json:"exchangeKeyLabel"`
	ExchangeKeyNetwork string                `json:"exchangeKeyNetwork,omitempty"`
	RealizedNetwork    string                `json:"realizedNetwork"`
	Entries            []trading.EntryRecord `json:"entries"`
}

// GetTradingEngineState 返回当前用户某条策略的内存状态。没有会话时是 Idle。
func GetTradingEngineState(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	row, terr := loadEngineStrategy(c, user.ID, engineRequest{})
	if terr != nil {
		writeEngineErr(c, terr)
		return
	}
	if snap, found := trading.DefaultHub().State(user.ID, row.ID); found {
		ok(c, bindEngineView(c, row, snap, true))
		return
	}
	ok(c, bindEngineView(c, row, trading.Snapshot{}, false))
}

// StartTradingEngine 按最新策略（或指定 id）做启动检查，进入 Armed，不下单。
func StartTradingEngine(c *gin.Context) {
	runEngine(c, func(userID int64, row strategyRow, req engineRequest, secrets trading.SecretOpener) (trading.Snapshot, error) {
		when, err := parseEngineTime(req.Now)
		if err != nil {
			return trading.Snapshot{}, err
		}
		if row.Record.PauseReason != "" {
			return trading.Snapshot{}, &tradingError{Status: http.StatusConflict, Message: "策略已自动暂停，请先手动恢复", Code: "paused"}
		}
		if taken, terr := runningSymbolTaken(userID, row.Record.ExchangeKeyID, row.Record.Symbol, row.ID); terr != nil {
			return trading.Snapshot{}, terr
		} else if taken {
			return trading.Snapshot{}, trading.ErrSymbolInUse
		}
		snap, err := trading.DefaultHub().Start(userID, row.ID, strategyConfig(row), trading.StartInput{
			Now:            when,
			FundingRate:    req.FundingRate,
			LiqDistancePct: liqDistance(req.LiqDistancePct),
			EquityUSDT:     req.EquityUSDT,
		}, secrets)
		if err == nil {
			if dbErr := setStrategyRunning(row.ID, userID, true); dbErr != nil {
				log.Printf("[trading] 记下运行标记失败: %v", dbErr)
			}
			ensureStrategyRunner(userID, row)
		}
		return snap, err
	})
}

// ResumeTradingEngine 清掉自动暂停后按启动流程重新武装。重启不会自己做这件事。
func ResumeTradingEngine(c *gin.Context) {
	runEngine(c, func(userID int64, row strategyRow, req engineRequest, secrets trading.SecretOpener) (trading.Snapshot, error) {
		if err := clearStrategyPause(row.ID, userID); err != nil {
			return trading.Snapshot{}, err
		}
		row.Record.PauseReason = ""
		trading.DefaultHub().ClearPause(userID, row.ID)
		when, err := parseEngineTime(req.Now)
		if err != nil {
			return trading.Snapshot{}, err
		}
		if taken, terr := runningSymbolTaken(userID, row.Record.ExchangeKeyID, row.Record.Symbol, row.ID); terr != nil {
			return trading.Snapshot{}, terr
		} else if taken {
			return trading.Snapshot{}, trading.ErrSymbolInUse
		}
		snap, err := trading.DefaultHub().Start(userID, row.ID, strategyConfig(row), trading.StartInput{
			Now:            when,
			FundingRate:    req.FundingRate,
			LiqDistancePct: liqDistance(req.LiqDistancePct),
			EquityUSDT:     req.EquityUSDT,
		}, secrets)
		if err == nil {
			if dbErr := setStrategyRunning(row.ID, userID, true); dbErr != nil {
				log.Printf("[trading] 记下运行标记失败: %v", dbErr)
			}
			ensureStrategyRunner(userID, row)
		}
		return snap, err
	})
}

// StepTradingEngine 推进一次。没有交叉或同一根 K 线时不会解开密钥。
func StepTradingEngine(c *gin.Context) {
	runEngine(c, func(userID int64, row strategyRow, req engineRequest, secrets trading.SecretOpener) (trading.Snapshot, error) {
		in, err := stepInput(req)
		if err != nil {
			return trading.Snapshot{}, err
		}
		return trading.DefaultHub().Step(userID, row.ID, strategyConfig(row), in, secrets)
	})
}

// StopTradingEngine 撤掉挂单并结束会话。Error 只能从这里离开。
func StopTradingEngine(c *gin.Context) {
	runEngine(c, func(userID int64, row strategyRow, req engineRequest, secrets trading.SecretOpener) (trading.Snapshot, error) {
		in, err := stepInput(req)
		if err != nil {
			return trading.Snapshot{}, err
		}
		snap, err := trading.DefaultHub().Stop(userID, row.ID, in, secrets)
		if err == nil {
			if dbErr := setStrategyRunning(row.ID, userID, false); dbErr != nil {
				log.Printf("[trading] 清除运行标记失败: %v", dbErr)
			}
			stopStrategyRunner(row.ID)
		}
		return snap, err
	})
}

// SetTradingTestnetGreen 打开或关闭进程内实盘门闩。默认关闭，不写入策略表。
func SetTradingTestnetGreen(c *gin.Context) {
	if _, okUser := requireTradingUser(c); !okUser {
		return
	}
	raw, okBody := readBody(c)
	if !okBody {
		return
	}
	var req testnetGreenRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.Passed == nil {
		fail(c, http.StatusBadRequest, "请用 passed 标明测网是否全绿", "bad_request")
		return
	}
	trading.SetTestnetGreen(*req.Passed)
	ok(c, gin.H{"testnetGreen": trading.TestnetGreen()})
}

type engineAction func(userID int64, row strategyRow, req engineRequest, secrets trading.SecretOpener) (trading.Snapshot, error)

func runEngine(c *gin.Context, action engineAction) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	req, okReq := bindEngineRequest(c)
	if !okReq {
		return
	}
	row, err := loadEngineStrategy(c, user.ID, req)
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	if terr := ensureEngineKey(row); terr != nil {
		writeEngineErr(c, terr)
		return
	}
	snap, err := action(user.ID, row, req, exchangeSecretOpener(user.ID, row))
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	ok(c, bindEngineView(c, row, snap, true))
}

func bindEngineRequest(c *gin.Context) (engineRequest, bool) {
	var req engineRequest
	raw, okBody := readBody(c)
	if !okBody {
		return req, false
	}
	if len(raw) == 0 {
		return req, true
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		fail(c, http.StatusBadRequest, "请求体不是合法的 JSON", "bad_request")
		return req, false
	}
	return req, true
}

func readBody(c *gin.Context) ([]byte, bool) {
	if c.Request == nil || c.Request.Body == nil {
		return nil, true
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		fail(c, http.StatusBadRequest, "读取请求失败", "bad_request")
		return nil, false
	}
	return []byte(strings.TrimSpace(string(raw))), true
}

func loadEngineStrategy(c *gin.Context, userID int64, req engineRequest) (strategyRow, error) {
	id, err := requestedStrategyID(c, req)
	if err != nil {
		return strategyRow{}, err
	}
	if id > 0 {
		return loadStrategy(id, userID)
	}
	return loadNewestStrategy(userID)
}

func requestedStrategyID(c *gin.Context, req engineRequest) (int64, error) {
	if req.StrategyID != nil {
		if *req.StrategyID <= 0 {
			return 0, &tradingError{Status: http.StatusBadRequest, Message: "策略 ID 不正确", Code: "bad_request"}
		}
		return *req.StrategyID, nil
	}
	raw := strings.TrimSpace(c.Query("strategyId"))
	if raw == "" {
		return 0, nil
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, &tradingError{Status: http.StatusBadRequest, Message: "策略 ID 不正确", Code: "bad_request"}
	}
	return id, nil
}

func loadNewestStrategy(userID int64) (strategyRow, error) {
	rows, err := queryRows(strategyListSQL, userID)
	if err != nil {
		return strategyRow{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return strategyRow{}, err
		}
		return strategyRow{}, sql.ErrNoRows
	}
	row, err := scanStrategy(rows)
	if err != nil {
		return strategyRow{}, err
	}
	return row, rows.Err()
}

func strategyConfig(row strategyRow) trading.Config {
	rec := row.Record
	return trading.Config{
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
		EntryMode:             rec.EntryMode,
		MinScore:              rec.MinScore,
		MinWinRate:            rec.MinWinRate,
		MinTrades:             rec.MinTrades,
		MaxMarginPerTradeUsdt: rec.MaxMarginPerTradeUsdt,
		MaxConsecutiveLosses:  rec.MaxConsecutiveLosses,
		PauseBalanceUsdt:      rec.PauseBalanceUsdt,
		MaxOpenPositions:      rec.MaxOpenPositions,
		PauseReason:           rec.PauseReason,
		RSILongMin:            rec.RSILongMin,
		RSILongMax:            rec.RSILongMax,
		RSIShortMin:           rec.RSIShortMin,
		RSIShortMax:           rec.RSIShortMax,
		GambleMode:            rec.GambleMode,
		ScalpTpPct:            rec.ScalpTpPct,
		ScalpSlPct:            rec.ScalpSlPct,
	}.Normalize()
}

func ensureEngineKey(row strategyRow) *tradingError {
	if row.Record.ExchangeKeyID <= 0 || !row.ExchangeKeyActive {
		return &tradingError{Status: http.StatusBadRequest, Message: "请先绑定一把未作废的交易所密钥", Code: "exchange_key_required"}
	}
	if row.ExchangeKeyNetwork != row.Record.Mode {
		return &tradingError{Status: http.StatusBadRequest, Message: "策略 mode 与密钥 network 不一致", Code: "exchange_key_required"}
	}
	return nil
}

// exchangeSecretOpener 在引擎真正发单时才读 exchange_keys 并解密。
func exchangeSecretOpener(userID int64, row strategyRow) trading.SecretOpener {
	keyID := row.Record.ExchangeKeyID
	mode := row.Record.Mode
	return func() (trading.Credentials, error) {
		stored, err := loadExchangeKey(keyID, userID)
		if isNotFound(err) || (err == nil && stored.Status != exchangeKeyActive) {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		if err != nil {
			return trading.Credentials{}, err
		}
		if stored.Network != mode {
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

func stepInput(req engineRequest) (trading.StepInput, error) {
	when, err := parseEngineTime(req.Now)
	if err != nil {
		return trading.StepInput{}, err
	}
	return trading.StepInput{
		Now:            when,
		Candles:        req.Candles,
		Higher:         req.Higher,
		MarkPrice:      req.MarkPrice,
		FundingRate:    req.FundingRate,
		LiqDistancePct: liqDistance(req.LiqDistancePct),
		EquityUSDT:     req.EquityUSDT,
	}, nil
}

func parseEngineTime(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	when, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, &tradingError{Status: http.StatusBadRequest, Message: "now 需要 RFC3339 时间", Code: "bad_request"}
	}
	return when, nil
}

// 省略强平距离表示空仓，不能当成 0（0 会被当成贴着强平价）。
func liqDistance(v *float64) float64 {
	if v == nil {
		return -1
	}
	return *v
}

func bindEngineView(c *gin.Context, row strategyRow, snap trading.Snapshot, hasSession bool) engineStateView {
	if !hasSession {
		snap = trading.Snapshot{
			State: trading.StateIdle,
			Mode:  row.Record.Mode,
		}
	}
	if snap.Mode == "" {
		snap.Mode = row.Record.Mode
	}
	snap.TestnetGreen = trading.TestnetGreen()
	return engineStateView{
		Snapshot:           snap,
		StrategyID:         row.ID,
		Symbol:             row.Record.Symbol,
		Leverage:           row.Record.Leverage,
		MarginMode:         row.Record.MarginMode,
		Timeframe:          row.Record.Timeframe,
		ExchangeKeyID:      row.Record.ExchangeKeyID,
		ExchangeKeyLabel:   row.ExchangeKeyLabel,
		ExchangeKeyNetwork: row.ExchangeKeyNetwork,
		RealizedNetwork:    realizedNetwork(row, snap, hasSession),
		Entries:            strategyEntries(rowUserID(c), row.ID),
	}
}

func rowUserID(c *gin.Context) int64 {
	user, okUser := currentUser(c)
	if !okUser {
		return 0
	}
	return user.ID
}

// 有会话时按引擎 mode 标注盈亏来源；否则用账户 network，再退回策略 mode。
func realizedNetwork(row strategyRow, snap trading.Snapshot, hasSession bool) string {
	if hasSession && snap.Mode != "" {
		return snap.Mode
	}
	if row.ExchangeKeyNetwork != "" {
		return row.ExchangeKeyNetwork
	}
	return row.Record.Mode
}

func writeEngineErr(c *gin.Context, err error) {
	if err == nil {
		return
	}
	var te *tradingError
	if errors.As(err, &te) {
		writeTradingError(c, te)
		return
	}
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "还没有可运行的策略", "not_found")
		return
	}
	var ve *trading.ValidationError
	if errors.As(err, &ve) {
		fail(c, http.StatusBadRequest, ve.Error(), "invalid_config")
		return
	}
	switch {
	case errors.Is(err, trading.ErrLiveGateClosed):
		fail(c, http.StatusConflict, "测网还没全绿，不能走实盘", "live_gate_closed")
	case errors.Is(err, trading.ErrDailyHalt):
		fail(c, http.StatusConflict, "当日亏损已到阈值，等到下一个 UTC 日再开", "daily_halt")
	case errors.Is(err, trading.ErrBlocked):
		fail(c, http.StatusConflict, err.Error(), "start_blocked")
	case errors.Is(err, trading.ErrNotionalBelowMin):
		fail(c, http.StatusConflict, "名义价值低于交易所下限", "notional_below_minimum")
	case errors.Is(err, trading.ErrNoAutoReopen):
		fail(c, http.StatusConflict, "出错后不会自动重开，请先停止", "no_auto_reopen")
	case errors.Is(err, trading.ErrNotRunning):
		fail(c, http.StatusConflict, "策略还没启动", "not_running")
	case errors.Is(err, trading.ErrAlreadyRunning):
		fail(c, http.StatusConflict, "策略正在持仓中", "already_running")
	case errors.Is(err, trading.ErrConfigLocked):
		fail(c, http.StatusConflict, "持仓期间不能改策略", "config_locked")
	case errors.Is(err, trading.ErrEquityRequired):
		fail(c, http.StatusBadRequest, "启动需要账户权益", "equity_required")
	case errors.Is(err, trading.ErrKeyNotUsable):
		fail(c, http.StatusBadRequest, "交易所密钥不可用", "exchange_key_required")
	case errors.Is(err, trading.ErrSymbolInUse):
		fail(c, http.StatusConflict, "同一交易所密钥下该交易对已有运行中的策略", "symbol_in_use")
	case errors.Is(err, trading.ErrPaused):
		fail(c, http.StatusConflict, "策略已自动暂停，请先手动恢复", "paused")
	case errors.Is(err, trading.ErrNotConfigured):
		fail(c, http.StatusBadRequest, "策略还没配置", "not_configured")
	case errors.Is(err, trading.ErrBadMode):
		fail(c, http.StatusBadRequest, "mode 只能是 testnet 或 live", "invalid_mode")
	case errors.Is(err, trading.ErrLiveTransportDisabled):
		fail(c, http.StatusConflict, "实盘通道未打开，订单没有发出", "live_transport_disabled")
	default:
		log.Printf("[trading] 引擎失败: %v", err)
		fail(c, http.StatusInternalServerError, "策略引擎失败", "server_error")
	}
}
