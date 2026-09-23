// Cline 集成测试
// ===========================================================================
// 背景：用户要求「研究一下有没有 cline 这个厂商的反代方案，需要集成」。
//
// 调研结论（2026-09-23）：**Cline 官方就提供标准 OpenAI 兼容 API**，
// 所以正确做法是按普通 API Key 渠道接入，而不是做社区那种 cline2api 反代。
// 本文件锁住这个结论涉及的每一处实现。
//
// 实现形态（两种凭据入口并存）：
//   ① 一键绑定 —— WorkOS RFC 8628 设备授权（端点全部实测），与 Kiro/WorkBuddy/Qoder
//      同一套 device-bind 机制；
//   ② API Key  —— 官方在 app.cline.bot 正式签发的 Key。
// 两条路都走同一个适配器（客户端标识头 + 响应包封解包 + 凭据刷新）。
//
// 关键实现事实（易错点，测试逐条锁住）：
//   · WorkOS 的 `authorization_pending` 是 **HTTP 400 + error 字段**，不是 2xx ——
//     判成失败会让一键绑定直接报错（与 Kiro 的 pending 是异常名同一类坑）；
//   · 必须带官方客户端标识头，裸请求会被上游 403；
//   · 不能重复设置 content-type/authorization（Fetch 逗号拼接 → 两段 Bearer → 401）。
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`); }
};

/* ============ ① 厂商声明与适配器注册 ============ */
console.log("\n=== ① 厂商声明与适配器 ===");
{
  const { publicProviders, getMethod } = await import("../src/services/channel-types.js");
  const { getAdapter } = await import("../src/services/router.js");

  const p = publicProviders().find((x) => x.key === "cline");
  ck("厂商列表里有 Cline", Boolean(p), p ? p.name : "缺失");
  ck("厂商名是 Cline", p?.name === "Cline", String(p?.name));
  ck("有 keyUrl（获取 Key 的官方页面）", /app\.cline\.bot/.test(p?.keyUrl || ""), p?.keyUrl);

  const m = getMethod("cline", "api");
  ck("有 api 接入方式", Boolean(m));
  ck("baseUrl 指向官方 OpenAI 兼容端点",
    m?.baseUrl === "https://api.cline.bot/api/v1", String(m?.baseUrl));
  ck("声明了 adapter: cline（不是裸 openai-compat）",
    m?.adapter === "cline", String(m?.adapter));

  const adapter = await getAdapter({ type: "cline", other: { method: "api" } });
  ck("适配器可加载（不是 UNSUPPORTED_CHANNEL）", Boolean(adapter?.chat));
  ck("实现了 chat", typeof adapter?.chat === "function");
  ck("实现了 verify（健康检查）", typeof adapter?.verify === "function");
  ck("实现了 fetchUpstreamModels（拉模型清单）", typeof adapter?.fetchUpstreamModels === "function");
}

/* ============ ② 客户端标识头（上游对无标识的请求会 403） ============ */
console.log("\n=== ② 客户端标识头 ===");
{
  const a = await import("../src/services/upstream/cline.js");
  ck("导出 CLINE_HEADERS", Boolean(a.CLINE_HEADERS));
  ck("含 HTTP-Referer（官方统计头）", a.CLINE_HEADERS["HTTP-Referer"] === "https://cline.bot");
  ck("含 X-Title", Boolean(a.CLINE_HEADERS["X-Title"]));
  ck("含 X-CLIENT-TYPE", a.CLINE_HEADERS["X-CLIENT-TYPE"] === "cline-sdk");
  ck("含 X-IS-MULTIROOT", "X-IS-MULTIROOT" in a.CLINE_HEADERS);

  const decorated = a.withClineHeaders({ id: 1, other: {} });
  ck("withClineHeaders 把标识头放进 extra_headers",
    decorated.other.extra_headers["HTTP-Referer"] === "https://cline.bot");

  // 渠道自定义头必须能覆盖默认值（显式配置优先）
  const custom = a.withClineHeaders({ id: 1, other: { extra_headers: { "X-Title": "MyTool" } } });
  ck("渠道自定义头可覆盖默认值（显式优先）",
    custom.other.extra_headers["X-Title"] === "MyTool", custom.other.extra_headers["X-Title"]);

  // UA 可覆盖（Cline 用 UA 里的版本号做过校验）
  const withUa = a.withClineHeaders({ id: 1, other: { client_user_agent: "Cline/3.0.0" } });
  ck("渠道可指定 UA（上游会校验版本号）",
    withUa.other.extra_headers["user-agent"] === "Cline/3.0.0");

  // 不能重复设置 content-type / authorization（Fetch 会逗号拼接 → 必然 401）
  const ck2 = a.withClineHeaders({ id: 1, other: {} });
  ck("不重复设置 content-type", !("content-type" in ck2.other.extra_headers));
  ck("不重复设置 authorization", !("authorization" in ck2.other.extra_headers));
}

/* ============ ③ 响应包封解包 ============ */
console.log("\n=== ③ 响应包封（data envelope）解包 ===");
{
  const { unwrapEnvelope } = await import("../src/services/upstream/cline.js");

  const standard = { choices: [{ index: 0, delta: { content: "hi" } }] };
  ck("标准形状原样返回", unwrapEnvelope(standard) === standard);
  ck("标准形状不被误改", Array.isArray(unwrapEnvelope(standard).choices));

  const wrapped = { success: true, data: { choices: [{ index: 0, delta: { content: "hi" } }] } };
  const out = unwrapEnvelope(wrapped);
  ck("data 包封被解开", Array.isArray(out.choices) && out.choices[0].delta.content === "hi");

  const wrappedWithUsage = { data: { choices: [{}] }, usage: { total_tokens: 5 } };
  ck("外层 usage 在解包后保留（部分实现把它放外层）",
    unwrapEnvelope(wrappedWithUsage).usage?.total_tokens === 5);

  ck("null 安全", unwrapEnvelope(null) === null);
  ck("无 choices 也无 data 时原样返回",
    unwrapEnvelope({ error: "x" }).error === "x");

  // openai-compat 必须真的调用这个钩子（否则适配器传了也没用）
  const compat = readFileSync(new URL("../src/services/upstream/openai-compat.js", import.meta.url), "utf8");
  ck("chat() 接收 unwrap 选项", /signal,\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*unwrap,/.test(compat) || /\bunwrap,\n\}\) \{/.test(compat));
  ck("SSE 解析里套用 unwrap（解包后再读 choices）",
    /if \(unwrap\) ev = unwrap\(ev\) \|\| ev;/.test(compat));
  ck("unwrap 未传时零影响（条件调用）", /if \(unwrap\)/.test(compat));
}

/* ============ ④ 模型 id 与定价门禁的配合 ============ */
console.log("\n=== ④ 模型 id 与「未定价不放行」门禁 ===");
{
  const { getMethod } = await import("../src/services/channel-types.js");
  const { DEFAULT_PRICES } = await import("../src/services/pricing.js");
  const m = getMethod("cline", "api");
  const ids = (m.defaultModels || []).map((x) => x.id);
  ck("登记了默认模型", ids.length >= 5, String(ids.length));
  ck("模型 id 是 vendor/model 形式（与官方一致）",
    ids.every((i) => i.includes("/")), JSON.stringify(ids.slice(0, 3)));

  // 复刻 isModelPriced 的判定（剥前缀 + 精确/最长前缀命中）
  const priced = new Set(DEFAULT_PRICES.map((p) => String(p.model).toLowerCase()));
  const isPriced = (model) => {
    const t = String(model || "").toLowerCase();
    const stripped = t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t;
    if (priced.has(t) || priced.has(stripped)) return true;
    for (const k of [t, stripped]) for (const p of priced) if (k.startsWith(p)) return true;
    return false;
  };
  const unpriced = ids.filter((i) => !isPriced(i));
  ck("全部默认模型都能通过定价门禁（否则加完渠道立刻不可用）",
    unpriced.length === 0, unpriced.join(", "));
  ck("testModel 也在已定价之列（否则「测试」按钮直接失败）",
    isPriced(m.testModel), String(m.testModel));

  // 剥离 vendor/ 前缀这件事本身要有断言 —— 它是上面能通过的原因
  ck("getPrice 会剥离 vendor/ 前缀（Cline/OpenRouter 共用这套 id 规则）",
    /const slash = m\.lastIndexOf\("\/"\)/.test(readFileSync(new URL("../src/services/pricing.js", import.meta.url), "utf8")));
}

/* ============ ⑤ 集成方式的选择（记录结论，防止回退成反代） ============ */
console.log("\n=== ⑤ 接入方式是官方 API 而非反代 ===");
{
  const src = readFileSync(new URL("../src/services/upstream/cline.js", import.meta.url), "utf8");
  ck("适配器注释记录了端点契约的实测结论", /实测/.test(src));
  ck("说明了两条凭据入口（一键绑定 + 粘贴 refreshToken）", /一键绑定/.test(src) && /refreshToken/.test(src));
  ck("标识头来源写明取自官方 SDK（不是猜的）",
    /request-headers\.ts/.test(src));
  ck("与其它厂商的同类做法一致（点名 WorkBuddy/Kiro 的标识头）",
    /WorkBuddy/.test(src) && /Kiro/.test(src));
}

/* ============ ⑥ 一键绑定（设备授权）============ */
console.log("\n=== ⑥ 一键绑定（WorkOS 设备流）===");
{
  const db = await import("../src/services/device-bind.js");
  ck("deviceBindVendors 含 cline", db.deviceBindVendors().includes("cline"));
  ck("supportsDeviceBind('cline')", db.supportsDeviceBind("cline") === true);

  const src = readFileSync(new URL("../src/services/device-bind.js", import.meta.url), "utf8");
  ck("用 WorkOS 设备授权端点", /user_management\/authorize\/device/.test(src));
  ck("用 WorkOS authenticate 端点轮询", /user_management\/authenticate/.test(src));
  ck("client_id 来自官方 SDK（不是猜的）", /client_01K3A541FN8TA3EPPHTD2325AR/.test(src));
  ck("grant_type 用 RFC 8628 标准 URN",
    /urn:ietf:params:oauth:grant-type:device_code/.test(src));
  ck("注释记录了实测结论（端点均探测过）",
    /实测/.test(src) && /authorization_pending/.test(src));

  const { judgeClineToken } = db;
  ck("导出 judgeClineToken（纯函数可离线覆盖分支）", typeof judgeClineToken === "function");

  const ok = judgeClineToken({ status: 200, json: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } }, {});
  ck("授权完成 → success 且带回两个 token",
    ok.status === "success" && ok.credential.access_token === "AT" && ok.credential.refresh_token === "RT",
    JSON.stringify(ok).slice(0, 100));
  ck("expires_at 换算成秒级时间戳",
    ok.credential.expires_at > Math.floor(Date.now() / 1000), String(ok.credential.expires_at));
  ck("落库带上 client_id 与 endpoint（刷新要用）",
    Boolean(ok.credential.client_id) && /api\.cline\.bot/.test(ok.credential.endpoint));

  // **关键语义**：authorization_pending 是 HTTP 400，但必须判成 pending 而不是失败
  const pend = judgeClineToken({ status: 400, json: { error: "authorization_pending" } }, {});
  ck("authorization_pending（HTTP 400）判为 pending，不是失败",
    pend.status === "pending", JSON.stringify(pend));
  const slow = judgeClineToken({ status: 400, json: { error: "slow_down" } }, {});
  ck("slow_down 继续轮询并标记 slowDown", slow.status === "pending" && slow.slowDown === true);
  const denied = judgeClineToken({ status: 400, json: { error: "access_denied" } }, {});
  ck("access_denied 判为 denied", denied.status === "denied");
  const exp = judgeClineToken({ status: 400, json: { error: "expired_token" } }, {});
  ck("expired_token 判为 expired", exp.status === "expired");
  const other = judgeClineToken({ status: 500, json: { error_description: "boom" } }, {});
  ck("其它错误给可归因信息且不算 success",
    other.status === "pending" && /boom/.test(other.message || ""), JSON.stringify(other));
}

/* ============ ⑦ 凭据生命周期（刷新）============ */
console.log("\n=== ⑦ 凭据刷新 ===");
{
  const a = await import("../src/services/upstream/cline.js");
  ck("导出 refreshAuth", typeof a.refreshAuth === "function");
  ck("导出 importAuth（粘贴 refreshToken 用）", typeof a.importAuth === "function");

  const src = readFileSync(new URL("../src/services/upstream/cline.js", import.meta.url), "utf8");
  ck("刷新走官方 /auth/refresh", /api\/v1\/auth\/refresh/.test(src));
  ck("刷新用 {refreshToken, grantType} 契约（实测形状）",
    /refreshToken, grantType: "refresh_token"/.test(src));
  ck("复用 withRefreshLock（并发刷新合并成一次）", /withRefreshLock\(channel/.test(src));
  ck("复用 persistOtherPatch + cred_epoch（人工换凭据不被覆盖）",
    /persistOtherPatch\(/.test(src) && /cred_epoch/.test(src));
  ck("提前 5 分钟刷新（不踩过期边界）", /expiresSoon/.test(src));
  ck("服务端装饰时删掉重复的 content-type/authorization（逗号拼接会 401）",
    /delete extra\["content-type"\]/.test(src) && /delete extra\.authorization/.test(src));
  ck("有旧 token 时刷新失败不阻断请求", /继续用现有 token/.test(src));

  const decorated = a.withClineHeaders({ id: 1, other: {} });
  const h = decorated.other.extra_headers;
  ck("标识头里没有 content-type / authorization",
    !("content-type" in h) && !("authorization" in h) && !("Authorization" in h));
}

/* ============ ⑧ 两种接入方式并存 ============ */
console.log("\n=== ⑧ 接入方式（一键绑定 + API Key 并存）===");
{
  const { getMethod, publicProviders } = await import("../src/services/channel-types.js");
  const p = publicProviders().find((x) => x.key === "cline");
  const keys = p.methods.map((m) => m.key);
  ck("同时提供 cli（一键绑定）与 api（API Key）两条路",
    keys.includes("cli") && keys.includes("api"), JSON.stringify(keys));

  const cli = getMethod("cline", "cli");
  ck("cli 方式声明 adapter: cline（走凭据生命周期）", cli?.adapter === "cline");
  ck("cli 方式带默认模型（否则绑定后无可选模型）",
    (cli?.defaultModels || []).length >= 5, String((cli?.defaultModels || []).length));
  const api = getMethod("cline", "api");
  ck("api 方式仍保留默认模型", (api?.defaultModels || []).length >= 5);
  ck("两种方式的默认模型一致（同一账号体系）",
    JSON.stringify((cli.defaultModels || []).map((m) => m.id).sort()) ===
      JSON.stringify((api.defaultModels || []).map((m) => m.id).sort()));

  const { DEFAULT_PRICES } = await import("../src/services/pricing.js");
  const priced = new Set(DEFAULT_PRICES.map((x) => String(x.model).toLowerCase()));
  const isPriced = (model) => {
    const t = String(model || "").toLowerCase();
    const st = t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t;
    if (priced.has(t) || priced.has(st)) return true;
    for (const k of [t, st]) for (const pr of priced) if (k.startsWith(pr)) return true;
    return false;
  };
  for (const mkey of ["cli", "api"]) {
    const mm = getMethod("cline", mkey);
    const unpriced = (mm.defaultModels || []).map((x) => x.id).filter((i) => !isPriced(i));
    ck(`${mkey} 方式全部默认模型都能过定价门禁`, unpriced.length === 0, unpriced.join(", "));
    ck(`${mkey} 方式的 testModel 已定价`, isPriced(mm.testModel), String(mm.testModel));
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
