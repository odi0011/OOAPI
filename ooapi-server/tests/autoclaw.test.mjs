// AutoClaw 适配器桩测：凭据解析（智谱 API Key）+ 默认端点 + 请求路径
// ===========================================================================
// AutoClaw 的凭据就是智谱开放平台的 API Key（id.secret 形态），
// 上游是标准 OpenAI 兼容协议 —— 桩测重点在「默认端点是否落在国内 bigmodel」
// 与「三种粘贴形态都能解出同一个 key」。
import http from "node:http";
import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ok  ${n}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.log(`  FAIL ${n}  ← ${extra}`); }
};

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization || "" });
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "glm-5.3" }] }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
// 与真实端点 /api/paas/v4 同形（带版本段），compat 只追加 /chat/completions
const BASE = `http://127.0.0.1:${server.address().port}/v4`;

const autoclaw = await import("../src/services/upstream/autoclaw.js");

/* ============ ① 凭据解析：三种形态 ============ */
console.log("\n=== ① 凭据解析 ===");
{
  const bare = autoclaw.parseAuthJson("1111.2222abcd");
  ck("裸 Key（id.secret）", bare.token === "1111.2222abcd");

  const json = autoclaw.parseAuthJson(JSON.stringify({ api_key: "3333.4444" }));
  ck("JSON api_key", json.token === "3333.4444");

  const alt = autoclaw.parseAuthJson(JSON.stringify({ apiKey: "5555.6666" }));
  ck("JSON apiKey 别名", alt.token === "5555.6666");

  const withEp = autoclaw.parseAuthJson(JSON.stringify({ api_key: "k", endpoint: BASE }));
  ck("endpoint 覆盖", withEp.endpoint === BASE);

  assert.throws(() => autoclaw.parseAuthJson(JSON.stringify({ foo: 1 })), /没有 api_key/);
  ck("缺 key 报 LOGIN_BAD_PARAMS", true);
}

/* ============ ② importAuth：默认端点是国内 bigmodel ============ */
console.log("\n=== ② importAuth ===");
{
  const r = await autoclaw.importAuth({ token: "7777.8888" });
  ck("method=autoclaw 落库", r.other.method === "autoclaw");
  ck("默认端点 = open.bigmodel.cn /api/paas/v4", r.other.endpoint === "https://open.bigmodel.cn/api/paas/v4", r.other.endpoint);
  const intl = await autoclaw.importAuth({ token: JSON.stringify({ api_key: "k", endpoint: "https://api.z.ai/api/paas/v4" }) });
  ck("国际端点可覆盖", intl.other.endpoint === "https://api.z.ai/api/paas/v4");
}

/* ============ ③ 请求真的到了假上游 ============ */
console.log("\n=== ③ 请求路径与鉴权头 ===");
{
  const channel = {
    id: 9002, type: "autoclaw", api_key: "zk.bin", models: "glm-5.3",
    other: { method: "autoclaw", endpoint: BASE, allow_private_upstream: true },
  };
  const out = await autoclaw.chat({ channel, model: "glm-5.3", messages: [{ role: "user", content: "hi" }], prompt: "hi" });
  const chatReq = seen.find((s) => s.url.includes("/chat/completions"));
  ck("对话打到 {base}/chat/completions（不再插一层 /v1）", Boolean(chatReq) && !chatReq.url.includes("/v1/chat"));
  ck("Authorization: Bearer 正确", chatReq?.auth === "Bearer zk.bin", chatReq?.auth);
  // compat.chat 非流式返回聚合形态 { content, ... }
  ck("正文返回", String(out?.content || "") === "OK", JSON.stringify(out).slice(0, 120));

  const models = await autoclaw.fetchUpstreamModels(channel);
  ck("模型清单可拉取", Array.isArray(models) && models.includes("glm-5.3"));
}

server.close();
console.log(`\nautoclaw 桩测：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
