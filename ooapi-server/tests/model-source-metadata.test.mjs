// 真实 HTTP + 内存数据：展示来源只认接入渠道，不改调度/白名单/价格或访问收费上游。
import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
process.env.JWT_SECRET = "model-source-fixture-signing-only";
const { pool } = await import("../src/db.js");
const { signToken } = await import("../src/middleware/auth.js");
const { loadOptions, setOption } = await import("../src/config.js");
const { invalidatePrices } = await import("../src/services/pricing.js");
const { modelRegistry, invalidateModelRegistry, canonicalModelName } = await import("../src/services/models.js");
const { groupModelVendors, channelModelVendors, sourceVendors, logsWithSourceVendors, billingSourceVendors } = await import("../src/services/model-sources.js");
const { writeLog, LOG_TYPE } = await import("../src/services/log.js");
const routes = await Promise.all(["token", "channel", "log", "dashboard", "pricing"].map(async (name) => [name, (await import(`../src/routes/${name}.js`)).default]));
const all = (value) => ({ version: 1, balance: value, usage_summary: value, usage_records: value, request_content: value, pricing: value });
const secret = "PRIVATE_SOURCE_SENTINEL";
const luna = "gpt-5.6-luna", sku = "~openai/gpt-5.6-luna:free";
const groups = [{ id: 7, name: "shared", vendor: "qwen", models: JSON.stringify([luna, sku, "mystery-model"]), remark: "Fixture", rate: 1 },
  { id: 8, name: "empty", vendor: "", models: "[]", rate: 1 },
  { id: 9, name: "capabilities", vendor: "qwen", models: JSON.stringify([luna, "fixture-unknown-capability"]), rate: 1 },
  { id: 10, name: "legacy", vendor: "deepseek", models: '["deepseek-chat","deepseek-flash-thinking","GPT-5.6-Luna"]', rate: 1 }];
const channels = [
  { id: 11, type: "cline", status: 1, models: `${sku},disallowed-model`, group_list: '["shared","empty"]' },
  { id: 12, type: "openai", status: 1, models: luna, group_list: '["shared","empty"]' },
  { id: 13, type: "mimo", status: 1, models: "mystery-model", group_list: '["shared"]' },
  { id: 14, type: "qoder", status: 2, models: luna, group_list: '["shared","empty"]' },
  { id: 15, type: "gemini", status: 1, models: luna, group_list: '["other"]' },
  { id: 16, type: "openai", status: 1, models: "", group_list: '["capabilities"]' },
  { id: 17, type: "cline", status: 1, models: "gpt-*", group_list: '["capabilities"]' },
  { id: 18, type: "mimo", status: 1, models: "*", group_list: '["capabilities"]' },
  { id: 19, type: "custom", status: 1, models: "", group_list: '["capabilities"]' },
  { id: 21, type: "deepseek", status: 1, models: "deepseek-flash", group_list: '["legacy"]' },
  { id: 22, type: "deepseek", status: 1, models: "deepseek-pro", group_list: '["legacy"]' },
].map((c) => ({ ...c, name: secret, api_key: secret, other: secret, group_name: "" }));
const users = new Map([1, 100].map((role) => [role, { id: role, role, status: 1, username: `fixture_source_${role}`, token_version: 0,
  group_name: "shared", quota: 10000, used_quota: 9, request_count: 1 }]));
const bill = { version: 1, components: { input: { tokens: 3, unit_price: 1, cost_od: .000003 } },
  channel_quote: { provider: "cline", url: secret }, calls: [{ channel_quote: { provider: "openai", api_key: secret }, upstream_model: secret }] };
const log = (id, extra) => ({ id, user_id: 1, username: users.get(1).username, created_at: Math.floor(Date.now() / 1000),
  type: 2, is_usage: 1, status: "success", model: luna, channel_id: 11, channel_name: secret, user_agent: secret,
  quota: 9, prompt_tokens: 3, completion_tokens: 1, cache_tokens: 0, input_text: secret, request_prompt_text: secret,
  output_text: secret, content: secret, elapsed_ms: 21, first_token_ms: 7, first_token_known: 1, ...extra });
const logs = [
  log(1, { channel_id: 15, source_vendors: '["cline","openai"]', detail: JSON.stringify({ source_vendors: ["cline", "openai"], billing_details: bill }) }),
  log(2, { billing_details: JSON.stringify(bill) }),
  log(3, {}),
  log(4, { channel_id: 999 }),
  log(5, { source_vendors: "[]" }),
  log(6, { source_vendors: JSON.stringify([secret, "cline", "cline", { type: "openai", api_key: secret }]) }),
];
const queries = [], settings = new Map();
let sourceReads = 0, throwSourceRead = false;
const originalQuery = pool.query;
pool.query = async (sql, args = []) => {
  if (String(sql).includes("FROM model_attributions")) return [[]];
  sql = String(sql); queries.push({ sql, args });
  assert.equal((sql.match(/\?/g) || []).length, args.length, "SQL placeholder count");
  if (/SELECT key_str, value FROM options/.test(sql)) return [[...settings].map(([key_str, value]) => ({ key_str, value }))];
  if (/INSERT INTO options/.test(sql)) { settings.set(args[0], args[1]); return [{ affectedRows: 1 }]; }
  if (/SELECT \* FROM users WHERE id/.test(sql)) return [[users.get(Number(args[0]))].filter(Boolean)];
  if (/FROM channel_groups/.test(sql)) return [[...groups.filter((g) => !sql.includes("WHERE name") || g.name === args[0])]];
  if (/FROM channels WHERE id IN/.test(sql)) {
    sourceReads++; if (throwSourceRead) throw Object.assign(new Error("Fixture unavailable"), { code: "FIXTURE_DB_DOWN" });
    assert.match(sql, /^SELECT id, type FROM channels/); assert.ok(!/name|api_key|other/.test(sql));
    return [channels.filter((c) => args.includes(c.id)).map(({ id, type }) => ({ id, type }))];
  }
  if (/FROM channels/.test(sql)) return [[...channels.filter((c) => !/status = 1/.test(sql) || c.status === 1)]];
  if (/FROM model_prices/.test(sql)) return [[{ model: luna, input_price: 1, output_price: 2, cache_price: .1, channel_type: "openai", updated_time: 1 }]];
  if (/FROM tokens/.test(sql)) return [[{ total_tokens: 1, active_tokens: 1 }]];
  if (/FROM logs/.test(sql)) {
    if (/SELECT id, created_at|SELECT id, user_id/.test(sql)) return [[...logs]];
    if (/GROUP BY/.test(sql)) return [[]];
    return [[{ total: logs.length, calls: 1, successes: 1, units: 9, prompt_tokens: 3, completion_tokens: 1, cache_tokens: 0, models: 1, n: 0 }]];
  }
  throw new Error(`Unhandled fixture SQL: ${sql.slice(0, 100)}`);
};
const app = express(); app.use(express.json());
for (const [name, router] of routes) app.use(`/api/${name}`, router);
app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
async function call(path, role = 1) {
  const response = await fetch(base + path, { headers: { Authorization: `Bearer ${signToken(users.get(role))}` } });
  return { status: response.status, ...(await response.json()) };
}
const policy = (value) => setOption("user_data_visibility", JSON.stringify(value));
let scenarios = 0;
const test = async (name, run) => { await run(); scenarios++; console.log(`  ok  ${name}`); };
try {
  await loadOptions(); await policy({ ...all(true), request_content: false }); invalidatePrices(); invalidateModelRegistry(); await modelRegistry();
  await test("品牌字段严格白名单，未知值/对象/凭据不能下发", async () => {
    assert.deepEqual(sourceVendors([secret, " OPENAI ", "cline", "cline", { provider: "mimo" }]), ["cline", "openai"]);
    assert.deepEqual(sourceVendors(secret), []);
  });
  await test("受限组按规范身份合并SKU与多渠道，未授权/跨组不混入", async () => {
    const m = groupModelVendors(groups[0], channels, { activeOnly: true });
    for (const id of [luna, sku]) assert.deepEqual(m[id], ["cline", "openai"]);
    assert.deepEqual(m["mystery-model"], ["mimo"]); assert.ok(!Object.hasOwn(m, "disallowed-model"));
    assert.ok(!Object.values(m).flat().includes("gemini")); assert.ok(!Object.values(m).flat().includes("qwen"));
    assert.deepEqual(groupModelVendors(groups[0], [...channels].reverse(), { activeOnly: true }), m);
  });
  await test("空白名单保留真实声明，禁用成员仅在管理员配置清单出现", async () => {
    const user = groupModelVendors(groups[1], channels, { activeOnly: true }), admin = groupModelVendors(groups[1], channels);
    assert.deepEqual(user[luna], ["cline", "openai"]); assert.deepEqual(user["disallowed-model"], ["cline"]);
    assert.deepEqual(admin[luna], ["cline", "openai", "qoder"]); assert.ok(!Object.hasOwn(user, "mystery-model"));
  });
  await test("渠道声明换行/空格/中文逗号与现有调度拆分一致", async () => {
    const c = [{ ...channels[0], models: `${sku}\nmystery-model，disallowed-model extra-model` }];
    const m = groupModelVendors(groups[0], c, { activeOnly: true });
    assert.deepEqual(m[luna], ["cline"]); assert.deepEqual(m["mystery-model"], ["cline"]);
    assert.ok(!Object.hasOwn(m, "disallowed-model")); assert.ok(!Object.hasOwn(m, "extra-model"));
    assert.ok(Object.keys(m).every((v) => !/[\s，]/.test(v)));
  });
  await test("显式通配白名单有效，空组/不存在组不猜来源", async () => {
    const m = groupModelVendors({ name: "shared", models: '["gpt-*"]' }, channels, { activeOnly: true });
    assert.deepEqual(m[luna], ["cline", "openai"]); assert.ok(!Object.hasOwn(m, "mystery-model"));
    assert.deepEqual({ ...groupModelVendors({ name: "missing", models: "[]" }, channels) }, {});
    assert.deepEqual(groupModelVendors({ name: "missing", models: JSON.stringify([luna]) }, channels)[luna], []);
  });
  await test("渠道空声明/全通配/前缀通配复用真实匹配，未知厂商空声明无全库授权", async () => {
    const m = groupModelVendors(groups[2], channels, { activeOnly: true });
    assert.deepEqual(m[luna], ["cline", "mimo", "openai"]);
    assert.deepEqual(m["fixture-unknown-capability"], ["mimo"]);
    assert.ok(!Object.values(m).flat().includes("custom")); assert.ok(!Object.values(m).flat().includes("gemini"));
    assert.deepEqual(channelModelVendors(channels.find((c) => c.id === 16))[luna], ["openai"]);
    assert.deepEqual(channelModelVendors(channels.find((c) => c.id === 17))[luna], ["cline"]);
    assert.deepEqual({ ...channelModelVendors(channels.find((c) => c.id === 19)) }, {});
    assert.ok(Object.keys(channelModelVendors(channels.find((c) => c.id === 18))).every((m) => !m.endsWith("*")));
  });
  await test("报价快照仅读取实际provider，旧版本/未知字段无开发商兜底", async () => {
    assert.deepEqual(billingSourceVendors(bill), ["cline", "openai"]);
    assert.deepEqual(billingSourceVendors({ ...bill, version: 2 }), []);
    assert.deepEqual(billingSourceVendors({ version: 1, type: "openai", channel_quote: { provider: secret } }), []);
  });
  await test("快照优先于修改后的渠道，旧账精确批查且已删渠道保持未知", async () => {
    const reads = sourceReads, rows = await logsWithSourceVendors(logs);
    assert.equal(sourceReads - reads, 1);
    assert.deepEqual(rows.map((r) => r.source_vendors), [["cline", "openai"], ["cline", "openai"], ["cline"], [], [], ["cline"]]);
    assert.ok(!Object.hasOwn(logs[2], "source_vendors")); // 投影不能修改真实存储对象。
  });
  await test("仅有快照时不读渠道表；渠道查询失败不破坏日志读取", async () => {
    const reads = sourceReads; await logsWithSourceVendors([logs[0], logs[1], logs[4]]); assert.equal(sourceReads, reads);
    throwSourceRead = true; const rows = await logsWithSourceVendors([logs[2]]); throwSourceRead = false;
    assert.deepEqual(rows[0].source_vendors, []);
  });
  await test("普通令牌分组HTTP包含来源映射，models原样保留且不泄露账号", async () => {
    const r = await call("/api/token/groups"); assert.equal(r.status, 200);
    const g = r.data.find((v) => v.name === "shared"); assert.deepEqual(g.models, [luna]);
    assert.deepEqual(g.model_vendors[luna], ["openai"]); assert.ok(!Object.hasOwn(g.model_vendors, sku));
    assert.ok(!Object.hasOwn(g, "channel_ids")); assert.ok(!JSON.stringify(r.data).includes(secret));
  });
  await test("普通分组HTTP真实展开空声明和通配，原始models权限不扩大", async () => {
    const r = await call("/api/token/groups"); assert.equal(r.status, 200);
    const g = r.data.find((v) => v.name === "capabilities"); assert.deepEqual(g.models, [luna]);
    assert.deepEqual(g.model_vendors[luna], ["openai"]); assert.ok(!Object.hasOwn(g.model_vendors, "fixture-unknown-capability"));
    assert.ok(Object.keys(g.model_vendors).every((id) => ["fixture-unknown-capability", luna].includes(canonicalModelName(id))));
  });
  await test("管理员分组HTTP含配置成员来源，普通用户不能越权", async () => {
    assert.equal((await call("/api/channel/groups")).status, 403);
    const r = await call("/api/channel/groups", 100); assert.equal(r.status, 200);
    assert.deepEqual(r.data.find((g) => g.name === "shared").model_vendors[luna], ["cline", "openai", "qoder"]);
  });
  await test("管理员渠道HTTP给即时编辑模型来源，空/通配保留原配置且不猜开发商", async () => {
    assert.equal((await call("/api/channel")).status, 403);
    const r = await call("/api/channel", 100); assert.equal(r.status, 200, JSON.stringify(r));
    const blank = r.data.find((c) => c.id === 16), prefix = r.data.find((c) => c.id === 17), wild = r.data.find((c) => c.id === 18);
    assert.deepEqual(blank.models, []); assert.deepEqual(prefix.models, ["gpt-*"]); assert.deepEqual(wild.models, ["*"]);
    assert.deepEqual(blank.model_vendors[luna], ["openai"]); assert.deepEqual(prefix.model_vendors[luna], ["cline"]); assert.deepEqual(wild.model_vendors[luna], ["mimo"]);
    assert.deepEqual(r.data.find((c) => c.id === 19).model_vendors, {});
  });
  await test("管理员渠道HTTP保留已保存旧别名/思考后缀，不把同厂商不同型号误认同源", async () => {
    const start = queries.length, r = await call("/api/channel", 100); assert.equal(r.status, 200);
    const flash = r.data.find((c) => c.id === 21), pro = r.data.find((c) => c.id === 22);
    assert.deepEqual(flash.models, ["deepseek-flash"]); assert.deepEqual(pro.models, ["deepseek-pro"]);
    for (const id of ["deepseek-chat", "deepseek-flash-thinking"]) {
      assert.deepEqual(flash.model_vendors[id], ["deepseek"]); assert.ok(!Object.hasOwn(pro.model_vendors, id));
    }
    assert.deepEqual(r.data.find((c) => c.id === 12).model_vendors["GPT-5.6-Luna"], ["openai"]);
    const reads = queries.slice(start).filter((q) => /SELECT models FROM channel_groups/.test(q.sql)); assert.equal(reads.length, 1);
    assert.ok(!queries.slice(start).some((q) => /^(UPDATE|INSERT|DELETE)/.test(q.sql)));
  });
  await test("普通使用记录HTTP来源正确且渠道ID/名称/报价/正文严格不泄露", async () => {
    const start = queries.length, r = await call("/api/log/usage?user_id=100"); assert.equal(r.status, 200, JSON.stringify(r));
    assert.deepEqual(r.data.items.map((v) => v.source_vendors), [["cline", "openai"], ["cline", "openai"], ["cline"], [], [], ["cline"]]);
    for (const row of r.data.items) for (const key of ["channel_id", "channel_name", "channel_type", "detail", "user_agent", "input_text"]) assert.ok(!Object.hasOwn(row, key));
    assert.ok(!JSON.stringify(r.data).includes(secret));
    assert.ok(queries.slice(start).filter((q) => /FROM logs/.test(q.sql)).every((q) => q.args.includes(1) && !q.args.includes(100)));
  });
  await test("关闭价格不会隐藏来源或单次扣费，也不会再公开渠道报价", async () => {
    await policy({ ...all(true), request_content: false, pricing: false }); const r = await call("/api/log/usage"); assert.equal(r.status, 200);
    assert.deepEqual(r.data.items[0].source_vendors, ["cline", "openai"]); assert.equal(r.data.items[0].quota, 9); assert.equal(r.data.items[0].billing_details, null);
    const g = await call("/api/token/groups"); assert.ok(!Object.hasOwn(g.data[0], "rate")); assert.deepEqual(g.data[0].model_vendors[luna], ["openai"]);
  });
  await test("关闭记录后接口403且不读取日志/来源，个人近期为空", async () => {
    await policy({ ...all(true), usage_records: false, request_content: false }); const start = queries.length;
    assert.equal((await call("/api/log/usage")).status, 403); assert.ok(!queries.slice(start).some((q) => /FROM logs|FROM channels/.test(q.sql)));
    const r = await call("/api/dashboard/self"); assert.equal(r.status, 200); assert.deepEqual(r.data.recent_logs, []);
  });
  await test("个人看板有汇总和无汇总两条HTTP路径都只投影来源品牌", async () => {
    for (const summary of [true, false]) {
      await policy({ ...all(true), usage_summary: summary, request_content: false }); const r = await call("/api/dashboard/self"); assert.equal(r.status, 200);
      assert.deepEqual(r.data.recent_logs.map((v) => v.source_vendors), [["cline", "openai"], ["cline", "openai"], ["cline"], [], [], ["cline"]]);
      assert.ok(!JSON.stringify(r.data).includes(secret)); assert.ok(!Object.hasOwn(r.data, "by_channel"));
      for (const row of r.data.recent_logs) for (const key of ["channel_id", "channel_name", "billing_details", "detail"]) assert.ok(!Object.hasOwn(row, key));
    }
  });
  await test("管理员归属分析实际接入品牌，公开定价目录仍按开发商", async () => {
    await policy(all(true)); assert.equal((await call("/api/pricing/attribution")).status, 403);
    const r = await call("/api/pricing/attribution", 100); assert.equal(r.status, 200, JSON.stringify(r));
    assert.ok(r.data.models.some(m => m.model === "mystery-model"));
    assert.ok(!r.data.models.some(m => m.model === luna));
    const catalog = await call("/api/pricing/public"); assert.equal(catalog.status, 200); assert.equal(catalog.data.items.find((v) => v.model === luna).vendor, "openai");
  });
  await test("消费及失败日志写入实际来源快照，原账单金额/SQL参数不变", async () => {
    for (const type of [LOG_TYPE.CONSUME, LOG_TYPE.ERROR]) {
      let inserted;
      const connection = { query: async (sql, args) => { assert.equal((sql.match(/\?/g) || []).length, args.length); inserted = args; return [{ insertId: 81 }]; } };
      const id = await writeLog({ connection, user: users.get(1), type, isUsage: true, detail: JSON.stringify({ billing_details: bill }), quota: 9, channelId: 11, model: luna });
      assert.equal(id, 81); assert.equal(inserted[8], 9); assert.equal(inserted[26], 1); assert.deepEqual(JSON.parse(inserted[5]).source_vendors, ["cline", "openai"]);
    }
  });
  await test("显式空来源快照保留，未知字段不写入展示来源", async () => {
    let stored;
    await writeLog({ user: users.get(1), type: LOG_TYPE.CONSUME, detail: JSON.stringify({ source_vendors: [secret, { provider: "openai" }], billing_details: bill }),
      connection: { query: async (sql, args) => { stored = JSON.parse(args[5]); return [{ insertId: 82 }]; } } });
    assert.deepEqual(stored.source_vendors, []);
  });
  console.log(`  模型实际接入来源 ${scenarios} 场景通过（真实数据库/收费上游请求0）`);
} finally {
  invalidatePrices(); invalidateModelRegistry(); pool.query = originalQuery;
  server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
  if (process.argv[1] === fileURLToPath(import.meta.url)) await pool.end();
}
