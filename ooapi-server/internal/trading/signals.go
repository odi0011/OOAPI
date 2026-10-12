package trading

// ScoreTrend 给 trend 模式打分。方向只由快慢线拉开的方向决定。
// 满分 4：EMA 方向、RSI 不逆势超买超卖、放量、15 分钟级别同向。
// 线没拉开时没有方向，分数为 0。
func ScoreTrend(cfg Config, candles, higher []Candle) (Side, int, error) {
	cfg = cfg.Normalize()
	closes := closesOf(candles)
	if len(closes) < cfg.EmaSlow+1 {
		return "", 0, nil
	}
	fast, err := EMA(closes, cfg.EmaFast)
	if err != nil {
		return "", 0, err
	}
	slow, err := EMA(closes, cfg.EmaSlow)
	if err != nil {
		return "", 0, err
	}
	i := len(closes) - 1
	price := closes[i]
	if price <= 0 {
		return "", 0, nil
	}
	gap := TrendGapFraction * price
	diff := fast[i] - slow[i]
	var side Side
	switch {
	case diff >= gap:
		side = SideLong
	case -diff >= gap:
		side = SideShort
	default:
		return "", 0, nil
	}
	score := 1
	longMin, longMax, shortMin, shortMax := cfg.rsiBand()
	if rsi, ok := LastRSI(closes, RSIPeriod); ok && rsiAllows(side, rsi, longMin, longMax, shortMin, shortMax) {
		score++
	}
	if volumeAbove(candles, VolumeLookback) {
		score++
	}
	if higherAgrees(cfg, higher, side) {
		score++
	}
	return side, score, nil
}

// TrendDirection 是加速候选的方向。分数仍由 ScoreTrend 计算。
// 快慢线没拉开到门槛时，只要快线在慢线上方就做多，下方就做空，方便窗口结束时强制开仓。
func TrendDirection(cfg Config, candles, higher []Candle) (Side, int, error) {
	side, score, err := ScoreTrend(cfg, candles, higher)
	if err != nil || side != "" {
		return side, score, err
	}
	cfg = cfg.Normalize()
	closes := closesOf(candles)
	if len(closes) < cfg.EmaSlow+1 {
		return "", score, nil
	}
	fast, err := EMA(closes, cfg.EmaFast)
	if err != nil {
		return "", score, err
	}
	slow, err := EMA(closes, cfg.EmaSlow)
	if err != nil {
		return "", score, err
	}
	i := len(closes) - 1
	switch {
	case fast[i] > slow[i]:
		return SideLong, score, nil
	case fast[i] < slow[i]:
		return SideShort, score, nil
	default:
		return "", score, nil
	}
}

func rsiAllows(side Side, rsi, longMin, longMax, shortMin, shortMax float64) bool {
	switch side {
	case SideLong:
		return rsi >= longMin && rsi <= longMax
	case SideShort:
		return rsi >= shortMin && rsi <= shortMax
	default:
		return false
	}
}

// LastRSI 用 Wilder 平滑。样本不够时 ok 为 false。
func LastRSI(closes []float64, period int) (float64, bool) {
	if period < 1 || len(closes) < period+1 {
		return 0, false
	}
	var gain, loss float64
	for i := 1; i <= period; i++ {
		d := closes[i] - closes[i-1]
		if d >= 0 {
			gain += d
		} else {
			loss -= d
		}
	}
	avgGain := gain / float64(period)
	avgLoss := loss / float64(period)
	for i := period + 1; i < len(closes); i++ {
		d := closes[i] - closes[i-1]
		var g, l float64
		if d >= 0 {
			g = d
		} else {
			l = -d
		}
		avgGain = (avgGain*float64(period-1) + g) / float64(period)
		avgLoss = (avgLoss*float64(period-1) + l) / float64(period)
	}
	if avgLoss == 0 {
		if avgGain == 0 {
			return 50, true
		}
		return 100, true
	}
	rs := avgGain / avgLoss
	return 100 - 100/(1+rs), true
}

// volumeAbove 比较最后一根已收盘 K 线的成交量和它之前 n 根的均值。
func volumeAbove(candles []Candle, n int) bool {
	if n < 1 || len(candles) < n+1 {
		return false
	}
	last := candles[len(candles)-1].Volume
	if last <= 0 {
		return false
	}
	var sum float64
	from := len(candles) - 1 - n
	for _, c := range candles[from : len(candles)-1] {
		sum += c.Volume
	}
	avg := sum / float64(n)
	return avg > 0 && last > avg
}

func higherAgrees(cfg Config, higher []Candle, side Side) bool {
	closes := closesOf(higher)
	if len(closes) < cfg.EmaSlow+1 {
		return false
	}
	fast, err := EMA(closes, cfg.EmaFast)
	if err != nil {
		return false
	}
	slow, err := EMA(closes, cfg.EmaSlow)
	if err != nil {
		return false
	}
	i := len(closes) - 1
	switch side {
	case SideLong:
		return fast[i] > slow[i]
	case SideShort:
		return fast[i] < slow[i]
	default:
		return false
	}
}

func closesOf(candles []Candle) []float64 {
	out := make([]float64, len(candles))
	for i, c := range candles {
		out[i] = c.Close
	}
	return out
}
