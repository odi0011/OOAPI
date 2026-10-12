package trading

import (
	"errors"
	"math"
	"testing"
	"time"
)

func near(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestProtectionPricesLongAndShort(t *testing.T) {
	stop, take, err := ProtectionPrices(SideLong, 2, 0.1, 1, 1.5)
	if err != nil {
		t.Fatal(err)
	}
	near(t, stop, 1.9)
	near(t, take, 2.15)

	stop, take, err = ProtectionPrices(SideShort, 2, 0.1, 1, 1.5)
	if err != nil {
		t.Fatal(err)
	}
	near(t, stop, 2.1)
	near(t, take, 1.85)
}

func TestAlignQuantityFloorsToStep(t *testing.T) {
	near(t, AlignQuantity(10.27, 0.1, 0.1), 10.2)
	if AlignQuantity(0.4, 1, 1) != 0 {
		t.Fatal("expected qty below the step to be rejected")
	}
}

func TestProtectionPricesRejectsNonPositive(t *testing.T) {
	if _, _, err := ProtectionPrices(SideLong, 0.05, 0.1, 1, 1.5); err == nil {
		t.Fatal("expected stop below zero to fail")
	}
	if _, _, err := ProtectionPrices(SideLong, 1, 0, 1, 1.5); err == nil {
		t.Fatal("expected zero R to fail")
	}
	if _, _, err := ProtectionPrices(Side("flat"), 1, 0.1, 1, 1.5); err == nil {
		t.Fatal("expected bad side to fail")
	}
}

func TestSizePositionRespectsMinNotional(t *testing.T) {
	_, notional, _, err := SizePosition(1.6, 3, 0.5, MinNotionalUSDT)
	if !errors.Is(err, ErrNotionalBelowMin) {
		t.Fatalf("1.6x3=%v err=%v", notional, err)
	}
	margin, notional, qty, err := SizePosition(1.7, 3, 0.5, MinNotionalUSDT)
	if err != nil {
		t.Fatal(err)
	}
	near(t, margin, 1.7)
	near(t, notional, 5.1)
	near(t, qty, 10.2)
	if _, _, _, err := SizePosition(1.8, 4, 1, MinNotionalUSDT); err == nil {
		t.Fatal("leverage above 3 must fail")
	}
}

func TestDailyHaltThreshold(t *testing.T) {
	const capital = 2.0
	const pct = 4.0
	if DailyHaltBreached(capital, -0.079, pct) {
		t.Fatal("loss under 4% should not halt")
	}
	if !DailyHaltBreached(capital, -0.08, pct) {
		t.Fatal("loss at 4% should halt")
	}
	// 先亏 0.05 再赚 0.03，净亏 0.02，不该停机。
	if DailyHaltBreached(capital, -0.05+0.03, pct) {
		t.Fatal("wins offset losses")
	}
	if DailyHaltBreached(0, -1, pct) {
		t.Fatal("missing capital must not halt")
	}
}

func TestLedgerResetsOnNextUTCDay(t *testing.T) {
	var book Ledger
	day := time.Date(2026, 10, 12, 22, 0, 0, 0, time.UTC)
	book.Roll(day, 2)
	if !book.Add(-0.08, 4) || !book.Halted {
		t.Fatal("expected halt")
	}
	book.Roll(day.Add(30*time.Minute), 9)
	if !book.Halted || book.Capital != 2 {
		t.Fatalf("same UTC day must keep the halt: %+v", book)
	}
	next := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	book.Roll(next, 2)
	if book.Halted || book.Realized != 0 || !book.Day.Equal(next) {
		t.Fatalf("next UTC day should clear the halt: %+v", book)
	}
}

func TestStartBlockedFundingAndLiquidation(t *testing.T) {
	if blocked, reason := StartBlocked(0.0001, -1); blocked {
		t.Fatalf("calm market blocked: %s", reason)
	}
	if blocked, reason := StartBlocked(0.002, -1); !blocked || reason != "funding_extreme" {
		t.Fatalf("funding blocked=%v reason=%s", blocked, reason)
	}
	if blocked, reason := StartBlocked(-0.002, -1); !blocked || reason != "funding_extreme" {
		t.Fatalf("negative funding blocked=%v reason=%s", blocked, reason)
	}
	if blocked, reason := StartBlocked(0, 0.01); !blocked || reason != "liquidation_too_close" {
		t.Fatalf("liq blocked=%v reason=%s", blocked, reason)
	}
	if blocked, _ := StartBlocked(0, -1); blocked {
		t.Fatal("flat account must not be blocked by liquidation")
	}
}

func TestConfigRejectsUnlockedStrategy(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ExchangeKeyID = 1
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg.Leverage = 4
	if err := cfg.Validate(); err == nil {
		t.Fatal("leverage 4")
	}
	cfg = DefaultConfig()
	cfg.ExchangeKeyID = 1
	cfg.Timeframe = "2m"
	if err := cfg.Validate(); err == nil {
		t.Fatal("timeframe")
	}
	cfg = DefaultConfig()
	cfg.ExchangeKeyID = 1
	cfg.EmaFast = 21
	cfg.EmaSlow = 9
	if err := cfg.Validate(); err == nil {
		t.Fatal("ema order")
	}
	cfg = DefaultConfig()
	cfg.ExchangeKeyID = 1
	cfg.MarginMode = "cross"
	if err := cfg.Validate(); err == nil {
		t.Fatal("margin")
	}
	cfg = DefaultConfig()
	if err := cfg.Validate(); err == nil {
		t.Fatal("missing key")
	}
}
