import assert from "node:assert/strict";
import http from "node:http";
import { endpointPath, endpointList, recordUpstreamEndpoint, withEndpointAudit } from "../src/services/endpoint-audit.js";
import { visibleChatAudit } from "../src/services/user-data-visibility.js";

assert.equal(endpointPath("https://fixture:private@example.invalid/zen/v1/responses?key=private#private"), "/zen/v1/responses");
assert.equal(endpointPath("/custom-private-prefix/v1/chat/completions"), "/:id/v1/chat/completions");
assert.equal(endpointPath("/v1beta/models/private-model:streamGenerateContent?key=private"), "/v1beta/models/:model:streamGenerateContent");
assert.equal(endpointPath("/oauth/token?private=value"), "");
assert.equal(endpointPath("/v1/models"), "");
assert.equal(endpointPath("/api/v0/chat/create_pow_challenge"), "");
assert.equal(endpointPath("/backend-api/f/conversation/prepare"), "");
assert.deepEqual(endpointList([undefined, ["/v1/messages", "/v1/messages"], "/v1/responses"]), ["/v1/messages", "/v1/responses"]);
assert.deepEqual(visibleChatAudit({part:{upstream_endpoints:['/v1/responses'],upstreamEndpoints:['/v1/messages']}},{usage_records:true,pricing:true}),{part:{}});
assert.equal(endpointPath('/archon/api/v1/session/fixture-id/message?token=private'),'/archon/api/v1/session/:id/message');
assert.equal(endpointPath('/api/agent/capy.agent.v1.AgentService/ChatStream'),'/api/agent/capy.agent.v1.AgentService/ChatStream');
const server = http.createServer((req, res) => { req.resume(); setTimeout(() => { res.writeHead(200); res.end("fixture"); }, req.url.includes("responses") ? 25 : 5); });
await new Promise(r => server.listen(0, "127.0.0.1", r));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = { endpoints: [] }, b = { endpoints: [] };
  await Promise.all([
    withEndpointAudit(a, async () => { await (await fetch(base + "/oauth/token", {method:"POST"})).text(); await (await fetch(base + "/v1/responses?key=private", {method:"POST"})).text(); }),
    withEndpointAudit(b, async () => { await (await fetch(base + "/v1/chat/completions", {method:"POST"})).text(); recordUpstreamEndpoint("/api/chat/private-session/completion"); }),
  ]);
  assert.deepEqual(a.endpoints, ["/v1/responses"]);
  assert.deepEqual(b.endpoints, ["/v1/chat/completions", "/api/chat/:id/completion"]);
  a.closed = true;
  withEndpointAudit(a, () => recordUpstreamEndpoint("/v1/messages"));
  assert.deepEqual(a.endpoints, ["/v1/responses"]);
  assert.ok(!JSON.stringify([a,b]).includes("private"));
  console.log("端点：真实并发HTTP、协议路径脱敏、非调用请求排除与结束后冻结通过");
} finally { await new Promise(r => server.close(r)); }
import "./endpoint-fallback.test.mjs";
