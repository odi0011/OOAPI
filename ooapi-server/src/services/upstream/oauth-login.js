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
const pending = new Map(); // state -> { type, createdAt }

function rememberState(state, type) {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  }
  pending.set(state, { type, createdAt: now });
}

function consumeState(state) {
  const hit = pending.get(String(state || ""));
  if (!hit) return null;
  pending.delete(String(state));
  if (Date.now() - hit.createdAt > PENDING_TTL_MS) return null;
  return hit;
}

/** 各厂商的 OAuth 配置。google 用 Antigravity/Code Assist 的公开客户端凭据（从 .env 读）。 */
function oauthConfigFor(type) {
  if (type === "gemini") {
    const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
    const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) {
      throw Object.assign(
        new Error(
          "未配置 Google OAuth 客户端（GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET）。" +
            "请在服务器 .env 里补上后重启服务，或改用「粘贴凭据」方式添加渠道"
        ),
        { code: "CHANNEL_CONFIG_ERROR" }
      );
    }
    return {
      type,
      clientId,
      clientSecret,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      // 与官方 Antigravity / Gemini Code Assist 客户端一致的 scope
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
      ],
      // 官方客户端注册的固定回调地址（我们只在用户浏览器里用到它，不需要真的监听）
      redirectUri: "http://localhost:51121/oauth-callback",
      // Google 需要这两项才会下发 refresh_token
      extraAuth: { access_type: "offline", prompt: "consent" },
    };
  }
  throw Object.assign(new Error("这个接入方式暂不支持交互式登录，请使用「粘贴凭据」"), {
    code: "LOGIN_BAD_PARAMS",
  });
}

/** 该厂商是否支持交互式登录（前端据此显示「登录账号」按钮） */
export function supportsInteractiveLogin(type) {
  if (type !== "gemini") return false;
  return true;
}

/**
 * 生成授权地址。
 * @returns {{ url: string, state: string, redirectUri: string }}
 */
export function buildLoginUrl(type) {
  const cfg = oauthConfigFor(type);
  const state = crypto.randomBytes(16).toString("hex");
  rememberState(state, type);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
    ...cfg.extraAuth,
  });
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
  // state 校验：只在用户回传了 state 时校验（有些用户只复制了 code 片段）
  if (state && expectedState && state !== expectedState) {
    throw Object.assign(new Error("state 不匹配，这次登录可能已过期或被篡改，请重新发起登录"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  if (expectedState && !consumeState(expectedState)) {
    throw Object.assign(new Error("这次登录已超时（超过 15 分钟），请重新点击「登录账号」"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }

  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  const resp = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
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
    // 与其收下一个「一小时后必然失效」的渠道，不如当场告诉用户重来（通常是没带 prompt=consent）。
    throw Object.assign(
      new Error("上游没有返回 refresh_token（无法自动续期）。请重新点击「登录账号」，并在 Google 页面确认授权"),
      { code: "LOGIN_FAILED" }
    );
  }

  // 顺手取一下邮箱，作为「账号标识」用于去重与展示
  let email = "";
  try {
    const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo?alt=json", {
      headers: { authorization: `Bearer ${j.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (ui.ok) email = String((await ui.json())?.email || "");
  } catch {
    /* 取不到邮箱不影响登录本身 */
  }

  return {
    credential: {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
      scope: j.scope || cfg.scopes.join(" "),
      email,
    },
    accountLabel: email,
  };
}

/** 给前端用的展示信息（哪些厂商支持、回调地址是什么） */
export function interactiveLoginInfo(type) {
  const ok = supportsInteractiveLogin(type);
  let redirectUri = "";
  try {
    redirectUri = oauthConfigFor(type).redirectUri;
  } catch {
    redirectUri = "";
  }
  return { supported: ok, redirectUri };
}

