package db

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"ooapi/internal/config"
)

var (
	// DB 是全局连接池，供各 handler 直接使用。
	DB *sql.DB
)

func Init(cfg *config.Config) error {
	conn, err := sql.Open("mysql", cfg.DSN())
	if err != nil {
		return fmt.Errorf("打开数据库连接: %w", err)
	}

	conn.SetMaxOpenConns(50)
	conn.SetMaxIdleConns(10)
	conn.SetConnMaxLifetime(time.Hour)

	if err := conn.Ping(); err != nil {
		return fmt.Errorf("连接数据库失败（检查 DB_* 配置与库是否已建）: %w", err)
	}

	DB = conn
	log.Printf("[db] 已连接 %s:%s/%s", cfg.DBHost, cfg.DBPort, cfg.DBName)

	if err := migrate(); err != nil {
		return fmt.Errorf("建表/补列失败: %w", err)
	}
	return nil
}

func Close() {
	if DB != nil {
		_ = DB.Close()
	}
}

// migrate 建表 + 补列。
// 线上表已存在时 CREATE TABLE IF NOT EXISTS 不会补列，
// 因此新增字段必须同时写进 columnMigrations。
func migrate() error {
	for _, stmt := range schemaStatements {
		if _, err := DB.Exec(stmt); err != nil {
			return fmt.Errorf("执行建表语句失败: %w\nSQL: %s", err, firstLine(stmt))
		}
	}

	for table, columns := range columnMigrations {
		for _, col := range columns {
			if err := ensureColumn(table, col.name, col.definition); err != nil {
				return err
			}
		}
	}

	if err := ensureVarcharAtLeast("tokens", "api_key", 191); err != nil {
		return err
	}
	if err := ensureTextColumn("channels", "api_key"); err != nil {
		return err
	}
	if err := ensureIndex("tokens", "idx_tokens_key_hash", "CREATE INDEX idx_tokens_key_hash ON tokens (key_hash)"); err != nil {
		return err
	}
	if err := relaxTradingRiskDefaults(); err != nil {
		return err
	}
	if err := alignTradingProductionDefaults(); err != nil {
		return err
	}

	log.Printf("[db] 表结构与列已就绪")
	return nil
}

type columnDef struct {
	name       string
	definition string
}

// productionStrategyDefaultStmts 把列默认值对齐生产 DOGE 策略 2。
// MODIFY 只改默认值，不改写已有行里的杠杆、日亏和暂停余额。
// 新列的 DEFAULT 在补列时写到已有行上，所以 1R 必须是 0.008（0.8%）。
func productionStrategyDefaultStmts() []string {
	return []string{
		"ALTER TABLE trading_strategies MODIFY COLUMN leverage INT NOT NULL DEFAULT 20",
		"ALTER TABLE trading_strategies MODIFY COLUMN margin_mode VARCHAR(16) NOT NULL DEFAULT 'isolated'",
		"ALTER TABLE trading_strategies MODIFY COLUMN daily_loss_pct DECIMAL(12,4) NOT NULL DEFAULT 100",
		"ALTER TABLE trading_strategies MODIFY COLUMN pause_balance_usdt DECIMAL(20,6) NOT NULL DEFAULT 0.5",
		"ALTER TABLE trading_strategies MODIFY COLUMN max_margin_usdt DECIMAL(20,6) NOT NULL DEFAULT 1.7",
		"ALTER TABLE trading_strategies MODIFY COLUMN r_fraction DECIMAL(16,8) NOT NULL DEFAULT 0.00800000",
		"ALTER TABLE trading_strategies MODIFY COLUMN expectancy_tp_cap_r DECIMAL(12,4) NOT NULL DEFAULT 3",
		"ALTER TABLE trading_strategies MODIFY COLUMN taker_fee_rate DECIMAL(16,8) NOT NULL DEFAULT 0.00050000",
		"ALTER TABLE trading_strategies MODIFY COLUMN maker_fee_rate DECIMAL(16,8) NOT NULL DEFAULT 0.00020000",
		"ALTER TABLE trading_strategies MODIFY COLUMN expectancy_gate TINYINT NOT NULL DEFAULT 1",
	}
}

func alignTradingProductionDefaults() error {
	for _, stmt := range productionStrategyDefaultStmts() {
		if _, err := DB.Exec(stmt); err != nil {
			return fmt.Errorf("对齐策略默认值失败: %w", err)
		}
	}
	return nil
}

// relaxTradingRiskDefaults 把单笔保证金和连亏次数的默认值改成关闭。
// 余额暂停线的默认值是 0.5，与权益停机地板相同。已有行保持原值。
func relaxTradingRiskDefaults() error {
	stmts := []string{
		"ALTER TABLE trading_strategies MODIFY COLUMN max_margin_per_trade_usdt DECIMAL(20,6) NOT NULL DEFAULT 0",
		"ALTER TABLE trading_strategies MODIFY COLUMN max_consecutive_losses INT NOT NULL DEFAULT 0",
		"ALTER TABLE trading_strategies MODIFY COLUMN pause_balance_usdt DECIMAL(20,6) NOT NULL DEFAULT 0.5",
	}
	for _, stmt := range stmts {
		if _, err := DB.Exec(stmt); err != nil {
			return fmt.Errorf("放宽策略风控默认值失败: %w", err)
		}
	}
	return nil
}

func ensureColumn(table, name, definition string) error {
	var exists int
	err := DB.QueryRow(
		`SELECT COUNT(*) FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
		table, name,
	).Scan(&exists)
	if err != nil {
		return fmt.Errorf("检查列 %s.%s 失败: %w", table, name, err)
	}
	if exists > 0 {
		return nil
	}

	stmt := fmt.Sprintf("ALTER TABLE `%s` ADD COLUMN `%s` %s", table, name, definition)
	if _, err := DB.Exec(stmt); err != nil {
		return fmt.Errorf("补列 %s.%s 失败: %w", table, name, err)
	}
	log.Printf("[db] 已补齐列 %s.%s", table, name)
	return nil
}

func ensureVarcharAtLeast(table, name string, size int) error {
	var length sql.NullInt64
	var dataType string
	err := DB.QueryRow(
		`SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
		table, name,
	).Scan(&dataType, &length)
	if err != nil {
		return fmt.Errorf("检查列宽 %s.%s 失败: %w", table, name, err)
	}
	if !strings.EqualFold(dataType, "varchar") || (length.Valid && int(length.Int64) >= size) {
		return nil
	}
	stmt := fmt.Sprintf("ALTER TABLE `%s` MODIFY `%s` VARCHAR(%d) NOT NULL", table, name, size)
	if _, err := DB.Exec(stmt); err != nil {
		return fmt.Errorf("加宽 %s.%s 失败: %w", table, name, err)
	}
	log.Printf("[db] 已加宽列 %s.%s 至 VARCHAR(%d)", table, name, size)
	return nil
}

func ensureTextColumn(table, name string) error {
	var dataType string
	err := DB.QueryRow(
		`SELECT DATA_TYPE FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
		table, name,
	).Scan(&dataType)
	if err != nil {
		return fmt.Errorf("检查列类型 %s.%s 失败: %w", table, name, err)
	}
	switch strings.ToLower(dataType) {
	case "text", "mediumtext", "longtext":
		return nil
	}
	stmt := fmt.Sprintf("ALTER TABLE `%s` MODIFY `%s` TEXT NOT NULL", table, name)
	if _, err := DB.Exec(stmt); err != nil {
		return fmt.Errorf("放宽 %s.%s 失败: %w", table, name, err)
	}
	log.Printf("[db] 已将 %s.%s 调整为 TEXT", table, name)
	return nil
}

func ensureIndex(table, indexName, ddl string) error {
	var n int
	err := DB.QueryRow(
		`SELECT COUNT(*) FROM information_schema.STATISTICS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
		table, indexName,
	).Scan(&n)
	if err != nil {
		return fmt.Errorf("检查索引 %s.%s 失败: %w", table, indexName, err)
	}
	if n > 0 {
		return nil
	}
	if _, err := DB.Exec(ddl); err != nil {
		return fmt.Errorf("创建索引 %s.%s 失败: %w", table, indexName, err)
	}
	log.Printf("[db] 已创建索引 %s.%s", table, indexName)
	return nil
}

func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' {
			return s[:i]
		}
	}
	return s
}
