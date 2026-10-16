package main

import (
	"database/sql"
	"fmt"
	"log"

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

	var keyEnc, secretEnc, network string
	err = db.QueryRow("SELECT api_key, api_secret, network FROM exchange_keys WHERE id = 2").
		Scan(&keyEnc, &secretEnc, &network)
	if err != nil {
		log.Fatalf("query key: %v", err)
	}

	apiKey, _ := cryptoutil.Decrypt(cfg.JWTSecret, keyEnc)
	apiSecret, _ := cryptoutil.Decrypt(cfg.JWTSecret, secretEnc)

	book, err := trading.NewDeskBook(network)
	if err != nil {
		log.Fatalf("new desk book: %v", err)
	}
	err = book.UseReadCredentials(trading.Credentials{
		APIKey: apiKey, APISecret: apiSecret, Network: network,
	})
	if err != nil {
		log.Fatalf("use read creds: %v", err)
	}

	pos, err := book.PositionRisk("SOLUSDT")
	if err != nil {
		log.Fatalf("pos risk: %v", err)
	}
	fmt.Printf("=== 币安 SOLUSDT 持仓状态 ===\n")
	fmt.Printf("持仓开启: %v | 方向: %s | 数量: %.4f SOL | 入场均价: %.4f | 标记价格: %.4f | 未实现盈亏: %.4f USDT\n",
		pos.Open, pos.Side, pos.Qty, pos.EntryPrice, pos.MarkPrice, pos.UnrealizedPnl)

	orders, err := book.OpenOrders("SOLUSDT")
	if err != nil {
		log.Fatalf("open orders: %v", err)
	}
	fmt.Printf("\n=== 币安挂单 (Limit / Take Profit) [%d 笔] ===\n", len(orders))
	for _, o := range orders {
		fmt.Printf("ID: %s | Kind: %-10s | Side: %-5s | Type: %-12s | 价格: %.4f | 数量: %.4f | 仅减仓(ReduceOnly): %v\n",
			o.ID, o.Kind, o.Side, o.Type, o.Price, o.Qty, o.ReduceOnly)
	}

	algoOrders, err := book.OpenAlgoOrders("SOLUSDT")
	if err != nil {
		log.Fatalf("open algo orders: %v", err)
	}
	fmt.Printf("\n=== 币安条件单 (Stop Loss) [%d 笔] ===\n", len(algoOrders))
	for _, o := range algoOrders {
		fmt.Printf("ID: %s | Kind: %-10s | Side: %-5s | Type: %-12s | 触发价: %.4f | 全部平仓(ClosePos): %v\n",
			o.ID, o.Kind, o.Side, o.Type, o.StopPrice, o.ClosePosition)
	}
}
