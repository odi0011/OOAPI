package db

import (
	"strings"
	"testing"
)

func TestTradingEntriesMigration(t *testing.T) {
	joined := strings.Join(schemaStatements, "\n")
	if !strings.Contains(joined, "CREATE TABLE IF NOT EXISTS trading_entries") {
		t.Fatal("trading_entries table missing from schema")
	}
	want := []string{
		"score", "min_score", "boost", "forced", "win_rate", "trade_count",
		"net_r", "expectancy_r", "expectancy_usdt", "one_r_usdt", "opened_at",
		"exit_price", "exit_qty", "realized_usdt", "exit_reason", "closed_at",
	}
	cols := columnMigrations["trading_entries"]
	for _, name := range want {
		if !strings.Contains(joined, name) {
			t.Fatalf("create table missing %s", name)
		}
		found := false
		for _, col := range cols {
			if col.name == name {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("column migration missing %s", name)
		}
	}
}
