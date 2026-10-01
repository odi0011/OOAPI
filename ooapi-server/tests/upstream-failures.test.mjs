// 真 HTTP + 两个真实协议适配器；全部仅环回、虚构上游与内存用量，不访问客户数据库。
import assert from "node:assert/strict";
import http from "node:http";
import * as openai from "../src/services/upstream/openai-compat.js";
import * as anthropic from "../src/services/upstream/anthropic-compat.js";
import { normalizeUsage } from "../src/services/pricing.js";

let scenario;
let requests = 0;
const server = http.createServer((req, res) => {
  req.resume();
  requests += 1;
  scenario(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const channel = { id: 1, type: "openai", base_url: base, api_key: "fixture-only", other: { method: "api", allow_private_upstream: true } };
const frame = (ev) => `data: ${JSON.stringify(ev)}\n\n`;
const delta = (content) => ({ choices: [{ delta: { content } }] });
const thought = (reasoning) => ({ choices: [{ delta: { reasoning_content: reasoning } }] });
const usage = { prompt_tokens: 17, completion_tokens: 3, cached_tokens: 5 };
const fail = { error: { message: "fixture upstream failed", code: "fixture_error" } };
const start = (input = 17, cache = 5) => ({ type: "message_start", message: { model: "fixture-model", usage: { input_tokens: input, cache_read_input_tokens: cache } } });
const text = (value) => ({ type: "content_block_delta", delta: { type: "text_delta", text: value } });
const thinking = (value) => ({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: value } });
const afail = { type: "error", error: { type: "fixture_error", message: "fixture upstream failed" } };
const stream = (frames) => {
  scenario = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(frames); };
  requests = 0;
};
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };
const run = (adapter, extra = {}) => adapter.chat({ channel, model: "fixture-model", prompt: "fixture input", ...extra });
const reject = async (adapter, expected, extra = {}) => {
  let error;
  await assert.rejects(() => run(adapter, extra), (e) => { error = e; return true; });
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(error[key], value, key);
  return error;
};

try {
  for (const [name, adapter] of [["OpenAI", openai], ["Anthropic", anthropic]]) {
    for (const status of [400, 401, 429, 502]) {
      await test(`${name} HTTP ${status} 真实拒绝保留状态且零收费`, async () => {
        requests = 0;
        scenario = (_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(fail)); };
        const e = await reject(adapter, { status, billable: false, upstreamRejected: true });
        assert.equal(normalizeUsage(e.usage).totalTokens, 0);
        assert.equal(requests, name === "OpenAI" && status === 502 ? 3 : 1);
        if (name === "OpenAI") assert.equal(e.retryCount, status === 502 ? 2 : 0);
      });
    }
  }
  await test("OpenAI SSE error 首包拒绝不能被忽略为成功", async () => {
    stream(frame(fail));
    await reject(openai, { code: "CHANNEL_BIZ_ERROR", status: 200, content: "", billable: false, upstreamErrorCode: "fixture_error" });
    assert.equal(requests, 1);
  });
  await test("OpenAI SSE 部分正文/推理/真实usage后报错均完整保留", async () => {
    stream(frame(delta("PARTIAL")) + frame(thought("THINK")) + frame({ usage }) + frame(fail));
    const seen = [];
    const e = await reject(openai, { content: "PARTIAL", reasoning: "THINK", usage: { ...usage, total_tokens: 0 }, billable: true }, { onUsage: (u) => seen.push(u) });
    assert.equal(e.code, "CHANNEL_BIZ_ERROR");
    assert.equal(seen.length, 1);
    assert.equal(requests, 1);
  });
  for (const tokens of [0, 17]) {
    await test(`OpenAI 仅usage=${tokens}后错误按实际用量判断`, async () => {
      stream(frame({ usage: { prompt_tokens: tokens, completion_tokens: 0 } }) + frame(fail));
      const e = await reject(openai, { content: "", billable: tokens > 0 });
      assert.equal(e.usage.prompt_tokens, tokens);
      assert.equal(requests, 1);
    });
  }
  for (const content of ["", "PARTIAL"]) {
    await test(`OpenAI ${content ? "部分回复" : "零输出"}缺结束帧不能假成功`, async () => {
      stream(content ? frame(delta(content)) : "");
      await reject(openai, { code: "CHANNEL_STREAM_ERROR", content, billable: Boolean(content) });
    });
  }
  await test("OpenAI 标准DONE成功并保留usage", async () => {
    stream(frame(delta("OK")) + frame({ usage }) + "data: [DONE]\n\n");
    const r = await run(openai);
    assert.equal(r.content, "OK"); assert.equal(r.usage.prompt_tokens, 17); assert.equal(r.httpStatus, 200);
  });
  await test("OpenAI finish_reason也是真实终止帧", async () => {
    stream(frame(delta("OK")) + frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    assert.equal((await run(openai)).content, "OK");
  });
  await test("OpenAI 推理单独产出失败但不丢用量", async () => {
    stream(frame(thought("THINK")) + frame({ usage }) + "data: [DONE]\n\n");
    await reject(openai, { code: "CHANNEL_EMPTY", content: "", reasoning: "THINK", billable: true });
  });
  await test("OpenAI 200 JSON error保留真实usage且不收费错误描述", async () => {
    scenario = (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...fail, usage })); };
    const e = await reject(openai, { code: "CHANNEL_BIZ_ERROR", billable: true, status: 200 });
    assert.equal(e.usage.completion_tokens, 3);
    assert.equal(e.content, undefined);
  });
  await test("OpenAI 局部网络断开保留增量而非成功", async () => {
    scenario = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame(delta("PARTIAL"))); setTimeout(() => res.destroy(), 20); };
    await reject(openai, { code: "CHANNEL_STREAM_ERROR", content: "PARTIAL", billable: true });
  });
  await test("OpenAI 用户停止保留最新usage和输出", async () => {
    scenario = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ usage }) + frame(delta("PARTIAL"))); };
    const ctrl = new AbortController();
    await reject(openai, { code: "CHANNEL_ABORTED", content: "PARTIAL", billable: true }, { signal: ctrl.signal, onDelta: () => ctrl.abort() });
  });
  await test("Anthropic 首包error零消费", async () => {
    stream(frame(afail));
    await reject(anthropic, { code: "CHANNEL_BIZ_ERROR", status: 200, content: "", billable: false });
  });
  await test("Anthropic message_start真实输入和缓存即刻可结算", async () => {
    stream(frame(start()) + frame(afail));
    const seen = [];
    const e = await reject(anthropic, { content: "", billable: true }, { onUsage: (u) => seen.push(u) });
    assert.equal(e.usage.prompt_tokens, 22); assert.equal(e.usage.cached_tokens, 5); assert.equal(seen.length, 1);
  });
  await test("Anthropic message_start零usage不收费", async () => {
    stream(frame(start(0, 0)) + frame(afail));
    await reject(anthropic, { billable: false });
  });
  await test("Anthropic 部分正文推理后error保留真实用量", async () => {
    stream(frame(start()) + frame(text("PARTIAL")) + frame(thinking("THINK")) + frame(afail));
    const e = await reject(anthropic, { content: "PARTIAL", reasoning: "THINK", billable: true });
    assert.equal(e.usage.prompt_tokens, 22);
  });
  for (const content of ["", "PARTIAL"]) {
    await test(`Anthropic ${content ? "部分回复" : "零输出"}缺message_stop不能成功`, async () => {
      stream(content ? frame(text(content)) : "");
      await reject(anthropic, { code: "CHANNEL_STREAM_ERROR", content, billable: Boolean(content) });
    });
  }
  await test("Anthropic message_stop尾行无换行可成功且推理不重复成正文", async () => {
    stream(frame(start()) + frame(thinking("THINK")) + frame(text("OK")) + frame({ type: "message_delta", usage: { output_tokens: 3 } }) + `data: ${JSON.stringify({ type: "message_stop" })}`);
    const r = await run(anthropic);
    assert.equal(r.content, "OK"); assert.equal(r.reasoning, "THINK"); assert.equal(r.usage.completion_tokens, 3); assert.equal(r.httpStatus, 200);
  });
  await test("Anthropic 推理单独产出不得当正文重复收费", async () => {
    stream(frame(start()) + frame(thinking("THINK")) + frame({ type: "message_stop" }));
    await reject(anthropic, { code: "CHANNEL_EMPTY", content: "", reasoning: "THINK", billable: true });
  });
  await test("Anthropic message_start后停止保留输入usage", async () => {
    scenario = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame(start())); };
    const ctrl = new AbortController();
    const e = await reject(anthropic, { code: "CHANNEL_ABORTED", content: "", billable: true }, { signal: ctrl.signal, onUsage: () => ctrl.abort() });
    assert.equal(e.usage.prompt_tokens, 22);
  });
  for (const [name, adapter, measured] of [["OpenAI", openai, usage], ["Anthropic", anthropic, { input_tokens: 17, output_tokens: 3 }]]) {
    await test(`${name} HTTP错误附真实usage不丢失也不自动重复调用`, async () => {
      requests = 0;
      scenario = (_req, res) => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ ...fail, usage: measured })); };
      const e = await reject(adapter, { status: 502, billable: true });
      assert.equal(e.usage.prompt_tokens, 17); assert.equal(e.usage.completion_tokens, 3); assert.equal(requests, 1);
    });
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`  上游真实 HTTP 故障回归 ${passed} 项通过`);
