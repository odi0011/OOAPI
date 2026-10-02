// Grok CLI 版本兼容回归：xAI 已拒绝旧版客户端并返回 HTTP 426。
// 这里用受控 fetch 验证对话/健康检查实际发出的头，避免触碰真实账号或上游额度。
import assert from "node:assert/strict";
import { grokClientVersion, grokIdentity } from "../src/services/upstream/cli-profile.js";
import { verify } from "../src/services/upstream/grok.js";

const channel = (clientVersion) => ({
  id: 991013,
  type: "grok",
  other: { access_token: "fixture-token", client_version: clientVersion },
});

assert.equal(grokClientVersion(channel("0.2.120")), "1.0.13", "旧版存量配置必须回落到最低兼容版本");
assert.equal(grokClientVersion(channel("0.2.112")), "1.0.13", "额度查询曾使用的旧版本也必须被拦截");
assert.equal(grokClientVersion(channel("1.0.13")), "1.0.13");
assert.equal(grokClientVersion(channel("1.2.0")), "1.2.0", "更高的管理员显式版本应保留");
assert.equal(grokClientVersion(channel("")), "1.0.13", "缺省版本必须使用当前最低兼容版本");
assert.equal(grokIdentity(channel("0.2.120")).clientVersion, "1.0.13");

const originalFetch = globalThis.fetch;
let seen = null;
globalThis.fetch = async (_url, init = {}) => {
  seen = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
};
try {
  await verify(channel("0.2.120"));
  assert.equal(seen["x-grok-client-version"], "1.0.13", "健康检查不能再带 0.2.x");
  assert.equal(seen["user-agent"], "xai-grok-workspace/1.0.13");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Grok CLI 版本兼容：6 项通过");
