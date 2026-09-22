// 首 Token 口径的实机验证（用户要求的「实机测测」）。
// ===========================================================================
// 用户的三个问题，一一对应到断言：
//   ①「你线上测测 Gemini 渠道的是不是根据首 t 来判定的检测时间？为什么响应时间这么长？」
//      → 改成 TTFT 后，一个「思考 2 秒 + 正文」的上游，首 Token 应 ≈2s、总耗时 ≈3s，
//        展示与判定都用前者。
//   ②「GLM 这个模型响应也是很慢，但人家一直在思考，思考的首 t 也算首 t 吧？」
//      → reasoning 增量必须触发 markFirstToken（onReasoning 回调）。
//   ③「如果这个渠道这个厂商本身响应就很慢的话则可以根据具体的模型进行响应时间的配置」
//      → probe_timeout_sec 能放宽预算，且实测真的会等满。
//
// 做法：起一个真实的本地 HTTP 上游（SSE），让 probeChannel 真的去请求它 ——
// 不是 mock 计时函数，而是端到端跑一遍真实的流式读取路径。
import http from "node:http";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`); }
};

/* ---------------- 起一个可控的假上游 ---------------- */
// 按 scenario 决定：先吐多少秒 reasoning、再吐多少秒 content
let scenario = { reasoningMs: 0, contentMs: 0, reasoningChunks: 1, contentChunks: 1 };
const server = http.createServer((req, res) => {
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta) => ({
    id: "c1", object: "chat.completion.chunk", created: 0, model: "mock",
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  const step = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    // 思考阶段：每 chunk 等 reasoningMs/chunks 毫秒
    for (let i = 0; i < scenario.reasoningChunks; i++) {
      await step(scenario.reasoningMs / scenario.reasoningChunks);
      sse(chunk({ reasoning_content: "思考中…" }));
    }
    // 正文阶段
    for (let i = 0; i < scenario.contentChunks; i++) {
      await step(scenario.contentMs / scenario.contentChunks);
      sse(chunk({ content: "答案" }));
    }
    sse({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  })();
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const { probeChannel } = await import("../src/services/channel-probe.js");
const compat = await import("../src/services/upstream/openai-compat.js");

const mkChannel = (extraOther = {}) => ({
  id: 99001, type: "openai", method: "api",
  base_url: BASE, api_key: "sk-test",
  models: "mock-model",
  other: { method: "api", ...extraOther },
});
// 本地地址默认会被 SSRF 防护挡掉（这本身是对的），测试里显式豁免
const localOk = { allow_private_upstream: true };

/* ---------------- ① 只有思考时：TTFT 应反映思考首字 ---------------- */
console.log("\n=== ① GLM 那种「一直在思考」的渠道 ===");
{
  scenario = { reasoningMs: 2000, contentMs: 1000, reasoningChunks: 4, contentChunks: 4 };
  const t0 = Date.now();
  const r = await probeChannel(compat, mkChannel(localOk), "hi");
  const wall = Date.now() - t0;

  ck("首 Token 显著小于总耗时（思考期已算响应）", r.ttftMs < r.ms * 0.75,
    `ttft=${r.ttftMs}ms total=${r.ms}ms`);
  ck("首 Token ≈ 第一个思考增量的时刻（约 500ms）", r.ttftMs >= 300 && r.ttftMs <= 1400,
    `${r.ttftMs}ms`);
  ck("总耗时覆盖全部思考+正文（约 3s）", r.ms >= 2500, `${r.ms}ms`);
  ck("墙钟与总耗时一致", Math.abs(wall - r.ms) < 900, `wall=${wall} total=${r.ms}`);
  ck("正文正确拼接", r.reply === "答案答案答案答案", JSON.stringify(r.reply));
}

/* ---------------- ② 无思考、慢首字：TTFT 与总耗时接近 ---------------- */
console.log("\n=== ② 纯正文渠道（首字即响应）===");
{
  scenario = { reasoningMs: 0, contentMs: 1500, reasoningChunks: 0, contentChunks: 3 };
  const r = await probeChannel(compat, mkChannel(localOk), "hi");
  // 无思考时首 Token = 第一个正文 chunk 的时刻（上游 3 段各 500ms → 约 500ms）。
  // 断言「落在首段附近」而不是「≈总耗时」：流式响应里首段必然早于结束，
  // 那才是 TTFT 的定义（写这个测试时的第一版预期是错的）。
  ck("无思考时首 Token = 首个正文 chunk 时刻（约 500ms）",
    r.ttftMs >= 300 && r.ttftMs <= 900, `ttft=${r.ttftMs} total=${r.ms}`);
  ck("无思考时首 Token 仍明显小于总耗时", r.ttftMs < r.ms * 0.75, `ttft=${r.ttftMs} total=${r.ms}`);
}

/* ---------------- ③ 快模型：TTFT 必须小 ---------------- */
console.log("\n=== ③ 快模型 ===");
{
  scenario = { reasoningMs: 0, contentMs: 60, reasoningChunks: 0, contentChunks: 2 };
  const r = await probeChannel(compat, mkChannel(localOk), "hi");
  ck("快模型首 Token < 500ms", r.ttftMs < 500, `${r.ttftMs}ms`);
  ck("ttftMs 字段一定存在且为正", Number.isFinite(r.ttftMs) && r.ttftMs > 0, String(r.ttftMs));
}

/* ---------------- ④ 逐渠道超时配置确实生效 ---------------- */
console.log("\n=== ④ 慢模型的自定义超时 ===");
{
  // 上游要 2.4s 才出全部正文
  scenario = { reasoningMs: 0, contentMs: 2400, reasoningChunks: 0, contentChunks: 2 };

  // 注意：预算有 5 秒下限（probeBudgetMs 的钳制），所以「1 秒」实际会变成 5 秒 ——
  // 这是有意的防抖（太紧的预算会把正常渠道判成超时）。要证明预算生效，
  // 得用一个 >5s 的慢上游 + 6s 预算。
  scenario = { reasoningMs: 0, contentMs: 9000, reasoningChunks: 0, contentChunks: 3 };
  let tightErr = "";
  try {
    await probeChannel(compat, mkChannel({ ...localOk, probe_timeout_ms: 6000 }), "hi");
  } catch (e) {
    tightErr = e.message;
  }
  ck("6s 预算对 9s 的上游触发超时（证明预算真的生效）", /超时/.test(tightErr), tightErr.slice(0, 60));
  ck("超时错误报出实际预算（不是写死的 90s）", /6s/.test(tightErr), tightErr.slice(0, 60));

  const ok = await probeChannel(compat, mkChannel({ ...localOk, probe_timeout_ms: 20000 }), "hi");
  ck("20s 预算下成功（慢模型可观测）", Boolean(ok.reply), ok.reply);

  // 边界：字段大小写/别名兼容 + 上下限钳制
  const { probeBudgetMs } = await import("../src/services/channel-probe.js");
  ck("默认预算 = 90s（普通渠道）", probeBudgetMs({ other: {} }) === 90000, String(probeBudgetMs({ other: {} })));
  ck("浏览器渠道默认 240s", probeBudgetMs({ other: { method: "relay" }, type: "glm" }) >= 90000);
  ck("自定义预算被采用", probeBudgetMs({ other: { probe_timeout_ms: 300000 } }) === 300000);
  ck("超大值被钳到 30 分钟", probeBudgetMs({ other: { probe_timeout_ms: 99999999 } }) === 1800000);
  ck("过小值被抬到 5 秒（防抖）", probeBudgetMs({ other: { probe_timeout_ms: 10 } }) === 5000);
  ck("test_timeout_ms 别名也认", probeBudgetMs({ other: { test_timeout_ms: 120000 } }) === 120000);
}

/* ---------------- ⑤ 渠道测试与真实网关口径一致 ---------------- */
console.log("\n=== ⑤ 网关侧首 Token 记录 ===");
{
  const gw = (await import("node:fs")).readFileSync(
    new URL("../src/routes/gateway.js", import.meta.url), "utf8"
  );
  ck("onDelta 触发 markFirstToken", /onDelta: \(t\) => \{\s*markFirstToken\(\)/.test(gw));
  ck("onReasoning 触发 markFirstToken（思考算响应）",
    /onReasoning: \(t\) => \{\s*markFirstToken\(\)/.test(gw));
  ck("firstTokenMs 落到使用记录", /firstTokenMs: firstTokenAt/.test(gw));
  ck("ttftMs 落到监控指标", /ttftMs: firstTokenAt/.test(gw));
}

server.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
