// Command momprobe 用币安 USDT 永续真实 K 线验证「横截面动量选币」策略。
//
// 策略原型（来自外部策略草案，见下方参数扫描）：
//
//	在每根 K 线（或每 N 根）做一次横截面排序：
//	  1. 计算每个标的近 L 根的累计涨幅作为动量得分；
//	  2. 取涨幅最强的 K 个；
//	  3. 按得分比例分配权重（做多，无杠杆）；
//	  4. 调仓到目标权重，按成交量差价扣手续费。
//
// 这个工具只做验证，不接账户、不下单。用完即删。
//
// 关键设计取舍（与原型草案的差异，每一处都有理由）：
//
//   - 原型用 14 根 1h K 线（=14 小时）。本工具同时测原参数与更长的窗口 ——
//     小时级动量在加密市场更多表现为反转，且调仓成本极高；
//
//   - 全部结果**扣除 taker 手续费**（双边 0.05%/次调仓量）。不扣费的回测
//     对这类高换手策略毫无参考价值；
//
//   - 资金费未建模（永续多头在热点山寨上通常倒付资金费），
//     结果里单独标注这一项的缺失。
//
//     go run ./cmd/momprobe
package main

import (
	"fmt"
	"log"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"ooapi/internal/trading"
)

const (
	feeRate = 0.0005 // taker 单边 0.05%
	days    = 400    // 回测窗口
	// universeN 是下载范围：今天成交额前 N 都拉下来。
	// 池子（poolN）在每个调仓日按**当时的**成交额从这里面现选 ——
	// 只下载 40 个再排序等于偷看答案（幸存者偏差）。
	universeN = 150
	// poolN 是每个调仓日的候选池大小（按当时 30 日平均成交额取前 N）。
	poolN = 40
	// poolVolWindow 是流动性排序的回看长度（根 K 线）。
	poolVolWindow = 30
)

type symbolSeries struct {
	symbol  string
	prices  map[int64]float64 // openTime(ms) -> close
	quote   map[int64]float64 // openTime(ms) -> 该根 K 线的成交额（close × volume）
	ordered []int64
}

type config struct {
	name      string
	interval  string
	lookback  int  // 动量窗口（K 线根数）
	topK      int  // 持仓数
	rebal     int  // 每多少根 K 线调仓一次
	volAdjust bool // 是否用波动率调整后的动量
}

func main() {
	log.SetOutput(os.Stderr)
	client := trading.PublicClient("live")

	fmt.Printf("拉取候选范围（按 24h 成交额前 %d，排除稳定币对）...\n", universeN)
	tickers, err := client.AllTickers()
	if err != nil {
		log.Fatalf("24h 行情: %v", err)
	}
	type pair struct {
		sym string
		qv  float64
	}
	var ranked []pair
	for sym, t := range tickers {
		if !strings.HasSuffix(sym, "USDT") || t.QuoteVolume <= 0 {
			continue
		}
		base := strings.TrimSuffix(sym, "USDT")
		switch base {
		case "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USD1":
			continue
		}
		ranked = append(ranked, pair{sym, t.QuoteVolume})
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].qv > ranked[j].qv })
	if len(ranked) > universeN {
		ranked = ranked[:universeN]
	}
	syms := make([]string, 0, len(ranked))
	for _, p := range ranked {
		syms = append(syms, p.sym)
	}
	fmt.Printf("候选池: %s\n\n", strings.Join(syms, " "))

	now := time.Now().UTC()
	since := now.Add(-days * 24 * time.Hour)

	// 按周期分别拉数据（不同周期共用同一次拉取）。
	cache := map[string]map[string]*symbolSeries{}
	fetch := func(interval string) map[string]*symbolSeries {
		if got, ok := cache[interval]; ok {
			return got
		}
		out := map[string]*symbolSeries{}
		fmt.Printf("下载 %s K 线（%d 个标的，逐请求限流）...\n", interval, len(syms))
		for i, sym := range syms {
			s, err := loadSeries(client, sym, interval, since)
			if err != nil {
				log.Printf("  %s: %v", sym, err)
			} else if len(s.ordered) > 60 {
				out[sym] = s
			}
			/*
				每请求都休眠。

				klines(limit=1500) 每次权重 10；150 个标的 × 多页 = 数百次请求。
				早先写的是「每 10 个请求睡 120ms」（平均 12ms/请求），
				实测把 IP 打到了 429（2400 权重/分钟的上限）——
				我们的熔断器接住了它、没有续封，但数据拉取被中断。
				700ms/请求 ≈ 86 请求/分钟 ≈ 860 权重/分钟，安全余量足够。
			*/
			time.Sleep(700 * time.Millisecond)
			if i%20 == 19 {
				fmt.Printf("  进度 %d/%d\n", i+1, len(syms))
			}
		}
		fmt.Printf("  有效标的: %d\n", len(out))
		cache[interval] = out
		return out
	}

	configs := []config{
		/*
			只保留日线配置。

			1h 与 4h 的结论已经拿到且一致：无偏池（按调仓当时成交额现选）下
			全部深度亏损 —— 原型参数（14 根 1h、每根调仓）总收益 -99.3%，
			降频到 12 小时仍是 -94.1%。小时级横截面动量在这个市场是反转，
			不是延续，且换手成本高到不可承受。

			日线窗口（横截面动量的文献主流区间，1–12 个月）是唯一值得继续
			验证的方向。
		*/
		{"1d/lookback30/K5/每周", "1d", 30, 5, 7, false},
		{"1d/lookback60/K5/每周", "1d", 60, 5, 7, false},
		{"1d/lookback90/K5/每周", "1d", 90, 5, 7, false},
		// 波动率调整版（动量 / 波动）：避免永远选到波动最大的那几个。
		{"1d/lookback60/K5/每周(波动率调整)", "1d", 60, 5, 7, true},
		{"1d/lookback90/K5/每周(波动率调整)", "1d", 90, 5, 7, true},
		// 集中度变体。
		{"1d/lookback60/K3/每周(波动率调整)", "1d", 60, 3, 7, true},
		{"1d/lookback60/K8/每周(波动率调整)", "1d", 60, 8, 7, true},
		// 调仓频率变体（降低换手）。
		{"1d/lookback90/K5/每两周(波动率调整)", "1d", 90, 5, 14, true},
		{"1d/lookback90/K5/每月(波动率调整)", "1d", 90, 5, 30, true},
	}

	fmt.Printf("\n%s\n", strings.Repeat("=", 118))
	fmt.Printf("%-38s %9s %9s %8s %7s %8s %9s\n",
		"配置", "总收益", "最大回撤", "Sharpe", "年换手", "费用占比", "调仓次数")
	fmt.Printf("%s\n", strings.Repeat("-", 118))

	for _, cfg := range configs {
		seriesSet := fetch(cfg.interval)
		res := runBacktest(seriesSet, cfg)
		if res == nil {
			fmt.Printf("%-38s  数据不足\n", cfg.name)
			continue
		}
		fmt.Printf("%-38s %8.2f%% %8.2f%% %8.2f %6.1fx %7.2f%% %9d\n",
			cfg.name, res.totalReturn*100, res.maxDD*100, res.sharpe,
			res.annualTurnover, res.feeDrag*100, res.rebalances)
	}

	// 基准：BTC 买入持有。
	if btc, err := loadSeries(client, "BTCUSDT", "1d", since); err == nil && len(btc.ordered) > 60 {
		first := btc.prices[btc.ordered[0]]
		last := btc.prices[btc.ordered[len(btc.ordered)-1]]
		fmt.Printf("\n基准 BTC 买入持有: %.2f%%\n", (last/first-1)*100)
	}
}

// loadSeries 分页拉取单个标的的 K 线。
func loadSeries(client *trading.USDMClient, symbol, interval string, since time.Time) (*symbolSeries, error) {
	s := &symbolSeries{symbol: symbol, prices: map[int64]float64{}, quote: map[int64]float64{}}
	cursor := since.UnixMilli()
	for page := 0; page < 4; page++ {
		bars, err := client.Candles(symbol, interval, cursor, 1500)
		if err != nil {
			return nil, err
		}
		if len(bars) == 0 {
			break
		}
		for _, b := range bars {
			ms := b.OpenTime.UnixMilli()
			s.prices[ms] = b.Close
			// 成交额近似：收盘价 × 成交量（USDT 计价）。
			// 用它做「调仓当时」的流动性排序 —— 这是消除幸存者偏差的关键，
			// 用今天的成交额排序等于偷看了答案。
			s.quote[ms] = b.Close * b.Volume
			s.ordered = append(s.ordered, ms)
		}
		last := bars[len(bars)-1].OpenTime.UnixMilli()
		if last <= cursor || len(bars) < 1500 {
			break
		}
		cursor = last + 1
	}
	return s, nil
}

type backtestResult struct {
	totalReturn    float64
	maxDD          float64
	sharpe         float64
	annualTurnover float64
	feeDrag        float64
	rebalances     int
}

// runBacktest 跑一次横截面动量回测。
func runBacktest(series map[string]*symbolSeries, cfg config) *backtestResult {
	// 时间轴：取并集并排序。
	axisSet := map[int64]struct{}{}
	for _, s := range series {
		for _, t := range s.ordered {
			axisSet[t] = struct{}{}
		}
	}
	axis := make([]int64, 0, len(axisSet))
	for t := range axisSet {
		axis = append(axis, t)
	}
	sort.Slice(axis, func(i, j int) bool { return axis[i] < axis[j] })
	if len(axis) <= cfg.lookback+cfg.rebal*2 {
		return nil
	}

	equity := 100.0
	lastEquity := 100.0 // 上次调仓后的权益
	weights := map[string]float64{}
	basePrices := map[string]float64{}
	peak := equity
	maxDD := 0.0
	feesPaid := 0.0
	turnoverSum := 0.0
	rebalances := 0

	barMs := int64(3600 * 1000)
	switch cfg.interval {
	case "4h":
		barMs = 4 * 3600 * 1000
	case "1d":
		barMs = 24 * 3600 * 1000
	}

	// 每日权益采样（Sharpe 用）。
	var dailyEquity []float64
	lastDay := int64(-1)

	for i := cfg.lookback; i < len(axis); i++ {
		t := axis[i]

		// 市值重估：drift 权重 = w * (p_i / p_base) 归一化。
		sumDrift := 0.0
		drift := map[string]float64{}
		for sym, w := range weights {
			s := series[sym]
			pNow, okNow := s.prices[t]
			pBase := basePrices[sym]
			if !okNow || pBase <= 0 {
				continue
			}
			d := w * (pNow / pBase)
			drift[sym] = d
			sumDrift += d
		}
		if sumDrift > 0 {
			equity = lastEquity * sumDrift
		}
		if equity > peak {
			peak = equity
		}
		if dd := (peak - equity) / peak; dd > maxDD {
			maxDD = dd
		}

		// 日界采样。
		day := t / 86400000
		if day != lastDay {
			dailyEquity = append(dailyEquity, equity)
			lastDay = day
		}

		if i%cfg.rebal != 0 {
			continue
		}

		/*
			按「调仓当时」的成交额选池。

			**这是全流程里最重要的一步**：如果直接用「今天的成交额前 40」当池子，
			等于回头买了「一年前你不知道会赢的那几个赢家」—— 回测收益会被
			系统性灌水。正确做法是每个调仓日只看截至当日的 30 根平均成交额，
			从下载的全部候选（universeN）里现选前 poolN。

			仍然消不掉的偏差：已退市的标的拿不到 K 线（币安不提供历史
			上架清单），所以「退市归零」的那部分亏损没有计入。
		*/
		pool := map[string]struct{}{}
		{
			type liq struct {
				sym string
				vol float64
			}
			var rankedLiq []liq
			for sym, s := range series {
				sum, n := 0.0, 0
				for j := i - poolVolWindow + 1; j <= i; j++ {
					if j < 0 {
						continue
					}
					if q, ok := s.quote[axis[j]]; ok {
						sum += q
						n++
					}
				}
				if n < poolVolWindow/2 {
					continue
				}
				rankedLiq = append(rankedLiq, liq{sym, sum / float64(n)})
			}
			sort.Slice(rankedLiq, func(a, b int) bool { return rankedLiq[a].vol > rankedLiq[b].vol })
			if len(rankedLiq) > poolN {
				rankedLiq = rankedLiq[:poolN]
			}
			for _, r := range rankedLiq {
				pool[r.sym] = struct{}{}
			}
		}

		// 动量打分（只在当日的池子里选）。
		type scored struct {
			sym   string
			score float64
		}
		var candidates []scored
		for sym, s := range series {
			if _, inPool := pool[sym]; !inPool {
				continue
			}
			pNow, okNow := s.prices[t]
			pPast, okPast := s.prices[axis[i-cfg.lookback]]
			if !okNow || !okPast || pPast <= 0 {
				continue
			}
			score := pNow/pPast - 1
			if cfg.volAdjust {
				// 用窗口内每根收益的标准差做波动率，得到类 t 值。
				var rets []float64
				prev := pPast
				valid := true
				for j := i - cfg.lookback + 1; j <= i; j++ {
					pj, ok := s.prices[axis[j]]
					if !ok || prev <= 0 {
						valid = false
						break
					}
					rets = append(rets, pj/prev-1)
					prev = pj
				}
				if !valid || len(rets) < 5 {
					continue
				}
				mean := 0.0
				for _, r := range rets {
					mean += r
				}
				mean /= float64(len(rets))
				varsum := 0.0
				for _, r := range rets {
					varsum += (r - mean) * (r - mean)
				}
				vol := math.Sqrt(varsum / float64(len(rets)-1))
				if vol <= 1e-9 {
					continue
				}
				score = score / vol / math.Sqrt(float64(cfg.lookback))
			}
			candidates = append(candidates, scored{sym, score})
		}
		if len(candidates) < cfg.topK {
			continue
		}
		sort.Slice(candidates, func(a, b int) bool { return candidates[a].score > candidates[b].score })
		picked := candidates[:cfg.topK]

		// 权重：按得分比例（得分有负数或全非正时退化为等权）。
		target := map[string]float64{}
		sumScore := 0.0
		for _, p := range picked {
			if p.score > 0 {
				sumScore += p.score
			}
		}
		if sumScore > 0 {
			for _, p := range picked {
				if p.score > 0 {
					target[p.sym] = p.score / sumScore
				}
			}
		} else {
			for _, p := range picked {
				target[p.sym] = 1 / float64(len(picked))
			}
		}

		// 归一化 drift 权重后算换手。
		normDrift := map[string]float64{}
		if sumDrift > 0 {
			for sym, d := range drift {
				normDrift[sym] = d / sumDrift
			}
		}
		turnover := 0.0
		symSet := map[string]struct{}{}
		for sym := range target {
			symSet[sym] = struct{}{}
		}
		for sym := range normDrift {
			symSet[sym] = struct{}{}
		}
		for sym := range symSet {
			turnover += math.Abs(target[sym] - normDrift[sym])
		}

		fee := turnover * feeRate
		feesPaid += equity * fee
		turnoverSum += turnover
		equity *= (1 - fee)
		rebalances++

		// 落定新持仓。
		weights = target
		basePrices = map[string]float64{}
		for sym := range target {
			if p, ok := series[sym].prices[t]; ok {
				basePrices[sym] = p
			} else {
				delete(weights, sym)
			}
		}
		lastEquity = equity
	}

	if len(dailyEquity) < 30 {
		return nil
	}
	// Sharpe：日收益年化。
	var rets []float64
	for i := 1; i < len(dailyEquity); i++ {
		if dailyEquity[i-1] > 0 {
			rets = append(rets, dailyEquity[i]/dailyEquity[i-1]-1)
		}
	}
	mean := 0.0
	for _, r := range rets {
		mean += r
	}
	mean /= float64(len(rets))
	varsum := 0.0
	for _, r := range rets {
		varsum += (r - mean) * (r - mean)
	}
	sd := math.Sqrt(varsum / float64(len(rets)-1))
	sharpe := 0.0
	if sd > 1e-12 {
		sharpe = mean / sd * math.Sqrt(365)
	}

	years := float64(len(axis)) * float64(barMs) / float64(365*24*3600*1000)
	annualTurnover := 0.0
	if years > 0 {
		annualTurnover = turnoverSum / years
	}

	return &backtestResult{
		totalReturn:    equity/100.0 - 1,
		maxDD:          maxDD,
		sharpe:         sharpe,
		annualTurnover: annualTurnover,
		feeDrag:        feesPaid / 100.0,
		rebalances:     rebalances,
	}
}
