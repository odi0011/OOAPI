import assert from "node:assert/strict";
import test from "node:test";
import { chatErrorDetails, chatErrorPart } from "../../ooapi-web/src/services/chat-error-display.js";

test("chat failures retain only public diagnostics from HTTP recovery and SSE", () => {
  const fields = { code: "CHANNEL_BAD_REQUEST", http_status: 400, upstream_error_code: "INVALID_ARGUMENT", upstream_response: { error: { message: "Unknown field" } } };
  const expected = { type: "error", message: "上游拒绝请求", ...fields };
  assert.deepEqual(chatErrorPart({ message: expected.message, ...fields, headers: { authorization: "fixture-private" } }), expected);
  assert.deepEqual(chatErrorPart({ message: expected.message, data: { data: { ...fields, request: { credential: "fixture-private" } } } }), expected);
  assert.deepEqual(chatErrorPart({ message: expected.message, data: fields }), expected);
});

test("historical errors without diagnostics keep their original explanation", () => {
  assert.deepEqual(chatErrorDetails({ text: "历史失败原因" }), { message: "历史失败原因", metadata: "", response: "" });
  assert.equal(chatErrorDetails({ message: "请求失败（HTTP 503）" }).metadata, "HTTP 503");
});

test("upstream JSON is readable while HTML and Markdown stay ordinary text", () => {
  const upstream = { error: { code: 400, message: '<script>window.fixtureUnsafe = true</script> [x](javascript:alert(1))' } };
  const pretty = JSON.stringify(upstream, null, 2);
  assert.equal(chatErrorDetails({ upstream_response: upstream }).response, pretty);
  assert.equal(chatErrorDetails({ upstream_response: JSON.stringify(upstream) }).response, pretty);
  assert.equal(chatErrorDetails({ upstream_response: "<b>upstream unavailable</b>" }).response, "<b>upstream unavailable</b>");
  assert.equal(chatErrorDetails({ code: "CHANNEL_BAD_REQUEST", http_status: 400, upstream_error_code: 11133 }).metadata, "HTTP 400 · CHANNEL_BAD_REQUEST · 11133");
});
