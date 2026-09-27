// ds_safety 标注剥离回归（2026-09-27 用户截图实测）：
//   对 "hi" 的回复正文里混着 <ds_safety>[用户未成年] 否 …[规则] 无 </ds_safety>=Safe
// 这是 DeepSeek 托管端点（OpenCode/WorkBuddy 转发）的安全审核组件把判定过程漏进正文
// —— 平台原样透传提示词、没有任何注入；但上游内部元数据不该展示给用户，
// 所以在网关层剥离（与开源代理 new-api/one-api 对 <think> 等内部标签的同一做法）。
// 锁三件事：① 非流式整段剥离（含 =Safe 尾巴与未闭合块）；② 流式跨增量剥离（状态机）；
// ③ 剥离发生时 result.safetyStripped 置位（渠道「Safe」tag 的数据来源）。
import http from "node:http";
import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ok  ${n}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.log(`  FAIL ${n}  ← ${extra}`); }
};

const ANNO = "<ds_safety>[用户未成年] 否 [类型] 他 [判定] 用户输入仅为简单问候，未涉及任何政治敏感或色情内容。 [规则] 无 </ds_safety>";

/* ---------- ① 非流式整段剥离 ---------- */
{
  const q = await import("../src/services/upstream/vendor-quirks.js");
  ck("完整块+尾巴剥离", q.stripDsSafety(`Hello How${ANNO}=Safe`) === "Hello How");
  ck("中间块剥离", q.stripDsSafety(`a${ANNO}b`) === "ab");
  ck("无标注原样返回", q.stripDsSafety("普通回复") === "普通回复");
  ck("未闭合块剥到结尾", q.stripDsSafety(`OK<ds_safety>[判定] 未知`) === "OK");
}

/* ---------- ② 流式状态机：跨增量剥离 ---------- */
{
  const q = await import("../src/services/upstream/vendor-quirks.js");
  const f = q.makeDsSafetyFilter();
  // 把整段按 3 字符一切，模拟最恶劣的分帧
  const full = `Hello How${ANNO}=Safe`;
  let out = "";
  for (let i = 0; i < full.length; i += 3) out += f(full.slice(i, i + 3));
  out += f.flush();
  ck("跨增量分帧剥离后正文完整", out === "Hello How", JSON.stringify(out));
  ck("报告 hit（渠道 safe tag 的数据来源）", f.hit() === true);

  const f2 = q.makeDsSafetyFilter();
  const clean = f2("普通回复") + f2.flush();
  ck("无标注时逐字透传", clean === "普通回复");
  ck("无标注不报告 hit", f2.hit() === false);
}

/* ---------- ③ 真实假上游：流式回复带标注 → 聚合正文干净 + safetyStripped 置位 ---------- */
{
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "text/event-stream" });
    // 标注拆成两段发送，模拟跨增量
    const parts = ["Hello How<ds_sa", "fety>[判定] 安全无敏感 </ds_safety>", "=Safe 剩余正文"];
    for (const p of parts) {
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${server.address().port}/v4`;
  const compat = await import("../src/services/upstream/openai-compat.js");
  const channel = {
    id: 9902, type: "openai-compat", api_key: "k", models: "deepseek-v4.1-flash",
    base_url: BASE,
    other: { method: "api", allow_private_upstream: true },
  };
  let streamed = "";
  const out = await compat.chat({
    channel, model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }], prompt: "hi",
    onDelta: (t) => { streamed += t; },
  });
  ck("聚合正文不含标注", !out.content.includes("ds_safety") && !out.content.includes("=Safe"), JSON.stringify(out.content));
  ck("onDelta 流出的内容同样干净", !streamed.includes("ds_safety") && !streamed.includes("=Safe"), JSON.stringify(streamed));
  ck("正文保留（Hello How 与 剩余正文）", out.content.includes("Hello How") && out.content.includes("剩余正文"), JSON.stringify(out.content));
  ck("safetyStripped 置位", out.safetyStripped === true);
  server.close();
}

console.log(`\nds_safety 剥离回归：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
