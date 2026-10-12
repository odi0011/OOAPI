package trading

import (
	"math"
	"testing"
	"time"
)

func TestEMASeedAndSmoothing(t *testing.T) {
	got, err := EMA([]float64{1, 2, 3, 4, 5}, 3)
	if err != nil {
		t.Fatal(err)
	}
	// 种子是前 3 根的 SMA = 2，k = 2/(3+1) = 0.5。
	want := []float64{0, 0, 2, 3, 4}
	if len(got) != len(want) {
		t.Fatalf("len %d", len(got))
	}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 1e-9 {
			t.Fatalf("ema[%d]=%v want %v", i, got[i], want[i])
		}
	}
}

func TestGoldenAndDeathCross(t *testing.T) {
	golden := candlesUntil(t, CrossGolden)
	closes := closesOf(golden)
	got, err := LastCross(closes, 9, 21)
	if err != nil || got != CrossGolden {
		t.Fatalf("golden cross=%s err=%v", got, err)
	}
	if side := SideForCross(got); side != SideLong {
		t.Fatalf("side %s", side)
	}

	death := candlesUntil(t, CrossDeath)
	got, err = LastCross(closesOf(death), 9, 21)
	if err != nil || got != CrossDeath {
		t.Fatalf("death cross=%s err=%v", got, err)
	}
	if side := SideForCross(got); side != SideShort {
		t.Fatalf("side %s", side)
	}

	if cross, err := LastCross([]float64{1, 2, 3}, 9, 21); err != nil || cross != CrossNone {
		t.Fatalf("short series cross=%s err=%v", cross, err)
	}
}

func candlesUntil(t *testing.T, want Cross) []Candle {
	t.Helper()
	price := 1.0
	mult1, mult2 := 0.995, 1.03
	if want == CrossDeath {
		mult1, mult2 = 1.005, 0.97
	}
	base := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	var candles []Candle
	push := func(i int) {
		candles = append(candles, Candle{
			OpenTime: base.Add(time.Duration(i) * 5 * time.Minute),
			Close:    price,
		})
	}
	for i := 0; i < 60; i++ {
		price *= mult1
		push(i)
	}
	for i := 60; i < 140; i++ {
		price *= mult2
		push(i)
		cross, err := LastCross(closesOf(candles), 9, 21)
		if err != nil {
			t.Fatal(err)
		}
		if cross == want {
			return candles
		}
	}
	t.Fatalf("series never produced %s", want)
	return nil
}
