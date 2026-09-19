// 运维监控接口冒烟测试（HTTP 级）
// ---------------------------------------------------------------------------
// 为什么需要它：静态检查只能查语法与 import，查不出「接口返回 200 但数据结构不对」。
// 真实案例：`const [[tbl]] = await pool.query(...)` 把多行结果解成了第一行，
// 于是 `tbl.map` 在运行期抛 500 —— 语法检查完全看不出问题。
//
// 用法（在服务器上）：
//   cd ooapi-server && node tests/monitor-smoke.mjs           # 自动取一个管理员生成令牌
// 需要数据库可连（用 db.js 里的 pool 直接签令牌，不需要知道管理员密码）。
//
// 必须显式加载 .env：正式服务由 index.js 里的 `import "dotenv/config"` 加载，
// 测试脚本直接 import db.js 就拿不到 DB_PASSWORD —— 会报 ER_ACCESS_DENIED。
import "dotenv/config";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3001";

const { JWT_SECRET, pool } = await import("../src/db.js");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

// 不依赖管理员密码：直接用 JWT_SECRET 签一个管理员令牌（本机测试专用）
const [[admin]] = await pool.query("SELECT id, username, role, token_version FROM users WHERE role >= 100 LIMIT 1");
if (!admin) {
  console.error("数据库里没有管理员账号，无法测试");
  process.exit(1);
}
const token = jwt.sign(
  { id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 },
  JWT_SECRET,
  { expiresIn: "10m" }
);
const H = { authorization: `Bearer ${token}` };

const req = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...H, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: r.status, body };
};

console.log(`冒烟测试目标：${BASE}（管理员 ${admin.username}）\n`);

console.log("鉴权");
await check("未带令牌访问监控接口应 401", async () => {
  const r = await fetch(`${BASE}/api/monitor/snapshot`);
  assert.equal(r.status, 401);
});

console.log("监控快照");
let snap;
await check("GET /api/monitor/snapshot 返回 200", async () => {
  const r = await req("/api/monitor/snapshot");
  assert.equal(r.status, 200, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.success, true, r.body.message);
  snap = r.body.data;
});

await check("system / process / eventLoop / pool 字段齐全", () => {
  assert.ok(snap.system && typeof snap.system.cpuCount === "number", "system 缺 cpuCount");
  assert.ok(typeof snap.system.usedMemPercent === "number", "system 缺 usedMemPercent");
  assert.ok(snap.process && typeof snap.process.rssBytes === "number", "process 缺 rssBytes");
  assert.ok(typeof snap.process.uptimeSec === "number", "process 缺 uptimeSec");
  assert.ok(snap.pool !== undefined, "缺 pool");
  assert.ok(snap.eventLoop !== undefined, "缺 eventLoop");
  assert.ok(snap.resources && "activeHandles" in snap.resources, "缺 resources.activeHandles");
});

await check("gateway 指标齐全且口径自洽", () => {
  const g = snap.gateway;
  assert.ok(typeof g.requests === "number", "缺 requests");
  assert.ok(typeof g.errors === "number", "缺 errors");
  assert.ok(typeof g.businessLimited === "number", "缺 businessLimited");
  assert.ok(g.upstream && typeof g.upstream.errors === "number", "缺 upstream.errors");
  assert.ok(typeof g.upstream.count429 === "number", "缺 upstream.count429");
  assert.ok(typeof g.channelSwitches === "number", "缺 channelSwitches");
  assert.ok(g.latency && typeof g.latency.p95Ms === "number", "缺 latency.p95Ms");
  assert.ok(Array.isArray(g.byStatus), "byStatus 必须是数组");
  assert.ok(Array.isArray(g.latencyHistogram), "latencyHistogram 必须是数组");
  assert.ok(Array.isArray(g.topModels), "topModels 必须是数组");
  assert.ok(Array.isArray(g.topChannels), "topChannels 必须是数组");
  assert.ok(Array.isArray(g.topUsers), "topUsers 必须是数组");
  assert.ok(Array.isArray(g.topVendors), "topVendors 必须是数组");
  // SLA 排除业务限制，不可能低于成功率
  if (g.sla != null && g.successRate != null) {
    assert.ok(g.sla >= g.successRate - 0.02, `SLA(${g.sla}) 不应低于成功率(${g.successRate})`);
  }
});

await check("trend 时间桶是 60 个且 QPS/TPS 结构完整", () => {
  assert.ok(snap.trend && Array.isArray(snap.trend.series), "缺 trend.series");
  assert.equal(snap.trend.series.length, 60, `应为 60 个分钟桶，实际 ${snap.trend.series.length}`);
  for (const k of ["current", "peak", "avg"]) {
    assert.ok(typeof snap.trend.qps[k] === "number", `trend.qps 缺 ${k}`);
    assert.ok(typeof snap.trend.tps[k] === "number", `trend.tps 缺 ${k}`);
  }
  assert.ok(snap.trend.qps.peak >= snap.trend.qps.current, "峰值不应小于当前值");
});

await check("overview 各计数为数字，tables 是数组（曾经的 500 就在这里）", () => {
  const o = snap.overview;
  assert.ok(o, "缺 overview");
  assert.ok(Array.isArray(o.tables), `overview.tables 必须是数组，实际 ${typeof o.tables}`);
  for (const t of o.tables) {
    assert.ok(typeof t.name === "string" && typeof t.mb === "number", `表项结构不对：${JSON.stringify(t)}`);
  }
  assert.ok(typeof o.channels.total === "number", "channels.total 必须是数字");
  assert.ok(typeof o.tokens.total === "number", "tokens.total 必须是数字");
  assert.ok(typeof o.users.total === "number", "users.total 必须是数字");
  assert.ok(typeof o.lastHour.calls === "number", "lastHour.calls 必须是数字");
  assert.ok(typeof o.last24h.calls === "number", "last24h.calls 必须是数字");
});

await check("channels 运行时是数组", () => {
  assert.ok(snap.channels && Array.isArray(snap.channels.list), "channels.list 必须是数组");
  for (const c of snap.channels.list) {
    assert.ok(typeof c.channelId === "number", "渠道项缺 channelId");
    assert.ok(typeof c.inflight === "number", "渠道项缺 inflight");
    assert.ok(typeof c.coolingDown === "boolean", "渠道项缺 coolingDown");
  }
});

await check("health / diagnosis / alerts / thresholds 齐全", () => {
  assert.ok(snap.health && typeof snap.health.score === "number", "health.score 必须是数字");
  assert.ok([0, 1].includes(snap.health.score > 100 ? 1 : 0), "健康分必须在 0-100");
  assert.ok(["healthy", "degraded", "risk", "idle"].includes(snap.health.level), `未知级别 ${snap.health.level}`);
  assert.ok(Array.isArray(snap.diagnosis) && snap.diagnosis.length > 0, "diagnosis 必须是非空数组");
  for (const d of snap.diagnosis) {
    assert.ok(d.title && d.impact && d.advice, "诊断项缺三段式字段");
  }
  assert.ok(snap.alerts && typeof snap.alerts === "object", "缺 alerts");
  assert.ok(snap.thresholds && typeof snap.thresholds === "object", "缺 thresholds");
});

console.log("告警接口");
await check("GET /api/monitor/alert/metrics 返回指标目录", async () => {
  const r = await req("/api/monitor/alert/metrics");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.metrics) && r.body.data.metrics.length >= 15, "指标数应 >= 15");
  assert.ok(Array.isArray(r.body.data.operators), "缺 operators");
  assert.ok(Array.isArray(r.body.data.severities), "缺 severities");
});

await check("GET /api/monitor/alert/rules 返回规则数组", async () => {
  const r = await req("/api/monitor/alert/rules");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data), "rules 必须是数组");
  assert.ok(r.body.data.length > 0, "内置规则应已写入（启动时 seed）");
});

await check("GET /api/monitor/alert/events 返回事件与统计", async () => {
  const r = await req("/api/monitor/alert/events?days=7");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.list), "events.list 必须是数组");
  assert.ok(r.body.data.stat && typeof r.body.data.stat.firing === "number", "缺 stat.firing");
  assert.ok(Array.isArray(r.body.data.notify), "notify 必须是数组");
});

await check("GET /api/monitor/alert/config 返回通道状态", async () => {
  const r = await req("/api/monitor/alert/config");
  assert.equal(r.status, 200);
  assert.ok(r.body.data.smtp && typeof r.body.data.smtp.configured === "boolean", "缺 smtp.configured");
  assert.ok(r.body.data.webhook && typeof r.body.data.webhook.configured === "boolean", "缺 webhook.configured");
});

await check("POST /api/monitor/alert/evaluate 能跑通求值", async () => {
  const r = await req("/api/monitor/alert/evaluate", { method: "POST", body: JSON.stringify({ force: true }) });
  assert.equal(r.status, 200, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.ok(typeof r.body.data.rules === "number", "缺 rules 计数");
  assert.ok(Array.isArray(r.body.data.events), "缺 events");
});

await check("规则 CRUD 全流程（建→改→停用→删）", async () => {
  const body = {
    name: "冒烟测试规则",
    metric: "error_rate",
    operator: ">",
    threshold: 99,
    window_min: 5,
    sustained_min: 5,
    cooldown_min: 60,
    severity: "P3",
  };
  const c = await req("/api/monitor/alert/rules", { method: "POST", body: JSON.stringify(body) });
  assert.equal(c.status, 200, `创建失败 HTTP ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
  const id = c.body.data.id;
  assert.ok(id > 0, "创建未返回 id");

  const u = await req(`/api/monitor/alert/rules/${id}`, { method: "PUT", body: JSON.stringify({ ...body, threshold: 88 }) });
  assert.equal(u.status, 200, `更新失败 ${JSON.stringify(u.body).slice(0, 200)}`);

  const listed = await req("/api/monitor/alert/rules");
  const found = listed.body.data.find((r) => r.id === id);
  assert.ok(found, "更新后应能查到");
  assert.equal(Number(found.threshold), 88, "阈值应已更新为 88");

  const t = await req(`/api/monitor/alert/rules/${id}/toggle`, { method: "POST", body: "{}" });
  assert.equal(t.status, 200, `切换失败 ${JSON.stringify(t.body).slice(0, 200)}`);
  assert.equal(t.body.data.enabled, false, "切换后应为停用");

  const d = await req(`/api/monitor/alert/rules/${id}`, { method: "DELETE" });
  assert.equal(d.status, 200, `删除失败 ${JSON.stringify(d.body).slice(0, 200)}`);
  const after = await req("/api/monitor/alert/rules");
  assert.ok(!after.body.data.find((r) => r.id === id), "删除后不应还能查到");
});

await check("非法规则被拒绝（避免静默失效的规则）", async () => {
  const bad = await req("/api/monitor/alert/rules", {
    method: "POST",
    body: JSON.stringify({ name: "坏指标", metric: "not_a_real_metric", operator: ">", threshold: 1 }),
  });
  assert.equal(bad.status, 400, `未知指标应被拒绝，实际 HTTP ${bad.status}`);
  const badOp = await req("/api/monitor/alert/rules", {
    method: "POST",
    body: JSON.stringify({ name: "坏操作符", metric: "error_rate", operator: "===", threshold: 1 }),
  });
  assert.equal(badOp.status, 400, `未知比较符应被拒绝，实际 HTTP ${badOp.status}`);
});

await check("维护窗口开关可切换", async () => {
  const on = await req("/api/monitor/alert/silence", { method: "POST", body: JSON.stringify({ minutes: 5, reason: "冒烟测试" }) });
  assert.equal(on.status, 200, `开启失败 ${JSON.stringify(on.body).slice(0, 200)}`);
  const cfg = await req("/api/monitor/alert/config");
  assert.equal(cfg.body.data.silenced, true, "开启后 silenced 应为 true");
  const off = await req("/api/monitor/alert/silence", { method: "POST", body: JSON.stringify({ minutes: 0 }) });
  assert.equal(off.status, 200, `关闭失败 ${JSON.stringify(off.body).slice(0, 200)}`);
  const cfg2 = await req("/api/monitor/alert/config");
  assert.equal(cfg2.body.data.silenced, false, "关闭后 silenced 应为 false");
});

await check("清理接口拒绝 days<=0（防止一键清空历史）", async () => {
  const r = await req("/api/monitor/alert/cleanup", { method: "POST", body: JSON.stringify({ days: 0 }) });
  assert.equal(r.status, 400, `days=0 应被拒绝，实际 HTTP ${r.status}`);
});

await check("SSE 流能建立连接并推送首帧", async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`${BASE}/api/monitor/stream?interval=1000`, { headers: H, signal: ctrl.signal });
    assert.equal(r.status, 200, `HTTP ${r.status}`);
    assert.match(String(r.headers.get("content-type")), /event-stream/, "content-type 必须是 event-stream");
    const reader = r.body.getReader();
    const { value } = await reader.read();
    const text = Buffer.from(value || []).toString("utf8");
    assert.match(text, /^data: /, `首帧应是 data: 开头，实际 "${text.slice(0, 80)}"`);
    const payload = JSON.parse(text.replace(/^data: /, "").trim());
    assert.ok(typeof payload.qps === "object", "首帧缺 qps");
    assert.ok(typeof payload.inFlight === "number", "首帧缺 inFlight");
    reader.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
});

await pool.end().catch(() => {});
console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
