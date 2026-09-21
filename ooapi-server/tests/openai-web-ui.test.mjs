// ChatGPT 网页版解析器单测。
// 重点覆盖「parts 是全量文本」这个语义 —— 它是本解析器存在的唯一理由：
// 当成增量转发会把已发内容重复一遍（显示重复 + 重复计费）。
import { createOpenAiWebParser, detectOpenAiWebError } from "../src/services/upstream/openai-web-parser.js";

let pass = 0;
let fail = 0;
const ck = (n, c, e = "") => {
  if (c) { pass += 1; console.log(`  ok   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${e}`); }
};

const frame = (parts, meta = {}) =>
  JSON.stringify({
    message: {
      id: "m1",
      author: { role: "assistant" },
      content: { content_type: "text", parts },
      metadata: { model_slug: "gpt-5-6-luna", is_completion: false, ...meta },
    },
    conversation_id: "c1",
  });

console.log("=== 全量文本 → 增量 diff（核心语义）===");
{
  const p = createOpenAiWebParser();
  const out = [];
  for (const t of ["你", "你好", "你好，", "你好，世界"]) {
    const d = p.push(frame([t]));
    if (d?.content) out.push(d.content);
  }
  ck("逐帧增量拼接后等于最终全文", out.join("") === "你好，世界", JSON.stringify(out));
  ck("每帧只发新增部分（首帧=首字）", out[0] === "你" && out[1] === "好", JSON.stringify(out));
  ck("重复帧不发内容（上游会重复推同一全量）", p.push(frame(["你好，世界"])) === null);
}

console.log("\n=== 上游回退重写（内容变短）===");
{
  const p = createOpenAiWebParser();
  p.push(frame(["你好，世界"]));
  // 上游回退到 "你好"：协议只能追加，取公共前缀之后的修正内容
  const d = p.push(frame(["你好"]));
  ck("回退时不重发已发内容", d === null || d.content === "", JSON.stringify(d));
  // 再增长：新内容应能继续
  const d2 = p.push(frame(["你好，中国"]));
  ck("回退后继续增长只发差异", d2?.content === "中国", JSON.stringify(d2));
}

console.log("\n=== 结束信号 ===");
{
  const p = createOpenAiWebParser();
  ck("[DONE] 帧被识别为结束", p.push("[DONE]")?.done === true);
  const p2 = createOpenAiWebParser();
  const d = p2.push(frame(["完"], { is_completion: true }));
  ck("metadata.is_completion 也标记 done", d?.done === true, JSON.stringify(d));
}

console.log("\n=== 非助手内容不进正文 ===");
{
  const p = createOpenAiWebParser();
  const userFrame = JSON.stringify({
    message: { id: "u1", author: { role: "user" }, content: { content_type: "text", parts: ["我的提问"] } },
  });
  ck("用户消息被忽略", p.push(userFrame) === null);
  const toolFrame = JSON.stringify({
    message: { id: "t1", author: { role: "tool" }, content: { content_type: "text", parts: ["工具输出"] } },
  });
  ck("工具消息被忽略（用户没要过这段文本）", p.push(toolFrame) === null);
  ck("正文只含助手内容", p.result().content === "");
}

console.log("\n=== 容错 ===");
{
  const p = createOpenAiWebParser();
  ck("空帧返回 null", p.push("") === null);
  ck("非 JSON 帧返回 null", p.push("not json") === null);
  ck("无 message 的控制帧返回 null", p.push(JSON.stringify({ type: "x" })) === null);
  ck("parts 缺失返回 null", p.push(JSON.stringify({ message: { author: { role: "assistant" } } })) === null);
  // 非字符串部件（图片）应被跳过而不是拼成 "[object Object]"
  const mixed = p.push(frame([{ content_type: "image" }, "文字部分"]));
  ck("非字符串部件被跳过", mixed?.content === "文字部分", JSON.stringify(mixed));
}

console.log("\n=== 元信息回传 ===");
{
  const p = createOpenAiWebParser();
  p.push(frame(["x"]));
  const r = p.result();
  ck("回传 conversation_id（用于排查）", r.conversationId === "c1");
  ck("回传上游真实 model_slug（按实际档位计费）", r.modelSlug === "gpt-5-6-luna", r.modelSlug);
}

console.log("\n=== 错误识别（风控 / 限额 / 掉登录态）===");
ck("识别风控帧", detectOpenAiWebError(["Unusual activity has been detected from your device"])?.code === "CHANNEL_WAF");
ck("识别达上限", detectOpenAiWebError(['"detail":"You\'ve reached your limit"'])?.code === "CHANNEL_QUOTA_EXCEEDED");
ck("401 识别为掉登录态", detectOpenAiWebError(["Unauthorized"], 401)?.code === "CHANNEL_AUTH_EXPIRED");
ck("人机验证识别为风控", detectOpenAiWebError(["verify you are human"])?.code === "CHANNEL_WAF");
ck("正常内容不误报", detectOpenAiWebError(["你好，有什么可以帮你"]) === null);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
