// 真实 Express HTTP + 内存池：只验证权限，不访问用户数据库或收费上游。
import assert from "node:assert/strict";
import express from "express";
import bcrypt from "bcryptjs";
process.env.JWT_SECRET = "visibility-fixture-signing-only";
const { pool } = await import("../src/db.js");
const { signToken } = await import("../src/middleware/auth.js");
const { loadOptions, setOption, publicStatus, getOption } = await import("../src/config.js");
const { configuredUserDataVisibility, parseUserDataVisibility } = await import("../src/services/user-data-visibility.js");
const { TOOLS } = await import("../src/services/harness/tools.js");
const { startRun, publish, finishRun } = await import("../src/services/harness/runs.js");
const routes = await Promise.all(["auth", "user", "token", "profile", "dashboard", "log", "pricing", "option", "chat"].map(async (name) => [name, (await import(`../src/routes/${name}.js`)).default]));
const hash = bcrypt.hashSync("FixtureInput7", 4);
const users = new Map([1, 100].map((role) => [role, { id: role, role, status: 1, username: `fixture_${role}`, display_name: "Fixture", password: hash,
  quota: 7654321, used_quota: 3456789, request_count: 29, token_version: 0, group_name: "fixture", created_time: 1, last_login_time: 2 }]));
const all = (value) => ({ version: 1, balance: value, usage_summary: value, usage_records: value, request_content: value, pricing: value });
const settings = new Map();
const queries = [];
const sentinel = "PRIVATE_VISIBILITY_SENTINEL";
const bill = { version: 1, components: { input: { tokens: 123, unit_price: 1, cost_od: .01 }, output: { tokens: 45, unit_price: 2, cost_od: .02 }, cache: { tokens: 0, unit_price: 0, cost_od: 0 } }, raw_cost_od: .03, base_cost_units: 300, charged_cost_units: 300,
  channel_quote: { provider: sentinel, price: { in: 0, out: 0, cache: 0 }, status: "available" }, calls: [{ upstream_model: sentinel }] };
const logRow = { id: 42, user_id: 1, username: "fixture_1", created_at: 1, type: 2, is_usage: 1, status: "success", content: sentinel, quota: 300,
  input_text: sentinel, output_text: sentinel, model: "fixture-model", prompt_tokens: 123, completion_tokens: 45, cache_tokens: 0,
  detail: JSON.stringify({ billing_details: bill, request_prompt_text: sentinel }), billing_details: bill };
const keyRow = { id: 1, user_id: 1, name: "Fixture key", status: 1, key_str: "fixture-local-unused", remain_quota: 7654321, used_quota: 3456789, unlimited_quota: 0, group_name: "fixture", expired_time: -1 };
const originalQuery = pool.query;
pool.query = async (sql, args = []) => {
  sql = String(sql); queries.push({ sql, args });
  assert.equal((sql.match(/\?/g) || []).length, args.length, "SQL placeholder count");
  if (/SELECT key_str, value FROM options/.test(sql)) return [[...settings].map(([key_str, value]) => ({ key_str, value }))];
  if (/INSERT INTO options/.test(sql)) { settings.set(args[0], args[1]); return [{ affectedRows: 1 }]; }
  if (/SELECT \* FROM users WHERE username/.test(sql)) return [[...users.values()].filter((u) => u.username === args[0])];
  if (/SELECT \* FROM users WHERE id/.test(sql)) return [[users.get(Number(args[0]))].filter(Boolean)];
  if (/FROM users WHERE id/.test(sql)) return [[users.get(Number(args[0])) || users.get(1)]];
  if (/^(INSERT|UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 1, insertId: 9 }];
  if (/FROM model_prices/.test(sql)) return [[{ model: "fixture-model", input_price: 1, output_price: 2, type: "openai" }]];
  if (/FROM channels/.test(sql)) return [[]];
  if (/FROM channel_groups/.test(sql)) return [[{ id: 1, name: "fixture", rate: 1.7, models: "[]" }]];
  if (/SUM\(used_quota\)/.test(sql)) return [[{ s: 123 }]];
  if (/FROM tokens/.test(sql)) {
    if (/COUNT\(/.test(sql)) return [[{ total_tokens: 1, active_tokens: 1, n: 1, on_: 1 }]];
    return [[keyRow]];
  }
  if (/FROM logs/.test(sql)) {
    if (/SELECT id, created_at|SELECT created_at, type|SELECT id, user_id/.test(sql)) return [[sql.includes("NOT (type = 2") ? { ...logRow, type: 4, is_usage: 0, status: "error" } : logRow]];
    if (/GROUP BY model/.test(sql)) return [[{ model: "fixture-model", day_ts: 20000 * 86400, calls: 2, n: 2, c: 2, units: 300, cost: 300 }]];
    if (/GROUP BY token_id/.test(sql)) return [[{ token_id: 1, token_name: "fixture", c: 2 }]];
    if (/GROUP BY group_name/.test(sql)) return [[{ group_name: "fixture", c: 2 }]];
    if (/GROUP BY FLOOR|GROUP BY day/.test(sql)) return [[{ day: "2026-10-02", day_ts: 20000 * 86400, bj_day: 20000, d: 20000, calls: 2, n: 2, units: 300, quota: 300, cost: 300 }]];
    if (/GROUP BY/.test(sql)) return [[]];
    return [[{ total: 1, calls: 2, successes: 2, units: 300, prompt_tokens: 123, completion_tokens: 45, cache_tokens: 0, models: 1, n: 1, cost: 300, c: 0 }]];
  }
  if (/FROM community_posts p/.test(sql)) return [[]];
  if (/FROM community_|FROM friendships/.test(sql)) return [[{ n: 0, likes: 0, views: 0, following: 0, followers: 0 }]];
  if (/FROM chat_sessions/.test(sql)) return [[{ id: "fixture-session", user_id: 1, title: "Fixture", agent: "general", model: "fixture-model", settings: "{}", cost_units: 300, prompt_tokens: 123, completion_tokens: 45 }]];
  if (/FROM chat_messages/.test(sql)) return [[{ id: 1, seq: 1, role: "assistant", parts: JSON.stringify([{ id: "p", type: "text", text: "Own conversation" }]), cost: .03, prompt_tokens: 123, completion_tokens: 45 }]];
  throw new Error(`Unhandled fixture SQL: ${sql.slice(0, 100)}`);
};
let scenarios = 0;
const test = async (name, run) => { await run(); scenarios++; console.log(`  ok  ${name}`); };
const app = express(); app.use(express.json());
app.get("/api/status", (req, res) => res.json({ success: true, data: publicStatus() }));
for (const [name, router] of routes) app.use(`/api/${name}`, router);
app.use((err, req, res, next) => res.status(500).json({ message: err.message }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
async function call(path, role = 1, body, method = body ? "PUT" : "GET") {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(role ? { Authorization: `Bearer ${signToken(users.get(role))}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...(await response.json()) };
}
async function policy(value) { await setOption("user_data_visibility", value === "" ? "" : JSON.stringify(value)); }
try {
  await loadOptions();
  await test("旧full/summary/hidden及总闸兼容，损坏配置从严", async () => {
    assert.deepEqual(configuredUserDataVisibility(), all(true));
    await setOption("user_visible_quota_detail", "summary"); assert.deepEqual(configuredUserDataVisibility(), { ...all(false), balance: true, usage_summary: true, pricing: true });
    await setOption("user_visible_quota_detail", "hidden"); assert.deepEqual(configuredUserDataVisibility(), { ...all(false), pricing: true });
    await setOption("user_visible_quota_detail", "full"); await setOption("general_setting_quota_display", "false"); assert.deepEqual(configuredUserDataVisibility(), { ...all(false), pricing: true });
    await setOption("general_setting_quota_display", "true"); await setOption("user_data_visibility", "bad-json"); assert.deepEqual(configuredUserDataVisibility(), all(false));
    await policy(all(true)); assert.deepEqual(configuredUserDataVisibility(), all(true));
  });
  await test("配置对象标准化，关闭记录同步关闭正文", async () => {
    const value = { ...all(true), usage_records: false };
    assert.equal(parseUserDataVisibility(value).request_content, false);
    const saved = await call("/api/option", 100, { user_data_visibility: value }); assert.equal(saved.status, 200);
    const read = await call("/api/option", 100); assert.equal(typeof read.data.user_data_visibility, "object"); assert.equal(read.data.user_data_visibility.request_content, false);
    const status = await call("/api/status", 0); assert.deepEqual(status.data.user_data_visibility, read.data.user_data_visibility);
  });
  for (const invalid of [{ ...all(true), api_key: true }, { ...all(true), balance: "true" }, { version: 1, balance: true }, { ...all(true), version: 2 }, [], "{bad"]) {
    await test("非法权限配置整体拒绝且不部分保存", async () => {
      const saved = settings.get("user_data_visibility");
      const r = await call("/api/option", 100, { system_name: "must-not-save", user_data_visibility: invalid });
      assert.equal(r.status, 400); assert.equal(settings.get("user_data_visibility"), saved); assert.notEqual(getOption("system_name"), "must-not-save");
    });
  }
  await test("普通用户不能保存权限，管理员可保存JSON字符串", async () => {
    assert.equal((await call("/api/option", 1, { user_data_visibility: all(true) })).status, 403);
    assert.equal((await call("/api/option", 100, { key: "user_data_visibility", value: JSON.stringify(all(false)) })).status, 200);
  });
  await test("旧库true不能解锁用户主题，币名恒定，管理设置校验", async () => {
    for (const key of ["theme_user_custom", "enable_theme_switch", "enable_primary_switch"]) {
      await setOption(key, "true"); assert.equal(getOption(key), "false"); assert.equal((await call("/api/option", 100, { key, value: true })).status, 400);
    }
    for (const key of ["currency_name", "currency_symbol"]) {
      await setOption(key, "Other"); assert.equal(getOption(key), "OD币"); assert.equal((await call("/api/option", 100, { key, value: "Other" })).status, 400);
    }
    assert.equal((await call("/api/option", 100, { theme_font_family: "invalid" })).status, 400);
    assert.equal((await call("/api/option", 100, { default_theme: "dark", theme_font_family: "serif", default_primary: "teal", theme_accent: "" })).status, 200);
    const s = publicStatus(); assert.equal(s.appearance.mode, "dark"); assert.equal(s.appearance.font_family, "serif"); assert.equal(s.appearance.accent, "#12a594"); assert.equal(s.appearance.user_custom, false);
  });
  await policy(all(false));
  for (const path of ["/api/auth/self", "/api/user/data/self", "/api/profile/me", "/api/profile/u/1", "/api/token", "/api/dashboard/self", "/api/chat/meta"]) {
    await test(`${path}关闭权限后不返回余额和累计值`, async () => {
      const r = await call(path); assert.equal(r.status, 200, JSON.stringify(r));
      assert.ok(!JSON.stringify(r.data).includes("7654321")); assert.ok(!JSON.stringify(r.data).includes("3456789"));
      assert.ok(!JSON.stringify(r.data).includes(sentinel));
    });
  }
  await test("真实登录响应也不旁路返回余额/累计", async () => {
    const r = await call("/api/auth/login", 0, { username: "fixture_1", password: "FixtureInput7" }, "POST");
    assert.equal(r.status, 200); assert.ok(!("quota" in r.data.user)); assert.ok(!("request_count" in r.data.user));
  });
  await test("个人资料更新与令牌创建/编辑回复仍执行相同权限", async () => {
    const u = await call("/api/user/self", 1, { display_name: "Changed" }); assert.equal(u.status, 200); assert.ok(!("quota" in u.data)); assert.ok(!("used_quota" in u.data));
    const created = await call("/api/token", 1, { name: "Fixture key", remain_quota: 100, group_name: "fixture" }, "POST"); assert.equal(created.status, 200, JSON.stringify(created)); assert.ok(!("remain_quota" in created.data)); assert.ok(!("used_quota" in created.data));
    const edited = await call("/api/token", 1, { id: 1, name: "Fixture edited" }); assert.equal(edited.status, 200, JSON.stringify(edited)); assert.ok(!("remain_quota" in edited.data)); assert.ok(!("used_quota" in edited.data));
  });
  await test("旧操作错误及兼容self不能旁路逐次用量/正文", async () => {
    for (const path of ["/api/log/operation", "/api/log/self"]) {
      const r = await call(path); assert.equal(r.status, 200); const row = r.data.items[0];
      assert.ok(!("model" in row)); assert.ok(!("quota" in row)); assert.ok(!("prompt_tokens" in row)); assert.ok(!("input_text" in row)); assert.ok(!JSON.stringify(r.data).includes(sentinel));
    }
  });
  for (const path of ["/api/log/usage", "/api/log/usage/filters", "/api/log/usage/summary", "/api/log/usage/analysis", "/api/token/reconcile", "/api/pricing/public"]) {
    await test(`${path}直接请求被403拦截且不读取业务表`, async () => {
      const start = queries.length, r = await call(path); assert.equal(r.status, 403);
      assert.ok(!queries.slice(start).some((q) => /FROM (logs|tokens|model_prices)/.test(q.sql)));
    });
  }
  await test("匿名公开价格遵循策略，管理员绕过价格关闭", async () => {
    assert.equal((await call("/api/pricing/public", 0)).status, 403);
    assert.equal((await call("/api/pricing/public", 100)).status, 200);
  });
  await test("普通用户不能通过user_id覆盖与admin路径越权", async () => {
    assert.equal((await call("/api/log", 1)).status, 403); assert.equal((await call("/api/dashboard/admin", 1)).status, 403);
    await policy({ ...all(false), usage_records: true });
    const start = queries.length, r = await call("/api/log/usage?user_id=100&keyword=secret"); assert.equal(r.status, 200);
    const logs = queries.slice(start).filter((q) => /FROM logs/.test(q.sql)); assert.ok(logs.every((q) => q.args.includes(1) && !q.args.includes(100))); assert.ok(logs.every((q) => !q.sql.includes("content LIKE")));
    assert.ok(!JSON.stringify(r.data).includes(sentinel)); assert.equal(r.data.items[0].billing_details, null); assert.ok(!("input_text" in r.data.items[0]));
  });
  await test("单独开余额不会带累计/记录，单独开汇总不会带余额/近期", async () => {
    await policy({ ...all(false), balance: true }); const b = await call("/api/dashboard/self"); assert.equal(b.data.account.quota, 7654321); assert.ok(!b.data.totals); assert.deepEqual(b.data.recent_logs, []);
    await policy({ ...all(false), usage_summary: true }); const u = await call("/api/dashboard/self"); assert.equal(u.data.totals.calls, 2); assert.ok(!("quota" in u.data.account)); assert.ok(!("group_rate" in u.data.account)); assert.deepEqual(u.data.recent_logs, []); assert.ok(!("by_channel" in u.data));
    for (const path of ["/api/log/usage/summary", "/api/log/usage/analysis"]) { const r = await call(path); assert.equal(r.status, 200, JSON.stringify(r)); }
    assert.equal((await call("/api/log/usage")).status, 403);
  });
  await test("正文关闭但记录/价格允许时只返回安全费用快照", async () => {
    await policy({ ...all(true), request_content: false }); const r = await call("/api/log/usage");
    assert.ok(r.data.items[0].billing_details); assert.ok(!JSON.stringify(r.data).includes(sentinel)); assert.ok(!("output_text" in r.data.items[0]));
  });
  await test("记录和汇总开启但正文关闭时，列表/汇总/分析关键词均不搜索隐藏正文", async () => {
    await policy({ ...all(true), request_content: false });
    for (const path of ["/api/log/usage", "/api/log/usage/summary", "/api/log/usage/analysis"]) {
      const start = queries.length, r = await call(`${path}?keyword=hidden_probe`); assert.equal(r.status, 200, JSON.stringify(r));
      const sql = queries.slice(start).filter((q) => /FROM logs/.test(q.sql)); assert.ok(sql.length);
      for (const q of sql) {
        assert.ok(!/content\s+LIKE/i.test(q.sql), `${path}不可通过正文命中数泄露内容`);
        assert.ok(/username LIKE \? OR model LIKE \?/.test(q.sql));
        assert.equal(q.args.filter((v) => v === "%hidden_probe%").length, 2);
      }
    }
    const start = queries.length, admin = await call("/api/log/usage/summary?keyword=hidden_probe", 100); assert.equal(admin.status, 200);
    const sql = queries.slice(start).find((q) => /FROM logs/.test(q.sql)); assert.ok(/content\s+LIKE/i.test(sql.sql)); assert.equal(sql.args.filter((v) => v === "%hidden_probe%").length, 3);
  });
  await test("允许正文仍不能得到管理员quote/calls等字段", async () => {
    await policy(all(true)); const r = await call("/api/log/usage"); assert.equal(r.data.items[0].input_text, sentinel);
    assert.ok(!("channel_quote" in r.data.items[0].billing_details)); assert.ok(!("calls" in r.data.items[0].billing_details)); assert.ok(!("detail" in r.data.items[0]));
  });
  await policy(all(false));
  await test("管理员保留余额、记录正文、报价、工具用量", async () => {
    const a = await call("/api/auth/self", 100); assert.equal(a.data.quota, 7654321); assert.equal(a.data.request_count, 29);
    const l = await call("/api/log/usage", 100); assert.equal(l.status, 200); assert.equal(l.data.items[0].input_text, sentinel); assert.equal(l.data.items[0].billing_details.channel_quote.provider, sentinel);
    for (const path of ["/api/log/usage/filters", "/api/log/usage/summary", "/api/log/usage/analysis", "/api/token/reconcile"]) assert.equal((await call(path, 100)).status, 200);
    assert.match((await TOOLS.account.run({ action: "overview" }, { user: users.get(100) })).output, /余额：/);
  });
  await test("account近期/失败/用量受后端权限约束，禁止动作不读日志", async () => {
    for (const action of ["recent", "errors", "usage", "logs", "history"]) {
      const start = queries.length, r = await TOOLS.account.run({ action }, { user: users.get(1) }); assert.equal(r.ok, false); assert.ok(!queries.slice(start).some((q) => /FROM logs/.test(q.sql)));
    }
    for (const action of ["overview", "balance", "tokens"]) {
      const r = await TOOLS.account.run({ action }, { user: users.get(1) }); assert.equal(r.ok, true); assert.doesNotMatch(r.output, /余额：|累计消耗：|近 24 小时：|剩余|已用|OD币|1 美元/);
    }
  });
  await test("account记录正文关闭不会返回旧错误文本，令牌永不查密钥", async () => {
    await policy({ ...all(false), usage_records: true }); const r = await TOOLS.account.run({ action: "errors" }, { user: users.get(1) }); assert.equal(r.ok, true); assert.ok(!r.output.includes(sentinel));
    const start = queries.length; await TOOLS.account.run({ action: "tokens" }, { user: users.get(1) }); assert.ok(!queries.slice(start).some((q) => /key_str/.test(q.sql)));
  });
  await test("会话JSON裁剪审计数字而保留正常正文，真实存储不受影响", async () => {
    await policy(all(false)); const r = await call("/api/chat/sessions/fixture-session"); assert.equal(r.status, 200);
    assert.ok(!("cost" in r.data.session)); assert.ok(!("prompt_tokens" in r.data.session)); assert.ok(!("tokens" in r.data.messages[0]));
    assert.equal(r.data.messages[0].parts[0].text, "Own conversation");
    await policy(all(true)); const full = await call("/api/chat/sessions/fixture-session"); assert.equal(full.data.session.cost, .03); assert.equal(full.data.messages[0].tokens.prompt, 123);
  });
  await test("真实SSE及重连快照隐藏cost/tokens/上游，允许记录时保留真实用量", async () => {
    const run = startRun("fixture-session", { userId: 1 });
    publish(run, { type: "part", part: { id: "p", type: "text", text: "Own streamed answer" } });
    publish(run, { type: "step_done", usage: { prompt_tokens: 123 }, channel: sentinel, cost: .03 });
    finishRun(run, { type: "done", message: { role: "assistant", parts: [{ type: "text", text: "Own streamed answer" }], cost: .03, tokens: { prompt: 123, completion: 45 } }, cost: .03, tokens: { prompt: 123, completion: 45 } });
    const stream = async () => {
      const response = await fetch(`${base}/api/chat/sessions/fixture-session/stream`, { headers: { Authorization: `Bearer ${signToken(users.get(1))}` } });
      assert.equal(response.status, 200); return await response.text();
    };
    await policy(all(false)); const hidden = await stream(); assert.ok(hidden.includes("Own streamed answer")); assert.ok(hidden.includes("[DONE]"));
    assert.ok(!hidden.includes('"cost"')); assert.ok(!hidden.includes('"tokens"')); assert.ok(!hidden.includes('"usage"')); assert.ok(!hidden.includes(sentinel));
    await policy({ ...all(false), usage_records: true }); const shown = await stream(); assert.ok(shown.includes('"cost":0.03')); assert.ok(shown.includes('"prompt":123')); assert.ok(!shown.includes(sentinel));
    assert.equal(run.events.at(-1).cost, .03); assert.equal(run.events.at(-1).tokens.prompt, 123);
  });
  await test("匿名或他人个人主页无用量，独立权限不扩大公开资料", async () => {
    await policy(all(true)); const anon = await call("/api/profile/u/1", 0); assert.equal(anon.status, 200); assert.ok(!anon.data.stats.usage);
    const other = await call("/api/profile/u/100", 1); assert.equal(other.status, 200); assert.ok(!other.data.stats.usage);
  });
  console.log(`  数据可见权限真实HTTP ${scenarios} 场景通过（数据库/收费上游请求0）`);
} finally {
  pool.query = originalQuery;
  server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
