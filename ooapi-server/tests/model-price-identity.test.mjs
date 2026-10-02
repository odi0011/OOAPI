// 只在内存中模拟价表与事务，禁止连接真实数据库和上游。
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import { canonicalModelName, warmAliasMap } from "../src/services/models.js";
import { consolidateModelPrices, originalModelPrice, getPrice, computeCost, invalidatePrices, effectivePrice, DEFAULT_PRICES, priceForTokens } from "../src/services/pricing.js";
import { fetchUpstreamPriceList } from "../src/services/price-sync.js";
import { applyVendorRequest } from "../src/services/upstream/vendor-quirks.js";

const original = { query: pool.query, connection: pool.getConnection, fetch: globalThis.fetch };
const row = (model, input, output, cache = 0) => ({ model, input_price: input, output_price: output, cache_price: cache,
  offpeak_input_price: null, offpeak_output_price: null, offpeak_cache_price: null, offpeak_rule: null, channel_type: "openai", remark: "fixture" });
let prices = [row("gpt-6-sol", 2, 10, .2), row("openai/gpt-6-sol:batch", 1, 5, .1),
  row("gpt-6-sol-pro", 2, 10, .2), row("deepseek-flash", .3, 1.2, .006),
  row("deepseek/deepseek-v4.1-flash:batch", .15, .6, .003),
  row("acme/widget:batch", .01, .01), row("acme/widget:free", 0, 0),
  row("MiniMax-M3", .3, 1.2), row("MiniMax-M3-priority", .6, 2.4)];
let archives = new Map();
let pending;
let sqlCount = 0;
const query = async (sql, args = [], tx = null) => {
  sqlCount++;
  if (sql.includes("FROM model_attributions")) return [[]];
  const state = tx || { prices, archives };
  if (sql === "SELECT * FROM model_prices FOR UPDATE" || sql.startsWith("SELECT * FROM model_prices")) return [structuredClone(state.prices), []];
  if (sql.startsWith("INSERT INTO model_price_aliases")) { state.archives.set(args[0], { model: args[1], original_price: args[2] }); return [{ affectedRows: 1 }, []]; }
  if (sql === "UPDATE model_prices SET model=? WHERE model=?") { state.prices.find((r) => r.model === args[1]).model = args[0]; return [{ affectedRows: 1 }, []]; }
  if (sql === "DELETE FROM model_prices WHERE model=?") { state.prices = state.prices.filter((r) => r.model !== args[0]); return [{ affectedRows: 1 }, []]; }
  if (sql === "SELECT original_price FROM model_price_aliases WHERE alias=?") return [[state.archives.get(args[0])].filter(Boolean), []];
  throw new Error(`未批准的测试 SQL: ${sql}`);
};
pool.query = (sql, args) => query(sql, args);
pool.getConnection = async () => ({ beginTransaction: async () => { pending = { prices: structuredClone(prices), archives: new Map(archives) }; },
  query: (sql, args) => query(sql, args, pending), commit: async () => { prices = pending.prices; archives = pending.archives; }, rollback: async () => { pending = null; }, release() {} });
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log(`  ok  ${name}`); };
try {
  await warmAliasMap(); invalidatePrices();
  await test("SKU/供应商前缀/旧DeepSeek/明确pro商品名统一身份，但真正不同档位保留", async () => {
    assert.equal(canonicalModelName("~openai/gpt-6-sol-pro:batch"), "gpt-6-sol");
    assert.equal(canonicalModelName("deepseek/deepseek-v4.1-flash:batch"), "deepseek-flash");
    assert.notEqual(canonicalModelName("gpt-5-pro"), canonicalModelName("gpt-5"));
    assert.notEqual(canonicalModelName("gemini-3.8-flash-preview"), canonicalModelName("gemini-3.8-flash"));
    assert.equal(canonicalModelName("qwen-max"), "qwen-max", "网页兜底档不能合并真实API型号");
    assert.equal(canonicalModelName("qwen-turbo"), "qwen-turbo");
    assert.equal(canonicalModelName("qwen-flash"), "qwen-flash");
    assert.equal(canonicalModelName("MiniMax-M3-priority"), "minimax-m3");
  });
  await test("归并前后每个同源请求计费相同，batch半价不能覆盖原厂单价", async () => {
    for (const name of ["gpt-6-sol", "openai/gpt-6-sol:batch", "gpt-6-sol-pro"]) {
      assert.equal(computeCost({ price: await getPrice(name), promptTokens: 1e6, completionTokens: 1e6 }), 120000);
    }
    assert.equal((await consolidateModelPrices()).merged, 6);
    assert.equal(prices.length, 3);
    assert.equal((await getPrice("openai/gpt-6-sol:batch")).input, 2);
    assert.equal((await getPrice("deepseek/deepseek-v4.1-flash:batch")).input, .3);
    assert.equal((await consolidateModelPrices()).merged, 0);
  });
  await test("管理员可追溯原SKU报价；只有free/batch的未知模型不生成虚假基准价", async () => {
    assert.equal((await originalModelPrice("openai/gpt-6-sol:batch")).in, 1);
    assert.ok(archives.has("acme/widget:free"));
    assert.equal((await originalModelPrice("MiniMax-M3-priority")).in, .6);
    assert.equal((await getPrice("MiniMax-M3-priority")).input, .3);
    assert.ok(!prices.some((p) => p.model === "widget"));
  });
  await test("计费统一时仍给上游真实声明的路由ID，显式SKU不被错误改写", async () => {
    const channel = { type: "openrouter", models: "openai/gpt-6-sol:batch,openai/gpt-6-sol" };
    const a = { model: "gpt-6-sol" }; applyVendorRequest(a, { channel }); assert.equal(a.model, "openai/gpt-6-sol");
    const b = { model: "openai/gpt-6-sol:batch" }; applyVendorRequest(b, { channel }); assert.equal(b.model, "openai/gpt-6-sol:batch");
    for (const models of ["", "*"]) {
      const body = { model: "minimax-m3" }; applyVendorRequest(body, { channel: { type: "minimax", models } });
      assert.equal(body.model, "MiniMax-M3", "空声明原厂渠道恢复官方大小写");
    }
    const custom = { model: "minimax-m3" }; applyVendorRequest(custom, { channel: { type: "custom", models: "vendor/minimax-m3" } });
    assert.equal(custom.model, "vendor/minimax-m3", "聚合实际声明不被原厂大小写覆盖");
  });
  await test("聚合价目顺序反转仍取正常档；缺失价和只有SKU的模型不冒充0元官方价", async () => {
    const items = [
      { id: "openai/gpt-6-sol:batch", pricing: { prompt: ".000001", completion: ".000005" } },
      { id: "openai/gpt-6-sol:free", pricing: { prompt: "0", completion: "0" } },
      { id: "openai/gpt-6-sol", pricing: { prompt: ".000002", completion: ".000010" } },
      { id: "acme/missing", pricing: {} }, { id: "acme/widget:batch", pricing: { prompt: ".000001", completion: ".000001" } },
    ];
    for (const data of [items, [...items].reverse()]) {
      globalThis.fetch = async (url) => { assert.equal(url, "https://openrouter.ai/api/v1/models"); return { ok: true, json: async () => ({ data }) }; };
      const models = await fetchUpstreamPriceList(); assert.equal(models.length, 1); assert.equal(models[0].model, "gpt-6-sol"); assert.equal(models[0].input, 2);
    }
  });
  await test("DeepSeek公共假期边界与周末补班不误收峰价", async () => {
    const p = DEFAULT_PRICES.find((p) => p.model === "deepseek-flash");
    for (const at of ["2026-10-01T02:00:00Z", "2026-10-07T02:00:00Z", "2026-10-10T02:00:00Z"]) assert.equal(effectivePrice(p, Date.parse(at)).phase, "offpeak");
    assert.equal(effectivePrice(p, Date.parse("2026-10-08T02:00:00Z")).phase, "peak");
    assert.equal(effectivePrice(p, Date.parse("2026-09-30T02:00:00Z")).phase, "peak");
  });
  await test("长上下文整次切档，边界以下保持基础价，缓存/输出档同步切换", async () => {
    const p = { input: 2, output: 10, cache: .2, tiers: [{ minInputTokens: 272001, input: 4, output: 15, cache: .4 }] };
    assert.equal(priceForTokens(p, 272000).input, 2); assert.equal(priceForTokens(p, 272001).input, 4);
    assert.equal(computeCost({ price: p, promptTokens: 1e6, completionTokens: 1e6, cacheTokens: 500000 }), 172000);
    assert.equal(p.input, 2, "分档不能污染缓存里的基准价");
  });
  assert.ok(sqlCount > 0);
  await test("官方促销到期自动切换，按调用开始时间取价", async () => {
    const p = { input: .75, output: 3.75, cache: .075, tiers: [{ from: "2027-01-01T00:00:00Z", input: 1.5, output: 7.5, cache: .15 }] };
    assert.equal(effectivePrice(p, Date.parse("2026-12-31T23:59:59Z")).price.input, .75);
    assert.equal(effectivePrice(p, Date.parse("2027-01-01T00:00:00Z")).price.input, 1.5);
  });
  console.log(`模型计价身份：${count} 项通过`);
} finally {
  pool.query = original.query; pool.getConnection = original.connection; globalThis.fetch = original.fetch; invalidatePrices();
}
