package trading

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

/*
PaperGrid 是网格引擎的内存撮合，不碰网络。

存在的理由和 Paper 一样：网格引擎里真正容易错的是**状态推进**——
"买单成交之后卖单挂到哪一格""部分成交之后这一格的数量算多少""撤单之后
下一拍会不会补回来"。这些错误在真实交易所上要等行情配合才复现，
而在内存里可以把价格路径一行行写出来，每一步都断言。

撮合规则刻意做成**最保守**的一种：

  · 限价单只有在价格**穿过**它时才成交，成交价就是挂单价
    （真实盘口上 maker 单还可能成交在更好的价位，这里不给这个便宜）；
  · 会立即成交的限价单直接拒绝（-2010），与币安的 LIMIT_MAKER 行为一致；
  · 市价单按当前价成交，并扣滑点。

保守的意义是：在这个撮合下算出来的收益是**下界**。真实成交只会更好，
不会更差 —— 所以拿它来验证"这个网格赚不赚钱"是安全的。
*/

// PaperGrid 是一台内存现货交易所。
type PaperGrid struct {
	mu sync.Mutex

	rules GridRules
	fee   float64 // 单边费率
	// slippage 是市价单的滑点比例，单向（买入付更多、卖出收更少）。
	slippage float64

	price float64

	base  float64 // 基础币余额
	quote float64 // 计价币余额

	open      map[string]*paperGridOrder
	trades    map[int64][]GridTrade
	orderSeen map[int64]SpotOrderState
	seq       int64

	// rejectPlace / rejectQuery 分别让下一次挂单、下一次查单失败。
	// **刻意分成两个**：引擎每一拍都会先 reconcile（查单）再补挂，
	// 共用一个钩子的话，想测"挂单失败"却会被查单先把钩子吃掉 ——
	// 测试会"通过"，但什么都没验证。
	rejectPlace error
	rejectQuery error
	// placed 记下每一张挂出去的单，测试用它断言"挂了哪几格"。
	placed []paperPlacement
	// cancelled 记下被撤掉的客户单号。
	cancelled []string
	// clock 是成交时间戳的来源。测试可以钉死它。
	clock func() time.Time
	// filledOnPlace 为真时，挂单当场成交（见 SettleFilledOnPlace）。
	filledOnPlace bool
}

type paperGridOrder struct {
	state SpotOrderState
	at    time.Time
}

// paperPlacement 是一张已经挂出去的单，测试用它断言网格的意图。
type paperPlacement struct {
	Level  int
	Side   SpotSide
	Price  float64
	Qty    float64
	Client string
}

// NewPaperGrid 建一台内存现货交易所。
func NewPaperGrid(rules GridRules, price, quote float64) *PaperGrid {
	if rules.StepSize <= 0 {
		rules.StepSize = 1e-8
	}
	if rules.TickSize <= 0 {
		rules.TickSize = 1e-8
	}
	if rules.MinNotional <= 0 {
		rules.MinNotional = MinNotionalUSDT
	}
	if rules.BaseAsset == "" {
		rules.BaseAsset = "DOGE"
	}
	if rules.QuoteAsset == "" {
		rules.QuoteAsset = "USDT"
	}
	return &PaperGrid{
		rules:     rules,
		fee:       TakerFeeRate,
		price:     price,
		quote:     quote,
		open:      map[string]*paperGridOrder{},
		trades:    map[int64][]GridTrade{},
		orderSeen: map[int64]SpotOrderState{},
		clock:     func() time.Time { return time.Now().UTC() },
	}
}

// SetFee 换掉单边费率（默认 0.1%）。
func (p *PaperGrid) SetFee(v float64) {
	p.mu.Lock()
	p.fee = v
	p.mu.Unlock()
}

// SetClock 换掉成交时间戳的来源。
func (p *PaperGrid) SetClock(fn func() time.Time) {
	if fn == nil {
		return
	}
	p.mu.Lock()
	p.clock = fn
	p.mu.Unlock()
}

// SetBalance 直接设定余额，用来测"钱不够"这类路径。
func (p *PaperGrid) SetBalance(base, quote float64) {
	p.mu.Lock()
	p.base, p.quote = base, quote
	p.mu.Unlock()
}

// Balances 返回当前余额。
func (p *PaperGrid) Balances() (base, quote float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.base, p.quote
}

// RejectNextPlace 让下一次挂单以给定错误被拒。传 nil 取消。
func (p *PaperGrid) RejectNextPlace(err error) {
	p.mu.Lock()
	p.rejectPlace = err
	p.mu.Unlock()
}

// RejectNextQuery 让下一次查单以给定错误失败。传 nil 取消。
func (p *PaperGrid) RejectNextQuery(err error) {
	p.mu.Lock()
	p.rejectQuery = err
	p.mu.Unlock()
}

// Placements 返回全部已经挂出去的单，按挂出顺序。
func (p *PaperGrid) Placements() []paperPlacement {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]paperPlacement, len(p.placed))
	copy(out, p.placed)
	return out
}

// Cancelled 返回被撤掉的客户单号。
func (p *PaperGrid) Cancelled() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, len(p.cancelled))
	copy(out, p.cancelled)
	return out
}

// OpenCount 返回当前挂在盘口上的单数。
func (p *PaperGrid) OpenCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.open)
}

// UseCredentials 在内存撮合里什么都不用做 —— 这里没有签名这一回事。
// 但方法必须存在：引擎把"装密钥"当成跑起来之前的一步，而它不该
// 因为换了个交易所实现就跳过那一步。
func (p *PaperGrid) UseCredentials(Credentials) error { return nil }

// CommissionRate 返回撮合用的费率，好让引擎按同一口径估手续费。
func (p *PaperGrid) CommissionRate() float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.fee
}

func (p *PaperGrid) Rules(string) (GridRules, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.rules, nil
}

// LastPrice 返回当前撮合价 —— 相当于内存交易所的最新成交价。
func (p *PaperGrid) LastPrice(string) (float64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !(p.price > 0) {
		return 0, invalid("内存撮合还没有价格")
	}
	return p.price, nil
}

// SetPrice 直接设定价格，不撮合。只用来摆好测试的初始状态。
func (p *PaperGrid) SetPrice(price float64) {
	if price <= 0 {
		return
	}
	p.mu.Lock()
	p.price = price
	p.mu.Unlock()
}

func (p *PaperGrid) BaseQty(string) (float64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.base, nil
}

// PositionQty 在纸面现货里就是基础币余额。
func (p *PaperGrid) PositionQty(string) (float64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.base, nil
}

// MarketClose 在纸面现货里就是市价卖出。
func (p *PaperGrid) MarketClose(symbol string, qty float64, clientID string) (SpotOrderState, error) {
	return p.MarketSell(symbol, qty, clientID)
}

/*
PlaceLimit 挂一张只做 maker 的限价单。

会立即成交的单**直接拒绝**（-2010），与币安一致。这一条是网格能成立的前提：
如果这里允许成交，测试就永远不会覆盖"穿价跳过"这条分支，
而那正是实盘上最常见的分支。
*/
func (p *PaperGrid) PlaceLimit(symbol string, side SpotSide, qty, price float64, clientID string) (SpotOrderState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rejectPlace != nil {
		err := p.rejectPlace
		p.rejectPlace = nil
		return SpotOrderState{}, err
	}
	if !side.Valid() || qty <= 0 || price <= 0 {
		return SpotOrderState{}, invalid("内存撮合：方向和数量价格都要合法")
	}
	/*
		数量和价格都按交易所步长取整，**与真实客户端走同一套规则**。

		这是刻意重复的一步：如果纸面撮合不做取整，而真实下单做，
		那么测试里"卖单数量正好等于持仓"在实盘上会变成"卖单比持仓少
		一个步长"，而那一格从此再也卖不空。测试必须复现生产的取整行为，
		否则它验证的是另一个系统。
	*/
	qty = AlignQuantity(qty, p.rules.StepSize, p.rules.MinQty)
	price = alignPriceDown(price, p.rules.TickSize)
	if qty <= 0 || price <= 0 {
		return SpotOrderState{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	if p.rules.MinNotional > 0 && qty*price < p.rules.MinNotional {
		return SpotOrderState{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	// 买单挂到市价之上（含等于）会立刻成交；卖单挂到市价之下同理。
	if (side == SpotBuy && price >= p.price) || (side == SpotSell && price <= p.price) {
		return SpotOrderState{}, &ExchangeError{
			Status: 400, Code: -2010,
			Msg: fmt.Sprintf("Order would immediately match and take. LIMIT_MAKER %s @%g vs %g", side, price, p.price),
		}
	}
	if side == SpotSell && qty > p.base+1e-12 {
		return SpotOrderState{}, &ExchangeError{
			Status: 400, Code: -2010,
			Msg:    fmt.Sprintf("Account has insufficient balance for requested action. want %g have %g", qty, p.base),
		}
	}
	p.seq++
	state := SpotOrderState{
		OrderID:       p.seq,
		ClientOrderID: clientID,
		Symbol:        strings.ToUpper(symbol),
		Side:          side,
		Type:          SpotTypeLimitMaker,
		Price:         price,
		OrigQty:       qty,
		Status:        SpotStatusNew,
		UpdateTime:    p.clock().UnixMilli(),
	}
	p.placed = append(p.placed, paperPlacement{
		Level: gridLevelFromClientID(clientID), Side: side, Price: price, Qty: qty, Client: clientID,
	})
	if p.filledOnPlace {
		o := &paperGridOrder{state: state, at: p.clock()}
		p.fillLocked(clientID, o, price)
		return o.state, nil
	}
	p.open[clientID] = &paperGridOrder{state: state, at: p.clock()}
	p.orderSeen[state.OrderID] = state
	return state, nil
}

/*
Tick 把价格推到一个新值，并撮合所有被穿过的挂单。

撮合顺序按**价格**排，不按挂出顺序：行情从上往下走时，价格高的买单先成交。
按挂出顺序撮合会在一次跳跃里把顺序弄反，而成交顺序会直接影响
"哪一格先拿到货"——测试必须能确定地复现。
*/
func (p *PaperGrid) Tick(price float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if price <= 0 {
		return
	}
	p.price = price
	type hit struct {
		client string
		order  *paperGridOrder
	}
	var hits []hit
	for client, o := range p.open {
		switch o.state.Side {
		case SpotBuy:
			if price <= o.state.Price {
				hits = append(hits, hit{client, o})
			}
		case SpotSell:
			if price >= o.state.Price {
				hits = append(hits, hit{client, o})
			}
		}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].order.state.Price > hits[j].order.state.Price })
	for _, h := range hits {
		p.fillLocked(h.client, h.order, h.order.state.Price)
	}
}

// fillLocked 让一张挂单全额成交，更新余额、写成交明细。必须在锁内调用。
func (p *PaperGrid) fillLocked(client string, o *paperGridOrder, price float64) {
	qty := o.state.OrigQty
	quote := qty * price
	feeQty, feeQuote := 0.0, 0.0
	switch o.state.Side {
	case SpotBuy:
		if quote > p.quote+1e-9 {
			// 钱不够：撤销这张单，不成交。真实交易所会在下单时就拒掉，
			// 这里推迟到成交时才发现 —— 效果一样，都是"没买到"。
			delete(p.open, client)
			o.state.Status = SpotStatusCanceled
			p.orderSeen[o.state.OrderID] = o.state
			return
		}
		// 买入的手续费从基础币里扣（币安默认口径）。
		feeQty = qty * p.fee
		p.quote -= quote
		p.base += qty - feeQty
	case SpotSell:
		if qty > p.base+1e-9 {
			delete(p.open, client)
			o.state.Status = SpotStatusCanceled
			p.orderSeen[o.state.OrderID] = o.state
			return
		}
		feeQuote = quote * p.fee
		p.base -= qty
		p.quote += quote - feeQuote
	}
	at := p.clock()
	o.state.ExecutedQty = qty
	o.state.CumQuote = quote
	o.state.Status = SpotStatusFilled
	o.state.UpdateTime = at.UnixMilli()
	p.orderSeen[o.state.OrderID] = o.state
	delete(p.open, client)

	trade := GridTrade{Price: price, Qty: qty, QuoteQty: quote, At: at}
	switch {
	case feeQty > 0:
		trade.Commission = feeQty
		trade.CommissionAsset = p.rules.BaseAsset
	case feeQuote > 0:
		trade.Commission = feeQuote
		trade.CommissionAsset = p.rules.QuoteAsset
	}
	p.trades[o.state.OrderID] = append(p.trades[o.state.OrderID], trade)
}

func (p *PaperGrid) OpenOrders(symbol string) ([]SpotOrderState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]SpotOrderState, 0, len(p.open))
	for _, o := range p.open {
		out = append(out, o.state)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OrderID < out[j].OrderID })
	return out, nil
}

// QueryOrder 查一张单的最终状态。模拟"查不到"要能发生 ——
// 引擎在那种情况下的行为（保留本地记账、下一拍重试）是必须被覆盖的。
func (p *PaperGrid) QueryOrder(symbol, clientID string) (SpotOrderState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rejectQuery != nil {
		err := p.rejectQuery
		p.rejectQuery = nil
		return SpotOrderState{}, err
	}
	if o, ok := p.open[clientID]; ok {
		return o.state, nil
	}
	for _, s := range p.orderSeen {
		if s.ClientOrderID == clientID {
			return s, nil
		}
	}
	return SpotOrderState{}, &ExchangeError{Status: 400, Code: -2013, Msg: "Order does not exist."}
}

func (p *PaperGrid) Cancel(symbol, clientID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cancelled = append(p.cancelled, clientID)
	o, ok := p.open[clientID]
	if !ok {
		// 撤一张不存在的单算成功 —— 与 USDMClient.SpotCancel 同一口径。
		return nil
	}
	o.state.Status = SpotStatusCanceled
	p.orderSeen[o.state.OrderID] = o.state
	delete(p.open, clientID)
	return nil
}

/*
PartialFill 让一张还挂着的单成交一部分，剩下的留在盘口上。

真实的只做 maker 单被吃的时候经常是部分成交（对手方的单量不够拿走整张）。
这条路径必须能测：引擎在部分成交之后要做两件事 —— 把成交的那一份坐实、
把剩下的撤掉 —— 少做一件，这一格的数量就会和账对不上。
*/
func (p *PaperGrid) PartialFill(clientID string, qty float64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	o, ok := p.open[clientID]
	if !ok {
		return invalid("内存撮合：这张单不在盘口上")
	}
	if qty <= 0 || qty >= o.state.OrigQty {
		return invalid("内存撮合：部分成交数量要在 0 和挂单量之间")
	}
	price := o.state.Price
	quote := qty * price
	at := p.clock()
	o.state.ExecutedQty += qty
	o.state.CumQuote += quote
	o.state.Status = SpotStatusPartial
	o.state.UpdateTime = at.UnixMilli()

	trade := GridTrade{Price: price, Qty: qty, QuoteQty: quote, At: at}
	if o.state.Side == SpotBuy {
		fee := qty * p.fee
		p.quote -= quote
		p.base += qty - fee
		trade.Commission = fee
		trade.CommissionAsset = p.rules.BaseAsset
	} else {
		fee := quote * p.fee
		p.base -= qty
		p.quote += quote - fee
		trade.Commission = fee
		trade.CommissionAsset = p.rules.QuoteAsset
	}
	p.trades[o.state.OrderID] = append(p.trades[o.state.OrderID], trade)
	return nil
}

/*
SettleFilledOnPlace 让下一张挂单**当场成交**。

只做 maker 的单理论上不该立刻成交，但对手方在同一个 tick 里吃掉它是
真会发生的。引擎必须走正常的入账路径，而不是把它当成"还挂在盘口上"——
那样下一拍会去查一张已经成交的单，再入账一次。
*/
func (p *PaperGrid) SettleFilledOnPlace(v bool) {
	p.mu.Lock()
	p.filledOnPlace = v
	p.mu.Unlock()
}

func (p *PaperGrid) Trades(symbol string, orderID int64) ([]GridTrade, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	rows := p.trades[orderID]
	out := make([]GridTrade, len(rows))
	copy(out, rows)
	return out, nil
}

// MarketSell 按当前价（扣滑点）卖出指定数量。
func (p *PaperGrid) MarketSell(symbol string, qty float64, clientID string) (SpotOrderState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rejectPlace != nil {
		err := p.rejectPlace
		p.rejectPlace = nil
		return SpotOrderState{}, err
	}
	if qty <= 0 {
		return SpotOrderState{}, invalid("内存撮合：市价卖出数量必须大于 0")
	}
	if qty > p.base+1e-9 {
		qty = p.base
	}
	price := p.price * (1 - p.slippage)
	quote := qty * price
	feeQuote := quote * p.fee
	p.base -= qty
	p.quote += quote - feeQuote
	at := p.clock()
	p.seq++
	state := SpotOrderState{
		OrderID:       p.seq,
		ClientOrderID: clientID,
		Symbol:        strings.ToUpper(symbol),
		Side:          SpotSell,
		Type:          SpotTypeMarket,
		Price:         price,
		OrigQty:       qty,
		ExecutedQty:   qty,
		CumQuote:      quote,
		Status:        SpotStatusFilled,
		UpdateTime:    at.UnixMilli(),
	}
	p.trades[state.OrderID] = []GridTrade{{
		Price: price, Qty: qty, QuoteQty: quote,
		Commission: feeQuote, CommissionAsset: p.rules.QuoteAsset, At: at,
	}}
	return state, nil
}
