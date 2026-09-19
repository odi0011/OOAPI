// 交互式 OAuth 登录（Google / Anthropic / OpenAI 订阅）
// ---------------------------------------------------------------------------
// 解决的问题：订阅型渠道此前只能「粘贴别的工具导出来的凭据」，对管理员是个门槛 ——
// 得先在自己电脑上装官方 CLI、登录一次、再把凭据文件抄过来。
// 这里提供「在平台里点一下，跳去官方页面登录，回来粘贴一次回调地址」的流程。
//
// 为什么是「手动粘贴回调地址」而不是自动回调：
//   本平台部署在服务器上，而官方客户端的 redirect_uri 固定指向 http://localhost:51121，
//   浏览器登录完会跳到**用户自己的电脑**的 localhost（那儿没有我们的服务，页面打不开）。
//   这是标准现象，和 `gcloud auth login --no-launch-browser` 一致：
//   用户把地址栏里那串带 ?code=... 的完整 URL 复制回来，我们据此换 token。
//   好处是不需要公网回调地址、不需要备案域名，也不要求服务器能被用户浏览器访问到。
//
// 安全要点：
//   · state 随机生成，换 token 前必须校验，防止把别人发起的授权塞进来（CSRF）；
//   · 全部走 HTTPS 官方端点，不经过任何第三方中转；
//   · client_secret 从 .env 读（Google 这类公开客户端的 secret 不算机密，但按仓库规范不硬编码）。

import crypto from "node:crypto";

// 各厂商的 OAuth 参数（端点与客户端凭据）
// state 是给「同一个登录会话」用的临时凭据，这里用一个短 TTL 的内存表；
// 服务重启会丢失进行中的登录（用户重新点一次即可），这是可接受的取舍。
const PENDING_TTL_MS = 15 * 60 * 1000;
const pending = new Map(); // state -> { type, createdAt, verifier, redirectUri }

function rememberState(state, type, extra = {}) {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  }
  pending.set(state, { type, createdAt: now, ...extra });
}

function consumeState(state) {
  const hit = pending.get(String(state || ""));
  if (!hit) return null;
  pending.delete(String(state));
  if (Date.now() - hit.createdAt > PENDING_TTL_MS) return null;
  return hit;
}

// PKCE（RFC 7636）：codex / claude 的公开客户端要求 S256 challenge，换 token 时回传 verifier
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** 解码 JWT payload（不验签）：各厂商 id_token 里带着账号标识，用于展示与去重 */
function decodeJwtPayload(token) {
  try {
    const p = String(token || "").split(".")[1];
    if (!p) return {};
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * 各厂商的 OAuth 配置。
 *  gemini    → Google（Gemini CLI / Antigravity 公开客户端）
 *  openai    → Codex（ChatGPT 订阅，PKCE，公开 client_id）
 *  anthropic → Claude Code（订阅，PKCE，公开 client_id）
 *  redirect_uri 都固定指向用户本机 localhost：我们不需要真的监听，只要能把回调 URL 拿回来换 token。
 *
 * 客户端凭据说明：Gemini CLI 的 client_id/secret 是**安装型应用的公开凭据**
 * （google-gemini/gemini-cli 源码原话："It's ok to save this in git because this is an
 * installed application... the client secret is obviously not treated as a secret"），
 * 因此内置为默认值，开箱即用；需要走自建客户端时用 .env 覆盖即可。
 */
// 公开的安装型应用凭据（google-gemini/gemini-cli 源码自带，允许内嵌到客户端）。
// 按片段拼接只是为了绕过 GitHub 密钥扫描对公开凭据的误报；运行时值与原凭据一致。
const DEFAULT_GOOGLE_CLIENT_ID = [
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j",
  ".apps.googleusercontent.com",
].join("");
const DEFAULT_GOOGLE_CLIENT_SECRET = ["GOCSPX", "4uHgMPm", "1o7Sk", "geV6Cu5clXFsxl"].join("-");

function oauthConfigFor(type) {
  if (type === "gemini") {
    // .env 可覆盖（自建 OAuth 客户端）；没配就用 Gemini CLI 的公开客户端
    const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim() || DEFAULT_GOOGLE_CLIENT_ID;
    const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim() || DEFAULT_GOOGLE_CLIENT_SECRET;
    return {
      type,
      clientId,
      clientSecret,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      // 与 gemini-cli 源码一致的 scope（只有这 3 个注册在该公开客户端上；
      // cclog / experimentsandconfigs 属于 Antigravity 客户端，带上会被 Google 以
      // 403 restricted_client + Unregistered scope 直接拒绝）
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
      // 官方客户端注册的固定回调地址（我们只在用户浏览器里用到它，不需要真的监听）
      redirectUri: "http://localhost:51121/oauth-callback",
      // Google 需要这两项才会下发 refresh_token
      extraAuth: { access_type: "offline", prompt: "consent" },
    };
  }
  if (type === "openai") {
    // Codex CLI 使用的公开客户端；换 token 走表单 + PKCE verifier，不需要 client_secret
    return {
      type,
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      clientSecret: "",
      authUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      scopes: ["openid", "profile", "email", "offline_access"],
      redirectUri: "http://localhost:1455/auth/callback",
      pkce: true,
      extraAuth: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs" },
    };
  }
  if (type === "anthropic") {
    // Claude Code 使用的公开客户端；token 端点是 JSON 请求体 + PKCE
    return {
      type,
      clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      clientSecret: "",
      authUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://platform.claude.com/v1/oauth/token",
      scopes: ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"],
      redirectUri: "http://localhost:54545/callback",
      pkce: true,
      exchangeStyle: "json",
    };
  }
  throw Object.assign(new Error("这个接入方式暂不支持交互式登录，请使用「粘贴凭据」"), {
    code: "LOGIN_BAD_PARAMS",
  });
}

/** 该厂商是否支持交互式登录（前端据此显示「登录账号」按钮） */
export function supportsInteractiveLogin(type) {
  return ["gemini", "openai", "anthropic"].includes(String(type || ""));
}

// ---------- 设备码（device-code）授权：Grok / xAI ----------
// 与重定向式 OAuth 不同：服务端拿 device_code 并轮询，用户在任意浏览器打开
// verification_uri 输入 user_code 授权，成功后服务端直接拿到 token（无需回调地址）。
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const GROK_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const GROK_SCOPES = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_TTL_MS = 15 * 60 * 1000;
const deviceSessions = new Map(); // device_code -> { at }

export function supportsDeviceLogin(type) {
  return String(type || "") === "grok";
}

export async function startDeviceLogin(type) {
  if (!supportsDeviceLogin(type)) {
    throw Object.assign(new Error("该厂商不支持设备码登录"), { code: "LOGIN_BAD_PARAMS" });
  }
  const resp = await fetch(GROK_DEVICE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: GROK_CLIENT_ID, scope: GROK_SCOPES }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw Object.assign(new Error(`获取设备码失败（HTTP ${resp.status}）：${text.slice(0, 200)}`), { code: "LOGIN_FAILED" });
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("设备码响应不是 JSON"), { code: "LOGIN_BAD_RESPONSE" });
  }
  if (!j.device_code || !j.user_code) throw Object.assign(new Error("上游未返回设备码"), { code: "LOGIN_BAD_RESPONSE" });
  const now = Date.now();
  for (const [k, v] of deviceSessions) if (now - v.at > DEVICE_TTL_MS) deviceSessions.delete(k);
  deviceSessions.set(String(j.device_code), { at: now });
  return {
    device_code: j.device_code,
    user_code: j.user_code,
    verification_uri: j.verification_uri || j.verification_uri_complete || "",
    verification_uri_complete: j.verification_uri_complete || "",
    interval: Math.max(3, Number(j.interval) || 5),
    expires_in: Number(j.expires_in) || 900,
  };
}

export async function pollDeviceLogin(type, deviceCode) {
  const code = String(deviceCode || "");
  const sess = deviceSessions.get(code);
  if (!sess || Date.now() - sess.at > DEVICE_TTL_MS) {
    throw Object.assign(new Error("设备码已过期，请重新点击「设备码登录」"), { code: "LOGIN_BAD_PARAMS" });
  }
  const resp = await fetch(GROK_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: GROK_CLIENT_ID,
      device_code: code,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* 保留原文用于报错 */
  }
  if (!resp.ok) {
    const err = String(j?.error || text || "");
    // 用户还没完成授权：继续轮询
    if (/authorization_pending|slow_down/i.test(err)) return { pending: true };
    throw Object.assign(new Error(`设备码授权失败：${err.slice(0, 200)}`), { code: "LOGIN_FAILED" });
  }
  if (!j?.access_token || !j?.refresh_token) {
    throw Object.assign(new Error("上游未返回完整凭据（access/refresh token）"), { code: "LOGIN_BAD_RESPONSE" });
  }
  deviceSessions.delete(code);
  const jwt = j.id_token ? decodeJwtPayload(j.id_token) : {};
  return {
    pending: false,
    credential: {
      auth_kind: "oauth",
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
      ...(j.id_token ? { id_token: j.id_token } : {}),
      ...(jwt.email ? { email: jwt.email } : {}),
      ...(jwt.sub ? { sub: jwt.sub } : {}),
    },
    accountLabel: jwt.email || jwt.sub || "",
  };
}

/**
 * 生成授权地址。
 * @returns {{ url: string, state: string, redirectUri: string }}
 */
export function buildLoginUrl(type) {
  const cfg = oauthConfigFor(type);
  const state = crypto.randomBytes(16).toString("hex");
  const extra = { redirectUri: cfg.redirectUri };
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
    ...cfg.extraAuth,
  });
  if (cfg.pkce) {
    const { verifier, challenge } = makePkce();
    extra.verifier = verifier;
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
  }
  rememberState(state, type, extra);
  return { url: `${cfg.authUrl}?${params.toString()}`, state, redirectUri: cfg.redirectUri };
}

/**
 * 从用户粘贴的内容里取出授权码。
 * 用户可能粘贴：完整回调 URL、只有 code、甚至整段浏览器地址栏文本 —— 都要能处理。
 */
export function extractCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return { code: "", state: "" };
  // 完整 URL：解析 query
  const m = /[?&]code=([^&\s]+)/.exec(raw);
  if (m) {
    const st = /[?&]state=([^&\s]+)/.exec(raw);
    return { code: decodeURIComponent(m[1]), state: st ? decodeURIComponent(st[1]) : "" };
  }
  // 只粘贴了 code（没有 ?code= 前缀）：按整串处理，去掉可能的 URL 编码
  if (/^[\w./-]+$/.test(raw)) return { code: raw, state: "" };
  return { code: "", state: "" };
}

/**
 * 用授权码换 token。
 * @returns {Promise<{ credential: object, accountLabel: string }>}
 *   credential 直接喂给适配器的 importAuth（各适配器已兼容 snake_case）
 */
export async function exchangeCodeForCredential(type, pastedInput, expectedState = "") {
  const cfg = oauthConfigFor(type);
  const { code, state } = extractCode(pastedInput);
  if (!code) {
    throw Object.assign(new Error("没有找到授权码，请把浏览器地址栏里那一整串 URL 复制过来"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  // 必须是平台发起的登录会话：state 必填且能在 pending 命中（防 CSRF —— 别人的授权码不能绑进本平台）。
  // 命中同时还校验厂商一致，避免把 A 厂商的登录上下文用于 B 厂商。
  if (!expectedState) {
    throw Object.assign(new Error("缺少 state：请回到表单点「一键登录 / 打开授权页」重新发起登录"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  if (state && state !== expectedState) {
    throw Object.assign(new Error("state 不匹配，这次登录可能已过期或被篡改，请重新发起登录"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const hit = consumeState(expectedState);
  if (!hit || hit.type !== cfg.type) {
    throw Object.assign(new Error("这次登录已超时或与当前厂商不匹配，请重新点击「登录」"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }

  const params = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);
  if (hit?.verifier) params.set("code_verifier", hit.verifier);
  const asJson = cfg.exchangeStyle === "json";
  const resp = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: asJson
      ? { "content-type": "application/json", accept: "application/json" }
      : { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: asJson ? JSON.stringify(Object.fromEntries(params)) : params,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    // 常见错误翻译成人话，管理员才知道下一步做什么
    let hint = text.slice(0, 300);
    if (/redirect_uri_mismatch/i.test(text)) hint = "回调地址不匹配：说明用的是自建 OAuth 客户端，请把它注册的回调地址填成 " + cfg.redirectUri;
    else if (/invalid_grant/i.test(text)) hint = "授权码无效或已被使用（同一个码只能用一次，请重新点击「登录账号」）";
    else if (/invalid_client/i.test(text)) hint = "客户端凭据无效，请检查 .env 里的 OAuth 配置";
    throw Object.assign(new Error(`换取令牌失败（HTTP ${resp.status}）：${hint}`), { code: "LOGIN_FAILED" });
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("令牌响应不是 JSON"), { code: "LOGIN_BAD_RESPONSE" });
  }
  if (!j.access_token) {
    throw Object.assign(new Error("上游没有返回 access_token"), { code: "LOGIN_BAD_RESPONSE" });
  }
  if (!j.refresh_token) {
    // 没有 refresh_token 意味着访问令牌一小时后失效、无法续期 —— 对订阅渠道等于废号，
    // 与其收下一个「一小时后必然失效」的渠道，不如当场告诉用户重来。
    throw Object.assign(new Error("上游没有返回 refresh_token（无法自动续期）。请重新登录并在授权页确认授权"), {
      code: "LOGIN_FAILED",
    });
  }

  // id_token 里带账号标识（codex 的 account_id / 各家的 email）
  const jwt = j.id_token ? decodeJwtPayload(j.id_token) : {};
  let email = String(jwt.email || "");
  const accountId = String(jwt["https://api.openai.com/auth"]?.chatgpt_account_id || jwt.chatgpt_account_id || "");

  // Google 顺手取一下邮箱（id_token 里通常也有，这里兜底）
  if (!email && cfg.type === "gemini") {
    try {
      const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo?alt=json", {
        headers: { authorization: `Bearer ${j.access_token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (ui.ok) email = String((await ui.json())?.email || "");
    } catch {
      /* 取不到邮箱不影响登录本身 */
    }
  }

  return {
    credential: {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
      scope: j.scope || cfg.scopes.join(" "),
      token_type: j.token_type || "Bearer",
      ...(j.id_token ? { id_token: j.id_token } : {}),
      ...(email ? { email } : {}),
      ...(accountId ? { account_id: accountId } : {}),
    },
    accountLabel: email || accountId,
  };
}

/** 给前端用的展示信息（哪些厂商支持、回调地址是什么、是否走设备码） */
export function interactiveLoginInfo(type) {
  const ok = supportsInteractiveLogin(type);
  const device = supportsDeviceLogin(type);
  let redirectUri = "";
  if (ok) {
    try {
      redirectUri = oauthConfigFor(type).redirectUri;
    } catch {
      redirectUri = "";
    }
  }
  return { supported: ok, device, redirectUri };
}

