package main

import (
	"fmt"
	"log"

	"ooapi/internal/trading"
)

func main() {
	client := trading.PublicClient("live")
	for _, sym := range []string{"SOLUSDT", "XRPUSDT", "DOGEUSDT"} {
		rules, err := client.Rules(sym)
		if err != nil {
			log.Fatalf("rules %s: %v", sym, err)
		}
		px, err := client.MarkPrice(sym)
		if err != nil {
			log.Fatalf("mark %s: %v", sym, err)
		}
		fmt.Printf("Symbol: %-10s MarkPrice: %-10.4f MinQty: %-8.4f StepSize: %-8.4f MinNotional: %-8.2f TickSize: %-8.4f\n",
			sym, px, rules.MinQty, rules.StepSize, rules.MinNotional, rules.TickSize)
	}
}
