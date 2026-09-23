// 设备授权绑定（一键绑定）—— Kiro / WorkBuddy / Qoder 共用
// ===========================================================================
// 为什么需要它：这三个渠道原先只能「手工粘贴凭据」—— 用户要自己找到
// 桌面端的登录文件（kiro-auth-token.json / workbuddy-desktop.info）、
// 从里面挑出 token 字段再粘进来。对绝大多数用户这是不可完成的任务。
//
// 三者都能走**设备授权**（device authorization）：
//   服务端发起 → 上游给一个「用户码 + 授权链接」→ 用户在浏览器里确认 →
//   服务端轮询到凭据。全程无回调、无 PKCE 回调地址、不依赖宿主机。
//
// 三家的差异与依据（2026-09 检索，来源见各处注释）：
//
// 【Kiro】AWS SSO OIDC 设备流（**官方标准 API，最稳**）
//   POST https://oidc.{region}.amazonaws.com/client/register
//   POST https://oidc.{region}.amazonaws.com/device_authorization
//   POST https://oidc.{region}.amazonaws.com/token   （grantType 是那个很长的 URN）
//   字段是 camelCase（不是标准 OAuth2 的 snake_case），Content-Type: application/json。
//   来源：AWS OIDC API Reference + KiroStudio/kiro-batch-login/claude-api 三个实现的交叉印证。
//   注意 startUrl：Builder ID 恒为 https://view.awsapps.com/start；
//   IAM Identity Center 是 https://d-xxxxxxxxxx.awsapps.com/start（由用户填）。
//
// 【WorkBuddy / CodeBuddy】腾讯自研的 state + authUrl（**不是** RFC 8628）
//   ① POST {base}/v2/plugin/auth/state?platform=CLI   → {state, authUrl}
//   ② 用户在浏览器打开 authUrl 登录
//   ③ GET  {base}/v2/plugin/auth/token?state=...      → 待授权时 HTTP 200 但 code!=0
//   源：Sliverkiss/workbuddy2api、cpa-multi-plugins PROTOCOL.md。
//   **关键点：pending 不是 HTTP 错误**，必须看业务 code，否则会把「等待中」当失败。
//
// 【Qoder】设备授权（PKCE）+ 分区分支
//   GET {site}/device/selectAccounts?nonce=&challenge=&challenge_method=S256...
//   GET {openapi}/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
//   **Global 端已发生协议漂移**：client_id/machine_id 从 URL 移除
//   （cockpit-tools v1.3.36 对齐），旧参数会导致「Parameter invalid」。
//   源：cpa-multi-plugins plugins/qoder/oauth.go（注释注明已对 Global 实测通过）。
//
// 统一抽象：start() 返回 {sessionId, userCode, verifyUrl, expiresIn, intervalMs}，
// poll() 返回 {status: pending|success|expired|denied, credential?}。
// 会话存进程内 Map（单机单实例；重启即失效 —— 重新绑定即可，不影响已存凭据）。
import crypto from "node:crypto";
import { assertPublicUrl } from "../utils.js";

/** 会话存活时间（上游过期时间通常 10~15 分钟，这里统一收敛到 15 分钟） */
const SESSION_TTL_MS = 15 * 60 * 1000;
/** 会话表：sessionId → { vendor, createdAt, ...上游需要的上下文 } */
const sessions = new Map();

/** 清理过期会话（避免长期运行内存里堆垃圾） */
function sweep() {
  const nowMs = Date.now();
  for (const [k, v] of sessions.entries()) {
    if (nowMs - v.createdAt > SESSION_TTL_MS) sessions.delete(k);
  }
}

/** 统一的 HTTP 调用：带超时、错误归一、响应体上限 */
async function reqJson(url, { method = "GET", headers = {}, body, timeoutMs = 20000 } = {}) {
  // 只允许公网地址（防止 SSRF：base_url 可由管理员配置）
  await assertPublicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "上游响应超时" : `无法连接上游：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON：下面按状态码处理 */
  }
  return { status: resp.status, ok: resp.ok, json, text: text.slice(0, 400) };
}

// ---------------------------------------------------------------------------
// Kiro：AWS SSO OIDC 设备流
// ---------------------------------------------------------------------------
const KIRO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];
/** 常见 region 候选：用户没填或填错时逐个试（每个 region 的 clientId 独立，必须各注册一次） */
const KIRO_REGION_CANDIDATES = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1", "ap-southeast-1"];

async function kiroStart({ startUrl, regionHint }) {
  const start = String(startUrl || "").trim() || "https://view.awsapps.com/start";
  // 用户填的 region 优先，其余作为候选
  const regions = [
    ...(String(regionHint || "").trim() ? [String(regionHint).trim()] : []),
    ...KIRO_REGION_CANDIDATES.filter((r) => r !== String(regionHint || "").trim()),
  ];

  let lastErr = "";
  for (const region of regions) {
    const base = `https://oidc.${region}.amazonaws.com`;
    try {
      // ① 注册客户端（设备流不需要 grantTypes / issuerUrl，AWS 标为可选）
      const reg = await reqJson(`${base}/client/register`, {
        method: "POST",
        body: { clientName: "OOAPI Gateway", clientType: "public", scopes: KIRO_SCOPES },
      });
      const clientId = reg.json?.clientId;
      const clientSecret = reg.json?.clientSecret;
      if (!clientId || !clientSecret) {
        lastErr = `region ${region} 注册失败（${reg.status}）`;
        continue;
      }
      // ② 设备授权
      const dev = await reqJson(`${base}/device_authorization`, {
        method: "POST",
        body: { clientId, clientSecret, startUrl: start },
      });
      if (!dev.json?.deviceCode) {
        // startUrl 与 region 不匹配时这里会 400 —— 换下一个 region 试
        lastErr = `region ${region}：${dev.json?.message || dev.json?.error_description || `HTTP ${dev.status}`}`;
        continue;
      }
      return {
        region,
        clientId,
        clientSecret,
        deviceCode: dev.json.deviceCode,
        userCode: dev.json.userCode || "",
        verifyUrl: dev.json.verificationUriComplete || dev.json.verificationUri || "",
        intervalMs: Math.max(3, Number(dev.json.interval) || 5) * 1000,
        expiresIn: Number(dev.json.expiresIn) || 600,
      };
    } catch (e) {
      lastErr = `region ${region}：${e.message}`;
    }
  }
  throw new Error(`AWS SSO 设备授权失败（试过 ${regions.length} 个 region）：${lastErr}`);
}

/**
 * Kiro：把 AWS 的 token 响应判定成统一状态。
 *
 * 抽成纯函数导出是刻意的：这里的分支最容易写错（AWS 的 pending 是**异常名**
 * 而不是 HTTP 状态；slow_down 要继续轮询而不是失败），
 * 而真实上游必须有 AWS 账号才能打到 —— 纯函数才能被测试覆盖。
 * @returns {{status, credential?, message?, slowDown?}}
 */
export function judgeKiroToken(r, s) {
  const j = r?.json || {};
  if (j.accessToken) {
    return {
      status: "success",
      credential: {
        // 与 kiro.js 的 importAuth 字段对齐，产出后可直接走同一条入库链路
        access_token: j.accessToken,
        refresh_token: j.refreshToken || "",
        region: s.region,
        client_id: s.clientId,
        client_secret: s.clientSecret,
        expires_at: Math.floor(Date.now() / 1000) + (Number(j.expiresIn) || 1800),
      },
    };
  }
  // 待授权：AWS 用异常名表达状态（camelCase 或 snake_case 都可能出现）
  const errCode = String(j.error || j.__type || j.code || "");
  if (/authorization_pending|AuthorizationPending/i.test(errCode)) return { status: "pending" };
  // slow_down 是「你轮询太快了」，要继续等而不是判失败
  if (/slow_down|SlowDown/i.test(errCode)) return { status: "pending", slowDown: true };
  if (/expired_token|ExpiredToken/i.test(errCode)) return { status: "expired", message: "授权码已过期，请重新发起绑定" };
  if (/access_denied|AccessDenied/i.test(errCode)) return { status: "denied", message: "用户在授权页拒绝了请求" };
  return { status: "pending", message: errCode || `HTTP ${r?.status}` };
}

/**
 * WorkBuddy：判定 /auth/token 响应。
 *
 * **关键：待授权是 HTTP 200 + 业务 code != 0**（不是 HTTP 错误）。
 * 按 HTTP 状态判断会把「等待中」直接判成失败 —— 这是这条流程最容易踩的坑。
 */
export function judgeWorkbuddyToken(r, s) {
  const j = r?.json || {};
  const data = j?.data || {};
  const token = data.accessToken || data.access_token;
  if (!token) return { status: "pending", message: j.msg || "" };
  return {
    status: "success",
    credential: {
      access_token: token,
      refresh_token: data.refreshToken || data.refresh_token || "",
      domain: data.domain || (s.realm === "global" ? "www.workbuddy.ai" : "copilot.tencent.com"),
      expires_at: Math.floor(Date.now() / 1000) + (Number(data.expiresIn) || 3600),
    },
  };
}

/**
 * Qoder：判定设备轮询响应。
 * 404 / 202 / 200-但-无-token 都算「还没授权」；410 或带 expire 文案才算过期。
 */
export function judgeQoderPoll(r, s) {
  const j = r?.json || {};
  const data = j?.data || j;
  const access = data?.accessToken || data?.access_token;
  const refresh = data?.refreshToken || data?.refresh_token;
  if (access) {
    return {
      status: "success",
      credential: {
        // 与 qoder.js 的 importAuth 对齐（该适配器接受 personal_token/endpoint 形态）
        personal_token: data.personalToken || data.personal_token || "",
        access_token: access,
        refresh_token: refresh || "",
        endpoint: s.openapi,
        realm: s.realm || "cn",
        // 上游给的是**毫秒**（社区实现与实测一致），统一换算成秒
        expires_at: Math.floor(Date.now() / 1000) + Math.floor((Number(data.expires_in) || 2592000000) / 1000),
      },
    };
  }
  if (r?.status === 410 || /expire/i.test(String(j?.message || ""))) {
    return { status: "expired", message: "授权已过期，请重新发起绑定" };
  }
  return { status: "pending", message: j?.message || (r?.status && r.status !== 200 && r.status !== 202 && r.status !== 404 ? `HTTP ${r.status}` : "") };
}

async function kiroPoll(s) {
  const base = `https://oidc.${s.region}.amazonaws.com`;
  const r = await reqJson(`${base}/token`, {
    method: "POST",
    body: {
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      deviceCode: s.deviceCode,
      // 这个长 URN 是 AWS 的规定值，不是 "device_code"
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });
  return judgeKiroToken(r, s);
}

// ---------------------------------------------------------------------------
// WorkBuddy / CodeBuddy：state + authUrl 轮询
// ---------------------------------------------------------------------------
const WB_BASES = {
  cn: "https://copilot.tencent.com",
  global: "https://www.workbuddy.ai",
};

async function wbStart({ realm }) {
  const base = WB_BASES[realm === "global" ? "global" : "cn"];
  const r = await reqJson(`${base}/v2/plugin/auth/state?platform=CLI`, {
    method: "POST",
    body: {},
    headers: {
      // 上游校验来源头，缺失会被拒（社区实现都带这几个）
      "x-requested-with": "XMLHttpRequest",
      origin: realm === "global" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn",
      referer: realm === "global" ? "https://www.workbuddy.ai/" : "https://www.codebuddy.cn/",
      "user-agent": "CLI/2.63.2 CodeBuddy/2.63.2",
    },
  });
  const j = r.json || {};
  const state = j?.data?.state || j?.state;
  const authUrl = j?.data?.authUrl || j?.authUrl;
  if (!state || !authUrl) {
    throw new Error(`发起授权失败：${j?.msg || j?.message || `HTTP ${r.status}`}`);
  }
  return { base, realm: realm === "global" ? "global" : "cn", state, authUrl, verifyUrl: authUrl, userCode: "", intervalMs: 3000, expiresIn: 600 };
}

async function wbPoll(s) {
  const r = await reqJson(`${s.base}/v2/plugin/auth/token?state=${encodeURIComponent(s.state)}`, {
    headers: {
      "x-requested-with": "XMLHttpRequest",
      origin: s.realm === "global" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn",
      referer: s.realm === "global" ? "https://www.workbuddy.ai/" : "https://www.codebuddy.cn/",
      "user-agent": "CLI/2.63.2 CodeBuddy/2.63.2",
    },
  });
  const judged = judgeWorkbuddyToken(r, s);
  if (judged.status !== "success") return judged;
  // 补账号信息（uid/enterpriseId）—— 上游 API 需要 X-User-Id
  let account = {};
  try {
    const acc = await reqJson(`${s.base}/v2/plugin/login/account?state=${encodeURIComponent(s.state)}`, {
      headers: { authorization: `Bearer ${judged.credential.access_token}`, "user-agent": "CLI/2.63.2 CodeBuddy/2.63.2" },
    });
    account = acc.json?.data || acc.json || {};
  } catch {
    /* 拿不到账号信息不阻断：device_token/user_id 后续可手工补 */
  }
  judged.credential.user_id = String(account.uid || account.userId || account.user_id || "");
  judged.credential.enterprise_id = String(account.enterpriseId || account.enterprise_id || "");
  return judged;
}

// ---------------------------------------------------------------------------
// Qoder：设备授权（PKCE）
// ---------------------------------------------------------------------------
const QODER_ENDPOINTS = {
  cn: {
    site: "https://qoder.com.cn",
    openapi: "https://openapi.qoder.com.cn",
    clientId: "1c5e33e1-364d-4ce6-b02c-acaa81274a5c",
    redirectUri: "qoder-work-cn://",
    // CN 仍带 client_id / machine_id
    keepClientParams: true,
  },
  global: {
    site: "https://qoder.com",
    openapi: "https://openapi.qoder.sh",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    redirectUri: "qoder://aicoding.aicoding-agent/login-success",
    // Global 端协议漂移：client_id / machine_id 已从授权 URL 移除，
    // 继续带会导致「Parameter invalid」（cockpit-tools v1.3.36 起）
    keepClientParams: false,
  },
};

/** PKCE：S256 challenge */
function pkcePair() {
  const verifier = crypto.randomBytes(48).toString("base64url").slice(0, 64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function qoderStart({ realm }) {
  const cfg = QODER_ENDPOINTS[realm === "global" ? "global" : "cn"];
  const { verifier, challenge } = pkcePair();
  const isGlobal = realm === "global";
  // nonce：CN 带横线 UUID；Global 去横线 32-hex（社区实现的分区差异）
  const nonce = isGlobal ? crypto.randomUUID().replace(/-/g, "") : crypto.randomUUID();

  const params = new URLSearchParams();
  params.set("nonce", nonce);
  params.set("challenge", challenge);
  params.set("challenge_method", "S256");
  params.set("redirect_uri", cfg.redirectUri);
  if (cfg.keepClientParams) {
    params.set("client_id", cfg.clientId);
    params.set("machine_id", crypto.randomUUID().replace(/-/g, ""));
  }
  const verifyUrl = `${cfg.site}/device/selectAccounts?${params.toString()}`;
  return {
    ...cfg,
    verifier,
    nonce,
    verifyUrl,
    userCode: "",
    intervalMs: 3000,
    expiresIn: 600,
  };
}

async function qoderPoll(s) {
  const url =
    `${s.openapi}/api/v1/deviceToken/poll?nonce=${encodeURIComponent(s.nonce)}` +
    `&verifier=${encodeURIComponent(s.verifier)}&challenge_method=S256`;
  const r = await reqJson(url);
  const judged = judgeQoderPoll(r, s);
  if (judged.status !== "success") return judged;
  // 补用户信息（可选，失败不阻断）
  try {
    const u = await reqJson(`${s.openapi}/api/v1/userinfo`, { headers: { authorization: `Bearer ${judged.credential.access_token}` } });
    const user = u.json?.data || u.json || {};
    judged.credential.user_id = String(user.id || "");
    judged.credential.user_name = String(user.name || user.username || "");
  } catch {
    /* ignore */
  }
  return judged;
}

// ---------------------------------------------------------------------------
// Cline：WorkOS 设备授权（RFC 8628 标准流程）
// ---------------------------------------------------------------------------
// 调研与实测（2026-09-23，全部端点为真实探测结果，非猜测）：
//   · Cline 的账号体系建在 **WorkOS AuthKit** 上，客户端 id 来自其开源 SDK
//     （`sdk/packages/shared/src/runtime/cline-environment.ts` 的 workOsClientId）。
//   · ① 发起：POST https://api.workos.com/user_management/authorize/device
//         body {client_id} → 实测 200，返回
//         {device_code, user_code, verification_uri: "https://authkit.cline.bot/device",
//          verification_uri_complete, expires_in: 300, interval: 5}
//   · ② 轮询：POST https://api.workos.com/user_management/authenticate
//         body {client_id, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code"}
//         → 未授权时实测 400 {"error":"authorization_pending", ...}（标准语义，**不是** HTTP 错误）
//         → 授权完成后返回 WorkOS 的 accessToken / refreshToken
//   · ③ 刷新：POST https://api.cline.bot/api/v1/auth/refresh
//         body {refreshToken, grantType: "refresh_token"}
//         → 坏 token 实测 400 {"error":"failed to refresh token: invalid_grant"}
//         （语义正确 ⇒ 有真 refreshToken 即可换取新 accessToken）
//
// 三个端点都已实测「存在且契约正确」，唯一未实测的是「用户完成授权后的返回体」——
// 那需要真实账号走一次，所以判空与容错写得宽一些（见 judgeClineToken）。
const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const CLINE_DEVICE_URL = "https://api.workos.com/user_management/authorize/device";
const CLINE_AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";
const CLINE_API_BASE = "https://api.cline.bot";

// 与其它厂商的浏览器标识保持一致（探测时用的就是这套头）
const CLINE_UA = "OOAPI-Gateway/1.0";

async function clineStart() {
  const r = await reqJson(CLINE_DEVICE_URL, {
    method: "POST",
    body: { client_id: CLINE_WORKOS_CLIENT_ID },
    headers: { "user-agent": CLINE_UA, accept: "application/json" },
  });
  const j = r.json || {};
  const deviceCode = j.device_code;
  const userCode = j.user_code || "";
  if (!deviceCode) {
    throw new Error(`Cline 发起授权失败：${j.error_description || j.error || `HTTP ${r.status}`}`);
  }
  return {
    deviceCode,
    userCode,
    // verification_uri_complete 带 user_code，用户点开就是填好的（少一步手抄）
    verifyUrl: j.verification_uri_complete || j.verification_uri || "https://authkit.cline.bot/device",
    intervalMs: Math.max(3, Number(j.interval) || 5) * 1000,
    // WorkOS 给 300 秒；按它自己的值来，别写死
    expiresIn: Number(j.expires_in) || 300,
  };
}

/**
 * 把 WorkOS 的轮询响应判定成统一状态。
 *
 * 抽成纯函数导出是刻意的（与 judgeKiroToken/judgeQoderPoll 同一理由）：
 * device flow 的分支最容易写错 —— WorkOS 的 `authorization_pending` 是
 * **HTTP 400 + error 字段**，不是 2xx；`slow_down` 要继续轮询而不是失败。
 * 而真实上游必须有 Cline 账号才能完整打到，纯函数才能被测试覆盖。
 *
 * @returns {{status, credential?, message?, slowDown?}}
 */
export function judgeClineToken(r, s) {
  const j = r?.json || {};
  const err = String(j.error || "");
  const desc = String(j.error_description || "");

  // 授权完成：WorkOS 返回标准 OAuth 令牌
  const access = j.access_token || j.accessToken;
  const refresh = j.refresh_token || j.refreshToken;
  if (access || refresh) {
    return {
      status: "success",
      credential: {
        access_token: access || "",
        refresh_token: refresh || "",
        token_type: String(j.token_type || "Bearer"),
        // 秒级时间戳；WorkOS 给 expires_in（秒），实测同族实现为 3600
        expires_at: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
        // 后续刷新与调用都要用的固定信息，一并落库（避免每次请求重新推导）
        client_id: CLINE_WORKOS_CLIENT_ID,
        endpoint: CLINE_API_BASE,
      },
    };
  }

  // 等待用户授权：**要继续轮询**，不是失败
  if (err === "authorization_pending") return { status: "pending", message: "等待你在浏览器里完成授权" };
  if (err === "slow_down") return { status: "pending", message: "轮询过快，已自动放慢", slowDown: true };
  if (err === "access_denied") return { status: "denied", message: "你在授权页拒绝了本次登录" };
  if (err === "expired_token" || r?.status === 410) {
    return { status: "expired", message: "授权已过期，请重新发起绑定" };
  }
  // 其余错误（含 WorkOS 偶发 5xx）：给可归因信息，不当作成功
  return {
    status: "pending",
    message: desc || err || (r?.status && r.status >= 400 ? `HTTP ${r.status}` : ""),
  };
}

async function clinePoll(s) {
  const r = await reqJson(CLINE_AUTHENTICATE_URL, {
    method: "POST",
    body: {
      client_id: CLINE_WORKOS_CLIENT_ID,
      device_code: s.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    headers: { "user-agent": CLINE_UA, accept: "application/json" },
  });
  return judgeClineToken(r, s);
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------
const VENDORS = {
  kiro: { start: kiroStart, poll: kiroPoll },
  workbuddy: { start: wbStart, poll: wbPoll },
  qoder: { start: qoderStart, poll: qoderPoll },
  // Cline：WorkOS 设备授权（标准 RFC 8628，端点均已实测）
  cline: { start: clineStart, poll: clinePoll },
};

/** 是否支持设备授权绑定 */
export function supportsDeviceBind(vendor) {
  return Boolean(VENDORS[String(vendor || "").trim()]);
}

/** 可绑定的渠道类型列表（前端据此显示「一键绑定」按钮） */
export function deviceBindVendors() {
  return Object.keys(VENDORS);
}

/**
 * 发起绑定：返回给前端展示的信息。
 * @returns {{sessionId, vendor, userCode, verifyUrl, intervalMs, expiresIn, realm?}}
 */
export async function startDeviceBind(vendor, params = {}) {
  sweep();
  const key = String(vendor || "").trim();
  const impl = VENDORS[key];
  if (!impl) throw new Error(`该渠道不支持一键绑定：${key}`);
  const ctx = await impl.start(params);
  const sessionId = crypto.randomBytes(16).toString("hex");
  sessions.set(sessionId, { vendor: key, createdAt: Date.now(), ...ctx });
  return {
    sessionId,
    vendor: key,
    userCode: ctx.userCode || "",
    verifyUrl: ctx.verifyUrl || "",
    intervalMs: ctx.intervalMs || 3000,
    expiresIn: ctx.expiresIn || 600,
    realm: ctx.realm || "",
    region: ctx.region || "",
  };
}

/**
 * 轮询一次。
 *
 * 两处关键约束：
 *
 * ① **vendor 由服务端会话决定，不信调用方**。返回值里带上 `vendor`，路由用它校验
 *    「这次授权拿到的凭据，到底属于哪个厂商」，防止把 A 厂商的授权结果写进 B 厂商渠道。
 *    （`/devices/poll` 的 body 里也有 vendor，但那是前端传的，只能当展示用。）
 *
 * ② **会话级 in-flight 互斥**。前端 `setInterval` 轮询与「两个管理员同时点」都会让同一
 *    session 被并发 poll：上游会被请求多次，更糟的是两边都拿到 `success`、都去写凭据，
 *    后写的那份覆盖先写的。这里用 `s.polling` 做闸门，重复请求直接返回 pending。
 *    终态用「删除成功者」做原子状态转移 —— `sessions.delete` 返回 true 的那个才继续。
 *
 * @returns {{status:'pending'|'success'|'expired'|'denied', vendor?:string, credential?, message?, slowDown?}}
 */
export async function pollDeviceBind(sessionId) {
  const key = String(sessionId || "");
  const s = sessions.get(key);
  if (!s) return { status: "expired", message: "绑定会话已失效，请重新发起" };
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(key);
    return { status: "expired", message: "绑定超时，请重新发起" };
  }
  const impl = VENDORS[s.vendor];
  if (!impl) {
    sessions.delete(key);
    return { status: "expired", message: "该渠道不支持一键绑定" };
  }
  if (s.polling) {
    // 上一次 poll 还在飞：这次不碰上游，按「仍在等待」回给前端（它会照常再轮询一次）
    return { status: "pending", vendor: s.vendor, vendorLocked: true, message: "上一次查询尚未返回，本次已跳过" };
  }
  s.polling = true;
  let out;
  try {
    out = await impl.poll(s);
  } finally {
    // 会话可能已在下面被删除；对已删除的会话补写标记无害
    s.polling = false;
  }
  if (out.status === "success" || out.status === "expired" || out.status === "denied") {
    // 终态：立即回收会话，避免凭据在内存里多留一份。
    // delete 的返回值即「谁抢到了终态」，避免两次成功各自写回。
    const won = sessions.delete(key);
    if (!won) return { status: "pending", vendor: s.vendor, message: "该会话已被其它请求完成" };
  }
  return { ...out, vendor: out.vendor || s.vendor };
}

/** 取消绑定（用户关弹窗） */
export function cancelDeviceBind(sessionId) {
  return sessions.delete(String(sessionId || ""));
}

/** 当前活跃会话数（监控/测试用） */
export function activeBindCount() {
  sweep();
  return sessions.size;
}
