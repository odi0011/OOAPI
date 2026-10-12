package trading

import "errors"

// 这些哨兵错误是给接口层映射状态码用的。
// 文案保持稳定，调用方用 errors.Is 判断，不要比较整句。
var (
	ErrLiveGateClosed        = errors.New("live mode refused until testnet has passed")
	ErrLiveTransportDisabled = errors.New("live transport is disabled; orders are not sent")
	ErrDailyHalt             = errors.New("daily loss halt")
	ErrBlocked               = errors.New("start blocked")
	ErrNoAutoReopen          = errors.New("error state does not auto-reopen")
	ErrIllegalTransition     = errors.New("illegal state transition")
	ErrNotRunning            = errors.New("strategy is not armed")
	ErrAlreadyRunning        = errors.New("strategy is already in a trade")
	ErrConfigLocked          = errors.New("strategy config is locked while in a trade")
	ErrKeyNotUsable          = errors.New("exchange key is missing or revoked")
	ErrEquityRequired        = errors.New("equity is required")
	ErrNotConfigured         = errors.New("strategy is not configured")
	ErrBadMode               = errors.New("mode must be testnet or live")
	ErrNotionalBelowMin      = errors.New("notional below exchange minimum")
)

// ValidationError 是配置字段不合法。接口层把它映射成 400。
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func invalid(message string) error {
	return &ValidationError{Message: message}
}

// ReasonError 在哨兵错误上带一个机器可读的原因（如 funding_extreme）。
type ReasonError struct {
	Err    error
	Reason string
}

func (e *ReasonError) Error() string {
	if e == nil || e.Err == nil {
		return ""
	}
	if e.Reason == "" {
		return e.Err.Error()
	}
	return e.Err.Error() + ": " + e.Reason
}

func (e *ReasonError) Unwrap() error { return e.Err }

func withReason(err error, reason string) error {
	return &ReasonError{Err: err, Reason: reason}
}
