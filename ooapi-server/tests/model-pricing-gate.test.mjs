// 真执行公共门禁与目录逻辑；数据库仅用内存数据，不访问上游。
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import { getPrice, isModelPriced, pendingPricedModels, invalidatePrices } from "../src/services/pricing.js";
import { canonicalModelName, warmAliasMap, invalidateModelRegistry } from "../src/services/models.js";
import { applyVendorRequest } from "../src/services/upstream/vendor-quirks.js";
import { runCompletion } from "../src/services/execute.js";

const original = pool.query;
const sku = "mimo-v2.6-flash-free", model = "mimo-v2.6-flash";
let approved = [];
const prices = [{ model, input_price: .14, output_price: .28, cache_price: .0028, channel_type: "mimo" },
  { model: "openrouter/auto", input_price: 2, output_price: 4, channel_type: "openrouter" },
  { model: "old-estimate", input_price: .3, output_price: 1.2, remark: "按同类轻量档估录，待复核" }];
const channels = [{ id: 1, name: "fixture", type: "opencode", models: sku },
  { id: 2, name: "dynamic", type: "kiro", models: "auto" }];
pool.query = async (sql, args = []) => {
  assert.equal((sql.match(/\?/g) || []).length, args.length);
  if (sql.includes("FROM model_attributions")) return [approved];
  if (sql.includes("FROM model_prices")) return [prices];
  if (sql.includes("FROM channels")) return [channels];
  throw new Error(`Unapproved fixture query: ${sql}`);
};
const reset = async () => { invalidatePrices(); invalidateModelRegistry(); await warmAliasMap(); };
try {
  await reset();
  assert.equal(canonicalModelName("auto"), "auto");
  assert.equal(canonicalModelName("openrouter/auto"), "openrouter/auto");
  assert.equal(canonicalModelName("openrouter/auto:free"), "openrouter/auto");
  assert.equal(canonicalModelName("openrouter/auto-thinking"), "openrouter/auto");
  for (const name of [sku, "auto", "old-estimate", `${model}-invented`]) {
    assert.equal(await isModelPriced(name), false, `${name} cannot inherit a guessed price`);
    assert.equal((await getPrice(name)).unpriced, true);
    await assert.rejects(runCompletion({ model: name }), e => e.code === "MODEL_NOT_PRICED" && e.billable === false);
  }
  const pending = await pendingPricedModels();
  assert.equal(pending.count, 2);
  assert.equal(pending.models.find(m => m.model === sku).candidates[0].model, model);
  assert.deepEqual(pending.models.find(m => m.model === "2-auto").candidates, []);
  approved = [{ alias: sku, model }]; await reset();
  assert.equal(canonicalModelName(sku), model);
  assert.equal(await isModelPriced(sku), true);
  assert.equal((await getPrice(sku)).input, .14);
  assert.equal((await getPrice(sku)).type, "mimo");
  const body = { model }; applyVendorRequest(body, { channel: channels[0] });
  assert.equal(body.model, sku, "upstream still receives its actual SKU");
  assert.equal((await pendingPricedModels()).count, 1);
  approved = []; await reset();
  assert.equal(await isModelPriced(sku), false, "revocation immediately restores the pricing gate");
  console.log("严格定价门禁：动态路由隔离、未配价阻断、候选、确认、SKU恢复、撤销全部通过");
} finally { pool.query = original; invalidatePrices(); invalidateModelRegistry(); }
await import("./channel-auto-model.test.mjs");
