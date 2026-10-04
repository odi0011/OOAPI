// 只验证渠道模型解析，不读取真实渠道/凭据，不访问数据库或上游。
import test from "node:test";
import assert from "node:assert/strict";
import { channelUpstreamModel } from "../src/services/channel-models.js";
import { canonicalModelName, modelForChannelMatch, modelInAllowList } from "../src/services/models.js";
import { channelSupportsModel } from "../src/services/router.js";
import { applyVendorRequest } from "../src/services/upstream/vendor-quirks.js";

const channel = (models, other = {}) => ({ id: 7, type: "gemini", models, other: { method: "antigravity", ...other } });

test("服务端显式传入统一别名解析器，纯共享模块不自行猜旧版型号", () => {
  const ch = channel("claude-opus-4.6-thinking");
  assert.equal(channelUpstreamModel(ch, "claude-opus-4-6"), "claude-opus-4-6");
  assert.equal(channelUpstreamModel(ch, "claude-opus-4-6", "auto", canonicalModelName), "claude-opus-4.6-thinking");
});

test("站内规范模型仍命中同一渠道，并恢复探针实际使用的 thinking SKU", () => {
  const ch = channel("claude-opus-4-6-thinking,gemini-3.8-flash-low,gemini-3.8-flash-high");
  const publicModel = canonicalModelName("claude-opus-4-6-thinking");
  const requested = modelForChannelMatch(publicModel);
  assert.equal(publicModel, "claude-opus-4-6");
  assert.equal(channelSupportsModel(ch, requested), true);
  assert.equal(channelUpstreamModel(ch, requested), "claude-opus-4-6-thinking");
  assert.equal(modelInAllowList(["claude-opus-4-6"], channelUpstreamModel(ch, requested)), true);
});

test("精确声明优先、保留原始大小写和 Gemini 独立 low/high 档位", () => {
  const ch = channel(["claude-opus-4-6-thinking", "Claude-Opus-4-6", "gemini-3.8-flash-low", "gemini-3.8-flash-high"]);
  assert.equal(channelUpstreamModel(ch, "claude-opus-4-6"), "Claude-Opus-4-6");
  assert.equal(channelUpstreamModel(ch, "claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
  for (const suffix of ["low", "high"]) assert.equal(channelUpstreamModel(ch, `gemini-3.8-flash-${suffix}`), `gemini-3.8-flash-${suffix}`);
  assert.equal(channelUpstreamModel(ch, "gemini-3.8-flash"), "gemini-3.8-flash", "不能把裸模型猜成某个思考档位");
});

test("只认本渠道唯一声明，忽略通配和重复，歧义时不借用登记表兜底", () => {
  const model = "claude-opus-4-6";
  assert.equal(channelUpstreamModel(channel("*,claude-opus-4-6-thinking,claude-opus-4-6-thinking"), model), `${model}-thinking`);
  for (const models of ["", "*", "claude-sonnet-4-6-thinking", "claude-opus-4-6-thinking,claude-opus-4-6:thinking"]) {
    assert.equal(channelUpstreamModel(channel(models), model, `${model}-thinking`), model);
  }
  assert.equal(channelUpstreamModel(channel("claude-opus-4-6:thinking,claude-opus-4-6-thinking"), model), model, "反转声明顺序也不能改变选择");
});

test("N-auto 仍按渠道归属恢复，不能被相同身份匹配串到其他渠道", () => {
  assert.equal(channelUpstreamModel(channel("auto"), "7-auto-thinking"), "auto");
  assert.equal(channelUpstreamModel(channel("vendor/auto"), "vendor/7-auto-thinking"), "vendor/auto");
  assert.equal(channelUpstreamModel(channel(""), "7-auto", "vendor/auto"), "vendor/auto");
  assert.equal(channelUpstreamModel(channel("auto"), "8-auto"), "8-auto");
});

test("普通 API 与 WorkBuddy 等保持各自现有模型映射边界", () => {
  for (const ch of [channel("claude-opus-4-6-thinking", { method: "api" }), { type: "anthropic", models: "claude-opus-4-6-thinking", other: { method: "claude-oauth" } }]) {
    assert.equal(channelUpstreamModel(ch, "claude-opus-4-6"), "claude-opus-4-6");
  }
  for (const type of ["workbuddy", "opencode"]) {
    const ch = { type, models: "deepseek-v4.1-flash", other: { method: type } };
    const model = channelUpstreamModel(ch, "deepseek-flash");
    assert.equal(model, "deepseek-flash");
    const body = { model }; applyVendorRequest(body, { channel: ch });
    assert.equal(body.model, "deepseek-v4.1-flash");
  }
  const api = { type: "deepseek", models: "deepseek-flash", other: { method: "api" } };
  assert.equal(channelUpstreamModel(api, "deepseek-v4-flash"), "deepseek-v4-flash");
});
