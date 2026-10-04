// 规格归属不改变历史权限/调度合同；内存数据库替身仅提供已确认别名。
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalModelName, modelIdentityInfo, resolveAliasSync, modelInAllowList, warmAliasMap } from "../src/services/models.js";
import { pool } from "../src/db.js";

test("-free 独立身份复用明确本体规格，:free 保持历史 Cline 合同", () => {
  const free = modelIdentityInfo("mimo-v2.6-flash-free");
  assert.equal(free.model, "mimo-v2.6-flash-free");
  assert.equal(free.pricingModel, free.model);
  assert.equal(free.matchedModel, "mimo-v2.6-flash");
  assert.equal(free.developerVendor, "mimo");
  assert.equal(free.source, "variant");
  assert.equal(canonicalModelName("fixture-billing-model:free"), "fixture-billing-model");
  assert.equal(canonicalModelName("gpt-6-sol:batch"), "gpt-6-sol");
  assert.equal(modelIdentityInfo("gpt-6-sol:batch").matchedModel, "gpt-6-sol");
  assert.equal(modelInAllowList(["mimo-v2.6-flash"], "mimo-v2.6-flash-free"), false);
  assert.equal(modelInAllowList(["fixture-billing-model"], "fixture-billing-model:free"), true);
});

test("已登记 alias 与组合能力后缀的规格归属使用同一精确身份", () => {
  const info = modelIdentityInfo("~openai/gpt-6-sol-pro:batch");
  assert.equal(info.model, "gpt-6-sol");
  assert.equal(info.matchedModel, "gpt-6-sol");
  assert.equal(info.developerVendor, "openai");
  assert.equal(info.source, "alias");
  for (const name of ["mimo-v2.6-flash-free-thinking", "mimo-v2.6-flash-free-search"]) {
    const variant = modelIdentityInfo(name);
    assert.equal(variant.model, "mimo-v2.6-flash-free");
    assert.equal(variant.matchedModel, "mimo-v2.6-flash");
    assert.equal(variant.developerVendor, "mimo");
  }
});

test("未知或相似名字不猜厂商；动态 auto 不归属固定模型", () => {
  for (const name of ["mystery-model-free", "mimo-v2.6-flashish-free", "auto-free", "gpt-6.1-sol-unverified-free"]) {
    const info = modelIdentityInfo(name);
    assert.equal(info.matchedModel, "");
    assert.equal(info.developerVendor, "");
    assert.equal(info.known, false);
  }
  for (const name of ["openrouter/auto:free", "opencode/auto", "7-auto-thinking", "vendor/default"]) {
    const dynamic = modelIdentityInfo(name);
    assert.equal(dynamic.model, canonicalModelName(name));
    assert.equal(dynamic.source, "dynamic");
    assert.equal(dynamic.matchedModel, "");
  }
  assert.equal(modelIdentityInfo("openrouter/auto:free").model, "openrouter/auto");
});

test("管理员确认的完整 alias 优先于去命名空间或自动 -free 归属", async () => {
  const query = pool.query;
  pool.query = async sql => {
    assert.match(String(sql), /SELECT alias,model FROM model_attributions/);
    return [[
      { alias: "custom/mimo-v2.6-flash-free", model: "gpt-6-sol" },
      { alias: "mimo-v2.6-flash-free", model: "claude-opus-4-6" },
      { alias: "unknown-free", model: "private-model" },
    ]];
  };
  try {
    await warmAliasMap();
    const info = modelIdentityInfo("custom/mimo-v2.6-flash-free");
    assert.equal(info.model, "gpt-6-sol");
    assert.equal(info.matchedModel, "gpt-6-sol");
    assert.equal(info.developerVendor, "openai");
    assert.equal(info.source, "confirmed");
    assert.equal(resolveAliasSync("custom/mimo-v2.6-flash-free"), "gpt-6-sol");
    assert.equal(modelIdentityInfo("mimo-v2.6-flash-free").developerVendor, "anthropic");
    assert.equal(modelIdentityInfo("unknown-free").model, "private-model");
    assert.equal(modelIdentityInfo("unknown-free").developerVendor, "");
  } finally {
    pool.query = async () => [[]];
    await warmAliasMap();
    pool.query = query;
  }
});