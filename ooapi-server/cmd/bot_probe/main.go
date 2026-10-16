// Command bot_probe 只读账户快照，用于分析第三方机器人（滚仓宝）的行为。
//
// 只读：不发单、不撤单、不改任何配置。用完即删。
// 复用网关已有的只读客户端（DeskBook/DeskAccountBook），凭据从库里解密。
package main

import (
	"database/sql"
	"fmt"
	"log"
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
		log.Fatalf("db: %v", err)
	}
	defer db.Close()

	var keyEnc, secretEnc, network string
	if err := db.QueryRow("SELECT api_key, api_secret, network FROM exchange_keys WHERE id = 2 AND status = 1").
		Scan(&keyEnc, &secretEnc, &network); err != nil {
		log.Fatalf("key: %v", err)
	}
	apiKey, err := cryptoutil.Decrypt(cfg.JWTSecret, keyEnc)
	if err != nil {
		log.Fatalf("decrypt: %v", err)
	}
	apiSecret, err := cryptoutil.Decrypt(cfg.JWTSecret, secretEnc)
	if err != nil {
		log.Fatalf("decrypt: %v", err)
	}

	book, err := trading.NewDeskBook(network)
	if err != nil {
		log.Fatalf("desk: %v", err)
	}
	if err := book.UseReadCredentials(trading.Credentials{APIKey: apiKey, APISecret: apiSecret, Network: network}); err != nil {
		log.Fatalf("creds: %v", err)
	}
	account, ok := book.(trading.DeskAccountBook)
	if !ok {
		log.Fatal("no account book")
	}
	client, ok := book.(*trading.USDMClient)
	if !ok {
		log.Fatal("no usdm client")
	}

	now := time.Now().UTC()
	cst := time.FixedZone("CST", 8*3600)
	fmt.Printf("now: %s UTC / %s CST\n\n", now.Format("15:04:05"), now.In(cst).Format("15:04:05"))

	if eq, err := account.ReadEquity(); err != nil {
		fmt.Println("equity err:", err)
	} else {
		fmt.Printf("=== 权益 ===\nwallte=%.4f available=%.4f unrealized=%.4f equity=%.4f marginUsed=%.4f\n\n",
			eq.Wallet, eq.Available, eq.Unrealized, eq.Equity, eq.MarginUsed)
	}

	if positions, err := account.ListOpenPositions(); err != nil {
		fmt.Println("positions err:", err)
	} else {
		fmt.Printf("=== 全部持仓（%d）===\n", len(positions))
		for _, p := range positions {
			fmt.Printf(" %-10s %-5s qty=%.8g entry=%.8g mark=%.8g upl=%+.4f lev=%dx margin=%.4f %s\n",
				p.Symbol, p.Side, p.Qty, p.EntryPrice, p.MarkPrice, p.UnrealizedPnl, p.Leverage, p.Margin, p.MarginMode)
		}
		fmt.Println()
	}

	for _, sym := range []string{"BTCUSDT"} {
		if risk, err := book.PositionRisk(sym); err == nil {
			fmt.Printf("=== %s 持仓风险 ===\nopen=%v side=%s qty=%.8g entry=%.8g mark=%.8g upl=%+.4f\n\n",
				sym, risk.Open, risk.Side, risk.Qty, risk.EntryPrice, risk.MarkPrice, risk.UnrealizedPnl)
		}
		if orders, err := book.OpenOrders(sym); err == nil {
			fmt.Printf("=== %s 普通挂单（%d）===\n", sym, len(orders))
			for _, o := range orders {
				fmt.Printf(" %-5s %-8s qty=%.8g price=%.8g stop=%.8g reduceOnly=%v id=%s\n",
					o.Side, o.Type, o.Qty, o.Price, o.StopPrice, o.ReduceOnly, o.ID)
			}
			fmt.Println()
		}
		if algos, err := book.OpenAlgoOrders(sym); err == nil {
			fmt.Printf("=== %s 条件单（%d）===\n", sym, len(algos))
			for _, o := range algos {
				fmt.Printf(" %-5s %-8s qty=%.8g price=%.8g stop=%.8g reduceOnly=%v id=%s\n",
					o.Side, o.Type, o.Qty, o.Price, o.StopPrice, o.ReduceOnly, o.ID)
			}
			fmt.Println()
		}
	}

	dayStart := trading.ShanghaiDayStart(now)
	if rows, err := account.AccountIncomeHistory(dayStart, now); err == nil {
		fmt.Printf("=== 今日账单（%d 行）===\n", len(rows))
		sum := map[string]float64{}
		for _, r := range rows {
			sum[r.IncomeType] += r.Income
			fmt.Printf(" %s %-14s %-9s %+.6f\n", r.Time.In(cst).Format("15:04:05"), r.IncomeType, r.Symbol, r.Income)
		}
		fmt.Println("--- 汇总 ---")
		for k, v := range sum {
			fmt.Printf(" %-14s %+.6f\n", k, v)
		}
		fmt.Println()
	}

	if fills, err := client.Trades("BTCUSDT", dayStart, now); err == nil {
		fmt.Printf("=== BTCUSDT 今日成交（%d 笔）===\n", len(fills))
		for _, f := range fills {
			fmt.Printf(" %s order=%-16d %-5s px=%.2f qty=%.4f\n",
				f.Time.In(cst).Format("15:04:05"), f.OrderID, f.Side, f.Price, f.Qty)
		}
	}
}
