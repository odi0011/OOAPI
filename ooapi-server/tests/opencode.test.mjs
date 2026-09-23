// OpenCode 适配器：GO 订阅的客户端识别要求（线上 400 missing_session_id 的回归）
// ===========================================================================
// 故障现场（线上渠道 #45）：
//   HTTP 400  missing_session_id
//   「Request is missing x-opencode-session and cannot be routed efficiently.
//     Please see https://opencode.ai/docs/go/#where-can-i-use-it」
//
// 官方文档 opencode.ai/docs/go/ 的 "Where can I use it?" 明确要求客户端：
//   ① 用自己的 user agent（如 my-coding-agent/1.0），不要用通用 SDK/库名；
//   ② 为每个会话发稳定的 x-opencode-session，用于路由与 prompt 缓存优化。
//
// 这里用**真实 HTTP 上游**（本地起一个记录请求头的服务）验证头真的发出去了 ——
// 不是断言源码里有没有字符串，而是看线上那条请求到底带了什么。
import http from "node:http";
import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`); }
};

/* ---------- 记录请求头的假上游 ---------- */
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: { ...req.headers } });
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "deepseek-v4.1-flash" }] }));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "OK" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/v1`;

const oc = await import("../src/services/upstream/opencode.js");
// 本地地址默认被 SSRF 防护挡掉（这本身是对的），测试里显式豁免
const mk = (extraOther = {}) => ({
  id: 4501, type: "opencode", base_url: BASE, api_key: "oc_sk_test",
  models: "deepseek-v4.1-flash",
  other: { method: "go", allow_private_upstream: true, ...extraOther },
});

/* ============ ① 会话 ID 的稳定性 ============ */
console.log("\n=== ① x-opencode-session 必须是稳定值 ===");
{
  const a = oc.sessionIdOf({ id: 45 });
  const b = oc.sessionIdOf({ id: 45 });
  const c = oc.sessionIdOf({ id: 46 });
  ck("同一渠道两次取到同一个 ID（换了等于缓存全失效）", a === b, a);
  ck("不同渠道取到不同 ID", a !== c, `${a} vs ${c}`);
  ck("形如 UUID（上游可能校验格式）", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), a);
  ck("可用 other.oc_session_id 覆盖", oc.sessionIdOf({ id: 45, other: { oc_session_id: "my-session-123" } }) === "my-session-123");
}

/* ============ ② 真实请求上必须带这两个头 ============ */
console.log("\n=== ② 线上那条请求到底带了什么头 ===");
{
  seen.length = 0;
  const r = await oc.chat({
    channel: mk(), model: "deepseek-v4.1-flash", prompt: "hi",
    messages: [{ role: "user", content: "hi" }], images: [],
    onDelta: () => {}, onReasoning: () => {},
  });
  ck("对话成功返回", r.content === "OK", JSON.stringify(r.content));
  const h = seen[0]?.headers || {};
  ck("发出 x-opencode-session（缺它就是 400 missing_session_id）", Boolean(h["x-opencode-session"]), JSON.stringify(Object.keys(h)));
  ck("session 值与派生结果一致", h["x-opencode-session"] === oc.sessionIdOf({ id: 4501 }), String(h["x-opencode-session"]));
  ck("发出自述 UA（不是 node 这种通用库名）", h["user-agent"] === "OOAPI-Gateway/1.0", String(h["user-agent"]));
  ck("Bearer 只出现一次（重复会被逗号拼接成两段，必然 401）",
    h.authorization === "Bearer oc_sk_test", String(h.authorization));
  ck("content-type 只出现一次且是 json", h["content-type"] === "application/json", String(h["content-type"]));

  // 稳定性：同一渠道连续两次请求，session 必须相同
  seen.length = 0;
  await oc.chat({ channel: mk(), model: "m", prompt: "x", messages: [{ role: "user", content: "x" }], images: [], onDelta: () => {} });
  ck("第二次请求用同一个 session（缓存能命中）",
    seen[0]?.headers["x-opencode-session"] === h["x-opencode-session"],
    `${seen[0]?.headers["x-opencode-session"]} vs ${h["x-opencode-session"]}`);
}

/* ============ ③ 健康检查与拉模型也带头 ============ */
console.log("\n=== ③ verify / fetchUpstreamModels 同样带头 ===");
{
  seen.length = 0;
  await oc.verify(mk());
  ck("verify 带 x-opencode-session", Boolean(seen[0]?.headers["x-opencode-session"]));
  ck("verify 带自述 UA", seen[0]?.headers["user-agent"] === "OOAPI-Gateway/1.0");

  seen.length = 0;
  const models = await oc.fetchUpstreamModels(mk());
  ck("拉模型带 x-opencode-session", Boolean(seen[0]?.headers["x-opencode-session"]));
  ck("拉模型返回列表", Array.isArray(models) && models.includes("deepseek-v4.1-flash"), JSON.stringify(models));
}

/* ============ ④ 不破坏用户已有的 extra_headers ============ */
console.log("\n=== ④ 与已有 extra_headers 共存 ===");
{
  seen.length = 0;
  await oc.chat({
    channel: mk({ extra_headers: { "x-custom": "keep-me", "x-opencode-session": "user-forced" } }),
    model: "m", prompt: "hi", messages: [{ role: "user", content: "hi" }], images: [],
    onDelta: () => {},
  });
  const h = seen[0]?.headers || {};
  ck("用户自定义头保留", h["x-custom"] === "keep-me", String(h["x-custom"]));
  ck("用户显式指定的 session 优先（不被覆盖）", h["x-opencode-session"] === "user-forced", String(h["x-opencode-session"]));
  ck("UA 仍被补上", Boolean(h["user-agent"]), String(h["user-agent"]));
}

/* ============ ⑤ 注册与声明一致（防「声明了但没注册」这类旧问题） ============ */
console.log("\n=== ⑤ 接入方式声明与适配器注册 ===");
{
  const { getMethod } = await import("../src/services/channel-types.js");
  const { getAdapter } = await import("../src/services/router.js");
  for (const method of ["api", "go"]) {
    const mCfg = getMethod("opencode", method);
    ck(`opencode 的 ${method} 方式声明了 adapter: opencode`, mCfg?.adapter === "opencode", String(mCfg?.adapter));
    const ch = { type: "opencode", other: { method } };
    const adapter = await getAdapter(ch);
    ck(`${method} 方式能取到适配器（不是 UNSUPPORTED_CHANNEL）`, Boolean(adapter?.chat), JSON.stringify(Object.keys(adapter || {})));
  }
  // 文档里的路径：base_url 必须是 /zen/go/v1（Go）与 /zen/v1（Zen）
  ck("GO 的 baseUrl 与官方 Endpoints 表一致", getMethod("opencode", "go")?.baseUrl === "https://opencode.ai/zen/go/v1",
    String(getMethod("opencode", "go")?.baseUrl));
  ck("Zen 的 baseUrl 与官方一致", getMethod("opencode", "api")?.baseUrl === "https://opencode.ai/zen/v1",
    String(getMethod("opencode", "api")?.baseUrl));
}

server.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
