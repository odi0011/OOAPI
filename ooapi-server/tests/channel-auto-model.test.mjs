import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import { warmAliasMap, modelRegistry, canonicalModelName, modelInAllowList, invalidateModelRegistry } from "../src/services/models.js";
import { channelSupportsModel, collectAvailableModels, invalidateVendorModels } from "../src/services/router.js";
import { channelUpstreamModel } from "../src/services/channel-models.js";
import { channelModelLimits, groupModelVendors } from "../src/services/model-sources.js";
import { pendingPricedModels, isModelPriced, invalidatePrices, getPrice } from "../src/services/pricing.js";
import { channelPriceQuote } from "../src/services/channel-price-quote.js";
import { runCompletion } from "../src/services/execute.js";

const original = pool.query;
const channels = [
  { id: 12, type: "kiro", models: "auto,claude-sonnet-4-6" },
  { id: 13, type: "custom", models: "AUTO" },
  { id: 14, type: "openrouter", models: "openrouter/auto" },
  { id: 15, type: "kiro", models: "" },
  { id: 16, type: "custom", models: "*" },
  { id: 17, type: "deepseek", models: "deepseek-*" },
].map(c => ({ ...c, name: `fixture-${c.id}`, status: 1, group_list: '["fixture"]' }));
const prices = [{ model: "auto", input_price: 1, output_price: 2, channel_type: "kiro" }];
pool.query = async (sql, args = []) => {
  assert.equal((sql.match(/\?/g) || []).length, args.length);
  if (sql.includes("FROM model_attributions")) return [[{ alias: "12-auto", model: "auto" }]];
  if (sql.includes("FROM model_prices")) return [prices];
  if (sql.includes("FROM channels")) return [channels];
  throw new Error(`Unexpected fixture query: ${sql}`);
};
try {
  invalidatePrices(); invalidateModelRegistry(); invalidateVendorModels();
  await warmAliasMap();
  const registry = await modelRegistry();
  for (const id of [12, 13, 14, 15, 16]) {
    const name = `${id}-auto`;
    assert.equal(registry.get(name).channelId, id);
    assert.equal(canonicalModelName(`${name}-thinking`), name);
    for (const channel of channels) assert.equal(channelSupportsModel(channel, name), channel.id === id, `${name} vs channel ${channel.id}`);
    assert.equal(await isModelPriced(name), false, "old auto price must not be inherited");
    await assert.rejects(runCompletion({ model: name }), e => e.code === "MODEL_NOT_PRICED" && e.billable === false);
  }
  assert.equal(registry.has("auto"), false);
  assert.equal(registry.has("openrouter/auto"), false);
  for (const channel of channels) assert.equal(channelSupportsModel(channel, "auto"), false);
  const available = collectAvailableModels(channels);
  for (const id of [12, 13, 14, 15]) assert(available.has(`${id}-auto`));
  assert(!available.has("auto") && !available.has("openrouter/auto") && !available.has("17-auto"));
  assert(!collectAvailableModels([channels[3]]).has("12-auto"), "blank vendor declarations cannot inherit another channel ID");
  assert.equal(channelUpstreamModel(channels[0], "12-auto-thinking"), "auto");
  assert.equal(channelUpstreamModel(channels[0], "vendor/12-auto-thinking"), "auto");
  assert.equal(channelUpstreamModel(channels[2], "14-auto"), "openrouter/auto");
  assert.equal(channelPriceQuote(channels[2], { model: "14-auto" }).model, "openrouter/auto");
  assert.equal(channelUpstreamModel(channels[0], "claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert(modelInAllowList(["auto"], "12-auto"));
  assert(!modelInAllowList(["auto"], "14-auto"));
  assert(modelInAllowList(["openrouter/auto"], "14-auto"));
  assert(!modelInAllowList(["12-auto"], "13-auto"));
  assert.deepEqual(channelModelLimits(["auto"], channels.slice(0, 2)), ["12-auto", "13-auto"]);
  const sources = groupModelVendors({ name: "fixture", models: '["auto"]' }, channels.slice(0, 2));
  assert.deepEqual(sources["12-auto"], ["kiro"]);
  assert.deepEqual(sources["13-auto"], ["custom"]);
  const pending = await pendingPricedModels();
  for (const id of [12, 13, 14, 15]) {
    const entry = pending.models.find(m => m.model === `${id}-auto`);
    assert.deepEqual(entry.channels.map(c => c.id), [id]);
    assert.deepEqual(entry.candidates, []);
  }
  prices.push({ model: "12-auto", input_price: .31, output_price: .62, channel_type: "kiro" });
  invalidatePrices();
  assert.equal((await getPrice("12-auto")).input, .31);
  assert.equal(await isModelPriced("13-auto"), false);
  assert(!(await pendingPricedModels()).models.some(m => m.model === "12-auto"));
  console.log("auto 渠道隔离通过：目录、通配/空声明、旧组权限、上游名称、独立定价、未配置拦截");
} finally { pool.query = original; await pool.end(); }
