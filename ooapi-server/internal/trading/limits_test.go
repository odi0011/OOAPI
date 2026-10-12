package trading

import (
	"testing"
	"time"
)

func TestOptionalRiskLimitsStayOffByDefault(t *testing.T) {
	cfg := testConfig()
	cfg.EntryMode = EntryModeTrend
	cfg.MinScore = 1
	cfg.DailyLossPct = DailyLossOffPct
	cfg.Leverage = 20
	cfg.MaxMarginUsdt = 10
	if cfg.OpenPositionLimit() != 0 || cfg.marginCap() != 0 || cfg.lossPauseCount() != 0 || cfg.balancePauseLine() != 0 {
		t.Fatalf("defaults %+v", cfg)
	}
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 50)); err != nil {
		t.Fatal(err)
	}
	candles := appendBar(candlesUntil(t, CrossGolden), 1.001)
	var snap Snapshot
	var err error
	for i := 0; i < 3; i++ {
		if i > 0 {
			candles = appendBar(candles, 1.001)
		}
		price := candles[len(candles)-1].Close
		snap, err = eng.Step(stepAt(now, candles, price, 50))
		if err != nil || snap.State != StateInPosition {
			t.Fatalf("entry %d %+v err=%v", i, snap, err)
		}
		if i == 0 {
			_, _, want, sizeErr := SizePosition(10, 20, price, MinNotionalUSDT)
			if sizeErr != nil {
				t.Fatal(sizeErr)
			}
			if snap.Qty < want-1e-6 || snap.Qty > want+1e-6 {
				t.Fatalf("qty=%v want=%v", snap.Qty, want)
			}
		}
		snap, err = eng.Step(stepAt(now, candles, snap.StopPrice, 50))
		if err != nil {
			t.Fatalf("exit %d %v", i, err)
		}
	}
	if snap.PauseReason != "" || !snap.Running || snap.State != StateArmed {
		t.Fatalf("losses should not pause %+v", snap)
	}

	in := stepAt(now, nil, 1, 50)
	in.WalletKnown = true
	in.Wallet = 1.2
	in.Available = 1.2
	snap, err = eng.Step(in)
	if err != nil || snap.PauseReason != "" || !snap.Running {
		t.Fatalf("balance 1.2 paused %+v err=%v", snap, err)
	}
}

func TestEnvAndStrategyEnableOptionalRiskLimits(t *testing.T) {
	t.Setenv(EnvMaxConsecutiveLosses, "2")
	t.Setenv(EnvPauseBalanceUSDT, "5")
	t.Setenv(EnvMaxMarginPerTradeUSDT, "1")
	cfg := testConfig()
	if cfg.lossPauseCount() != 2 || cfg.balancePauseLine() != 5 || cfg.marginCap() != 1 {
		t.Fatalf("env cfg %+v cap=%v losses=%d pause=%v", cfg, cfg.marginCap(), cfg.lossPauseCount(), cfg.balancePauseLine())
	}
	cfg.MaxConsecutiveLosses = 5
	cfg.PauseBalanceUsdt = 0.8
	cfg.MaxMarginPerTradeUsdt = 2
	if cfg.lossPauseCount() != 5 || cfg.balancePauseLine() != 0.8 || cfg.marginCap() != 2 {
		t.Fatalf("strategy should win %+v", cfg)
	}

	eng := withSecrets(NewEngine(testConfig(), NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	in := stepAt(now, nil, 1, 20)
	in.WalletKnown = true
	in.Wallet = 1.2
	in.Available = 1.2
	snap, err := eng.Step(in)
	if err != nil || snap.LastReason != ReasonBalanceBelowPause || snap.Running {
		t.Fatalf("env pause %+v err=%v", snap, err)
	}
}

func TestLiveArmedPeersIgnoreTestnetAndOpenPositions(t *testing.T) {
	ResetTestnetGreen()
	SetTestnetGreen(true)
	t.Cleanup(ResetTestnetGreen)
	h := NewHub()
	now := time.Date(2026, 10, 12, 9, 30, 0, 0, time.UTC)
	live := testConfig()
	live.Mode = ModeLive
	live.ID = 1
	eng := withSecrets(NewEngine(live, NewPaper(), DiscardLogger()))
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	h.PutForTest(1, 1, eng)
	held := live
	held.ID = 2
	held.Symbol = "DOGEUSDT"
	heldEng := withSecrets(NewEngine(held, NewPaper(), DiscardLogger()))
	if err := heldEng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	heldEng.SeedPositionForTest(SideLong, 1, 1, 0.9, 1.2)
	h.PutForTest(1, 2, heldEng)
	paperCfg := testConfig()
	paperCfg.ID = 3
	paper := withSecrets(NewEngine(paperCfg, NewPaper(), DiscardLogger()))
	if err := paper.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	h.PutForTest(1, 3, paper)
	h.mu.Lock()
	ids := h.liveArmedIDsLocked()
	h.mu.Unlock()
	if len(ids) != 1 || ids[0] != 1 {
		t.Fatalf("peers %v", ids)
	}
}
