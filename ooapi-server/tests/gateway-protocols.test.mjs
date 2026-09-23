// 三协议网关单测：请求解析 + 响应渲染。
// 不起 HTTP 服务，直接测协议对象 —— 它俩是纯函数，能覆盖最易错的字段映射。
import { PROTOCOLS } from "../src/services/gateway-protocols.js";

let pass = 0;
let fail = 0;
const ck = (n, c, e = "") => {
  if (c) { pass += 1; console.log(`  ok   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${e}`); }
};

/** 极简 res 替身：记录 status/headers/json/写出的 SSE 文本 */
function fakeRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: null,
    chunks: [],
    ended: false,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    flushHeaders() { this.headersSent = true; },
    json(o) { this.body = o; this.headersSent = true; return this; },
    write(t) { this.chunks.push(t); this.headersSent = true; return true; },
    end() { this.ended = true; return this; },
  };
  return r;
}
const sseData = (res) =>
  res.chunks
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => {
      try { return JSON.parse(l.slice(6)); } catch { return null; }
    })
    .filter(Boolean);
const sseEvents = (res) =>
  res.chunks.join("").split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7).trim());

/* ==================== ① 请求解析 ==================== */
console.log("=== ① 请求解析 ===");
{
  const a = PROTOCOLS.chat.parse({ model: "m1", messages: [{ role: "user", content: "hi" }], stream: true });
  ck("chat：读取 messages/stream", a.model === "m1" && a.messages.length === 1 && a.stream === true);

  // Anthropic：system 在顶层，不在 messages 里
  const b = PROTOCOLS.messages.parse({
    model: "m2",
    system: "你是助手",
    messages: [{ role: "user", content: "hi" }],
  });
  ck("messages：system 被提到 messages 最前（否则系统指令整段丢失）",
    b.messages[0].role === "system" && b.messages[0].content === "你是助手", JSON.stringify(b.messages));
  ck("messages：system 数组形态也能读",
    PROTOCOLS.messages.parse({ model: "m", system: [{ type: "text", text: "S" }], messages: [{ role: "user", content: "u" }] })
      .messages[0].content === "S");
  // Anthropic content 支持数组块
  const c = PROTOCOLS.messages.parse({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "块文本" }] }] });
  ck("messages：content 数组块被压成文本", c.messages[0].content === "块文本", JSON.stringify(c.messages));
  // 图片：**必须作为独立分片保留**。
  // 这条断言原先写的是「变成 [图片] 占位」—— 那是把缺陷当契约锁住了：
  // 拍平之后图片数据丢失（Anthropic SDK 传图静默失效），而且网关的图片数量防护
  // 是按 image_url 计数的，拍平后一张都数不到、防护被绕过。
  // 现在改为：数据走 image_url 分片，文本里不再重复占位。
  const cImg = PROTOCOLS.messages.parse({
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: "T" },
        ],
      },
    ],
  });
  const parts = Array.isArray(cImg.messages[0].content) ? cImg.messages[0].content : [];
  ck("messages：图片块保留为 image_url 分片（不再被拍平丢弃）",
    parts.filter((x) => x.type === "image_url").length === 1, JSON.stringify(cImg.messages));
  ck("messages：文本片里不再重复写 [图片] 占位",
    parts.some((x) => x.type === "text" && x.text === "T") && !JSON.stringify(cImg.messages).includes("[图片]"),
    JSON.stringify(cImg.messages));

  // Responses：input 可为字符串或数组
  ck("responses：input 字符串 → 一条 user",
    PROTOCOLS.responses.parse({ model: "m", input: "你好" }).messages[0].content === "你好");
  const d = PROTOCOLS.responses.parse({
    model: "m",
    input: [{ role: "user", content: [{ type: "input_text", text: "A" }] }, { role: "assistant", content: "B" }],
  });
  ck("responses：input 数组（含 content 块）解析正确",
    d.messages.length === 2 && d.messages[0].content === "A" && d.messages[1].content === "B",
    JSON.stringify(d.messages));
  ck("responses：缺 input 时返回空数组（由上层报错）",
    PROTOCOLS.responses.parse({ model: "m" }).messages.length === 0);
}

/* ==================== ② 非流式响应形状 ==================== */
console.log("\n=== ② 非流式响应 ===");
const settled = { promptTokens: 10, completionTokens: 5, cacheTokens: 2, od: 0.001, currency: "OD币", channel: "ch1", elapsed: 123 };
{
  const r = fakeRes();
  PROTOCOLS.chat.finish(r, { id: "id1", model: "m", content: "正文", settled });
  ck("chat：object=chat.completion 且有 choices[0].message",
    r.body.object === "chat.completion" && r.body.choices[0].message.content === "正文");
  ck("chat：usage 三件套齐全",
    r.body.usage.prompt_tokens === 10 && r.body.usage.completion_tokens === 5 && r.body.usage.total_tokens === 15);
  ck("chat：缓存量放 prompt_tokens_details（严格 SDK 会校验 usage 子字段）",
    r.body.usage.prompt_tokens_details.cached_tokens === 2);

  const r2 = fakeRes();
  PROTOCOLS.messages.finish(r2, { id: "id2", model: "m", content: "正文", settled });
  ck("messages：type=message 且 content 是块数组",
    r2.body.type === "message" && r2.body.content[0].type === "text" && r2.body.content[0].text === "正文");
  ck("messages：usage 用 input_tokens/output_tokens（不是 prompt_tokens）",
    r2.body.usage.input_tokens === 10 && r2.body.usage.output_tokens === 5);
  ck("messages：stop_reason=end_turn", r2.body.stop_reason === "end_turn");

  const r3 = fakeRes();
  PROTOCOLS.responses.finish(r3, { id: "id3", model: "m", content: "正文", settled });
  ck("responses：object=response 且 output 里是 message/output_text",
    r3.body.object === "response" && r3.body.output[0].content[0].type === "output_text");
  // finish() 不是纯函数（它把响应写进 res），所以要先构造 res 再断言
  const r4 = fakeRes();
  PROTOCOLS.responses.finish(r4, { id: "x", model: "m", content: "c", reasoning: "想了", settled });
  ck("responses：reasoning 作为独立 output 项", r4.body.output[0].type === "reasoning", JSON.stringify(r4.body.output.map((o) => o.type)));
}

/* ==================== ③ 流式事件 ==================== */
console.log("\n=== ③ 流式事件 ===");
{
  const r = fakeRes();
  const st = PROTOCOLS.chat.openStream(r, "id1", "m");
  PROTOCOLS.chat.delta(st, "你");
  PROTOCOLS.chat.delta(st, "好");
  PROTOCOLS.chat.done(r, st, { settled });
  const d = sseData(r);
  ck("chat：首帧带 role=assistant", d[0].choices[0].delta.role === "assistant");
  const text = d.filter((x) => x.choices?.[0]?.delta?.content).map((x) => x.choices[0].delta.content).join("");
  ck("chat：增量拼接正确", text === "你好", text);
  ck("chat：末帧 finish_reason=stop + [DONE]",
    d[d.length - 1].choices[0].finish_reason === "stop" && r.chunks.join("").includes("[DONE]"));

  const r2 = fakeRes();
  const st2 = PROTOCOLS.messages.openStream(r2, "id2", "m");
  PROTOCOLS.messages.delta(st2, "收到");
  PROTOCOLS.messages.done(r2, st2, { settled });
  const ev = sseEvents(r2);
  ck("messages：事件序列含 message_start / content_block_delta / message_stop",
    ev.includes("message_start") && ev.includes("content_block_delta") && ev.includes("message_stop"), ev.join(","));
  const md = sseData(r2).find((x) => x.type === "content_block_delta");
  ck("messages：delta 结构为 {type:'text_delta',text}", md?.delta?.type === "text_delta" && md.delta.text === "收到");

  const r3 = fakeRes();
  const st3 = PROTOCOLS.responses.openStream(r3, "id3", "m");
  PROTOCOLS.responses.delta(st3, "收到");
  PROTOCOLS.responses.done(r3, st3, { settled });
  const ev3 = sseEvents(r3);
  ck("responses：事件含 response.created / output_text.delta / response.completed",
    ev3.includes("response.created") && ev3.includes("response.output_text.delta") && ev3.includes("response.completed"), ev3.join(","));
  const td = sseData(r3).find((x) => x.type === "response.output_text.delta");
  ck("responses：delta 在 delta 字段", td?.delta === "收到");
}

/* ==================== ④ 错误形状 ==================== */
console.log("\n=== ④ 错误形状 ===");
{
  const err = Object.assign(new Error("上游失败"), { code: "CHANNEL_ERROR" });
  const r = fakeRes();
  PROTOCOLS.chat.error(r, 502, err, { id: "i" });
  ck("chat：错误体 {error:{message,type}}", r.body.error.message === "上游失败" && r.statusCode === 502);

  const r2 = fakeRes();
  PROTOCOLS.messages.error(r2, 400, err, { id: "i" });
  ck("messages：错误体 {type:'error',error:{...}}",
    r2.body.type === "error" && r2.body.error.message === "上游失败", JSON.stringify(r2.body));

  const r3 = fakeRes();
  PROTOCOLS.responses.error(r3, 429, err, { id: "i" });
  ck("responses：错误体 {error:{...}} + 状态码透传", r3.statusCode === 429 && r3.body.error.message === "上游失败");
}

/* ============ ⑤ 第 46 批复审修复项的回归（AI协作.md） ============ */
console.log("\n=== ⑤ 复审修复项回归 ===");
{
  // Responses 顶层 instructions = system（早先整段丢弃，系统约束静默失效）
  const a = PROTOCOLS.responses.parse({ model: "m", instructions: "只回答一个字", input: "你好" });
  ck("responses：instructions 转成 system 且排在最前",
    a.messages[0]?.role === "system" && a.messages[0]?.content === "只回答一个字" && a.messages[1]?.role === "user",
    JSON.stringify(a.messages));
  ck("responses：instructions 数组形态也能读",
    PROTOCOLS.responses.parse({ model: "m", instructions: [{ type: "input_text", text: "S" }], input: "u" })
      .messages[0]?.content === "S");
  ck("responses：无 instructions 时不无中生有",
    PROTOCOLS.responses.parse({ model: "m", input: "u" }).messages.every((x) => x.role !== "system"));

  // Anthropic thinking 必须是**独立块**，且与 text 块各占一个 index
  const r1 = fakeRes();
  const st = PROTOCOLS.messages.openStream(r1, "id1", "claude-x");
  PROTOCOLS.messages.reasoning(st, "想一想");
  PROTOCOLS.messages.delta(st, "答案");
  PROTOCOLS.messages.done(r1, st, { settled: { promptTokens: 1, completionTokens: 2 } });
  const ev1 = [];
  r1.chunks.join("").split("\n\n").forEach((frame) => {
    const em = frame.match(/^event: (\S+)/m);
    const dm = frame.match(/^data: (.*)$/m);
    if (em && dm) { try { ev1.push({ event: em[1], data: JSON.parse(dm[1]) }); } catch { /* skip */ } }
  });
  const types1 = ev1.map((e) => e.event);
  ck("messages：thinking 有独立 content_block_start(type=thinking)",
    ev1.some((e) => e.event === "content_block_start" && e.data.content_block?.type === "thinking"),
    JSON.stringify(types1));
  ck("messages：thinking_delta 落在 thinking 块的下标上",
    ev1.some((e) => e.data?.delta?.type === "thinking_delta" && e.data.index === 0),
    JSON.stringify(ev1.filter((e) => e.data?.delta).map((e) => [e.data.index, e.data.delta.type])));
  ck("messages：text_delta 落在另一个快下标上（不与 thinking 混块）",
    ev1.some((e) => e.data?.delta?.type === "text_delta" && e.data.index === 1),
    JSON.stringify(ev1.filter((e) => e.data?.delta).map((e) => [e.data.index, e.data.delta.type])));
  const starts1 = ev1.filter((e) => e.event === "content_block_start").length;
  const stops1 = ev1.filter((e) => e.event === "content_block_stop").length;  // 以解析后的事件为准
  ck("messages：块开闭配对（每个块恰好关一次）", starts1 === stops1 && starts1 === 2, `${starts1}/${stops1}`);

  // 只有正文时不产生多余块
  const r2 = fakeRes();
  const st2 = PROTOCOLS.messages.openStream(r2, "id2", "m");
  PROTOCOLS.messages.delta(st2, "只有正文");
  PROTOCOLS.messages.done(r2, st2, { settled: {} });
  // 只数 event: 行 —— 事件名在 data JSON 里也出现一次，直接 match 会翻倍
  const countBlockStart = (res) => (res.chunks.join("").match(/^event: content_block_start$/gm) || []).length;
  ck("messages：无思考时只有一个块", countBlockStart(r2) === 1, String(countBlockStart(r2)));

  // 空回复也要有一个块（部分 SDK 对「零内容块」判为解析失败）
  const r3 = fakeRes();
  const st3 = PROTOCOLS.messages.openStream(r3, "id3", "m");
  PROTOCOLS.messages.done(r3, st3, { settled: {} });
  ck("messages：空回复仍给出一个 content_block", countBlockStart(r3) === 1, String(countBlockStart(r3)));

  // 非流式必须返回 thinking 块（原先静默丢弃）
  const r4 = fakeRes();
  PROTOCOLS.messages.finish(r4, {
    id: "i", model: "m", content: "答案", reasoning: "推理过程",
    settled: { promptTokens: 1, completionTokens: 2, od: 0, currency: "OD", channel: "c", elapsed: 5 },
  });
  ck("messages：非流式返回独立 thinking 块",
    r4.body.content.length === 2 && r4.body.content[0].type === "thinking" && r4.body.content[0].thinking === "推理过程",
    JSON.stringify(r4.body.content));

  // Responses 完成事件的字段完整性（官方 SDK 用它替换本地 response 对象）
  const r5 = fakeRes();
  const st5 = PROTOCOLS.responses.openStream(r5, "resp_1", "gpt-5.6");
  PROTOCOLS.responses.reasoning(st5, "思考");
  PROTOCOLS.responses.delta(st5, "正文");
  PROTOCOLS.responses.done(r5, st5, { settled: { promptTokens: 3, completionTokens: 4 } });
  const done = sseData(r5).find((d) => d.type === "response.completed");
  const cc = done?.response || {};
  ck("responses：completed 带 id", cc.id === "resp_1", String(cc.id));
  ck("responses：completed 带 object/model/created_at",
    cc.object === "response" && cc.model === "gpt-5.6" && typeof cc.created_at === "number", JSON.stringify(cc));
  ck("responses：completed 带 output（含 message 项）",
    Array.isArray(cc.output) && cc.output.some((o) => o.type === "message"), JSON.stringify(cc.output?.map((o) => o.type)));
  ck("responses：completed 的 output 文本与流内一致",
    cc.output?.find((o) => o.type === "message")?.content?.[0]?.text === "正文");
  ck("responses：completed 的思考在 output 里也有",
    cc.output?.some((o) => o.type === "reasoning" && o.summary?.[0]?.text === "思考"),
    JSON.stringify(cc.output?.map((o) => o.type)));
  ck("responses：usage 三件套齐全",
    cc.usage?.input_tokens === 3 && cc.usage?.output_tokens === 4 && cc.usage?.total_tokens === 7, JSON.stringify(cc.usage));
  ck("responses：created 与 completed 字段集一致（同一 respBase）",
    (() => {
      const cr = sseData(r5).find((d) => d.type === "response.created")?.response || {};
      const keys = ["id", "object", "created_at", "model"];
      return keys.every((k) => k in cr && k in cc);
    })());
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
