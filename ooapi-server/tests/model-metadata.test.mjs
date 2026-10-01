// 模型目录行为回归：真实 HTTP 路由 + 内存数据库，不调用上游、不接触真实账号。
// 复现过的故障：接入厂商与模型原厂混淆、通配/分隔符与调度语义不同，
// 以及未知空声明把全库模型展示成可调用。仅静态检查函数名无法发现这些问题。
import assert from "node:assert/strict";
import express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") !== filename) {
  // npm test 入口会动态 import 本文件。隔离进程让私有登记表/价格缓存也能完整复原，
  // 避免测试污染后续模块，或父进程已加载 db.js 后误用真实 JWT 配置。
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename], { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`模型目录 HTTP 子进程失败（${signal || code}）`)));
  });
} else {

// 测试专用签名密钥只存在本进程，避免 db.js 在新检出目录生成 .jwt-secret。
const fixtureSecret = "model-metadata-test-only-signing-secret";
const previousSecret = process.env.JWT_SECRET;
let db;
try {
  process.env.JWT_SECRET = fixtureSecret;
  db = await import("../src/db.js");
} finally {
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
}
assert.equal(db.JWT_SECRET, fixtureSecret, "模型目录测试必须先于任何使用真实 JWT 配置的模块加载");
const { pool } = db;
const originalQuery = pool.query;
const originalExecute = pool.execute;
const originalConnection = pool.getConnection;
const groupName = "metadata-fixture";
const user = { id: 87001, username: "metadata_test_user", role: 1, status: 1, token_version: 0, quota: 10000, used_quota: 0 };
const fixtureKey = "sk-model-metadata-fixture-only";
const token = {
  id: 87002, user_id: user.id, name: "目录测试", key_str: fixtureKey,
  status: 1, expired_time: -1, group_name: groupName, model_limits: "",
  unlimited_quota: 1, remain_quota: 10000, used_quota: 0,
};
const foreignToken = { ...token, id: 87003, user_id: 87004, key_str: "sk-foreign-metadata-fixture-only" };
let fixture = { channels: [], groupModels: [], keyModels: [], prices: [] };
let queryCount = 0;
let rejectedQueries = 0;
let pass = 0;
let fail = 0;
let server;
const channel = (id, type, models, extra = {}) => ({
  id, name: `目录测试渠道 ${id}`, type, models, status: 1,
  priority: 0, weight: 1, group_name: groupName, group_list: JSON.stringify([groupName]),
  other: JSON.stringify({ method: "api" }), recent_calls: "[]", ...extra,
});

// 必须模拟 SQL 的筛选，而非一律返回所有 fixtures：这样才能验证禁用渠道与外组隔离。
pool.query = async (sql, params = []) => {
  queryCount++;
  const s = String(sql).replace(/\s+/g, " ").trim();
  assert.equal((s.match(/\?/g) || []).length, params.length, "SQL 占位符与参数必须一致");
  if (s.startsWith("SELECT * FROM users WHERE id = ?")) return [[user].filter((u) => u.id === Number(params[0]))];
  if (s.startsWith("SELECT * FROM tokens WHERE key_str = ?")) return [[token, foreignToken].filter((t) => t.key_str === params[0])];
  if (s === "SELECT * FROM tokens WHERE id = ? AND user_id = ?") {
    return [[token, foreignToken].filter((t) => t.id === Number(params[0]) && t.user_id === Number(params[1]))];
  }
  if (s.includes("FROM tokens WHERE user_id = ?")) {
    return [[token].filter((t) => t.user_id === Number(params[0]))];
  }
  if (s.includes("FROM channels")) {
    const rows = fixture.channels.filter((c) => !s.includes("WHERE status = 1") || c.status === 1);
    return [[...rows].sort((a, b) => b.priority - a.priority || a.id - b.id)];
  }
  if (s.startsWith("SELECT name, remark, rate FROM channel_groups WHERE name IN")) {
    return [[{ name: groupName, remark: "测试分组", rate: 1 }].filter((g) => params.includes(g.name))];
  }
  if (s === "SELECT rate, models FROM channel_groups WHERE name = ? LIMIT 1") {
    return [params[0] === groupName ? [{ rate: 1, models: JSON.stringify(fixture.groupModels) }] : []];
  }
  if (s === "SELECT * FROM model_prices") return [fixture.prices];
  rejectedQueries++;
  throw new Error(`模型目录测试不允许实际 SQL 或未覆盖查询：${s}`);
};
pool.execute = async () => { rejectedQueries++; throw new Error("目录只读测试不允许 execute"); };
pool.getConnection = async () => { rejectedQueries++; throw new Error("目录只读测试不允许数据库连接"); };

const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name} → ${e.message}`);
  }
};

try {
  const models = await import("../src/services/models.js");
  const routing = await import("../src/services/router.js");
  const { clearGroupConfigCache } = await import("../src/services/group-rate.js");
  const { invalidatePrices } = await import("../src/services/pricing.js");
  const { signToken } = await import("../src/middleware/auth.js");
  const { default: chatRoutes } = await import("../src/routes/chat.js");
  const { default: gatewayRoutes } = await import("../src/routes/gateway.js");
  await models.warmAliasMap();
  const app = express();
  app.use("/api/chat", chatRoutes);
  app.use("/v1", gatewayRoutes);
  app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message }));
  server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jwt = signToken(user);
  const get = async (path, bearer) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    assert.equal(res.status, 200, `${path} 应成功（${body.message || body.error?.message || res.status}）`);
    return body;
  };
  const reset = async (channels, { groupModels = [], keyModels = [], prices = [] } = {}) => {
    fixture = { channels, groupModels, keyModels, prices };
    token.model_limits = keyModels.join(",");
    clearGroupConfigCache();
    invalidatePrices();
    routing.invalidateChannelCache();
    routing.invalidateVendorModels();
    models.invalidateModelRegistry();
    await models.modelRegistry();
  };
  const ids = (rows) => rows.map((m) => m.id.toLowerCase()).sort();
  const expectIds = (rows, expected) => assert.deepEqual(ids(rows), expected.map((id) => id.toLowerCase()).sort());
  const directory = async () => {
    const chat = (await get(`/api/chat/meta?keyId=${token.id}`, jwt)).data;
    const gateway = (await get("/v1/models", fixtureKey)).data;
    assert.ok(Array.isArray(chat?.models) && Array.isArray(gateway), "两端必须返回模型数组");
    assert.equal(new Set(chat.models.map((m) => `${m.vendor}:${models.canonicalModelName(m.id)}`)).size, chat.models.length, "站内目录同一接入厂商的规范模型不能重复");
    assert.equal(new Set(ids(gateway)).size, gateway.length, "网关目录同名模型不能重复");
    const grouped = chat.vendors.flatMap((g) => {
      for (const m of g.models) assert.equal(m.vendor, g.vendor, "模型厂商必须与下拉分组一致");
      return g.models;
    });
    expectIds(grouped, ids(chat.models));
    // 不调用上游也能验证列表与真实调度一致：这些 fixtures 没有运行时冷却。
    for (const m of [...chat.models, ...gateway]) {
      assert.ok(!m.id.includes("*"), `目录不能把通配 ${m.id} 当成模型发给客户端`);
      const sameGroup = fixture.channels.filter((c) => c.status === 1 && routing.channelInGroup(routing.rowToChannel(c), groupName));
      assert.ok(sameGroup.some((c) => routing.channelSupportsModel(routing.rowToChannel(c), m.id)), `目录模型 ${m.id} 缺少同组支持渠道`);
      const selected = await routing.selectChannels({ model: m.id, groupName, channelType: m.vendor || "" });
      assert.ok(selected.length > 0, `目录模型 ${m.id} 必须有真实可选渠道`);
      assert.ok(selected.every((c) => c.status === 1 && routing.channelInGroup(c, groupName)), "选择器不能使用禁用或外组渠道");
      if (m.vendor) assert.ok(selected.every((c) => c.type === m.vendor), "站内选定的接入厂商不能串到另一家");
      assert.ok(models.modelInAllowList(fixture.groupModels, m.id), "目录模型必须通过组白名单");
      assert.ok(models.modelInAllowList(fixture.keyModels, m.id), "普通用户目录模型必须通过密钥白名单");
      const counterpart = gateway.find((g) => models.canonicalModelName(g.id) === models.canonicalModelName(m.id));
      if (m.vendor) {
        assert.ok(counterpart, `站内目录模型 ${m.id} 必须同时出现在网关目录`);
        assert.equal(m.channel_type, m.vendor, "站内条目必须携带实际接入厂商");
      }
    }
    return { chat, gateway };
  };
  const expectLuna = ({ chat, gateway }, provider = "openai") => {
    expectIds(chat.models, ["gpt-5.6-luna"]);
    expectIds(gateway, ["gpt-5.6-luna"]);
    const luna = chat.models[0];
    assert.equal(luna.vendor, provider);
    assert.match(luna.vendorName, provider === "openai" ? /OpenAI/ : /OpenCode/, "站内分组名应来自实际接入厂商");
    assert.equal(luna.supportsThinking, true, "OpenAI Luna 思考能力不能被托管目录的 false 覆盖");
    assert.ok(!/OpenCode|托管|通道/i.test(luna.desc), "原厂说明不能被其他供应商说明覆盖");
    assert.equal(gateway[0].owned_by, "openai");
    assert.equal(gateway[0].vendor_name, "OpenAI");
  };

  console.log("\n=== 模型元信息与目录路由一致性（真实 HTTP / 内存 SQL） ===");
  await test("仅 OpenAI Luna：原厂、能力和 /v1/models 均准确", async () => {
    await reset([channel(87101, "openai", "gpt-5.6-luna")]);
    expectLuna(await directory());
  });
  await test("仅 OpenCode 提供 Luna：站内归 OpenCode，能力和 API 原厂信息仍归 OpenAI", async () => {
    await reset([channel(87102, "opencode", "gpt-5.6-luna")]);
    expectLuna(await directory(), "opencode");
  });
  await test("同名跨厂商分别可选、同厂商去重，交换渠道顺序不改变结果", async () => {
    const channels = [channel(87103, "opencode", "gpt-5.6-luna"), channel(87104, "openai", "gpt-5.6-luna"), channel(87116, "opencode", "gpt-5.6-luna")];
    await reset(channels);
    const first = await directory();
    assert.equal(first.chat.models.length, 2);
    assert.deepEqual(first.chat.models.map((m) => m.vendor).sort(), ["openai", "opencode"]);
    assert.ok(first.chat.models.every((m) => m.supportsThinking));
    expectIds(first.gateway, ["gpt-5.6-luna"]);
    assert.equal((await routing.selectChannels({ model: "gpt-5.6-luna", groupName, channelType: "opencode", excludeIds: new Set([87103, 87116]) })).length, 0, "所选厂商的渠道都失败后不能重试其他厂商");
    await reset([...channels].reverse().map((c, i) => ({ ...c, id: 87105 + i })));
    const reversed = await directory();
    assert.deepEqual(first.chat.models, reversed.chat.models);
  });
  await test("Cline 托管 Qwen：列表跟随 Cline，报价仍是 Qwen 原厂报价", async () => {
    const raw = "qwen/qwen3.8-27b:free";
    await reset([channel(87117, "cline", raw), channel(87118, "qwen", "qwen3.8-27b")], {
      groupModels: [raw], prices: [{ model: "qwen3.8-27b", input_price: 0.424, output_price: 1.696, cache_price: 0.0848, type: "qwen" }],
    });
    const { chat } = await directory();
    const hosted = chat.models.find((m) => m.vendor === "cline");
    const original = chat.models.find((m) => m.vendor === "qwen");
    assert.ok(hosted && original, "同一个 Qwen 模型应分别列在 Cline 和通义渠道下");
    assert.equal(hosted.id, "qwen3.8-27b");
    assert.match(hosted.vendorName, /Cline/i);
    assert.deepEqual(hosted.price, { input: 0.424, output: 1.696, cache: 0.0848 });
    assert.deepEqual(hosted.price, original.price, "托管渠道不得覆盖模型原厂报价");
    assert.equal((await routing.selectChannels({ model: hosted.id, groupName, channelType: "opencode" })).length, 0, "选定厂商没有模型时不得借其他厂商发送");
  });
  await test("公开目录供应商/原厂输入顺序翻转：helper 保持原厂元信息", async () => {
    const catalog = (await models.allPublicModels()).filter((m) => m.id === "gpt-5.6-luna");
    assert.ok(catalog.some((m) => m.vendor === "openai") && catalog.some((m) => m.vendor === "opencode"));
    assert.equal(typeof models.publicModelMetadataMap, "function");
    const first = models.publicModelMetadataMap(catalog).get("gpt-5.6-luna");
    const reversed = models.publicModelMetadataMap([...catalog].reverse()).get("gpt-5.6-luna");
    assert.equal(first.vendor, "openai");
    assert.equal(first.supportsThinking, true);
    assert.deepEqual(first, reversed);
  });
  await test("未知 gpt 前缀及普通模型：跟随实际 WorkBuddy 渠道", async () => {
    await reset([channel(87107, "workbuddy", "gpt-private-fixture,metadata-unknown-fixture")]);
    const { chat, gateway } = await directory();
    expectIds(chat.models, ["gpt-private-fixture", "metadata-unknown-fixture"]);
    expectIds(gateway, ["gpt-private-fixture", "metadata-unknown-fixture"]);
    assert.ok(chat.models.every((m) => m.vendor === "workbuddy"));
    assert.ok(gateway.every((m) => m.owned_by === "workbuddy"));
  });
  await test("禁用和外组渠道不会污染模型目录或 Luna 原厂元信息", async () => {
    await reset([
      channel(87108, "openai", "gpt-5.6-luna"),
      channel(87109, "opencode", "gpt-5.6-luna,metadata-disabled-fixture", { status: 2 }),
      channel(87110, "workbuddy", "gpt-5.6-luna,metadata-outsider-fixture", { group_list: '["other-group"]' }),
    ]);
    expectLuna(await directory());
  });
  await test("DeepSeek 旧名/规范名同源：站内去重，两端仍能按别名匹配", async () => {
    await reset([channel(87111, "workbuddy", "deepseek-v4.1-flash,deepseek-flash")]);
    const { chat, gateway } = await directory();
    assert.equal(chat.models.length, 1);
    assert.equal(models.canonicalModelName(chat.models[0].id), "deepseek-flash");
    assert.equal(chat.models[0].vendor, "workbuddy");
    assert.ok(gateway.length > 0 && gateway.every((m) => models.canonicalModelName(m.id) === "deepseek-flash" && m.owned_by === "deepseek"));
    assert.equal((await routing.selectChannels({ model: "deepseek-v4.1-flash", groupName })).length, 1);
  });
  await test("gpt-* 展开为具体模型，两端不泄出通配占位条目", async () => {
    await reset([channel(87112, "openai", "gpt-*")]);
    const { chat, gateway } = await directory();
    for (const list of [chat.models, gateway]) {
      assert.ok(list.some((m) => m.id === "gpt-5.6-luna"));
      assert.ok(list.some((m) => m.id === "gpt-5.6-terra"));
      assert.ok(list.every((m) => m.id.startsWith("gpt-") && !m.id.includes("*")));
    }
  });
  await test("换行/中文逗号声明：HTTP 目录与选择器使用同一拆分规则", async () => {
    await reset([channel(87113, "openai", "gpt-5.6-luna\ngpt-5.6-terra，gpt-5.6-sol")]);
    const { chat, gateway } = await directory();
    const expected = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
    expectIds(chat.models, expected);
    expectIds(gateway, expected);
  });
  await test("未知 custom 空 models 不得放行全库", async () => {
    await reset([channel(87114, "custom", "")]);
    const { chat, gateway } = await directory();
    expectIds(chat.models, []);
    expectIds(gateway, []);
    assert.equal((await routing.selectChannels({ model: "gpt-5.6-luna", groupName })).length, 0);
  });
  await test("普通用户：分组白名单与 Key 白名单求交，两端仅返回 Terra", async () => {
    await reset([channel(87115, "openai", "gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol")], {
      groupModels: ["gpt-5.6-luna", "gpt-5.6-terra"], keyModels: ["gpt-5.6-terra"],
    });
    const { chat, gateway } = await directory();
    expectIds(chat.models, ["gpt-5.6-terra"]);
    expectIds(gateway, ["gpt-5.6-terra"]);
  });
  await test("普通用户不能拿其他用户 Key 枚举模型", async () => {
    const body = await get(`/api/chat/meta?keyId=${foreignToken.id}`, jwt);
    expectIds(body.data.models, []);
    assert.equal(body.data.active_key, null);
  });
  await test("整个 HTTP 回归只使用内存只读 SQL", async () => {
    assert.ok(queryCount > 0);
    assert.equal(rejectedQueries, 0, "路由出现了未覆盖或可能写库的操作");
  });
} finally {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  // 登记表失效会安排 200ms 异步补热；先让它在内存桩下结束，再恢复真正的 pool 方法。
  await new Promise((resolve) => setTimeout(resolve, 250));
  pool.query = originalQuery;
  pool.execute = originalExecute;
  pool.getConnection = originalConnection;
  await pool.end();
}
console.log(`模型元信息：${pass} 通过 / ${fail} 失败`);
if (fail) throw new Error(`模型元信息 HTTP 回归失败 ${fail} 项`);
}
