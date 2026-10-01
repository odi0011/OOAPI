// 真 HTTP 管理路由与受控上游；数据库全部在内存，验证成功后错误状态清除且不复活禁用渠道。
import assert from "node:assert/strict";
import http from "node:http";
process.env.JWT_SECRET = "fixture-channel-recovery-only";
const { pool } = await import("../src/db.js");
const { signToken } = await import("../src/middleware/auth.js");
const express = (await import("express")).default;
const { default: channelRoutes } = await import("../src/routes/channel.js");
const { resetChannelState, resumeRateLimitedChannels } = await import("../src/services/router.js");
const { runDueChannelTests } = await import("../src/services/autotest.js");
const user = { id: 992013, username: "fixture-admin", role: 1000, status: 1, token_version: 0 };
const auth = signToken(user);
let row;
let tested = 0;
let upstreamCalls = 0;
const upstream = http.createServer((req, res) => {
  req.resume(); upstreamCalls++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "fixture healthy" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const originalQuery = pool.query;
pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, " ").trim();
  assert.equal((q.match(/\?/g) || []).length, params.length, `SQL parameter mismatch: ${q}`);
  if (q.startsWith("SELECT * FROM users")) return [[{ ...user }]];
  if (q.startsWith("SELECT") && q.includes("FROM channels")) {
    if (q.includes("auto_test = 1")) return [[...(row.auto_test && row.status === 1 ? [{ ...row }] : [])]];
    if (q.includes("rate_limit_until > 0")) return [[...(row.status === 3 && row.rate_limit_until > 0 && row.rate_limit_until <= params[0] ? [{ ...row }] : [])]];
    return [[{ ...row }]];
  }
  if (q.startsWith("SELECT") && q.includes("FROM logs")) return [[]];
  if (q.startsWith("INSERT INTO logs")) return [{ insertId: 1 }];
  if (q.startsWith("UPDATE channels SET")) {
    const assignments = q.slice("UPDATE channels SET ".length, q.indexOf(" WHERE ")).split(",");
    let index = 0;
    for (const assignment of assignments) {
      const match = assignment.trim().match(/^(\w+)\s*=\s*(\?|''|\d+)$/);
      assert.ok(match, `Unhandled assignment: ${assignment}`);
      row[match[1]] = match[2] === "?" ? params[index++] : match[2] === "''" ? "" : Number(match[2]);
    }
    assert.equal(index + 1, params.length, "Fixture exercises exactly one channel");
    assert.equal(Number(params[index]), row.id);
    return [{ affectedRows: 1 }];
  }
  throw new Error(`Unexpected fixture query: ${q}`);
};
const app = express(); app.use(express.json()); app.use("/api/channel", channelRoutes);
app.use((error, _req, res, _next) => res.status(500).json({ success: false, message: error.message }));
const service = app.listen(0, "127.0.0.1");
await new Promise((resolve) => service.once("listening", resolve));
const base = `http://127.0.0.1:${service.address().port}/api/channel`;
const request = async (path, method = "GET", body) => {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.success, true, data.message); return data.data;
};
const stale = (status) => {
  row = { id: 991203, name: "fixture-open-code", type: "opencode", status, api_key: "fixture-key", models: "space-bunny-free", auto_ban: 1,
    base_url: `http://127.0.0.1:${upstream.address().port}/v1`, group_list: "[]", priority: 0, weight: 1,
    other: JSON.stringify({ method: "api", allow_private_upstream: true, min_gap_ms: 0, max_per_min: 1000 }),
    last_error: "HTTP 401 invalid key", last_error_code: "CHANNEL_AUTH_EXPIRED", rate_limit_until: Math.floor(Date.now() / 1000) + 3600 };
  resetChannelState(row.id);
};
const cleared = async (status) => {
  assert.equal(row.status, status); assert.equal(row.last_error, ""); assert.equal(row.last_error_code, ""); assert.equal(row.rate_limit_until, 0);
  const items = await request("/"); const recovery = await request(`/${row.id}/recovery`);
  assert.equal(items[0].needsRelogin, false); assert.equal(items[0].rate_limit_until, 0); assert.notEqual(items[0].status_label, "限流停用"); assert.equal(recovery.needsRelogin, false);
};
try {
  for (const status of [1, 2, 3]) {
    stale(status); const calls = upstreamCalls;
    await request(`/${row.id}/test`, "POST"); await cleared(status);
    assert.equal(upstreamCalls, calls + 1);
    tested++; console.log(`  ok  成功测试清除旧鉴权码与429标记，status=${status} 保持`);
  }
  stale(3); await request(`/${row.id}/keys`, "POST", { action: "replace", keys: ["fixture-new-key"] }); await cleared(3);
  tested++; console.log("  ok  替换Key清旧错误且自动暂停状态保持");
  stale(2); await request("/", "PUT", { id: row.id, api_key: "fixture-edited-key" }); await cleared(2);
  tested++; console.log("  ok  编辑Key清旧错误且管理员禁用状态保持");
  stale(3); row.auto_test = 1; row.status = 1; row.last_test_time = 0;
  await runDueChannelTests(); await cleared(1);
  tested++; console.log("  ok  自动检测成功同步清除错误码与限流标记");
  stale(3); row.rate_limit_until = Math.floor(Date.now() / 1000) - 1; row.last_error_code = "CHANNEL_RATE_LIMIT";
  await resumeRateLimitedChannels(); await cleared(1);
  tested++; console.log("  ok  到期限流恢复同步清除旧错误码");
} finally {
  service.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise((resolve) => service.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  pool.query = originalQuery; await pool.end();
}
console.log(`渠道恢复真实 HTTP 回归 ${tested} 项通过`);
