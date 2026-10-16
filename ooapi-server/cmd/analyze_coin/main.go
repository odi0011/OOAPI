package main

import (
	"fmt"
	"math"
	"sort"
	"time"

	"ooapi/internal/trading"
)

type SymbolAnalysis struct {
	Symbol     string
	Price      float64
	EMA9       float64
	EMA21      float64
	EMA50      float64
	RSI        float64
	ATR        float64
	ATRpct     float64
	Trend5m    string
	Trend15m   string
	TrendScore int
	Suggested  string
	StopPrice  float64
	TakePrice  float64
	RiskReward float64
}

func calculateATR(candles []trading.Candle, period int) float64 {
	if len(candles) < period+1 {
		return 0
	}
	trs := make([]float64, len(candles))
	for i := 1; i < len(candles); i++ {
		c := candles[i].Close
		prev := candles[i-1].Close
		trs[i] = math.Abs(c - prev)
	}
	sum := 0.0
	for i := len(candles) - period; i < len(candles); i++ {
		sum += trs[i]
	}
	return sum / float64(period)
}

func analyze(symbol string) (*SymbolAnalysis, error) {
	now := time.Now().UTC()
	since := now.Add(-48 * time.Hour)

	candles5m, err := trading.LoadCandles("live", symbol, "5m", since, now)
	if err != nil {
		return nil, fmt.Errorf("5m candles: %w", err)
	}
	candles15m, err := trading.LoadCandles("live", symbol, "15m", since, now)
	if err != nil {
		return nil, fmt.Errorf("15m candles: %w", err)
	}

	if len(candles5m) < 60 || len(candles15m) < 30 {
		return nil, fmt.Errorf("insufficient candles: 5m=%d, 15m=%d", len(candles5m), len(candles15m))
	}

	closes5m := make([]float64, len(candles5m))
	for i, c := range candles5m {
		closes5m[i] = c.Close
	}
	lastPx := closes5m[len(closes5m)-1]

	ema9, _ := trading.EMA(closes5m, 9)
	ema21, _ := trading.EMA(closes5m, 21)
	ema50, _ := trading.EMA(closes5m, 50)
	rsi, _ := trading.LastRSI(closes5m, 14)
	atr := calculateATR(candles5m, 14)

	closes15m := make([]float64, len(candles15m))
	for i, c := range candles15m {
		closes15m[i] = c.Close
	}
	ema9_15, _ := trading.EMA(closes15m, 9)
	ema21_15, _ := trading.EMA(closes15m, 21)

	n5 := len(closes5m) - 1
	n15 := len(closes15m) - 1

	trend5 := "neutral"
	if ema9[n5] > ema21[n5] && lastPx > ema9[n5] {
		trend5 = "bullish"
	} else if ema9[n5] < ema21[n5] && lastPx < ema9[n5] {
		trend5 = "bearish"
	}

	trend15 := "neutral"
	if ema9_15[n15] > ema21_15[n15] {
		trend15 = "bullish"
	} else if ema9_15[n15] < ema21_15[n15] {
		trend15 = "bearish"
	}

	// Score
	side, score, _ := trading.ScoreTrend(trading.Config{
		EmaFast: 9, EmaSlow: 21, Symbol: symbol, Timeframe: "5m",
	}, candles5m, candles15m)

	res := &SymbolAnalysis{
		Symbol:     symbol,
		Price:      lastPx,
		EMA9:       ema9[n5],
		EMA21:      ema21[n5],
		EMA50:      ema50[n5],
		RSI:        rsi,
		ATR:        atr,
		ATRpct:     atr / lastPx * 100,
		Trend5m:    trend5,
		Trend15m:   trend15,
		TrendScore: score,
		Suggested:  string(side),
	}

	// Calculate healthy Stop and Take Profit based on ATR and structure (1.5R to 2R)
	slDist := math.Max(atr*1.5, lastPx*0.008) // at least 0.8%, optimal 1.5 ATR
	tpDist := slDist * 1.8                   // 1:1.8 Risk/Reward

	if side == trading.SideLong {
		res.StopPrice = lastPx - slDist
		res.TakePrice = lastPx + tpDist
		res.RiskReward = tpDist / slDist
	} else if side == trading.SideShort {
		res.StopPrice = lastPx + slDist
		res.TakePrice = lastPx - tpDist
		res.RiskReward = tpDist / slDist
	}

	return res, nil
}

func main() {
	symbols := []string{"DOGEUSDT", "XRPUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT"}
	fmt.Printf("%-10s %-10s %-8s %-8s %-8s %-8s %-8s %-10s\n",
		"Symbol", "Price", "RSI", "ATR%", "5mTrend", "15mTrend", "Score", "Suggested")
	fmt.Println("---------------------------------------------------------------------------------")

	type scored struct {
		a *SymbolAnalysis
	}
	var list []scored
	for _, sym := range symbols {
		a, err := analyze(sym)
		if err != nil {
			fmt.Printf("%-10s error: %v\n", sym, err)
			continue
		}
		list = append(list, scored{a: a})
		fmt.Printf("%-10s %-10.4f %-8.1f %-8.2f %-8s %-8s %-8d %-10s\n",
			a.Symbol, a.Price, a.RSI, a.ATRpct, a.Trend5m, a.Trend15m, a.TrendScore, a.Suggested)
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].a.TrendScore > list[j].a.TrendScore
	})

	if len(list) > 0 && list[0].a.Suggested != "" {
		best := list[0].a
		fmt.Printf("\n>>> TOP PICK: %s (%s) <<<\n", best.Symbol, best.Suggested)
		fmt.Printf("Current Price: %.6f\n", best.Price)
		fmt.Printf("EMA9: %.6f, EMA21: %.6f, EMA50: %.6f\n", best.EMA9, best.EMA21, best.EMA50)
		fmt.Printf("RSI(14): %.2f\n", best.RSI)
		fmt.Printf("Recommended SL: %.6f (distance: %.2f%%)\n",
			best.StopPrice, math.Abs(best.StopPrice-best.Price)/best.Price*100)
		fmt.Printf("Recommended TP: %.6f (distance: %.2f%%)\n",
			best.TakePrice, math.Abs(best.TakePrice-best.Price)/best.Price*100)
		fmt.Printf("Risk/Reward Ratio: 1:%.2f\n", best.RiskReward)
	}
}
