// 对话工具调用嗅探回归（services/harness/loop.js 的 StepStream）
// ---------------------------------------------------------------------------
// 真实事故（用户截图，2026-09-27）：DeepSeek 吐出原生 DSML 调用标记，
// 原嗅探器不认，整段 <｜DSML｜invoke …> 被当正文显示成「乱码」，工具也没执行。
// 每个用例都跑两遍：整段一次性推入 + 逐字符推入（流式把标记切碎是最容易漏的情况）。
import { StepStream, parseInvokeMarkup } from "../src/services/harness/loop.js";

let pass = 0;
let fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? `  ← ${extra}` : ""}`);
  }
};

function run(text, mode) {
  const s = new StepStream();
  let shown = "";
  if (mode === "whole") shown += s.push(text);
  else for (const ch of text) shown += s.push(ch);
  const f = s.finish();
  return { shown: shown + f.text, call: f.call, bad: f.bad };
}

const SCREENSHOT =
  "我现在去搜一下真实仓库，避免给你编名字。\n" +
  "<｜DSML｜function_calls>\n" +
  '<｜DSML｜invoke name="github">\n' +
  '<｜DSML｜parameter name="args" string="false">{"action": "search", "repo": "anthropics/skills", "query": "animation"}</｜DSML｜parameter>\n' +
  '<｜DSML｜parameter name="tool" string="true">github</｜DSML｜parameter>\n' +
  "</｜DSML｜invoke>\n" +
  "</｜DSML｜function_calls>";

const CASES = [
  {
    name: "截图原文：DSML function_calls（args 为 JSON 串）",
    text: SCREENSHOT,
    tool: "github",
    args: { action: "search", repo: "anthropics/skills", query: "animation" },
    visible: "我现在去搜一下真实仓库",
  },
  {
    name: "半角竖线 + 双竖线变体 <||DSML||invoke>",
    text: '好的。<||DSML||invoke name="search"><||DSML||parameter name="query">OOAPI 网关</||DSML||parameter></||DSML||invoke>',
    tool: "search",
    args: { query: "OOAPI 网关" },
    visible: "好的。",
  },
  {
    name: "普通 XML function_calls/invoke（Claude 风格）",
    text: '<function_calls><invoke name="fetch"><parameter name="url">https://example.com</parameter></invoke></function_calls>',
    tool: "fetch",
    args: { url: "https://example.com" },
    visible: "",
  },
  {
    name: "约定写法 <tool_call>",
    text: '先查一下。\n<tool_call>{"tool":"search","args":{"query":"x"}}</tool_call>',
    tool: "search",
    args: { query: "x" },
    visible: "先查一下。",
  },
  {
    name: "<tool_call> 里用 name/arguments（OpenAI 风格）",
    text: '<tool_call>{"name":"account","arguments":{"action":"balance"}}</tool_call>',
    tool: "account",
    args: { action: "balance" },
    visible: "",
  },
  {
    name: "DeepSeek V3 特殊 token",
    text: '查询中<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search\n```json\n{"query":"天气"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
    tool: "search",
    args: { query: "天气" },
    visible: "查询中",
  },
  {
    name: "整个回答为裸 JSON 调用",
    text: '{"tool":"search","args":{"query":"y"}}',
    tool: "search",
    args: { query: "y" },
    visible: "",
  },
  {
    name: "线上 Laguna arg_key/arg_value 原文",
    text: '<tool_call>account<arg_key>action</arg_key><arg_value>overview</arg_value></tool_call>',
    tool: "account", args: { action: "overview" }, visible: "",
  },
  {
    name: "线上 Laguna 完整 JSON 漏结束标签",
    text: '<tool_call>{"tool":"account","args":{"action":"overview"}}',
    tool: "account", args: { action: "overview" }, visible: "",
  },
  {
    name: "大写标签与 functions 前缀",
    text: '<TOOL_CALL>{"name":"functions.account","arguments":"{\\"action\\":\\"recent\\",\\"limit\\":5}"}</TOOL_CALL>',
    tool: "account", args: { action: "recent", limit: 5 }, visible: "",
  },
  {
    name: "单条 OpenAI tool_calls 包装",
    text: '<tool_call>{"tool_calls":[{"function":{"name":"account","arguments":"{\\"action\\":\\"overview\\"}"}}]}</tool_call>',
    tool: "account", args: { action: "overview" }, visible: "",
  },
];

console.log("=== 工具调用嗅探 ===");
for (const c of CASES) {
  for (const mode of ["whole", "char"]) {
    const r = run(c.text, mode);
    const tag = `${c.name}（${mode === "whole" ? "整段" : "逐字"}）`;
    ck(`${tag} 识别出工具 ${c.tool}`, r.call?.tool === c.tool, JSON.stringify(r.call));
    ck(`${tag} 参数正确`, JSON.stringify(r.call?.args) === JSON.stringify(c.args), JSON.stringify(r.call?.args));
    ck(`${tag} 正文不含任何调用标记`, !/DSML|invoke|function_calls|tool_call|tool▁|"tool"/.test(r.shown), JSON.stringify(r.shown));
    if (c.visible) ck(`${tag} 调用前的说明文字保留`, r.shown.includes(c.visible), JSON.stringify(r.shown));
  }
}

console.log("\n=== 异常与边界 ===");
for (const mode of ["whole", "char"]) {
  const cut = run('稍等<｜DSML｜function_calls><｜DSML｜invoke name="github"><｜DSML｜parameter name="args">{"repo":', mode);
  ck(`未闭合的 DSML 标记不当正文吐出（${mode}）`, !/DSML|invoke/.test(cut.shown), JSON.stringify(cut.shown));
  ck(`未闭合的 DSML 标记判为格式不合法（让模型重试）（${mode}）`, cut.bad === true && !cut.call);

  const badTag = run("<tool_call>这不是 JSON</tool_call>", mode);
  ck(`<tool_call> 里不是 JSON → 格式不合法（${mode}）`, badTag.bad === true && !/tool_call/.test(badTag.shown));

  const plain = run("普通回答，包含代码 `const a = {b: 1}` 与 <div>html</div>，还有 x < y。", mode);
  ck(`普通正文原样保留、无误判（${mode}）`, !plain.call && !plain.bad && plain.shown === "普通回答，包含代码 `const a = {b: 1}` 与 <div>html</div>，还有 x < y。", JSON.stringify(plain.shown));

  const fence = run('示例：\n```json\n{"tool": "search"', mode);
  ck(`未闭合的 JSON 代码块按正文吐出、不吞内容（${mode}）`, fence.shown.includes('"tool": "search"') && !fence.call, JSON.stringify(fence.shown));

  const stray = run("回答完毕<｜end▁of▁sentence｜>", mode);
  ck(`对话模板特殊 token 被剥掉（${mode}）`, stray.shown === "回答完毕", JSON.stringify(stray.shown));

  for (const example of [
    '这是 JSON 示例，请勿执行：\n```json\n{"tool":"todowrite","args":{"todos":[{"content":"example"}]}}\n```',
    '普通解释中的 {"tool":"account","args":{"action":"overview"}} 应显示为正文。',
    '示例：`<tool_call>{"tool":"account","args":{}}</tool_call>`',
    '> ~~~xml\n> <tool_call>{"tool":"account","args":{}}</tool_call>\n> ~~~',
    '    <tool_call>{"tool":"account","args":{}}</tool_call>',
  ]) {
    const literal = run(example, mode);
    ck(`普通代码/行内示例不执行且原样显示（${mode}）`, !literal.call && !literal.bad && literal.shown === example, JSON.stringify(literal));
  }
  for (const args of ['"not-json"', 'null', '[]']) {
    const invalid = run(`<tool_call>{"tool":"account","args":${args}}</tool_call>`, mode);
    ck(`非法参数 ${args} 不变成默认空参数（${mode}）`, invalid.bad && !invalid.call);
    const markup = run(`<function_calls><invoke name="account"><parameter name="args">${args}</parameter></invoke></function_calls>`, mode);
    ck(`XML参数 ${args} 不变成默认空参数（${mode}）`, markup.bad && !markup.call);
  }
  const partial = run('<tool_call>{"tool":"account","args":{"action":', mode);
  ck(`未完成 JSON 不猜补并调用（${mode}）`, partial.bad && !partial.call);
  for (const text of ['（工具调用格式不合法）', '（工具调用格式不合法）\n（工具调用格式不合法）']) {
    const internal = run(text, mode);
    ck(`内部错误占位符不能显示成成功回答（${mode}）`, internal.bad && !internal.call && !internal.shown);
  }
}

const p = parseInvokeMarkup('<invoke name="x"><parameter name="n">42</parameter><parameter name="s" string="true">42</parameter></invoke>');
ck("parameter 按 JSON 解析数字，string=true 保留字符串", p.args.n === 42 && p.args.s === "42", JSON.stringify(p.args));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
await import("./harness-billing.test.mjs");
process.exit(fail ? 1 : 0);
