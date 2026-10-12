// Command trendsweep 用币安 USDT-M 公开 K 线扫描 trend 参数。
// 近 7 天里前 5 天选参、后 2 天验证。不需要交易所密钥。
//
//	go run ./cmd/trendsweep
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"time"

	"ooapi/internal/trading"
)

func main() {
	log.SetOutput(os.Stderr)
	now := time.Now().UTC()
	report, err := sweep(now)
	if err != nil {
		log.Fatal(err)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(report); err != nil {
		log.Fatal(err)
	}
}

type rsiBand struct {
	LongMin  float64
	LongMax  float64
	ShortMin float64
	ShortMax float64
}

type stats struct {
	WinRate    float64 `json:"winRate"`
	TradeCount int     `json:"tradeCount"`
	NetR       float64 `json:"netR"`
}

type row struct {
	Symbol      string  `json:"symbol"`
	Timeframe   string  `json:"timeframe"`
	TakeProfitR float64 `json:"takeProfitR"`
	EmaFast     int     `json:"emaFast"`
	EmaSlow     int     `json:"emaSlow"`
	RSILongMin  float64 `json:"rsiLongMin"`
	RSILongMax  float64 `json:"rsiLongMax"`
	RSIShortMin float64 `json:"rsiShortMin"`
	RSIShortMax float64 `json:"rsiShortMax"`
	MinScore    int     `json:"minScore"`
	InSample    stats   `json:"inSample"`
	OutSample   stats   `json:"outSample"`
	Pass        bool    `json:"pass"`
}

type report struct {
	GeneratedAt    time.Time `json:"generatedAt"`
	InSampleFrom   time.Time `json:"inSampleFrom"`
	SplitAt        time.Time `json:"splitAt"`
	OutSampleUntil time.Time `json:"outSampleUntil"`
	TakerFee       float64   `json:"takerFee"`
	Slippage       float64   `json:"slippage"`
	Rows           []row     `json:"rows"`
}

func sweep(now time.Time) (report, error) {
	inFrom := now.Add(-7 * 24 * time.Hour)
	split := now.Add(-2 * 24 * time.Hour)
	until := now.Add(time.Minute)
	since := now.Add(-9 * 24 * time.Hour)
	symbols := []string{"XRPUSDT", "DOGEUSDT", "SOLUSDT", "ETHUSDT"}
	frames := []string{trading.Timeframe5m, trading.HigherTimeframe}
	takes := []float64{0.8, 1, 1.5}
	emas := [][2]int{{9, 21}, {12, 26}, {5, 13}, {20, 50}}
	scores := []int{2, 3, 4}
	bands := []rsiBand{
		{50, 70, 30, 50},
		{45, 65, 35, 55},
		{55, 75, 25, 45},
		{40, 80, 20, 60},
	}

	cache := map[string][]trading.Candle{}
	load := func(symbol, tf string) ([]trading.Candle, error) {
		key := symbol + "|" + tf
		if bars, ok := cache[key]; ok {
			return bars, nil
		}
		bars, err := trading.LoadCandles(trading.ModeLive, symbol, tf, since, now)
		if err != nil {
			return nil, fmt.Errorf("%s %s: %w", symbol, tf, err)
		}
		cache[key] = bars
		log.Printf("klines %s %s bars=%d", symbol, tf, len(bars))
		return bars, nil
	}

	out := report{
		GeneratedAt:    now,
		InSampleFrom:   inFrom,
		SplitAt:        split,
		OutSampleUntil: now,
		TakerFee:       trading.TakerFeeRate,
		Slippage:       trading.SlippageRate,
		Rows:           []row{},
	}
	for _, symbol := range symbols {
		for _, tf := range frames {
			candles, err := load(symbol, tf)
			if err != nil {
				return report{}, err
			}
			higher, err := load(symbol, trading.HigherTimeframe)
			if err != nil {
				return report{}, err
			}
			for _, tp := range takes {
				for _, ema := range emas {
					for _, score := range scores {
						for _, band := range bands {
							cfg := trading.DefaultConfig()
							cfg.Symbol = symbol
							cfg.Timeframe = tf
							cfg.EntryMode = trading.EntryModeTrend
							cfg.TakeProfitR = tp
							cfg.EmaFast = ema[0]
							cfg.EmaSlow = ema[1]
							cfg.MinScore = score
							cfg.RSILongMin = band.LongMin
							cfg.RSILongMax = band.LongMax
							cfg.RSIShortMin = band.ShortMin
							cfg.RSIShortMax = band.ShortMax
							res, err := trading.Backtest(cfg, candles, higher)
							if err != nil {
								return report{}, fmt.Errorf("%s %s ema %d/%d: %w", symbol, tf, ema[0], ema[1], err)
							}
							inSum := trading.WindowStats(res.Trades, inFrom, split)
							outSum := trading.WindowStats(res.Trades, split, until)
							out.Rows = append(out.Rows, row{
								Symbol:      symbol,
								Timeframe:   tf,
								TakeProfitR: tp,
								EmaFast:     ema[0],
								EmaSlow:     ema[1],
								RSILongMin:  band.LongMin,
								RSILongMax:  band.LongMax,
								RSIShortMin: band.ShortMin,
								RSIShortMax: band.ShortMax,
								MinScore:    score,
								InSample:    toStats(inSum),
								OutSample:   toStats(outSum),
								Pass:        trading.SweepPass(inSum, outSum),
							})
						}
					}
				}
			}
		}
	}
	sort.SliceStable(out.Rows, func(i, j int) bool {
		return out.Rows[i].InSample.NetR > out.Rows[j].InSample.NetR
	})
	return out, nil
}

func toStats(sum trading.BacktestSummary) stats {
	return stats{WinRate: sum.WinRate, TradeCount: sum.Trades, NetR: sum.NetR}
}
