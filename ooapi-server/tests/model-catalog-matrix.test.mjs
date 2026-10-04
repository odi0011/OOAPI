// 覆盖所有仓库内可发现目录与价格/规格库；请求通过受控 fetch 运行实际三协议适配器。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pool } from "../src/db.js";
import { setOption } from "../src/config.js";
import { allPublicModels, canonicalModelName, modelIdentityInfo, modelInAllowList, warmAliasMap } from "../src/services/models.js";
import { DEFAULT_PRICES, getPrice, invalidatePrices, isModelPriced } from "../src/services/pricing.js";
import { modelCapabilities, modelCapabilityDocumentation } from "../src/services/model-capabilities.js";
import { upstreamModelForChannel, upstreamModelOf, applyVendorRequest, guessVendorFromUrl } from "../src/services/upstream/vendor-quirks.js";
import { chatOnce as chat } from "../src/services/upstream/openai-compat.js";
import { chatOnce as responses } from "../src/services/upstream/responses-compat.js";
import { chatOnce as messages } from "../src/services/upstream/anthropic-compat.js";

const originalQuery = pool.query;
pool.query = async (sql) => {
  if (/model_attributions/.test(String(sql))) return [[]];
  throw new Error("Unexpected test query");
};
await warmAliasMap();
pool.query = originalQuery;
const catalog = await allPublicModels();
const originalVendors = new Set(["deepseek", "glm", "kimi", "doubao", "qwen", "openai", "anthropic", "gemini", "grok", "mimo", "minimax", "stepfun", "ark"]);
const specs = JSON.parse(fs.readFileSync(new URL("../src/services/model-capabilities.json", import.meta.url), "utf8"));

test("18 个厂商目录每个可发现型号：规范身份、真实声明和精确权限一致", () => {
  assert.equal(new Set(catalog.map(m => m.vendor)).size, 18);
  assert.ok(catalog.length >= 119);
  for (const model of catalog) {
    const info = modelIdentityInfo(model.id);
    assert.equal(info.model, canonicalModelName(model.id));
    assert.equal(info.pricingModel, info.model);
    assert.equal(modelCapabilities(model.id).model, info.model);
    const channel = { type: model.vendor, models: model.id, other: { method: "api" } };
    assert.equal(upstreamModelForChannel(channel, info.model), model.id, `${model.vendor}/${model.id}: exact channel SKU`);
    assert.ok(modelInAllowList([model.id], info.model));
    assert.equal(modelInAllowList([model.id], `${info.model}-unregistered-more-expensive`), false);
    if (info.developerVendor) assert.ok(originalVendors.has(info.developerVendor), "聚合服务商不能冒充原厂");
  }
});

test("全默认价与规格目录：未知后缀不继承，-free 仅对已确认本体继承", () => {
  const ids = new Set([...DEFAULT_PRICES.map(p => p.model), ...Object.keys(specs)]);
  for (const id of ids) {
    const info = modelIdentityInfo(id);
    const free = modelIdentityInfo(`${id}-free`);
    if (info.known && !id.endsWith("-free")) {
      assert.equal(free.matchedModel, info.model, `${id} variant owner`);
      assert.equal(free.developerVendor, info.developerVendor);
      assert.equal(free.model, canonicalModelName(`${id}-free`));
      if (specs[info.model] && !specs[free.model]) {
        const own = modelCapabilities(free.model), base = modelCapabilities(info.model);
        assert.equal(own.contextWindow, base.contextWindow);
        assert.equal(own.maxOutputTokens, base.maxOutputTokens);
        assert.deepEqual(own.reasoning, base.reasoning);
      }
    }
    const changed = modelIdentityInfo(`${id}-not-an-alias-free`);
    assert.equal(changed.matchedModel, "");
    assert.equal(changed.known, false);
  }
  assert.equal(modelIdentityInfo("grok-3-mini").developerVendor, "grok", "已注册原厂目录不应要求先配置价格才能识别归属");
  assert.equal(modelIdentityInfo("longcat-2.0").developerVendor, "", "聚合目录不能凭名称推测原厂");
});

test("已知免费 SKU 有独立价格时优先、只有本体价格时继承、未知 SKU 不兜底", async () => {
  pool.query = async () => [[
    { model: "gpt-6-sol", input_price: 7, output_price: 21, cache_price: 1 },
    { model: "gpt-6-sol-free", input_price: 0, output_price: 0, cache_price: 0 },
    { model: "mimo-v2.6-flash", input_price: 1, output_price: 2, cache_price: 0.1 },
  ]];
  try {
    invalidatePrices();
    assert.equal((await getPrice("gpt-6-sol-free")).input, 0);
    assert.equal((await getPrice("gpt-6-sol-free")).model, "gpt-6-sol-free");
    assert.equal((await getPrice("mimo-v2.6-flash-free")).model, "mimo-v2.6-flash-free", "价格来源不能改变请求型号");
    assert.equal((await getPrice("mimo-v2.6-flash-free")).pricingSourceModel, "mimo-v2.6-flash");
    assert.equal(await isModelPriced("mimo-v2.6-flash-free"), true);
    assert.equal(await isModelPriced("mimo-v2.6-flash-unknown-free"), false);
  } finally { pool.query = originalQuery; invalidatePrices(); }
});

test("SKU 自定义规格独立于本体，返回值修改不会污染其他型号", async () => {
  pool.query = async sql => { assert.match(String(sql), /INSERT INTO options/); return [{ affectedRows: 1 }]; };
  try {
    const model = "mimo-v2.6-flash-free";
    const before = modelCapabilities("mimo-v2.6-flash");
    await setOption(`model_caps:${model}`, JSON.stringify({ contextWindow: 65432, maxOutputTokens: 1234 }));
    const own = modelCapabilities(model);
    assert.equal(own.contextWindow, 65432);
    assert.equal(own.customized, true);
    own.reasoning.levels.push("fixture-mutation");
    assert.deepEqual(modelCapabilities("mimo-v2.6-flash"), before);
    assert.ok(!modelCapabilities(model).reasoning.levels.includes("fixture-mutation"));
    assert.ok(modelCapabilityDocumentation(model, "opencode").includes("mimo.mi.com"));
    await setOption(`model_caps:${model}`, "null");
  } finally { pool.query = originalQuery; }
});

test("显式 SKU 不变成正价档；三协议、大小写和批处理正常档优先一致", async () => {
  for (const type of ["workbuddy", "opencode", "minimax"]) {
    for (const sku of ["deepseek-flash:free", "deepseek-flash:batch", "vendor/deepseek-flash", "deepseek-flash-free"]) {
      assert.equal(upstreamModelOf(type, sku), sku);
      assert.equal(upstreamModelForChannel({ type, models: "deepseek-flash" }, sku), sku);
    }
  }
  const fetch = globalThis.fetch;
  try {
    for (const [name, adapter] of Object.entries({ chat, responses, messages })) {
      for (const declared of ["OpenAI/GPT-6-Sol", "OpenAI/GPT-6-Sol:free", "GPT-6-Sol:batch,OpenAI/GPT-6-Sol"]) {
        const expected = declared.includes(",") ? "OpenAI/GPT-6-Sol" : declared;
        const channel = { id: 81380, type: "custom", base_url: "http://127.0.0.1:48151/v1", api_key: "fixture-not-a-real-key", models: declared, other: { allow_private_upstream: true } };
        globalThis.fetch = async (_url, init) => {
          assert.equal(JSON.parse(init.body).model, expected, `${name}/${declared}`);
          const body = name === "chat" ? { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }
            : name === "responses" ? { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }
              : { content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" };
          return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        };
        const result = await adapter({ channel, endpoint: "http://127.0.0.1:48151/v1/responses", model: "gpt-6-sol", prompt: "fixture", messages: [{ role: "user", content: "fixture" }] });
        assert.equal(result.content, "OK");
      }
    }
  } finally { globalThis.fetch = fetch; }
});

test("厂商 URL 仅按官方 host 判定，不被路径/参数/用户名/相似域注入", () => {
  for (const url of ["https://example.invalid/minimax", "https://example.invalid/?upstream=api.stepfun.com", "https://api.minimax.io@example.invalid/v1", "https://api.minimax.io.example.invalid/v1", "https://evil-volces.com/api/v3", "https://fake-mimo.mi.com/v1", "file://api.minimax.io/v1"]) assert.equal(guessVendorFromUrl(url), "", url);
  for (const [url, vendor] of [["https://api.minimax.io/v1", "minimax"], ["https://api.stepfun.com/v1", "stepfun"], ["https://ark.cn-beijing.volces.com/api/v3", "ark"], ["https://api.xiaomimimo.com/v1", "mimo"]]) assert.equal(guessVendorFromUrl(url), vendor);
  const body = { model: "fixture", temperature: 5 };
  applyVendorRequest(body, { channel: { type: "custom", base_url: "https://example.invalid/minimax" } });
  assert.deepEqual(body, { model: "fixture", temperature: 5 });
});
