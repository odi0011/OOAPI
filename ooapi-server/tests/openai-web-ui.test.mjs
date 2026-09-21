// ChatGPT 网页版解析器单测。
//
// 最重要的部分是「真实帧回归」：fixtures/openai-web-frames.json 是
// 2026-09-21 从线上真实对话抓下来的帧序列（脱敏后只留协议结构）。
// 为什么必须用真实帧：这套协议与社区文档差异很大（端点、帧格式都变了），
// 照着文档写的实现曾经「捕到 23 帧、页面也真回复了，解析出来却是空字符串」。
// 用真实帧当基准，协议一有变化测试立刻会红。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAiWebParser, detectOpenAiWebError } from "../src/services/upstream/openai-web-parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const ck = (n, c, e = "") => {
  if (c) { pass += 1; console.log(`  ok   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${e}`); }
};

/* ==================== ① 真实帧回归（核心） ==================== */
console.log("=== 真实帧回归（线上抓取） ===");
{
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "openai-web-frames.json"), "utf8"));
  const frames = fixture.frames;
  ck(`fixture 已加载（${frames.length} 帧）`, frames.length >= 15, `实际 ${frames.length}`);

  const p = createOpenAiWebParser();
  let streamed = "";
  const doneFlags = [];
  for (const f of frames) {
    const d = p.push(f);
    if (d?.content) streamed += d.content;
    if (d?.done) doneFlags.push(true);
  }
  const r = p.result();

  ck("流式增量拼接 = 「收到」（与页面显示一致）", streamed === "收到", JSON.stringify(streamed));
  ck("result.content = 「收到」", r.content === "收到", JSON.stringify(r.content));
  ck("识别出 conversation_id", /^[0-9a-f-]{20,}$/.test(String(r.conversationId || "")), String(r.conversationId));
  ck("从 server_ste_metadata 取到真实 model_slug（计费按实际档位）",
    /^gpt-/.test(String(r.modelSlug || "")), String(r.modelSlug));
  ck("流结束标记被识别", r.finished === true);
  ck("未把 system/隐藏消息混进正文（正文里不含 rebase 之类字样）",
    !/rebase|is_visually_hidden/.test(r.content), r.content.slice(0, 80));

  // 快照类帧要幂等：同一条 message 快照重复到达（上游会重推全量）不能重复输出。
  // 注意 patch 的 append 是**真增量**语义，重放整批帧本来就会再追加一次 ——
  // 那不是缺陷（真实场景里重复发送会带新的 message id），所以这里只断言快照幂等。
  const p2 = createOpenAiWebParser();
  const snapFrame = frames.find((f) => {
    try {
      const j = JSON.parse(f);
      const m = j?.v?.message;
      return m && (m.author || {}).role === "assistant" && String((m.content || {}).parts?.[0] || "").length > 0;
    } catch { return false; }
  });
  if (snapFrame) {
    const a = p2.push(snapFrame);
    const b = p2.push(snapFrame);
    ck("同一快照重复到达不重复输出", Boolean(a?.content) && b === null, `第一次=${JSON.stringify(a?.content)} 第二次=${JSON.stringify(b)}`);
  } else {
    // fixture 里若没有「带正文的助手快照」（本轮的回复是纯 patch 增量），用构造帧验证
    const mk = (txt) => JSON.stringify({ v: { message: { id: "z", author: { role: "assistant" }, content: { content_type: "text", parts: [txt] } } } });
    const a = p2.push(mk("你好"));
    const b = p2.push(mk("你好"));
    ck("同一快照重复到达不重复输出", a?.content === "你好" && b === null, `第一次=${JSON.stringify(a?.content)} 第二次=${JSON.stringify(b)}`);
  }
}

/* ==================== ② 增量语义（构造帧） ==================== */
console.log("\n=== 增量语义 ===");
{
  const snap = (role, parts, ct = "text") =>
    JSON.stringify({ v: { message: { id: "m1", author: { role }, content: { content_type: ct, parts } } } });
  const patch = (ops) => JSON.stringify({ o: "patch", v: ops });

  const p = createOpenAiWebParser();
  const out = [];
  for (const chunk of ["你", "好", "，世界"]) {
    const d = p.push(patch([{ p: "/message/content/parts/0", o: "append", v: chunk }]));
    if (d?.content) out.push(d.content);
  }
  ck("patch append 逐帧产出增量", out.join("") === "你好，世界", JSON.stringify(out));
  ck("每帧只发新增部分", out[0] === "你" && out[1] === "好", JSON.stringify(out));

  // 整条快照 + 后续 patch 混用（真实的第 14/17 帧就是这个组合）
  const p2 = createOpenAiWebParser();
  p2.push(snap("assistant", [""]));                       // 占位
  const d1 = p2.push(patch([{ p: "/message/content/parts/0", o: "append", v: "收" }]));
  const d2 = p2.push(patch([{ p: "/message/content/parts/0", o: "append", v: "到" }]));
  ck("占位快照后接 patch 增量", (d1?.content || "") + (d2?.content || "") === "收到", `${d1?.content}|${d2?.content}`);

  // 单操作形态（上游把 patch 数组拆成多个 data: 行）—— 实测两种形态都出现过，
  // 只认包装形态会漏掉正文：帧数正常但解析出空串（间歇性，取决于上游分帧）。
  const p3 = createOpenAiWebParser();
  const s1 = p3.push(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "收" }));
  const s2 = p3.push(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "到" }));
  ck("单操作形态的 patch 也能产出增量", (s1?.content || "") + (s2?.content || "") === "收到",
    `第一次=${JSON.stringify(s1?.content)} 第二次=${JSON.stringify(s2?.content)}`);
  const s3 = p3.push(JSON.stringify({ p: "/message/status", o: "replace", v: "finished_successfully" }));
  ck("单操作形态的 status patch 标记结束", s3?.done === true, JSON.stringify(s3));

  // 非 parts 路径的 patch 不应产出正文
  const d3 = p2.push(patch([{ p: "/message/status", o: "replace", v: "finished_successfully" }]));
  ck("status patch 不产正文但标记结束", d3?.content === undefined && d3?.done === true, JSON.stringify(d3));
}

/* ==================== ③ 角色与类型过滤 ==================== */
console.log("\n=== 角色/类型过滤 ===");
{
  const mk = (role, ct, parts) =>
    JSON.stringify({ v: { message: { id: "x", author: { role }, content: { content_type: ct, parts } } } });

  const p = createOpenAiWebParser();
  ck("user 消息不进正文", p.push(mk("user", "text", ["我的提问"])) === null);
  ck("system 隐藏消息不进正文", p.push(mk("system", "text", ["rebase 提示"])) === null);
  ck("reasoning_recap 不进正文", p.push(mk("assistant", "reasoning_recap", ["思考了 2 秒"])) === null);
  ck("model_editable_context 不进正文", p.push(mk("assistant", "model_editable_context", ["ctx"])) === null);
  const d = p.push(mk("assistant", "text", ["真正的回复"]));
  ck("assistant text 进正文", d?.content === "真正的回复", JSON.stringify(d));
  ck("正文只含助手内容", p.result().content === "真正的回复", p.result().content);
}

/* ==================== ④ 容错 ==================== */
console.log("\n=== 容错 ===");
{
  const p = createOpenAiWebParser();
  ck("空帧忽略", p.push("") === null);
  ck("版本标记 v1 忽略（不是 JSON）", p.push("v1") === null);
  ck("任意版本标记都忽略", p.push("v2") === null);
  ck("[DONE] 标记结束", p.push("[DONE]")?.done === true);
  ck("非 JSON 帧忽略", p.push("not json") === null);
  ck("message_marker 控制帧忽略", p.push(JSON.stringify({ type: "message_marker", marker: "cot_token" })) === null);
  ck("title_generation 不产正文", p.push(JSON.stringify({ type: "title_generation", title: "回复收到" })) === null);
  const p2 = createOpenAiWebParser();
  ck("parts 非字符串元素被跳过", p2.push(JSON.stringify({
    v: { message: { id: "y", author: { role: "assistant" }, content: { content_type: "text", parts: [{ x: 1 }, "文字"] } } },
  }))?.content === "文字");
}

/* ==================== ⑤ 错误识别 ==================== */
console.log("\n=== 错误识别 ===");
ck("风控帧 → CHANNEL_WAF", detectOpenAiWebError(["Unusual activity has been detected from your device"])?.code === "CHANNEL_WAF");
ck("达上限 → CHANNEL_QUOTA_EXCEEDED", detectOpenAiWebError(['"detail":"You\'ve reached your limit"'])?.code === "CHANNEL_QUOTA_EXCEEDED");
ck("401 → CHANNEL_AUTH_EXPIRED", detectOpenAiWebError(["Unauthorized"], 401)?.code === "CHANNEL_AUTH_EXPIRED");
ck("人机验证 → CHANNEL_WAF", detectOpenAiWebError(["verify you are human"])?.code === "CHANNEL_WAF");
ck("正常内容不误报", detectOpenAiWebError(["你好，有什么可以帮你"]) === null);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
