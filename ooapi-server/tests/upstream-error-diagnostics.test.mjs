import test from "node:test";
import assert from "node:assert/strict";
import { attachUpstreamDiagnostics, publicErrorDiagnostics } from "../src/services/upstream/error-diagnostics.js";
import { publicRunError } from "../src/services/upstream/public-error.js";

test("Google 工具参数失败保留 HTTP、原始错误码和字段路径，剔除其他响应字段", () => {
  const error = Object.assign(new Error("adapter failure"), { code: "CHANNEL_BAD_REQUEST", usage: { promptTokens: 0 }, billable: false });
  const body = { error: { code: 400, status: "INVALID_ARGUMENT", message: 'Invalid JSON payload: Unknown name "additionalProperties".', details: [{
    "@type": "type.googleapis.com/google.rpc.BadRequest",
    fieldViolations: [{ field: "tools[0].function_declarations[1].parameters", description: "Unknown name additionalProperties", request: "must not copy" }],
    metadata: { stack: "must not copy" },
  }], request: "must not copy", stack: "must not copy" }, headers: { dummy: "must not copy" } };
  assert.equal(attachUpstreamDiagnostics(error, { status: 400, body }), error);
  assert.deepEqual(publicErrorDiagnostics(error), { http_status: 400, upstream_error_code: "INVALID_ARGUMENT", upstream_response: { error: {
    code: 400, status: "INVALID_ARGUMENT", message: 'Invalid JSON payload: Unknown name "additionalProperties".',
    details: [{ fieldViolations: [{ field: "tools[0].function_declarations[1].parameters", description: "Unknown name additionalProperties" }] }],
  } } });
  assert.equal(error.code, "CHANNEL_BAD_REQUEST");
  assert.deepEqual(error.usage, { promptTokens: 0 });
  assert.equal(error.billable, false, "诊断不得改变账单属性");
});

test("未知本地异常和未标记 upstreamResponse 不冒充实际接口返回", () => {
  const error = Object.assign(new Error("private local exception"), { httpStatus: 502, upstreamResponse: { message: "injected" } });
  assert.deepEqual(publicErrorDiagnostics(error), { http_status: 502 });
  attachUpstreamDiagnostics(error, { status: 502 });
  assert.deepEqual(publicErrorDiagnostics(error), { http_status: 502 });
  assert.deepEqual(publicErrorDiagnostics(null), {});
  assert.deepEqual(publicErrorDiagnostics({ status: "https://private.invalid" }), {});
});

test("多 Key、OAuth、Cookie、嵌套请求头及 URL 凭据从诊断投影中清除", () => {
  const secrets = ["fixture-key-alpha", "fixture-key-beta", "fixture-refresh", "fixture-cookie-value", "fixture-custom-header", "fixture-proxy-pass", "fixture-api-query"];
  const channel = { api_key: secrets.slice(0, 2).join("\n"), other: JSON.stringify({ refresh_token: secrets[2], cookie: `session=${secrets[3]}`, headers: { "x-custom-credential": secrets[4] } }), base_url: `https://fixture-user:${secrets[5]}@private.invalid/?key=${secrets[6]}` };
  const error = attachUpstreamDiagnostics(new Error("private"), { status: 401, channel, body: { error: {
    code: "invalid_key", message: `Failed ${secrets.join(" ")} ${encodeURIComponent(secrets[0])}`, details: [{ fieldViolations: [{ field: secrets[1], description: secrets[2] }] }],
  } } });
  const publicValue = JSON.stringify(publicErrorDiagnostics(error));
  for (const secret of secrets) assert.ok(!publicValue.includes(secret));
  assert.ok(publicValue.includes("已隐藏"));
  assert.ok(!error.message.includes(secrets[0]));
});

test("未配置在渠道中的常见凭据形态、响应内回显请求秘密仍须隐藏", () => {
  const body = { error: { message: 'Invalid Authorization: Bearer fixture-bearer\nCookie: example=fixture-cookie\napi_key=fixture-api\nsecret=fixture-secret\nhttps://name:fixture-password@example.invalid/?token=fixture-token\neyJmaXh0dXJlIjoxfQ.eyJleHAiOjF9.fixtureSignature\nsk-fixtureexamplevalue\nresponse-reflected-secret\n{"api_key":"fixture-quoted","password":"fixture spaced password"}' }, request: { headers: { "x-private": "response-reflected-secret" } } };
  const result = JSON.stringify(publicErrorDiagnostics(attachUpstreamDiagnostics(new Error("hidden"), { body })));
  for (const secret of ["fixture-bearer", "fixture-cookie", "fixture-api", "fixture-secret", "fixture-password", "fixture-token", "fixtureSignature", "sk-fixtureexamplevalue", "response-reflected-secret", "fixture-quoted", "fixture spaced password"]) assert.ok(!result.includes(secret), secret);
});

test("响应只允许白名单字段且 HTML、残缺 JSON 不自由回显", () => {
  for (const body of ['<!doctype html><html><script>fixtureDanger()</script></html>', '{"error":{"request":"fixturePrivate"']) {
    const result = JSON.stringify(publicErrorDiagnostics(attachUpstreamDiagnostics(new Error("hidden"), { body })));
    assert.ok(!result.includes("fixtureDanger") && !result.includes("fixturePrivate") && !result.includes("<script>"));
  }
  const error = attachUpstreamDiagnostics(new Error("hidden"), { body: { error: { message: "bad <img src=x onerror=fixtureDanger()> schema", request: { secret: "fixturePrivate" } } } });
  assert.equal(publicErrorDiagnostics(error).upstream_response.error.message, "bad [标记已省略] schema");
});

test("已捕获投影不可被公开属性或调用方修改污染", () => {
  const error = attachUpstreamDiagnostics(new Error("hidden"), { status: 400, body: { error: { message: "bad parameters" } } });
  error.upstreamResponse.error.message = "injected private data";
  const one = publicErrorDiagnostics(error);
  assert.equal(one.upstream_response.error.message, "bad parameters");
  one.upstream_response.error.message = "second injected private data";
  assert.equal(publicErrorDiagnostics(error).upstream_response.error.message, "bad parameters");
});

test("字符串、深度和总输出都有上限，先脱敏再截断", () => {
  const secret = "fixtureLongCredential";
  const error = attachUpstreamDiagnostics(new Error("hidden"), { channel: { api_key: secret }, body: { error: { message: "x".repeat(1995) + secret + "y".repeat(10000), details: Array.from({ length: 8 }, () => ({ fieldViolations: Array.from({ length: 16 }, () => ({ field: "tools[0]", description: "d".repeat(1000) })) })) } } });
  const result = JSON.stringify(publicErrorDiagnostics(error));
  assert.ok(result.length < 16000);
  assert.ok(!result.includes(secret.slice(0, 7)), "不得泄漏截断密钥的前缀");
  const deep = { error: { message: "deep response" } };
  let cursor = deep;
  for (let i = 0; i < 20; i++) cursor = cursor.child = {};
  assert.match(publicErrorDiagnostics(attachUpstreamDiagnostics(new Error("hidden"), { body: deep })).upstream_response.error.message, /过于复杂/);
  assert.match(publicErrorDiagnostics(attachUpstreamDiagnostics(new Error("hidden"), { body: "x".repeat(70000) })).upstream_response.error.message, /过长/);
});

test("兼容文本和不同厂商的结构化错误，同时保持 CHANNEL_BAD_REQUEST 中文原因", () => {
  assert.deepEqual(publicErrorDiagnostics(attachUpstreamDiagnostics(new Error("hidden"), { status: 429, body: "rate limited" })).upstream_response, { error: { message: "rate limited" } });
  assert.deepEqual(publicErrorDiagnostics(attachUpstreamDiagnostics(new Error("hidden"), { body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "invalid parameter", param: "tools" } }) })).upstream_response, { error: { type: "invalid_request_error", message: "invalid parameter", param: "tools" } });
  assert.match(publicRunError({ code: "CHANNEL_BAD_REQUEST" }), /上游拒绝了请求参数/);
  assert.match(publicRunError({ code: "CHANNEL_BAD_REQUEST", message: 'tools[0].function_declarations[0].parameters: unknown name additionalProperties' }), /工具定义的参数格式/);
});
