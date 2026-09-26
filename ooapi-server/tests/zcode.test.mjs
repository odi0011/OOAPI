// ZCode 适配器桩测：凭据解析（credentials.json 扁平 KV）+ 默认端点 + 头组
// ===========================================================================
// ZCode CLI 的凭据文件是**扁平键值对**（键名带冒号），与常见 JSON 凭据完全不同。
// 这里用真实 HTTP 假上游验证：解析出的 key 真的发到了 Authorization，
// 默认端点真的是 Z.ai 的 coding 前缀 —— 不是断言源码字符串。
import http from "node:http";
import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ok  ${n}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.log(`  FAIL ${n}  ← ${extra}`); }
};

/* ---------- 假上游：记录路径与鉴权头 ---------- */
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization || "" });
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }] }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
// 假上游带版本段（与真实端点 /api/coding/paas/v4 同形）：
// compat 对「已带 /vN 的 base」只追加 /chat/completions，对裸域名会插一层 /v1
const BASE = `http://127.0.0.1:${server.address().port}/v4`;

const zcode = await import("../src/services/upstream/zcode.js");

/* ============ ① 凭据解析：扁平 KV（真实 credentials.json 形态） ============ */
console.log("\n=== ① 凭据解析 ===");
{
  // 结构仿真实文件（值是假的）：coding-plan api-key 必须优先于 oauth access_token
  const flat = {
    "oauth:zai:access_token": "oauthjwt.should.not.win",
    "zcodejwttoken": "clijwt",
    "account-provider:coding-plan:account:zai-individual-coding-plan:account:u-1:api-key": "plankey.deadbeef",
    "oauth:active_provider": "zai",
  };
  const cred = zcode.parseAuthJson(JSON.stringify(flat));
  ck("coding-plan 的 api-key 优先", cred.token === "plankey.deadbeef" && cred.kind === "coding-plan", JSON.stringify(cred.kind));
  ck("无 endpoint 时为空（importAuth 再落默认值）", cred.endpoint === "");

  const onlyOauth = zcode.parseAuthJson(JSON.stringify({ "oauth:zai:access_token": "oauthjwt.ok" }));
  ck("只有 oauth token 时用它", onlyOauth.token === "oauthjwt.ok" && onlyOauth.kind === "oauth");

  const bare = zcode.parseAuthJson("rawkey123");
  ck("裸串直接当 token", bare.token === "rawkey123");

  const explicit = zcode.parseAuthJson(JSON.stringify({ api_key: "k2", endpoint: BASE }));
  ck("显式 api_key + endpoint 可覆盖", explicit.token === "k2" && explicit.endpoint === BASE);

  assert.throws(() => zcode.parseAuthJson("{}"), /没有可用字段/);
  ck("空对象报 LOGIN_BAD_PARAMS", true);
}

/* ============ ② importAuth：落库形态 ============ */
console.log("\n=== ② importAuth ===");
{
  const r = await zcode.importAuth({ token: JSON.stringify({ "oauth:zai:access_token": "tok1" }) });
  ck("method=zcode 落库", r.other.method === "zcode");
  ck("默认端点是 Z.ai coding 前缀", r.other.endpoint === "https://api.z.ai/api/coding/paas/v4", r.other.endpoint);
  ck("token 透传", r.token === "tok1");
  const cn = await zcode.importAuth({ token: JSON.stringify({ api_key: "k", endpoint: "https://open.bigmodel.cn/api/coding/paas/v4/" }) });
  ck("endpoint 覆盖生效并去尾斜杠", cn.other.endpoint === "https://open.bigmodel.cn/api/coding/paas/v4");
}

/* ============ ③ 对话与模型清单：真的发到了假上游 ============ */
console.log("\n=== ③ 请求路径与鉴权头 ===");
{
  const channel = {
    id: 9001, type: "zcode", api_key: "live-key", models: "glm-5.3",
    other: { method: "zcode", endpoint: BASE, allow_private_upstream: true },
  };
  const out = await zcode.chat({ channel, model: "glm-5.3", messages: [{ role: "user", content: "hi" }], prompt: "hi" });
  const chatReq = seen.find((s) => s.url.includes("/chat/completions"));
  ck("对话打到 {base}/chat/completions（不再插一层 /v1）", Boolean(chatReq) && !chatReq.url.includes("/v1/chat"), seen.map((s) => s.url).join(","));
  ck("Authorization: Bearer 用的是渠道 key", chatReq?.auth === "Bearer live-key", chatReq?.auth);
  // compat.chat 非流式返回聚合形态 { content, reasoning, usage, ... }，不是原始 OpenAI JSON
  ck("正文返回", String(out?.content || "") === "OK", JSON.stringify(out).slice(0, 120));

  const models = await zcode.fetchUpstreamModels(channel);
  ck("模型清单来自 {base}/models", Array.isArray(models) && models.includes("glm-5.3"));
  const mReq = seen.find((s) => s.url.endsWith("/models"));
  ck("模型请求也带 Bearer", mReq?.auth === "Bearer live-key");
}

server.close();
console.log(`\nzcode 桩测：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
