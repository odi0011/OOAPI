// 费用拆分和渠道报价是审计快照；测试全在内存，不访问真实DB/渠道。
import assert from "node:assert/strict";
import { billingDetails, computeCost, DEFAULT_PRICES } from "../src/services/pricing.js";
import { channelPriceQuote, finalizeChannelQuote } from "../src/services/channel-price-quote.js";
import { applyGroupRate } from "../src/services/group-rate.js";
import { warmAliasMap } from "../src/services/models.js";
import { billableFailedCall } from "../src/services/execute.js";
import { pool } from "../src/db.js";
const savedQuery = pool.query;
pool.query = async () => [[]];
await warmAliasMap();
pool.query = savedQuery;
let passed = 0;
const test = (name, run) => { run(); passed++; console.log(`  ok  ${name}`); };
const price = { input: 1, output: 2, cache: .5 };
const tokens = { promptTokens: 1700, completionTokens: 300, cacheTokens: 500 };
const one = (extra = {}) => ({ price, tokens, at: Date.parse("2026-10-01T02:00:00Z"), phase: "peak", ...extra });
test("三分项输入排除缓存，原始费用数学合计与计费取整/分组扣费可分辨", () => {
  const base = computeCost({ price, ...tokens }), charged = applyGroupRate(base, .7);
  const b = billingDetails({ calls: [one()], multiplier: .7, chargedUnits: charged, baseUnits: base });
  assert.deepEqual(b.components.input, { tokens: 1200, unit_price: 1, cost_od: .0012, mixed: false });
  assert.equal(b.components.output.cost_od, .0006); assert.equal(b.components.cache.cost_od, .00025);
  assert.equal(b.raw_cost_od, .00205); assert.equal(b.base_cost_units, 21); assert.equal(b.charged_cost_units, 15);
  assert.equal(b.pre_rate_rounding_units, .5); assert.equal(b.adjustment_units, .3);
  assert.equal(b.usage_present, true); assert.equal(b.price_quoted, false);
});
test("超小用量和free平台价保持现有最低额度，不把0单价改成免费调用", () => {
  for (const p of [price, { input: 0, output: 0, cache: 0 }]) {
    const t = { promptTokens: 1, completionTokens: 0, cacheTokens: 0 };
    const base = computeCost({ price: p, ...t });
    const b = billingDetails({ calls: [one({ price: p, tokens: t })], chargedUnits: applyGroupRate(base, .01) });
    assert.equal(base, 1); assert.equal(b.base_cost_units, 1); assert.equal(b.charged_cost_units, 1);
  }
});
test("缓存价未提供则费用与平台实际单价回退输入档，缓存不超过总输入", () => {
  const b = billingDetails({ calls: [one({ price: { ...price, cache: null }, tokens: { ...tokens, cacheTokens: 1900 } })] });
  assert.equal(b.components.input.tokens, 0); assert.equal(b.components.cache.tokens, 1700);
  assert.equal(b.platform_price.cache, 1); assert.equal(b.components.cache.cost_od, .0017);
});
test("input_only账号输出费0，数学合计仍使用原有计费口径", () => {
  const b = billingDetails({ calls: [one({ contextBilling: "input_only" })] });
  assert.equal(b.components.output.cost_od, 0); assert.equal(b.components.output.tokens, 0);
  assert.equal(b.platform_price.out, 0); assert.equal(b.raw_cost_od, .00145);
  assert.equal(b.base_cost_units, computeCost({ price, ...tokens, contextBilling: "input_only" }));
});
test("多call逐次取整后才乘分组倍率，混档明示且不伪造统一价", () => {
  const calls = [one(), one({ price: { input: 2, output: 4, cache: 1 }, phase: "offpeak" })];
  const b = billingDetails({ calls, multiplier: 2, chargedUnits: 124 });
  assert.equal(b.base_cost_units, 62); assert.equal(b.charged_cost_units, 124);
  assert.equal(b.raw_cost_od, .00615); assert.equal(b.components.input.unit_price, null);
  assert.equal(b.components.input.mixed, true); assert.equal(b.price_mode, "mixed");
  assert.equal(b.platform_price, null); assert.equal(b.channel_quote, null); assert.equal(b.call_count, 2);
  assert.equal(b.price_phase, "peak+offpeak");
  assert.deepEqual(b.platform_unit_prices, { input: [1, 2], output: [2, 4], cache: [.5, 1] });
});
test("真实长上下文档价进入三分项与原始费用，不污染基础价", () => {
  const p = { input: 1, output: 2, cache: .1, tiers: [{ minInputTokens: 1001, input: 2, output: 4, cache: .2 }] };
  const b = billingDetails({ calls: [one({ price: p })] });
  assert.equal(b.components.input.unit_price, 2); assert.equal(b.components.cache.unit_price, .2);
  assert.equal(b.context_tier, 1001); assert.equal(p.input, 1);
});
test("HTTP拒绝显式billable=false保存0原始费/0扣费，不执行最低1额度", () => {
  const b = billingDetails({ calls: [one({ tokens: {}, billable: false })], chargedUnits: 0 });
  assert.equal(b.raw_cost_od, 0); assert.equal(b.base_cost_units, 0); assert.equal(b.charged_cost_units, 0);
  assert.equal(b.usage_present, false); assert.equal(b.price_quoted, true);
});
test("提交结果未知不能在明细伪造0扣费", () => {
  const b = billingDetails({ calls: [one()], chargedUnits: null });
  assert.equal(b.charged_cost_units, null); assert.equal(b.charged_cost_od, null); assert.equal(b.adjustment_units, null);
});
for (const type of ["cline", "openrouter", "opencode"]) test(`${type}本次真实free SKU渠道价0，正常SKU不会猜免费`, () => {
  const c = { type, models: "openai/gpt-6-sol,openai/gpt-6-sol:free" };
  const free = finalizeChannelQuote(channelPriceQuote(c, { model: "openai/gpt-6-sol:free" }));
  assert.deepEqual(free.price, { in: 0, out: 0, cache: 0 }); assert.equal(free.status, "available");
  assert.equal(finalizeChannelQuote(channelPriceQuote(c, { model: "gpt-6-sol" })).price, null);
});
test("实际渠道只声明free时裸模型走该SKU；batch原始渠道价格未知而非原厂半价", () => {
  const free = channelPriceQuote({ type: "cline", models: "openai/gpt-6-sol:free" }, { model: "gpt-6-sol" });
  assert.equal(free.model, "openai/gpt-6-sol:free"); assert.equal(free.price.in, 0);
  assert.equal(channelPriceQuote({ type: "cline", models: "openai/gpt-6-sol:batch" }, { model: "gpt-6-sol" }).price, null);
});
test("积分/订阅和未知代理价格null+固定文档，不存凭据或任意配置URL", () => {
  const q = channelPriceQuote({ type: "workbuddy", api_key: "PRIVATE_SENTINEL", base_url: "https://PRIVATE_SENTINEL.invalid", other: { docs_url: "https://PRIVATE_SENTINEL.invalid" } }, { model: "deepseek-flash" });
  assert.equal(q.status, "credits"); assert.equal(q.price, null); assert.ok(q.url);
  assert.ok(!JSON.stringify(q).includes("PRIVATE_SENTINEL"));
  assert.equal(channelPriceQuote({ type: "openai", base_url: "https://proxy.invalid", other: { method: "api" } }, { model: "gpt-6-sol" }).price, null);
  assert.equal(channelPriceQuote({ type: "custom", models: "gpt-6-sol:free" }, { model: "gpt-6-sol:free" }).price, null);
});
test("官方host+API方法才用原渠道公开价，平台可改价不进入渠道报价", () => {
  const c = { type: "openai", base_url: "https://api.openai.com/v1", other: { method: "api" } };
  const q = finalizeChannelQuote(channelPriceQuote(c, { model: "gpt-6-sol" }));
  const official = DEFAULT_PRICES.find((p) => p.model === "gpt-6-sol");
  assert.equal(q.price.in, official.input); assert.equal(q.source, "official_channel_published");
  assert.equal(channelPriceQuote({ ...c, other: { method: "codex" } }, { model: "gpt-6-sol" }).price, null);
  assert.equal(channelPriceQuote({ type: "glm", base_url: "https://open.bigmodel.cn/api/paas/v4", other: { method: "api" } }, { model: "glm-5.3" }).price, null, "Z.AI美元价不是国内BigModel渠道原始价");
  assert.equal(channelPriceQuote({ type: "minimax", base_url: "https://api.minimax.cn/v1", other: { method: "api" } }, { model: "MiniMax-M3" }).price, null, "海外美元价不能冒充国内渠道原始价");
  assert.equal(finalizeChannelQuote(channelPriceQuote({ type: "glm", base_url: "https://api.z.ai/api/paas/v4", other: { method: "api" } }, { model: "glm-5.3" })).price.in, 1.4);
  const cacheUnknown = finalizeChannelQuote(channelPriceQuote({ type: "qwen", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", other: { method: "api" } }, { model: "qwen3.8-max" }));
  assert.equal(cacheUnknown.price.in, 1.65); assert.equal(cacheUnknown.price.cache, null, "未公开渠道缓存价保留未知，不能显示成免费缓存");
});
test("报价快照保留调用开始日期并按真实usage切长档，后续channel改动不影响", () => {
  const c = { type: "minimax", base_url: "https://api.minimax.io/v1", other: { method: "api" } };
  const q = channelPriceQuote(c, { model: "minimax-m3", at: 1234567890000 });
  c.type = "workbuddy"; c.base_url = "https://proxy.invalid";
  const short = finalizeChannelQuote(q, 512000), long = finalizeChannelQuote(q, 512001);
  assert.equal(short.price.in, .3); assert.equal(long.price.in, .6); assert.equal(long.price.cache, .12);
  assert.equal(long.captured_at, 1234567890000); assert.ok(!('terms' in long));
});
test("失败call继承同次snapshot且工具已记账时不合成第二份", () => {
  const channelQuote = channelPriceQuote({ type: "cline" }, { model: "openai/gpt-6-sol:free" });
  const err = { billable: true, content: "partial", channelQuote, usage: { prompt_tokens: 10 } };
  assert.equal(billableFailedCall(err).channelQuote, channelQuote);
  err.billingRecorded = true; assert.equal(billableFailedCall(err), null);
});
console.log(`  费用明细/渠道报价 ${passed} 项通过`);

const freeZen = channelPriceQuote({ type:"opencode", models:"mimo-v2.6-flash-free", other:{method:"api"} }, {model:"mimo-v2.6-flash-free"});
assert.equal(freeZen.status,"available");assert.deepEqual(freeZen.price,{in:0,out:0,cache:0});
