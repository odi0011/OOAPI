package handlers

import (
	"database/sql"
	"errors"
	"log"
	"os"
	"strings"
	"time"

	"ooapi/internal/trading"
)

// strategyRunner 是进程内的多品种调度器。测试默认不启动。
var strategyRunner = trading.NewRunner(trading.DefaultHub())

func runnerDisabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("TRADING_RUNNER"))) {
	case "0", "false", "off":
		return true
	default:
		return false
	}
}

// StartTradingRunner 恢复数据库里 running=1 的策略，并在每根 K 线收盘后推进。
// TRADING_RUNNER=0 时不启动，只留手工 /api/trading/engine/step。
func StartTradingRunner() {
	installEntryLog()
	installOrderBook()
	strategyRunner.SetEntriesPaused(loadPauseEntries)
	strategyRunner.SetPauseBalance(loadPauseBalance)
	if runnerDisabled() {
		log.Printf("[trading] 进程内调度已关闭（TRADING_RUNNER）")
		return
	}
	trading.DefaultHub().SetPauseHook(func(id int64, reason string) {
		if err := setStrategyPaused(id, reason); err != nil {
			log.Printf("[trading] 记下暂停原因失败 id=%d: %v", id, err)
		}
		strategyRunner.Remove(id)
	})
	trading.DefaultHub().SetRunHook(func(id int64, running bool) {
		if err := setStrategyRunning(id, 0, running); err != nil {
			log.Printf("[trading] 同步运行标记失败 id=%d: %v", id, err)
		}
		if !running {
			strategyRunner.Remove(id)
		}
	})
	strategyRunner.SetStop(func(id int64) {
		if err := setStrategyRunning(id, 0, false); err != nil {
			log.Printf("[trading] 停止策略 %d 失败: %v", id, err)
		}
	})
	strategyRunner.Start()
	specs, err := loadRunningSpecs()
	if err != nil {
		log.Printf("[trading] 恢复运行中的策略失败: %v", err)
		return
	}
	strategyRunner.Sync(specs)
	log.Printf("[trading] 已恢复 %d 条运行中的策略", len(specs))
}

func ensureStrategyRunner(userID int64, row strategyRow) {
	if runnerDisabled() || !strategyRunner.Started() {
		return
	}
	row.Record.Running = true
	strategyRunner.Ensure(specFromRow(userID, row))
}

func stopStrategyRunner(strategyID int64) {
	strategyRunner.Remove(strategyID)
}

// reloadStrategyConfig 把保存后的参数写进正在跑的引擎和调度循环，不重启。
func reloadStrategyConfig(userID int64, row strategyRow) {
	cfg := strategyConfig(row)
	cfg.Revision = time.Now().UnixNano()
	spec := specFromRow(userID, row)
	spec.Config = cfg
	strategyRunner.Reload(spec)
	trading.DefaultHub().ApplyConfig(userID, row.ID, cfg)
}

func specFromRow(userID int64, row strategyRow) trading.RunSpec {
	return trading.RunSpec{
		UserID:  userID,
		Config:  strategyConfig(row),
		Secrets: exchangeSecretOpener(userID, row),
	}
}

const runningStrategiesSQL = `
SELECT s.user_id, ` + strategySelectCols + `
FROM trading_strategies s
LEFT JOIN exchange_keys k ON k.id = s.exchange_key_id AND k.user_id = s.user_id
WHERE s.running = 1 AND s.pause_reason = ''
ORDER BY s.id`

func loadRunningSpecs() ([]trading.RunSpec, error) {
	rows, err := queryRows(runningStrategiesSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var specs []trading.RunSpec
	for rows.Next() {
		var userID int64
		row, err := scanStrategyUser(rows, &userID)
		if err != nil {
			return nil, err
		}
		specs = append(specs, specFromRow(userID, row))
	}
	return specs, rows.Err()
}

func scanStrategyUser(s scanner, userID *int64) (strategyRow, error) {
	var (
		row            strategyRow
		network        sql.NullString
		status         sql.NullInt64
		label          sql.NullString
		running        int
		gamble         int
		pauseEntries   int
		expectancyGate int
	)
	err := s.Scan(
		userID,
		&row.ID, &row.Record.Symbol, &row.Record.Leverage, &row.Record.MarginMode,
		&row.Record.EmaFast, &row.Record.EmaSlow, &row.Record.Timeframe,
		&row.Record.StopR, &row.Record.TakeProfitR, &row.Record.DailyLossPct, &row.Record.MaxMarginUsdt,
		&row.Record.ExchangeKeyID, &row.Record.Mode,
		&row.Record.EntryMode, &row.Record.MinScore, &row.Record.MinWinRate, &row.Record.MinTrades,
		&row.Record.MaxMarginPerTradeUsdt, &row.Record.MaxConsecutiveLosses, &row.Record.PauseBalanceUsdt, &row.Record.PauseReason,
		&pauseEntries,
		&row.Record.MaxOpenPositions,
		&row.Record.RSILongMin, &row.Record.RSILongMax, &row.Record.RSIShortMin, &row.Record.RSIShortMax,
		&gamble, &row.Record.ScalpTpPct, &row.Record.ScalpSlPct,
		&row.Record.RFraction, &row.Record.ExpectancyTpCapR, &row.Record.TakerFeeRate, &row.Record.MakerFeeRate, &expectancyGate,
		&running,
		&row.CreatedAt, &row.UpdatedAt,
		&network, &status, &label,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return strategyRow{}, err
		}
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

func loadPauseEntries(id int64) (bool, error) {
	var flag int
	err := queryRow(`SELECT pause_entries FROM trading_strategies WHERE id = ?`, id).Scan(&flag)
	if err != nil {
		return false, err
	}
	return flag != 0, nil
}

func loadPauseBalance(id int64) (float64, error) {
	var line float64
	err := queryRow(`SELECT pause_balance_usdt FROM trading_strategies WHERE id = ?`, id).Scan(&line)
	if err != nil {
		return 0, err
	}
	return line, nil
}
