// 上游适配器：腾讯 WorkBuddy / CodeBuddy（桌面端/CLI 凭据反代）
// ===========================================================================
// 协议：**OpenAI 兼容，但端点带 /v2 前缀**（不是 /v1）——
//   POST {域}/v2/chat/completions                 对话（SSE）
//   GET  {域}/v3/config                           模型清单（含 credits 倍率）
//   POST {billing域}/v2/billing/meter/get-user-resource   积分余额
//
// 这三个都是**实测确认**的（2026-09-22，用真实账号跑通 glm-5.3 / deepseek-v4.1-flash
// / kimi-k3 三个模型均为 HTTP 200、正文正确）：
//   · `/v1/chat/completions`、`/v1/models`、`/v2/plugin/models`、`/v2/plugin/chat/*`
//     全部 **404** —— 早期版本按社区文档把端点写成 `/v1`，
//     于是「绑定成功但一检测就 404」（用户实测反馈）。
//   · 对话**必须流式**（stream:true）；非流式由网关侧聚合。
//
// 三个硬约束（不满足就被上游拒，报错原文写在下面注释里）：
//   ① **首条消息必须是 system**，否则 400 `code 11128 first message is not system prompt`；
//   ② **域必须与账号 realm 一致**：凭据 JWT 的 `iss` 决定 ——
//      `www.workbuddy.ai` / `www.codebuddy.ai`（国际）vs
//      `copilot.tencent.com` / `www.codebuddy.cn`（国内）。
//      域错了会被 APISIX 网关直接 401（返回 HTML 而非 JSON），
//      **而这个 401 极像「token 过期」** —— 实测踩过：token 有效期到 2027 年
//      却一直 401，真实原因只是打错了域。故 realm 由 token 自己判定，不靠用户填。
//   ③ UA 必须**双段**（`CLI/2.117.2 CodeBuddy/2.117.2`），
//      单段会被 `/v3/config` 以 `code 12403` 拒。
//
// 另：`device_token` 不是必需项（官方 CLI 整包零命中该头，社区实现也都优雅降级），
// 绑定路径拿不到它不影响可用性 —— 保留可选注入，但不为它设计获取流程。
import * as compat from "./openai-compat.js";

const CN_BASE = "https://copilot.tencent.com";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CN_BILLING = "https://www.codebuddy.cn";
const CLI_VER = "2.117.2";

/** 兼容多种导出形态的凭据解析（桌面端 info / CLI auth.json / 设备绑定产物） */
export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    // 也接受「直接粘贴一整个 token 字符串」
    if (text && !text.startsWith("{")) {
      return { access_token: text, refresh_token: "", device_token: "", user_id: "", enterprise_id: "", endpoint: "" };
    }
    throw Object.assign(new Error("凭据不是合法 JSON（请粘贴 WorkBuddy 桌面端凭据）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const t = j.tokens || j.token_data || j.credentials || j;
  const access_token = String(
    t.access_token || t.accessToken || t.token || t.auth_token || j.access_token || j.accessToken || j.token || ""
  ).trim();
  const refresh_token = String(t.refresh_token || t.refreshToken || j.refresh_token || j.refreshToken || "").trim();
  const device_token = String(
    t.device_token || t.deviceToken || j.device_token || j.deviceToken || j["X-Device-Token"] || ""
  ).trim();
  const user_id = String(t.user_id || t.userId || j.user_id || j.userId || j.uid || j["X-User-Id"] || "").trim();
  const enterprise_id = String(
    t.enterprise_id || t.enterpriseId || j.enterprise_id || j.enterpriseId || j["X-Enterprise-Id"] || ""
  ).trim();
  // endpoint 的几种来源都要认：手工粘贴常用 endpoint/base_url，
  // 一键绑定产出的是 `domain`（见 device-bind.js 的 judgeWorkbuddyToken）——
  // 不认 domain 会让绑定凭据被当成「没有地址」，进而落到错误的域。
  const domain = String(t.domain || j.domain || "").trim();
  const endpoint = String(
    t.endpoint || j.endpoint || j.base_url || j.baseUrl ||
    (domain ? `https://${domain.replace(/^https?:\/\//, "")}` : "")
  ).trim().replace(/\/+$/, "");
  if (!access_token) {
    throw Object.assign(new Error("凭据里没有 access_token（请粘贴 WorkBuddy 桌面端凭据文件）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  return { access_token, refresh_token, device_token, user_id, enterprise_id, endpoint };
}

/**
 * 从 access_token（JWT）的 `iss` 判定账号属于国际版还是国内版。
 *
 * 为什么必须判：域错了会被网关 401（HTML），而 token 本身完全有效，
 * 错误信息会把人引向「重新登录」这个错误方向（实测踩过）。
 * JWT 解不开时（非 JWT token）回退：看 endpoint，再默认国内。
 */
export function realmOf(token, endpoint = "") {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    const iss = String(payload?.iss || "").toLowerCase();
    if (iss.includes("workbuddy.ai") || iss.includes("codebuddy.ai")) return "global";
    if (iss.includes("codebuddy.cn") || iss.includes("tencent.com")) return "cn";
  } catch {
    /* 非 JWT：走下面的兜底 */
  }
  const ep = String(endpoint || "").toLowerCase();
  if (ep.includes("workbuddy.ai") || ep.includes("codebuddy.ai")) return "global";
  return "cn";
}

/** realm → { api, billing, host, locale } */
export function realmEndpoints(realm) {
  return realm === "global"
    ? { api: GLOBAL_BASE, billing: GLOBAL_BASE, host: "www.workbuddy.ai", locale: "en-US" }
    : { api: CN_BASE, billing: CN_BILLING, host: "www.codebuddy.cn", locale: "zh-CN" };
}

/**
 * 上游要求的完整头组（实测最小可用集）。
 * 缺 `X-CodeBuddy-Request`、UA 不是双段、Origin 与 realm 不同域 —— 都会被拒。
 */
export function buildHeaders({ token, userId, enterpriseId, deviceToken, realm, sse = false }) {
  const e = realmEndpoints(realm);
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: sse ? "application/json, text/event-stream" : "application/json",
    "accept-language": e.locale,
    "x-requested-with": "XMLHttpRequest",
    // 风控闸门头：官方文档写明「所有 API 请求必须携带」
    "x-codebuddy-request": "1",
    "x-domain": e.host,
    "x-product": "SaaS",
    "x-ide-type": "CLI",
    "x-ide-name": "CLI",
    "x-ide-version": CLI_VER,
    "x-agent-intent": "craft",
    "x-agent-purpose": "conversation",
    // UA 必须双段：单段会被 /v3/config 以 code 12403 拒
    "user-agent": `CLI/${CLI_VER} CodeBuddy/${CLI_VER}`,
    origin: `https://${e.host}`,
    referer: `https://${e.host}/`,
    ...(userId ? { "x-user-id": String(userId) } : {}),
    // 无企业时明确发 X-No-Enterprise-Id（社区实现的一致做法，比留空稳）
    ...(enterpriseId ? { "x-enterprise-id": String(enterpriseId) } : { "x-no-enterprise-id": "1" }),
    ...(deviceToken ? { "x-device-token": String(deviceToken) } : {}),
  };
}

/** 渠道凭据 → 统一形态（含 realm 判定） */
function credsOf(channel) {
  const o = channel?.other || {};
  const token = String(o.access_token || channel?.api_key || "").trim();
  return {
    token,
    userId: String(o.user_id || "").trim(),
    enterpriseId: String(o.enterprise_id || "").trim(),
    deviceToken: String(o.device_token || "").trim(),
    // 优先用落库的 realm；老渠道没有该字段时按 token 现场判定
    realm: o.realm === "global" || o.realm === "cn" ? o.realm : realmOf(token, o.endpoint || channel?.base_url),
  };
}

export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  const realm = realmOf(cred.access_token, cred.endpoint);
  const e = realmEndpoints(realm);
  return {
    token: cred.access_token,
    other: {
      access_token: cred.access_token,
      refresh_token: cred.refresh_token,
      device_token: cred.device_token,
      user_id: cred.user_id,
      enterprise_id: cred.enterprise_id,
      // 存 realm 而不是 endpoint：判域依据是账号 realm，
      // 而 endpoint 可能被填成任意中转地址
      realm,
      endpoint: e.api,
    },
    accountLabel: cred.user_id ? `WorkBuddy · ${cred.user_id}` : "WorkBuddy",
  };
}

/**
 * 装饰成 openai-compat 需要的形态。
 * base_url 指向 `{域}/v2` —— openai-compat 会自行拼 `/chat/completions`，
 * 而上游真实端点是 `/v2/chat/completions`（**不是 /v1**）。
 */
function decorated(channel) {
  const c = credsOf(channel);
  const e = realmEndpoints(c.realm);
  return {
    ...channel,
    base_url: `${e.api}/v2`,
    api_key: c.token,
    other: {
      ...(channel?.other || {}),
      // extra_headers 由 openai-compat 合并进请求头（它会再叠加大写的
      // `Content-Type` 与 `Authorization`）。
      //
      // **这两个头绝不能放在这里**：Fetch 的 Headers 把头名归一后，
      // 同名头的值会被**逗号拼接**而不是覆盖 —— 实测：
      //   {"authorization":"Bearer A","Authorization":"Bearer B"}
      //   → 实际发出 `authorization: "Bearer A, Bearer B"`
      // 上游收到两段 Bearer，必然 401（返回 HTML，极像 token 失效）。
      // 这个坑排查了很久：同一 token 手打 curl 是 200，走适配器就 401，
      // 差异只在「有没有重复设置这两个头」。
      // 所以这里只放兼容层不会设置的那些头。
      extra_headers: (() => {
        const h = buildHeaders({ ...c, sse: true });
        delete h["content-type"];
        delete h.authorization;
        return h;
      })(),
    },
  };
}

/**
 * 首条消息必须是 system —— 缺就补一个中性 system。
 * 上游原文报错：400 `code 11128 first message is not system prompt`。
 * 另外 `developer` 角色会被安全策略拦（11128），这里一并映射成 system。
 */
function ensureSystemFirst(messages, prompt) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m === "object")
    .map((m) => (m.role === "developer" ? { ...m, role: "system" } : m));
  if (!list.length) {
    return [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: String(prompt || "") },
    ];
  }
  if (list[0].role !== "system") {
    list.unshift({ role: "system", content: "You are a helpful assistant." });
  }
  return list;
}

export async function chat(args) {
  return compat.chat({
    ...args,
    channel: decorated(args.channel),
    messages: ensureSystemFirst(args.messages, args.prompt),
  });
}

/* ---------------------------------------------------------------------------
   模型清单：GET {域}/v3/config（不是 OpenAI 的 /v1/models）
   --------------------------------------------------------------------------- */
export async function fetchUpstreamModels(channel) {
  const c = credsOf(channel);
  const e = realmEndpoints(c.realm);
  const resp = await fetch(`${e.api}/v3/config`, {
    headers: buildHeaders(c),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`拉取模型失败（HTTP ${resp.status}）`);
  const j = await resp.json();
  const models = j?.data?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => m && m.id)
    // 过滤不可对话档位（选了会被上游以 11102 拒）：图像/视频/补全类
    .filter((m) => !/image|video|nes-|completion-/i.test(String(m.id)) && !(m.tags || []).includes("text-to-image"))
    .map((m) => String(m.id));
}

/**
 * 模型单价 —— **该厂商自己的计价口径**（与平台定价无关）。
 *
 * WorkBuddy 是**积分制**：`/v3/config` 的每个模型带 `credits` 字段
 * （实测形如 `"x0.79 credits"`），这就是跑一次该模型的消耗倍率。
 * 前端在「模型」列的悬浮里显示它 —— 用户要的是「这个模型对当前厂商
 * 消费多少」，而不是我们平台收多少。
 *
 * 返回 { "<model-id>": { text, unit } }；拿不到就返回空对象（前端不显示价格）。
 */
export async function fetchUpstreamPrices(channel) {
  const c = credsOf(channel);
  const e = realmEndpoints(c.realm);
  const resp = await fetch(`${e.api}/v3/config`, {
    headers: buildHeaders(c),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) return {};
  const j = await resp.json();
  const models = Array.isArray(j?.data?.models) ? j.data.models : [];
  const out = {};
  for (const m of models) {
    if (!m?.id) continue;
    // credits 形如 "x0.79 credits" / "x2.00 credits" —— 原样透出，
    // 但把单位抽出来供前端加图标（积分/美元是两种不同的东西）。
    const raw = String(m.credits || "").trim();
    if (!raw) continue;
    out[String(m.id)] = { text: raw, unit: /credit/i.test(raw) ? "credits" : "money" };
  }
  return out;
}

/** 渠道可用性：打 /v3/config（轻量、不计费），顺带验证 realm 是否正确 */
export async function verify(channel) {
  const c = credsOf(channel);
  if (!c.token) throw Object.assign(new Error("未填写 WorkBuddy 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  const e = realmEndpoints(c.realm);
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(`${e.api}/v3/config`, { headers: buildHeaders(c), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw Object.assign(new Error(`无法连接 WorkBuddy 上游：${err.message}`), { code: "CHANNEL_NETWORK" });
  }
  if (resp.status === 401 || resp.status === 403) {
    // 401 有两种成因（token 失效 / 域与账号不匹配），都要说清；
    // 只说「鉴权失败」会把人引向「重新登录」，而实际可能只是域错了。
    throw Object.assign(
      new Error(
        `WorkBuddy 拒绝鉴权（HTTP ${resp.status}）。本次按「${c.realm === "global" ? "国际版" : "国内版"}」域请求；` +
          `若账号其实是另一版本，重新绑定即可（域不匹配时也会 401，且 token 本身可能仍然有效）`
      ),
      { code: "CHANNEL_AUTH_EXPIRED" }
    );
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw Object.assign(new Error(`上游返回 HTTP ${resp.status}${body ? `：${body.slice(0, 160)}` : ""}`), {
      code: "CHANNEL_HTTP_ERROR",
    });
  }
  return Date.now() - t0;
}

/* ---------------------------------------------------------------------------
   积分余额（用户明确反馈：「WorkBuddy 人家有积分制，为什么额度这里显示不支持」）
   --------------------------------------------------------------------------- */
/**
 * 查积分：POST {billing域}/v2/billing/meter/get-user-resource
 *
 * 实测响应关键字段：
 *   TotalDosage                          总量（积分）
 *   Accounts[].CycleCapacity{Size,Remain,Used}  当期套餐包的量与余量
 *   Accounts[].Capacity{Size,Remain,Used}       非 Cycle 时的回退字段
 * 聚合口径与社区实现一致：Cycle 优先，回退非 Cycle，TotalDosage 作下限。
 *
 * billing 域与 api 域可能不同：国内 api 在 copilot.tencent.com、
 * billing 在 www.codebuddy.cn；国际两者同为 www.workbuddy.ai。
 */
export async function fetchCredits(channel) {
  const c = credsOf(channel);
  const e = realmEndpoints(c.realm);
  const resp = await fetch(`${e.billing}/v2/billing/meter/get-user-resource`, {
    method: "POST",
    headers: {
      ...buildHeaders(c),
      // billing 用单段 UA（与 chat 的双段不同，两者各自实测可用）
      "user-agent": `WorkBuddy/${CLI_VER}`,
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: new Date().toISOString().slice(0, 19).replace("T", " "),
      PackageEndTimeRangeEnd: "2127-01-01 00:00:00",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`查询积分失败（HTTP ${resp.status}）`), { code: "CHANNEL_HTTP_ERROR" });
  }
  const j = await resp.json();
  const data = j?.data?.Response?.Data || {};
  const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];

  let size = 0;
  let remain = 0;
  const lines = [];
  for (const a of accounts) {
    const cSize = Number(a.CycleCapacitySize);
    const cRemain = Number(a.CycleCapacityRemain);
    const cUsed = Number(a.CycleCapacityUsed);
    let s;
    let r;
    if (Number.isFinite(cSize) && cSize > 0) {
      s = cSize;
      r = Math.max(0, Math.min(Number.isFinite(cRemain) ? cRemain : cSize, cSize));
    } else {
      s = Number(a.CapacitySize) || 0;
      const r2 = Number(a.CapacityRemain);
      const u2 = Number(a.CapacityUsed) || 0;
      r = Math.max(0, Math.min(Number.isFinite(r2) ? r2 : s - u2, s));
    }
    size += s;
    remain += r;
    const name = String(a.PackageName || a.DealName || "积分包");
    lines.push({
      label: name,
      total: Math.round(r * 100) / 100,
      ...(s ? { limit: Math.round(s * 100) / 100 } : {}),
      ...(Number.isFinite(cUsed) && cUsed > 0 ? { used: Math.round(cUsed * 100) / 100 } : {}),
    });
  }
  const total = Number(data.TotalDosage);
  if (Number.isFinite(total) && total > size) size = total;
  const used = Math.max(0, size - remain);

  return {
    credits: {
      ...(lines.length ? { lines } : {}),
      balance: Math.round(remain * 100) / 100,
      limit: Math.round(size * 100) / 100,
      used: Math.round(used * 100) / 100,
      unit: "积分",
    },
    plan: "",
    account: String(c.userId || ""),
    windows: size > 0
      ? [{
          label: "积分余额",
          key: "credits",
          usedPercent: (used / size) * 100,
          limit: size,
          used,
          remaining: remain,
          note: `共 ${size} 积分，剩 ${remain}`,
        }]
      : [],
  };
}

/** 该适配器支持的登录方式：订阅型凭据统一「粘贴 JSON」（一键绑定走设备授权） */
export function loginModes() {
  return ["paste"];
}
