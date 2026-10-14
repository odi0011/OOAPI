package trading

/*
标的多因子画像：从真实 K 线算，供看板的「量化五因子」雷达/进度条使用。

**为什么必须算而不能写死**：界面上这五个分数长得像技术指标，
用户会拿它判断「这个币现在适不适合趋势跟踪」。早先这五个数是
硬编码在资产档案里的固定值（趋势 88 / 动量 82 / 盘口 99 …），
无论行情怎么变都不动 —— 那不是指标，是装饰。

口径（都用已有的指标函数，不另造一套）：
  · 趋势持续度 Trend      快慢 EMA 的分离程度，归一化到 0–100
  · 动量爆发力 Momentum   RSI 偏离中值 + 最近涨幅
  · 波动率弹性 Volatility 真实波幅（ATR 风格的均值上下沿）
  · 均值回归   Mean-Rev   收盘价对 EMA 的偏离（越偏越可能回归）
  · 盘口深度   Liquidity  K 线量能相对自身近期均量（交易所公开数据里
                          没有逐档挂单，用成交量代表「流动性活跃度」，
                          指标名保持「量能」以免误导）

每个因子都返回 0–100 的整数，并按同一套规则取整 —— 分数之间可比。
样本不足时返回 ok=false，调用方**不要**用 0 或默认值冒充：
「算不出来」和「分数很低」是两件事。
*/

// FactorScores 是标的多因子画像（每项 0–100）。
type FactorScores struct {
	Trend         int `json:"trend"`
	Momentum      int `json:"momentum"`
	Volatility    int `json:"volatility"`
	MeanReversion int `json:"meanReversion"`
	Liquidity     int `json:"liquidity"`
}

// factorSampleFloor 是算因子所需的最少 K 线根数。
// 低于这个数时指标没有统计意义（EMA 都算不出来），宁可不给分数。
const factorSampleFloor = 30

/*
ComputeFactorScores 从 K 线算五因子。

candles 按时间正序（最后一个是最新）。样本不足返回 ok=false。
*/
func ComputeFactorScores(candles []DeskCandle) (FactorScores, bool) {
	if len(candles) < factorSampleFloor {
		return FactorScores{}, false
	}
	closes := make([]float64, 0, len(candles))
	volumes := make([]float64, 0, len(candles))
	highs := make([]float64, 0, len(candles))
	lows := make([]float64, 0, len(candles))
	for _, c := range candles {
		if c.Close > 0 {
			closes = append(closes, c.Close)
		}
		volumes = append(volumes, c.Volume)
		highs = append(highs, c.High)
		lows = append(lows, c.Low)
	}
	if len(closes) < factorSampleFloor {
		return FactorScores{}, false
	}

	fast, errFast := EMA(closes, 9)
	slow, errSlow := EMA(closes, 21)
	if errFast != nil || errSlow != nil || len(fast) == 0 || len(slow) == 0 {
		return FactorScores{}, false
	}
	i := len(closes) - 1
	price := closes[i]

	/*
		--- 趋势持续度：快慢线分离的**带方向**强度 ---

		为什么带方向：这五个分数是给人看「现在什么状态」的。
		如果上涨和下跌都返回 100，页面上就是「趋势 100」而看不出是涨是跌 ——
		那种分数没有信息量，和硬编码的装饰数字没有区别
		（测试 TestFactorScoresDifferByTrend 专门盯这一点）。

		口径：快线在慢线上方 → 正分（多头趋势越强越高）；
		下方 → 负向映射（0–40，表示弱势/空头强度）。
	*/
	sep := 0.0
	if price > 0 {
		sep = (fast[i] - slow[i]) / price
	}
	trend := 0
	if sep >= 0 {
		trend = scoreFromRatio(sep/0.008, 100)
	} else {
		trend = scoreFromRatio(1-absFloat(sep)/0.008, 40)
	}

	/*
		--- 动量爆发力：**带方向**的近期涨跌（以「看多强度」为刻度） ---

		为什么带方向：这五个分数是给人看「现在什么状态」的。
		如果上涨和下跌都返回 100，页面上就是「动量 100」而看不出方向 ——
		那种分数没有信息量，和硬编码的装饰数字没有区别
		（测试 TestFactorScoresDifferByTrend 专门盯这一点）。

		刻度：把近 10 根的涨跌幅映射到 0–100，
		跌 2% 及以上 → 0（无看多动量），涨 2% 及以上 → 100。
		RSI 作顺势确认，权重较小（价格变化是主证据）。
	*/
	momentum := 0
	if len(closes) > 10 {
		base := closes[len(closes)-11]
		if base > 0 {
			change := (price - base) / base
			// -2% 记 0，+2% 记 100，线性。
			momentum = scoreFromRatio((change+0.02)/0.04, 100)
		}
	}
	if rsi, okRSI := LastRSI(closes, RSIPeriod); okRSI {
		// RSI 本身也是看多刻度：0 → 0 分，100 → 100 分。
		// 取 1/3 权重与价格动量融合 —— 两者都指向强势时分数才接近满值。
		rsiScore := scoreFromRatio(rsi/100, 100)
		momentum = (momentum*2 + rsiScore) / 3
	}

	// --- 波动率弹性：近段真实波幅均值 / 价格 ---
	// 与方向无关（波动就是波动）：0% → 0 分，≥2% → 100 分。
	trSum := 0.0
	trCount := 0
	start := len(candles) - 20
	if start < 1 {
		start = 1
	}
	for idx := start; idx < len(candles); idx++ {
		prevClose := candles[idx-1].Close
		if prevClose <= 0 {
			continue
		}
		high := highs[idx]
		low := lows[idx]
		tr := high - low
		if h := absFloat(high - prevClose); h > tr {
			tr = h
		}
		if l := absFloat(low - prevClose); l > tr {
			tr = l
		}
		trSum += tr
		trCount++
	}
	volatility := 0
	if trCount > 0 && price > 0 {
		volatility = scoreFromRatio((trSum/float64(trCount))/price/0.02, 100)
	}

	/*
		--- 均值回归：收盘价相对慢线的偏离（**刻意不带方向**）---

		与趋势/动量不同，均值回归没有「看多/看空」之分：
		价格偏离均线 4%，无论是上方还是下方，回归压力都同样大。
		所以这一项用绝对值 —— 不是漏了方向，是方向在这里没有意义。
	*/
	meanReversion := 0
	if slow[i] > 0 {
		dev := absFloat((price - slow[i]) / slow[i])
		meanReversion = scoreFromRatio(dev/0.03, 100)
	}

	// --- 量能（流动性活跃度）：近 10 根均量 / 近 50 根均量 ---
	// 比值 1.0 是「与自身常态持平」；1.0 → 50 分，≥2.0 → 100 分，
	// 越低说明当前越清淡。
	liquidity := 0
	if recent, base, ok := volumeRatio(volumes, 10, 50); ok && base > 0 {
		liquidity = scoreFromRatio(recent/base/2.0, 100)
	}

	return FactorScores{
		Trend:         trend,
		Momentum:      momentum,
		Volatility:    volatility,
		MeanReversion: meanReversion,
		Liquidity:     liquidity,
	}, true
}

// scoreFromRatio 把 0..∞ 的比值映射到 0..100（1.0 及以上记满）。
func scoreFromRatio(ratio float64, full int) int {
	if ratio <= 0 {
		return 0
	}
	if ratio >= 1 {
		return full
	}
	return int(ratio*float64(full) + 0.5)
}

// volumeRatio 用最后 recentN 根的量比上前 baseN 根（不足则取全部）。
func volumeRatio(volumes []float64, recentN, baseN int) (float64, float64, bool) {
	if len(volumes) < recentN+1 {
		return 0, 0, false
	}
	recent := avgOf(volumes[len(volumes)-recentN:])
	baseStart := len(volumes) - baseN
	if baseStart < 0 {
		baseStart = 0
	}
	base := avgOf(volumes[baseStart:])
	return recent, base, true
}

func avgOf(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func absFloat(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
