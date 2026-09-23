// 上游适配器：Cline（cline.bot）
// ===========================================================================
// Cline 官方提供标准 OpenAI 兼容 API，所以对话链路本身是 openai-compat；
// 本适配器负责的是**凭据生命周期**与两处兼容：
//
//   ① 客户端标识头（上游对无标识的请求会拒）
//   ② 响应的 `data` 包封解包（其 SDK 定义里带 responseEnvelope: "success-data"）
//
// ── 凭据体系（2026-09-23 实测，端点契约均已真实探测）─────────────────────────
// Cline 的账号建在 **WorkOS AuthKit** 上（client_id 取自其开源 SDK
// `sdk/packages/shared/src/runtime/cline-environment.ts`）。设备授权是
// 标准 RFC 8628：
//   ① POST https://api.workos.com/user_management/authorize/device  {client_id}
//      → 实测 200：{device_code, user_code, verification_uri: authkit.cline.bot/device,
//                   verification_uri_complete, expires_in: 300, interval: 5}
//   ② POST https://api.workos.com/user_management/authenticate
//      {client_id, device_code, grant_type: urn:ietf:params:oauth:grant-type:device_code}
//      → 未授权实测 400 {error:"authorization_pending"}（标准语义，要继续轮询）
//      → 授权完成返回 WorkOS 的 access_token / refresh_token
//   ③ POST https://api.cline.bot/api/v1/auth/refresh  {refreshToken, grantType}
//      → 坏 token 实测 400 {error:"failed to refresh token: invalid_grant"}
//        （语义正确 ⇒ 有真 refreshToken 即可换取新 accessToken）
//
// 两种凭据入口都支持：
//   · 一键绑定（设备授权）：用户点一下 → 打开 authkit.cline.bot/device 输码 → 自动写入
//   · 粘贴 refreshToken：手上已有 token 时直接粘（也接受完整 JSON）
import * as compat from "./openai-compat.js";
import { persistOtherPatch, withRefreshLock } from "./auth-store.js";

const API_BASE = "https://api.cline.bot";
const REFRESH_URL = `${API_BASE}/api/v1/auth/refresh`;
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

/**
 * 官方客户端标识头。
 *
 * 来源：Cline 开源源码 `sdk/packages/llms/src/providers/request-headers.ts`
 * （`DEFAULT_CLINE_REQUEST_HEADERS` + `buildClineRequestHeaders`）。
 * 官方文档把 HTTP-Referer / X-Title / X-Task-ID 标为「可选（统计用）」，
 * 但社区实测报告：没有客户端标识的请求会收到
 * 403 `only available via Cline product surfaces`。
 *
 * 这与 WorkBuddy 的 `x-codebuddy-request`、Kiro 的 `KiroIDE-<指纹>` UA 是同一类东西：
 * **带上官方标识反而降低风控概率** —— 不带标识的裸请求才像异常客户端。
 */
export const CLINE_HEADERS = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "OOAPI",
  "X-IS-MULTIROOT": "false",
  "X-CLIENT-TYPE": "cline-sdk",
};

/** 给渠道补上客户端标识头（不覆盖渠道自己配的同名头） */
export function withClineHeaders(channel) {
  const o = channel?.other || {};
  const extra = o.extra_headers && typeof o.extra_headers === "object" ? o.extra_headers : {};
  const ua = String(o.client_user_agent || "").trim();
  return {
    ...channel,
    other: {
      ...o,
      extra_headers: {
        ...CLINE_HEADERS,
        // UA 可被渠道覆盖（上游可能按 UA 里的版本号校验）
        ...(ua ? { "user-agent": ua } : {}),
        // 渠道自定义头放最后：显式配置优先于我们的默认值
        ...extra,
      },
    },
  };
}

/**
 * 解包可能的 `data` 包封。
 *
 * 背景：Cline 官方 SDK 的 provider 定义里带 `responseEnvelope: "success-data"`，
 * 社区 issue #12647 报告**非流式**回复会把 choices 包在 `data` 里
 * （`{success:true, data:{choices:[...]}}`）。
 *
 * 我们始终用 `stream:true` 请求，受影响面很小；但解包成本极低且能兼容两种形状。
 * 判定保守：**只有顶层没有 choices、而 data 里有 choices 时**才解包。
 */
export function unwrapEnvelope(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj.choices)) return obj; // 标准形状，原样返回
  const inner = obj.data;
  if (inner && typeof inner === "object" && Array.isArray(inner.choices)) {
    // 保留外层可能带的 usage（有些实现把它放外层）
    return { ...inner, usage: inner.usage ?? obj.usage };
  }
  return obj;
}

/** 解析粘贴的凭据：refreshToken / accessToken / 完整 JSON 都接受 */
export async function importAuth(input = {}) {
  const raw = String(typeof input === "string" ? input : (input.token ?? input.json ?? "")).trim();
  if (!raw) throw Object.assign(new Error("粘贴内容为空"), { code: "LOGIN_BAD_PARAMS" });

  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = null;
  }
  const pick = (t) =>
    String(
      t?.refreshToken || t?.refresh_token || t?.accessToken || t?.access_token || t?.token || ""
    ).trim();

  let refreshToken = "";
  let accessToken = "";
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const t = obj.tokens || obj.credential || obj.data || obj;
    refreshToken = String(t.refreshToken || t.refresh_token || "").trim();
    accessToken = String(t.accessToken || t.access_token || t.token || "").trim();
  } else {
    // 裸 token：无法区分类型时按 refreshToken 处理（更通用：它能换出 access）
    refreshToken = raw;
  }
  if (!refreshToken && !accessToken) {
    throw Object.assign(
      new Error("没有解析到凭据（请粘贴 Cline 的 refreshToken，或一键绑定）"),
      { code: "LOGIN_BAD_PARAMS" }
    );
  }
  // 提示：官方签发的 API Key 请用「API Key」那种接入方式 —— 这里期望的是
  // OAuth 的 refresh/access token 对，拿 API Key 过来会被送去刷新并得到一个
  // 令人困惑的 invalid_grant（上面的报错里已说明该怎么做）。

  // 拿到 refreshToken 就立刻换一次 accessToken：确认凭据真的可用，
  // 而不是先建成渠道、等第一次调用才发现是坏的（WorkBuddy 踩过这个坑：
  // 假凭据能通过校验并建成渠道，但永远 401）。
  let finalAccess = accessToken;
  let expiresAt = 0;
  if (refreshToken) {
    const r = await exchangeRefreshToken(refreshToken).catch((e) => {
      throw Object.assign(new Error(`凭据校验失败：${e.message}`), { code: "CHANNEL_AUTH_EXPIRED" });
    });
    finalAccess = r.access_token || finalAccess;
    expiresAt = r.expires_at || 0;
  }

  return {
    token: finalAccess,
    other: {
      access_token: finalAccess,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      client_id: WORKOS_CLIENT_ID,
      endpoint: API_BASE,
    },
    accountLabel: "Cline",
  };
}

/** 用 refreshToken 换新的 accessToken（实测端点契约正确） */
async function exchangeRefreshToken(refreshToken) {
  const resp = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLINE_HEADERS, accept: "application/json" },
    body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
  });
  const text = await resp.text().catch(() => "");
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* 保留原文供报错 */
  }
  if (!resp.ok) {
    const detail = j?.error || j?.message || text.slice(0, 160) || `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  // 响应同样可能带 data 包封
  const d = unwrapEnvelope(j) || {};
  const t = d.tokens || d.data || d;
  const access = String(t.accessToken || t.access_token || "").trim();
  if (!access) throw new Error("刷新响应里没有 accessToken");
  return {
    access_token: access,
    expires_at: Math.floor(Date.now() / 1000) + (Number(t.expiresIn || t.expires_in) || 3600),
  };
}

/** 是否快过期（提前 5 分钟刷新，避免踩在边界上） */
function expiresSoon(other) {
  const exp = Number(other?.expires_at || 0);
  return exp > 0 && exp - Math.floor(Date.now() / 1000) < 300;
}

/**
 * 刷新并写回。
 *
 * 与 kiro/grok 等共用 auth-store 的两件保障：
 *   · withRefreshLock：同渠道并发刷新合并成一次（否则多请求同时刷新会让
 *     refresh_token 连续轮换，看起来像异常客户端）；
 *   · persistOtherPatch + cred_epoch：管理员人工换过凭据时不覆盖新凭据。
 */
export async function refreshAuth(channel, { force = false } = {}) {
  return withRefreshLock(channel, async () => {
    const other = channel?.other || {};
    if (!force && other.access_token && !expiresSoon(other)) {
      return { access_token: String(other.access_token), expires_at: Number(other.expires_at) || 0 };
    }
    const rt = String(other.refresh_token || "").trim();
    if (!rt) {
      throw Object.assign(new Error("凭据里没有 refreshToken，请重新一键绑定或粘贴凭据"), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    const fresh = await exchangeRefreshToken(rt);
    await persistOtherPatch(
      channel.id,
      { access_token: fresh.access_token, expires_at: fresh.expires_at, cred_updated_at: Math.floor(Date.now() / 1000) },
      Number(other.cred_epoch) || 0
    );
    // 同步到当前对象：调用方接下来就用它发请求，不必重新查库
    if (channel.other) {
      channel.other.access_token = fresh.access_token;
      channel.other.expires_at = fresh.expires_at;
    }
    return fresh;
  });
}

/**
 * 该渠道用的是哪种凭据。
 *
 * 必须区分，否则会出**真实故障**（上线后立刻被用户撞到）：
 *   · `api` 方式：凭据是官方签发的 API Key，存在 `channel.api_key` 里，
 *     **不参与刷新**（它不是 OAuth access token，没有 refreshToken）；
 *   · `cli` 方式（一键绑定）：凭据是 WorkOS 的 access/refresh 对，存在 `other` 里，
 *     access 过期要用 refresh 换新的。
 *
 * 早先这里只看 `other.access_token`，于是 API Key 渠道被判成「需要刷新」→
 * 找不到 refresh_token → 抛「凭据里没有 refreshToken，请重新一键绑定」。
 * 用户的 API Key 完全正常，却收到「没有 RT 凭证」的矛盾提示。
 */
function credentialKind(channel) {
  const method = String(channel?.other?.method || "");
  // 显式声明了方法就按方法走；老渠道没有 method 时按凭据形态兜底推断
  if (method === "api") return "apikey";
  if (method === "cli") return "oauth";
  return channel?.other?.refresh_token ? "oauth" : "apikey";
}

/** 拿到可用的 bearer token（OAuth 方式快过期时先刷新；API Key 方式直接用） */
async function ensureToken(channel) {
  const other = channel?.other || {};
  if (credentialKind(channel) === "apikey") {
    // API Key 直接用它本身；不动 other 里的字段（避免旧渠道残留的 access_token
    // 把新填的 Key 顶掉 —— 那会让管理员「改了 Key 却不生效」）
    const key = String(channel?.api_key || "").trim();
    if (!key) {
      throw Object.assign(new Error("未填写 Cline API Key"), { code: "CHANNEL_AUTH_EXPIRED" });
    }
    return key;
  }
  if (!other.access_token || expiresSoon(other)) {
    await refreshAuth(channel, { force: !other.access_token }).catch((e) => {
      if (!other.access_token) throw e;
      // 有可用的旧 token 时，刷新失败不该让请求直接失败（上游偶尔 5xx）
      console.warn(`[cline] 提前刷新失败（继续用现有 token）：${e.message}`);
    });
  }
  return String(channel?.other?.access_token || "");
}

/**
 * 装饰成 openai-compat 需要的形态。
 * 注意 **不能重复设置 content-type / authorization** —— Fetch 对同名头是
 * **逗号拼接**而不是覆盖，重复会让 `Bearer A` 变成 `Bearer A, Bearer A`，
 * 上游必然 401（WorkBuddy 排查了很久的坑）。
 */
async function decorated(channel) {
  const token = await ensureToken(channel);
  const withH = withClineHeaders({ ...channel, api_key: token });
  const extra = { ...(withH.other?.extra_headers || {}) };
  delete extra["content-type"];
  delete extra.authorization;
  delete extra.Authorization;
  delete extra["Content-Type"];
  return { ...withH, other: { ...withH.other, extra_headers: extra } };
}

export async function chat(args) {
  return compat.chat({
    ...args,
    channel: await decorated(args.channel),
    unwrap: unwrapEnvelope,
  });
}

export async function verify(channel) {
  return compat.verify(await decorated(channel));
}

export async function fetchUpstreamModels(channel) {
  // `/models` 无需鉴权，但带上 token 也无妨（带 token 时可能返回该账号可用子集）
  return compat.fetchUpstreamModels(await decorated(channel));
}

export function loginModes() {
  return ["paste"];
}
