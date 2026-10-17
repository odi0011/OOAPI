package trading

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

/*
PaperFuturesGrid 是合约网格的内存撮合，只给测试用。

它复现的是**引擎依赖的那几条交易所行为**，不是完整的撮合引擎：

	· GTX（post-only）挂单会立刻吃单时，交易所直接拒绝（-5022）；
	· 卖单在价格涨到挂价时成交，买单在价格跌到挂价时成交；
	· 成交价就是挂价（maker），手续费按 maker 费率收在计价币上；
	· 市价平仓按当前价加滑点成交。

刻意不做保证金/强平模拟：引擎不依赖那些数，做了反而会让测试
把注意力放到撮合模型的细节上，而不是网格的状态推进。
*/
type PaperFuturesGrid struct {
	mu        sync.Mutex
	rules     GridRules
	price     float64
	fee       float64
	slippage  float64
	direction GridDirection

	// position 带符号：空头为负。
	position float64
	seq      int64
	// protectTrigger 是交易所侧保护单的触发价，0 表示没有。
	protectTrigger float64

	open    map[string]*paperFuturesOrder
	closed  map[string]SpotOrderState
	trades  map[int64][]GridTrade
	clock   func() time.Time
	reject  error
}

type paperFuturesOrder struct {
	OrderID int64
	Client  string
	Symbol  string
	Side    SpotSide
	Price   float64
	Qty     float64
}

func NewPaperFuturesGrid(rules GridRules, price float64, direction GridDirection, fee float64) *PaperFuturesGrid {
	if fee <= 0 {
		fee = FuturesDefaultGridFeeRate
	}
	return &PaperFuturesGrid{
		rules:     rules,
		price:     price,
		fee:       fee,
		slippage:  GridDefaultSlippagePct,
		direction: NormalizeDirection(direction),
		open:      map[string]*paperFuturesOrder{},
		closed:    map[string]SpotOrderState{},
		trades:    map[int64][]GridTrade{},
		clock:     func() time.Time { return time.Now().UTC() },
	}
}

func (p *PaperFuturesGrid) SetClock(fn func() time.Time) { p.clock = fn }
func (p *PaperFuturesGrid) SetFee(v float64)            { p.fee = v }
func (p *PaperFuturesGrid) SetPrice(price float64) {
	p.mu.Lock()
	p.price = price
	p.mu.Unlock()
}

func (p *PaperFuturesGrid) SetSlippage(v float64) {
	p.mu.Lock()
	p.slippage = v
	p.mu.Unlock()
}

// RejectNextPlace 让下一次挂单返回一个指定错误，用来测失败分支。
func (p *PaperFuturesGrid) RejectNextPlace(err error) {
	p.mu.Lock()
	p.reject = err
	p.mu.Unlock()
}

func (p *PaperFuturesGrid) OpenCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.open)
}

func (p *PaperFuturesGrid) Position() float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.position
}

func (p *PaperFuturesGrid) UseCredentials(Credentials) error { return nil }
func (p *PaperFuturesGrid) CommissionRate() float64          { return p.fee }

func (p *PaperFuturesGrid) Rules(string) (GridRules, error)    { return p.rules, nil }
func (p *PaperFuturesGrid) LastPrice(string) (float64, error)  { return p.price, nil }
func (p *PaperFuturesGrid) PositionQty(string) (float64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.position < 0 {
		return -p.position, nil
	}
	return p.position, nil
}
func (p *PaperFuturesGrid) BaseQty(symbol string) (float64, error) { return p.PositionQty(symbol) }

func (p *PaperFuturesGrid) PlaceLimit(symbol string, side SpotSide, qty, price float64, clientID string) (SpotOrderState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reject != nil {
		err := p.reject
		p.reject = nil
		return SpotOrderState{}, err
	}
	if !side.Valid() || qty <= 0 || price <= 0 {
		return SpotOrderState{}, invalid("内存合约撮合：方向、数量、价格都要合法")
	}
	qty = AlignQuantity(qty, p.rules.StepSize, p.rules.MinQty)
	price = alignPriceDown(price, p.rules.TickSize)
	if qty <= 0 || price <= 0 {
		return SpotOrderState{}, withReason(ErrNotionalBelowMin, ReasonBelowMinNotional)
	}
	// GTX：会立刻吃单的挂单被拒。
	if (side == SpotBuy && price >= p.price) || (side == SpotSell && price <= p.price) {
		return SpotOrderState{}, &ExchangeError{
			Status: 400, Code: -5022,
			Msg: "Due to the order could not be executed as maker, the Post Only order will be rejected",
		}
	}
	p.seq++
	o := &paperFuturesOrder{
		OrderID: p.seq, Client: clientID, Symbol: strings.ToUpper(symbol),
		Side: side, Price: price, Qty: qty,
	}
	p.open[clientID] = o
	return SpotOrderState{
		OrderID: p.seq, ClientOrderID: clientID, Symbol: o.Symbol,
		Side: side, Type: "LIMIT", Price: price, OrigQty: qty,
		Status: SpotStatusNew, UpdateTime: p.clock().UnixMilli(),
	}, nil
}

// Tick 把价格推给撮合：触及挂价的单成交。
func (p *PaperFuturesGrid) Tick(price float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.price = price
	clients := make([]string, 0, len(p.open))
	for c := range p.open {
		clients = append(clients, c)
	}
	sort.Strings(clients)
	for _, c := range clients {
		o := p.open[c]
		if o == nil {
			continue
		}
		if (o.Side == SpotBuy && price > o.Price) || (o.Side == SpotSell && price < o.Price) {
			continue
		}
		p.fillLocked(o)
	}
}

func (p *PaperFuturesGrid) fillLocked(o *paperFuturesOrder) {
	delete(p.open, o.Client)
	quote := o.Qty * o.Price
	feeQuote := quote * p.fee
	switch o.Side {
	case SpotBuy:
		p.position += o.Qty
	case SpotSell:
		p.position -= o.Qty
	}
	at := p.clock()
	p.trades[o.OrderID] = []GridTrade{{
		Price: o.Price, Qty: o.Qty, QuoteQty: quote,
		Commission: feeQuote, CommissionAsset: p.rules.QuoteAsset, At: at,
	}}
	p.closed[o.Client] = SpotOrderState{
		OrderID: o.OrderID, ClientOrderID: o.Client, Symbol: o.Symbol,
		Side: o.Side, Type: "LIMIT", Price: o.Price, OrigQty: o.Qty,
		ExecutedQty: o.Qty, CumQuote: quote, Status: SpotStatusFilled,
		UpdateTime: at.UnixMilli(),
	}
}

func (p *PaperFuturesGrid) OpenOrders(symbol string) ([]SpotOrderState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]SpotOrderState, 0, len(p.open))
	for _, o := range p.open {
		out = append(out, SpotOrderState{
			OrderID: o.OrderID, ClientOrderID: o.Client, Symbol: o.Symbol,
			Side: o.Side, Type: "LIMIT", Price: o.Price, OrigQty: o.Qty,
			Status: SpotStatusNew,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ClientOrderID < out[j].ClientOrderID })
	return out, nil
}

func (p *PaperFuturesGrid) QueryOrder(symbol, clientID string) (SpotOrderState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if o, ok := p.open[clientID]; ok {
		return SpotOrderState{
			OrderID: o.OrderID, ClientOrderID: o.Client, Symbol: o.Symbol,
			Side: o.Side, Type: "LIMIT", Price: o.Price, OrigQty: o.Qty,
			Status: SpotStatusNew,
		}, nil
	}
	if st, ok := p.closed[clientID]; ok {
		return st, nil
	}
	return SpotOrderState{ClientOrderID: clientID, Status: SpotStatusCanceled}, nil
}

func (p *PaperFuturesGrid) Cancel(symbol, clientID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.open, clientID)
	return nil
}

func (p *PaperFuturesGrid) Trades(symbol string, orderID int64) ([]GridTrade, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	rows := p.trades[orderID]
	out := make([]GridTrade, len(rows))
	copy(out, rows)
	return out, nil
}

// MarketClose 按当前价加滑点平掉指定数量。
func (p *PaperFuturesGrid) MarketClose(symbol string, qty float64, clientID string) (SpotOrderState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reject != nil {
		err := p.reject
		p.reject = nil
		return SpotOrderState{}, err
	}
	qty = AlignQuantity(qty, p.rules.StepSize, p.rules.MinQty)
	if qty <= 0 {
		return SpotOrderState{}, invalid("内存合约撮合：清仓数量必须大于 0")
	}
	side := p.direction.CloseSide()
	price := p.price
	if side == SpotBuy {
		price *= 1 + p.slippage
	} else {
		price *= 1 - p.slippage
	}
	price = alignPriceDown(price, p.rules.TickSize)
	if price <= 0 || qty <= 0 {
		return SpotOrderState{}, invalid("内存合约撮合：清仓价格或数量不合法")
	}
	switch side {
	case SpotBuy:
		p.position += qty
	case SpotSell:
		p.position -= qty
	}
	quote := qty * price
	feeQuote := quote * p.fee
	at := p.clock()
	p.seq++
	state := SpotOrderState{
		OrderID: p.seq, ClientOrderID: clientID, Symbol: strings.ToUpper(symbol),
		Side: side, Type: "MARKET", Price: price, OrigQty: qty,
		ExecutedQty: qty, CumQuote: quote, Status: SpotStatusFilled,
		UpdateTime: at.UnixMilli(),
	}
	p.trades[state.OrderID] = []GridTrade{{
		Price: price, Qty: qty, QuoteQty: quote,
		Commission: feeQuote, CommissionAsset: p.rules.QuoteAsset, At: at,
	}}
	return state, nil
}

// MarketSell 在合约上就是按清仓方向市价了结。
func (p *PaperFuturesGrid) MarketSell(symbol string, qty float64, clientID string) (SpotOrderState, error) {
	return p.MarketClose(symbol, qty, clientID)
}

// EnsureProtectionStop 记下交易所侧止损的触发价。
func (p *PaperFuturesGrid) EnsureProtectionStop(symbol string, trigger float64, clientID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reject != nil {
		err := p.reject
		p.reject = nil
		return err
	}
	if trigger <= 0 {
		return invalid("保护单触发价必须大于 0")
	}
	p.protectTrigger = trigger
	return nil
}

// CancelProtectionStops 撤掉保护单。
func (p *PaperFuturesGrid) CancelProtectionStops(string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.protectTrigger = 0
	return nil
}

// ProtectionTrigger 给测试断言用。
func (p *PaperFuturesGrid) ProtectionTrigger() float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.protectTrigger
}

// String 让失败信息里能看出当前状态。
func (p *PaperFuturesGrid) String() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return fmt.Sprintf("paper-futures position=%g open=%d price=%g", p.position, len(p.open), p.price)
}
