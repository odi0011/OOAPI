import test from "node:test";
import assert from "node:assert/strict";
import { chatOnce as openai } from "../src/services/upstream/openai-compat.js";
import { chatOnce as anthropic } from "../src/services/upstream/anthropic-compat.js";
import { chatOnce as responses } from "../src/services/upstream/responses-compat.js";
import { chat as antigravity } from "../src/services/upstream/antigravity.js";
import { publicErrorDiagnostics } from "../src/services/upstream/error-diagnostics.js";
import { publicRunError } from "../src/services/upstream/public-error.js";

const secret = "fixture-channel-secret";
const channel = { id: 81501, type: "custom", api_key: secret, base_url: "http://127.0.0.1:48151/v1", other: {
  allow_private_upstream: true, access_token: secret, expires_at: Math.floor(Date.now() / 1000) + 3600, project_id: "fixture-project",
} };
const args = { channel, endpoint: "http://127.0.0.1:48151/v1/responses", model: "fixture-model", prompt: "fixture question", messages: [{ role: "user", content: "fixture question" }] };
const payload = { error: { code: "INVALID_ARGUMENT", type: "invalid_request_error", message: `Unknown name additionalProperties in tools. ${secret}` } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (frames, tail = "") => new Response(frames.map(body => `data: ${JSON.stringify(body)}\n\n`).join("") + tail, { headers: { "content-type": "text/event-stream" } });

test("四种实际适配器捕获 HTTP 拒绝、JSON 错误和尾帧 SSE 错误", async (t) => {
  const fetch = globalThis.fetch;
  try {
    for (const [name, chat] of Object.entries({ openai, anthropic, responses, antigravity })) {
      for (const mode of ["http", "json", "sse-tail"]) await t.test(`${name} ${mode}`, async () => {
        globalThis.fetch = async () => mode === "http" ? json(payload, 400) : mode === "json" ? json(payload) : sse([], `data: ${JSON.stringify({ type: "error", ...payload })}`);
        await assert.rejects(chat(args), error => {
          assert.notEqual(error.code, "CHANNEL_EMPTY", "上游显式错误不能退化为空回答");
          const detail = publicErrorDiagnostics(error);
          assert.equal(detail.http_status, mode === "http" ? 400 : 200);
          assert.match(detail.upstream_response.error.message, /additionalProperties/);
          assert.ok(!JSON.stringify(detail).includes(secret));
          assert.ok(!error.message.includes(secret));
          return true;
        });
      });
    }
  } finally { globalThis.fetch = fetch; }
});

test("流中失败保留已输出正文与真实用量，诊断捕获不能抹去费用依据", async (t) => {
  const fetch = globalThis.fetch;
  const fixtures = {
    openai: [openai, [{ choices: [{ delta: { content: "partial answer" } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }]],
    anthropic: [anthropic, [{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 2 } } }, { type: "content_block_delta", delta: { type: "text_delta", text: "partial answer" } }]],
    responses: [responses, [{ type: "response.output_text.delta", delta: "partial answer" }, { type: "response.failed", response: { status: "failed", usage: { input_tokens: 10, output_tokens: 2 }, ...payload } }]],
    antigravity: [antigravity, [{ response: { candidates: [{ content: { parts: [{ text: "partial answer" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } } }]],
  };
  try {
    for (const [name, [chat, frames]] of Object.entries(fixtures)) await t.test(name, async () => {
      globalThis.fetch = async () => sse(frames, `data: ${JSON.stringify({ type: "error", ...payload })}`);
      await assert.rejects(chat(args), error => {
        assert.equal(error.content, "partial answer");
        assert.equal(error.usage.prompt_tokens, 10);
        assert.equal(error.usage.completion_tokens, 2);
        assert.equal(error.billable, true);
        assert.ok(publicErrorDiagnostics(error).upstream_response);
        return true;
      });
    });
  } finally { globalThis.fetch = fetch; }
});

test("404 HTTP 和 NOT_FOUND 业务错误有明确中文解释", () => {
  assert.match(publicRunError({ code: "CHANNEL_BAD_REQUEST", httpStatus: 404 }), /未找到请求的接口或模型/);
  assert.match(publicRunError({ code: "CHANNEL_BIZ_ERROR", httpStatus: 200, upstreamErrorCode: "NOT_FOUND" }), /未找到请求的接口或模型/);
  assert.match(publicRunError({ code: "CHANNEL_BIZ_ERROR", httpStatus: 200, upstreamErrorCode: "INVALID_ARGUMENT" }), /拒绝了请求参数/);
});
