// max_tokens / max_output_tokens 真正生效 —— 三种协议的回归锁
// ===========================================================================
// 黑盒测试实测（海外开发者人格，原话要点）：
//   同一 prompt，`max_tokens: 8` 返回 **88** 个 completion token，
//   换成 `max_tokens: 4096` 还是 88 —— 参数完全无效。
//   他还指出这比报错更糟：「max_tokens 是成本控制最被信任的旋钮；
//   任何依赖 finish_reason == "length" 判断截断的 agent 循环永远看不到该值。」
//
// 这组测试不依赖真实上游：直接驱动协议层 + 截断逻辑，验证
//   ① 三个协议的字段名都能被解析（max_tokens / max_completion_tokens / max_output_tokens）
//   ② 非法值当「没给」而不是抛错
//   ③ 截断时 finish_reason / stop_reason / status 分别是 length / max_tokens / incomplete
import { PROTOCOLS } from "../src/services/gateway-protocols.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name} → ${e.message}`);
  }
};
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

const chat = PROTOCOLS.chat;
const anthropic = PROTOCOLS.messages;
const responses = PROTOCOLS.responses;

/* ---------- ① 解析：三种协议的字段名 ---------- */
console.log("\n=== ① 解析输出上限字段 ===");
t("OpenAI chat: max_tokens", () => {
  eq(chat.parse({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 8 }).maxTokens, 8, "max_tokens");
});
t("OpenAI chat: max_completion_tokens（新名字）", () => {
  eq(chat.parse({ model: "m", messages: [{ role: "user", content: "x" }], max_completion_tokens: 16 }).maxTokens, 16, "max_completion_tokens");
});
t("OpenAI chat: 两个都给时以 max_tokens 为准", () => {
  const p = chat.parse({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 5, max_completion_tokens: 99 });
  eq(p.maxTokens, 5, "优先 max_tokens");
});
t("Anthropic: max_tokens", () => {
  eq(anthropic.parse({ model: "m", max_tokens: 32, messages: [{ role: "user", content: "x" }] }).maxTokens, 32, "max_tokens");
});
t("Responses: max_output_tokens", () => {
  eq(responses.parse({ model: "m", input: "x", max_output_tokens: 64 }).maxTokens, 64, "max_output_tokens");
});

/* ---------- ② 非法值当「没给」（0），不抛错 ---------- */
console.log("\n=== ② 非法值宽容处理 ===");
const bad = [
  [-1, "负数"],
  [0, "零"],
  ["abc", "字符串"],
  [null, "null"],
  [undefined, "未给"],
  [Infinity, "Infinity"],
  [NaN, "NaN"],
];
for (const [v, label] of bad) {
  t(`chat: ${label} → 视为未指定（0）`, () => {
    const p = chat.parse({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: v });
    eq(p.maxTokens, 0, label);
  });
}
t("小数向下取整", () => {
  eq(chat.parse({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 8.9 }).maxTokens, 8, "floor");
});
t("字符串数字被接受（宽容）", () => {
  eq(chat.parse({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: "16" }).maxTokens, 16, "string ok");
});

/* ---------- ③ 截断信号：三种协议各自的表达 ---------- */
console.log("\n=== ③ 截断时的 finish/stop 信号 ===");

/** 假 res：收集写入的 SSE 文本 */
function fakeRes() {
  const chunks = [];
  return {
    chunks,
    headersSent: false,
    setHeader() {},
    flushHeaders() {},
    write(s) { chunks.push(s); return true; },
    end(s) { if (s) chunks.push(s); },
    status() { return this; },
    json(o) { chunks.push(JSON.stringify(o)); return this; },
    text: () => chunks.join(""),
  };
}

t("chat 流式：截断 → finish_reason:length；正常 → stop", () => {
  const r1 = fakeRes();
  const st1 = chat.openStream(r1, "id", "m");
  chat.done(r1, st1, { settled: { truncated: true, promptTokens: 1, completionTokens: 8 } });
  if (!/"finish_reason":"length"/.test(r1.text())) throw new Error(`截断时未回 length: ${r1.text().slice(0, 200)}`);

  const r2 = fakeRes();
  const st2 = chat.openStream(r2, "id", "m");
  chat.done(r2, st2, { settled: { truncated: false, promptTokens: 1, completionTokens: 8 } });
  if (!/"finish_reason":"stop"/.test(r2.text())) throw new Error("正常时未回 stop");
});

t("chat 非流式：截断 → finish_reason:length", () => {
  const r = fakeRes();
  chat.finish(r, {
    id: "id", model: "m", content: "abc", reasoning: "",
    settled: { truncated: true, promptTokens: 1, completionTokens: 8, od: 0, currency: "OD", channel: "", elapsed: 1 },
  });
  if (!/"finish_reason":"length"/.test(r.text())) throw new Error(`非流式未回 length: ${r.text().slice(0, 200)}`);
});

t("Anthropic 流式：截断 → stop_reason:max_tokens；正常 → end_turn", () => {
  const r1 = fakeRes();
  const st1 = anthropic.openStream(r1, "id", "m");
  anthropic.done(r1, st1, { settled: { truncated: true, promptTokens: 1, completionTokens: 8 } });
  if (!/"stop_reason":"max_tokens"/.test(r1.text())) throw new Error(`未回 max_tokens: ${r1.text().slice(0, 300)}`);

  const r2 = fakeRes();
  const st2 = anthropic.openStream(r2, "id", "m");
  anthropic.done(r2, st2, { settled: { truncated: false, promptTokens: 1, completionTokens: 8 } });
  if (!/"stop_reason":"end_turn"/.test(r2.text())) throw new Error("正常时未回 end_turn");
});

t("Anthropic 非流式：截断 → stop_reason:max_tokens", () => {
  const r = fakeRes();
  anthropic.finish(r, {
    id: "id", model: "m", content: "abc", reasoning: "",
    settled: { truncated: true, promptTokens: 1, completionTokens: 8, od: 0, currency: "OD", channel: "", elapsed: 1 },
  });
  if (!/"stop_reason":"max_tokens"/.test(r.text())) throw new Error("非流式未回 max_tokens");
});

t("Responses 流式：截断 → response.incomplete + status:incomplete", () => {
  const r1 = fakeRes();
  const st1 = responses.openStream(r1, "id", "m");
  responses.done(r1, st1, { settled: { truncated: true, promptTokens: 1, completionTokens: 8 } });
  const txt = r1.text();
  if (!/response\.incomplete/.test(txt)) throw new Error(`未发 response.incomplete: ${txt.slice(0, 300)}`);
  if (!/"status":"incomplete"/.test(txt)) throw new Error("status 不是 incomplete");
  if (!/max_output_tokens/.test(txt)) throw new Error("缺 incomplete_details.reason");

  const r2 = fakeRes();
  const st2 = responses.openStream(r2, "id", "m");
  responses.done(r2, st2, { settled: { truncated: false, promptTokens: 1, completionTokens: 8 } });
  if (!/response\.completed/.test(r2.text())) throw new Error("正常时未发 response.completed");
});

t("Responses 非流式：截断 → status:incomplete", () => {
  const r = fakeRes();
  responses.finish(r, {
    id: "id", model: "m", content: "abc", reasoning: "",
    settled: { truncated: true, promptTokens: 1, completionTokens: 8, od: 0, currency: "OD", channel: "", elapsed: 1 },
  });
  const o = JSON.parse(r.text());
  eq(o.status, "incomplete", "status");
  eq(o.incomplete_details?.reason, "max_output_tokens", "reason");
});

/* ---------- ④ 未截断时不能误报 ---------- */
console.log("\n=== ④ 未截断时不得误报截断 ===");
t("settled 缺失时按「正常」处理（旧调用方不传该字段）", () => {
  const r = fakeRes();
  const st = chat.openStream(r, "id", "m");
  chat.done(r, st, {});
  if (!/"finish_reason":"stop"/.test(r.text())) throw new Error("缺 settled 时未回 stop");
});
t("Responses 非流式缺 settled → completed", () => {
  const r = fakeRes();
  responses.finish(r, { id: "id", model: "m", content: "x", reasoning: "", settled: { promptTokens: 1, completionTokens: 1, od: 0, currency: "OD", channel: "", elapsed: 1 } });
  eq(JSON.parse(r.text()).status, "completed", "status");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
