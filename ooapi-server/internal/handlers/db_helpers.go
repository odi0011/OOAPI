package handlers

import (
	"database/sql"

	"ooapi/internal/db"
)

// sqlRows 是 *sql.Rows 的别名，让 handler 里声明变量时不必引入 database/sql。
type sqlRows = sql.Rows

// queryRows 执行查询并返回行集。
// 抽出来是为了让上层不必反复写 db.DB.Query 与错误处理样板。
func queryRows(query string, args ...any) (*sql.Rows, error) {
	return db.DB.Query(query, args...)
}

// queryRow 执行单行查询。
func queryRow(query string, args ...any) *sql.Row {
	return db.DB.QueryRow(query, args...)
}

// exec 执行写操作。
func exec(query string, args ...any) (sql.Result, error) {
	return db.DB.Exec(query, args...)
}
