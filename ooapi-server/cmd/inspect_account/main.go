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
	fmt.Printf("=== Binance Equity (%s) ===\n", network)
	fmt.Printf("Wallet:    %.4f USDT\n", eq.Wallet)
	fmt.Printf("Available: %.4f USDT\n", eq.Available)
	fmt.Printf("Equity:    %.4f USDT\n", eq.Equity)

	positions, err := client.AccountPositions()
	if err != nil {
		log.Fatalf("read positions: %v", err)
	}
	fmt.Printf("\n=== Open Positions: %d ===\n", len(positions))
	for _, p := range positions {
		fmt.Printf("Symbol: %s, Side: %s, Qty: %.4f, Entry: %.6f, Margin: %.4f\n",
			p.Symbol, p.Side, p.Qty, p.Entry, p.Margin)
	}
}
