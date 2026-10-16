package trading

import (
	"strings"
	"sync"
)

/*
GridExchange 在真实币安现货客户端上的实现。

这一层是**薄壳**，但每一层薄壳都有它存在的理由：网格引擎认的是
PlaceLimit / OpenOrders / Cancel 这组名字，而那组名字和趋势引擎的
PlaceEntry / Close 是两套完全不同的语义（挂限价 vs 市价开平）。
同一个类型上不能有两组同名方法，所以现货网格用带 Spot 前缀的
底层方法 + 这层适配器 —— 名字区分开，误调就不可能发生。

与 SpotExchange（趋势引擎的现货适配器）的区别：

	SpotExchange   市价开仓 → 挂止损止盈 → 市价平仓
	SpotGridExchange 一批只做 maker 的限价单，成交后在对面重挂
*/
type SpotGridExchange struct {
	c *USDMClient
	// mu 保护 creds 的装配。引擎每一拍都会 authorize 一次。
	mu sync.Mutex
}

// NewSpotGridExchange 按网络打开一个现货网格出口。
//
// 测网不可用：现货测网（testnet.binance.vision）与合约测网是两套
// 互不连通的账本，而且现货测网上的交易对与规则和实盘差得很远，
// 网格这种靠"参数恰好落在门槛上"的策略在测网上的结论没有参考价值。
// 但**代码路径是通的**，单测用 mock 主机跑。
func NewSpotGridExchange(network string) (*SpotGridExchange, error) {
	base, err := spotBaseFor(network)
	if err != nil {
		return nil, err
	}
	return &SpotGridExchange{c: NewUSDMClient(base)}, nil
}

// UseCredentials 装填密钥。网络必须与主机一致。
func (s *SpotGridExchange) UseCredentials(creds Credentials) error {
	if s == nil || s.c == nil {
		return ErrKeyNotUsable
	}
	return s.c.UseCredentials(creds)
}

// SyncsPosition 表示挂单与余额以交易所为准，不是本地记账。
func (s *SpotGridExchange) SyncsPosition() bool { return true }

func (s *SpotGridExchange) PlaceLimit(symbol string, side SpotSide, qty, price float64, clientID string) (SpotOrderState, error) {
	return s.c.PlaceSpotLimit(symbol, side, qty, price, clientID)
}

func (s *SpotGridExchange) OpenOrders(symbol string) ([]SpotOrderState, error) {
	return s.c.SpotOpenOrders(symbol)
}

func (s *SpotGridExchange) QueryOrder(symbol, clientID string) (SpotOrderState, error) {
	return s.c.SpotQueryOrder(symbol, clientID)
}

func (s *SpotGridExchange) Cancel(symbol, clientID string) error {
	return s.c.SpotCancel(symbol, clientID)
}

func (s *SpotGridExchange) Trades(symbol string, orderID int64) ([]GridTrade, error) {
	return s.c.SpotOrderTrades(symbol, orderID)
}

func (s *SpotGridExchange) MarketSell(symbol string, qty float64, clientID string) (SpotOrderState, error) {
	return s.c.SpotMarketSell(symbol, qty, clientID)
}

func (s *SpotGridExchange) BaseQty(symbol string) (float64, error) {
	return s.c.SpotFreeQty(symbol)
}

/*
Rules 读交易对规则。

**现货和合约的过滤器名字不一样**，这里必须走现货那一套
（/api/v3/exchangeInfo、NOTIONAL 而不是 MIN_NOTIONAL 优先）。
走错了会拿到一个看似合理但其实不是这个交易对的步长 ——
而步长错一位，卖单数量就会差一个数量级。
*/
func (s *SpotGridExchange) Rules(symbol string) (GridRules, error) {
	r, err := s.c.spotRulesFor(symbol)
	if err != nil {
		return GridRules{}, err
	}
	return GridRules{
		BaseAsset:   r.BaseAsset,
		QuoteAsset:  r.QuoteAsset,
		StepSize:    r.StepSize,
		MinQty:      r.MinQty,
		TickSize:    r.TickSize,
		MinNotional: r.MinNotional,
	}, nil
}

/*
LastPrice 读最新成交价。

用现货公开接口（/api/v3/ticker/price），不需要密钥 —— 读价失败
不该和"密钥没配好"混在一起，而且调度器在建引擎之前就要用它。

用**上一笔成交价**而不是买一卖一中间价：网格判断"哪些线在当前价
之下"用的是挂单口径。用中间价的话，价差大的币种上会算出偏乐观的
"价格在线上"，于是挂出一张会立即成交的买单（被 -2010 拒掉），
每一拍都白跑一次。
*/
func (s *SpotGridExchange) LastPrice(symbol string) (float64, error) {
	if s == nil || s.c == nil {
		return 0, invalid("交易所客户端未初始化")
	}
	return s.c.SpotLastPrice(symbol)
}

// CommissionRate 读现货账户的单边费率（取 taker，保守）。
//
// 网格的每格收益 = 间距 − 双边手续费，而币安现货基础档是 0.1%/边，
// 是合约 taker 费（0.05%）的两倍。拿 0.05% 去算，一份**实际亏损**的
// 网格会被算成盈利 —— 所以建网格时要把真实费率读出来存进配置。
// 读不到时返回 0，由调用方用不乐观的兜底值。
func (s *SpotGridExchange) CommissionRate() float64 {
	if s == nil || s.c == nil {
		return 0
	}
	maker, taker, err := s.c.SpotCommissionRates()
	if err != nil {
		return 0
	}
	// 用两者中较大的那个：网格卖出是 maker，但把 maker 的便宜
	// 当成既定收益，等于把"运气"写进成本模型。
	if taker > maker {
		return taker
	}
	return maker
}

/*
GridExchangeFor 按网络建一个现货网格出口。

**实盘门闩在这里也要拦一道**，和趋势引擎的 NewExchange 一样。
多一道是刻意的：网格会同时挂出十几张单，比趋势引擎一次一张单
更容易在某条少见的路径上绕过门闩 —— 而绕过之后动的是真钱。
*/
func GridExchangeFor(network string) (GridExchange, error) {
	switch strings.ToLower(strings.TrimSpace(network)) {
	case ModeTestnet:
		return NewSpotGridExchange(ModeTestnet)
	case ModeLive:
		if !TestnetGreen() {
			return nil, ErrLiveGateClosed
		}
		return NewSpotGridExchange(ModeLive)
	default:
		return nil, ErrBadMode
	}
}
