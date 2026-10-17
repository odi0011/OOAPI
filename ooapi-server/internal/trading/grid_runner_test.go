package trading

import (
	"context"
	"testing"
	"time"
)

/*
网格自己停机时，回调必须带上 userID。

落库的 UPDATE 是 `WHERE id = ? AND user_id = ?`。调度器曾经只传
gridID、userID 填 0，SQL 一行都没更新，也不报错：网格自停机后
running 仍是 1，服务一重启就被恢复，本地还按旧成交历史重建出
已经平掉的持仓。实盘（测试网 WIF 空头）已经复现过整条链路。
*/
func TestRunnerStopCallbackCarriesUserID(t *testing.T) {
	hub := NewGridHub()
	r := NewGridRunner(hub)
	r.SetMarket(func(GridConfig, SecretOpener, time.Time) (float64, error) {
		return gridTestStart, nil
	})

	cfg := GridConfig{
		ID: 99, UserID: 42, ExchangeKeyID: 3,
		Symbol: gridTestSymbol, Mode: ModeTestnet,
		Lower: gridTestLower, Upper: gridTestUpper, Levels: 6,
		QuoteBudget: 22, FeeRate: 0.001,
		// 调度器只推进"该跑"的网格；引擎自己已经停了，但库里的运行
		// 标记在回调落库之前仍然是 true。
		Running: true,
	}
	paper := NewPaperGrid(gridTestRules(), gridTestStart, 50)
	eng, err := BuildGridEngine(cfg, gridTestStart, paper, newMemoryGridFillLog(), DiscardLogger())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := eng.Stop(now, ReasonGridStoppedByUser); err != nil {
		t.Fatal(err)
	}
	if err := hub.Put(eng); err != nil {
		t.Fatal(err)
	}

	r.mu.Lock()
	r.specs[cfg.ID] = GridRunSpec{UserID: cfg.UserID, Config: cfg}
	r.mu.Unlock()

	var gotID, gotUser int64
	r.SetStop(func(gridID, userID int64) {
		gotID, gotUser = gridID, userID
	})

	r.tick(context.Background(), cfg.ID)

	if gotID != cfg.ID || gotUser != cfg.UserID {
		t.Fatalf("停机回调应收到 id=%d user=%d，得到 id=%d user=%d",
			cfg.ID, cfg.UserID, gotID, gotUser)
	}
}
