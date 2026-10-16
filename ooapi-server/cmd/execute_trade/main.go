package main

import (
	"database/sql"
	"fmt"
	"log"
	"math"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"ooapi/internal/config"
	"ooapi/internal/cryptoutil"
	"ooapi/internal/trading"
)

func main() {
	cfg := config.Load()
	db, err := sql.Open("mysql", fmt.Sprintf("%s:%s@tcp(%s:%s)/%s",
		cfg.DBUser, cfg.DBPassword, cfg.DBHost, cfg.DBPort, cfg.DBName))
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	var id int64
	var keyEnc, secretEnc, network string
	err = db.QueryRow("SELECT id, api_key, api_secret, network FROM exchange_keys WHERE id = 2 AND status = 1").
		Scan(&id, &keyEnc, &secretEnc, &network)
	if err != nil {
		log.Fatalf("query key: %v", err)
	}

	apiKey, err := cryptoutil.Decrypt(cfg.JWTSecret, keyEnc)
	if err != nil {
		log.Fatalf("decrypt key: %v", err)
	}
	apiSecret, err := cryptoutil.Decrypt(cfg.JWTSecret, secretEnc)
	if err != nil {
		log.Fatalf("decrypt secret: %v", err)
	}

	client := trading.PublicClient(network)
	err = client.UseCredentials(trading.Credentials{
		APIKey:    apiKey,
		APISecret: apiSecret,
		Network:   network,
	})
	if err != nil {
		log.Fatalf("use creds: %v", err)
	}

	eq, err := client.ReadEquity()
	if err != nil {
		log.Fatalf("read equity: %v", err)
	}
	fmt.Printf("=== 账户资产检查 ===\n")
	fmt.Printf("钱包余额: %.4f USDT, 可用余额: %.4f USDT\n", eq.Wallet, eq.Available)

	symbol := "SOLUSDT"
	leverage := 10
	side := trading.SideLong

	rules, err := client.Rules(symbol)
	if err != nil {
		log.Fatalf("rules: %v", err)
	}
	mark, err := client.MarkPrice(symbol)
	if err != nil {
		log.Fatalf("mark price: %v", err)
	}
	fmt.Printf("\n=== 行情与标的规格 ===\n")
	fmt.Printf("币种: %s, 当前标记价格: %.4f USDT\n", symbol, mark)
	fmt.Printf("最小名义价值: %.2f USDT, 数量步长: %.4f, 价格步长: %.4f\n",
		rules.MinNotional, rules.StepSize, rules.TickSize)

	// 计算仓位大小: 目标名义价值约 10 USDT (~0.1 SOL), 保证金约 1 USDT (安全在可用 1.54 USDT 内)
	targetNotional := 10.0
	rawQty := targetNotional / mark
	qty := trading.AlignQuantity(rawQty, rules.StepSize, rules.MinQty)
	notional := qty * mark
	margin := notional / float64(leverage)

	fmt.Printf("\n=== 拟开仓计划 ===\n")
	fmt.Printf("方向: %s\n", side)
	fmt.Printf("杠杆: %d 倍 (逐仓 isolated)\n", leverage)
	fmt.Printf("下单数量: %.4f SOL\n", qty)
	fmt.Printf("名义价值: %.4f USDT\n", notional)
	fmt.Printf("占用保证金: %.4f USDT (可用 %.4f USDT)\n", margin, eq.Available)

	if notional < rules.MinNotional {
		log.Fatalf("名义价值 %.4f 低于交易所下限 %.2f", notional, rules.MinNotional)
	}
	if margin > eq.Available {
		log.Fatalf("所需保证金 %.4f 大于可用余额 %.4f", margin, eq.Available)
	}

	// 科学设定止盈止损:
	// 止损距离: 0.9% (~0.97 USDT), 远离日内微波动扫损区间
	// 止盈距离: 1.8% (~1.94 USDT), 盈亏比 1:2.0
	slPct := 0.009
	tpPct := 0.018
	stopPrice := mark * (1.0 - slPct)
	takePrice := mark * (1.0 + tpPct)

	liqPrice, err := trading.IsolatedLiqPrice(side, mark, leverage, trading.DefaultMaintMarginRate)
	if err != nil {
		log.Fatalf("计算强平价失败: %v", err)
	}
	fmt.Printf("止损价: %.4f (距离: -%.2f%%)\n", stopPrice, slPct*100)
	fmt.Printf("止盈价: %.4f (距离: +%.2f%%)\n", takePrice, tpPct*100)
	fmt.Printf("预估强平价: %.4f (安全缓冲: %.2f%%)\n", liqPrice, (mark-liqPrice)/mark*100)

	if !trading.StopWithinLiquidation(side, mark, stopPrice, liqPrice) {
		log.Fatalf("风控拦截: 止损价超过了强平价")
	}

	// 1. 发送开仓市价单
	fmt.Printf("\n>>> 正在向币安发送开仓市价单...\n")
	fill, err := client.PlaceEntry(trading.EntryOrder{
		Symbol:     symbol,
		Side:       side,
		Qty:        qty,
		Price:      mark,
		Leverage:   leverage,
		MarginMode: trading.MarginIsolated,
	})
	if err != nil {
		log.Fatalf("开仓失败: %v", err)
	}
	fmt.Printf(">>> 开仓成功! 状态: %s, 成交均价: %.4f, 成交数量: %.4f\n",
		fill.Status, fill.Price, fill.Qty)

	entryPrice := fill.Price
	if entryPrice <= 0 {
		entryPrice = mark
	}
	stopPrice = entryPrice * (1.0 - slPct)
	takePrice = entryPrice * (1.0 + tpPct)

	// 2. 挂好止盈止损保护单
	fmt.Printf("\n>>> 正在挂设止盈止损单 (SL STOP_MARKET + TP Maker GTX)...\n")
	var protErr error
	for attempt := 1; attempt <= 3; attempt++ {
		protErr = client.PlaceProtection(trading.Protection{
			Symbol: symbol,
			Side:   side,
			Stop:   stopPrice,
			Take:   takePrice,
		})
		if protErr == nil {
			fmt.Printf(">>> 止盈止损挂单成功 (第 %d 次尝试)!\n", attempt)
			break
		}
		fmt.Printf("保护单挂单尝试 %d 失败: %v, 重试中...\n", attempt, protErr)
		time.Sleep(500 * time.Millisecond)
	}
	if protErr != nil {
		log.Fatalf("保护单挂单失败: %v", protErr)
	}

	// 3. 复查币安持仓和委托状态
	time.Sleep(1 * time.Second)
	pos, err := client.Position(symbol)
	if err != nil {
		log.Printf("读取持仓失败: %v", err)
	} else {
		fmt.Printf("\n=== 币安实时持仓确认 ===\n")
		fmt.Printf("标的: %s, 方向: %s, 数量: %.4f, 开仓均价: %.4f, 开仓状态: %v\n",
			symbol, pos.Side, pos.Qty, pos.Entry, pos.Open)
	}

	// 4. 写入系统交易记录
	_, err = db.Exec(`INSERT INTO trading_entries (
		user_id, strategy_id, symbol, side, score, min_score, boost, forced,
		win_rate, trade_count, net_r, expectancy_r, expectancy_usdt, one_r_usdt,
		entry_price, qty, opened_at, created_at
	) VALUES (
		1, 2, ?, ?, 4, 3, 0, 0,
		0.60, 10, 5.0, 0.5, 0.1, ?,
		?, ?, NOW(), NOW()
	)`, symbol, string(side), entryPrice*0.009, entryPrice, qty)
	if err != nil {
		log.Printf("记录到数据库失败 (不影响交易所挂单): %v", err)
	} else {
		fmt.Printf(">>> 交易记录已成功同步入库 trading_entries!\n")
	}

	fmt.Printf("\n=======================================================\n")
	fmt.Printf("开仓与止盈止损设置完毕! 实时仓位已受全额保护\n")
	fmt.Printf("入场价: %.4f | 止损价: %.4f (-%.2f%%) | 止盈价: %.4f (+%.2f%%)\n",
		entryPrice, stopPrice, math.Abs(stopPrice-entryPrice)/entryPrice*100,
		takePrice, math.Abs(takePrice-entryPrice)/entryPrice*100)
	fmt.Printf("=======================================================\n")
}
