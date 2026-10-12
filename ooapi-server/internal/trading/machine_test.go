package trading

import (
	"errors"
	"testing"
)

func TestStateNamesMatchDesign(t *testing.T) {
	want := []State{
		StateIdle, StateArmed, StateEntrySubmitted, StateInPosition,
		StateExitSubmitted, StateSettled, StateDailyHalt, StateBlocked, StateError,
	}
	got := []string{"Idle", "Armed", "EntrySubmitted", "InPosition", "ExitSubmitted", "Settled", "DailyHalt", "Blocked", "Error"}
	if len(want) != len(got) {
		t.Fatal("len")
	}
	for i := range want {
		if string(want[i]) != got[i] {
			t.Fatalf("state[%d]=%s", i, want[i])
		}
	}
}

func TestStateMachineHappyPathAndHalt(t *testing.T) {
	m := NewMachine()
	steps := []struct {
		ev   Event
		want State
	}{
		{Event{Kind: EventStartOK}, StateArmed},
		{Event{Kind: EventEntrySignal, Reason: "golden"}, StateEntrySubmitted},
		{Event{Kind: EventEntryFilled}, StateInPosition},
		{Event{Kind: EventExitSignal, Reason: "take_profit"}, StateExitSubmitted},
		{Event{Kind: EventExitFilled}, StateSettled},
		{Event{Kind: EventBooked}, StateIdle},
	}
	for _, step := range steps {
		if err := m.Transition(step.ev); err != nil {
			t.Fatal(err)
		}
		if m.State != step.want {
			t.Fatalf("after %s got %s", step.ev.Kind, m.State)
		}
	}

	m = NewMachine()
	mustMove(t, m, Event{Kind: EventStartOK}, StateArmed)
	mustMove(t, m, Event{Kind: EventEntrySignal}, StateEntrySubmitted)
	mustMove(t, m, Event{Kind: EventEntryFilled}, StateInPosition)
	mustMove(t, m, Event{Kind: EventExitSignal, Reason: "stop_loss"}, StateExitSubmitted)
	mustMove(t, m, Event{Kind: EventExitFilled}, StateSettled)
	mustMove(t, m, Event{Kind: EventDailyHalt}, StateDailyHalt)
	mustMove(t, m, Event{Kind: EventNextUTCDay}, StateIdle)

	m = NewMachine()
	mustMove(t, m, Event{Kind: EventStartBlocked, Reason: "funding_extreme"}, StateBlocked)
	mustMove(t, m, Event{Kind: EventStartOK}, StateArmed)
}

func TestErrorDoesNotAutoReopen(t *testing.T) {
	m := NewMachine()
	mustMove(t, m, Event{Kind: EventStartOK}, StateArmed)
	mustMove(t, m, Event{Kind: EventEntrySignal}, StateEntrySubmitted)
	mustMove(t, m, Event{Kind: EventFail, Reason: "rejected"}, StateError)
	before := m.Trace()
	err := m.Transition(Event{Kind: EventEntrySignal})
	if !errors.Is(err, ErrIllegalTransition) {
		t.Fatal(err)
	}
	if m.State != StateError {
		t.Fatalf("state changed to %s", m.State)
	}
	err = m.Transition(Event{Kind: EventStartOK})
	if !errors.Is(err, ErrIllegalTransition) || m.State != StateError {
		t.Fatalf("start from error: %v state=%s", err, m.State)
	}
	if err := m.Transition(Event{Kind: EventStop}); err != nil || m.State != StateIdle {
		t.Fatalf("manual stop: %v state=%s", err, m.State)
	}
	if len(m.Trace()) < len(before) {
		t.Fatal("trace shrank")
	}
}

func TestIllegalTransitionLeavesState(t *testing.T) {
	m := NewMachine()
	err := m.Transition(Event{Kind: EventEntryFilled})
	if !errors.Is(err, ErrIllegalTransition) {
		t.Fatal(err)
	}
	if m.State != StateIdle {
		t.Fatalf("state %s", m.State)
	}
}

func mustMove(t *testing.T, m *Machine, ev Event, want State) {
	t.Helper()
	if err := m.Transition(ev); err != nil {
		t.Fatal(err)
	}
	if m.State != want {
		t.Fatalf("after %s got %s want %s", ev.Kind, m.State, want)
	}
}
