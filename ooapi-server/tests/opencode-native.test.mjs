// 实际 HTTP 验证 Zen 原生端点、请求语义、流式结果及错误用量；只用本地受控上游。
import http from "node:http";
import assert from "node:assert/strict";
import * as adapter from "../src/services/upstream/opencode.js";
import { publicRunError } from "../src/services/upstream/public-error.js";

let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`  ✓ ${name}`); };
let mode = "sse", seen = [];
const usage = { input_tokens: 296, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } };
const output = [{ type: "message", content: [{ type: "output_text", text: "你好" }] }];
const event = (res, value, tail = false) => res.write(`data: ${JSON.stringify(value)}${tail ? "" : "\n\n"}`);
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
  if (mode === "reject") {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "OpenCode's free tier can only be used from within OpenCode" } }));
  }
  if (mode === "invalid") { res.writeHead(200, { "content-type": "application/json" }); return res.end("broken json"); }
  if (mode === "json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ model: "muse-spark-1.3", status: "completed", output, usage }));
  }
  if (mode === "max") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ model: "muse-spark-1.3", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output, usage }));
  }
  if (mode === "systemone") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ model: "jev-1.13.0", answers: {
      urgent: { type: "noul", noul: .95 }, low: { type: "noul", noul: .05 },
      team: { type: "choice", choice: "billing", confidence: .88 },
      mood: { type: "score", score: 1.05, confidence: .92 },
    }, usage }));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (mode === "compat") {
    event(res, { choices: [{ delta: { content: "compat" }, finish_reason: "stop" }] });
    return res.end("data: [DONE]\n\n");
  }
  event(res, { type: "response.reasoning_summary_text.delta", delta: "思考" });
  event(res, { type: "response.output_text.delta", delta: "你" });
  if (mode === "abort") return;
  if (mode === "truncated") return res.end();
  if (mode === "ssefail") {
    event(res, { type: "response.failed", response: { model: "muse-spark-1.3", usage, error: { message: "fixture failure" } } });
    return res.end();
  }
  event(res, { type: "response.output_text.delta", delta: "好" });
  event(res, { type: "response.completed", response: { model: "muse-spark-1.3", status: "completed", output, usage } }, mode === "tail");
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/zen/v1`;
const channel = { id: 99123, type: "opencode", base_url: base, api_key: "fixture-native-key", models: "muse-spark-1.2-contributor-free,muse-spark-1.3-contributor-free,jev-1.13-free,jev-1.13,mimo-v2.6-free", other: { method: "api", allow_private_upstream: true } };
const chat = (model = "muse-spark-1.3-contributor-free", extra = {}) => adapter.chat({ channel, model, prompt: "说明这次判断", ...extra });
const assertHeaders = (request, auth = "Bearer fixture-native-key") => {
  assert.equal(request.headers.authorization, auth);
  assert.equal(request.headers["x-opencode-client"], "cli");
  assert.match(request.headers["x-opencode-session"], /^ses_/);
  assert.match(request.headers["x-opencode-request"], /^msg_/);
  assert.equal(request.headers["x-opencode-session"], request.headers["x-opencode-session-id"]);
};
const FREE_TOOLS = ["bash", "edit", "glob", "grep", "read"];
const structured = { state: { ticket: "我的付款失败了" }, questions: {
  urgent: { type: "noul", instructions: "需要紧急处理吗？" },
  team: { type: "choice", instructions: "归哪个团队？", criteria: { billing: "付款", support: "技术" } },
  mood: { type: "score", instructions: "用户有多生气？", criteria: ["平静", "不满", "生气"] },
} };
try {
  await test("模型管理的统一输出上限与推理映射下发到 Responses", async () => {
    mode = "sse"; seen = [];
    const result = await chat(undefined, {maxOutputTokens: 1024, reasoningConfig: {level:"low",parameter:"reasoning_effort",value:"low"}});
    assert.equal(seen[0].body.max_output_tokens, 1024);
    assert.equal(seen[0].body.reasoning.effort, "low");
    assert.equal(result.reasoningApplied, true);
  });
  await test("Muse Spark SSE 使用 Responses 输入并保留角色、图片与系统指令", async () => {
    mode = "sse"; seen = []; const deltas = [], reasoning = [], usages = [];
    const result = await chat(undefined, { messages: [
      { role: "system", content: "system fixture" }, { role: "assistant", content: "previous" },
      { role: "user", content: [{ type: "text", text: "user fixture" }] },
    ], images: [{ mimeType: "image/png", buffer: Buffer.from("fixture-image") }], onDelta: (x) => deltas.push(x), onReasoning: (x) => reasoning.push(x), onUsage: (x) => usages.push(x) });
    const request = seen[0]; assertHeaders(request, "Bearer public");
    assert.equal(request.url, "/zen/v1/responses"); assert.equal(request.body.model, "muse-spark-1.3-contributor-free");
    // 免费档请求体必须是 agent 形态：Responses 工具为顶层扁平结构，只看名字
    assert.deepEqual(FREE_TOOLS.filter((n) => (request.body.tools || []).some((t) => t?.name === n)), FREE_TOOLS);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.instructions, "system fixture"); assert.equal(request.body.input[0].content[0].type, "output_text");
    assert.equal(request.body.input[1].content[0].text, "user fixture"); assert.match(request.body.input[1].content[1].image_url, /^data:image\/png;base64,/);
    assert.equal(request.body.messages, undefined); assert.equal(request.body.stream_options, undefined);
    assert.equal(result.content, "你好"); assert.equal(deltas.join(""), "你好"); assert.equal(reasoning.join(""), "思考");
    assert.deepEqual(result.usage, { prompt_tokens: 296, completion_tokens: 20, cached_tokens: 80 }); assert.ok(usages.length);
    assert.equal(result.upstreamModel, "muse-spark-1.3"); assert.equal(seen.length, 1);
  });
  await test("旧 Contributor 与完整端点、非流式 Responses 都正确转换", async () => {
    mode = "json"; seen = [];
    const result = await chat("muse-spark-1.2-contributor-free", { channel: { ...channel, base_url: `${base}/chat/completions` } });
    assert.equal(seen[0].url, "/zen/v1/responses"); assert.equal(seen[0].body.model, "muse-spark-1.2-contributor-free"); assert.equal(result.content, "你好");
    assert.equal(result.usage.completion_tokens, 20);
  });
  await test("没有末尾空行的完成事件仍被读取", async () => { mode = "tail"; const result = await chat(); assert.equal(result.content, "你好"); assert.equal(result.usage.prompt_tokens, 296); });
  await test("Responses 标准限额与采样推理参数转发，正常上限截断不当生成失败", async () => {
    mode = "max"; seen = [];
    const result = await chat(undefined, { max_tokens: 17, temperature: .7, top_p: .9, reasoning: { effort: "low", summary: "auto" } });
    assert.equal(seen[0].body.max_output_tokens, 17); assert.equal(seen[0].body.max_tokens, undefined);
    assert.equal(seen[0].body.temperature, .7); assert.equal(seen[0].body.top_p, .9); assert.deepEqual(seen[0].body.reasoning, { effort: "low", summary: "auto" });
    assert.equal(result.content, "你好"); assert.equal(result.truncated, true); assert.equal(result.finishReason, "length");
  });
  await test("SSE 已产生正文的错误保留部分内容、思考和实际用量", async () => {
    mode = "ssefail"; seen = []; const usages = [];
    await assert.rejects(chat(undefined, { onUsage: (u) => usages.push(u) }), (e) => e.code === "CHANNEL_STREAM_ERROR" && e.content === "你" && e.reasoning === "思考" && e.billable === true && e.usage.completion_tokens === 20);
    assert.equal(seen.length, 1); assert.ok(usages.length);
  });
  await test("提前断流不当成功，保留已输出内容", async () => {
    mode = "truncated"; await assert.rejects(chat(), (e) => e.code === "CHANNEL_STREAM_ERROR" && e.content === "你" && e.billable === true);
  });
  await test("主动取消保留已输出正文", async () => {
    mode = "abort"; const ac = new AbortController();
    await assert.rejects(chat(undefined, { signal: ac.signal, onDelta: () => ac.abort() }), (e) => e.code === "CHANNEL_ABORTED" && e.content === "你");
  });
  await test("HTTP403 免费限制不重试、不错误收费、不当 Key 失效", async () => {
    mode = "reject"; seen = [];
    await assert.rejects(chat(), (e) => e.code === "CHANNEL_FORBIDDEN" && e.status === 403 && e.billable === false && e.upstreamRejected === true);
    assert.equal(seen.length, 1);
  });
  await test("非 JSON 返回明确报错", async () => { mode = "invalid"; await assert.rejects(chat(), (e) => e.code === "CHANNEL_BAD_RESPONSE" && !e.billable); });
  await test("Jev 原生问题映射、判断概率和实际输出 token 正确保留", async () => {
    mode = "systemone"; seen = []; const deltas = [];
    const result = await chat("jev-1.13-free", { prompt: JSON.stringify(structured), onDelta: (x) => deltas.push(x) });
    const request = seen[0]; assertHeaders(request, "Bearer public"); assert.equal(request.url, "/zen/v1/systemone");
    // SystemOne 是结构化判定请求而非 agent 流量：免费档只换匿名凭据，请求体保持原样
    assert.deepEqual(request.body.state, structured.state); assert.deepEqual(request.body.questions, structured.questions); assert.equal(request.body.stream, undefined);
    assert.equal(request.body.tools, undefined);
    assert.match(result.content, /urgent: 是（95.0%）/); assert.match(result.content, /low: 否（5.0%）/); assert.match(result.content, /team: billing/);
    assert.equal(result.structured.answers.urgent.noul, .95); assert.equal(result.usage.completion_tokens, 20); assert.equal(deltas.join(""), result.content);
    assert.equal(result.upstreamModel, "jev-1.13.0");
  });
  await test("Jev 普通聊天明确提示能力，不向错误端点请求或收费", async () => {
    mode = "systemone"; seen = [];
    await assert.rejects(chat("jev-1.13-free"), (e) => e.code === "CHANNEL_BAD_REQUEST" && e.upstreamStarted === false && e.billable === false && /结构化判断/.test(publicRunError(e)));
    assert.equal(seen.length, 0);
  });
  await test("Jev 问题边界提前拒绝，用户 JSON 数组不发错协议", async () => {
    seen = [];
    for (const prompt of ["[]", JSON.stringify({ state: "x", questions: { q: { type: "score", instructions: "x", criteria: ["only one"] } } }), JSON.stringify({ state: "x", questions: { q: { type: "choice", instructions: "x", criteria: {} } } })]) {
      await assert.rejects(chat("jev-1.13", { prompt }), (e) => e.upstreamStarted === false && e.capability === "systemone");
    }
    assert.equal(seen.length, 0);
  });
  await test("Jev HTTP403 也保留实际权限分类", async () => {
    mode = "reject"; seen = [];
    await assert.rejects(chat("jev-1.13-free", { prompt: JSON.stringify(structured) }), (e) => e.code === "CHANNEL_FORBIDDEN" && !e.billable);
    assert.equal(seen[0].url, "/zen/v1/systemone");
  });
  await test("其他 Zen 模型及 GO 请求继续兼容端点", async () => {
    mode = "compat"; seen = [];
    assert.equal((await chat("mimo-v2.6-free")).content, "compat");
    assert.equal((await chat(undefined, { channel: { ...channel, other: { ...channel.other, method: "go" } } })).content, "compat");
    assert.equal(seen[0].url, "/zen/v1/chat/completions"); assert.equal(seen[1].url, "/zen/v1/chat/completions");
    // Zen 免费档（mimo-v2.6-free）走匿名凭据 + 核心工具；GO 订阅保持 keyed 原样
    assert.equal(seen[0].headers.authorization, "Bearer public");
    assert.deepEqual(FREE_TOOLS.filter((n) => (seen[0].body.tools || []).some((t) => t?.function?.name === n)), FREE_TOOLS);
    assert.equal(seen[1].headers.authorization, "Bearer fixture-native-key");
    assert.equal(seen[1].body.tools, undefined);
    assert.equal(seen[1].headers["user-agent"], "OOAPI-Gateway/1.0");
  });
  await test("原生端点仍有公网 SSRF 检查", async () => {
    mode = "json"; seen = [];
    await assert.rejects(chat(undefined, { channel: { ...channel, other: { method: "api" } } }));
    assert.equal(seen.length, 0);
  });
  console.log(`OpenCode 原生协议 ${passed}/${passed} 通过`);
} finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
