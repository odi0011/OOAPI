package trading

/*
交易所公开行情的共享缓存。

**为什么必须有**：看板每轮刷新会对每个币种各发 klines + ticker + 标记价，
而页面周期性刷新、多个用户各自刷新 —— 全部直连币安会瞬间打满权重配额。
实测后果是服务器 IP 被币安 418 封禁（`Way too many requests`），
整个看板连同交易台一起不可用。

**缓存几秒对展示没有任何影响**：交易所公开行情本身就是十几秒粒度的数据，
看板显示的不是逐笔成交。用缓存换来的稳定性远大于那几秒的延迟。

设计要点：
  · 按「主机 + 交易对 + 周期 + 条数」分键 —— 不同账号模式（测网/实盘）
    的主机不同，不能互相命中；
  · single-flight：同一个键的并发请求只发一次上游，其余等结果 ——
    否则「10 个用户同时刷新」会变成 10 倍请求，等于没缓存；
  · 失败不缓存：网络抖动造成的空结果不该被记成「这个币种没有行情」，
    下一次请求要能立刻重试。
*/

import (
	"sync"
	"time"
)

const (
	// klineCacheTTL 是 K 线缓存时长。
	//
	// 取 5 秒：页面的真实轮询周期也是 5 秒，展示上感觉不到差别，
	// 但把「多个用户同时刷新」合并成一次上游请求。
	klineCacheTTL = 5 * time.Second

	/*
		bulkTickerTTL 是「全市场 24h 统计」的缓存时长。

		这里用批量端点（不带 symbol）而不是逐个币种查：批量一次拉回
		全部 793 个交易对，权重 40；逐个查是**每个币种**权重 40 ——
		看板有 8 个币种，逐个查就是 320。差了 8 倍，而这正是把 IP
		打成 418 封禁的主因。

		24h 涨跌幅是分钟级变化的量，缓存 30 秒对展示没有影响。
	*/
	bulkTickerTTL = 30 * time.Second

	/*
		bulkMarkTTL 是「全市场标记价 + 资金费率」的缓存时长。

		同样用批量端点：一次拉全部交易对（权重 10），而不是每币一次。
		标记价变化最快，给 5 秒 —— 既要跟上价格，又不能被高频轮询打穿。
	*/
	bulkMarkTTL = 5 * time.Second

	// tickerCacheTTL 保留给单个币种的兜底查询（批量端点不可用时）。
	tickerCacheTTL = 5 * time.Second

	// markCacheTTL 是单币种标记价缓存时长（兜底路径）。
	markCacheTTL = 2 * time.Second

	/*
		accountCacheTTL 是**签名账户读**（持仓/挂单/权益）的缓存时长。

		这些是账户私有数据、不共享，所以不能像公开行情那样长缓存 ——
		但看板每 5 秒轮询一次，每个打开页面的用户都会各触发一轮，
		没有任何缓存时请求量随「在线人数 × 币种数」线性增长。

		3 秒：短于页面轮询周期（每次刷新仍拿到新数据），
		又能把「多个用户同时刷新」合并成一次上游请求。
		仓位与挂单晚 3 秒对展示没有影响。
	*/
	accountCacheTTL = 3 * time.Second

	// maxMarketCacheEntries 是缓存条目上限。
	// 正常规模（十几个币种 × 几个周期）远达不到；设上限是防止
	// 异常调用（比如遍历上千个交易对）把内存撑起来。
	maxMarketCacheEntries = 512
)

type marketCacheEntry[T any] struct {
	value   T
	expires time.Time
	// ready 在首次填充完成后关闭；等待者靠它拿到同一个结果（single-flight）。
	ready chan struct{}
}

type marketCacheStore[T any] struct {
	mu      sync.Mutex
	entries map[string]*marketCacheEntry[T]
	ttl     time.Duration
}

func newMarketCacheStore[T any](ttl time.Duration) *marketCacheStore[T] {
	return &marketCacheStore[T]{entries: map[string]*marketCacheEntry[T]{}, ttl: ttl}
}

/*
get 取缓存；未命中时调用 fetch 填充。

single-flight 语义：同一个键的并发调用里只有一个会执行 fetch，
其余阻塞等待同一个结果 —— 这是「缓存能不能真正挡住并发」的关键。
*/
func (s *marketCacheStore[T]) get(key string, fetch func() (T, error)) (T, error) {
	s.mu.Lock()
	now := time.Now()
	if entry, ok := s.entries[key]; ok {
		if now.Before(entry.expires) {
			// 命中且未过期：等它填好（一般已填好，ready 立即返回）。
			ready := entry.ready
			s.mu.Unlock()
			<-ready
			return entry.value, nil
		}
		// 过期：下面重建
		delete(s.entries, key)
	}
	// 未命中：登记占位并成为唯一的 fetch 执行者
	entry := &marketCacheEntry[T]{ready: make(chan struct{})}
	if len(s.entries) >= maxMarketCacheEntries {
		// 超限就整体清空重建：正常规模下永远不会走到这里
		s.entries = map[string]*marketCacheEntry[T]{}
	}
	s.entries[key] = entry
	s.mu.Unlock()

	value, err := fetch()
	if err != nil {
		// 失败不留缓存：网络抖动不该被记成「这个币种没有行情」，
		// 下一次请求要能立刻重试。
		s.mu.Lock()
		delete(s.entries, key)
		close(entry.ready)
		s.mu.Unlock()
		var zero T
		return zero, err
	}

	s.mu.Lock()
	entry.value = value
	entry.expires = time.Now().Add(s.ttl)
	close(entry.ready)
	s.mu.Unlock()
	return value, nil
}

// MarkQuoteView 是一个交易对的标记价与资金费率。
type MarkQuoteView struct {
	MarkPrice float64
	Funding   float64
}

var (
	klineCache     = newMarketCacheStore[[]DeskCandle](klineCacheTTL)
	tickerCache    = newMarketCacheStore[Ticker24h](tickerCacheTTL)
	markPriceCache = newMarketCacheStore[float64](markCacheTTL)

	// 批量行情：一次拉全市场再按交易对索引。看板有 8 个币种，
	// 逐个查与批量查的权重差 8 倍（这是 IP 被封的主因）。
	bulkTickerCache = newMarketCacheStore[map[string]Ticker24h](bulkTickerTTL)
	bulkMarkCache   = newMarketCacheStore[map[string]MarkQuoteView](bulkMarkTTL)

	/*
		账户读缓存。键里必须带凭据指纹 —— 不同账号读到的持仓不同，
		按交易对缓存会把 A 账号的持仓返回给 B 账号（严重串号）。
	*/
	accountCache = newMarketCacheStore[accountCacheValue](accountCacheTTL)
)

// accountCacheValue 是一次签名读的结果。三类读共用一个结构，
// 让它们能走同一套缓存（各自只填自己那一项）。
type accountCacheValue struct {
	Risk          *RiskView
	BookOrders    []DeskOrder
	AlgoOrders    []DeskOrder
	OpenPositions []PanelPosition
}

// marketCacheKey 由主机与请求参数拼成。主机区分测网/实盘。
func marketCacheKey(parts ...string) string {
	out := ""
	for i, part := range parts {
		if i > 0 {
			out += "|"
		}
		out += part
	}
	return out
}
