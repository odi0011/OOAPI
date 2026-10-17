package trading

import (
	"sort"
	"sync"
)

/*
网格成交的内存账本。

它存在的第一个理由是单测：引擎要能在不碰数据库的情况下跑完整条路径。
第二个理由是**它同时定义了「Holdings 该算出什么」**——数据库实现只要
跟这里算出一样的结果就行，不用各自理解一遍"什么算持有"。
*/

type memoryGridFillLog struct {
	mu   sync.Mutex
	next int64
	rows []GridFill
}

func newMemoryGridFillLog() *memoryGridFillLog { return &memoryGridFillLog{} }

var (
	gridFillMu  sync.RWMutex
	gridFillLog GridFillLog = newMemoryGridFillLog()
)

// SetGridFillLog 换成进程使用的网格成交账本。nil 恢复成内存实现。
func SetGridFillLog(log GridFillLog) {
	gridFillMu.Lock()
	defer gridFillMu.Unlock()
	if log == nil {
		log = newMemoryGridFillLog()
	}
	gridFillLog = log
}

// currentGridFillLog 返回当前账本。**永远是同一个实例**——
// 引擎构造时拿到的和后续替换进去的要能对上，所以这里不新建。
func currentGridFillLog() GridFillLog {
	gridFillMu.RLock()
	defer gridFillMu.RUnlock()
	if gridFillLog == nil {
		return newMemoryGridFillLog()
	}
	return gridFillLog
}

func resetGridFillsForTest() {
	gridFillMu.Lock()
	defer gridFillMu.Unlock()
	if mem, ok := gridFillLog.(*memoryGridFillLog); ok {
		mem.reset()
		return
	}
	gridFillLog = newMemoryGridFillLog()
}

func (m *memoryGridFillLog) Save(fill GridFill) (int64, error) {
	if m == nil {
		return 0, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.next++
	fill.ID = m.next
	if fill.FilledAt.IsZero() {
		fill.FilledAt = fill.FilledAt.UTC()
	}
	m.rows = append(m.rows, fill)
	return fill.ID, nil
}

func (m *memoryGridFillLog) List(gridID int64, limit int) ([]GridFill, error) {
	if m == nil {
		return []GridFill{}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]GridFill, 0, len(m.rows))
	for i := len(m.rows) - 1; i >= 0; i-- {
		if m.rows[i].GridID != gridID {
			continue
		}
		out = append(out, m.rows[i])
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

/*
Holdings 按线号把每一格还没卖掉的量累加起来。

规则只有两条：
  · 买入加、卖出减；
  · **Level 为 -1 的卖出是清仓单**，不属于任何一格，它减的是"总持仓"
    而不是某一格 —— 所以它不参与这里的逐格计算。

第二条是必须的：清仓单把货一次性卖光，如果按线号去减，就会把某一格
减成负数，而那和事实不符（清仓卖的是所有格凑起来的货）。
*/
func (m *memoryGridFillLog) Holdings(gridID int64, direction GridDirection) (map[int]float64, error) {
	if m == nil {
		return map[int]float64{}, nil
	}
	short := NormalizeDirection(direction).Short()
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[int]float64{}
	for _, row := range m.rows {
		if row.GridID != gridID || row.Level < 0 {
			continue
		}
		if short {
			// 空头：SELL 开空落在自己那一格，BUY 平空减的是**下一格**
			// （买单挂在 i-1，平的是 i 那格的空）。
			switch row.Side {
			case SpotSell:
				out[row.Level] += row.Qty
			case SpotBuy:
				out[row.Level+1] -= row.Qty
			}
			continue
		}
		switch row.Side {
		case SpotBuy:
			out[row.Level] += row.Qty
		case SpotSell:
			out[row.Level-1] -= row.Qty
		}
	}
	for level, qty := range out {
		if qty <= 1e-12 {
			delete(out, level)
		}
	}
	return out, nil
}

// Summary 汇总笔数与已实现盈亏。已实现**不包含未平仓的部分**，
// 所以它和账户上的余额变化不是一个数 —— 后者还含浮动盈亏。
func (m *memoryGridFillLog) Summary(gridID int64) (int, float64, error) {
	if m == nil {
		return 0, 0, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	fills := 0
	realized := 0.0
	for _, row := range m.rows {
		if row.GridID != gridID {
			continue
		}
		fills++
		realized += row.Realized
	}
	return fills, realized, nil
}

func (m *memoryGridFillLog) reset() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.rows = nil
	m.next = 0
	m.mu.Unlock()
}

// CurrentGridFillLog 返回进程正在用的网格账本。
// 接口层建引擎时把它传进去，好让引擎和库用的是同一份账本。
func CurrentGridFillLog() GridFillLog { return currentGridFillLog() }

// GridSummaryFor 汇总某条网格的笔数与已实现盈亏。
func GridSummaryFor(gridID int64) (int, float64, error) {
	if gridID <= 0 {
		return 0, 0, nil
	}
	return currentGridFillLog().Summary(gridID)
}

// GridFillList 返回某条网格的成交明细，新的在前。
func GridFillList(gridID int64, limit int) ([]GridFill, error) {
	if gridID <= 0 {
		return []GridFill{}, nil
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := currentGridFillLog().List(gridID, limit)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []GridFill{}
	}
	return rows, nil
}

// GridHoldings 返回某条网格每一格还持有（多头）或还欠着（空头）的数量。
func GridHoldings(gridID int64, direction GridDirection) (map[int]float64, error) {
	if gridID <= 0 {
		return map[int]float64{}, nil
	}
	rows, err := currentGridFillLog().Holdings(gridID, direction)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = map[int]float64{}
	}
	return rows, nil
}

// SortedGridLevels 把持有表按线号排好，日志和测试里读起来才稳定。
func SortedGridLevels(holds map[int]float64) []int {
	out := make([]int, 0, len(holds))
	for level, qty := range holds {
		if qty > 0 {
			out = append(out, level)
		}
	}
	sort.Ints(out)
	return out
}
