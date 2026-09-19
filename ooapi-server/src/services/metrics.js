// 运维监控：系统资源 + 网关运行时指标
// ---------------------------------------------------------------------------
// 为什么自己采集而不是引 Prometheus 客户端：
//   本项目规范禁止新增依赖，而 Node 内置模块已经能拿到全部需要的指标 ——
//   os.cpus/totalmem/freemem/loadavg、process.memoryUsage/uptime、
//   fs.statfs（磁盘）、perf_hooks.monitorEventLoopDelay（事件循环延迟）、
//   pool 的连接状态（mysql2 自带）。
//
// 指标分两类：
//   · 采样型（CPU/内存/磁盘/事件循环）：每次调用现取，无状态；
//   · 累计型（请求数/错误数/延迟分位）：进程内累计，随服务重启清零 ——
//     跨重启的历史请看 logs 表（使用记录/操作日志），监控页只反映「当前进程」。
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pool } from "../db.js";

const START_AT = Date.now();

// 事件循环延迟直方图（1ms 精度；只统计「上一次采样到现在」，取每次快照的差值）
const loopHist = monitorEventLoopDelay({ resolution: 20 });
try {
  loopHist.enable();
} catch {
  /* 某些环境不支持，降级为不采集 */
}

// ---------------------------------------------------------------------------
// 累计指标（进程内）
// ---------------------------------------------------------------------------
const counters = {
  requests: 0,      // 网关 + 站内对话的总调用数
  errors: 0,        // 其中失败数
  byStatus: new Map(), // HTTP 状态码分布
  latency: [],      // 最近的延迟样本（环形，用于分位）
  inFlight: 0,      // 当前在途
  peakInFlight: 0,  // 峰值在途
  byModel: new Map(), // model -> { calls, errors, totalMs }
  byChannel: new Map(), // channelName -> { calls, errors, totalMs }
};
const LATENCY_WINDOW = 1000; // 保留最近 1000 次用于分位（内存可控）

/** 记一次请求结果（由网关/对话在结束时调用） */
export function recordRequest({ ok = true, status = 200, ms = 0, model = "", channel = "" } = {}) {
  counters.requests += 1;
  if (!ok) counters.errors += 1;
  counters.byStatus.set(status, (counters.byStatus.get(status) || 0) + 1);
  if (ms > 0) {
    counters.latency.push(ms);
    if (counters.latency.length > LATENCY_WINDOW) counters.latency.shift();
  }
  if (model) {
    const m = counters.byModel.get(model) || { calls: 0, errors: 0, totalMs: 0 };
    m.calls += 1;
    if (!ok) m.errors += 1;
    m.totalMs += ms;
    counters.byModel.set(model, m);
  }
  if (channel) {
    const c = counters.byChannel.get(channel) || { calls: 0, errors: 0, totalMs: 0 };
    c.calls += 1;
    if (!ok) c.errors += 1;
    c.totalMs += ms;
    counters.byChannel.set(channel, c);
  }
}

/** 在途计数（请求进入/离开时各调一次） */
export function enterRequest() {
  counters.inFlight += 1;
  if (counters.inFlight > counters.peakInFlight) counters.peakInFlight = counters.inFlight;
}
export function leaveRequest() {
  counters.inFlight = Math.max(0, counters.inFlight - 1);
}

/** 百分位（线性插值；样本不足时返回最后一个） */
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

// ---------------------------------------------------------------------------
// 采样型指标
// ---------------------------------------------------------------------------

// CPU 使用率需要两次采样求差（os.cpus() 给的是累计 tick）
let lastCpu = null;
function cpuUsage() {
  const cpus = os.cpus() || [];
  const snap = cpus.map((c) => {
    const t = c.times || {};
    return { idle: t.idle || 0, total: (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0) + (t.idle || 0) };
  });
  if (!lastCpu || lastCpu.length !== snap.length) {
    lastCpu = snap;
    return null; // 首次采样没有基线，返回 null 让前端显示「计算中」
  }
  let idleDiff = 0;
  let totalDiff = 0;
  for (let i = 0; i < snap.length; i += 1) {
    idleDiff += snap[i].idle - lastCpu[i].idle;
    totalDiff += snap[i].total - lastCpu[i].total;
  }
  lastCpu = snap;
  if (totalDiff <= 0) return null;
  return Math.max(0, Math.min(100, Number((((totalDiff - idleDiff) / totalDiff) * 100).toFixed(1))));
}

/** 磁盘（Node 18.15+ 的 fs.statfs；取后端进程所在分区） */
function diskUsage() {
  try {
    const st = fs.statfsSync(path.resolve(process.cwd(), ".."));
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    if (!total) return null;
    return {
      totalBytes: total,
      freeBytes: free,
      usedBytes: total - free,
      usedPercent: Number((((total - free) / total) * 100).toFixed(1)),
    };
  } catch {
    return null; // Windows 老版本 / 不支持的文件系统
  }
}

/** 事件循环延迟（读取后重置直方图，得到「本区间」的统计而不是进程启动至今） */
function eventLoop() {
  try {
    const p50 = loopHist.percentile(50) / 1e6; // 纳秒 → 毫秒
    const p99 = loopHist.percentile(99) / 1e6;
    const max = loopHist.max / 1e6;
    loopHist.reset();
    return {
      p50Ms: Number(p50.toFixed(2)),
      p99Ms: Number(p99.toFixed(2)),
      maxMs: Number(max.toFixed(2)),
    };
  } catch {
    return null;
  }
}

/** MySQL 连接池状态（mysql2 的 pool 暴露内部连接数组） */
function poolStats() {
  try {
    const all = pool.pool?._allConnections?.length ?? 0;
    const free = pool.pool?._freeConnections?.length ?? 0;
    const queue = pool.pool?._connectionQueue?.length ?? 0;
    return { total: all, free, inUse: Math.max(0, all - free), queued: queue };
  } catch {
    return null;
  }
}

/** 汇总所有指标 */
export function snapshot() {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const proc = process.memoryUsage();
  const lat = counters.latency;

  // 按模型/渠道排行（按调用数）
  const topModels = [...counters.byModel.entries()]
    .map(([model, v]) => ({
      model,
      calls: v.calls,
      errors: v.errors,
      successRate: v.calls ? Number((((v.calls - v.errors) / v.calls) * 100).toFixed(1)) : null,
      avgMs: v.calls ? Math.round(v.totalMs / v.calls) : 0,
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);
  const topChannels = [...counters.byChannel.entries()]
    .map(([channel, v]) => ({
      channel,
      calls: v.calls,
      errors: v.errors,
      successRate: v.calls ? Number((((v.calls - v.errors) / v.calls) * 100).toFixed(1)) : null,
      avgMs: v.calls ? Math.round(v.totalMs / v.calls) : 0,
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);

  return {
    // ---- 进程 ----
    process: {
      uptimeSec: Math.floor((Date.now() - START_AT) / 1000),
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      pid: process.pid,
      rssBytes: proc.rss,
      heapUsedBytes: proc.heapUsed,
      heapTotalBytes: proc.heapTotal,
      externalBytes: proc.external,
      // 外部内存（Buffer 等）快速增长通常意味着流式响应没释放
    },
    // ---- 系统 ----
    system: {
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || "",
      cpuPercent: cpuUsage(),
      // loadavg 在 Windows 恒为 0；前端据此隐藏该指标
      loadavg: os.platform() === "win32" ? null : os.loadavg().map((n) => Number(n.toFixed(2))),
      totalMemBytes: totalMem,
      freeMemBytes: freeMem,
      usedMemPercent: Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1)),
      disk: diskUsage(),
      hostname: os.hostname(),
    },
    // ---- 事件循环 ----
    eventLoop: eventLoop(),
    // ---- 数据库连接池 ----
    pool: poolStats(),
    // ---- 网关运行时 ----
    gateway: {
      requests: counters.requests,
      errors: counters.errors,
      successRate: counters.requests
        ? Number((((counters.requests - counters.errors) / counters.requests) * 100).toFixed(2))
        : null,
      inFlight: counters.inFlight,
      peakInFlight: counters.peakInFlight,
      byStatus: [...counters.byStatus.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => a.status - b.status),
      latency: {
        samples: lat.length,
        avgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
        p50Ms: percentile(lat, 0.5),
        p95Ms: percentile(lat, 0.95),
        p99Ms: percentile(lat, 0.99),
      },
      topModels,
      topChannels,
    },
    fetchedAt: Date.now(),
  };
}
