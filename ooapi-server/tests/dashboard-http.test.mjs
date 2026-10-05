// 真 Express HTTP + 受控日志样本；不连接真实库、不写业务数据、不访问模型上游。
import assert from "node:assert/strict";
import express from "express";
process.env.JWT_SECRET = "fixture-dashboard-http-only";
const { pool } = await import("../src/db.js");
const { signToken } = await import("../src/middleware/auth.js");
const { loadOptions } = await import("../src/config.js");
const { invalidatePrices } = await import("../src/services/pricing.js");
const dashboard = (await import("../src/routes/dashboard.js")).default;
const stamp = (iso) => Date.parse(iso) / 1000;
const requestNow = stamp("2026-10-05T15:59:58Z");
const today = stamp("2026-10-04T16:00:00Z"), since = today - 6 * 86400;
let clock = requestNow, crossMidnight = false;
const users = [
  { id: 1, username: "fixture-admin", role: 1000, status: 1, token_version: 0, created_time: since - 1 },
  { id: 2, username: "fixture-a", display_name: "Fixture A", avatar_media_id: 99, role: 1, status: 1, token_version: 0, group_name: "", created_time: since + 1 },
  { id: 3, username: "fixture-b", display_name: "Fixture B", avatar_media_id: 100, role: 1, status: 1, token_version: 0, group_name: "", created_time: since + 1 },
];
const tokens = [{ id: 11, user_id: 2, name: "Key A" }, { id: 12, user_id: 3, name: "Key B" }];
const channels = [{ id: 7, name: "Fixture edited channel", type: "qwen" }];
const sample = (created_at, status, quota, extra = {}) => ({ id: 0, user_id: 2, token_id: 11,
  channel_id: 7, created_at, model: "fixture-model", type: status === "success" ? 2 : 4,
  is_usage: 1, status, quota, prompt_tokens: 0, completion_tokens: 0, cache_tokens: 0,
  elapsed_ms: 100, first_token_known: 0, first_token_ms: 0,
  detail: JSON.stringify({ source_vendors: ["opencode"], requested_model: "fixture-alias", upstream_model: "fixture-model-free", pricing_model: "fixture-model", private: "NEVER_EXPOSE_DETAIL" }), ...extra });
const logs = [
  sample(since, "success", 100, { prompt_tokens: 100, completion_tokens: 10, cache_tokens: 60, first_token_known: 1 }),
  sample(requestNow, "success", 200, { prompt_tokens: 200, completion_tokens: 20, cache_tokens: 100, first_token_known: 1, first_token_ms: 200 }),
  sample(requestNow - 5, "partial", 50, { prompt_tokens: 50, completion_tokens: 5, cache_tokens: 10, first_token_known: 1, first_token_ms: 300 }),
  sample(requestNow - 10, "error", 0, { model: "" }),
  sample(requestNow - 15, "stopped", 10, { prompt_tokens: 10, completion_tokens: 1 }),
  sample(since - 1, "success", 80), sample(requestNow + 1, "success", 999999),
  sample(requestNow - 20, "error", 999, { is_usage: 0 }),
  sample(requestNow - 1, "success", 900, { user_id: 3, token_id: 12, prompt_tokens: 999, completion_tokens: 99 }),
  // 零价格、高频型号同样进入完整模型分布，不能被按消费筛掉。
  ...Array.from({ length: 13 }, (_, i) => sample(since + i + 1, "success", 0, { token_id: 0, model: `zero-model-${i}`, prompt_tokens: i + 1, detail: "{}" })),
].map((row, i) => ({ ...row, id: i + 1 }));
const originalQuery = pool.query, originalConnection = pool.getConnection, originalNow = Date.now;
Date.now = () => clock * 1000;
const queries = [];
const sum = (rows, key) => rows.reduce((n, row) => n + Number(row[key] || 0), 0);
const isUsage = (l) => l.type === 2 || l.type === 4 && l.is_usage === 1;
const isSuccess = (l) => l.type === 2 && ["", "success"].includes(l.status);
const isFailure = (l) => l.type === 4 && l.is_usage === 1 && l.status !== "stopped";
const agg = (rows) => {
  const first = rows.filter((l) => l.first_token_known === 1 || l.first_token_ms > 0);
  return { calls: rows.length, units: sum(rows, "quota"), prompt_tokens: sum(rows, "prompt_tokens"),
    completion_tokens: sum(rows, "completion_tokens"), cache_tokens: sum(rows, "cache_tokens"),
    total_tokens: sum(rows, "prompt_tokens") + sum(rows, "completion_tokens"), tokens: sum(rows, "prompt_tokens") + sum(rows, "completion_tokens"),
    successes: rows.filter(isSuccess).length, errors: rows.filter(isFailure).length,
    stopped: rows.filter((l) => l.status === "stopped").length, partial: rows.filter((l) => l.status === "partial").length,
    models: new Set(rows.map((l) => l.model)).size, users: new Set(rows.map((l) => l.user_id)).size,
    avg_elapsed: rows.length ? sum(rows, "elapsed_ms") / rows.length : 0,
    avg_first_token: first.length ? sum(first, "first_token_ms") / first.length : null };
};
const group = (rows, key) => {
  const map = new Map();
  for (const row of rows) { const k = typeof key === "function" ? key(row) : row[key]; if (!map.has(k)) map.set(k, []); map.get(k).push(row); }
  return [...map].map(([k, entries]) => ({ k, entries, ...agg(entries) }));
};
// 按参数所在 SQL 位置求筛选值，而非预设路由结果，专门检验范围/Key 占位符错位。
function selected(sql, args) {
  let rows = logs.filter(isUsage);
  for (const hit of sql.matchAll(/\b(?:l\.)?(user_id|token_id|created_at)\s*(=|>=|<)\s*\?/g)) {
    const index = (sql.slice(0, hit.index).match(/\?/g) || []).length;
    const value = Number(args[index]);
    rows = rows.filter((r) => hit[2] === "=" ? r[hit[1]] === value : hit[2] === ">=" ? r[hit[1]] >= value : r[hit[1]] < value);
  }
  if (/WHERE .*type = 4 AND is_usage = 1 AND status <> 'stopped'/.test(sql) && !/type = 2 OR/.test(sql)) rows = rows.filter(isFailure);
  if (sql.includes("channel_id > 0")) rows = rows.filter((l) => l.channel_id > 0);
  if (sql.includes("token_id > 0")) rows = rows.filter((l) => l.token_id > 0);
  return rows;
}
const fixtureQuery = async (raw, args = []) => {
  const sql = String(raw).replace(/\s+/g, " ").trim();
  assert.equal((sql.match(/\?/g) || []).length, args.length, `SQL 参数数量：${sql}`);
  queries.push({ sql, args });
  if (sql.startsWith("SELECT * FROM users WHERE id") || sql.startsWith("SELECT quota, used_quota")) return [users.filter((u) => u.id === Number(args[0]))];
  if (sql.startsWith("SELECT user_id FROM tokens")) return [tokens.filter((t) => t.id === Number(args[0]))];
  if (sql.includes("FROM model_attributions")) return [[]];
  if (sql.includes("FROM model_prices")) return [[{ model: "fixture-model", channel_type: "openai", input_price: 1, output_price: 2, cache_price: .1 }]];
  if (sql.includes("FROM options")) return [[{ key_str: "user_data_visibility", value: JSON.stringify({ version: 1, balance: true, usage_summary: true, usage_records: true, request_content: false, pricing: true }) }]];
  if (sql.includes("FROM channel_groups")) return [[]];
  if (sql.startsWith("SELECT id, type FROM channels")) return [channels.filter((c) => args.includes(c.id))];
  if (sql.includes("FROM tokens") && !sql.includes("FROM logs")) return [[{ active_tokens: 1, total_tokens: 1 }]];
  if (sql.startsWith("SELECT COUNT(*) AS n FROM users")) return [[{ n: users.length }]];
  if (!sql.includes("FROM logs")) throw new Error(`未处理 fixture 查询：${sql}`);
  if (crossMidnight) { clock = requestNow + 5; crossMidnight = false; }
  const rows = selected(sql, args);
  if (sql.startsWith("SELECT id, created_at") || sql.startsWith("SELECT l.id, l.created_at")) return [[...rows].sort((a, b) => b.id - a.id).slice(0, 8).map((r) => ({ ...r, ...Object.fromEntries(["username", "display_name", "avatar_media_id"].map((key) => [key, users.find((u) => u.id === r.user_id)?.[key]])) }))];
  if (sql.includes("GROUP BY l.model")) return [group(rows, "model").map((r) => ({ ...r, model: r.k,
    source_snapshots: [...new Set(r.entries.map((l) => { try { return JSON.stringify(JSON.parse(l.detail).source_vendors); } catch { return undefined; } }).filter(Boolean))].join("\n"),
    legacy_source_vendors: r.entries.some((l) => !Object.hasOwn(JSON.parse(l.detail), "source_vendors")) ? "qwen" : "" }))];
  if (sql.includes("GROUP BY FLOOR((created_at")) return [group(rows, (r) => Math.floor((r.created_at + 28800) / 86400)).map((r) => ({ ...r, bj_day: r.k }))];
  if (sql.includes("GROUP BY FLOOR(MOD")) return [group(rows, (r) => Math.floor(((r.created_at + 28800) % 86400) / 3600)).map((r) => ({ ...r, hour: r.k }))];
  if (sql.includes("GROUP BY l.user_id")) return [group(rows, "user_id").map((r) => ({ ...r, user_id: r.k, ...users.find((u) => u.id === r.k) }))];
  if (sql.includes("GROUP BY l.channel_id")) return [group(rows, "channel_id").map((r) => ({ ...r, channel_id: r.k, channel_name: channels[0].name, channel_type: channels[0].type }))];
  if (sql.includes("GROUP BY channel_id")) return [group(rows, "channel_id").map((r) => ({ ...r, channel_id: r.k }))];
  if (sql.includes("GROUP BY token_id")) return [group(rows, "token_id").map((r) => ({ ...r, token_id: r.k, token_name: tokens.find((t) => t.id === r.k)?.name, username: "fixture-owner" }))];
  if (sql.includes("GROUP BY model")) return [group(rows, "model").map((r) => ({ model: r.k, errors: r.calls }))];
  if (sql.startsWith("SELECT COUNT(*) AS n")) return [[{ n: rows.length }]];
  return [[agg(rows)]];
};
const transactions = [];
let snapshotActive = false;
pool.query = async (...args) => {
  assert.equal(snapshotActive, false, "统计快照持有连接时不得再借全局池查询元数据");
  return fixtureQuery(...args);
};
pool.getConnection = async () => {
  const trace = []; transactions.push(trace);
  return {
    query: async (sql, args) => {
      if (String(sql).startsWith("SET TRANSACTION")) { trace.push("isolation"); return [[]]; }
      if (String(sql).startsWith("START TRANSACTION")) { snapshotActive = true; trace.push("start"); return [[]]; }
      assert.equal(snapshotActive, true); trace.push("read"); return fixtureQuery(sql, args);
    },
    commit: async () => { snapshotActive = false; trace.push("commit"); },
    rollback: async () => { snapshotActive = false; trace.push("rollback"); },
    release: () => trace.push("release"), destroy: () => { snapshotActive = false; trace.push("destroy"); },
  };
};
const app = express(); app.use("/dashboard", dashboard);
app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}/dashboard`;
async function get(path, uid = 1, expectedStatus = 200) {
  clock = requestNow;
  const response = await fetch(base + path, { headers: { Authorization: `Bearer ${signToken(users.find((u) => u.id === uid))}` } });
  const body = await response.json(); assert.equal(response.status, expectedStatus, body.message); return body.data;
}
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`  ok  ${name}`); };
try {
  await loadOptions(); invalidatePrices();
  crossMidnight = true;
  const d = await get("/admin?range=7d&user_id=2&token_id=11");
  check("跨午夜固定生成时刻，7 个北京日与所有查询同范围", () => {
    assert.equal(d.range.generated_at, requestNow); assert.equal(d.range.from, since); assert.equal(d.range.to, requestNow);
    assert.equal(d.range.timezone, "Asia/Shanghai"); assert.equal(d.trend.length, 7); assert.equal(d.trend.at(-1).day, "2026-10-05");
    assert.equal(d.trend.reduce((n, r) => n + r.calls, 0), d.totals.calls);
  });
  check("用户/Key 过滤排除其他人、旧重复错误、范围外及未来记录", () => {
    assert.equal(d.totals.calls, 5); assert.equal(d.totals.units, 360); assert.equal(d.totals.total_tokens, 396);
    assert.equal(d.totals.active_users, 1); assert.ok(d.recent_logs.every((r) => r.user_id === 2));
  });
  check("失败已含部分输出，停止单列，成功率分母全部请求", () => {
    assert.deepEqual([d.totals.successes, d.totals.errors, d.totals.partial, d.totals.stopped, d.totals.remaining], [2, 2, 1, 1, 0]);
    assert.equal(d.totals.success_rate, 40); assert.equal(d.trend.reduce((n, r) => n + r.errors, 0), 2);
  });
  check("缓存含在输入内，真实 0ms 首字纳入平均", () => {
    assert.equal(d.totals.prompt_tokens, 360); assert.equal(d.totals.cache_tokens, 170); assert.equal(d.totals.uncached_tokens, 190);
    assert.equal(d.totals.avg_first_token, 167); assert.equal(d.by_channel[0].avg_first_token, 167);
  });
  check("最近记录安全投影最新头像与请求/上游/计费型号", () => {
    const row = d.recent_logs.find((r) => r.status === "partial");
    assert.equal(row.avatar_url, "/api/media/avatar/2?v=99"); assert.equal(row.requested_model, "fixture-alias");
    assert.equal(row.upstream_model, "fixture-model-free"); assert.equal(row.billing_model, "fixture-model");
    assert.ok(!JSON.stringify(d).includes("NEVER_EXPOSE_DETAIL"));
  });
  check("模型/渠道/趋势分项与总计完全对齐，快照优先于当前渠道", () => {
    assert.equal(d.top_models.reduce((n, r) => n + r.calls, 0), d.totals.calls);
    assert.equal(d.top_models.reduce((n, r) => n + r.units, 0), d.totals.units);
    assert.equal(d.top_models.reduce((n, r) => n + r.total_tokens, 0), d.totals.total_tokens);
    assert.equal(d.by_channel[0].total_tokens, 396);
    assert.deepEqual(d.top_models.find((r) => r.model === "fixture-model").source_vendors, ["opencode"]);
  });
  check("上一周期与首日边界不重叠", () => { assert.equal(d.previous.calls, 1); assert.equal(d.previous.units, 80); });
  const full = await get("/admin?range=7d&user_id=2");
  check("14+ 模型完整保留，免费型号可按调用排序", () => {
    assert.equal(full.top_models.length, 15); assert.ok(!full.top_models.some((r) => r.model === "其他模型"));
    assert.equal(full.top_models.filter((r) => r.model.startsWith("zero-model-")).length, 13);
    assert.equal(full.top_models.reduce((n, r) => n + r.calls, 0), full.totals.calls);
  });
  const self = await get("/self?range=7d&user_id=3", 2);
  check("个人范围不能被 user_id 覆盖，任何记录均不泄露上游/其他用户", () => {
    assert.equal(self.totals.calls, full.totals.calls);
    assert.ok(self.recent_logs.every((r) => !r.upstream_model && !Object.hasOwn(r, "user_id")));
    assert.equal(self.by_model.reduce((n, r) => n + r.units, 0), self.totals.units);
  });
  logs.push(...[
    sample(since + 1, "success", 3, { model: "claude-opus-4-6", token_id: 0 }),
    sample(since + 2, "partial", 5, { model: "claude-opus-4-6-thinking", token_id: 0 }),
    sample(since + 3, "success", 2, { model: "3-auto", token_id: 0 }),
    sample(since + 4, "success", 4, { model: "4-auto", token_id: 0 }),
  ].map((row, i) => ({ ...row, id: 100 + i })));
  const aliases = await get("/admin?range=7d&user_id=2");
  check("历史能力别名只合并统计身份，渠道专属 auto 各自保留", () => {
    const row = aliases.top_models.find((r) => r.model === "claude-opus-4-6");
    assert.equal(row.calls, 2); assert.equal(row.units, 8); assert.equal(row.partial, 1); assert.equal(row.errors, 1);
    assert.ok(!aliases.top_models.some((r) => r.model.endsWith("-thinking")));
    assert.equal(aliases.totals.models, aliases.top_models.length);
    assert.ok(aliases.top_models.some((r) => r.model === "3-auto")); assert.ok(aliases.top_models.some((r) => r.model === "4-auto"));
    assert.equal(aliases.top_models.reduce((n, r) => n + r.units, 0), aliases.totals.units);
  });
  const empty = await get("/admin?range=7d&user_id=98765");
  check("无样本成功率/缓存率/首字时间保持未知，日期完整补零", () => {
    assert.equal(empty.totals.calls, 0); assert.equal(empty.totals.success_rate, null); assert.equal(empty.totals.cache_rate, null);
    assert.equal(empty.totals.avg_first_token, null); assert.equal(empty.trend.length, 7); assert.deepEqual(empty.recent_logs, []);
  });
  await get("/admin?range=7d&user_id=3&token_id=11", 1, 400);
  await get("/admin?range=7d", 2, 403);
  check("拒绝不匹配用户密钥与普通用户管理员接口", () => assert.ok(true));
  for (const [range, days] of [["30d", 30], ["90d", 90], ["__proto__", 30]]) {
    const data = await get(`/self?range=${range}`, 2);
    check(`固定范围 ${range}`, () => assert.equal(data.trend.length, days));
  }
  check("所有日志查询占位符与参数一致并携带固定时间上限", () => {
    const logQueries = queries.filter((q) => q.sql.includes("FROM logs"));
    assert.ok(logQueries.length > 30); assert.ok(logQueries.every((q) => /created_at < \?/.test(q.sql)));
  });
  check("每次成功看板提交并释放连接，品牌/价格读取都在事务外", () => {
    assert.ok(transactions.length > 5);
    assert.ok(transactions.every((trace) => trace[0] === "isolation" && trace[1] === "start" && trace.at(-2) === "commit" && trace.at(-1) === "release"));
    assert.equal(snapshotActive, false);
  });
} finally {
  Date.now = originalNow; pool.query = originalQuery; pool.getConnection = originalConnection; invalidatePrices();
  await new Promise((resolve) => server.close(resolve)); await pool.end();
}
console.log(`Dashboard HTTP: ${checks} checks passed (real DB/upstream requests: 0)`);
process.exit(0);
