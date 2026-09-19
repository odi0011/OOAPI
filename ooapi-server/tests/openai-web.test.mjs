// OpenAI 网页版适配器桩测试（凭据解析 + 模型映射，无需真实凭据）
import test from "node:test";
import assert from "node:assert/strict";
import { parseAuthJson, webModelId } from "../src/services/upstream/openai-web-parse.js";

test("openai-web：裸 access_token 字符串", () => {
  const c = parseAuthJson("a".repeat(50));
  assert.equal(c.access_token, "a".repeat(50));
  assert.equal(c.refresh_token, "");
});

test("openai-web：会话 JSON（accessToken/refreshToken）", () => {
  const c = parseAuthJson(JSON.stringify({ accessToken: "at", refreshToken: "rt", user: { email: "u@x.com" } }));
  assert.equal(c.access_token, "at");
  assert.equal(c.refresh_token, "rt");
  assert.equal(c.email, "u@x.com");
});

test("openai-web：嵌套 session 包装 + snake_case", () => {
  const c = parseAuthJson(JSON.stringify({ session: { access_token: "at2", refresh_token: "rt2" } }));
  assert.equal(c.access_token, "at2");
  assert.equal(c.refresh_token, "rt2");
});

test("openai-web：非法输入报错", () => {
  assert.throws(() => parseAuthJson("short"), /access_token/);
  assert.throws(() => parseAuthJson(JSON.stringify({ foo: 1 })), /缺少 access_token/);
});

test("openai-web：模型映射", () => {
  assert.equal(webModelId("gpt-5.6-luna"), "auto");
  assert.equal(webModelId("gpt-5.5"), "auto");
  assert.equal(webModelId("gpt-4o"), "gpt-4o");
  assert.equal(webModelId("gpt-4o-mini"), "gpt-4o-mini");
  assert.equal(webModelId("unknown-model"), "auto");
});
