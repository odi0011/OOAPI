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
//
// 「业务限制」与「上游错误」的区分（对齐 sub2api 的 SLA 口径）：
//   · 业务限制 businessLimited：余额不足 / 配额超限 / 密钥无效 / 渠道不可用 ——
//     这是我们自己的策略拦下的，不是上游故障，**不计入 SLA 分母**；
//   · 上游错误 upstreamErrors：真正打到上游后失败（排除 429 限流、529 过载 ——
//     这两个是上游的正常保护行为，单独计数）；
//   · SLA 成功率 = 成功 /（总请求 - 业务限制）。
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pool } from "../db.js";

const START_AT = Date.now();

// 事件循环延迟直方图（1ms 精度；只统计「上一次采样到现在」，取每次快照的差值）
const loopHist = monitorEventLoopDelay({ resolution: 20 });
try {
  loopHist.enable();
} catch {
  /* 某些环境不支持，降级为不采集 */
}
let lastElu = null; // 事件循环利用率（比延迟直方图更省，两者互补）

// ---------------------------------------------------------------------------
// 累计指标（进程内）
// ---------------------------------------------------------------------------
const counters = {
  requests: 0,      // 网关 + 站内对话的总调用数
  errors: 0,        // 其中失败数
  businessLimited: 0, // 业务限制（余额/配额/密钥/渠道不可用），不计入 SLA
  upstreamErrors: 0,  // 上游错误（排除 429/529）
  upstream429: 0,
  upstream529: 0,
  firstTokenSamples: [], // 首 token 延迟样本（环形）
  byStatus: new Map(), // HTTP 状态码分布
  latency: [],      // 最近的延迟样本（环形，用于分位）
  inFlight: 0,      // 当前在途
  peakInFlight: 0,  // 峰值在途
  byModel: new Map(), // model -> { calls, errors, totalMs, ttft:[] }
  byChannel: new Map(), // channelName -> { calls, errors, totalMs, ttft:[] }
  byUser: new Map(), // userId -> { calls, errors, totalMs }
  byVendor: new Map(), // vendor -> { calls, errors, totalMs }
  ctxSwitch: 0,     // 账号切换次数（failover/重试换号）
  // 分钟桶：{ min: epochMinute, calls, errors, tokens } —— 用于 QPS/TPS 趋势
  buckets: new Map(),
};
const LATENCY_WINDOW = 1000; // 保留最近 1000 次用于分位（内存可控）
const BUCKET_KEEP = 180;     // 保留最近 180 分钟的时间桶

function bucketAt(ts = Date.now()) {
  const min = Math.floor(ts / 60000);
  let b = counters.buckets.get(min);
  if (!b) {
    b = { min, calls: 0, errors: 0, tokens: 0, ttftSum: 0, ttftCount: 0 };
    counters.buckets.set(min, b);
    if (counters.buckets.size > BUCKET_KEEP) {
      const cutoff = min - BUCKET_KEEP;
      for (const k of counters.buckets.keys()) if (k < cutoff) counters.buckets.delete(k);
    }
  }
  return b;
}

/**
 * 记一次请求结果（由网关/对话在结束时调用）
 * @param {object} o
 * @param {boolean} o.ok            是否成功
 * @param {number}  o.status        HTTP 状态码
 * @param {number}  o.ms            总耗时
 * @param {number}  [o.ttftMs]      首 token 耗时（流式才有）
 * @param {string}  [o.model]
 * @param {string}  [o.channel]
 * @param {number}  [o.userId]
 * @param {string}  [o.vendor]
 * @param {number}  [o.tokens]      本次消耗 token 数（用于 TPS）
 * @param {string}  [o.errorCode]   错误码（用于区分业务限制 / 上游错误）
 * @param {number}  [o.upstreamStatus] 上游返回的状态码
 */
export function recordRequest(o = {}) {
  const {
    ok = true,
    status = 200,
    ms = 0,
    ttftMs = 0,
    model = "",
    channel = "",
    userId = 0,
    vendor = "",
    tokens = 0,
    errorCode = "",
    upstreamStatus = 0,
  } = o;

  counters.requests += 1;
  if (!ok) counters.errors += 1;
  counters.byStatus.set(status, (counters.byStatus.get(status) || 0) + 1);

  // 错误归类：业务限制 vs 上游错误（对齐 sub2api 的 SLA 口径）
  if (!ok) {
    if (BUSINESS_LIMIT_CODES.has(errorCode)) {
      counters.businessLimited += 1;
    } else {
      const us = Number(upstreamStatus) || 0;
      if (us === 429) counters.upstream429 += 1;
      else if (us === 529) counters.upstream529 += 1;
      else counters.upstreamErrors += 1; // 429/529 是上游的保护性限流，单列后不再计入故障
    }
  }

  const b = bucketAt();
  b.calls += 1;
  if (!ok) b.errors += 1;
  b.tokens += Number(tokens) || 0;

  if (ms > 0) {
    counters.latency.push(ms);
    if (counters.latency.length > LATENCY_WINDOW) counters.latency.shift();
  }
  if (ttftMs > 0) {
    counters.firstTokenSamples.push(ttftMs);
    if (counters.firstTokenSamples.length > LATENCY_WINDOW) counters.firstTokenSamples.shift();
    b.ttftSum += ttftMs;
    b.ttftCount += 1;
  }
  const bump = (map, key, extra) => {
    if (!key) return;
    const v = map.get(key) || { calls: 0, errors: 0, totalMs: 0, ttftSum: 0, ttftCount: 0 };
    v.calls += 1;
    if (!ok) v.errors += 1;
    v.totalMs += ms;
    if (ttftMs > 0) {
      v.ttftSum += ttftMs;
      v.ttftCount += 1;
    }
    if (extra) Object.assign(v, extra);
    map.set(key, v);
  };
  bump(counters.byModel, model);
  bump(counters.byChannel, channel);
  bump(counters.byUser, userId || 0);
  bump(counters.byVendor, vendor);
}

/** 记一次账号切换（failover / 重试换号），用于「账号切换率」趋势 */
export function recordChannelSwitch() {
  counters.ctxSwitch += 1;
}

// 业务限制错误码：这些是我们自己的策略拦下的，不是上游故障
const BUSINESS_LIMIT_CODES = new Set([
  "INSUFFICIENT_QUOTA",
  "QUOTA_EXHAUSTED",
  "TOKEN_INVALID",
  "TOKEN_DISABLED",
  "USER_DISABLED",
  "USER_BANNED",
  "MODEL_NOT_ALLOWED",
  "GROUP_UNAVAILABLE",
  "CHANNEL_EMPTY",       // 无可用渠道：是配置问题，不是上游故障
  "CHANNEL_UNSUPPORTED",
  "CHANNEL_MUTED",       // 账号被风控静默：属于账号状态，不是上游服务故障
  "RATE_LIMITED_LOCAL",  // 本地限流（用户侧 RPM/TPM 超限）
]);

/**
 * 把一次失败的异常归类成监控需要的维度。
 * 上游状态码优先取 err.upstreamStatus（适配器可显式带上），
 * 其次从「上游返回 HTTP 429」这类消息里解析 —— 适配器众多，
 * 逐个改注解不如在这里统一兜底，也不影响错误消息本身。
 */
export function classifyError(err) {
  const code = String(err?.code || "");
  const businessLimited = BUSINESS_LIMIT_CODES.has(code);
  let upstreamStatus = Number(err?.upstreamStatus) || 0;
  if (!upstreamStatus) {
    const m = /上游返回 HTTP (\d{3})/.exec(String(err?.message || ""));
    if (m) upstreamStatus = Number(m[1]);
  }
  // 被上游限流也算 429：sub2api 的 SLA 口径就是把 429/529 排除在「上游错误」之外
  if (!upstreamStatus && code === "CHANNEL_RATE_LIMIT") upstreamStatus = 429;
  return { errorCode: code, businessLimited, upstreamStatus };
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

/** 分位族：p50/p90/p95/p99/avg/max（sub2api 的 duration/ttft 卡片就是这一组） */
function quantiles(arr) {
  if (!arr.length) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    samples: arr.length,
    avgMs: Math.round(sum / arr.length),
    p50Ms: percentile(arr, 0.5),
    p90Ms: percentile(arr, 0.9),
    p95Ms: percentile(arr, 0.95),
    p99Ms: percentile(arr, 0.99),
    maxMs: Math.max(...arr),
  };
}

/** 直方图分桶（成功请求的耗时分布；sub2api 的 Request Duration Histogram） */
function histogram(arr, edges = [0, 100, 300, 500, 1000, 2000, 3000, 5000, 10000, 30000, Infinity]) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const count = arr.filter((v) => v >= lo && v < hi).length;
    out.push({ range: hi === Infinity ? `${lo}ms+` : `${lo}-${hi}ms`, lo, hi: hi === Infinity ? null : hi, count });
  }
  return out;
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

// 进程级 CPU（os.cpus 是全机器；进程自己占多少只有 process.cpuUsage 知道）——
// 这一项 sub2api 没有：能区分「机器忙」和「我们自己的 Node 卡」
let lastProcCpu = null;
function processCpu() {
  const u = process.cpuUsage();
  const now = Date.now();
  if (!lastProcCpu) {
    lastProcCpu = { u, at: now };
    return null;
  }
  const elapsedMs = now - lastProcCpu.at;
  if (elapsedMs <= 0) return null;
  const userMs = (u.user - lastProcCpu.u.user) / 1000;
  const sysMs = (u.system - lastProcCpu.u.system) / 1000;
  lastProcCpu = { u, at: now };
  const cores = (os.cpus() || []).length || 1;
  return {
    percent: Number((((userMs + sysMs) / elapsedMs) * 100).toFixed(1)), // 占单核的百分比（可 >100）
    percentOfMachine: Number((((userMs + sysMs) / elapsedMs / cores) * 100).toFixed(1)), // 占整机
    userMs: Math.round(userMs),
    systemMs: Math.round(sysMs),
  };
}

/** 磁盘（Node 18.15+ 的 fs.statfs；Windows 上必须给盘符根，否则可能 ENOSYS） */
function diskUsage() {
  const tryPath = (p) => {
    const st = fs.statfsSync(p);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    if (!total) return null;
    return {
      path: p,
      totalBytes: total,
      freeBytes: free,
      usedBytes: total - free,
      usedPercent: Number((((total - free) / total) * 100).toFixed(1)),
    };
  };
  const targets = [path.resolve(process.cwd(), ".."), path.parse(process.cwd()).root];
  for (const t of targets) {
    try {
      const r = tryPath(t);
      if (r) return r;
    } catch {
      /* 换下一个候选路径 */
    }
  }
  return null; // 老 Node / 不支持的文件系统
}

/** 事件循环延迟（读取后重置直方图，得到「本区间」的统计而不是进程启动至今） */
function eventLoop() {
  let delay = null;
  try {
    const p50 = loopHist.percentile(50) / 1e6; // 纳秒 → 毫秒
    const p99 = loopHist.percentile(99) / 1e6;
    const max = loopHist.max / 1e6;
    loopHist.reset(); // 必须 reset，否则是进程启动至今的累计值
    delay = {
      p50Ms: Number(p50.toFixed(2)),
      p99Ms: Number(p99.toFixed(2)),
      maxMs: Number(max.toFixed(2)),
    };
  } catch {
    delay = null;
  }
  let utilization = null;
  try {
    const elu = performance.eventLoopUtilization(lastElu || undefined);
    lastElu = performance.eventLoopUtilization();
    utilization = Number(elu.utilization.toFixed(3)); // 0~1
  } catch {
    utilization = null;
  }
  if (!delay && utilization == null) return null;
  return { ...(delay || {}), utilization };
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

/** 运行时活动资源（Node 没有 goroutine，用活动句柄数作类比 —— 泄漏时只增不减） */
function resources() {
  let activeHandles = null;
  try {
    activeHandles = process.getActiveResourcesInfo?.().length ?? null;
  } catch {
    activeHandles = null;
  }
  let ru = null;
  try {
    const r = process.resourceUsage();
    ru = {
      maxRssBytes: r.maxRSS * 1024, // Linux 上是 KB；Windows 上单位不同，仅作趋势参考
      voluntarySwitches: r.voluntaryContextSwitches,
      involuntarySwitches: r.involuntaryContextSwitches,
      fsRead: r.fsRead,
      fsWrite: r.fsWrite,
    };
  } catch {
    ru = null;
  }
  return { activeHandles, resourceUsage: ru };
}

// ---------------------------------------------------------------------------
// 时间桶趋势（QPS/TPS 当前/峰值/平均 + 错误趋势）
// ---------------------------------------------------------------------------
function trend() {
  const nowMin = Math.floor(Date.now() / 60000);
  const series = [];
  for (let i = 59; i >= 0; i -= 1) {
    const min = nowMin - i;
    const b = counters.buckets.get(min);
    series.push({
      minute: min,
      calls: b?.calls || 0,
      errors: b?.errors || 0,
      tokens: b?.tokens || 0,
      qps: b ? Number((b.calls / 60).toFixed(3)) : 0,
      tps: b ? Number((b.tokens / 60).toFixed(2)) : 0,
      avgTtftMs: b?.ttftCount ? Math.round(b.ttftSum / b.ttftCount) : 0,
    });
  }
  const lastMin = series[series.length - 1];
  const prevMin = series[series.length - 2];
  const nonEmpty = series.filter((s) => s.calls > 0);
  const avg = (key) =>
    nonEmpty.length ? Number((nonEmpty.reduce((a, b) => a + b[key], 0) / nonEmpty.length).toFixed(3)) : 0;
  const peak = (key) => nonEmpty.reduce((a, b) => Math.max(a, b[key]), 0);
  return {
    series,
    qps: { current: lastMin.qps, prev: prevMin.qps, peak: peak("qps"), avg: avg("qps") },
    tps: { current: lastMin.tps, prev: prevMin.tps, peak: peak("tps"), avg: avg("tps") },
  };
}

/**
 * 按时间窗口聚合分钟桶 —— 让告警规则的 window_min 真正生效。
 *
 * 为什么需要它：进程内累计计数器是「进程启动至今」，用它求值等于 window_min 摆设。
 * minuteBuckets 保留了最近 180 分钟的分桶数据，按窗口求和即可得到真实窗口值
 * （错误率、成功率、调用数）。窗口超过保留时长时按「有数据的桶」计算并标注 partial。
 *
 * @param {number} windowMin 窗口分钟数
 */
export function windowStats(windowMin = 5) {
  const w = Math.max(1, Math.floor(windowMin));
  const nowMin = Math.floor(Date.now() / 60000);
  const from = nowMin - w + 1;
  let calls = 0;
  let errors = 0;
  let tokens = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let covered = 0;
  for (const [min, b] of counters.buckets.entries()) {
    if (min < from || min > nowMin) continue;
    calls += b.calls;
    errors += b.errors;
    tokens += b.tokens;
    ttftSum += b.ttftSum;
    ttftCount += b.ttftCount;
    covered += 1;
  }
  const oldest = Math.min(...counters.buckets.keys(), nowMin);
  return {
    windowMin: w,
    // 覆盖是否完整：进程刚启动或窗口长于保留时长时为 false，前端可标注「样本不足」
    partial: covered < w || oldest > from,
    coveredMinutes: covered,
    calls,
    errors,
    tokens,
    successRate: calls ? Number((((calls - errors) / calls) * 100).toFixed(2)) : null,
    errorRate: calls ? Number(((errors / calls) * 100).toFixed(2)) : null,
    avgTtftMs: ttftCount ? Math.round(ttftSum / ttftCount) : 0,
    qps: Number((calls / (w * 60)).toFixed(3)),
    tps: Number((tokens / (w * 60)).toFixed(2)),
  };
}

/** 汇总所有指标 */
export function snapshot() {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const proc = process.memoryUsage();
  const lat = counters.latency;
  const ttft = counters.firstTokenSamples;

  const rank = (map, keyName, limit = 10) =>
    [...map.entries()]
      .map(([key, v]) => ({
        [keyName]: key,
        calls: v.calls,
        errors: v.errors,
        successRate: v.calls ? Number((((v.calls - v.errors) / v.calls) * 100).toFixed(1)) : null,
        avgMs: v.calls ? Math.round(v.totalMs / v.calls) : 0,
        avgTtftMs: v.ttftCount ? Math.round(v.ttftSum / v.ttftCount) : 0,
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, limit);

  // SLA：排除业务限制后的成功率（余额不足/配额超限不算我们的锅）
  const slaDenom = counters.requests - counters.businessLimited;
  const sla = slaDenom > 0 ? Number((((slaDenom - counters.errors + counters.businessLimited) / slaDenom) * 100).toFixed(2)) : null;

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
      arrayBuffersBytes: proc.arrayBuffers,
      // 外部内存/Buffer 快速增长通常意味着流式响应没释放（sub2api 没有这一项）
      cpu: processCpu(),
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
      osUptimeSec: Math.floor(os.uptime()),
    },
    // ---- 事件循环 ----
    eventLoop: eventLoop(),
    // ---- 运行时资源 ----
    resources: resources(),
    // ---- 数据库连接池 ----
    pool: poolStats(),
    // ---- 网关运行时 ----
    gateway: {
      requests: counters.requests,
      errors: counters.errors,
      businessLimited: counters.businessLimited,
      successRate: counters.requests
        ? Number((((counters.requests - counters.errors) / counters.requests) * 100).toFixed(2))
        : null,
      sla,
      // 上游错误：排除 429/529（上游的正常保护行为，单列计数）
      upstream: {
        errors: counters.upstreamErrors,
        rate: counters.requests
          ? Number(((counters.upstreamErrors / counters.requests) * 100).toFixed(2))
          : null,
        count429: counters.upstream429,
        count529: counters.upstream529,
      },
      errorRate: counters.requests
        ? Number(((counters.errors / counters.requests) * 100).toFixed(2))
        : null,
      channelSwitches: counters.ctxSwitch,
      switchRate: counters.requests
        ? Number(((counters.ctxSwitch / counters.requests) * 100).toFixed(2))
        : null,
      inFlight: counters.inFlight,
      peakInFlight: counters.peakInFlight,
      byStatus: [...counters.byStatus.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => a.status - b.status),
      latency: quantiles(lat) || { samples: 0, avgMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 },
      ttft: quantiles(ttft),
      latencyHistogram: histogram(lat),
      topModels: rank(counters.byModel, "model"),
      topChannels: rank(counters.byChannel, "channel"),
      topUsers: rank(counters.byUser, "userId"),
      topVendors: rank(counters.byVendor, "vendor"),
    },
    // ---- 时间桶趋势 ----
    trend: trend(),
    // ---- 窗口聚合（让告警规则的 window_min 真正生效）----
    windows: {
      m1: windowStats(1),
      m5: windowStats(5),
      m60: windowStats(60),
    },
    fetchedAt: Date.now(),
  };
}

/**
 * 健康分（0-100）：照 sub2api 的权重 —— 业务健康 70% + 基础设施 30%
 *   业务健康 = 错误率 50% + TTFT 50%（1% 错误/1s TTFT 得满分，10% 错误/3s TTFT 得 0 分）
 *   基础设施 = 存储 40%（DB 不可用 = 0）+ 计算资源 30%（CPU>80%、内存>85% 扣分）+ 后台任务 30%
 * 空闲时（无流量）返回 idle，而不是给个低分误导人。
 */
export function healthScore(extra = {}) {
  const snap = snapshot();
  const g = snap.gateway;
  const { dbOk = true, jobOk = true, jobDetail = null } = extra;
  const hasTraffic = g.requests >= 10;

  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  // 错误率：1% → 100 分，10% → 0 分（线性）
  const errPct = Number(g.errorRate) || 0;
  const errScore = clamp01(1 - (errPct - 1) / 9) * 100;
  // TTFT P99：1s → 100 分，3s → 0 分（线性）；无 TTFT 样本时用延迟 P95 兜底
  const ttftP99 = g.ttft?.p99Ms || g.latency?.p95Ms || 0;
  const ttftScore = clamp01(1 - (ttftP99 / 1000 - 1) / 2) * 100;

  const business = hasTraffic ? errScore * 0.5 + ttftScore * 0.5 : null;

  const diskScore = snap.system.disk ? clamp01(1 - Math.max(0, snap.system.disk.usedPercent - 70) / 30) * 100 : 100;
  const storage = dbOk ? diskScore : 0;
  const cpu = snap.system.cpuPercent ?? 0;
  const mem = snap.system.usedMemPercent ?? 0;
  let compute = 100;
  if (cpu > 80) compute -= Math.min(50, (cpu - 80) * 2.5);
  if (mem > 85) compute -= Math.min(50, (mem - 85) * 3.33);
  compute = clamp01(compute / 100) * 100;
  const jobs = jobOk ? 100 : 0;

  const infra = storage * 0.4 + compute * 0.3 + jobs * 0.3;
  const score = business == null ? infra : business * 0.7 + infra * 0.3;

  return {
    score: Math.round(score),
    level: !hasTraffic ? "idle" : score >= 90 ? "healthy" : score >= 70 ? "degraded" : "risk",
    hasTraffic,
    parts: {
      business: business == null ? null : Math.round(business),
      infra: Math.round(infra),
      errorRate: g.errorRate,
      ttftP99Ms: g.ttft?.p99Ms ?? null,
      sla: g.sla,
      diskUsedPercent: snap.system.disk?.usedPercent ?? null,
      cpuPercent: cpu,
      memPercent: mem,
      dbOk,
      jobOk,
      jobDetail,
    },
  };
}

/**
 * 智能诊断（规则引擎）：产出「现象 / 影响 / 建议」三段式
 * 纯字符串拼装，不引入任何依赖。
 */
export function diagnose(extra = {}) {
  const snap = snapshot();
  const g = snap.gateway;
  const sys = snap.system;
  const items = [];
  const add = (severity, title, impact, advice) => items.push({ severity, title, impact, advice });

  if (extra.dbOk === false) add("critical", "数据库连接不可用", "所有需要读写数据库的接口都会失败，包括登录与计费", "检查 MySQL 进程与连接配置（DB_HOST/DB_USER/DB_PASSWORD），确认网络可达");
  if (extra.redisOk === false) add("warning", "Redis 不可用", "缓存类功能降级（本项目未依赖 Redis，如已配置请检查）", "确认 Redis 服务状态");

  const cpu = sys.cpuPercent;
  if (cpu != null && cpu > 90) add("critical", `CPU 使用率过高（${cpu}%）`, "请求排队变慢，首 token 延迟升高", "检查是否有 CPU 密集型任务，考虑扩容或优化代码");
  else if (cpu != null && cpu > 80) add("warning", `CPU 使用率偏高（${cpu}%）`, "高并发时可能出现延迟抖动", "观察趋势，必要时限制并发或扩容");

  const mem = sys.usedMemPercent;
  if (mem > 90) add("critical", `内存使用率过高（${mem}%）`, "可能触发 OOM 重启，导致在途请求全部失败", "检查进程 RSS 是否持续上涨，必要时重启或扩容");
  else if (mem > 85) add("warning", `内存使用率偏高（${mem}%）`, "长时间运行可能逼近上限", "观察 Buffer 占用（arrayBuffers）是否只增不减");

  if (sys.disk && sys.disk.usedPercent > 90) add("critical", `磁盘剩余空间不足（已用 ${sys.disk.usedPercent}%）`, "日志无法写入，数据库可能停止工作", "清理日志表或扩容磁盘");
  else if (sys.disk && sys.disk.usedPercent > 80) add("warning", `磁盘使用率偏高（${sys.disk.usedPercent}%）`, "日志持续增长会很快占满", "检查日志保留天数设置，或清理历史日志");

  const ttftP99 = g.ttft?.p99Ms;
  if (ttftP99 && ttftP99 > 3000) add("critical", `首 Token 延迟 P99 过高（${ttftP99}ms）`, "用户明显感觉「卡住了」", "检查上游渠道响应、事件循环延迟与连接池排队");
  else if (ttftP99 && ttftP99 > 1500) add("warning", `首 Token 延迟 P99 偏高（${ttftP99}ms）`, "流式体验变差", "对比各渠道首 token 耗时，考虑调整路由优先级");

  if (g.errorRate != null && g.errorRate > 10) add("critical", `请求错误率过高（${g.errorRate}%）`, "大量用户请求失败", "查看错误日志定位是上游故障还是配置问题");
  else if (g.errorRate != null && g.errorRate > 5) add("warning", `请求错误率偏高（${g.errorRate}%）`, "部分用户受影响", "关注上游错误率与 429/529 计数");

  if (g.upstream.rate != null && g.upstream.rate > 10) add("critical", `上游错误率过高（${g.upstream.rate}%）`, "渠道不稳定，会触发频繁重试与切换", "检查渠道健康状态与账号额度");
  else if (g.upstream.rate != null && g.upstream.rate > 5) add("warning", `上游错误率偏高（${g.upstream.rate}%）`, "少数请求需要重试", "查看各渠道失败明细");

  if (g.sla != null && g.sla < 95) add("critical", `SLA 成功率过低（${g.sla}%）`, "承诺的可用性未达标", "优先排查上游错误与超时");
  else if (g.sla != null && g.sla < 99) add("warning", `SLA 成功率偏低（${g.sla}%）`, "距离 99.5% 目标还有差距", "关注错误趋势与失败渠道");

  const el = snap.eventLoop;
  if (el?.p99Ms > 100) add("warning", `事件循环延迟偏高（P99 ${el.p99Ms}ms）`, "Node 被同步操作阻塞，所有请求都会排队", "检查是否有同步 IO / 大 JSON 解析 / 密集循环");
  if (snap.pool?.queued > 0) add("warning", `数据库连接池排队（${snap.pool.queued} 个等待）`, "请求在等待数据库连接，延迟升高", "适当增大连接池上限，或检查是否有慢查询");
  if (g.inFlight > 50) add("info", `当前在途请求较多（${g.inFlight}）`, "系统负载较高", "观察是否伴随延迟上升");

  // Buffer 泄漏：外部内存占比过高且绝对值大
  const extMb = snap.process.externalBytes / 1024 / 1024;
  const rssMb = snap.process.rssBytes / 1024 / 1024;
  if (extMb > 200 && extMb / rssMb > 0.5) add("warning", `外部内存占用偏高（${extMb.toFixed(0)}MB / RSS ${rssMb.toFixed(0)}MB）`, "可能是流式响应的 Buffer 未释放", "观察 arrayBuffers 是否只增不减，必要时排查流式转发逻辑");

  if (!items.length) add("info", "未发现异常", "各项指标均在正常范围内", "无需操作");
  return items;
}
