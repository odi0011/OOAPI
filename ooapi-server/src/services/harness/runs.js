// 进行中的对话运行（断线续传）
// ---------------------------------------------------------------------------
// 为什么需要它：用户在生成过程中切换页面 / 刷新浏览器时，如果直接把上游请求 abort，
// 那一轮就白花钱了（上游已经产出、也已计费）。这里的做法是：
//   · 运行本身跑在服务端，与某个 HTTP 连接解绑（客户端断开不 abort）；
//   · 事件进环形缓冲，重连的客户端先回放缓冲再接着收实时事件；
//   · 前端刷新后重新订阅同一会话即可看到完整过程与最终结果。
// 边界：缓冲只在内存里（进程重启即丢失，那一轮按已产出内容照常计费），
// 且同一个会话同一时刻只允许一个运行（重复提交直接拒绝，避免双份计费）。
const MAX_EVENTS = 4000; // 增量事件有界；超过上限后用完整 part 快照恢复文本。

const runs = new Map(); // sessionId -> run

export function getRun(sessionId) {
  return runs.get(String(sessionId)) || null;
}

export function isRunning(sessionId) {
  const r = runs.get(String(sessionId));
  return Boolean(r && !r.settled);
}

/**
 * 开始一轮运行。同一会话已在运行时返回 null（调用方据此拒绝重复提交）。
 * @param {string} sessionId
 * @param {object} meta { userId, startedAt }
 */
export function startRun(sessionId, meta = {}) {
  const key = String(sessionId);
  const existing = runs.get(key);
  if (existing && !existing.settled) return null;
  const run = {
    sessionId: key,
    userId: meta.userId,
    startedAt: meta.startedAt || Date.now(),
    settled: false,
    events: [],
    subscribers: new Set(),
    error: null,
    // 当增量事件超过环形缓冲时，保留每个 part 的最新快照，重连不会从一个
    // 缺失的 `part` 开始应用 delta，导致长回答刷新后只剩半截。
    snapshots: new Map(),
    dropped: false,
  };
  runs.set(key, run);
  return run;
}

/** 记录一个事件：进缓冲 + 广播给所有订阅者 */
export function publish(run, event) {
  if (!run) return;
  if (event.type === "part" && event.part?.id) run.snapshots.set(event.part.id, { ...event.part });
  else if (event.type === "part_update" && event.id && run.snapshots.has(event.id)) run.snapshots.set(event.id, { ...run.snapshots.get(event.id), ...event.patch });
  else if (event.type === "delta" && event.id && run.snapshots.has(event.id)) {
    const part = run.snapshots.get(event.id);
    run.snapshots.set(event.id, { ...part, [event.field]: `${part[event.field] || ""}${event.delta || ""}` });
  }
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) {
    run.events.splice(0, run.events.length - MAX_EVENTS);
    run.dropped = true;
  }
  for (const fn of run.subscribers) {
    try {
      fn(event);
    } catch {
      /* 单个订阅者写失败不影响其他人 */
    }
  }
}

/**
 * 结束一轮运行：标记 settled、广播收尾事件、把订阅者踢掉。
 * 保留 5 分钟再清理，让「刚跑完就刷新」的客户端还能拿到 done/error 状态。
 */
export function finishRun(run, finalEvent) {
  if (!run) return;
  if (finalEvent) publish(run, finalEvent);
  run.settled = true;
  run.endedAt = Date.now();
  const subs = [...run.subscribers];
  run.subscribers.clear();
  for (const fn of subs) {
    try {
      fn(null); // null = 流结束信号
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    const cur = runs.get(run.sessionId);
    if (cur === run && cur.settled) runs.delete(run.sessionId);
  }, 5 * 60 * 1000).unref?.();
}

/**
 * 订阅一轮运行：先回放已缓冲的事件，再接着收实时的。
 * @returns {Function} 取消订阅
 */
export function subscribe(run, onEvent) {
  if (!run) return () => {};
  if (run.dropped && run.snapshots.size) {
    try { onEvent({ type: "snapshot", parts: [...run.snapshots.values()].map((p) => ({ ...p })) }); } catch { /* ignore */ }
  }
  for (const ev of run.events) {
    // snapshot 已包含所有增量文本；再次回放 delta 会把尾部重复追加。
    if (run.dropped && ["part", "part_update", "delta"].includes(ev.type)) continue;
    try {
      onEvent(ev);
    } catch {
      /* ignore */
    }
  }
  if (run.settled) {
    onEvent(null);
    return () => {};
  }
  run.subscribers.add(onEvent);
  return () => run.subscribers.delete(onEvent);
}

/** 当前运行状态（供前端判断「要不要连上」） */
export function runStatus(sessionId) {
  const run = runs.get(String(sessionId));
  if (!run) return { running: false };
  return {
    running: !run.settled,
    startedAt: run.startedAt,
    endedAt: run.endedAt || 0,
    events: run.events.length,
    error: run.error,
  };
}
