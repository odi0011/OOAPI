// Grok CLI 版本兼容回归：xAI 已拒绝旧版客户端并返回 HTTP 426。
// 这里用受控 fetch 验证对话/健康检查实际发出的头，避免触碰真实账号或上游额度。
import assert from "node:assert/strict";
import { grokClientVersion, grokIdentity } from "../src/services/upstream/cli-profile.js";
import { verify } from "../src/services/upstream/grok.js";
import { fetchQuota, normalizeGrokQuota } from "../src/services/upstream/quota.js";
import { quotaNumber } from "../../ooapi-web/src/components/quota-order.js";

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

// 真实响应的结构：有结算周期和现金余额，缺少 creditUsagePercent/套餐字段。
const partial = normalizeGrokQuota({ config: {
  currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-10-09T00:00:00Z" },
  prepaidBalance: { val: 0 }, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 },
} });
assert.equal(partial.windows[0].usedPercent, null);
assert.equal(partial.windows[0].tag, "7d");
assert.equal(partial.windows[0].resetAt, 1791504000);
assert.equal(partial.usageUnavailable, true);
assert.equal(partial.plan, "", "不能根据现金余额为 0 猜测免费套餐");
assert.equal(partial.credits.prepaidBalance, 0, "上游明确返回的余额 0 必须保留");
for (const value of [undefined, null, "", " ", false, [], {}, "invalid"]) {
  assert.equal(normalizeGrokQuota({ creditUsagePercent: value }).usageUnavailable, true);
  assert.equal(quotaNumber(value), null);
}
const full = normalizeGrokQuota({ creditUsagePercent: 0.1, subscriptionTier: "SuperGrok", prepaidBalance: { val: 2500 } });
assert.equal(full.windows[0].usedPercent, 0.1, "0.1% 不能放大为 10%");
assert.equal(full.plan, "SuperGrok");
assert.equal(full.credits.prepaidBalance, 25);
assert.equal(normalizeGrokQuota({ creditUsagePercent: 0 }).usageUnavailable, false);
assert.equal(quotaNumber(0), 0);
assert.equal(quotaNumber("0"), 0);
assert.equal(normalizeGrokQuota({ prepaidBalance: { val: null } }).credits.prepaidBalance, null);
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
  assert.equal(init.headers["x-grok-client-version"], "1.0.13");
  assert.equal(init.headers["x-grok-client-identifier"], "grok-shell");
  return Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } });
};
try {
  const result = await fetchQuota({ ...channel("0.2.120"), method: "grok-oauth" });
  assert.equal(result.provider, "grok-oauth");
  assert.equal(result.windows[0].usedPercent, null);
} finally { globalThis.fetch = originalFetch; }
console.log("Grok CLI 版本、账号额度缺省与真实零值：通过");
