package trading

import (
	"fmt"
	"sync"
)

const (
	StatusSubmitted = "submitted"
	StatusFilled    = "filled"
)

// EntryOrder 是一张开仓单。测网撮合按 Price 立即成交。
type EntryOrder struct {
	Symbol     string
	Side       Side
	Qty        float64
	Price      float64
	Leverage   int
	MarginMode string
}

// Protection 是持仓上的止损和止盈。测网会把它做成条件单。
type Protection struct {
	Symbol string
	Stop   float64
	Take   float64
	Side   Side
}

// CloseOrder 是平仓请求。
type CloseOrder struct {
	Symbol string
	Price  float64
	Reason string
}

// Fill 是一次成交回报。
type Fill struct {
	OrderID string
	Price   float64
	Qty     float64
	Status  string
	Side    Side
}

// Position 是当前合约持仓。Open 为假表示空仓。
type Position struct {
	Open  bool
	Side  Side
	Qty   float64
	Entry float64
}

// Exchange 是策略引擎和交易所之间的边界。
// Paper 只给状态机单测。测网和已开门闩的实盘都走 USDMClient，主机不同。
type Exchange interface {
	PlaceEntry(req EntryOrder) (Fill, error)
	PlaceProtection(req Protection) error
	Close(req CloseOrder) (Fill, error)
	CancelOpen(symbol string) error
	Position(symbol string) (Position, error)
}

// Paper 是测网内存撮合。开仓按市价立即成交，不访问网络。
type Paper struct {
	mu         sync.Mutex
	pos        Position
	openOrders int
	seq        int
	Leverage   int
	MarginMode string
	Cancels    int
	Entries    int
}

func NewPaper() *Paper { return &Paper{} }

func (p *Paper) PlaceEntry(req EntryOrder) (Fill, error) {
	if req.Symbol == "" || req.Qty <= 0 || req.Price <= 0 {
		return Fill{}, invalid("开仓单缺少交易对、数量或价格")
	}
	if req.Leverage < 1 || req.Leverage > MaxLeverage || req.MarginMode != MarginIsolated {
		return Fill{}, invalid(fmt.Sprintf("测网撮合只接受逐仓且杠杆不超过 %d", MaxLeverage))
	}
	if req.Side != SideLong && req.Side != SideShort {
		return Fill{}, invalid("开仓方向只能是 long 或 short")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pos.Open {
		return Fill{}, invalid("已有持仓，不能再开仓")
	}
	p.seq++
	p.Entries++
	p.Leverage = req.Leverage
	p.MarginMode = req.MarginMode
	p.pos = Position{Open: true, Side: req.Side, Qty: req.Qty, Entry: req.Price}
	return Fill{
		OrderID: fmt.Sprintf("paper-%d", p.seq),
		Price:   req.Price,
		Qty:     req.Qty,
		Status:  StatusFilled,
		Side:    req.Side,
	}, nil
}

func (p *Paper) PlaceProtection(req Protection) error {
	if req.Stop <= 0 || req.Take <= 0 {
		return invalid("保护单价格必须大于 0")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.pos.Open {
		return invalid("没有持仓，不能挂保护单")
	}
	p.openOrders++
	return nil
}

func (p *Paper) Close(req CloseOrder) (Fill, error) {
	if req.Price <= 0 {
		return Fill{}, invalid("平仓价必须大于 0")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.pos.Open {
		return Fill{}, invalid("没有持仓可平")
	}
	p.seq++
	side := p.pos.Side
	qty := p.pos.Qty
	p.pos = Position{}
	p.openOrders = 0
	return Fill{
		OrderID: fmt.Sprintf("paper-%d", p.seq),
		Price:   req.Price,
		Qty:     qty,
		Status:  StatusFilled,
		Side:    side,
	}, nil
}

func (p *Paper) CancelOpen(symbol string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Cancels++
	p.openOrders = 0
	return nil
}

func (p *Paper) Position(symbol string) (Position, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.pos, nil
}

// LiveStub 是实盘传输的桩。它没有 HTTP 客户端，任何发单调用都直接拒绝。
// 撤单返回成功：出错路径需要撤掉挂单，桩上本来就没有挂单。
type LiveStub struct {
	mu      sync.Mutex
	Entries int
	Closes  int
	Cancels int
}

func NewLiveStub() *LiveStub { return &LiveStub{} }

func (s *LiveStub) PlaceEntry(req EntryOrder) (Fill, error) {
	s.mu.Lock()
	s.Entries++
	s.mu.Unlock()
	return Fill{}, ErrLiveTransportDisabled
}

func (s *LiveStub) PlaceProtection(req Protection) error {
	return ErrLiveTransportDisabled
}

func (s *LiveStub) Close(req CloseOrder) (Fill, error) {
	s.mu.Lock()
	s.Closes++
	s.mu.Unlock()
	return Fill{}, ErrLiveTransportDisabled
}

func (s *LiveStub) CancelOpen(symbol string) error {
	s.mu.Lock()
	s.Cancels++
	s.mu.Unlock()
	return nil
}

func (s *LiveStub) Position(symbol string) (Position, error) {
	return Position{}, nil
}

// USDT-M 合约地址。测网和实盘共用同一套 REST，只是主机不同。
const (
	BinanceUSDMTestnetBase = "https://testnet.binancefuture.com"
	BinanceUSDMLiveBase    = "https://fapi.binance.com"
)

// NewExchange 按策略 mode 选择客户端。
// 测网走币安 USDT-M 测试网。实盘在门闩关闭时直接拒绝；打开后用实盘主机发单。
func NewExchange(cfg Config) (Exchange, error) {
	switch cfg.Mode {
	case ModeTestnet:
		return NewUSDMTestnet(), nil
	case ModeLive:
		if !TestnetGreen() {
			return nil, ErrLiveGateClosed
		}
		return NewUSDMClient(BinanceUSDMLiveBase), nil
	default:
		return nil, ErrBadMode
	}
}
