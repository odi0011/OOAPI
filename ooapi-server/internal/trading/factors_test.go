package trading

import (
	"math"
	"testing"
	"time"
)

/*
多因子画像的测试。

重点不是「分数算得准不准」，而是**这五个数确实来自 K 线**：

早先它们被硬编码在资产档案里（趋势 88 / 动量 82 / 盘口 99 …），
行情怎么变都不动 —— 页面上长得像技术指标，其实是装饰。
所以这里用「上涨行情 vs 下跌行情必须给出不同的分」把这件事钉死：
任何把它改回常量的人都会让这组测试变红。
*/

// makeCandles 造一段带方向与波幅的 K 线。drift > 0 上涨，< 0 下跌。
func makeCandles(n int, start, drift, amplitude, baseVolume float64) []DeskCandle {
	out := make([]DeskCandle, 0, n)
	price := start
	now := time.Now().Add(-time.Duration(n) * time.Minute).UTC()
	for i := 0; i < n; i++ {
		open := price
		price = price * (1 + drift)
		// 加一点正弦扰动，让 RSI / 波幅不至于退化
		wiggle := math.Sin(float64(i)*0.7) * amplitude * start
		high := math.Max(open, price) + math.Abs(wiggle)
		low := math.Min(open, price) - math.Abs(wiggle)
		volume := baseVolume * (1 + 0.3*math.Sin(float64(i)*0.4))
		out = append(out, DeskCandle{
			OpenTime: now.Add(time.Duration(i) * time.Minute),
			Open:     open,
			High:     high,
			Low:      low,
			Close:    price,
			Volume:   volume,
		})
	}
	return out
}

func TestFactorScoresDifferByTrend(t *testing.T) {
	// 同一起点、同一波幅，只有方向相反 —— 因子必须能区分。
	up := makeCandles(120, 100, 0.004, 0.002, 1000)
	down := makeCandles(120, 100, -0.004, 0.002, 1000)

	upScores, okUp := ComputeFactorScores(up)
	downScores, okDown := ComputeFactorScores(down)
	if !okUp || !okDown {
		t.Fatal("样本充足时必须算得出因子")
	}

	if upScores.Trend == downScores.Trend {
		t.Fatalf("上涨与下跌的趋势分不该相同（%d）—— 分数看起来不依赖行情", upScores.Trend)
	}
	if upScores.Momentum == downScores.Momentum {
		t.Fatalf("上涨与下跌的动量分不该相同（%d）", upScores.Momentum)
	}

	// 全部落在合法区间（进度条按 0-100 渲染）。
	for name, s := range map[string]FactorScores{"up": upScores, "down": downScores} {
		for label, v := range map[string]int{
			"trend": s.Trend, "momentum": s.Momentum, "volatility": s.Volatility,
			"meanReversion": s.MeanReversion, "liquidity": s.Liquidity,
		} {
			if v < 0 || v > 100 {
				t.Fatalf("%s 的 %s 越界: %d", name, label, v)
			}
		}
	}
}

func TestFactorScoresFollowVolatility(t *testing.T) {
	// 平静行情 vs 剧烈行情：波动率分必须不同。
	calm := makeCandles(120, 100, 0.001, 0.0005, 1000)
	wild := makeCandles(120, 100, 0.001, 0.02, 1000)

	calmScores, _ := ComputeFactorScores(calm)
	wildScores, _ := ComputeFactorScores(wild)
	if wildScores.Volatility <= calmScores.Volatility {
		t.Fatalf("剧烈行情的波动率分应更高：calm=%d wild=%d", calmScores.Volatility, wildScores.Volatility)
	}
}

func TestFactorScoresFollowVolume(t *testing.T) {
	// 尾段放量：量能分必须比均匀量能高。
	quiet := makeCandles(120, 100, 0.001, 0.002, 1000)
	loud := makeCandles(120, 100, 0.001, 0.002, 1000)
	for i := len(loud) - 10; i < len(loud); i++ {
		loud[i].Volume *= 5
	}

	quietScores, _ := ComputeFactorScores(quiet)
	loudScores, _ := ComputeFactorScores(loud)
	if loudScores.Liquidity <= quietScores.Liquidity {
		t.Fatalf("尾段放量的量能分应更高：quiet=%d loud=%d", quietScores.Liquidity, loudScores.Liquidity)
	}
}

func TestFactorScoresRefuseThinSamples(t *testing.T) {
	// 样本不足时返回 ok=false —— 调用方据此不显示，
	// 而不是显示一堆 0（「算不出」和「分数很低」是两件事）。
	thin := makeCandles(factorSampleFloor-1, 100, 0.001, 0.002, 1000)
	if _, okScores := ComputeFactorScores(thin); okScores {
		t.Fatal("样本不足时不该给分数")
	}
	if _, okEmpty := ComputeFactorScores(nil); okEmpty {
		t.Fatal("空输入不该给分数")
	}
}

func TestScoreFromRatioBounds(t *testing.T) {
	if got := scoreFromRatio(0, 100); got != 0 {
		t.Fatalf("0 比值应为 0 分，得到 %d", got)
	}
	if got := scoreFromRatio(1, 100); got != 100 {
		t.Fatalf("1.0 比值应记满，得到 %d", got)
	}
	if got := scoreFromRatio(5, 100); got != 100 {
		t.Fatalf("超过 1.0 应封顶在 100，得到 %d", got)
	}
	if got := scoreFromRatio(0.5, 100); got != 50 {
		t.Fatalf("0.5 应为 50 分，得到 %d", got)
	}
}
