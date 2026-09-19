// 运维监控 + 告警管理（管理员）
// ---------------------------------------------------------------------------
// 指标来源见 services/metrics.js（Node 内置模块采集，不引依赖）。
// 这一页是「当前进程 + 当前机器」的实时视图；跨重启的历史看使用记录/操作日志。
//
// 与 sub2api 的对应关系：snapshot ≈ 它的 OpsDashboardHeader + 各图表卡片；
// alerts/* ≈ 它的 OpsAlertRulesCard / OpsAlertEventsCard；
// 多出来的部分：SSE 实时推送、Webhook 通道、进程级 CPU、事件循环阻塞归因、Buffer 泄漏检测。
import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { snapshot, healthScore, diagnose, recordChannelSwitch } from "../services/metrics.js";
import { runtimeConcurrency } from "../services/router.js";
import { evaluateAlerts, engineStatus, METRICS, OPERATORS, SEVERITIES, DEFAULT_RULES, silenceActive } from "../services/alert.js";
import { sendTestMail, sendWebhook, webhookPlatform, smtpConfig } from "../services/notify.js";
import { START_TIME, VERSION, getNumberOption, getBoolOption, getOption } from "../config.js";

const router = Router();
// 注意：/stream 走「一次性票据」自鉴权（EventSource 无法带 Authorization 头），
// 所以不能在这里全局挂 adminRequired —— 那会让它在进到处理器之前就被 401 挡掉。
// 其余接口在下面各自的中间件里挂，或在文件末尾统一补挂（见 GUARDED 注释）。
const GUARD_EXEMPT = new Set(["/stream", "/stream-ticket"]);
router.use((req, res, next) => {
  // mount 之后 req.path 是去掉挂载点的相对路径
  if (GUARD_EXEMPT.has(req.path)) return next();
  return adminRequired(req, res, next);
});

// 阈值：与「告警」同源，避免两处口径（前端据此给红/黄标记）
function thresholds() {
  return {
    slaPercentMin: Number(getOption("alert_sla_min") || 99.5),
    ttftP99MsMax: Number(getOption("alert_ttft_p99_max") || 3000),
    errorRateMax: Number(getOption("alert_error_rate_max") || 5),
    upstreamErrorRateMax: Number(getOption("alert_upstream_error_rate_max") || 5),
    cpuPercentMax: 85,
    memPercentMax: 90,
    logRetentionDays: getNumberOption("log_retention_days"),
    rateLimitEnabled: getBoolOption("rate_limit_enabled"),
    alertEnabled: getBoolOption("alert_enabled"),
  };
}

// ---------------------------------------------------------------------------
// 平台业务概览（与系统资源分开：这些来自数据库，不是进程指标）
// ---------------------------------------------------------------------------
async function platformOverview() {
  const [[ch]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(status = 1) AS enabled,
            SUM(status = 2) AS disabled,
            SUM(status = 3) AS auto_disabled
       FROM channels`
  );
  const [[tk]] = await pool.query("SELECT COUNT(*) AS total, SUM(status = 1) AS active FROM tokens");
  const [[us]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(status = 1) AS active,
            SUM(quota <= ?) AS low_balance
       FROM users`,
    [getNumberOption("quota_remind_threshold") || 100000]
  );
  const nowSec = now();
  const [[h1]] = await pool.query(
    `SELECT SUM(type = 2) AS calls, SUM(type = 4) AS errors, COALESCE(SUM(quota),0) AS units
       FROM logs WHERE created_at >= ?`,
    [nowSec - 3600]
  );
  const [[h24]] = await pool.query(
    `SELECT SUM(type = 2) AS calls, SUM(type = 4) AS errors, COALESCE(SUM(quota),0) AS units
       FROM logs WHERE created_at >= ?`,
    [nowSec - 86400]
  );
  // 注意这里是 `const [tbl]` 而不是 `const [[tbl]]`：
  // pool.query 返回 [rows, fields]，再解一层就只剩第一行了，tbl.map 会直接抛。
  const [tbl] = await pool.query(
    `SELECT table_name AS name,
            ROUND((data_length + index_length) / 1024 / 1024, 2) AS mb,
            table_rows AS approx_rows
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
      ORDER BY (data_length + index_length) DESC LIMIT 8`
  );
  return {
    channels: {
      total: Number(ch.total) || 0,
      enabled: Number(ch.enabled) || 0,
      disabled: Number(ch.disabled) || 0,
      autoDisabled: Number(ch.auto_disabled) || 0,
    },
    tokens: { total: Number(tk.total) || 0, active: Number(tk.active) || 0 },
    users: {
      total: Number(us.total) || 0,
      active: Number(us.active) || 0,
      lowBalance: Number(us.low_balance) || 0,
    },
    lastHour: { calls: Number(h1.calls) || 0, errors: Number(h1.errors) || 0, units: Number(h1.units) || 0 },
    last24h: { calls: Number(h24.calls) || 0, errors: Number(h24.errors) || 0, units: Number(h24.units) || 0 },
    tables: tbl.map((t) => ({ name: t.name, mb: Number(t.mb) || 0, rows: Number(t.approx_rows) || 0 })),
  };
}

/** 渠道运行时（并发/队列卡片）：把「从未被调用」的渠道也补出来，
 *  否则刚部署完看到的是一张空表，不知道是没数据还是没功能。 */
async function channelRuntime() {
  const rt = runtimeConcurrency();
  const byId = new Map(rt.map((r) => [r.channelId, r]));
  const [rows] = await pool.query(
    "SELECT id, name, type, status, response_time, last_error, used_count, quota, quota_time FROM channels ORDER BY id"
  );
  const list = rows.map((c) => {
    const r = byId.get(c.id) || {};
    return {
      channelId: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      inflight: r.inflight || 0,
      coolingDown: Boolean(r.coolingDown),
      cooldownRemainSec: r.cooldownRemainSec || 0,
      recentCalls: r.recentCalls || 0,
      queued: r.queued || 0,
      lastError: r.lastError || c.last_error || "",
      responseTime: Number(c.response_time) || 0,
      usedCount: Number(c.used_count) || 0,
    };
  });
  const totalInflight = list.reduce((a, b) => a + b.inflight, 0);
  return {
    list,
    inflight: totalInflight,
    cooling: list.filter((c) => c.coolingDown).length,
    enabled: list.filter((c) => c.status === 1).length,
    errors: list.filter((c) => c.lastError).length,
  };
}

// 实时快照（前端按间隔轮询；需要秒级时用 /stream）
router.get(
  "/snapshot",
  asyncHandler(async (req, res) => {
    const s = snapshot();
    const health = healthScore({ dbOk: true, jobOk: true });
    const [overview, channels] = await Promise.all([platformOverview(), channelRuntime()]);

    return ok(res, {
      ...s,
      version: VERSION,
      startedAt: START_TIME * 1000,
      overview,
      channels,
      health,
      diagnosis: diagnose({ dbOk: true, jobOk: true }),
      alerts: engineStatus(),
      thresholds: thresholds(),
    });
  })
);

// SSE 实时推送（sub2api 用的 WebSocket；SSE 无依赖、浏览器原生自动重连、没有连接数上限问题）
//
// 鉴权：浏览器原生的 EventSource **不能自定义请求头**，所以没法带 Authorization。
// 早期实现直接让这个接口过 adminRequired，结果前端每次连接都被 401（控制台报错、
// 图表拿不到实时数据，只能靠 15s 轮询兜着）。
// 这里改为「一次性短票据」：前端先用普通 API 调用换取一个 60 秒内有效、只能用于
// 这一个接口的随机票据，再拼到 query 上。比把完整 JWT 放进 URL 安全 ——
// 完整 JWT 有效期 30 天且等同全站通行证，一旦出现在访问日志/浏览器历史里就是长期风险。
const streamTickets = new Map(); // ticket → { userId, exp }
const TICKET_TTL_MS = 60_000;

function issueTicket(userId) {
  const ticket = crypto.randomBytes(24).toString("hex");
  streamTickets.set(ticket, { userId, exp: Date.now() + TICKET_TTL_MS });
  // 顺手清理过期票据：量很小，但避免只增不减
  const now = Date.now();
  for (const [k, v] of streamTickets.entries()) if (v.exp < now) streamTickets.delete(k);
  return ticket;
}

router.post(
  "/stream-ticket",
  adminRequired,
  asyncHandler(async (req, res) => ok(res, { ticket: issueTicket(req.user.id), expiresInSec: TICKET_TTL_MS / 1000 }))
);

router.get(
  "/stream",
  asyncHandler(async (req, res) => {
    // 票据校验（一次性：用过即删，避免被反复利用）
    const ticket = String(req.query.ticket || "");
    const rec = streamTickets.get(ticket);
    if (!rec || rec.exp < Date.now()) {
      res.status(401).json({ success: false, message: "实时推送凭据无效或已过期，请刷新页面" });
      return;
    }
    streamTickets.delete(ticket);
    const [[user]] = await pool.query("SELECT id, role, status FROM users WHERE id = ?", [rec.userId]);
    if (!user || user.status !== 1 || user.role < 100) {
      res.status(403).json({ success: false, message: "需要管理员权限" });
      return;
    }

    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no"); // nginx 反代下必须显式关闭缓冲
    res.flushHeaders?.();

    const intervalMs = Math.min(10000, Math.max(1000, Number(req.query.interval) || 3000));
    let closed = false;
    const send = () => {
      if (closed) return;
      try {
        const s = snapshot();
        // SSE 只推「会变且轻量」的部分：完整快照走 /snapshot 轮询
        res.write(
          `data: ${JSON.stringify({
            at: Date.now(),
            qps: s.trend.qps,
            tps: s.trend.tps,
            inFlight: s.gateway.inFlight,
            requests: s.gateway.requests,
            errors: s.gateway.errors,
            sla: s.gateway.sla,
            errorRate: s.gateway.errorRate,
            latency: { p95Ms: s.gateway.latency.p95Ms, p99Ms: s.gateway.latency.p99Ms },
            ttftP99Ms: s.gateway.ttft?.p99Ms ?? null,
            cpuPercent: s.system.cpuPercent,
            usedMemPercent: s.system.usedMemPercent,
            eventLoopP99Ms: s.eventLoop?.p99Ms ?? null,
          })}\n\n`
        );
      } catch {
        /* 序列化失败不该拖垮连接，下一轮再试 */
      }
    };
    send();
    const timer = setInterval(send, intervalMs);
    // 心跳：有些反代会把 60s 无数据的连接掐掉，注释帧不算数据但能保活
    const beat = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, 15000);
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
      clearInterval(beat);
    });
    return undefined;
  })
);

// ---------------------------------------------------------------------------
// 告警规则 CRUD
// ---------------------------------------------------------------------------

/** 入参校验：数值范围不校验会让 `threshold: "abc"` 之类的值导致永不触发（静默失效） */
function normalizeRule(body, existing = {}) {
  const metric = String(body.metric ?? existing.metric ?? "").trim();
  if (!METRICS.some((m) => m.key === metric)) return { error: `未知指标：${metric}` };
  const operator = String(body.operator ?? existing.operator ?? ">");
  if (!OPERATORS.includes(operator)) return { error: `未知比较符：${operator}` };
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };
  const threshold = num(body.threshold ?? existing.threshold, 0, -1e12, 1e12);
  const windowMin = Math.round(num(body.window_min ?? existing.window_min, 5, 1, 1440));
  const sustainedMin = Math.round(num(body.sustained_min ?? existing.sustained_min, 5, 1, 1440));
  const cooldownMin = Math.round(num(body.cooldown_min ?? existing.cooldown_min, 30, 0, 10080));
  const severity = String(body.severity ?? existing.severity ?? "P2").toUpperCase();
  if (!SEVERITIES.includes(severity)) return { error: `未知级别：${severity}` };
  const name = String(body.name ?? existing.name ?? "").trim() || METRICS.find((m) => m.key === metric).label;
  return {
    rule: {
      name: name.slice(0, 64),
      metric,
      operator,
      threshold,
      window_min: windowMin,
      sustained_min: sustainedMin,
      cooldown_min: cooldownMin,
      severity,
      enabled: body.enabled === undefined ? Number(existing.enabled ?? 1) : body.enabled ? 1 : 0,
      notify_email: body.notify_email === undefined ? Number(existing.notify_email ?? 1) : body.notify_email ? 1 : 0,
      notify_webhook: body.notify_webhook === undefined ? Number(existing.notify_webhook ?? 1) : body.notify_webhook ? 1 : 0,
      webhook_url: String(body.webhook_url ?? existing.webhook_url ?? "").trim().slice(0, 512),
      notify_emails: String(body.notify_emails ?? existing.notify_emails ?? "").trim().slice(0, 512),
      description: String(body.description ?? existing.description ?? "").trim().slice(0, 255),
      filters: typeof body.filters === "string" ? body.filters : JSON.stringify(body.filters ?? {}) || "{}",
    },
  };
}

router.get(
  "/alert/metrics",
  asyncHandler(async (req, res) => ok(res, { metrics: METRICS, operators: OPERATORS, severities: SEVERITIES, defaults: DEFAULT_RULES }))
);

router.get(
  "/alert/rules",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM alert_rules ORDER BY severity, id");
    return ok(res, rows);
  })
);

router.post(
  "/alert/rules",
  asyncHandler(async (req, res) => {
    const { rule, error } = normalizeRule(req.body || {});
    if (error) return fail(res, error);
    const [r] = await pool.query(
      `INSERT INTO alert_rules
         (name, metric, operator, threshold, window_min, sustained_min, cooldown_min, severity, enabled,
          notify_email, notify_webhook, webhook_url, notify_emails, channels, filters, description, created_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rule.name, rule.metric, rule.operator, rule.threshold, rule.window_min, rule.sustained_min,
        rule.cooldown_min, rule.severity, rule.enabled, rule.notify_email, rule.notify_webhook,
        rule.webhook_url, rule.notify_emails, "", rule.filters, rule.description, now(),
      ]
    );
    return ok(res, { id: r.insertId }, "规则已创建");
  })
);

router.put(
  "/alert/rules/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [[existing]] = await pool.query("SELECT * FROM alert_rules WHERE id = ?", [id]);
    if (!existing) return fail(res, "规则不存在", 404);
    const { rule, error } = normalizeRule(req.body || {}, existing);
    if (error) return fail(res, error);
    await pool.query(
      `UPDATE alert_rules SET name=?, metric=?, operator=?, threshold=?, window_min=?, sustained_min=?,
              cooldown_min=?, severity=?, enabled=?, notify_email=?, notify_webhook=?, webhook_url=?,
              notify_emails=?, filters=?, description=?
        WHERE id = ?`,
      [
        rule.name, rule.metric, rule.operator, rule.threshold, rule.window_min, rule.sustained_min,
        rule.cooldown_min, rule.severity, rule.enabled, rule.notify_email, rule.notify_webhook,
        rule.webhook_url, rule.notify_emails, rule.filters, rule.description, id,
      ]
    );
    return ok(res, null, "规则已更新");
  })
);

router.delete(
  "/alert/rules/:id",
  asyncHandler(async (req, res) => {
    await pool.query("DELETE FROM alert_rules WHERE id = ?", [Number(req.params.id)]);
    return ok(res, null, "规则已删除");
  })
);

router.post(
  "/alert/rules/:id/toggle",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await pool.query("UPDATE alert_rules SET enabled = 1 - enabled WHERE id = ?", [id]);
    const [[r]] = await pool.query("SELECT enabled FROM alert_rules WHERE id = ?", [id]);
    return ok(res, { enabled: Number(r?.enabled) === 1 }, r?.enabled ? "规则已启用" : "规则已停用");
  })
);

// 告警事件（触发/恢复历史）
router.get(
  "/alert/events",
  asyncHandler(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const status = String(req.query.status || "").trim();
    const severity = String(req.query.severity || "").trim();
    const where = ["created_time >= ?"];
    const params = [now() - days * 86400];
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    if (severity) {
      where.push("severity = ?");
      params.push(severity);
    }
    const [rows] = await pool.query(
      `SELECT * FROM alert_events WHERE ${where.join(" AND ")} ORDER BY created_time DESC LIMIT ${limit}`,
      params
    );
    const [[stat]] = await pool.query(
      `SELECT SUM(status = 'firing') AS firing,
              SUM(status = 'resolved') AS resolved,
              SUM(severity = 'P0') AS p0,
              SUM(severity = 'P1') AS p1
         FROM alert_events WHERE created_time >= ?`,
      [now() - days * 86400]
    );
    const [notify] = await pool.query(
      `SELECT channel, SUM(ok = 0) AS failed, COUNT(*) AS total
         FROM alert_notify_logs WHERE created_time >= ? GROUP BY channel`,
      [now() - days * 86400]
    );
    return ok(res, {
      list: rows,
      stat: {
        firing: Number(stat.firing) || 0,
        resolved: Number(stat.resolved) || 0,
        p0: Number(stat.p0) || 0,
        p1: Number(stat.p1) || 0,
      },
      notify: notify.map((n) => ({ channel: n.channel, failed: Number(n.failed) || 0, total: Number(n.total) || 0 })),
    });
  })
);

router.post(
  "/alert/events/:id/resolve",
  asyncHandler(async (req, res) => {
    await pool.query("UPDATE alert_events SET status = 'resolved', resolved_time = ? WHERE id = ?", [
      now(),
      Number(req.params.id),
    ]);
    return ok(res, null, "已标记为已解决");
  })
);

// 立即求值（管理员手动触发，跳过冷却与静默，用于验证规则配置）
router.post(
  "/alert/evaluate",
  asyncHandler(async (req, res) => {
    const force = req.body?.force !== false;
    const r = await evaluateAlerts({ force });
    return ok(res, r, `已求值 ${r.rules} 条规则`);
  })
);

// 维护窗口（全局静默）：一键静默 N 分钟
router.post(
  "/alert/silence",
  asyncHandler(async (req, res) => {
    const { setOption } = await import("../config.js");
    const minutes = Number(req.body?.minutes) || 0;
    const reason = String(req.body?.reason || "").slice(0, 255);
    if (minutes > 0) {
      await setOption("alert_silence_enabled", "true");
      await setOption("alert_silence_until", String(Date.now() + minutes * 60000));
      await setOption("alert_silence_reason", reason);
      return ok(res, null, `已静默 ${minutes} 分钟`);
    }
    await setOption("alert_silence_enabled", "false");
    await setOption("alert_silence_until", "0");
    await setOption("alert_silence_reason", "");
    return ok(res, null, "已解除静默");
  })
);

// 通知通道测试
router.post(
  "/alert/test",
  asyncHandler(async (req, res) => {
    const channel = String(req.body?.channel || "email");
    if (channel === "email") {
      const cfg = smtpConfig();
      if (!cfg.host) return fail(res, "请先在系统设置中配置 SMTP 服务器地址");
      const to = String(req.body?.to || getOption("alert_email_to") || "").trim();
      if (!to) return fail(res, "请填写测试收件人地址");
      try {
        const r = await sendTestMail(to);
        return ok(res, r, `测试邮件已发送（${r.ms}ms）`);
      } catch (e) {
        return fail(res, `发送失败：${e.message}`);
      }
    }
    if (channel === "webhook") {
      const url = String(req.body?.url || getOption("alert_webhook_url") || "").trim();
      if (!url) return fail(res, "请填写 Webhook 地址");
      const secret = String(getOption("alert_webhook_secret") || "");
      const r = await sendWebhook(url, "【OOAPI】Webhook 配置测试", [
        `这是一条测试消息（${webhookPlatform(url)}）`,
        `时间：${new Date().toLocaleString("zh-CN")}`,
      ], { secret });
      return r.ok ? ok(res, r, `测试消息已发送（${webhookPlatform(url)}，${r.ms}ms）`) : fail(res, `发送失败：${r.error}`);
    }
    return fail(res, "未知的通知通道");
  })
);

// 告警配置概览（系统设置页展示当前通道状态）
router.get(
  "/alert/config",
  asyncHandler(async (req, res) => {
    const cfg = smtpConfig();
    const url = String(getOption("alert_webhook_url") || "");
    return ok(res, {
      smtp: {
        enabled: cfg.enabled,
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        from: cfg.from,
        secure: cfg.secure,
        configured: Boolean(cfg.host && cfg.from),
      },
      webhook: {
        url,
        platform: url ? webhookPlatform(url) : "",
        configured: Boolean(url),
        hasSecret: Boolean(String(getOption("alert_webhook_secret") || "")),
      },
      engine: engineStatus(),
      silenced: silenceActive(),
    });
  })
);

// 清理过期告警事件
router.post(
  "/alert/cleanup",
  asyncHandler(async (req, res) => {
    // 注意不能写成 `Number(x) || 30`：显式传 days=0 会被 0 是 falsy 这条规则
    // 悄悄变成 30，把「清空全部」的保护性拒绝变成「删掉 30 天前的数据」。
    const raw = req.body?.days ?? getNumberOption("alert_retention_days");
    const days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) {
      return fail(res, "保留天数必须大于 0；清空全部告警历史属于危险操作，不予执行");
    }
    const keep = Math.min(3650, Math.floor(days));
    const [r] = await pool.query("DELETE FROM alert_events WHERE created_time < ?", [now() - keep * 86400]);
    await pool.query("DELETE FROM alert_notify_logs WHERE created_time < ?", [now() - keep * 86400]);
    return ok(res, { deleted: r.affectedRows, days: keep }, `已清理 ${r.affectedRows} 条历史告警（保留 ${keep} 天）`);
  })
);

// 手动换号计数（供内部使用，也在监控页展示）
router.post(
  "/channel-switch",
  asyncHandler(async (req, res) => {
    recordChannelSwitch();
    return ok(res, null, "已记录");
  })
);

export default router;
