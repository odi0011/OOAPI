package trading

import (
	"fmt"
	"sync"
)

// Credentials 是下单瞬间解开的交易所密钥。不得写入日志或策略响应。
type Credentials struct {
	APIKey    string
	APISecret string
}

// SecretOpener 只在发单或管理挂单时调用，启动和空转不会调用。
type SecretOpener func() (Credentials, error)

// Hub 按用户和策略 ID 保存内存中的状态机。配置仍从 trading_strategies 读取。
type Hub struct {
	mu      sync.Mutex
	engines map[string]*Engine
}

func NewHub() *Hub {
	return &Hub{engines: map[string]*Engine{}}
}

var defaultHub = NewHub()

// DefaultHub 是进程内唯一的引擎表。
func DefaultHub() *Hub { return defaultHub }

// ResetForTest 清空引擎和实盘门闩，避免测试互相污染。
func ResetForTest() {
	defaultHub = NewHub()
	ResetTestnetGreen()
}

func sessionKey(userID, strategyID int64) string {
	return fmt.Sprintf("%d:%d", userID, strategyID)
}

func (h *Hub) Start(userID, strategyID int64, cfg Config, in StartInput, secrets SecretOpener) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	eng, err := h.prepare(userID, strategyID, cfg, secrets)
	if err != nil {
		if eng != nil {
			return eng.Snapshot(), err
		}
		return Snapshot{}, err
	}
	err = eng.Start(in)
	return eng.Snapshot(), err
}

func (h *Hub) Step(userID, strategyID int64, cfg Config, in StepInput, secrets SecretOpener) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng == nil {
		return Snapshot{}, ErrNotRunning
	}
	if !eng.Busy() {
		if err := eng.UpdateConfig(cfg); err != nil {
			return eng.Snapshot(), err
		}
		ex, err := NewExchange(cfg)
		if err != nil {
			return eng.Snapshot(), err
		}
		if err := eng.UseExchange(ex); err != nil {
			return eng.Snapshot(), err
		}
	}
	eng.SetSecrets(secrets)
	return eng.Step(in)
}

func (h *Hub) Stop(userID, strategyID int64, in StepInput, secrets SecretOpener) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng == nil {
		return Snapshot{State: StateIdle}, nil
	}
	eng.SetSecrets(secrets)
	err := eng.Stop(in)
	return eng.Snapshot(), err
}

func (h *Hub) State(userID, strategyID int64) (Snapshot, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng == nil {
		return Snapshot{}, false
	}
	return eng.Snapshot(), true
}

func (h *Hub) prepare(userID, strategyID int64, cfg Config, secrets SecretOpener) (*Engine, error) {
	key := sessionKey(userID, strategyID)
	eng := h.engines[key]
	if eng != nil && eng.State() == StateError {
		eng.SetSecrets(secrets)
		return eng, ErrNoAutoReopen
	}
	if eng != nil && eng.Busy() {
		eng.SetSecrets(secrets)
		return eng, nil
	}
	ex, err := NewExchange(cfg)
	if err != nil {
		return eng, err
	}
	if eng == nil {
		eng = NewEngine(cfg, ex, nil)
		h.engines[key] = eng
	} else {
		if err := eng.UpdateConfig(cfg); err != nil {
			return eng, err
		}
		if err := eng.UseExchange(ex); err != nil {
			return eng, err
		}
	}
	eng.SetSecrets(secrets)
	return eng, nil
}
