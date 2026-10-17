package trading

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
现货网格引擎。

和趋势引擎（Engine）的关系：**两套东西，不共用状态机**。
趋势是「一个仓位、开仓→挂保护→平仓」；网格是「N 张同时挂着的限价单」，
没有"一个仓位"这个概念，也没有开平配对 —— 每一格自己买、在上一格卖。

所以这里不复用 Machine。硬把网格塞进那 8 个状态里，只会造出一个
每个状态名都对不上的东西。

--------------------------------------------------------------------------
每格一个「单位」，这就是全部的状态
--------------------------------------------------------------------------

引擎的全部内存状态是一张 hold 表：

	holds[i] = 在第 i 条线上买到的、还没卖出去的那一份（数量 + 买入均价）

规则只有三条，每一拍都从零重算"应该挂什么"，所以它是**自愈**的：

 1. holds[i] 非空 → 第 i 条线上不能再挂买单，改成在**第 i+1 条线**挂卖单；
 2. holds[i] 为空且当前价高于第 i 条线 → 在第 i 条线挂买单；
 3. 最后一条线（i = N-1）永远不挂买单 —— 它上面没有线可以卖，
    在那里买入就是把货砸在自己手里。

第 1 条里藏着一个容易写错的地方：卖单挂在 **i+1**，不是挂在 i。
在 i 卖出等于把刚买到的按原价卖回去，白付两次手续费。

因为每拍都重算，崩溃重启之后只要 holds 表还在，引擎自己就会把
该挂的单挂回去 —— 不需要一套"恢复到某个中间状态"的逻辑。

--------------------------------------------------------------------------
为什么买单一旦有任何成交就立刻撤掉剩下的
--------------------------------------------------------------------------

一笔部分成交的买单会让「这一格持有一个单位」这句话不再成立：
手里有半格货、盘口上还挂着半格的单。继续等它成交意味着这一格的
单位大小是浮动的，而卖单是按"已经买到的量"挂的 —— 一旦买入量后来又涨了，
就会出现"卖掉的数量超过了为它挂的卖单"，账从此对不上。

所以规则是：**买单只要有成交就撤掉剩余部分，把这个成交量的单位坐实**。
代价是极少数情况下少买了一点；换来的是每一格的数量在成交那一刻就定死，
后面的记账不会漂。
*/

// GridState 是网格的运行状态。
type GridState string

const (
	GridIdle    GridState = "Idle"
	GridRunning GridState = "Running"
	GridStopped GridState = "Stopped"
	GridError   GridState = "Error"
)

// 网格停机的原因。写成常量，前端按原因分支展示，不去比对文案。
const (
	ReasonGridStoppedByUser = "grid_stopped_by_user"
	ReasonGridStopLoss      = "grid_stop_loss"
	ReasonGridTakeProfit    = "grid_take_profit"
	ReasonGridRebalance     = "grid_rebalance"
	// ReasonGridPositionMismatch 表示交易所持仓和成交账本对不上。
	// 杠杆仓位不能带着一本错误的账继续挂单，所以直接停机清仓。
	ReasonGridPositionMismatch = "grid_position_mismatch"
)

// GridConfig 是一条网格的配置。字段与 trading_grids 表一致。
type GridConfig struct {
	ID            int64  `json:"id,omitempty"`
	UserID        int64  `json:"-"`
	ExchangeKeyID int64  `json:"exchangeKeyId"`
	Symbol        string `json:"symbol"`
	Mode          string `json:"mode"`
	// Direction 是 long / short。空值按多头处理（老数据）。
	Direction GridDirection `json:"direction"`
	// Market 是 spot / futures。做空网格必须是 futures。
	Market string `json:"market"`
	// Leverage 只对合约网格有意义。现货恒为 1。
	Leverage    int       `json:"leverage"`
	Lower       float64   `json:"lower"`
	Upper       float64   `json:"upper"`
	Levels      int       `json:"levels"`
	QuoteBudget float64   `json:"quoteBudget"`
	StopPct     float64   `json:"stopPct,omitempty"`
	FeeRate     float64   `json:"feeRate,omitempty"`
	Running     bool      `json:"running"`
	PauseReason string    `json:"pauseReason,omitempty"`
	CreatedAt   time.Time `json:"-"`
}

// Normalize 补齐默认值并规整大小写。与 Config.Normalize 同一个套路：
// 引擎里有些不变量靠它保证，放在构造和每一拍上，调用方绕不过去。
func (c GridConfig) Normalize() GridConfig {
	c.Symbol = strings.ToUpper(strings.TrimSpace(c.Symbol))
	c.Mode = strings.ToLower(strings.TrimSpace(c.Mode))
	c.Direction = NormalizeDirection(c.Direction)
	c.Market = NormalizeGridMarket(c.Market)
	// 做空必须有合约；反过来，现货网格没有杠杆可言。
	if c.Direction.Short() {
		c.Market = GridMarketFutures
	}
	if c.Market != GridMarketFutures {
		c.Leverage = 1
	}
	if c.Leverage < 1 {
		c.Leverage = 1
	}
	if c.Leverage > MaxLeverage {
		c.Leverage = MaxLeverage
	}
	c.FeeRate = gridFeeRateFor(c.Market, c.FeeRate)
	if !(c.StopPct > 0) || c.StopPct > GridMaxStopPct {
		c.StopPct = GridDefaultStopPct
	}
	return c
}

/*
gridFeeRate 是网格用的单边费率。

**回退值不是 TakerFeeRate。** 那一个是 USDT-M 合约的 taker 费（0.05%），
而网格跑在现货上，币安现货基础档是 **0.1%/边**，正好是它的两倍。
用 0.05% 当回退会让"每格的净收益"系统性多算 0.1 个百分点 ——
而网格的每格收益本来就只有 1~2 个点，这个偏差足以把一份亏损的网格
在界面上显示成盈利的。

真实费率由接口层在建网格时从 /api/v3/account 读出来存进配置，
这里只负责在拿不到时给一个不乐观的默认值。
*/
func gridFeeRate(v float64) float64 {
	if !(v > 0) || v > 0.01 {
		return SpotDefaultFeeRate
	}
	return v
}

// GridRules 是网格需要知道的交易对规则。
type GridRules struct {
	BaseAsset   string  `json:"baseAsset"`
	QuoteAsset  string  `json:"quoteAsset"`
	StepSize    float64 `json:"stepSize"`
	MinQty      float64 `json:"minQty"`
	TickSize    float64 `json:"tickSize"`
	MinNotional float64 `json:"minNotional"`
}

// GridTrade 是一笔成交（来自 /api/v3/myTrades）。
//
// 必须用它而不是订单回执：订单只给"累计成交额"，拿不到手续费收在哪个币种里。
// 币安现货买入时手续费从**基础币**里扣、卖出时从**计价币**里扣（或用 BNB 抵扣），
// 所以"成交了多少"和"到账了多少"不是同一个数 —— 差的就是手续费。
type GridTrade struct {
	Price           float64
	Qty             float64
	QuoteQty        float64
	Commission      float64
	CommissionAsset string
	At              time.Time
}

// GridFill 是一笔已经落账的网格成交。
type GridFill struct {
	ID       int64    `json:"id,omitempty"`
	UserID   int64    `json:"-"`
	GridID   int64    `json:"gridId,omitempty"`
	Symbol   string   `json:"symbol"`
	Level    int      `json:"level"`
	Side     SpotSide `json:"side"`
	Price    float64  `json:"price"`
	Qty      float64  `json:"qty"`
	Quote    float64  `json:"quote"`
	FeeQuote float64  `json:"feeQuote"`
	// Realized 是这笔成交带来的已实现盈亏（计价币），买入时恒为 0。
	Realized   float64   `json:"realizedUsdt"`
	OrderID    int64     `json:"orderId,omitempty"`
	ClientID   string    `json:"clientOrderId,omitempty"`
	FilledAt   time.Time `json:"filledAt"`
	FillSource string    `json:"fillSource,omitempty"`
}

// GridFillLog 保存网格成交。内存实现只活在本进程；数据库实现负责重启后的历史。
//
// Holdings 是重启后的关键：每一格还持有多少，从成交历史里累加出来。
// 让它成为唯一来源，就不存在"内存状态和数据库谁说了算"的问题。
type GridFillLog interface {
	Save(GridFill) (int64, error)
	List(gridID int64, limit int) ([]GridFill, error)
	// Holdings 按方向还原每一格还没平掉的量。多头是"买入加、卖出减上一格"，
	// 空头是"卖出加、买入减下一格" —— 两个方向减的都不是自己那一格。
	Holdings(gridID int64, direction GridDirection) (map[int]float64, error)
	Summary(gridID int64) (fills int, realized float64, err error)
}

/*
GridExchange 是网格和交易所之间的边界。

方法与趋势引擎的 Exchange 刻意不重名：一个是市价开平仓，一个是挂限价单，
在同一个类型上放两套同名方法，迟早会有人把网格的单发到趋势的路径上。
*/
type GridExchange interface {
	// PlaceLimit 挂一张只做 maker 的限价单。
	PlaceLimit(symbol string, side SpotSide, qty, price float64, clientID string) (SpotOrderState, error)
	// OpenOrders 列出该交易对当前挂在盘口上的单。
	OpenOrders(symbol string) ([]SpotOrderState, error)
	// QueryOrder 按客户单号查一张单的最终状态。
	QueryOrder(symbol, clientID string) (SpotOrderState, error)
	// Cancel 按客户单号撤单。单不存在算成功。
	Cancel(symbol, clientID string) error
	// Trades 读某张单的成交明细，用来拿真实手续费。
	Trades(symbol string, orderID int64) ([]GridTrade, error)
	// MarketSell 市价卖掉指定数量，用于多头止损/上沿止盈清仓。
	MarketSell(symbol string, qty float64, clientID string) (SpotOrderState, error)
	// BaseQty 读基础币的余额（free + locked）。清仓时以它为准。
	BaseQty(symbol string) (float64, error)
	// PositionQty 读网格当前**持有的数量**（取绝对值）：多头是基础币余额，
	// 空头是合约持仓量。两个方向都用它来定清仓数量。
	PositionQty(symbol string) (float64, error)
	// MarketClose 以市价了结持仓：多头卖出基础币，空头买回合约。
	MarketClose(symbol string, qty float64, clientID string) (SpotOrderState, error)
	// Rules 读交易对规则。
	Rules(symbol string) (GridRules, error)
	// LastPrice 读最新成交价。调度器在建引擎之前就要用它来算计划，
	// 所以它是这条边界的一部分，而不是某个实现私有的能力。
	LastPrice(symbol string) (float64, error)
	// UseCredentials 装填密钥。网格的每一拍都要读挂单、读成交，
	// 全部是签名请求，所以密钥得在引擎跑起来之前就装好。
	UseCredentials(creds Credentials) error
	// CommissionRate 读账户的单边费率。0 表示读不到，调用方用兜底值。
	//
	// 它是这条边界的一部分而不是某个实现私有：网格的每格收益 =
	// 间距 − 双边手续费，费率读错一位，一份实际亏损的网格会被算成盈利的。
	CommissionRate() float64
}

/*
GridProtector 是合约网格的**交易所侧保护单**。

为什么必须有它：网格的止损平时靠引擎每一拍判断 outOfRange 再市价平仓。
进程被杀、机器重启、网络断了 —— 这些时候引擎不在，止损也就不在。
杠杆仓位不能只有软件止损，所以合约网格在 Start 之后的第一拍就要在交易所
挂一张 closePosition 的 STOP_MARKET，并在停机时撤掉。

现货网格不实现这个接口：现货没有强平，最坏结果是拿着币。
*/
type GridProtector interface {
	// EnsureProtectionStop 保证交易所上有一张触发价等于 trigger 的
	// 全平保护单。已存在且价格一致时是幂等的。
	EnsureProtectionStop(symbol string, trigger float64, clientID string) error
	// CancelProtectionStops 撤掉该交易对上的全部条件单。
	CancelProtectionStops(symbol string) error
}

// gridHold 是某一格上已经买到、还没卖掉的一份。
type gridHold struct {
	Qty   float64
	Price float64 // 买入均价（含手续费摊薄前的成交价）
}

// gridResting 是一张已经挂出去、还在盘口上的单。
type gridResting struct {
	Level   int
	Side    SpotSide
	Price   float64
	Qty     float64
	Client  string
	OrderID int64
	At      time.Time
}

// GridSnapshot 是网格对外的运行状态。
type GridSnapshot struct {
	ID        int64     `json:"id,omitempty"`
	Symbol    string    `json:"symbol"`
	State     GridState `json:"state"`
	Running   bool      `json:"running"`
	Mode      string    `json:"mode"`
	Lower     float64   `json:"lower"`
	Upper     float64   `json:"upper"`
	Levels    int       `json:"levels"`
	Spacing   float64   `json:"spacingPct"`
	StopPrice float64   `json:"stopPrice"`
	// TakeProfitPrice 是多头走完上沿 / 空头跌破下沿的那个价。
	TakeProfitPrice float64 `json:"takeProfitPrice"`
	Direction       string  `json:"direction"`
	Market          string  `json:"market"`
	Leverage        int     `json:"leverage"`
	LastPrice       float64 `json:"lastPrice,omitempty"`
	// QtyPerLevel / NotionalPerLevel 是每一格的规模，界面靠它解释"每天赚多少"。
	QtyPerLevel       float64 `json:"qtyPerLevel"`
	NotionalPerLevel  float64 `json:"notionalPerLevel"`
	NetProfitPct      float64 `json:"netProfitPct"`
	NetProfitPerLevel float64 `json:"netProfitPerLevel"`
	QuoteNeeded       float64 `json:"quoteNeeded"`
	WorstLossUSDT     float64 `json:"worstLossUsdt"`
	// InventoryQty / InventoryCost 是手里还压着的货，以及它的成本。
	InventoryQty  float64 `json:"inventoryQty"`
	InventoryCost float64 `json:"inventoryCost"`
	// DustQty 是卖单取整之后卖不掉的零头（小于一个步长）。
	// 它是真实资产，但只能靠币安的小额兑换处理，这里只如实报出来。
	DustQty float64 `json:"dustQty"`
	// Buys / Sells / RoundTrips 分别是买入笔数、卖出笔数、完成的往返次数。
	Buys       int `json:"buys"`
	Sells      int `json:"sells"`
	RoundTrips int `json:"roundTrips"`
	// RealizedUSDT 是已落袋的净盈亏（扣手续费）。Unrealized 是持仓浮动盈亏。
	RealizedUSDT   float64 `json:"realizedUsdt"`
	UnrealizedUSDT float64 `json:"unrealizedUsdt"`
	// Resting 是当前挂着的单，按价格从低到高。
	Resting []GridRestingView `json:"resting"`
	// LevelsView 是每条网格线的状态，界面用它画那张格子图。
	LevelsView []GridLevelView `json:"lines"`
	LastAction string          `json:"lastAction,omitempty"`
	LastReason string          `json:"lastReason,omitempty"`
	LastError  string          `json:"lastError,omitempty"`
	// PlaceFailed 记下这一拍因为穿价（LIMIT_MAKER 被拒）而没挂上的格数。
	// 它不是错误，是行情跑得比轮询快 —— 但持续很大就说明轮询太慢了。
	PlaceFailed int `json:"placeFailed"`
}

// GridRestingView 是一张挂单在界面上的样子。
type GridRestingView struct {
	Level int       `json:"level"`
	Side  SpotSide  `json:"side"`
	Price float64   `json:"price"`
	Qty   float64   `json:"qty"`
	At    time.Time `json:"at"`
}

// GridLevelView 是一条网格线的状态。
//
// State 只有三种，取的就是引擎里的三种真实情况：
// buy（挂着买单）/ sell（挂着卖单）/ holding（已买到、等卖）/ empty（空着）。
type GridLevelView struct {
	Index int      `json:"index"`
	Price float64  `json:"price"`
	State string   `json:"state"`
	Qty   float64  `json:"qty,omitempty"`
	Side  SpotSide `json:"side,omitempty"`
}

// 网格线在界面上的状态。
const (
	GridLineEmpty   = "empty"
	GridLineBuy     = "buy"
	GridLineSell    = "sell"
	GridLineHolding = "holding"
)

/*
GridEngine 是一台网格。

调用方一次只推进一个线程（runner 的循环），所以内部锁只用来防 Snapshot
与 Step 并发 —— 与 Engine 同一条约定。
*/
type GridEngine struct {
	mu    sync.Mutex
	cfg   GridConfig
	plan  GridPlan
	ex    GridExchange
	log   Logger
	fills GridFillLog
	// rules 是交易对规则。卖单数量要按步长向下取整、判断零头能不能单独
	// 卖出去，都要用它，所以建引擎时就存下来，不在每拍重新拉。
	rules GridRules

	state     GridState
	reason    string
	lastError string
	running   bool

	holds   map[int]*gridHold
	resting map[int]*gridResting

	realized   float64
	buys       int
	sells      int
	roundTrips int
	costBasis  float64
	qtyHeld    float64
	/*
		dustQty / dustCost 是卖单取整之后卖不掉的零头。

		币安现货的数量必须是 stepSize 的整数倍，而买入到账量不是 ——
		买 14 个 DOGE，手续费以 DOGE 收取之后到手 13.986 个，而 DOGE 的
		步长是 1，所以卖单最多只能挂 13 个。每完成一次往返就会留下
		不到一个步长的零头，它是**真实存在的资产**（币安余额里看得到），
		只是没法单独挂单卖出。

		这些零头不属于任何一格 —— 那一格的单位已经卖掉了。所以它们
		单独记在这里，参与"我总共还有多少货"的计算，但不参与
		"哪一格还持着货"的判断（否则那一格永远空不了，网格就卡死了）。
	*/
	dustQty  float64
	dustCost float64

	lastPrice   float64
	lastAction  string
	lastReason  string
	placeFailed int
	// driftTicks 是"交易所持仓与本地账本不一致"连续出现的拍数。
	// 单拍不一致可能是刚成交还没对上账，连续多拍才停机 —— 见 checkPositionDrift。
	driftTicks int
	stepAt     time.Time
	startedAt  time.Time
	seq        int64
	// closedAtReason 记下停机原因，供 Stop 之后的事件流使用。
	closedReason string
}

/*
BuildGridEngine 建一台网格引擎，并按交易对规则算出计划。

价格从交易所读一次（用最新成交价），因为"哪些线在当前价之下"决定了开局
挂几张买单 —— 而这个判断必须基于真实价格，不能靠调用方随手给一个数。
*/
func BuildGridEngine(cfg GridConfig, price float64, ex GridExchange, fills GridFillLog, logger Logger) (*GridEngine, error) {
	cfg = cfg.Normalize()
	if logger == nil {
		logger = discardLog{}
	}
	if ex == nil {
		return nil, invalid("网格需要交易所客户端")
	}
	if !AllowedSymbol(cfg.Symbol) {
		return nil, invalid("网格只支持 USDT 现货交易对，例如 DOGEUSDT")
	}
	if cfg.Mode != ModeTestnet && cfg.Mode != ModeLive {
		return nil, ErrBadMode
	}
	rules, err := ex.Rules(cfg.Symbol)
	if err != nil {
		return nil, err
	}
	plan, err := BuildGridPlan(GridInput{
		Symbol:      cfg.Symbol,
		Direction:   cfg.Direction,
		Market:      cfg.Market,
		Leverage:    cfg.Leverage,
		Lower:       cfg.Lower,
		Upper:       cfg.Upper,
		Levels:      cfg.Levels,
		QuoteBudget: cfg.QuoteBudget,
		LastPrice:   price,
		FeeRate:     cfg.FeeRate,
		MinNotional: rules.MinNotional,
		StepSize:    rules.StepSize,
		MinQty:      rules.MinQty,
		TickSize:    rules.TickSize,
		StopPct:     cfg.StopPct,
	})
	if err != nil {
		return nil, err
	}
	if fills == nil {
		fills = newMemoryGridFillLog()
	}
	e := &GridEngine{
		cfg:   cfg,
		plan:  plan,
		ex:    ex,
		log:   logger,
		fills: fills,
		rules: rules,
		state: GridIdle,
		// 建引擎时的参考价留着，Start 要用它判断这份区间从现在这个价
		// 起跑得起来 —— 见 Start 里的说明。
		lastPrice: price,
		holds:     map[int]*gridHold{},
		resting:   map[int]*gridResting{},
	}
	if err := e.loadHoldings(); err != nil {
		return nil, err
	}
	return e, nil
}

// loadHoldings 从成交历史里把每一格还持有的数量还原回来。
//
// 重启之后内存里的 holds 是空的，而盘口上可能还挂着卖单 —— 不知道
// 哪些格持有货，就不知道该在哪儿挂卖单。成交历史是唯一的事实来源。
func (g *GridEngine) loadHoldings() error {
	if g == nil || g.cfg.ID <= 0 {
		return nil
	}
	holds, err := g.fills.Holdings(g.cfg.ID, g.cfg.Direction)
	if err != nil {
		return err
	}
	for level, qty := range holds {
		if qty <= 0 || level < 0 || level >= len(g.plan.Lines) {
			continue
		}
		g.holds[level] = &gridHold{Qty: qty, Price: g.plan.Lines[level].Buy}
	}
	if _, realized, err := g.fills.Summary(g.cfg.ID); err == nil {
		g.realized = realized
	}
	g.recount()
	return nil
}

// recount 重算持仓汇总。每一处改动 holds 之后都调用它，
// 免得"手上有多少货"散在好几个地方各算一遍、算法还不一样。
func (g *GridEngine) recount() {
	g.qtyHeld, g.costBasis = g.dustQty, g.dustCost
	for _, h := range g.holds {
		if h == nil || h.Qty <= 0 {
			continue
		}
		g.qtyHeld += h.Qty
		g.costBasis += h.Qty * h.Price
	}
}

/*
sellableQty 把想卖的数量按交易所步长向下取整。

**每一个卖单都必须过这里**，包括纸面撮合的测试路径。哪怕真实交易所
会替我们取整并拒掉不合法的量，本地也要算出同一个数 —— 否则
"卖单数量"和"记账里减掉的数量"会不一致，而那种不一致会以
"余额不足"的形式在下一次挂单时才暴露出来。
*/
func (g *GridEngine) sellableQty(qty float64) float64 {
	return AlignQuantity(qty, g.rules.StepSize, g.rules.MinQty)
}

// closeUnit 关闭第 level 格上的这个单位：卖剩下的零头转入 dust。
func (g *GridEngine) closeUnit(level int) {
	held := g.holds[level]
	if held == nil {
		return
	}
	if held.Qty > 0 {
		g.dustQty += held.Qty
		g.dustCost += held.Qty * held.Price
		g.log.Printf("[grid] %s 第 %d 格卖掉后剩 %g 个零头（小于步长 %g，卖不出去）",
			g.cfg.Symbol, level, held.Qty, g.rules.StepSize)
	}
	delete(g.holds, level)
}

func (g *GridEngine) State() GridState {
	if g == nil {
		return GridIdle
	}
	return g.state
}

// Running 报告网格是否在推进。
func (g *GridEngine) Running() bool { return g != nil && g.running }

// SetExchange 换掉交易所客户端（测试与热更新用）。运行中不允许换。
func (g *GridEngine) SetExchange(ex GridExchange) error {
	if g == nil || ex == nil {
		return invalid("缺少交易所客户端")
	}
	if g.running {
		return ErrConfigLocked
	}
	g.ex = ex
	return nil
}

// Plan 返回算好的网格计划副本。
func (g *GridEngine) Plan() GridPlan { return g.plan }

// Start 让网格开始推进。不在这里挂单 —— 挂单在第一次 Step 里做，
// 这样"启动"和"跑起来"是同一段代码，不会出现只在启动路径上才有的行为。
func (g *GridEngine) Start(now time.Time) error {
	if g == nil {
		return invalid("缺少网格")
	}
	if g.state == GridError {
		return ErrNoAutoReopen
	}
	/*
		价格必须落在区间内，否则这份网格从第一拍起就什么都不做。

		价格在**下沿之下**时，所有网格线都在市价之上，一张买单都挂不出去
		（挂出去就是以高于市价的限价买入）。而现货只能做多，手里也没货
		可卖 —— 于是它会"运行"着，盘口上一张单都没有，界面上看起来
		一切正常。这种静默的空转比直接报错难查得多。

		价格在**上沿之上**同样拦：那种情况会立刻触发上沿止盈，
		等于刚启动就清仓停机，用户会以为网格坏了。
	*/
	if g.lastPrice > 0 && (g.lastPrice <= g.plan.Lower || g.lastPrice >= g.plan.Upper) {
		return withReason(invalid(fmt.Sprintf(
			"当前价 %.8g 不在区间 %g–%g 内，网格起不来（这个区间里一张单都挂不出去）。"+
				"请把区间挪到当前价两侧，或等价格回到区间里再启动",
			g.lastPrice, g.plan.Lower, g.plan.Upper)), ReasonGridPriceOutOfRange)
	}
	g.state = GridRunning
	g.running = true
	g.startedAt = at(now)
	g.note("start", "")
	return nil
}

/*
Stop 停掉网格并清仓。

**默认清仓**，不是"撤单走人"：网格停在一半意味着手里压着货、盘口上
没有对应的卖单 —— 那就是一个没有任何保护的裸露仓位。用户说"停"的时候
想要的是"别动了，把我的钱拿回来"，而不是"把钱换成一堆币放着"。

清仓用市价单：止损/上沿止盈的时刻行情在快速移动，挂限价单很可能挂不上，
而那时我们最不需要的就是"再等一拍"。
*/
func (g *GridEngine) Stop(now time.Time, reason string) error {
	if g == nil {
		return nil
	}
	if reason == "" {
		reason = ReasonGridStoppedByUser
	}
	g.running = false
	if err := g.cancelAll(now); err != nil {
		g.log.Printf("[grid] %s 停机撤单失败: %v", g.cfg.Symbol, err)
	}
	if err := g.flatten(now, reason); err != nil {
		g.state = GridError
		g.lastError = err.Error()
		g.note("stop_failed", reason)
		return err
	}
	/*
		清仓成功之后撤掉交易所侧保护单。

		顺序不能反：先撤保护再平仓，中间那段时间仓位是裸的；
		而平仓失败时保留保护单，至少还有一张止损在交易所上。
	*/
	if prot, ok := g.ex.(GridProtector); ok && g.cfg.Market == GridMarketFutures {
		if cerr := prot.CancelProtectionStops(g.cfg.Symbol); cerr != nil {
			g.log.Printf("[grid] %s 撤掉保护单失败（仓位已平，保护单可能残留）: %v", g.cfg.Symbol, cerr)
		}
	}
	g.state = GridStopped
	g.closedReason = reason
	g.note("stop", reason)
	return nil
}

/*
Adopt 认领一条已经在交易所挂了单的网格（进程重启后）。

做法是**先把该交易对的挂单全部撤掉，再按成交历史重建 holds，然后让
下一次 Step 把该挂的单挂回去**。不试图去认每一张挂单属于哪一格 ——
那些单可能是崩溃前最后一次 Step 挂的，而当时的意图已经无从得知。
撤掉重挂最多损失几秒钟的做市时间，换来的是一个能证明正确的状态。
*/
func (g *GridEngine) Adopt(now time.Time) error {
	if g == nil {
		return nil
	}
	if err := g.cancelAll(now); err != nil {
		return err
	}
	if err := g.loadHoldings(); err != nil {
		return err
	}
	g.state = GridRunning
	g.running = true
	if g.startedAt.IsZero() {
		g.startedAt = at(now)
	}
	g.note("adopt", "")
	return nil
}

/*
cancelAll 撤掉该交易对上的全部挂单，并清空本地记账。

撤的是**该交易对的全部挂单**，不只是我们记得的那几张：进程重启后
本地记账是空的，而盘口上留着上一次运行时挂的单。那些单如果不撤，
网格会一边按新计划挂单、一边被旧单搅乱成交，两套数量叠在一起。

代价是这个交易对上手工挂的单也会被撤掉。网格独占一个交易对是它的前提
（见 Hub 的 symbolTaken），页面要写明这一点。
*/
func (g *GridEngine) cancelAll(now time.Time) error {
	if g == nil || g.ex == nil {
		return nil
	}
	open, err := g.ex.OpenOrders(g.cfg.Symbol)
	if err != nil {
		return err
	}
	var firstErr error
	for _, o := range open {
		if o.ClientOrderID == "" {
			continue
		}
		if cerr := g.ex.Cancel(g.cfg.Symbol, o.ClientOrderID); cerr != nil {
			if firstErr == nil {
				firstErr = cerr
			}
			g.log.Printf("[grid] %s 撤单 %s 失败: %v", g.cfg.Symbol, o.ClientOrderID, cerr)
			continue
		}
		g.log.Printf("[grid] %s 撤单 %s %s %g@%g", g.cfg.Symbol, o.ClientOrderID, o.Side, o.OrigQty, o.Price)
	}
	g.resting = map[int]*gridResting{}
	return firstErr
}

// flatten 以市价了结全部持仓：多头卖出基础币，空头买回合约。
func (g *GridEngine) flatten(now time.Time, reason string) error {
	if g == nil || g.ex == nil {
		return nil
	}
	qty, err := g.ex.PositionQty(g.cfg.Symbol)
	if err != nil {
		return err
	}
	rules, rerr := g.ex.Rules(g.cfg.Symbol)
	if rerr == nil {
		qty = AlignQuantity(qty, rules.StepSize, rules.MinQty)
	}
	if qty <= 0 {
		g.clearHolds()
		return nil
	}
	state, err := g.ex.MarketClose(g.cfg.Symbol, qty, g.clientID("flat"))
	if err != nil {
		return err
	}
	econ := g.orderEconomics(state, g.lastPrice)
	if econ.Qty <= 0 {
		econ.Qty = qty
	}
	if econ.Price <= 0 {
		econ.Price = g.lastPrice
	}
	/*
		清仓这一笔的已实现盈亏按**平均成本**算，逐格扣减。

		不按"每格的买入价"逐格配对：清仓时手里可能同时持有多格的货，
		而市价卖出是一笔成交、一个价格，没法知道哪一份对应哪一格。
		平均成本法给出的是同一个总数，而且不依赖配对顺序 —— 对账时
		能跟币安的余额对得上。
	*/
	avgCost := 0.0
	if g.qtyHeld > 0 {
		avgCost = g.costBasis / g.qtyHeld
	}
	realized, _ := g.realizeAgainstCost(econ.Qty, econ.Price, econ.FeeQuote)
	g.realized += realized
	g.clearHolds()
	/*
		卖完之后账户里剩下的，就是**卖不掉的零头**（小于一个步长）。

		clearHolds 会把它一并清掉，但它是真实存在的资产 —— 币安余额里
		看得到，只是挂不出一张合法的卖单。把它如实记回来，用户才不会
		看到"已清仓"却在账户里发现还有货。
	*/
	if left, lerr := g.ex.PositionQty(g.cfg.Symbol); lerr == nil && left > 0 {
		g.dustQty = left
		g.dustCost = left * avgCost
		g.qtyHeld, g.costBasis = left, left*avgCost
		if g.cfg.Market == GridMarketFutures {
			g.log.Printf("[grid] %s 清仓后仍有 %g 张合约持仓未平（不是零头）：请检查", g.cfg.Symbol, left)
		}
	}
	if _, err := g.fills.Save(GridFill{
		UserID:   g.cfg.UserID,
		GridID:   g.cfg.ID,
		Symbol:   g.cfg.Symbol,
		Level:    -1, // -1 表示清仓单，不属于任何一格
		Side:     g.cfg.Direction.CloseSide(),
		Price:    econ.Price,
		Qty:      econ.Qty,
		Quote:    econ.GrossQuote,
		FeeQuote: econ.FeeQuote,
		Realized: realized,
		OrderID:  state.OrderID,
		ClientID: state.ClientOrderID,
		FilledAt: fillTime(state, now),
	}); err != nil {
		g.log.Printf("[grid] %s 清仓成交落库失败（内存已记，重启后会少这一笔）: %v", g.cfg.Symbol, err)
	}
	if g.cfg.Direction.Short() {
		g.buys++
	} else {
		g.sells++
	}
	g.note("flatten", reason)
	g.log.Printf("[grid] %s 清仓 %g@%g 已实现 %.6f reason=%s", g.cfg.Symbol, econ.Qty, econ.Price, realized, reason)
	return nil
}

/*
realizeAgainstCost 按平均成本扣掉卖出的那一份，返回（已实现盈亏, 卖出后剩余数量）。

平均成本 = 成本总额 / 持有总量。卖出一部分就按这个比例把成本也带走，
剩下的成本继续挂在剩余持仓上。这是标准做法，也是唯一能在
"一笔卖出对应多格持仓"时给出确定答案的做法。
*/
func (g *GridEngine) realizeAgainstCost(qty, price, fee float64) (realized, remaining float64) {
	if qty <= 0 || price <= 0 {
		return 0, g.qtyHeld
	}
	if g.qtyHeld <= 0 {
		/*
			账上没有持仓却发生了平仓成交 —— 这是**账本外**的仓位：
			手工开的、别的策略开的，或者成交历史缺失。

			既不假装它有成本，也不凭空记一笔盈亏：把整笔平仓金额
			记成亏损（空头）或盈利（多头），会让界面上出现一笔
			与网格完全无关的巨额已实现。真实盈亏只有那个外部仓位
			的主人知道，网格不该替它记账。只记 0，并把这件事说清楚。
		*/
		g.log.Printf("[grid] %s 平掉了账本外的 %g@%g（外部仓位或缺失的成交历史），不计已实现",
			g.cfg.Symbol, qty, price)
		return 0, 0
	}
	avg := g.costBasis / g.qtyHeld
	sold := qty
	if sold > g.qtyHeld {
		sold = g.qtyHeld
	}
	if g.cfg.Direction.Short() {
		// 买回平空：付出 qty*price+fee，冲抵 sold*avg 的入账成本。
		realized = sold*avg - (qty*price+fee)*(sold/qty)
	} else {
		proceeds := qty*price - fee
		realized = proceeds*(sold/qty) - sold*avg
	}
	remaining = g.qtyHeld - sold
	return realized, remaining
}

func (g *GridEngine) clearHolds() {
	g.holds = map[int]*gridHold{}
	g.dustQty, g.dustCost = 0, 0
	g.qtyHeld, g.costBasis = 0, 0
}

// clientID 生成这一台引擎专属的客户单号。币安只接受 [.A-Za-z0-9_-]，最长 36。
func (g *GridEngine) clientID(tag string) string {
	g.seq++
	return fmt.Sprintf("oo-g%d-%s-%d", g.cfg.ID, tag, g.seq)
}

// Step 推进一次网格。一次调用里完成：读盘口 → 认成交 → 补挂 → 判断出界。
func (g *GridEngine) Step(now time.Time, price float64) (GridSnapshot, error) {
	if g == nil {
		return GridSnapshot{}, invalid("缺少网格")
	}
	g.stepAt = at(now)
	g.placeFailed = 0
	if !g.running || g.state != GridRunning {
		return g.snapshot(), ErrNotRunning
	}
	if price > 0 {
		g.lastPrice = price
	}
	if g.lastPrice <= 0 {
		return g.snapshot(), invalid("读不到行情价格，网格无法判断该在哪一格挂单")
	}

	// 1. 认成交。这一步必须在补挂之前：不知道哪些格已经买到了，
	//    就会在已经持有的格上再挂一张买单。
	if err := g.reconcile(); err != nil {
		g.note("reconcile_failed", err.Error())
		g.lastError = err.Error()
		return g.snapshot(), err
	}

	// 2. 出界判定。放在补挂之前 —— 已经该走了，就不该再往盘口上挂新单。
	if reason, out := g.outOfRange(g.lastPrice); out {
		g.log.Printf("[grid] %s 价格 %g 出界（%g–%g），清仓停机 reason=%s",
			g.cfg.Symbol, g.lastPrice, g.plan.Lower, g.plan.Upper, reason)
		if err := g.Stop(now, reason); err != nil {
			return g.snapshot(), err
		}
		g.closedReason = reason
		g.note("exit", reason)
		return g.snapshot(), nil
	}

	/*
		2.5 合约网格：对一次持仓账。

		交易所持仓和成交账本必须一致。不一致意味着有我们不知道的事情
		发生了（没认到的成交、强平、人工下单），继续按本地账挂单
		就是在错误的数字上做决定。连续三拍对不上就停机清仓。
	*/
	if g.cfg.Market == GridMarketFutures {
		stopped, derr := g.checkPositionDrift(now)
		if derr != nil {
			g.note("drift_failed", derr.Error())
			g.lastError = derr.Error()
			return g.snapshot(), derr
		}
		if stopped {
			return g.snapshot(), nil
		}
		/*
			漂移还没确认（第 1、2 拍）时**这一拍不挂任何新单**。

			如果交易所已经没仓位、本地还以为有，rebalance 会按"平仓"
			挂一张买单 —— 在空仓上那张买单就是开多。等确认或恢复再挂，
			最多错过几秒行情，换的是不会在错误的账上建仓。
		*/
		if g.driftTicks > 0 {
			g.note("drift_wait", "持仓与账本暂不一致，本拍不挂单")
			return g.snapshot(), nil
		}
	}

	/*
		3. 合约网格：保证交易所上有一张全平止损。

		放在补挂之前：如果保护单挂不上（权限不够、参数被拒），就不该
		继续往盘口上铺网格单 —— 杠杆仓位先有安全网，再谈赚价差。
	*/
	if prot, ok := g.ex.(GridProtector); ok && g.cfg.Market == GridMarketFutures {
		if err := prot.EnsureProtectionStop(g.cfg.Symbol, g.plan.StopPrice, g.clientID("prot")); err != nil {
			g.note("protect_failed", err.Error())
			g.lastError = err.Error()
			return g.snapshot(), err
		}
	}

	// 4. 按当前持仓重算该挂什么，补齐差额。
	if err := g.rebalance(now); err != nil {
		g.note("rebalance_failed", err.Error())
		g.lastError = err.Error()
		return g.snapshot(), err
	}
	g.lastError = ""
	return g.snapshot(), nil
}

/*
outOfRange 判断是否该离场。

两个边界对应两种完全不同的结局，所以原因要分开写：

	· 跌破止损价 —— 亏着走。下沿是接货区，跌破它再跌 StopPct 说明
	  行情不是震荡而是单边下跌，网格的假设已经不成立；
	· 涨过上沿 —— 赚着走。区间走完了，手里的货在往上的过程中已经一格一格
	  卖光，这时候停机就是把利润落袋。

上沿这一条**不设条件**：价格到了区间顶，网格已经没有可以挂的卖单了，
继续留着只会让钱趴在账上不干活。
*/
func (g *GridEngine) outOfRange(price float64) (string, bool) {
	if price <= 0 {
		return "", false
	}
	if g.cfg.Direction.Short() {
		// 空头的两个边界是镜像的：向上破止损，向下跌破下沿止盈。
		if g.plan.StopPrice > 0 && price >= g.plan.StopPrice {
			return ReasonGridStopLoss, true
		}
		if g.plan.TakeProfitPrice > 0 && price <= g.plan.TakeProfitPrice {
			return ReasonGridTakeProfit, true
		}
		return "", false
	}
	if g.plan.StopPrice > 0 && price <= g.plan.StopPrice {
		return ReasonGridStopLoss, true
	}
	if g.plan.Upper > 0 && price >= g.plan.Upper {
		return ReasonGridTakeProfit, true
	}
	return "", false
}

// gridDriftTicks 是持仓不一致持续多少拍才停机。留两拍缓冲：
// 刚成交、回执还没返回时本地账会短暂落后，网络抖动也不该直接停机。
const gridDriftTicks = 3

/*
checkPositionDrift 对一次合约持仓的账。

**交易所是唯一事实来源。** 本地账本由成交回执重建，而回执可能丢、
网络可能断；强平和人工下单则完全不在账本里。任何一种情况都会让
本地 qtyHeld 和交易所持仓分叉，而在分叉的账上继续挂单，等于用
错误的库存做决定 —— 对杠杆网格这是不能接受的。

读不到持仓（网络失败）不算漂移：那只会让下一拍再试一次，
而不是把一条正常的网格误停。
*/
func (g *GridEngine) checkPositionDrift(now time.Time) (stopped bool, err error) {
	if g == nil || g.ex == nil {
		return false, nil
	}
	pos, perr := g.ex.PositionQty(g.cfg.Symbol)
	if perr != nil {
		return false, nil
	}
	tolerance := g.rules.StepSize
	if !(tolerance > 0) {
		tolerance = 1e-9
	}
	if math.Abs(pos-g.qtyHeld) <= tolerance+1e-9 {
		g.driftTicks = 0
		return false, nil
	}
	g.driftTicks++
	g.log.Printf("[grid] %s 持仓不一致：交易所 %.8g / 本地 %.8g（第 %d 拍）",
		g.cfg.Symbol, pos, g.qtyHeld, g.driftTicks)
	if g.driftTicks < gridDriftTicks {
		return false, nil
	}
	g.log.Printf("[grid] %s 持仓连续 %d 拍不一致，停机清仓", g.cfg.Symbol, g.driftTicks)
	if serr := g.Stop(now, ReasonGridPositionMismatch); serr != nil {
		return false, serr
	}
	g.driftTicks = 0
	return true, nil
}

/*
reconcile 把本地记账和交易所的盘口对齐。

流程刻意是「先取盘口，再逐张核对」，而不是「本地有一张单就假定它还在」：

 1. 拉一次该交易对的挂单列表；
 2. 本地记着、列表里没有的，逐张查它的最终状态 ——
    成交了 / 被撤了 / 过期了，**只有查了才知道**。猜错的方向只有一个
    （把成交当成没成交），后果是重复挂单、重复建仓；
 3. 列表里有、本地却没记着的（手工挂的、上一轮留下的）也撤掉 ——
    网格独占一个交易对，混进来的单会打乱每一格的数量。
*/
func (g *GridEngine) reconcile() error {
	open, err := g.ex.OpenOrders(g.cfg.Symbol)
	if err != nil {
		return err
	}
	live := make(map[string]SpotOrderState, len(open))
	for _, o := range open {
		if o.ClientOrderID != "" {
			live[o.ClientOrderID] = o
		}
	}
	// 不认识却挂在盘口上的单：撤掉。
	for _, o := range open {
		if o.ClientOrderID == "" {
			continue
		}
		if _, known := g.restingByClient(o.ClientOrderID); known {
			continue
		}
		if cerr := g.ex.Cancel(g.cfg.Symbol, o.ClientOrderID); cerr != nil {
			g.log.Printf("[grid] %s 撤掉外来挂单 %s 失败: %v", g.cfg.Symbol, o.ClientOrderID, cerr)
			continue
		}
		g.log.Printf("[grid] %s 撤掉外来挂单 %s %s %g@%g", g.cfg.Symbol, o.ClientOrderID, o.Side, o.OrigQty, o.Price)
	}

	// 本地记着、盘口上不在的：查最终状态。
	for _, rest := range g.restingList() {
		if state, still := live[rest.Client]; still {
			// 还在盘口上。部分成交的话按已成交部分入账，其余撤掉
			//（见文件头：成交那一刻就把这一格的数量坐实）。
			if state.ExecutedQty > 0 {
				if err := g.absorbPartial(rest, state); err != nil {
					return err
				}
			}
			continue
		}
		final, err := g.ex.QueryOrder(g.cfg.Symbol, rest.Client)
		if err != nil {
			/*
				查不到不等于没成交。网络抖一下也查不到 —— 而这两种情况
				在本地看起来一模一样。所以这里**不清掉本地记账**：
				保持原样，下一拍再查。宁可多查几次，也不能把一次
				网络故障当成"这单没了"，那会让我们把已成交的仓位
				当成没持有。
			*/
			g.log.Printf("[grid] %s 查单 %s 失败，下一拍重试: %v", g.cfg.Symbol, rest.Client, err)
			continue
		}
		if err := g.settle(rest, final); err != nil {
			return err
		}
	}
	return nil
}

func (g *GridEngine) restingByClient(client string) (*gridResting, bool) {
	for _, r := range g.resting {
		if r != nil && r.Client == client {
			return r, true
		}
	}
	return nil, false
}

// restingList 返回当前挂单，按线号排序 —— 顺序稳定，日志和测试才好读。
func (g *GridEngine) restingList() []*gridResting {
	out := make([]*gridResting, 0, len(g.resting))
	for _, r := range g.resting {
		if r != nil {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Level < out[j].Level })
	return out
}

/*
settle 处理一张已经有最终状态的单。

三种结局都要处理，而且**撤单和过期与成交一样重要**：把它们当成
"没成交、不用管"，本地就会一直以为这一格挂着单，再也不补 ——
盘口上那一格永远空着，网格少一条腿，而界面上看起来一切正常。
*/
func (g *GridEngine) settle(rest *gridResting, final SpotOrderState) error {
	/*
		只有**终态**才能记账并删除挂单记录。

		如果查到的还是 NEW / PARTIALLY_FILLED，说明这张单可能只是暂时
		不在这一拍的 OpenOrders 快照里（撮合与查询之间有延迟），它仍然
		可能继续成交。此时按当前部分成交量入账并删掉记录，后续成交就
		永远丢了 —— 测试网 WIF 空头第二次停机就是这么来的：平仓单在
		撤单竞态里多成交 25.4 张，settle 记了快照量就删了记录，之后
		交易所 613.3 / 本地 638.7，漂移守卫三拍后清仓。

		保留记录，下一拍再查；只要它回到 OpenOrders，就会走
		absorbPartial（先撤单、再按终态入账）。
	*/
	if !gridOrderFinal(final.Status) {
		g.log.Printf("[grid] %s 第 %d 格 %s 单状态 %s 尚未终结，下一拍再核对",
			g.cfg.Symbol, rest.Level, rest.Side, final.Status)
		return nil
	}
	delete(g.resting, rest.Level)
	if final.ExecutedQty > 0 {
		return g.bookFill(rest, final)
	}
	if final.Status == SpotStatusCanceled || final.Status == SpotStatusExpired ||
		final.Status == SpotStatusExpiredInMatch || final.Status == SpotStatusRejected {
		g.log.Printf("[grid] %s 第 %d 格 %s 单%s，下一拍重挂",
			g.cfg.Symbol, rest.Level, rest.Side, final.Status)
	}
	// 终态且零成交（例如刚挂上就被撤）：这一格空着，下一拍按持仓重算。
	return nil
}

/*
absorbPartial 处理还在盘口上、但已经成交了一部分的单。

顺序必须是「先撤单、再查终态、最后入账」，不能反过来：

	state 只是撤单**之前**那一刻的快照。撤单请求发出去到交易所真正把
	单撤掉之间，仍然可能再成交（实盘上常见，测试网也复现了：WIF 空头
	第 9 格快照 201.2，撤单过程中又成交 25.7，本地少记，随后被持仓
	漂移守卫连续三拍抓到，整条网格停机清仓）。

先撤单之后，QueryOrder 返回的是这张单的最终成交量；用它入账一次，
本地持仓就和交易所完全一致。撤单失败或终态还没出来时**不记账、也
不删除挂单记录**，下一拍再核对 —— 宁可多等一拍，也不能在错误的
数量上继续挂单。
*/
func (g *GridEngine) absorbPartial(rest *gridResting, state SpotOrderState) error {
	if cerr := g.ex.Cancel(g.cfg.Symbol, rest.Client); cerr != nil {
		g.log.Printf("[grid] %s 撤掉部分成交单 %s 失败，下一拍重试: %v", g.cfg.Symbol, rest.Client, cerr)
		return nil
	}
	final, ferr := g.ex.QueryOrder(g.cfg.Symbol, rest.Client)
	if ferr != nil {
		g.log.Printf("[grid] %s 部分成交单 %s 撤单后查终态失败，下一拍重试: %v", g.cfg.Symbol, rest.Client, ferr)
		return nil
	}
	if !gridOrderFinal(final.Status) {
		g.log.Printf("[grid] %s 部分成交单 %s 撤单后状态仍为 %s，下一拍再核对", g.cfg.Symbol, rest.Client, final.Status)
		return nil
	}
	if final.ExecutedQty > 0 {
		if err := g.bookFill(rest, final); err != nil {
			return err
		}
	}
	delete(g.resting, rest.Level)
	return nil
}

// gridOrderFinal 判断订单是否已经不会再有成交。
func gridOrderFinal(status string) bool {
	switch status {
	case SpotStatusFilled, SpotStatusCanceled, SpotStatusExpired,
		SpotStatusExpiredInMatch, SpotStatusRejected:
		return true
	}
	return false
}

// gridEconomics 是一张成交单折算出来的账目。用结构体而不是一串返回值：
// 这里面有四个都是金额/数量的 float64，位置写反了编译器不会说话。
type gridEconomics struct {
	// Qty 是**到账数量**（买入时已扣掉以基础币收取的手续费）。
	Qty float64
	// Price 是成交价，不含手续费的摊薄。
	Price float64
	// GrossQuote 是成交总额（未扣手续费），等于 Qty/费率修正前的量 × 成交价。
	GrossQuote float64
	// FeeQuote 是手续费折算成计价币之后的数。
	FeeQuote float64
	At       time.Time
	// Source 是 order 或 trades —— 估算出来的账和真实的账必须能被区分。
	Source string
}

/*
orderEconomics 把一张成交单折算成一份账。

**手续费收在哪个币种上，决定了"到账了多少"和"成交了多少"是不是同一个数。**
币安现货买入时手续费从**基础币**里扣（买 14 个 DOGE，实际到手 13.986 个），
卖出时从**计价币**里扣。订单回执只给"累计成交额"，看不出这件事 ——
直接拿 executedQty 当持仓，手上的货会永远比记录多一点点，
而那个差额会在下一次挂卖单时变成"余额不足"，且很难查。

所以优先读 /api/v3/myTrades（那里有 commission 和 commissionAsset），
读不到时退回订单回执 + 费率估算，并把 Source 标出来 ——
估算出来的账和真实的账必须能被区分，否则对不上账时无从下手。
*/
func (g *GridEngine) orderEconomics(state SpotOrderState, fallbackPrice float64) gridEconomics {
	out := gridEconomics{
		Qty:    state.ExecutedQty,
		Price:  state.AvgPrice(),
		At:     time.UnixMilli(state.UpdateTime),
		Source: "order",
	}
	if out.Price <= 0 {
		out.Price = fallbackPrice
	}
	out.GrossQuote = out.Qty * out.Price

	if state.OrderID > 0 {
		trades, err := g.ex.Trades(g.cfg.Symbol, state.OrderID)
		switch {
		case err != nil:
			g.log.Printf("[grid] %s 读成交明细失败，手续费按费率估: %v", g.cfg.Symbol, err)
		case len(trades) > 0:
			// 同一张单可能被拆着吃。加权平均成一个价、手续费累加 ——
			// 对账要看的是这张单的总效果，不是其中某一笔。
			var grossQty, grossQuote, commission float64
			asset := ""
			latest := out.At
			for _, t := range trades {
				grossQty += t.Qty
				grossQuote += t.QuoteQty
				commission += t.Commission
				if t.CommissionAsset != "" {
					asset = strings.ToUpper(strings.TrimSpace(t.CommissionAsset))
				}
				if t.At.After(latest) {
					latest = t.At
				}
			}
			if grossQty > 0 && grossQuote > 0 {
				asset = strings.ToUpper(strings.TrimSpace(asset))
				out.Price = grossQuote / grossQty
				out.GrossQuote = grossQuote
				out.At = latest
				out.Source = "trades"
				// 手续费收在基础币上时，到账量要先把那部分扣掉。
				if asset == g.baseAsset() && commission > 0 && grossQty-commission > 0 {
					out.Qty = grossQty - commission
					out.FeeQuote = commission * out.Price
					return out
				}
				out.Qty = grossQty
				out.FeeQuote = g.commissionInQuote(commission, asset, out.Price, grossQuote)
				return out
			}
		}
	}
	// 退回订单回执：手续费按费率估，口径最保守。
	if out.Qty <= 0 {
		return out
	}
	out.FeeQuote = out.Qty * out.Price * gridFeeRate(g.cfg.FeeRate)
	return out
}

// baseAsset 从交易对里推出基础币。只支持 <BASE>USDT 这一种形状 ——
// 网格本来就只支持 USDT 现货对（见 BuildGridPlan），所以不需要通用解析。
func (g *GridEngine) baseAsset() string {
	return strings.TrimSuffix(strings.ToUpper(strings.TrimSpace(g.cfg.Symbol)), "USDT")
}

// quoteAsset 是计价币。网格只跑 USDT 对。
func (g *GridEngine) quoteAsset() string { return "USDT" }

/*
bookFill 把一笔成交落进账里。

买入用的是**到账数量**（扣掉以基础币收取的手续费之后的量），
而不是成交数量 —— 见 orderEconomics 的说明。持有一格 13.986 个却
记成 14 个，下一次挂卖单就会被币安以余额不足拒掉，而且这种现象
只在开了手续费抵扣的账户上出现，最难复现。
*/
func (g *GridEngine) bookFill(rest *gridResting, state SpotOrderState) error {
	econ := g.orderEconomics(state, rest.Price)
	if econ.Qty <= 0 || econ.Price <= 0 {
		return nil
	}

	fill := GridFill{
		UserID:     g.cfg.UserID,
		GridID:     g.cfg.ID,
		Symbol:     g.cfg.Symbol,
		Level:      rest.Level,
		Side:       rest.Side,
		Price:      econ.Price,
		Qty:        econ.Qty,
		Quote:      econ.GrossQuote,
		FeeQuote:   econ.FeeQuote,
		OrderID:    state.OrderID,
		ClientID:   rest.Client,
		FilledAt:   fillTime(state, econ.At),
		FillSource: econ.Source,
	}

	openSide := g.cfg.Direction.OpenSide()
	closeSide := g.cfg.Direction.CloseSide()
	switch rest.Side {
	case openSide:
		/*
			开仓：把这一格的持仓坐实，成本价按**含手续费的实际成本**算。

			多头：掏出去的是毛成交额，到手的只有 econ.Qty 个（手续费以
			基础币扣掉），所以单份成本 = grossQuote / 到账数量。
			空头：收到的是毛成交额减去手续费，单份成本 =
			(grossQuote - fee) / 数量 —— 手续费就是这样被摊进成本的。
			若拿成交价当成本，这一格的已实现盈亏会永久性地多算一份手续费。

			取 max(已有, 本次) 而不是累加：同一格理论上只会有一张开仓单，
			但重启认领、重复回执这些情况下累加会凭空多出持仓，
			而「每格一个单位」是这个引擎全部推理的基础，不能被破坏。
		*/
		costPerUnit := econ.Price
		if econ.Qty > 0 && econ.GrossQuote > 0 {
			if g.cfg.Direction.Short() {
				costPerUnit = (econ.GrossQuote - econ.FeeQuote) / econ.Qty
			} else {
				costPerUnit = econ.GrossQuote / econ.Qty
			}
		}
		held := g.holds[rest.Level]
		if held == nil {
			held = &gridHold{}
			g.holds[rest.Level] = held
		}
		if econ.Qty > held.Qty {
			held.Qty = econ.Qty
			held.Price = costPerUnit
		}
		if g.cfg.Direction.Short() {
			g.sells++
		} else {
			g.buys++
		}
		g.note("open", fmt.Sprintf("第 %d 格 %g@%g", rest.Level, econ.Qty, econ.Price))
	case closeSide:
		// 平仓：按平均成本算这一笔的已实现盈亏。手续费从收入里扣
		// （空头是加在买入成本上，见 realizeAgainstCost）。
		realized, _ := g.realizeAgainstCost(econ.Qty, econ.Price, econ.FeeQuote)
		fill.Realized = realized
		g.realized += realized
		if g.cfg.Direction.Short() {
			g.buys++
		} else {
			g.sells++
		}
		g.roundTrips++
		/*
			平掉的是**哪一格**：多头卖单挂在 i+1 上，平的是 holds[i]；
			空头买单挂在 i-1 上，平的是 holds[i]。

			减完之后如果剩下的量已经**平不掉**（小于一个步长），
			就把这个单位关掉，剩下那点零头转入 dust。

			不这么做的后果很具体：剩下的 0.986 个 DOGE 会让第 i 格
			永远处于"已持有"状态，于是永远不再挂买单 —— 那一条网格线
			从此死掉，而界面上它看起来只是"一直持着货"。
		*/
		src := g.cfg.Direction.ClosedLevel(rest.Level)
		if held := g.holds[src]; held != nil {
			held.Qty -= econ.Qty
			if g.sellableQty(held.Qty) <= 0 {
				g.closeUnit(src)
			}
		}
		g.note("close", fmt.Sprintf("第 %d 格 %g@%g", rest.Level, econ.Qty, econ.Price))
	default:
		return invalid("网格成交方向只能是 BUY 或 SELL")
	}
	g.recount()

	if _, err := g.fills.Save(fill); err != nil {
		/*
			落库失败**不回滚内存**：成交已经发生在交易所上了，把内存改回去
			只会让本地和交易所不一致。重启后 loadHoldings 会从库里
			少读到这一笔 —— 所以这里必须留下痕迹，不能吞掉。
		*/
		g.log.Printf("[grid] %s 成交落库失败（内存已记，重启后会少这一笔）: %v", g.cfg.Symbol, err)
		return err
	}
	g.log.Printf("[grid] %s 第 %d 格 %s %g@%g 手续费 %.6f 已实现 %.6f",
		g.cfg.Symbol, rest.Level, rest.Side, econ.Qty, econ.Price, econ.FeeQuote, fill.Realized)
	return nil
}

/*
commissionInQuote 把手续费统一换算成计价币。

三种收法都要能算，因为它们对应三种真实的账户配置：

	· 收计价币（卖出时的默认）—— 直接就是 quote；
	· 收基础币（买入时的默认）—— 按成交价折成 quote；
	· 收第三种币（开了 BNB 抵扣时）—— 我们不知道那一刻 BNB 的价，
	  只能按费率估。**估，不是 0**：把 BNB 抵扣当成免手续费，
	  已实现盈亏会系统性偏乐观。
*/
func (g *GridEngine) commissionInQuote(commission float64, asset string, price, quote float64) float64 {
	if commission <= 0 {
		return 0
	}
	switch strings.ToUpper(strings.TrimSpace(asset)) {
	case "":
		return quote * gridFeeRate(g.cfg.FeeRate)
	case g.quoteAsset():
		return commission
	case g.baseAsset():
		return commission * price
	default:
		return quote * gridFeeRate(g.cfg.FeeRate)
	}
}

// fillTime 用交易所给的时间；它不合理（0 或未来）时退回本地时钟。
func fillTime(state SpotOrderState, at time.Time) time.Time {
	if !at.IsZero() && at.Year() > 2000 && !at.After(time.Now().UTC().Add(time.Hour)) {
		return at.UTC()
	}
	if state.UpdateTime > 0 {
		return time.UnixMilli(state.UpdateTime).UTC()
	}
	return time.Now().UTC()
}

/*
rebalance 按当前持仓重算"应该在哪些格挂什么单"，把差额补齐。

每一拍都从零重算，这是**自愈**的来源：崩溃、漏掉一次轮询、行情跳空，
下一拍都会自动回到正确状态，不需要一套"恢复到某个中间状态"的逻辑。

	持有第 i 格的货  → 在第 i+1 格挂卖单（不是第 i 格！）
	第 i 格没货，且当前价高于第 i 条线 → 在第 i 格挂买单
	最后一条线永远不挂买单 —— 它上面没有线可以卖

一个格子同时被"要挂卖单"和"要挂买单"指着的时候，**卖单优先**：
手里已经有货，把它卖掉是这个网格的全部目的；而那一格的买单会让
同一格既有货又想买货，两件事互相打架。
*/
func (g *GridEngine) rebalance(now time.Time) error {
	want := g.desiredOrders()

	// 先撤掉不再需要的挂单。
	for _, rest := range g.restingList() {
		side, ok := want[rest.Level]
		if ok && side == rest.Side {
			continue
		}
		if err := g.ex.Cancel(g.cfg.Symbol, rest.Client); err != nil {
			g.log.Printf("[grid] %s 撤掉不再需要的挂单 %s 失败: %v", g.cfg.Symbol, rest.Client, err)
			continue
		}
		delete(g.resting, rest.Level)
		g.log.Printf("[grid] %s 撤掉第 %d 格 %s 单（不再需要）", g.cfg.Symbol, rest.Level, rest.Side)
	}

	// 再补齐缺的。线号从小到大 —— 价格下跌时先接住离市价最近的那一格。
	levels := make([]int, 0, len(want))
	for level := range want {
		levels = append(levels, level)
	}
	sort.Ints(levels)
	var firstErr error
	for _, level := range levels {
		if _, ok := g.resting[level]; ok {
			continue
		}
		if err := g.place(now, level, want[level]); err != nil {
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

/*
desiredOrders 算出每一格现在应该挂着什么单。

返回的 map 只包含**该有单**的格；没列进来的格就是"这一拍什么都不挂"。
*/
func (g *GridEngine) desiredOrders() map[int]SpotSide {
	want := map[int]SpotSide{}
	lines := g.plan.Lines
	if g.cfg.Direction.Short() {
		/*
			空头是严格镜像：

			 1. 持着空的格 i，在**下面一格 i-1** 挂买平 —— 在 i 买回等于
			    原价进原价出，白付两次手续费；
			 2. 没持空的格 i，价格在它之下就挂卖开；
			 3. 第 0 格永远不卖 —— 它下面没有线可以买回。
		*/
		for level := 1; level < len(lines); level++ {
			if h := g.holds[level]; h != nil && h.Qty > 0 {
				want[level-1] = SpotBuy
			}
		}
		// 平仓单优先：同一格既能平上一格的空、又能开一张新空时，
		// 先平仓 —— 手里已经有的仓位必须先了结。
		for level := 1; level < len(lines); level++ {
			if _, taken := want[level]; taken {
				continue
			}
			if h := g.holds[level]; h != nil && h.Qty > 0 {
				continue
			}
			if g.lastPrice < lines[level].Buy {
				want[level] = SpotSell
			}
		}
		return want
	}
	// 第一遍：有货的格，在它的上一格挂卖单。
	for level := 0; level < len(lines)-1; level++ {
		if h := g.holds[level]; h != nil && h.Qty > 0 {
			want[level+1] = SpotSell
		}
	}
	// 第二遍：没货的格，价格在它之上就挂买单。卖单已经占住的格跳过。
	for level := 0; level < len(lines)-1; level++ {
		if _, taken := want[level]; taken {
			continue
		}
		if h := g.holds[level]; h != nil && h.Qty > 0 {
			continue
		}
		if g.lastPrice > lines[level].Buy {
			want[level] = SpotBuy
		}
	}
	return want
}

// place 在某一格挂一张单。
func (g *GridEngine) place(now time.Time, level int, side SpotSide) error {
	lines := g.plan.Lines
	if level < 0 || level >= len(lines) {
		return invalid(fmt.Sprintf("网格线号 %d 超出范围", level))
	}
	price, qty := lines[level].Buy, g.plan.QtyPerLevel
	closeSide := g.cfg.Direction.CloseSide()
	if side == closeSide {
		// 平的是**相邻那一格**的持仓（多头 i+1 卖 i 的货，空头 i-1 买回 i 的空），
		// 数量以实际持有为准 —— 按计划数量挂会在部分成交之后平超过持仓，
		// 被交易所拒掉。
		held := g.holds[g.cfg.Direction.ClosedLevel(level)]
		if held == nil || held.Qty <= 0 {
			return nil
		}
		qty = g.sellableQty(held.Qty)
	}
	if qty <= 0 || price <= 0 {
		return nil
	}
	/*
		零头卖不出去时**关掉这个单位**，而不是让挂单失败。

		部分成交之后这一格可能只剩不到一个步长的量：挂不出一张合法卖单
		（数量不够最小名义）。这时如果返回错误，引擎会每一拍都失败一次、
		永远卡在这一格上。正确做法是承认这个零头收不回来了，
		把它转入 dust，让这一格回到"可以重新买入"的状态。
	*/
	if side == closeSide && g.rules.MinNotional > 0 && qty*price < g.rules.MinNotional {
		if g.cfg.Market == GridMarketFutures {
			/*
				合约上的持仓不会因为"数量太小"就消失。把这一格当成已平仓，
				等于把一个真实存在的空头从记账里抹掉 —— 账户上还欠着，
				引擎却以为已经了结。所以这里不丢弃，仍然去下单：
				reduceOnly 的平仓单通常不受最小名义限制，就算被拒也只是
				这一拍失败，下一拍会重试。
			*/
			g.log.Printf("[grid] %s 第 %d 格平仓名义 %.4f 低于交易所最小名义 %.4f，仍尝试平仓（合约不丢仓）",
				g.cfg.Symbol, level, qty*price, g.rules.MinNotional)
		} else {
			g.log.Printf("[grid] %s 第 %d 格的平仓单只有 %g（名义 %.4f），低于交易所下限，转入零头",
				g.cfg.Symbol, level, qty, qty*price)
			g.closeUnit(g.cfg.Direction.ClosedLevel(level))
			g.recount()
			return nil
		}
	}
	client := g.clientID(fmt.Sprintf("L%d", level))
	state, err := g.ex.PlaceLimit(g.cfg.Symbol, side, qty, price, client)
	if err != nil {
		if limitMakerRejected(err) {
			/*
				只做 maker 被拒 = 这张单挂上去会立刻成交。

				这不是故障，是网格的正常分支：行情在两次轮询之间跳过了这一格。
				不记成错误（否则日志会被正常情况刷屏），但计数 ——
				这个数持续偏大说明轮询太慢，格子已经跟不上行情了。
			*/
			g.placeFailed++
			g.log.Printf("[grid] %s 第 %d 格 %s 单穿价跳过（%g）", g.cfg.Symbol, level, side, price)
			return nil
		}
		return err
	}
	rest := &gridResting{
		Level:   level,
		Side:    side,
		Price:   price,
		Qty:     qty,
		Client:  client,
		OrderID: state.OrderID,
		At:      at(now),
	}
	if state.Filled() {
		/*
			挂上去就成交了。

			只做 maker 的单**不应该**立刻成交，但对手方在同一个 tick 里
			吃掉它是可能的。走正常的入账路径，不要假装它还在盘口上 ——
			那样下一拍会去查一张已经成交的单，再入账一次。
		*/
		return g.bookFill(rest, state)
	}
	g.resting[level] = rest
	g.log.Printf("[grid] %s 第 %d 格挂 %s %g@%g", g.cfg.Symbol, level, side, qty, price)
	return nil
}

func (g *GridEngine) note(action, reason string) {
	g.lastAction = action
	g.lastReason = reason
}

// GridQuoteNeeded 是这份计划最坏要占用的计价币。接口层用它跟余额比。
func (g *GridEngine) QuoteNeeded() float64 { return g.plan.QuoteNeeded }

// Snapshot 返回一份当前状态的副本。
func (g *GridEngine) Snapshot() GridSnapshot { return g.snapshot() }

func (g *GridEngine) snapshot() GridSnapshot {
	if g == nil {
		return GridSnapshot{}
	}
	snap := GridSnapshot{
		ID:                g.cfg.ID,
		Symbol:            g.cfg.Symbol,
		State:             g.state,
		Running:           g.running,
		Mode:              g.cfg.Mode,
		Lower:             g.plan.Lower,
		Upper:             g.plan.Upper,
		Levels:            g.plan.Levels,
		Spacing:           g.plan.SpacingPct,
		StopPrice:         g.plan.StopPrice,
		TakeProfitPrice:   g.plan.TakeProfitPrice,
		Direction:         string(g.cfg.Direction),
		Market:            g.cfg.Market,
		Leverage:          g.cfg.Leverage,
		LastPrice:         g.lastPrice,
		QtyPerLevel:       g.plan.QtyPerLevel,
		NotionalPerLevel:  g.plan.NotionalPerLevel,
		NetProfitPct:      g.plan.NetProfitPct,
		NetProfitPerLevel: g.plan.NetProfitPerLevel,
		QuoteNeeded:       g.plan.QuoteNeeded,
		WorstLossUSDT:     g.plan.WorstLossUSDT,
		InventoryQty:      g.qtyHeld,
		InventoryCost:     g.costBasis,
		DustQty:           g.dustQty,
		Buys:              g.buys,
		Sells:             g.sells,
		RoundTrips:        g.roundTrips,
		RealizedUSDT:      g.realized,
		LastAction:        g.lastAction,
		LastReason:        g.lastReason,
		LastError:         g.lastError,
		PlaceFailed:       g.placeFailed,
	}
	if g.qtyHeld > 0 && g.lastPrice > 0 {
		if g.cfg.Direction.Short() {
			// 空头的浮盈 = 入账成本 - 现在买回要花的钱。
			snap.UnrealizedUSDT = g.costBasis - g.qtyHeld*g.lastPrice
		} else {
			snap.UnrealizedUSDT = g.qtyHeld*g.lastPrice - g.costBasis
		}
	}
	for _, rest := range g.restingList() {
		snap.Resting = append(snap.Resting, GridRestingView{
			Level: rest.Level, Side: rest.Side, Price: rest.Price, Qty: rest.Qty, At: rest.At,
		})
	}
	if snap.Resting == nil {
		snap.Resting = []GridRestingView{}
	}
	snap.LevelsView = g.levelViews()
	return snap
}

// levelViews 把每条网格线的状态画出来：空着 / 挂着买单 / 挂着卖单 / 已持有等卖。
func (g *GridEngine) levelViews() []GridLevelView {
	out := make([]GridLevelView, 0, len(g.plan.Lines))
	for i, line := range g.plan.Lines {
		view := GridLevelView{Index: i, Price: line.Buy, State: GridLineEmpty}
		switch {
		case g.resting[i] != nil:
			// 界面上的状态用小写词（buy/sell/holding/empty），
			// 不是币安传回来的大写方向 —— 这几个词前端按字符串分支。
			if g.resting[i].Side == SpotBuy {
				view.State = GridLineBuy
			} else {
				view.State = GridLineSell
			}
			view.Side = g.resting[i].Side
			view.Qty = g.resting[i].Qty
		default:
			if h := g.holds[i]; h != nil && h.Qty > 0 {
				view.State = GridLineHolding
				view.Qty = h.Qty
			}
		}
		out = append(out, view)
	}
	return out
}

// Audit 返回这一台网格的操作痕迹，最新的在前。
func (g *GridEngine) Audit() []string {
	if g == nil {
		return nil
	}
	out := make([]string, 0, 4)
	if g.lastAction != "" {
		out = append(out, g.lastAction+" "+g.lastReason)
	}
	return out
}

// HoldingsView 返回每一格当前持有的数量，界面与对账都用它。
func (g *GridEngine) HoldingsView() map[int]float64 {
	out := map[int]float64{}
	for level, h := range g.holds {
		if h != nil && h.Qty > 0 {
			out[level] = h.Qty
		}
	}
	return out
}

// gridLevelFromClientID 从客户单号里解出线号。认不出来返回 -1。
//
// 只在排查历史挂单时用得上：单号是我们自己造的，格式是
// oo-g<grid>-L<level>-<seq>。解析失败要能明确表示"这不是网格的单"，
// 而不是回 0 —— 0 是一个合法的线号。
func gridLevelFromClientID(client string) int {
	idx := strings.Index(client, "-L")
	if idx < 0 {
		return -1
	}
	rest := client[idx+2:]
	if end := strings.IndexByte(rest, '-'); end >= 0 {
		rest = rest[:end]
	}
	level, err := strconv.Atoi(rest)
	if err != nil || level < 0 {
		return -1
	}
	return level
}

// ErrGridNeedsRebuild 表示这份计划不能再用了（区间或条数变了），必须重建。
var ErrGridNeedsRebuild = errors.New("grid plan must be rebuilt")
