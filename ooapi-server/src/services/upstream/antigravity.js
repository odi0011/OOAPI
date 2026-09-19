// 上游适配器：antigravity（Google 订阅 · Antigravity / Gemini Code Assist OAuth）
// ===========================================================================
// 协议来源：参考开源项目 CLIProxyAPI（router-for-me/CLIProxyAPI）的 antigravity 实现。
//
// 凭据（channels.other）：
//   · access_token / refresh_token / expires_at
//   · project_id（Google Cloud 项目，由 loadCodeAssist 引导获得并落库）
//   · email
//
// 上游：
//   POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist     （引导/健康检查）
//   POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
//   —— 请求体是 Google 私有信封 {model, project, request:{contents,...}}，
//      身份用统一指纹模块派生的 requestId / sessionId，UA 用官方 antigravity/hub/<ver>。
// ---------------------------------------------------------------------------
import { antigravityIdentity, antigravityUserAgent, CLI_VERSIONS } from "./cli-profile.js";
import { persistOtherPatch, loadOther, withRefreshLock } from "./auth-store.js";

const AUTH_URL = "https://oauth2.googleapis.com/token";
// Google OAuth 客户端凭据不写进仓库（GitHub 密钥扫描会拦截；也符合「不提交密钥」的规范）。
// 管理员在 .env 配置 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET。
// 说明：官方客户端的 client_secret 属于「公开客户端」凭据，但与其把它硬编码在这里，
// 不如让部署方显式配置——换客户端、被封禁时都不需要改代码。
const CLIENT_ID = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
const LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";
const CHAT_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const REFRESH_LEAD_S = 300;
const MAX_SSE_BUF = 8 * 1024 * 1024;

function tokenExpiredSoon(other) {
  const exp = Number(other?.expires_at || 0);
  if (!exp) return Boolean(other?.refresh_token); // 无过期信息：先刷一次拿真实过期时间
  return exp - REFRESH_LEAD_S <= Math.floor(Date.now() / 1000);
}

/** 时间戳统一成秒：毫秒（>1e12）、ISO/RFC3339 字符串都兼容 */
function toEpochSeconds(raw) {
  if (!raw) return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n > 1e12 ? n / 1000 : n);
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("凭据不是合法 JSON（请粘贴 Antigravity/Gemini 的 OAuth 凭据）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  // 兼容裸凭据、{token:{...}} 与 sub2api 导出（credentials 对象）
  const t = j.token || j.tokens || j.credentials || j;
  const access_token = String(t.access_token || t.accessToken || j.access_token || "").trim();
  const refresh_token = String(t.refresh_token || t.refreshToken || j.refresh_token || "").trim();
  if (!access_token) throw Object.assign(new Error("缺少 access_token"), { code: "LOGIN_BAD_PARAMS" });
  if (!refresh_token) throw Object.assign(new Error("缺少 refresh_token（订阅渠道必须能自动续期）"), { code: "LOGIN_BAD_PARAMS" });
  const project = j.project_id || j.projectId || j.cloudaicompanionProject || t.project_id || "";
  return {
    access_token,
    refresh_token,
    // 兼容 expired(RFC3339) / expiry_date(ms) / expiry / expires_at
    expires_at: toEpochSeconds(t.expired || t.expiry_date || t.expiry || t.expires_at),
    project_id: String(project || "").trim(),
    email: String(j.email || t.email || "").trim(),
  };
}

/** 刷新登录态；并发用 withRefreshLock 合并，刷新前重读 DB */
export async function refreshAuth(channel, { force = false } = {}) {
  return withRefreshLock(channel.id, async () => {
    const fresh = await loadOther(channel.id);
    if (fresh) {
      const freshExp = Number(fresh.expires_at || 0);
      const valid = fresh.access_token && freshExp - REFRESH_LEAD_S > Math.floor(Date.now() / 1000);
      if (!force && valid) {
        channel.other = { ...(channel.other || {}), ...fresh };
        return { access_token: fresh.access_token, expires_at: freshExp };
      }
      channel.other = { ...(channel.other || {}), ...fresh };
    }
    const other = channel?.other || {};
    const refreshToken = String(other.refresh_token || "").trim();
    if (!refreshToken) {
      throw Object.assign(new Error("缺少 refresh_token，请重新导入 Google 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
    }
    if (!CLIENT_ID || !CLIENT_SECRET) {
      // 这是部署配置问题，不是账号失效：独立错误码，避免按 6 小时账号级冷却处理
      throw Object.assign(
        new Error("未配置 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET（.env），无法自动续期"),
        { code: "CHANNEL_CONFIG_ERROR" }
      );
    }
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const resp = await fetch(AUTH_URL, {
      method: "POST",
      headers: {
        host: "oauth2.googleapis.com",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Go-http-client/2.0", // 与参考实现一致：模仿真实客户端
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw Object.assign(new Error(`刷新 Google 登录态失败（HTTP ${resp.status}）：${text.slice(0, 160)}`), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("刷新响应不是 JSON"), { code: "CHANNEL_BAD_RESPONSE" });
    }
    const patch = {
      access_token: j.access_token || other.access_token,
      refresh_token: j.refresh_token || refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
    };
    await persistOtherPatch(channel.id, patch);
    channel.other = { ...other, ...patch };
    return patch;
  });
}

async function ensureToken(channel) {
  if (!channel?.other?.access_token || tokenExpiredSoon(channel.other)) {
    await refreshAuth(channel).catch((e) => {
      if (!channel?.other?.access_token) throw e;
      console.warn(`[antigravity] 提前刷新失败（继续用现有 token）：${e.message}`);
    });
  }
  return String(channel.other?.access_token || "");
}

/** 带 401 自动刷新重试的请求包装（401 时强刷一次再重放） */
async function fetchWithAuthRetry(channel, buildInit, url, extraInit = {}) {
  const token = await ensureToken(channel);
  const doFetch = (t) =>
    fetch(url, { ...extraInit, ...buildInit(t) }).catch((e) => {
      if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
      throw Object.assign(new Error(`无法连接 Antigravity 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
    });
  let resp = await doFetch(token);
  if (resp.status === 401 && channel?.other?.refresh_token) {
    console.warn("[antigravity] 上游 401，刷新登录态后重试一次");
    await refreshAuth(channel, { force: true }).catch(() => {});
    const retryToken = String(channel?.other?.access_token || token);
    if (retryToken && retryToken !== token) resp = await doFetch(retryToken);
  }
  return resp;
}

export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  const other = {
    access_token: cred.access_token,
    refresh_token: cred.refresh_token,
    expires_at: cred.expires_at || 0,
    project_id: cred.project_id || "",
    email: cred.email,
  };
  return { token: cred.access_token, other, accountLabel: cred.email || cred.project_id || "" };
}

// ---------------------------------------------------------------------------
// 引导：拿 project_id（首次或换号后自动执行，结果落库）
// ---------------------------------------------------------------------------

function agHeaders(channel, { withNodeClient = false } = {}) {
  return {
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": antigravityUserAgent(channel, { withNodeClient }),
  };
}

async function loadProject(channel, token) {
  const resp = await fetch(LOAD_URL, {
    method: "POST",
    headers: { ...agHeaders(channel), authorization: `Bearer ${token}` },
    // 与 CLIProxyAPI 对齐：loadCodeAssist 用短 UA + snake_case metadata（camelCase 在部分账号上不返回项目）
    body: JSON.stringify({
      metadata: { ide_type: "ANTIGRAVITY", ide_version: CLI_VERSIONS.antigravity, ide_name: "antigravity" },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const code =
      resp.status === 401 ? "CHANNEL_AUTH_EXPIRED" : resp.status === 429 ? "CHANNEL_RATE_LIMIT" : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`Antigravity 引导失败（HTTP ${resp.status}）：${text.slice(0, 200)}`), { code });
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("引导响应不是 JSON"), { code: "CHANNEL_BAD_RESPONSE" });
  }
  const pick = (v) => (v && typeof v === "object" ? v.id || v.projectId || v.project : v);
  const project = String(
    pick(j.cloudaicompanionProject) || pick(j.projectId) || pick(j.project) || channel?.other?.project_id || ""
  ).trim();
  const defaultTier =
    (j.allowedTiers || []).find((t) => t?.isDefault)?.id || j.currentTier?.id || "free-tier";
  return { project, defaultTier };
}

async function onboard(channel, token, tier) {
  const resp = await fetch(ONBOARD_URL, {
    method: "POST",
    headers: {
      ...agHeaders(channel, { withNodeClient: true }),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      tier_id: tier,
      metadata: { ide_type: "ANTIGRAVITY", ide_version: CLI_VERSIONS.antigravity, ide_name: "antigravity" },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw Object.assign(new Error(`Antigravity 开通失败（HTTP ${resp.status}）：${text.slice(0, 200)}`), {
      code: "CHANNEL_HTTP_ERROR",
    });
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return "";
  }
  const pick = (v) => (v && typeof v === "object" ? v.id || v.projectId || v.project : v);
  return String(pick(j.response?.cloudaicompanionProject) || pick(j.cloudaicompanionProject) || pick(j.projectId) || "").trim();
}

/** 确保渠道有 project_id（无则引导并落库） */
async function ensureProject(channel, token) {
  if (String(channel?.other?.project_id || "").trim()) return String(channel.other.project_id);
  const { project, defaultTier } = await loadProject(channel, token);
  let pid = project;
  if (!pid) {
    // 轮询语义参考实现：最多 5 次、每次间隔 2s
    for (let i = 0; i < 5 && !pid; i++) {
      pid = await onboard(channel, token, defaultTier);
      if (!pid) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!pid) {
    // 每个账号的 project_id 由 loadCodeAssist/onboardUser 自动开通并落库到渠道 other；
    // 换号/新建渠道都会自动重新开通，不需要人工配置任何东西。
    // 若这里仍拿不到，说明 Google 侧拒绝为该账号开项目（通常是账号资格问题），
    // 而不是平台配置问题 —— 换一个已开通过 Code Assist 的 Google 账号即可。
    throw Object.assign(
      new Error(
        "Google 未能为该账号自动开通 Antigravity 项目（project_id）。" +
          "该账号可能没有 Gemini Code Assist 资格：请换一个开通过的 Google 账号登录；" +
          "也可以直接粘贴官方 Antigravity auth 文件（内含 project_id）添加。"
      ),
      { code: "CHANNEL_NOT_READY" }
    );
  }
  await persistOtherPatch(channel.id, { project_id: pid });
  channel.other = { ...(channel.other || {}), project_id: pid };
  return pid;
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

function toContents(messages, images, fallbackPrompt) {
  const contents = [];
  const use = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: fallbackPrompt }];
  for (const m of use) {
    if (!m || typeof m !== "object" || m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    const text = String(m.content ?? "");
    // Google 要求首条为 user，合并连续同角色
    if (!contents.length && role !== "user") continue;
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts[0].text += `\n\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }
  if (images?.length) {
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role !== "user") continue;
      for (const img of images) {
        contents[i].parts.push({
          inlineData: { mimeType: img.mimeType || "image/png", data: img.buffer.toString("base64") },
        });
      }
      break;
    }
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: fallbackPrompt || "你好" }] });
  // 补 leading user turn（前一条逻辑已处理，这里兜底空 user 文本）
  if (contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "" }] });
  return contents;
}

function extractSystem(messages, prompt) {
  const sys = (messages || []).filter((m) => m && m.role === "system").map((m) => String(m.content ?? ""));
  const text = sys.join("\n\n");
  return text ? { parts: [{ text }] } : undefined;
}

export async function chat({
  channel,
  model,
  prompt,
  messages,
  thinkingOverride,
  images = [],
  onDelta,
  onReasoning,
  signal,
}) {
  const token = await ensureToken(channel);
  const project = await ensureProject(channel, token);
  const identity = antigravityIdentity(channel);
  const request = {
    contents: toContents(messages, images, prompt),
    sessionId: identity.sessionId,
  };
  const systemInstruction = extractSystem(messages, prompt);
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (thinkingOverride === true) request.generationConfig = { thinkingConfig: { includeThoughts: true } };

  const envelope = {
    model,
    userAgent: "antigravity",
    requestType: /image/i.test(String(model)) ? "image_gen" : "agent",
    project,
    requestId: identity.requestId,
    request,
  };

  const resp = await fetchWithAuthRetry(
    channel,
    (token) => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": identity.userAgent,
      },
      body: JSON.stringify(envelope),
      signal,
    }),
    CHAT_URL
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || msg;
    } catch {
      /* 保留原始文本 */
    }
    const code =
      resp.status === 401
        ? "CHANNEL_AUTH_EXPIRED"
        : resp.status === 429
          ? "CHANNEL_RATE_LIMIT"
          : [400, 404, 409, 413, 422].includes(resp.status)
            ? "CHANNEL_BAD_REQUEST"
            : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`Antigravity 上游 HTTP ${resp.status}：${msg}`), { code });
  }
  if (!resp.body) throw Object.assign(new Error("Antigravity 上游未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let upstreamModel = model;

  const handlePayload = (payloadText) => {
    let j;
    try {
      j = JSON.parse(payloadText);
    } catch {
      return;
    }
    // ?alt=sse 时 data 可能是 {response:{...}} 或直接是响应体，也可能是数组
    const items = Array.isArray(j) ? j : [j];
    for (const item of items) {
      const r = item?.response || item;
      if (!r || typeof r !== "object") continue;
      if (r.modelVersion) upstreamModel = r.modelVersion;
      if (r.usageMetadata) {
        const p = Number(r.usageMetadata.promptTokenCount) || 0;
        // 思考 token 也属于补全消耗，漏掉会少计费
        const c = (Number(r.usageMetadata.candidatesTokenCount) || 0) + (Number(r.usageMetadata.thoughtsTokenCount) || 0);
        usage = {
          prompt_tokens: p,
          completion_tokens: c,
          total_tokens: Number(r.usageMetadata.totalTokenCount) || p + c,
          cached_tokens: Number(r.usageMetadata.cachedContentTokenCount) || 0,
        };
      }
      for (const cand of r.candidates || []) {
        for (const part of cand?.content?.parts || []) {
          if (typeof part?.text !== "string" || !part.text) continue;
          if (part.thought) {
            reasoning += part.text;
            if (onReasoning) onReasoning(part.text);
          } else {
            content += part.text;
            if (onDelta) onDelta(part.text);
          }
        }
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > MAX_SSE_BUF) {
        throw Object.assign(new Error("Antigravity 数据帧异常（单行超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
      }
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        handlePayload(payload);
      }
    }
    // 收尾：末尾不带换行符的残帧不能丢（可能是最后一个文本增量或 usage）
    const tail = buf.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          handlePayload(payload);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content) {
    throw Object.assign(new Error(reasoning ? "Antigravity 只返回了思考内容，没有正文" : "Antigravity 返回空内容"), {
      code: "CHANNEL_EMPTY",
    });
  }
  return { content, reasoning, usage, upstreamModel };
}

/** 健康检查：loadCodeAssist（轻量、只验证凭据与项目） */
export async function verify(channel) {
  const started = Date.now();
  const token = await ensureToken(channel);
  if (!token) throw Object.assign(new Error("渠道未配置 Google 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  await loadProject(channel, token);
  return Date.now() - started;
}

/** 拉取上游可用模型（管理端「获取模型」用） */export async function fetchUpstreamModels(channel) {
  const token = await ensureToken(channel);
  const project = String(channel?.other?.project_id || "").trim();
  const resp = await fetch(MODELS_URL, {
    method: "POST",
    headers: { ...agHeaders(channel), authorization: `Bearer ${token}` },
    body: JSON.stringify(project ? { project } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`拉取模型失败（HTTP ${resp.status}）：${text.slice(0, 160)}`);
  }
  const j = await resp.json().catch(() => null);
  const models = j?.models || {};
  // 统一返回 id 字符串数组（前端模型选择器直接写入，不能给对象）
  return Object.keys(models)
    .filter((id) => !/^(chat_|tab_)/.test(id) && !/^gemini-2\.5/.test(id))
    .sort();
}

export function loginModes() {
  return ["paste"];
}

/** 测试探针：真实发送自定义提示词（默认 hi），返回 AI 回复供管理端 tip 展示 */
export async function probe(channel, prompt = "hi") {
  const started = Date.now();
  const model = channel?.test_model || channel?.other?.test_model || "gemini-2.5-flash";
  const r = await chat({
    channel,
    model,
    prompt,
    messages: [{ role: "user", content: prompt }],
    images: [],
    onDelta: () => {},
    onReasoning: () => {},
  });
  return { ms: Date.now() - started, reply: r.content || "", model, usage: r.usage };
}
