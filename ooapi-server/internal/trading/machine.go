package trading

// State 是订单状态机的节点。字符串与约定的设计名一致。
type State string

const (
	StateIdle           State = "Idle"
	StateArmed          State = "Armed"
	StateEntrySubmitted State = "EntrySubmitted"
	StateInPosition     State = "InPosition"
	StateExitSubmitted  State = "ExitSubmitted"
	StateSettled        State = "Settled"
	StateDailyHalt      State = "DailyHalt"
	StateBlocked        State = "Blocked"
	StateError          State = "Error"
)

// EventKind 是推动状态机的事件。
type EventKind string

const (
	EventStartOK      EventKind = "start_ok"
	EventStartBlocked EventKind = "start_blocked"
	EventStop         EventKind = "stop"
	EventEntrySignal  EventKind = "entry_signal"
	EventEntryFilled  EventKind = "entry_filled"
	EventExitSignal   EventKind = "exit_signal"
	EventExitFilled   EventKind = "exit_filled"
	EventBooked       EventKind = "booked"
	EventDailyHalt    EventKind = "daily_halt"
	EventNextUTCDay   EventKind = "next_utc_day"
	EventFail         EventKind = "fail"
)

// Event 是一次状态迁移。Reason 只用于审计，不参与选边。
type Event struct {
	Kind   EventKind
	Reason string
}

// 迁移表是唯一允许的边。Error 只能由人工 Stop 离开，避免自动重开。
var transitions = map[State]map[EventKind]State{
	StateIdle: {
		EventStartOK:      StateArmed,
		EventStartBlocked: StateBlocked,
		EventDailyHalt:    StateDailyHalt,
	},
	StateArmed: {
		EventEntrySignal:  StateEntrySubmitted,
		EventStop:         StateIdle,
		EventStartBlocked: StateBlocked,
		EventDailyHalt:    StateDailyHalt,
		EventFail:         StateError,
	},
	StateEntrySubmitted: {
		EventEntryFilled: StateInPosition,
		EventFail:        StateError,
		EventStop:        StateIdle,
	},
	StateInPosition: {
		EventExitSignal: StateExitSubmitted,
		EventFail:       StateError,
	},
	StateExitSubmitted: {
		EventExitFilled: StateSettled,
		EventFail:       StateError,
	},
	StateSettled: {
		EventBooked:    StateIdle,
		EventDailyHalt: StateDailyHalt,
	},
	StateDailyHalt: {
		EventNextUTCDay: StateIdle,
	},
	StateBlocked: {
		EventStartOK:      StateArmed,
		EventStartBlocked: StateBlocked,
		EventStop:         StateIdle,
		EventDailyHalt:    StateDailyHalt,
	},
	StateError: {
		EventStop: StateIdle,
	},
}

// Machine 是纯状态机，不碰交易所。
type Machine struct {
	State  State
	Reason string
	trace  []State
}

func NewMachine() *Machine {
	return &Machine{State: StateIdle, trace: []State{StateIdle}}
}

// Trace 返回从 Idle 开始的状态序列副本。
func (m *Machine) Trace() []State {
	out := make([]State, len(m.trace))
	copy(out, m.trace)
	return out
}

// Transition 只在表中有边时前进。非法事件不改变当前状态。
func (m *Machine) Transition(ev Event) error {
	if m == nil {
		return ErrIllegalTransition
	}
	next, ok := transitions[m.State][ev.Kind]
	if !ok {
		return withReason(ErrIllegalTransition, string(m.State)+" -"+string(ev.Kind)+"->")
	}
	m.State = next
	m.Reason = ev.Reason
	m.trace = append(m.trace, next)
	return nil
}

// Restore 用于进程重启后的安全恢复，不把它当成一笔交易事件。
func (m *Machine) Restore(state State, reason string) {
	if m == nil {
		return
	}
	m.State = state
	m.Reason = reason
	m.trace = append(m.trace, state)
}
