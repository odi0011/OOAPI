import test from "node:test";
import assert from "node:assert/strict";
import { prepareResponseCompaction, sealCompaction, openCompaction, compactionProtocol } from "../src/services/response-compaction.js";
import { PROTOCOLS } from "../src/services/gateway-protocols.js";
import { keyBillingInfo } from "../src/services/key-billing.js";
import { endpointPath } from "../src/services/endpoint-audit.js";
import http from "node:http";
import { chatOnce as chatCompletion } from "../src/services/upstream/openai-compat.js";
import { chatOnce as anthropicCompletion } from "../src/services/upstream/anthropic-compat.js";

const context = { secret: "fixture-only-compaction-secret", auth: { user: { id: 7 }, token: { id: 9, group_name: "fixture" } } };
const trigger = { type: "compaction_trigger" };
const history = [{ role: "user", content: "Keep file audit.js unchanged; the project code is orchard-726." },
  { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"audit.js"}' },
  { type: "function_call_output", call_id: "c1", output: "Found two pending checks." }];

test("Sub2API 原样探测请求进入摘要流程，不丢 compaction_trigger 后调用普通对话", () => {
  const original = { model: "gemini-3.5-flash", instructions: "You are a helpful coding assistant.", input: [{ type: "message", role: "user", content: "Respond with OK." }, trigger], stream: true };
  const prepared = prepareResponseCompaction(original, context);
  assert(prepared.compact); assert(prepared.body.stream);
  const parsed = PROTOCOLS.responses.parse(prepared.body);
  assert.match(parsed.messages[0].content, /Do not answer the last user message/);
  assert.match(parsed.messages[1].content, /Respond with OK/);
  assert.deepEqual(parsed.tools, []);
  assert.deepEqual(original.input.at(-1), trigger, "不修改原始入站请求");
});

test("完整历史、约束、工具调用/结果保留为数据，压缩操作不执行工具", () => {
  const prepared = prepareResponseCompaction({ model: "fixture", input: [...history, trigger], instructions: "Never change files", tools: [{ type: "function", name: "read_file" }] }, context);
  const parsed = PROTOCOLS.responses.parse(prepared.body);
  for (const value of ["orchard-726", "audit.js", "c1", "read_file", "Found two pending checks", "Never change files"]) assert(parsed.messages[1].content.includes(value));
  assert.deepEqual(prepared.body.tools, []); assert.equal(prepared.body.thinking, false);
});

test("无触发器的普通请求保持正常；裸解析器拒绝未经处理的压缩项", () => {
  const plain = { model: "fixture", input: "hello", stream: true };
  assert.equal(prepareResponseCompaction(plain, context).body, plain);
  assert.throws(() => PROTOCOLS.responses.parse({ input: [...history, trigger] }), /压缩/);
  assert.throws(() => PROTOCOLS.responses.parse({ input: [{ type: "compaction", encrypted_content: "opaque" }] }), /压缩/);
});

test("加密摘要能跨请求恢复，新的指令与问题仍保留，输出密文不带明文摘要", () => {
  const summary = "Project orchard-726. Do not change audit.js. Two checks remain.";
  const item = sealCompaction(summary, context);
  assert(!item.encrypted_content.includes(summary));
  assert.notEqual(item.encrypted_content, sealCompaction(summary, context).encrypted_content);
  const next = prepareResponseCompaction({ instructions: "Answer in Chinese", input: [item, { role: "user", content: "Continue" }] }, context);
  assert(!next.compact);
  const messages = PROTOCOLS.responses.parse(next.body).messages;
  assert.equal(messages[0].content, "Answer in Chinese");
  assert.equal(messages[1].role, "user", "Anthropic 等渠道不能丢掉开头的历史摘要");
  assert(messages[1].content.includes(summary)); assert.equal(messages.at(-1).content, "Continue");
  const again = prepareResponseCompaction({ input: [item, ...history, trigger] }, context);
  assert(again.compact); assert(JSON.stringify(again.body).includes(summary));
});

test("跨账号/密钥/分组、换服务器密钥及密文篡改均失败，不能丢失历史后继续回答", () => {
  const item = sealCompaction("fixture private context", context);
  for (const changed of [
    { ...context, secret: "different-site-fixture" },
    { ...context, auth: { ...context.auth, user: { id: 8 } } },
    ...[{ id: 10, group_name: "fixture" }, { id: 9, group_name: "other" }].map(token => ({ ...context, auth: { ...context.auth, token } })),
  ]) assert.throws(() => openCompaction(item, changed), e => e.code === "invalid_compaction");
  const pos = item.encrypted_content.length - 12;
  const corrupted = { ...item, encrypted_content: item.encrypted_content.slice(0, pos) + (item.encrypted_content[pos] === "A" ? "B" : "A") + item.encrypted_content.slice(pos + 1) };
  assert.throws(() => openCompaction(corrupted, context), e => e.code === "invalid_compaction");
  assert.throws(() => openCompaction({ encrypted_content: "foreign-opaque" }, context), e => e.code === "unsupported_compaction");
  assert.throws(() => openCompaction({ encrypted_content: "ooapi.compact.v1." + "a".repeat(1024 * 1024 + 1) }, context), e => e.code === "invalid_compaction");
  assert.throws(() => sealCompaction(" ", context), e => e.code === "CONTEXT_COMPACTION_FAILED");
});

test("触发器顺序、空历史、服务端引用、未支持附件与旧端点 stream 均明确拒绝", () => {
  for (const input of [[trigger], [trigger, ...history], [...history, trigger, trigger]]) assert.throws(() => prepareResponseCompaction({ input }, context));
  for (const field of ["previous_response_id", "conversation"]) assert.throws(() => prepareResponseCompaction({ input: [...history, trigger], [field]: "id-fixture" }, context), e => e.code === "unsupported_compaction");
  assert.throws(() => prepareResponseCompaction({ input: [{ type: "item_reference", id: "id-fixture" }, ...history, trigger] }, context), e => e.code === "unsupported_compaction");
  for (const type of ["input_file", "input_audio", "input_video"]) assert.throws(() => prepareResponseCompaction({ input: [{ role: "user", content: [{ type }] }, trigger] }, context), e => e.code === "unsupported_compaction");
  assert.throws(() => prepareResponseCompaction({ input: "hi", stream: true }, context, { legacy: true }));
});

test("图片从历史 JSON 抽出为真实多模态分片，不把 base64 当摘要文字", () => {
  const url = "data:image/png;base64,fixture";
  const prepared = prepareResponseCompaction({ input: [{ role: "user", content: [{ type: "input_text", text: "See image" }, { type: "input_image", image_url: url }] }, trigger] }, context);
  const content = prepared.body.input[0].content;
  assert(!content[0].text.includes(url)); assert.equal(content[1].image_url, url);
  assert(PROTOCOLS.responses.parse(prepared.body).messages[1].content.some(p => p.type === "image_url"));
});

const settled = { promptTokens: 30, completionTokens: 8, cacheTokens: 4, od: 0.001, currency: "OD", elapsed: 1 };
const fakeRes = () => ({ chunks: [], status() { return this; }, setHeader() {}, flushHeaders() {}, write(s) { this.chunks.push(s); }, end() {}, json(body) { this.body = body; } });
test("v2 SSE 只输出完整 compaction 项；added/done/completed 的编号和内容一致", () => {
  const res = fakeRes(), protocol = compactionProtocol(PROTOCOLS.responses), state = protocol.openStream(res, "resp-fixture", "fixture");
  protocol.delta(state, "PRIVATE SUMMARY"); protocol.reasoning(state, "PRIVATE THOUGHT");
  const item = sealCompaction("Project orchard-726", context);
  protocol.done(res, state, { settled, compactionItem: item });
  const raw = res.chunks.join(""); assert(!raw.includes("PRIVATE"));
  const events = raw.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  const added = events.find(e => e.type === "response.output_item.added").item;
  assert.equal(added.type, "compaction"); assert(added.encrypted_content);
  assert.equal(events.find(e => e.type === "response.compaction.compacting").item_id, added.id);
  assert.deepEqual(events.find(e => e.type === "response.output_item.done").item, added);
  assert.deepEqual(events.at(-1).response.output, [added]); assert.equal(events.at(-1).response.usage.total_tokens, 38);
});

test("v2 JSON 与旧 compact 端点返回可恢复的压缩项，保留用量并声明实现方式", () => {
  for (const legacy of [true, false]) {
    const res = fakeRes(), protocol = compactionProtocol(PROTOCOLS.responses, { legacy });
    protocol.finish(res, { id: "resp-fixture", model: "fixture", content: "PRIVATE SUMMARY", compactionItem: sealCompaction("Remember orchard-726", context), settled });
    assert.equal(res.body.object, legacy ? "response.compaction" : "response");
    assert.equal(res.body.x_compaction_mode, "gateway_summary"); assert.equal(res.body.usage.total_tokens, 38);
    assert.equal(res.body.output.length, 1); assert(openCompaction(res.body.output[0], context).content.includes("orchard-726"));
  }
});

test("通用倍率与 Sub2API schema 数值一致，清楚区分分组倍率与模型价格", () => {
  for (const rate of [0.0001, 0.01, 1, 12.5]) for (const compatibility of [true, false]) {
    const response = keyBillingInfo("fixture", rate, { compatibility });
    assert.equal(response.object, compatibility ? "sub2api.key_billing" : "ooapi.key_billing");
    assert.equal(response.schema_version, 1); assert.equal(response.billing_scope, "token");
    assert.equal(response.group_rate_multiplier, rate); assert.equal(response.resolved_rate_multiplier, rate); assert.equal(response.effective_rate_multiplier, rate);
    assert.equal(response.peak_rate_enabled, false); assert.equal(response.rate_basis, "platform_model_price");
    assert(Number.isFinite(Date.parse(response.observed_at)));
    assert(!JSON.stringify(response).includes("key_str"));
  }
  for (const rate of [NaN, Infinity, -1]) assert.throws(() => keyBillingInfo("fixture", rate));
});

test("Chat/Anthropic 的 JSON 与 SSE 截断标记不丢失，恢复历史跨协议仍保留", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    seen.push(JSON.parse(raw));
    const anthropic = req.url.includes("anthropic"), stream = req.url.includes("stream");
    res.setHeader("content-type", stream ? "text/event-stream" : "application/json");
    if (!stream) return res.end(JSON.stringify(anthropic
      ? { model: "fixture", content: [{ type: "text", text: "partial summary" }], stop_reason: "max_tokens", usage: { input_tokens: 2, output_tokens: 1 } }
      : { model: "fixture", choices: [{ message: { content: "partial summary" }, finish_reason: "length" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    const events = anthropic
      ? [{ type: "message_start", message: { usage: { input_tokens: 2 } } }, { type: "content_block_delta", delta: { type: "text_delta", text: "partial summary" } }, { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]
      : [{ choices: [{ delta: { content: "partial summary" } }] }, { choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const summary = openCompaction(sealCompaction("Remember orchard-726", context), context);
    for (const [name, call] of [["chat", chatCompletion], ["anthropic", anthropicCompletion]]) for (const mode of ["json", "stream"]) {
      const endpoint = `http://127.0.0.1:${server.address().port}/${name}/${mode}`;
      const result = await call({ endpoint, channel: { id: 9999, type: "openai", api_key: "fixture", base_url: endpoint, other: { allow_private_upstream: true } }, model: "fixture", prompt: "fixture", messages: [summary, { role: "user", content: "Continue" }], tools: [] });
      assert.equal(result.truncated, true, `${name}/${mode}`);
      assert(JSON.stringify(seen.at(-1).messages).includes("orchard-726"));
    }
    for (const prefix of ["", "/v1", "/api/v1"]) assert.equal(endpointPath(prefix + "/responses/compact?key=fixture"), prefix + "/responses/compact");
  } finally { await new Promise(r => server.close(r)); }
});
