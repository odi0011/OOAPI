// 真执行公共门禁与目录逻辑；数据库仅用内存数据，不访问上游。
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import { getPrice, loadPrices, isModelPriced, pendingPricedModels, invalidatePrices } from "../src/services/pricing.js";
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
  for (const name of ["auto", "old-estimate", `${model}-invented`, "unknown-free"]) {
    assert.equal(await isModelPriced(name), false, `${name} cannot inherit a guessed price`);
    assert.equal((await getPrice(name)).unpriced, true);
    await assert.rejects(runCompletion({ model: name }), e => e.code === "MODEL_NOT_PRICED" && e.billable === false);
  }
  const pending = await pendingPricedModels();
  assert.equal(pending.count, 1);
  assert.equal(await isModelPriced(sku), true, '已知 free 变体可以复用已核实本体价');
  assert.equal((await getPrice(sku)).model, sku, '默认价不能改变发给上游的模型ID');
  assert.equal((await getPrice(sku)).input, .14);
  assert.equal((await loadPrices()).get(sku).pricingSourceModel, model);
  prices.push({ model: sku, input_price: 0, output_price: 0, cache_price: 0, channel_type: 'opencode' });
  invalidatePrices();
  assert.equal((await getPrice(sku)).input, 0, '管理员的独立0价优先');
  assert.equal((await getPrice(sku)).type, 'mimo', '接入厂商不覆盖开发厂商');
  prices.pop(); invalidatePrices();
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
  assert.equal(await isModelPriced(sku), true, "撤销人工关系后仍可识别已核实的本体，不丢独立SKU身份");
  assert.equal(canonicalModelName(sku), sku);
  console.log("严格定价门禁：动态路由隔离、未知阻断、已知变体归属、独立价格优先、确认、SKU恢复全部通过");
} finally { pool.query = original; invalidatePrices(); invalidateModelRegistry(); }
await import("./channel-auto-model.test.mjs");
