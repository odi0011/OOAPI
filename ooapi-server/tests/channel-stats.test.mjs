// 管理路由真实 HTTP 回归；pool 完全替换为内存样本，不连接或修改真实数据库。
import assert from "node:assert/strict";
process.env.JWT_SECRET = "fixture-channel-statistics-only";
const { pool } = await import("../src/db.js");
const { signToken } = await import("../src/middleware/auth.js");
const express = (await import("express")).default;
const { default: channelRoutes } = await import("../src/routes/channel.js");

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const requestNow = sec("2026-10-05T15:59:58Z"); // 北京时间午夜前，查询期间模拟跨午夜。
const todayStart = sec("2026-10-04T16:00:00Z");
const hourSince = todayStart - 30 * 86400;
const user = { id: 991021, username: "fixture-stats-admin", role: 1000, status: 1, token_version: 0 };
const channels = new Map([7, 8].map((id) => [id, {
  id, name: `fixture-channel-${id}`, type: "openai", recent_calls: "[]", group_list: "[]",
}]));
const sample = (channel_id, created_at, prompt_tokens, completion_tokens, detail = {}) => ({
  channel_id, created_at, prompt_tokens, completion_tokens, cache_tokens: 0,
  model: "fixture-model", quota: 0, detail: JSON.stringify(detail),
});
const logs = [
  sample(7, todayStart, 10, 2, { prompt_tokens: 9000, completion_tokens: 9000 }),
  sample(7, todayStart + 3599, 0, 0, { prompt_tokens: 3, completion_tokens: 4 }),
  sample(7, todayStart + 3600, 5, 1),
  sample(7, sec("2026-10-05T00:00:00Z"), 6, 2),
  sample(7, requestNow, 7, 2),
  sample(7, todayStart - 1, 10, 1),
  sample(7, hourSince, 6, 3),
  sample(7, hourSince - 1, 900, 100),
  sample(7, requestNow + 1, 9000, 999),
  sample(8, todayStart, 40000, 10000),
  // 同时含 channel_id/channel_ids 的旧日志只能被一次查询纳入一次。
  sample(0, todayStart + 7200, 0, 0, { channel_id: 7, channel_ids: [7], prompt_tokens: 7, completion_tokens: 2, cache_tokens: 6 }),
  sample(0, todayStart, 0, 0, { channel_id: 9, channel_ids: [9], prompt_tokens: 70000, completion_tokens: 10000 }),
];
const originalQuery = pool.query;
const originalNow = Date.now;
let clock = requestNow;
let crossMidnight = false;
const queries = [];
Date.now = () => clock * 1000;
const auth = signToken(user);
pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, " ").trim();
  assert.equal((q.match(/\?/g) || []).length, params.length, `SQL 参数不匹配：${q}`);
  queries.push({ q, params });
  if (q.startsWith("SELECT * FROM users")) return [[{ ...user }]];
  if (q === "SELECT * FROM channels WHERE id = ?") {
    if (crossMidnight) clock = requestNow + 5;
    return [[channels.get(Number(params[0]))].filter(Boolean)];
  }
  if (q.includes("FROM logs") && q.includes("COUNT(*) AS calls")) {
    return [[{ calls: 0, units: 0, pt: 0, ct: 0 }]];
  }
  if (q.startsWith("SELECT created_at") && q.includes("FROM logs")) {
    const [since, channelId] = params;
    const selected = logs.filter((l) => {
      if (l.created_at < since) return false;
      if (!q.includes("channel_id = 0")) return l.channel_id === Number(channelId);
      const d = JSON.parse(l.detail);
      return l.channel_id === 0 && (Number(d.channel_id) === Number(channelId) || d.channel_ids?.includes(Number(channelId)));
    });
    return [selected.map((l) => ({ ...l }))];
  }
  throw new Error(`未处理的内存查询：${q}`);
};

const app = express();
app.use("/api/channel", channelRoutes);
app.use((error, _req, res, _next) => res.status(500).json({ success: false, message: error.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}/api/channel`;
const get = async (id, days) => {
  clock = requestNow;
  const response = await fetch(`${base}/${id}/stats?days=${days}`, { headers: { Authorization: `Bearer ${auth}` } });
  const body = await response.json();
  assert.equal(response.status, 200, body.message);
  assert.equal(body.success, true, body.message);
  return body.data;
};
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`  ok  ${name}`); };
try {
  crossMidnight = true;
  const yearly = await get(7, 365);
  check("跨午夜请求固定生成时刻，日期列表不会跳到次日", () => {
    assert.equal(yearly.generatedAt, requestNow);
    assert.equal(yearly.timezone, "Asia/Shanghai");
    assert.equal(yearly.byDay.length, 365);
    assert.equal(yearly.byDay.at(-1).day, "2026-10-05");
  });
  check("UTC 午夜与北京时间午夜使用同一北京日期", () => {
    assert.equal(yearly.byDay.at(-1).tokens, 51);
    assert.equal(yearly.byDay.at(-1).calls, 6);
    assert.equal(yearly.byDay.at(-2).tokens, 11);
    assert.equal(yearly.byDay.at(-2).calls, 1);
  });
  check("新 token 列与旧 detail 回落同口径，旧渠道归属不会重复计数", () => {
    assert.equal(yearly.totals.tokens, 1071);
    assert.equal(yearly.totals.calls, 9);
    assert.equal(yearly.totals.cacheTokens, 6);
    assert.equal(yearly.byHour.reduce((sum, h) => sum + h.tokens, 0), 71);
    assert.equal(yearly.byHour.reduce((sum, h) => sum + h.calls, 0), 8);
  });
  check("小时桶稀疏升序且整点前后分桶，未来记录不参与统计", () => {
    assert.deepEqual(yearly.byHour.find((h) => h.time === todayStart), { time: todayStart, calls: 2, tokens: 19 });
    assert.deepEqual(yearly.byHour.find((h) => h.time === todayStart + 3600), { time: todayStart + 3600, calls: 1, tokens: 6 });
    assert.ok(yearly.byHour.every((h, i, all) => h.time % 3600 === 0 && h.time <= requestNow && (!i || h.time > all[i - 1].time)));
    assert.equal(yearly.byHour.length, 7);
  });
  check("31 日窗口包含首日午夜，前一秒只进入全年日统计", () => {
    assert.deepEqual(yearly.byHour[0], { time: hourSince, calls: 1, tokens: 9 });
    assert.ok(!yearly.byHour.some((h) => h.time < hourSince));
    const boundaryDay = new Date((hourSince + 8 * 3600) * 1000).toISOString().slice(0, 10);
    assert.equal(yearly.byDay.find((d) => d.day === boundaryDay).tokens, 9);
  });
  crossMidnight = false;
  const today = await get(7, 1);
  check("一日趋势包含完整北京今日，额外小时样本不污染今日汇总", () => {
    assert.deepEqual(today.byDay.map((d) => [d.day, d.calls, d.tokens]), [["2026-10-05", 6, 51]]);
    assert.equal(today.totals.calls, 6);
    assert.equal(today.totals.tokens, 51);
    assert.deepEqual(today.byHour, yearly.byHour);
    assert.deepEqual(today.series[0].values, [51]);
    const selections = queries.filter(({ q }) => q.startsWith("SELECT created_at")).slice(-2);
    assert.ok(selections.every(({ params }) => params[0] === hourSince));
  });
  const weekly = await get(7, 7);
  check("七日趋势从首日完整午夜开始且恰有七个日历日", () => {
    assert.equal(weekly.byDay.length, 7);
    assert.equal(weekly.byDay[0].day, "2026-09-29");
    assert.equal(weekly.totals.calls, 7);
    assert.equal(weekly.totals.tokens, 62);
  });
  const other = await get(8, 30);
  check("当前渠道与其他渠道日志严格隔离", () => {
    assert.equal(other.totals.calls, 1);
    assert.equal(other.totals.tokens, 50000);
    assert.deepEqual(other.byHour, [{ time: todayStart, calls: 1, tokens: 50000 }]);
  });
  console.log(`渠道时间活动真实 HTTP 回归 ${checks} 项通过（真实数据库查询 0）`);
} finally {
  Date.now = originalNow;
  pool.query = originalQuery;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
