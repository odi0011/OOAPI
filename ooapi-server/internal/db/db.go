package db

import (
	"database/sql"
	"fmt"
	"log"
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

	log.Printf("[db] 表结构与列已就绪")
	return nil
}

type columnDef struct {
	name       string
	definition string
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

func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' {
			return s[:i]
		}
	}
	return s
}
