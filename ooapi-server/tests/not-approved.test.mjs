// 「账号未批准/风控标记」归类回归（WorkBuddy 11128/11140 实测事故，2026-09-26）
// ===========================================================================
// 事故：新建 WorkBuddy 渠道一测就 403（11140 request illegal /「内容未通过安全审核」），
// 旧归类把 403 一律当成 CHANNEL_AUTH_EXPIRED → auto_ban 停渠道 + 管理员被引导
// 重新绑定（实测同一账号连绑 4 次全部无效，凭据明明是好的）。
// 这里锁三件事：
//   ① 403+11140 / 400+11128 的响应体 → CHANNEL_NOT_APPROVED（不是 AUTH_EXPIRED）；
//   ② 该码可换渠道重试（RETRYABLE），别的账号往往能过；
//   ③ 不在 AUTO_PAUSE_CODES 里（自动恢复 T1 上线前，自动停用等于永久下线）。
import http from "node:http";
import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ok  ${n}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.log(`  FAIL ${n}  ← ${extra}`); }
};

/* ---------- ① 分类函数 ---------- */
{
  const { classifyUpstreamHttp } = await import("../src/services/upstream/http-error.js");
  const a = classifyUpstreamHttp(403, '{"code":11140,"msg":"request illegal","displayMsg":{"zh":"内容未通过安全审核"}}');
  ck("403+11140 → CHANNEL_NOT_APPROVED", a.code === "CHANNEL_NOT_APPROVED", a.code);
  const b = classifyUpstreamHttp(400, '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}');
  ck("400+11128 → CHANNEL_NOT_APPROVED", b.code === "CHANNEL_NOT_APPROVED", b.code);
  const c = classifyUpstreamHttp(403, '{"error":"token expired"}');
  ck("普通 403 仍归 AUTH_EXPIRED", c.code === "CHANNEL_AUTH_EXPIRED", c.code);
  ck("提示语写明「非凭据问题」", /非凭据问题/.test(a.hint));
}

/* ---------- ②③ 调度语义 ---------- */
{
  const execute = await import("../src/services/execute.js");
  ck("CHANNEL_NOT_APPROVED 可换渠道重试", execute.isRetryable("CHANNEL_NOT_APPROVED"));
  const router = await import("../src/services/router.js");
  ck("不在 AUTO_PAUSE_CODES（T1 上线前停了就回不来）", !router.AUTO_PAUSE_CODES.has("CHANNEL_NOT_APPROVED"));
}

/* ---------- ④ 真实假上游：适配器真的抛出该码 ---------- */
// 注意：workbuddy 适配器按 realm 固定上游域（忽略 base_url，这是正确行为），
// 所以这里走 openai-compat（workbuddy 的对话本来就装饰成 compat 形态）验证同一条分类路径。
{
  const server = http.createServer((req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({
      code: 11140, msg: "request illegal",
      displayMsg: { en: "The content did not pass the safety review.", zh: "内容未通过安全审核，请调整后重试" },
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${server.address().port}/v4`;
  const compat = await import("../src/services/upstream/openai-compat.js");
  const channel = {
    id: 9901, type: "openai-compat", api_key: "faketoken", models: "deepseek-v4.1-flash",
    base_url: BASE,
    other: { method: "api", allow_private_upstream: true },
  };
  try {
    await compat.chat({ channel, model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], prompt: "hi" });
    ck("403+11140 应抛错而非返回", false, "没有抛错");
  } catch (e) {
    ck("403+11140 → CHANNEL_NOT_APPROVED", e.code === "CHANNEL_NOT_APPROVED", `${e.code} :: ${String(e.message).slice(0, 80)}`);
    ck("报错文案引导正确（含「重新绑定无效」）", /重新绑定无效/.test(String(e.message)));
    ck("报错不再被当成凭据失效", e.code !== "CHANNEL_AUTH_EXPIRED");
  }
  server.close();
}

console.log(`\nnot-approved 回归：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
