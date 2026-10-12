package trading

import (
	"fmt"
	"log"
	"sort"
	"sync"
	"time"
)

// EntryStamp 是一笔开仓当时的信号和回测快照。
// 分数、门槛、是否加速/强制，以及该策略配置对应的回测统计都在这里。
// boost 与 forced 即使为 false 也要带上，开仓记录必须能看出不是加速单。
type EntryStamp struct {
	Score          int     `json:"score"`
	MinScore       int     `json:"minScore"`
	Boost          bool    `json:"boost"`
	Forced         bool    `json:"forced"`
	WinRate        float64 `json:"winRate"`
	Trades         int     `json:"trades"`
	NetR           float64 `json:"netR"`
	ExpectancyR    float64 `json:"expectancyR"`
	ExpectancyUSDT float64 `json:"expectancyUsdt"`
	OneRUSDT       float64 `json:"oneRUsdt"`
}

// EntryRecord 是一笔已经落库的开仓。历史在进程重启后仍能读回来。
type EntryRecord struct {
	ID         int64     `json:"id,omitempty"`
	UserID     int64     `json:"-"`
	StrategyID int64     `json:"strategyId,omitempty"`
	Symbol     string    `json:"symbol"`
	Side       string    `json:"side"`
	EntryPrice float64   `json:"entryPrice"`
	Qty        float64   `json:"qty"`
	OpenedAt   time.Time `json:"openedAt"`
	EntryStamp
}

// PositionOneRUSDT 是这笔仓位的 1R 金额，口径与回测 netR 的分母相同：
// 入场价 × DefaultRFraction × stopR × 数量。
// stopR 小于等于 0 时按 DefaultStopR。期望金额 = 每笔期望 R × 这个 1R。
func PositionOneRUSDT(entry, qty, stopR float64) float64 {
	if entry <= 0 || qty <= 0 {
		return 0
	}
	if stopR <= 0 {
		stopR = DefaultStopR
	}
	return entry * DefaultRFraction * stopR * qty
}

// Event 把一笔开仓收成检测事件。重启后事件环是空的，用这条把历史补回去。
func (rec EntryRecord) Event() DetectionEvent {
	stamp := rec.EntryStamp
	action := "entry"
	switch {
	case rec.Forced:
		action = "boost_forced"
	case rec.Boost:
		action = "boost_entry"
	}
	return DetectionEvent{
		TS:      rec.OpenedAt,
		Symbol:  rec.Symbol,
		Side:    rec.Side,
		Score:   rec.Score,
		WinRate: rec.WinRate,
		Action:  action,
		Msg:     fmt.Sprintf("score %d/%d", rec.Score, rec.MinScore),
		Entry:   &stamp,
	}
}

// EntryLog 保存开仓记录。内存实现只活在本进程；数据库实现负责重启后的历史。
type EntryLog interface {
	Save(EntryRecord) error
	List(userID, strategyID int64, limit int) ([]EntryRecord, error)
	Recent(limit int) ([]EntryRecord, error)
}

type memoryEntryLog struct {
	mu   sync.Mutex
	next int64
	rows []EntryRecord
}

func newMemoryEntryLog() *memoryEntryLog {
	return &memoryEntryLog{}
}

func (m *memoryEntryLog) Save(rec EntryRecord) error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.next++
	rec.ID = m.next
	m.rows = append(m.rows, rec)
	return nil
}

func (m *memoryEntryLog) List(userID, strategyID int64, limit int) ([]EntryRecord, error) {
	if m == nil {
		return []EntryRecord{}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]EntryRecord, 0)
	for i := len(m.rows) - 1; i >= 0; i-- {
		row := m.rows[i]
		if row.UserID != userID || row.StrategyID != strategyID {
			continue
		}
		out = append(out, row)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (m *memoryEntryLog) Recent(limit int) ([]EntryRecord, error) {
	if m == nil {
		return []EntryRecord{}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > len(m.rows) {
		limit = len(m.rows)
	}
	out := make([]EntryRecord, 0, limit)
	for i := len(m.rows) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, m.rows[i])
	}
	return out, nil
}

func (m *memoryEntryLog) reset() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.rows = nil
	m.next = 0
	m.mu.Unlock()
}

var (
	entryMu  sync.RWMutex
	entryLog EntryLog = newMemoryEntryLog()
)

// SetEntryLog 换成进程使用的开仓日志。nil 恢复成内存日志。
func SetEntryLog(log EntryLog) {
	entryMu.Lock()
	defer entryMu.Unlock()
	if log == nil {
		log = newMemoryEntryLog()
	}
	entryLog = log
}

func currentEntryLog() EntryLog {
	entryMu.RLock()
	defer entryMu.RUnlock()
	if entryLog == nil {
		return newMemoryEntryLog()
	}
	return entryLog
}

func resetEntriesForTest() {
	entryMu.Lock()
	defer entryMu.Unlock()
	if entryLog == nil {
		entryLog = newMemoryEntryLog()
		return
	}
	if mem, ok := entryLog.(*memoryEntryLog); ok {
		mem.reset()
	}
}

// SaveEntry 写入一笔开仓。写失败只记日志，不改变是否开仓。
func SaveEntry(rec EntryRecord) error {
	if err := currentEntryLog().Save(rec); err != nil {
		log.Printf("[trading] 保存开仓记录失败: %v", err)
		return err
	}
	return nil
}

// ListEntries 返回某条策略的开仓记录，新的在前。
func ListEntries(userID, strategyID int64, limit int) ([]EntryRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := currentEntryLog().List(userID, strategyID, limit)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []EntryRecord{}
	}
	return rows, nil
}

// RecentEntries 返回最近的开仓记录，新的在前。检测事件在重启后用它补历史。
func RecentEntries(limit int) ([]EntryRecord, error) {
	if limit <= 0 {
		limit = EventCapacity
	}
	rows, err := currentEntryLog().Recent(limit)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []EntryRecord{}
	}
	return rows, nil
}

// EventsWithEntries 把环形缓冲和已落库的开仓拼在一起。
// 同一笔开仓已经在缓冲里时不重复。重启后缓冲是空的，历史仍从日志回来。
func EventsWithEntries() []DetectionEvent {
	live := RecentEvents()
	saved, err := RecentEntries(EventCapacity)
	if err != nil {
		log.Printf("[trading] 读取开仓历史失败: %v", err)
		if live == nil {
			return []DetectionEvent{}
		}
		return live
	}
	return mergeEntryEvents(live, saved)
}

func mergeEntryEvents(live []DetectionEvent, saved []EntryRecord) []DetectionEvent {
	out := append([]DetectionEvent{}, live...)
	for _, rec := range saved {
		if entryAlreadyListed(out, rec) {
			continue
		}
		out = append(out, rec.Event())
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].TS.Before(out[j].TS)
	})
	if out == nil {
		out = []DetectionEvent{}
	}
	return out
}

func entryAlreadyListed(events []DetectionEvent, rec EntryRecord) bool {
	for _, ev := range events {
		if ev.Entry == nil || ev.Symbol != rec.Symbol || ev.Side != rec.Side {
			continue
		}
		if ev.TS.Equal(rec.OpenedAt) {
			return true
		}
		delta := ev.TS.Sub(rec.OpenedAt)
		if delta < 0 {
			delta = -delta
		}
		if delta <= time.Second {
			return true
		}
	}
	return false
}
