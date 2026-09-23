// Trae 适配器的行为锁
// ===========================================================================
// Trae（字节 AI IDE）不是 OpenAI 兼容协议，必须有独立适配器。这里锁住四件
// 容易在后续改动中被破坏、而破坏后**很难从现象反推原因**的事：
//
//   ① **SSE 分片解析**：网络分包不保证一个 chunk 就是一个事件。若假设
//      「一次 push 就是一个完整事件」，内容会随机丢字/丢事件 —— 表现为
//      「回答断断续续」，排查时完全想不到是解析问题。
//   ② **200 + event:error 不能当成功**：实测上游对未认证也回 200，
//      错误在 SSE 帧里（code 1001）。不识别就会以「上游返回空内容」收场，
//      把认证问题伪装成内容问题（Qoder 那类故障的翻版）。
//   ③ **模型必须登记上游真实档位**：社区实测 Trae 的 claude-opus-4-x /
//      claude-sonnet-4-x 实际跑 GLM-5.2，claude-haiku-4-5 跑 GLM-5.1，
//      gpt-4o 跑 DeepSeek-V4-Pro。登记别名 = 用户按 Claude 的价付费拿到 GLM 输出。
//   ④ **不能错走 openai-compat**：方式必须带 loginModes，否则 isApiKeyMethod
//      会把它判成 API Key 型，请求发成 OpenAI 格式 → 必定失败。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name} → ${e.message}`);
  }
};
const ck = (c, m) => {
  if (!c) throw new Error(m || "断言失败");
};

const trae = await import("../src/services/upstream/trae.js");
const { publicProviders, getMethod } = await import("../src/services/channel-types.js");
const { adapterKeyFor, isSupportedType } = await import("../src/services/router.js");

console.log("=== ① SSE 分片解析（网络分包必须不影响内容）===");
t("内容与思考分字段回传", () => {
  let content = "";
  let reasoning = "";
  const p = trae.makeStreamParser({ onDelta: (t2) => { content += t2; }, onReasoning: (t2) => { reasoning += t2; } });
  p.push('event: output\ndata: {"response":"你好","reasoning_content":"想一下"}\n\n');
  p.push('event: output\ndata: {"response":"世界"}\n\n');
  p.flush();
  ck(content === "你好世界", `正文应为「你好世界」，实际「${content}」`);
  ck(reasoning === "想一下", `思考应为「想一下」，实际「${reasoning}」`);
});
t("任意切分位置都不丢内容（按字节切）", () => {
  const full =
    'event: output\ndata: {"response":"AB"}\n\n' +
    'event: output\ndata: {"response":"CD"}\n\n' +
    'event: done\ndata: {"finish_reason":"stop"}\n\n';
  for (const size of [1, 3, 7, 13, 29]) {
    let out = "";
    const p = trae.makeStreamParser({ onDelta: (x) => { out += x; } });
    for (let i = 0; i < full.length; i += size) p.push(full.slice(i, i + size));
    p.flush();
    ck(out === "ABCD", `按 ${size} 字节切分后得到「${out}」，期望「ABCD」`);
  }
});
t("排队事件不当内容", () => {
  let out = "";
  const p = trae.makeStreamParser({ onDelta: (x) => { out += x; } });
  p.push('event: request_wait_in_queue\ndata: {"position":3}\n\n');
  p.push('event: output\ndata: {"response":"ok"}\n\n');
  p.flush();
  ck(out === "ok", `排队事件混进了内容：「${out}」`);
});
t("坏 JSON 不抛错（流不能因为一帧解析失败而中断）", () => {
  let out = "";
  const p = trae.makeStreamParser({ onDelta: (x) => { out += x; } });
  p.push("event: output\ndata: {坏掉的 json\n\n");
  p.push('event: output\ndata: {"response":"ok"}\n\n');
  p.flush();
  ck(out === "ok", `坏帧影响了后续内容：「${out}」`);
});

console.log("\n=== ② 200 + event:error 必须被识别 ===");
t("code 1001 → CHANNEL_AUTH_EXPIRED（不是空内容）", () => {
  const r = trae.detectStreamError(
    'event: error\ndata: {"code":1001,"error":"","message":"We are sorry, but we are not able to authenticate you"}\n\n'
  );
  ck(r, "没有识别出错误帧");
  ck(r.code === "CHANNEL_AUTH_EXPIRED", `错误码应为 CHANNEL_AUTH_EXPIRED，实际 ${r.code}`);
  ck(/authenticate/.test(r.message), "错误信息没有带上游原文");
});
t("其它业务错误 → CHANNEL_BIZ_ERROR 并带码", () => {
  const r = trae.detectStreamError('event: error\ndata: {"code":5000,"message":"busy"}\n\n');
  ck(r && r.code === "CHANNEL_BIZ_ERROR", `实际 ${r?.code}`);
  ck(/5000/.test(r.message), "业务错误没有带上游错误码");
});
t("正常流不被误判为错误", () => {
  ck(trae.detectStreamError('event: output\ndata: {"response":"hi"}\n\n') === null, "正常内容被当成错误");
  ck(trae.detectStreamError("") === null, "空输入被当成错误");
});

console.log("\n=== ③ 凭据导入（用户能拿到什么就接受什么）===");
t("标准字段名", async () => {
  const r = await trae.importAuth({ token: JSON.stringify({ token: "tk", refreshToken: "rt", userId: "u1", region: "sg" }) });
  ck(r.token === "tk", "token 没解析出来");
  ck(r.other.refresh_token === "rt", "refreshToken 没解析出来");
  ck(r.other.region === "sg", "region 没解析出来");
});
t("常见别名（accessToken / refresh_token / user_id）", async () => {
  const r = await trae.importAuth({ token: JSON.stringify({ accessToken: "tk2", refresh_token: "rt2", user_id: "u2" }) });
  ck(r.token === "tk2", `token=${r.token}`);
  ck(r.other.refresh_token === "rt2", "别名 refresh_token 没解析");
  ck(r.other.user_id === "u2", "别名 user_id 没解析");
});
t("嵌套 credential 形态", async () => {
  const r = await trae.importAuth({ token: JSON.stringify({ credential: { token: "tk3", refreshToken: "rt3" } }) });
  ck(r.token === "tk3", `嵌套解析失败：${r.token}`);
});
t("裸串按 refreshToken 处理（它能换出 access token）", async () => {
  const r = await trae.importAuth({ token: "raw-token-abc" });
  ck(r.other.refresh_token === "raw-token-abc", "裸串没被当作 refreshToken");
});
t("空输入与无效 JSON 报错而不是静默产出空渠道", async () => {
  let threw = false;
  try {
    await trae.importAuth({ token: "" });
  } catch {
    threw = true;
  }
  ck(threw, "空输入没有报错");
  threw = false;
  try {
    await trae.importAuth({ token: JSON.stringify({ unrelated: 1 }) });
  } catch {
    threw = true;
  }
  ck(threw, "不含令牌的 JSON 没有报错");
});
t("region 映射到上游主机", async () => {
  const sg = await trae.importAuth({ token: JSON.stringify({ token: "x", region: "sg" }) });
  ck(/coresg-normal/.test(sg.other.host || ""), `sg 主机不对：${sg.other.host}`);
  const us = await trae.importAuth({ token: JSON.stringify({ token: "x", region: "us" }) });
  ck(/coreva-normal/.test(us.other.host || ""), `us 主机不对：${us.other.host}`);
  const cn = await trae.importAuth({ token: JSON.stringify({ token: "x", region: "cn" }) });
  ck(/mchost\.guru/.test(cn.other.host || ""), `cn 主机不对：${cn.other.host}`);
});

console.log("\n=== ④ 登记与路由（错了就必失败）===");
t("厂商已登记且方式带 loginModes（否则会错走 openai-compat）", () => {
  const p = publicProviders().find((x) => x.key === "trae");
  ck(p, "trae 厂商没登记");
  const m = p.methods.find((x) => x.key === "trae");
  ck(m, "trae 接入方式没登记");
  ck(m.apiKey === false, "被误判成 API Key 型（会走 openai-compat）");
  ck(m.entryUrl, "没有登录入口");
  ck(m.localLogin, "没有本机指引");
});
t("适配器已注册且能解析到（未注册会抛 UNSUPPORTED_CHANNEL）", () => {
  ck(isSupportedType("trae"), "trae 没注册进 ADAPTERS");
  ck(adapterKeyFor({ type: "trae", other: { method: "trae" } }) === "trae", "adapterKeyFor 没解析到 trae");
});
t("登记的是上游真实档位，不是会撒谎的 claude-* 别名", () => {
  const m = getMethod("trae", "trae");
  const ids = (m.defaultModels || []).map((x) => String(x.id).toLowerCase());
  for (const bad of ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-4o"]) {
    ck(!ids.includes(bad), `登记了会撒谎的别名「${bad}」——用户会按它的价付费却拿到别的模型`);
  }
  ck(ids.some((x) => x.includes("glm")), "没有登记 GLM 档位（Trae 实际跑的就是它）");
});
t("适配器实现了完整契约", () => {
  for (const k of ["chat", "verify", "fetchUpstreamModels", "importAuth", "refreshAuth"]) {
    ck(typeof trae[k] === "function", `缺 ${k}`);
  }
});

console.log("\n=== ⑤ 续期与认证头的约定 ===");
t("没有 refreshToken 时续期报 CHANNEL_AUTH_EXPIRED（需人工重贴）", async () => {
  // 同步断言：只看函数存在与错误码在源码里出现（真正发起网络请求不在此测）
  const src = read("src/services/upstream/trae.js");
  ck(/没有 refreshToken/.test(src), "没有对缺 refreshToken 的明确报错");
  ck(/CHANNEL_AUTH_EXPIRED/.test(src), "续期失败没有用 AUTH_EXPIRED（会让渠道被当成可自愈反复重试）");
});
t("发送三个令牌头（只带 Authorization 会被拒）", () => {
  const src = read("src/services/upstream/trae.js");
  ck(/authorization: `Cloud-IDE-JWT \$\{creds\.token\}`/.test(src), "缺 Cloud-IDE-JWT 头");
  ck(/"x-cloudide-token": creds\.token/.test(src), "缺 x-cloudide-token");
  ck(/"x-ide-token": creds\.token/.test(src), "缺 x-ide-token");
  ck(/"x-ide-version"/.test(src), "缺 x-ide-version（上游按版本校验档位）");
});
t("不重复设置 content-type（fetch 会逗号拼接导致 400）", () => {
  const src = read("src/services/upstream/trae.js");
  // headersFor 里不该出现 content-type；它只在各调用点单独给
  const fn = src.match(/function headersFor\(channel, creds\)[\s\S]*?\n\}/);
  ck(fn, "未找到 headersFor");
  ck(!/["']content-type["']\s*:/.test(fn[0]), "headersFor 里设置了 content-type（会与调用点重复）");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
