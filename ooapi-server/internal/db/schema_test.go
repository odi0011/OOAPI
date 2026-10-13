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
		"net_r", "expectancy_r", "expectancy_usdt", "one_r_usdt",
		"live_expectancy", "take_profit_dist", "opened_at",
		"exit_price", "exit_qty", "realized_usdt", "exit_reason", "closed_at",
	}
	if !strings.Contains(joined, "CREATE TABLE IF NOT EXISTS trading_orders") {
		t.Fatal("trading_orders table missing from schema")
	}
	if !strings.Contains(joined, "pause_entries") {
		t.Fatal("pause_entries missing from trading_strategies")
	}
	for _, name := range []string{"order_id", "commission", "funding_fee", "price", "realized_pnl"} {
		if !strings.Contains(joined, name) {
			t.Fatalf("trading_orders create table missing %s", name)
		}
		found := false
		for _, col := range columnMigrations["trading_orders"] {
			if col.name == name {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("trading_orders column migration missing %s", name)
		}
	}
	foundPause := false
	for _, col := range columnMigrations["trading_strategies"] {
		if col.name == "pause_entries" {
			foundPause = true
		}
	}
	if !foundPause {
		t.Fatal("pause_entries column migration missing")
	}
	joinedSchema := strings.Join(schemaStatements, "\n")
	for _, needle := range []string{
		"DEFAULT 20",
		"DEFAULT 100",
		"DEFAULT 0.5",
		"DEFAULT 0.00800000",
		"DEFAULT 1.7",
		"DEFAULT 0.00050000",
		"DEFAULT 0.00020000",
		"expectancy_gate",
		"DEFAULT 'isolated'",
		"expectancy_tp_cap_r",
	} {
		if !strings.Contains(joinedSchema, needle) {
			t.Fatalf("schema default missing %s", needle)
		}
	}
	alters := strings.Join(productionStrategyDefaultStmts(), "\n")
	for _, needle := range []string{
		"leverage INT NOT NULL DEFAULT 20",
		"daily_loss_pct DECIMAL(12,4) NOT NULL DEFAULT 100",
		"pause_balance_usdt DECIMAL(20,6) NOT NULL DEFAULT 0.5",
		"r_fraction DECIMAL(16,8) NOT NULL DEFAULT 0.00800000",
		"max_margin_usdt DECIMAL(20,6) NOT NULL DEFAULT 1.7",
	} {
		if !strings.Contains(alters, needle) {
			t.Fatalf("production alter missing %s", needle)
		}
	}
	for _, name := range []string{"r_fraction", "expectancy_tp_cap_r", "taker_fee_rate", "maker_fee_rate", "expectancy_gate"} {
		found := false
		for _, col := range columnMigrations["trading_strategies"] {
			if col.name == name && strings.Contains(col.definition, "DEFAULT") {
				found = true
			}
		}
		if !found {
			t.Fatalf("trading_strategies column migration missing %s", name)
		}
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
