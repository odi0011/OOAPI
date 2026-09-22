// TypeSafe AI（Jev）适配器单测。
// 重点在**双向转换**：Jev 不是聊天模型，网关内部却是聊天语义，
// 入站要把 messages 变成 {state, questions}，出站要把 answers 渲染成文本。
// 这两个方向都容易错，且错了以后表面「有回复」但内容是错的。
import { endpoints, parseQuestions, renderAnswers } from "../src/services/upstream/typesafe.js";

let pass = 0;
let fail = 0;
const ck = (n, c, e = "") => {
  if (c) { pass += 1; console.log(`  ok   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${e}`); }
};

/* ==================== ① 端点推导 ==================== */
console.log("=== ① 端点推导 ===");
{
  ck("默认 base → /v1/systemone",
    endpoints("").systemone === "https://api.typesafe.ai/v1/systemone", endpoints("").systemone);
  ck("裸域名 → /v1/systemone",
    endpoints("https://api.typesafe.ai").systemone === "https://api.typesafe.ai/v1/systemone");
  ck("已含 /v1 → 直接拼 systemone",
    endpoints("https://api.typesafe.ai/v1").systemone === "https://api.typesafe.ai/v1/systemone");
  ck("直填完整端点不重复拼",
    endpoints("https://api.typesafe.ai/v1/systemone").systemone === "https://api.typesafe.ai/v1/systemone");
  ck("末尾斜杠被规整", endpoints("https://api.typesafe.ai/").systemone === "https://api.typesafe.ai/v1/systemone");
  ck("models 端点同源", endpoints("https://api.typesafe.ai").models === "https://api.typesafe.ai/v1/models");
}

/* ==================== ② 结构化问题解析 ==================== */
console.log("\n=== ② 结构化问题解析 ===");
{
  // 纯 JSON 数组
  const a = parseQuestions(JSON.stringify([
    { id: "q1", type: "noul", text: "是否通过？" },
    { id: "q2", type: "choice", text: "选哪个？", choices: [{ id: "x", text: "X" }, { id: "y", text: "Y" }] },
  ]));
  ck("纯 JSON 数组被识别", Array.isArray(a) && a.length === 2, JSON.stringify(a));
  ck("choice 的选项被规整", a?.[1]?.choices?.length === 2 && a[1].choices[0].id === "x", JSON.stringify(a?.[1]));
  ck("id 缺失时自动补", parseQuestions('[{"type":"noul","text":"t"}]')?.[0]?.id === "q1");

  // 代码块包裹（调用方常这么贴）
  const b = parseQuestions('请判断：\n```json\n[{"id":"k","type":"noul","text":"ok?"}]\n```\n谢谢');
  ck("代码块里的 JSON 被识别", b?.[0]?.id === "k", JSON.stringify(b));

  // 非法/自然语言 → null（交给自动 noul）
  ck("自然语言返回 null", parseQuestions("这句话是否成立？") === null);
  ck("空输入返回 null", parseQuestions("") === null);
  ck("JSON 但不是问题数组 → null", parseQuestions("[1,2,3]") === null);
  ck("未知 type 被过滤掉", parseQuestions('[{"type":"unknown","text":"x"}]') === null);

  // score 的区间兜底
  const c = parseQuestions('[{"id":"s","type":"score","text":"打分","min":1,"max":5"}]');
  ck("score 非法 JSON 不崩（返回 null）", c === null);
  const d = parseQuestions('[{"id":"s","type":"score","text":"打分","min":1,"max":5}]');
  ck("score 区间被读取", d?.[0]?.min === 1 && d[0].max === 5, JSON.stringify(d?.[0]));
  const e2 = parseQuestions('[{"id":"s","type":"score","text":"打分"}]');
  ck("score 缺区间时给默认 0..1", e2?.[0]?.min === 0 && e2[0].max === 1, JSON.stringify(e2?.[0]));

  // choice 超 255 应当报错（官方硬约束）
  const many = Array.from({ length: 256 }, (_, i) => ({ id: String(i), text: `opt${i}` }));
  let threw = null;
  try { parseQuestions(JSON.stringify([{ id: "big", type: "choice", text: "t", choices: many }])); }
  catch (err) { threw = err; }
  ck("choice 超 255 项时报错（官方上限）", threw?.code === "CHANNEL_BAD_REQUEST", String(threw?.code));
}

/* ==================== ③ 答案渲染 ==================== */
console.log("\n=== ③ 答案渲染 ===");
{
  // noul：是/否 + 概率
  const a = renderAnswers([{ id: "q1", type: "noul", answer: true, probability: 0.92 }]);
  ck("noul 选 true → 「是」并带百分比", a.includes("是") && a.includes("92.0%"), a);

  const b = renderAnswers([{ id: "q1", type: "noul", answer: false, probability: 0.13 }]);
  ck("noul 选 false → 「否」", b.includes("否") && b.includes("13.0%"), b);

  // 概率字段名的多种写法
  ck("confidence 也能识别", renderAnswers([{ id: "q", type: "noul", answer: true, confidence: 0.5 }]).includes("50.0%"));
  ck("prob 也能识别", renderAnswers([{ id: "q", type: "noul", answer: true, prob: 0.25 }]).includes("25.0%"));

  // choice：把 id 翻译成选项文本
  const c = renderAnswers([{
    id: "q2", type: "choice", choice: "y", probability: 0.7,
    choices: [{ id: "x", text: "选项X" }, { id: "y", text: "选项Y" }],
  }]);
  ck("choice 把选项 id 翻成文本", c.includes("选项Y") && !c.includes("选项X"), c);

  // score
  ck("score 渲染数值", renderAnswers([{ id: "s", type: "score", score: 4, probability: 0.8 }]).includes("4"));

  // 容错
  ck("空数组渲染成空串", renderAnswers([]) === "");
  ck("非数组渲染成空串", renderAnswers(null) === "");
  ck("混入 null 元素不崩", renderAnswers([null, { id: "q", type: "noul", answer: true }]).includes("是"));
  ck("未知 type 不崩（走 noul 分支）", typeof renderAnswers([{ id: "u", type: "weird", answer: true }]) === "string");
}

/* ==================== ④ 与网关契约的一致性 ==================== */
console.log("\n=== ④ 与网关契约一致性 ===");
{
  // Jev 输出免费 → 适配器必须把 completion_tokens 报 0，
  // 否则网关会按输出计价，凭空多收（官方输出价是 $0）
  const src = await import("node:fs").then((m) => m.readFileSync(
    new URL("../src/services/upstream/typesafe.js", import.meta.url), "utf8"));
  ck("适配器把 completion_tokens 固定为 0（Jev 输出免费）",
    /completion_tokens:\s*0/.test(src), "未找到 completion_tokens: 0");
  ck("适配器回报 prompt_tokens（按输入计费）", /prompt_tokens:/.test(src));
  ck("适配器声明了 structured 字段（保留原始结构化结果）", /structured:\s*\{/.test(src));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
