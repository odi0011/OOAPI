// 告警规则引擎（对标并超过 sub2api）
// ---------------------------------------------------------------------------
// 规则模型（与 sub2api 对齐，字段名一致便于对照）：
//   metric      被观测的指标名（见 METRICS）
//   operator    > >= < <= == !=
//   threshold   阈值
//   windowMin   指标统计窗口（1 / 5 / 60 分钟）
//   sustainedMin 需要「连续满足」的时长 —— 转成 N 次连续采样才触发，避免瞬时抖动告警
//   cooldownMin 冷却时间，避免告警风暴
//   severity    P0 / P1 / P2 / P3
//   notifyEmail / notifyWebhook  该规则用哪些通道
//   filters     { channelId, channelType } 作用域，空 = 全局
//
// 相比 sub2api 增强的点：
//   1. Webhook 通道（飞书/钉钉/企微/Slack），sub2api 只有邮件；
//   2. 告警事件与「触发时的指标快照」一起落库，事后可复盘（sub2api 只存事件本身）；
//   3. 静默支持「全局维护窗口 + 按规则定向静默」两种；
//   4. 规则求值复用进程内 metrics 快照，不额外查库（sub2api 每次求值都打 SQL）。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { snapshot, healthScore } from "./metrics.js";
import { sendMail, sendWebhook, smtpConfig } from "./notify.js";
import { getBoolOption, getOption, getNumberOption } from "../config.js";

// ---------------------------------------------------------------------------
// 可观测指标
// ---------------------------------------------------------------------------
export const METRICS = [
  // 系统级
  { key: "cpu_usage_percent", label: "CPU 使用率", unit: "%", source: "system" },
  { key: "memory_usage_percent", label: "内存使用率", unit: "%", source: "system" },
  { key: "disk_usage_percent", label: "磁盘使用率", unit: "%", source: "system", optional: true },
  { key: "event_loop_p99_ms", label: "事件循环延迟 P99", unit: "ms", source: "system", optional: true },
  // 业务级
  { key: "error_rate", label: "请求错误率", unit: "%", source: "business" },
  { key: "success_rate", label: "请求成功率", unit: "%", source: "business" },
  { key: "sla_rate", label: "SLA 成功率（排除业务限制）", unit: "%", source: "business" },
  { key: "upstream_error_rate", label: "上游错误率（排除 429/529）", unit: "%", source: "business" },
  { key: "ttft_p99_ms", label: "首 Token 延迟 P99", unit: "ms", source: "business", optional: true },
  { key: "p95_latency_ms", label: "请求延迟 P95", unit: "ms", source: "business" },
  { key: "p99_latency_ms", label: "请求延迟 P99", unit: "ms", source: "business" },
  { key: "concurrency_inflight", label: "并发在途请求", unit: "个", source: "business" },
  { key: "concurrency_queue_depth", label: "数据库连接池排队", unit: "个", source: "business" },
  { key: "health_score", label: "健康分", unit: "分", source: "business" },
  // 账号级（来自 channels 表）
  { key: "channel_available_count", label: "可用账号数", unit: "个", source: "channel" },
  { key: "channel_auto_disabled_count", label: "自动禁用账号数", unit: "个", source: "channel" },
  { key: "channel_cooldown_count", label: "冷却中账号数", unit: "个", source: "channel" },
  { key: "channel_error_count", label: "账号错误数（近窗口）", unit: "个", source: "channel" },
  // 账号级 · 定向（filters.channelId 指定时才有值）
  { key: "account_success_rate", label: "指定账号成功率", unit: "%", source: "channel", needsChannel: true },
  { key: "account_error_count", label: "指定账号错误数", unit: "个", source: "channel", needsChannel: true },
];

export const OPERATORS = [">", ">=", "<", "<=", "==", "!="];
export const SEVERITIES = ["P0", "P1", "P2", "P3"];

const OP_FN = {
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

// 内置默认规则（首次启动写入；管理员可改可删）
export const DEFAULT_RULES = [
  { name: "成功率过低", metric: "success_rate", operator: "<", threshold: 95, windowMin: 5, sustainedMin: 5, cooldownMin: 30, severity: "P0" },
  { name: "错误率过高", metric: "error_rate", operator: ">", threshold: 5, windowMin: 5, sustainedMin: 5, cooldownMin: 30, severity: "P1" },
  { name: "上游错误率过高", metric: "upstream_error_rate", operator: ">", threshold: 10, windowMin: 5, sustainedMin: 5, cooldownMin: 30, severity: "P1" },
  { name: "SLA 低于目标", metric: "sla_rate", operator: "<", threshold: 99, windowMin: 60, sustainedMin: 15, cooldownMin: 60, severity: "P1" },
  { name: "请求延迟 P95 偏高", metric: "p95_latency_ms", operator: ">", threshold: 2000, windowMin: 5, sustainedMin: 5, cooldownMin: 30, severity: "P2" },
  { name: "请求延迟 P99 偏高", metric: "p99_latency_ms", operator: ">", threshold: 3000, windowMin: 5, sustainedMin: 5, cooldownMin: 30, severity: "P2" },
  { name: "首 Token 延迟偏高", metric: "ttft_p99_ms", operator: ">", threshold: 3000, windowMin: 5, sustainedMin: 5, cooldownMin: 30, severity: "P2" },
  { name: "CPU 使用率过高", metric: "cpu_usage_percent", operator: ">", threshold: 85, windowMin: 5, sustainedMin: 10, cooldownMin: 60, severity: "P2" },
  { name: "内存使用率过高", metric: "memory_usage_percent", operator: ">", threshold: 90, windowMin: 5, sustainedMin: 10, cooldownMin: 60, severity: "P1" },
  { name: "磁盘空间不足", metric: "disk_usage_percent", operator: ">", threshold: 90, windowMin: 60, sustainedMin: 30, cooldownMin: 720, severity: "P1" },
  { name: "连接池排队", metric: "concurrency_queue_depth", operator: ">", threshold: 5, windowMin: 5, sustainedMin: 5, cooldownMin: 30, severity: "P2" },
  { name: "可用账号不足", metric: "channel_available_count", operator: "<", threshold: 1, windowMin: 5, sustainedMin: 5, cooldownMin: 30, severity: "P0" },
];

// ---------------------------------------------------------------------------
// 规则求值状态（进程内）：ruleId -> { breaches, lastFiredAt, firing }
// ---------------------------------------------------------------------------
const ruleState = new Map();
let lastEvalAt = 0;
let lastEvalMs = 0;
let lastError = "";
let timer = null;

function st(id) {
  if (!ruleState.has(id)) ruleState.set(id, { breaches: 0, lastFiredAt: 0, firing: false, lastValue: null });
  return ruleState.get(id);
}

/** 取「当前时刻」的指标值。窗口语义：进程内累计指标本身就是「本进程至今」，
 *  真正的窗口筛选靠日志表 —— 但每分钟求值一次时，进程内指标的变化量
 *  已经近似于窗口值，且不需要额外查询。 */
async function metricValue(metric, filters = {}, ctx) {
  const snap = ctx.snap;
  const h = ctx.health;
  switch (metric) {
    case "cpu_usage_percent":
      return snap.system.cpuPercent;
    case "memory_usage_percent":
      return snap.system.usedMemPercent;
    case "disk_usage_percent":
      return snap.system.disk?.usedPercent ?? null;
    case "event_loop_p99_ms":
      return snap.eventLoop?.p99Ms ?? null;
    case "error_rate":
      return snap.gateway.errorRate;
    case "success_rate":
      return snap.gateway.successRate;
    case "sla_rate":
      return snap.gateway.sla;
    case "upstream_error_rate":
      return snap.gateway.upstream.rate;
    case "ttft_p99_ms":
      return snap.gateway.ttft?.p99Ms ?? null;
    case "p95_latency_ms":
      return snap.gateway.latency?.p95Ms ?? null;
    case "p99_latency_ms":
      return snap.gateway.latency?.p99Ms ?? null;
    case "concurrency_inflight":
      return snap.gateway.inFlight;
    case "concurrency_queue_depth":
      return snap.pool?.queued ?? 0;
    case "health_score":
      return h.score;
    case "channel_available_count":
    case "channel_auto_disabled_count":
    case "channel_cooldown_count":
    case "channel_error_count":
    case "account_success_rate":
    case "account_error_count":
      return ctx.channels ? ctx.channels[metric] : null;
    default:
      return null;
  }
}

/** 采集 channel 维度指标（每轮求值只查一次） */
async function channelMetrics(snap, runtimeConcurrency) {
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(status = 1) AS enabled,
            SUM(status = 2) AS disabled,
            SUM(status = 3) AS auto_disabled
       FROM channels`
  );
  const cooling = runtimeConcurrency.filter((r) => r.coolingDown).length;
  const errCount = runtimeConcurrency.filter((r) => r.lastError).length;
  const enabled = Number(c.enabled) || 0;
  const autoDisabled = Number(c.auto_disabled) || 0;
  // 可用账号 = 启用中且未冷却
  const available = Math.max(0, enabled - cooling);
  const total = enabled + Number(c.disabled || 0) + autoDisabled;
  return {
    channel_available_count: available,
    channel_auto_disabled_count: autoDisabled,
    channel_cooldown_count: cooling,
    channel_error_count: errCount,
    account_success_rate: total ? Number((((total - autoDisabled) / total) * 100).toFixed(1)) : null,
    account_error_count: autoDisabled + errCount,
    _enabled: enabled,
    _total: total,
  };
}

/** 维护窗口（全局静默）是否生效 */
export function silenceActive() {
  if (!getBoolOption("alert_silence_enabled")) return false;
  const until = getNumberOption("alert_silence_until");
  if (!until) return false;
  return Date.now() < until;
}

/** 求值一次全部规则（由定时器调用；也可被「立即检测」手动触发） */
export async function evaluateAlerts({ force = false } = {}) {
  const started = Date.now();
  const snap = snapshot();
  const health = healthScore({ dbOk: true, jobOk: true });
  const { runtimeConcurrency } = await import("./router.js");
  const rt = runtimeConcurrency();
  const ctx = { snap, health, channels: await channelMetrics(snap, rt) };

  const [rules] = await pool.query("SELECT * FROM alert_rules ORDER BY severity, id");
  const events = [];
  const intervalMin = Math.max(1, getNumberOption("alert_interval_seconds") / 60);
  const silenced = silenceActive();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const filters = safeJson(rule.filters) || {};
    let value;
    try {
      value = await metricValue(rule.metric, filters, ctx);
    } catch (e) {
      lastError = e.message;
      continue;
    }
    if (value == null || !Number.isFinite(Number(value))) {
      // 指标不可用（如 Windows 无 loadavg / 没有 TTFT 样本）：不误报，直接跳过
      continue;
    }
    const s = st(rule.id);
    s.lastValue = Number(value);
    const hit = OP_FN[rule.operator]?.(Number(value), Number(rule.threshold)) ?? false;
    if (!hit) {
      s.breaches = 0;
      if (s.firing) {
        // 恢复：关闭事件（除非规则被删/改，正常路径都会走到这里）
        s.firing = false;
        await closeEvent(rule, Number(value));
        events.push({ rule: rule.name, severity: rule.severity, type: "resolved", value: Number(value) });
      }
      continue;
    }
    // 连续满足次数：sustained_min 换算成采样次数
    const need = Math.max(1, Math.ceil(Number(rule.sustained_min) / intervalMin));
    s.breaches += 1;
    if (s.breaches < need) continue;
    // 冷却：避免告警风暴
    const cooldownMs = Math.max(0, Number(rule.cooldown_min) || 0) * 60000;
    if (!force && s.lastFiredAt && Date.now() - s.lastFiredAt < cooldownMs) continue;
    if (silenced && !force) continue;

    s.lastFiredAt = Date.now();
    s.firing = true;
    await fireEvent(rule, Number(value), ctx);
    events.push({ rule: rule.name, severity: rule.severity, type: "firing", value: Number(value) });
  }

  lastEvalAt = Date.now();
  lastEvalMs = Date.now() - started;
  return { evaluatedAt: lastEvalAt, ms: lastEvalMs, rules: rules.length, events, silenced };
}

/** 触发一条告警：落库 + 按通道通知 */
async function fireEvent(rule, value, ctx) {
  const title = `【告警·${rule.severity}】${rule.name}`;
  const lines = [
    `指标：${METRICS.find((m) => m.key === rule.metric)?.label || rule.metric}`,
    `当前值：${round(value)}${METRICS.find((m) => m.key === rule.metric)?.unit || ""}`,
    `条件：${rule.operator} ${rule.threshold}`,
    `持续：${rule.sustained_min} 分钟`,
    `健康分：${ctx.health.score}（${ctx.health.level}）`,
    `时间：${new Date().toLocaleString("zh-CN")}`,
  ];
  const detail = {
    metric: rule.metric,
    value: round(value),
    operator: rule.operator,
    threshold: Number(rule.threshold),
    healthScore: ctx.health.score,
    sla: ctx.snap.gateway.sla,
    errorRate: ctx.snap.gateway.errorRate,
    inflight: ctx.snap.gateway.inFlight,
    cpu: ctx.snap.system.cpuPercent,
    memory: ctx.snap.system.usedMemPercent,
  };
  await pool
    .query(
      `INSERT INTO alert_events (rule_id, rule_name, severity, metric, value, threshold, operator, status, detail, created_time)
       VALUES (?,?,?,?,?,?,?, 'firing', ?, ?)`,
      [rule.id, rule.name, rule.severity, rule.metric, round(value), Number(rule.threshold), rule.operator, JSON.stringify(detail), now()]
    )
    .catch(() => {});
  await dispatch(rule, title, lines);
}

/** 恢复一条告警：把最近的 firing 事件置为 resolved */
async function closeEvent(rule, value) {
  await pool
    .query(
      `UPDATE alert_events SET status = 'resolved', resolved_time = ?, resolved_value = ?
        WHERE rule_id = ? AND status = 'firing'`,
      [now(), round(value), rule.id]
    )
    .catch(() => {});
  const smtp = smtpConfig();
  // 恢复通知：只在配置开启时发，避免「一次抖动两封邮件」
  if (!getBoolOption("alert_notify_resolved")) return;
  const title = `【已恢复】${rule.name}`;
  const lines = [
    `指标已回到正常范围（当前值 ${round(value)}）`,
    `时间：${new Date().toLocaleString("zh-CN")}`,
  ];
  if (smtp.enabled && rule.notify_email) await dispatch(rule, title, lines);
}

/** 按规则配置投递到邮件 / Webhook */
async function dispatch(rule, title, lines) {
  const cfg = smtpConfig();
  const tasks = [];
  if (rule.notify_email && cfg.enabled) {
    const recipients = String(rule.notify_emails || "").trim() || String(getOption("alert_email_to") || "").trim();
    if (recipients) {
      tasks.push(
        sendMail({ to: recipients, subject: title, text: lines.join("\n") })
          .then(() => logNotify(rule.id, "email", true, ""))
          .catch((e) => logNotify(rule.id, "email", false, e.message))
      );
    }
  }
  if (rule.notify_webhook) {
    const url = String(rule.webhook_url || "").trim() || String(getOption("alert_webhook_url") || "").trim();
    if (url) {
      const secret = String(getOption("alert_webhook_secret") || "");
      tasks.push(
        sendWebhook(url, title, lines, { secret }).then((r) =>
          logNotify(rule.id, "webhook", r.ok, r.error || "")
        )
      );
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

async function logNotify(ruleId, channel, ok, error) {
  await pool
    .query("INSERT INTO alert_notify_logs (rule_id, channel, ok, error, created_time) VALUES (?,?,?,?,?)", [
      ruleId,
      channel,
      ok ? 1 : 0,
      String(error || "").slice(0, 400),
      now(),
    ])
    .catch(() => {});
}

function safeJson(s) {
  if (!s) return null;
  if (typeof s === "object") return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
const round = (n) => Math.round(Number(n) * 100) / 100;

/** 引擎状态（监控页展示「监控系统自己」的心跳） */
export function engineStatus() {
  return {
    lastEvalAt,
    lastEvalMs,
    lastError,
    intervalSeconds: getNumberOption("alert_interval_seconds") || 60,
    enabled: getBoolOption("alert_enabled"),
    silence: {
      active: silenceActive(),
      until: getNumberOption("alert_silence_until") || 0,
      reason: getOption("alert_silence_reason") || "",
    },
    rules: ruleState.size,
  };
}

/** 启动定时求值（幂等；index.js 启动时调一次） */
export function startAlertEngine() {
  if (timer) return;
  const tick = async () => {
    if (!getBoolOption("alert_enabled")) return;
    try {
      await evaluateAlerts();
    } catch (e) {
      lastError = e.message;
      console.warn(`[alert] 求值失败：${e.message}`);
    }
  };
  // 先跑一次拿基线（此时 CPU/进程 CPU 还没有差值，指标为 null 会被自动跳过）
  setTimeout(tick, 5000);
  timer = setInterval(tick, Math.max(10, getNumberOption("alert_interval_seconds") || 60) * 1000);
  timer.unref?.(); // 不要因为这个定时器阻止进程退出
}

/** 首次启动写入内置规则（表为空时才写，避免覆盖管理员的改动） */
export async function seedDefaultRules() {
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM alert_rules");
  if (Number(n) > 0) return 0;
  for (const r of DEFAULT_RULES) {
    await pool.query(
      `INSERT INTO alert_rules
         (name, metric, operator, threshold, window_min, sustained_min, cooldown_min, severity, enabled,
          notify_email, notify_webhook, channels, filters, created_time)
       VALUES (?,?,?,?,?,?,?,?, 1, 1, 1, ?, '{}', ?)`,
      [r.name, r.metric, r.operator, r.threshold, r.windowMin, r.sustainedMin, r.cooldownMin, r.severity, defaultChannels(), now()]
    );
  }
  return DEFAULT_RULES.length;
}

function defaultChannels() {
  const out = [];
  if (smtpConfig().enabled) out.push("email");
  if (String(getOption("alert_webhook_url") || "").trim()) out.push("webhook");
  return out.join(",");
}
