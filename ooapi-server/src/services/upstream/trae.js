// 上游适配器：Trae（字节跳动的 AI IDE）
// ===========================================================================
// 为什么需要独立适配器（不能直接用 openai-compat）：
//   · 协议不是 OpenAI 兼容的 —— 端点 /api/ide/v1/chat 收 `{messages, model,
//     function, stream, request_id, session_id}`，返回的是**自定义 SSE 事件**
//     （event: output / done），正文在 data.response、思考在 data.reasoning_content；
//   · 认证头是三个自定义头（Cloud-IDE-JWT / X-Cloudide-Token / X-Ide-Token）
//     加一整套 x-* 客户端标识，不是 `Authorization: Bearer`；
//   · 令牌是 OAuth 双令牌，要用它自己的 ExchangeToken 接口续期。
//
// 端点与协议（2026-09-23 在服务器上逐条实测，非猜测）：
//   · `POST https://coresg-normal.trae.ai/api/ide/v1/chat` → **200 + text/event-stream**
//     （未带有效凭据时也返回 200，body 是 `event: error` + code 1001 —— 说明
//      **不能靠 HTTP 状态判失败**，必须解析 SSE 流，见 detectStreamError）
//   · 区域镜像：新加坡 coresg-normal.trae.ai / 美国 coreva-normal.trae.ai /
//     国内 trae-api-cn.mchost.guru（CN 域名解析到同一个服务）
//   · `POST {host}/cloudide/api/v3/trae/oauth/ExchangeToken`
//     body `{ClientID, RefreshToken, ClientSecret: "-", UserID}`
//     → 实测 401 且 message 为「refresh token is invalid」的**正确语义**
//     （说明该路由存在且校验真实；给真 RT 就能换到新令牌）
//   · `POST {host}/cloudide/api/v3/trae/GetLoginGuidance` → 200（区域探测用）
//
// ⚠️ **计费口径警示（必须遵守）**：Trae 的模型名会撒谎。社区实测（trae-local-api）
//   它的 `claude-opus-4-7/4-6/4-5`、`claude-sonnet-4-6/4-5/4`、`claude-3.5/3.7-sonnet`
//   实际跑的是 **GLM-5.2**，`claude-haiku-4-5` 跑 GLM-5.1，`gpt-4o` 跑 DeepSeek-V4-Pro。
//   所以渠道的 models **必须登记上游真实档位**（glm-5.2 等），不能登记 claude-* 别名 ——
//   否则用户按 Claude 的价付费、实际拿到 GLM 的输出（与 WorkBuddy 那条注释同一类问题）。
//
// 不做一键绑定：Trae 是浏览器 OAuth + PKCE 授权码流、回调到 **localhost**，
// 没有 device_code（与 Qoder 同理，服务端接不住）—— 见 device-bind.js 的判定标准。
import crypto from "node:crypto";
import { now } from "../../utils.js";
import { withRefreshLock, persistOtherPatch } from "./auth-store.js";

const DEFAULT_HOST = "https://coresg-normal.trae.ai";
// 客户端标识：上游按 x-ide-version 做档位校验，必须固定成一个真实版本号
const IDE_VERSION = "3.5.66";
const IDE_VERSION_CODE = "20260811";
const X_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const OAUTH_CLIENT_ID = "ono9krqynydwx5";

/** 区域 → 上游主机（凭据里可覆盖） */
const HOSTS = {
  sg: "https://coresg-normal.trae.ai",
  us: "https://coreva-normal.trae.ai",
  cn: "https://trae-api-cn.mchost.guru",
};

/** 该渠道的令牌与主机（凭据形态：other.token / other.refresh_token / other.host / other.region） */
function credsOf(channel) {
  const o = channel?.other || {};
  const region = String(o.region || "sg").toLowerCase();
  return {
    token: String(o.token || channel?.api_key || "").trim(),
    refreshToken: String(o.refresh_token || "").trim(),
    userId: String(o.user_id || "").trim(),
    host: String(o.host || HOSTS[region] || DEFAULT_HOST).replace(/\/+$/, ""),
    region,
  };
}

/** 稳定的设备标识（上游要求每台设备一个固定 id；从渠道 id 派生，幂等且无需落库） */
function deviceIds(channel) {
  const o = channel?.other || {};
  const h = crypto.createHash("sha1").update(`ooapi-trae-${Number(channel?.id) || 0}`).digest("hex");
  const uuid = [h.slice(0, 8), h.slice(8, 12), `5${h.slice(13, 16)}`, `8${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
  return {
    deviceId: String(o.device_id || uuid),
    machineId: String(o.machine_id || uuid),
  };
}

/** 拼请求头。注意：绝不能重复设置 content-type（fetch 对同名头是逗号拼接，会 400） */
function headersFor(channel, creds) {
  const { deviceId, machineId } = deviceIds(channel);
  const o = channel?.other || {};
  const extra = o.extra_headers && typeof o.extra_headers === "object" ? o.extra_headers : {};
  return {
    // 三个令牌头缺一不可（社区实测：只带 Authorization 会被拒）
    authorization: `Cloud-IDE-JWT ${creds.token}`,
    "x-cloudide-token": creds.token,
    "x-ide-token": creds.token,
    ...(creds.userId ? { "x-uid": creds.userId } : {}),
    "x-app-id": X_APP_ID,
    "x-device-id": deviceId,
    "x-machine-id": machineId,
    "x-request-id": crypto.randomUUID(),
    "x-ide-version": IDE_VERSION,
    "x-ide-version-code": IDE_VERSION_CODE,
    "x-device-type": "windows",
    "x-os-version": "10.0.26100",
    accept: "text/event-stream",
    // 官方客户端标识（缺它会更像脚本流量）
    "user-agent": `Trae/${IDE_VERSION}`,
    ...extra,
  };
}

/**
 * 续期：POST {host}/cloudide/api/v3/trae/oauth/ExchangeToken
 *
 * 与 Grok/Cline 同一套生命周期：withRefreshLock 保证并发只刷一次，
 * persistOtherPatch 按 cred_epoch 写回（避免把管理员刚换的凭据覆盖掉）。
 */
export async function refreshAuth(channel, { force = false } = {}) {
  const c = credsOf(channel);
  if (!c.refreshToken) {
    throw Object.assign(new Error("凭据里没有 refreshToken，请重新粘贴 Trae 登录令牌"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  return withRefreshLock(channel, async () => {
    const r = await fetch(`${c.host}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `Trae/${IDE_VERSION}` },
      body: JSON.stringify({
        ClientID: OAUTH_CLIENT_ID,
        RefreshToken: c.refreshToken,
        ClientSecret: "-",
        UserID: c.userId,
      }),
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => {
      throw Object.assign(new Error(`续期请求失败：${e.message}`), { code: "CHANNEL_NETWORK" });
    });
    const j = await r.json().catch(() => null);
    const res = j?.Result || j?.result || {};
    const token = String(res.Token || res.token || "");
    if (!token) {
      const msg = String(j?.Message || j?.message || `HTTP ${r.status}`);
      // refresh token 失效是不可自愈的：要管理员重新粘贴（自动暂停由 router 处理）
      throw Object.assign(new Error(`Trae 令牌续期失败：${msg}`), { code: "CHANNEL_AUTH_EXPIRED" });
    }
    const nextRT = String(res.RefreshToken || res.refreshToken || c.refreshToken);
    await persistOtherPatch(channel, {
      token,
      refresh_token: nextRT,
      user_id: String(res.UserID || res.userId || c.userId || ""),
      cred_epoch: (Number(channel?.other?.cred_epoch) || 0) + 1,
      cred_updated_at: now(),
    });
    return { token, refreshToken: nextRT };
  });
}

/** 取一个可用令牌（快过期时先续期） */
async function ensureToken(channel) {
  const c = credsOf(channel);
  if (!c.token && !c.refreshToken) {
    throw Object.assign(new Error("未填写 Trae 登录令牌（token 或 refreshToken）"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  const exp = Number(channel?.other?.expires_at) || 0;
  const soon = exp > 0 && exp - Math.floor(Date.now() / 1000) < 300;
  if (c.refreshToken && (soon || !c.token)) {
    const r = await refreshAuth(channel).catch((e) => {
      // 已有可用 token 时续期失败不该打断请求（与 cline 同一策略）
      if (c.token) {
        console.warn(`[trae] 提前续期失败（继续用现有 token）：${e.message}`);
        return null;
      }
      throw e;
    });
    if (r?.token) return r.token;
  }
  return c.token;
}

/**
 * 判断 SSE 里的错误帧。
 *
 * 上游对**未认证**也返回 200 + `event: error`，所以状态码不足以判失败 ——
 * 不解析这块就会把「认证失败」当成「空回复」，用户看到的是「上游返回空内容」，
 * 排查方向完全跑偏（这正是 Qoder 那类问题的翻版）。
 */
export function detectStreamError(raw) {
  const text = String(raw || "");
  const m = /event:\s*error\s*\ndata:\s*(\{[\s\S]*?\})/.exec(text);
  if (!m) return null;
  let j = null;
  try {
    j = JSON.parse(m[1]);
  } catch {
    return { code: "CHANNEL_BIZ_ERROR", message: text.slice(0, 200) };
  }
  const code = Number(j?.code);
  const message = String(j?.message || j?.error || "上游返回错误");
  // 1001 = 认证失败（实测原文：「we are not able to authenticate you」）
  if (code === 1001) {
    return { code: "CHANNEL_AUTH_EXPIRED", message: `Trae 认证失败：${message}` };
  }
  return { code: "CHANNEL_BIZ_ERROR", message: `Trae 上游错误（${code || "?"}）：${message}` };
}

/** 把 Trae 的 SSE 事件流解析成平台口径的增量 */
export function makeStreamParser({ onDelta, onReasoning }) {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      // SSE 以空行分隔事件；只处理完整的块，最后一段留在缓冲里
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleBlock(block, onDelta, onReasoning);
      }
    },
    flush() {
      if (buf.trim()) handleBlock(buf, onDelta, onReasoning);
      buf = "";
    },
  };
}

function handleBlock(block, onDelta, onReasoning) {
  // 一个块可能是 event:xxx + data:{...}（也可能只有 data）
  const evM = /event:\s*([a-zA-Z_]+)/.exec(block);
  const dataM = /data:\s*([\s\S]*)$/.exec(block);
  if (!dataM) return;
  let j = null;
  try {
    j = JSON.parse(dataM[1].trim());
  } catch {
    return;
  }
  const ev = evM ? evM[1] : "output";
  if (ev === "request_wait_in_queue") return; // 排队提示，不是内容
  // 思考与正文分字段：思考要单独回传（平台会包装成 <think>）
  const think = j?.reasoning_content || j?.reasoning;
  if (typeof think === "string" && think && onReasoning) onReasoning(think);
  const text = j?.response ?? j?.content ?? j?.text;
  if (typeof text === "string" && text && onDelta) onDelta(text);
}

/**
 * 执行一次对话（流式）。
 * 与 openai-compat 的 chat 同签名，便于 router 统一调用。
 */
export async function chat({ channel, model, messages, prompt, onDelta, onReasoning, signal }) {
  const token = await ensureToken(channel);
  const c = credsOf(channel);
  const body = {
    // Trae 的 content 是分片数组形态（社区实测），文本片写作 {type:"text", text}
    messages: (Array.isArray(messages) && messages.length
      ? messages
      : [{ role: "user", content: prompt }]
    ).map((m) => ({
      role: m.role,
      content: typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : Array.isArray(m.content)
          ? m.content.map((part) =>
              part?.type === "text" ? { type: "text", text: part.text } : part
            )
          : [],
    })),
    model,
    // 上游用 function 区分能力档位；普通对话用 chat_v3（inline_chat 是编辑器内联补全）
    function: "chat_v3",
    stream: true,
    // request_id 与 session_id 同值：上游按它做会话粘性
    request_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
  };

  const resp = await fetch(`${c.host}/api/ide/v1/chat`, {
    method: "POST",
    headers: { ...headersFor(channel, { ...c, token }), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const code =
      resp.status === 401 || resp.status === 403
        ? "CHANNEL_AUTH_EXPIRED"
        : resp.status === 429
          ? "CHANNEL_RATE_LIMIT"
          : resp.status >= 500
            ? "CHANNEL_UPSTREAM_BUSY"
            : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`Trae 上游 HTTP ${resp.status}：${text.slice(0, 200)}`), { code });
  }
  if (!resp.body) throw Object.assign(new Error("Trae 未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });

  // 逐块读流，同时把原始文本留一份用于错误识别（200 + event:error 的情况）
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const parser = makeStreamParser({ onDelta, onReasoning });
  let rawAll = "";
  let content = "";
  let reasoning = "";
  const wDelta = (t) => {
    content += t;
    if (onDelta) onDelta(t);
  };
  const wThink = (t) => {
    reasoning += t;
    if (onReasoning) onReasoning(t);
  };
  const p2 = makeStreamParser({ onDelta: wDelta, onReasoning: wThink });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    rawAll += text;
    if (rawAll.length < 4000) p2.push(text);
  }
  p2.flush();

  // 一个字的正文都没有 → 看是不是 SSE 错误帧（200 + error 是上游的惯例）
  if (!content && !reasoning) {
    const err = detectStreamError(rawAll);
    if (err) throw Object.assign(new Error(err.message), { code: err.code });
    throw Object.assign(new Error("Trae 返回空内容"), { code: "CHANNEL_EMPTY" });
  }
  return { content, reasoning };
}

/** 健康检查：拿一次 model_list（需要认证，能同时验证令牌有效性） */
export async function verify(channel) {
  const started = Date.now();
  const token = await ensureToken(channel);
  const c = credsOf(channel);
  const resp = await fetch(`${c.host}/api/ide/v1/model_list?type=llm_raw_chat`, {
    method: "POST",
    headers: { ...headersFor(channel, { ...c, token }), "content-type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await resp.json().catch(() => null);
  // 401 + 「not able to authenticate」= 令牌无效：这是可归因的失败
  if (resp.status === 401) {
    throw Object.assign(new Error("Trae 令牌无效或已过期，请重新粘贴登录令牌"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (!resp.ok) {
    throw Object.assign(new Error(`Trae 健康检查失败（HTTP ${resp.status}）`), { code: "CHANNEL_HTTP_ERROR" });
  }
  return Date.now() - started;
}

/** 拉上游真实模型列表（用真实档位名，不是 claude-* 别名 —— 见文件头的计费警示） */
export async function fetchUpstreamModels(channel) {
  const token = await ensureToken(channel);
  const c = credsOf(channel);
  const resp = await fetch(`${c.host}/api/ide/v1/model_list?type=llm_raw_chat`, {
    method: "POST",
    headers: { ...headersFor(channel, { ...c, token }), "content-type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await resp.json().catch(() => null);
  const list = j?.model_configs || j?.Result?.model_configs || [];
  const ids = (Array.isArray(list) ? list : [])
    .map((m) => String(m?.model_name || m?.name || m?.id || "").trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

/** 该接入方式支持的登录形态：粘贴（Trae 是浏览器 OAuth，服务端接不住回调） */
export function loginModes() {
  return ["paste"];
}

/**
 * 凭据导入（粘贴 Trae 的登录令牌）。
 *
 * 接受的形态（尽量宽容，因为用户可能粘的是 storage.json 里的片段或社区工具导出的 JSON）：
 *   { "token": "...", "refreshToken": "...", "userId": "...", "region": "sg" }
 *   { "accessToken": "...", "refresh_token": "...", "user_id": "..." }   ← 常见别名
 *   裸 token 串（无法区分类型时按 refreshToken 处理：它能换出 access token，更通用）
 *
 * 与 device-bind 的判定一致：Trae 没有 device_code（浏览器 OAuth + PKCE 回调 localhost），
 * 服务端接不住，所以这里是**唯一**的接入路径 —— 指引必须写清去哪里拿。
 */
export async function importAuth(input = {}) {
  const raw = String(typeof input === "string" ? input : (input.token ?? input.json ?? "")).trim();
  if (!raw) throw Object.assign(new Error("粘贴内容为空"), { code: "LOGIN_BAD_PARAMS" });

  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = null;
  }
  let token = "";
  let refreshToken = "";
  let userId = "";
  let region = "";
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    // storage.json / 社区工具导出的 JSON：字段名各异，全试一遍
    const t = obj.credential || obj.data || obj;
    token = String(t.token || t.accessToken || t.access_token || "").trim();
    refreshToken = String(t.refreshToken || t.refresh_token || "").trim();
    userId = String(t.userId || t.user_id || t.uid || "").trim();
    region = String(t.region || t.host || "").trim();
  } else {
    // 裸串：按 refreshToken 处理（能换出 access token）
    refreshToken = raw;
  }
  if (!token && !refreshToken) {
    throw Object.assign(
      new Error("没找到 Trae 令牌：请粘贴含 token / refreshToken 的 JSON，或直接粘贴那一串令牌"),
      { code: "LOGIN_BAD_PARAMS" }
    );
  }
  // region/host → 上游主机（用户贴的是 host 时按 host 归一）
  let host = "";
  if (region) {
    const key = region.toLowerCase();
    if (HOSTS[key]) host = HOSTS[key];
    else if (/^https?:\/\//i.test(region)) host = region.replace(/\/+$/, "");
  }
  return {
    // api_key 存 token（适配器每次请求都要用它，放这里便于通用展示与掩码）
    token: token || "",
    other: {
      ...(token ? { token } : {}),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(userId ? { user_id: userId } : {}),
      ...(host ? { host, region: region.toLowerCase() } : {}),
    },
    accountLabel: `Trae${userId ? ` · ${userId.slice(0, 12)}` : ""}`,
  };
}
