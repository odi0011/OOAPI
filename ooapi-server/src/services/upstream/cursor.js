// 上游适配器：Cursor（cursor.com，Anysphere 的 AI 编辑器）
// ===========================================================================
// 这是本项目里协议最特殊的一个 —— 它**同时**要求：
//   ① HTTP/2（Node 的 fetch 走 h1.1 被上游 415 拒，实测确认）；
//   ② Connect 帧（`[1B flag][4B 大端长度][JSON]`；不帧装上游回
//      "protocol error: missing input message for server-streaming method"）；
//   ③ 自定义主机与路径（`api2.cursor.sh/aiserver.v1.AiService/StreamChat`）。
// 所以传输层单独实现（见 cursor-transport.js），本文件只负责「协议 ↔ 平台口径」的翻译。
//
// ---- 请求/响应 schema（**来自 Cursor 官方客户端 bundle 的 proto 定义**，非推测）----
// 调研方式：下载官方稳定版客户端（cursor_3.21.18_amd64.deb），从它的
// protobuf-ts 紧凑 schema 里解出 5795 个消息定义，其中：
//   StreamChat 的输入 = `aiserver.v1.GetChatRequest`
//   StreamChat 的输出 = `aiserver.v1.StreamChatResponse`
// 并且在服务端**逐字段验证过类型**（服务端在认证之前就解码请求体，会把确切的
// 字段名/类型回显在错误里，例如：
//   `cannot decode field aiserver.v1.GetChatRequest.conversation from JSON: "x"`）
//
// GetChatRequest 只用得到这几个字段（其余 20+ 个是 IDE 上下文，网关不需要）：
//   conversation[]   → ConversationMessage { text=1, type=2(1=HUMAN,2=AI), bubble_id=13 }
//   modelDetails     → ModelDetails { model_name=1 }
//   requestId / conversationId
//   isComposer       → 走 composer 模式（网页版对话用 false 更稳）
//
// ⚠️ 两个实测出来的坑：
//   · **枚举要用数字**（type: 1 / 2）。写 "HUMAN" 这类字符串**不会报错**，
//     但会被服务端的 DiscardUnknown 静默丢掉 —— 表现为"消息发出去了但模型没收到"。
//   · 未知字段名同样被静默丢弃，所以「探字段」探不出来，只有**类型不匹配**才报错。
//
// ---- 认证（两条路，都实测过）----
//   · **推荐：官方 API Key**（`crsr_...`）
//     POST https://api2.cursor.sh/auth/exchange_user_api_key
//       headers { authorization: `Bearer crsr_...`, content-type: application/json }
//       body `{}`（**空 body 会 400**：'Body cannot be empty when content-type is
//       set to application/json'）
//     → { accessToken, refreshToken }
//     这条路的好处是**不需要 machineId、不需要 checksum 签名**：API Key 换 token
//     的接口是公开的普通 REST，令牌长期有效且可续期。
//   · 备选：从 IDE 本地库取的 accessToken（需要 machineId 才完整）
//
// ---- 请求头（实测哪些是必需的）----
//   必需：authorization、content-type: application/connect+json
//   **不需要**：x-cursor-checksum（伪造值也能进认证层；CLI 客户端根本不发它）、
//               x-cursor-client-version、x-request-id（发了更像官方客户端，但不门控）
//   仍然带上后三个：它们让流量看起来像官方客户端（降低风控概率），成本为零。
import crypto from "node:crypto";
import { now } from "../../utils.js";
import { withRefreshLock, persistOtherPatch } from "./auth-store.js";
import { connectPost, connectUnary, detectFrameError, assertCursorHost } from "./cursor-transport.js";

const API_HOST = "https://api2.cursor.sh";
const STREAM_CHAT = `${API_HOST}/aiserver.v1.AiService/StreamChat`;
const EXCHANGE_KEY = `${API_HOST}/auth/exchange_user_api_key`;
// 官方客户端自报的版本号（CLI 形态）。不发也不影响认证，但发了更像官方流量。
const CLIENT_VERSION = "cli-2026.09.23-agent-host";

/** 凭据形态：other.api_key（crsr_ 官方 Key）优先；否则 other.access_token（IDE 里取的） */
function credsOf(channel) {
  const o = channel?.other || {};
  return {
    apiKey: String(o.cursor_api_key || "").trim(),
    accessToken: String(o.access_token || channel?.api_key || "").trim(),
    refreshToken: String(o.refresh_token || "").trim(),
    machineId: String(o.machine_id || "").trim(),
  };
}

/** 公共请求头。注意 content-type 由传输层负责（它是 Connect 帧，不能在这里覆盖） */
function baseHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "user-agent": "cursor-agent/1.0",
    // 自报客户端身份（非必需，但让流量像官方客户端）
    "x-cursor-client-version": CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-request-id": crypto.randomUUID(),
  };
}

/**
 * 用官方 API Key 换内部 token（并缓存到 other）。
 *
 * 为什么值得单独一条路：它**不需要 machineId、不需要 checksum**，而且返回
 * refreshToken 可以续期 —— 比让用户从 IDE 本地库抠 accessToken 可靠得多。
 */
export async function exchangeApiKey(apiKey, { signal } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw Object.assign(new Error("未填写 Cursor API Key（crsr_...）"), { code: "CHANNEL_AUTH_EXPIRED" });
  const r = await fetch(EXCHANGE_KEY, {
    method: "POST",
    // body **必须**是 JSON 对象：空 body 会被 400 拒（官方客户端源码里也是发 {}）
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({}),
    signal: signal || AbortSignal.timeout(30_000),
  }).catch((e) => {
    throw Object.assign(new Error(`换取 Cursor 令牌失败：${e.message}`), { code: "CHANNEL_NETWORK" });
  });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* 非 JSON：下面按状态码判断 */
  }
  if (r.status === 401 || r.status === 403) {
    throw Object.assign(
      new Error(`Cursor API Key 无效或已失效（HTTP ${r.status}）：${String(j?.message || text).slice(0, 120)}`),
      { code: "CHANNEL_AUTH_EXPIRED" }
    );
  }
  if (!r.ok) {
    throw Object.assign(new Error(`换取 Cursor 令牌失败（HTTP ${r.status}）：${String(text).slice(0, 150)}`), {
      code: r.status >= 500 ? "CHANNEL_UPSTREAM_BUSY" : "CHANNEL_AUTH_EXPIRED",
    });
  }
  const accessToken = String(j?.accessToken || j?.access_token || "");
  if (!accessToken) {
    throw Object.assign(new Error(`Cursor 未返回 accessToken：${String(text).slice(0, 150)}`), {
      code: "CHANNEL_BAD_RESPONSE",
    });
  }
  return { accessToken, refreshToken: String(j?.refreshToken || j?.refresh_token || "") };
}

/** 取一个可用 token；有 API Key 就（按需）换取并缓存，否则用 IDE 的 access_token */
async function ensureToken(channel) {
  const c = credsOf(channel);
  // 官方 API Key：换出来的 token 缓存在 other.access_token，快过期才重换
  if (c.apiKey) {
    const exp = Number(channel?.other?.expires_at) || 0;
    const soon = exp > 0 && exp - Math.floor(Date.now() / 1000) < 600;
    if (!c.accessToken || soon) {
      return withRefreshLock(channel, async () => {
        const r = await exchangeApiKey(c.apiKey);
        await persistOtherPatch(channel, {
          access_token: r.accessToken,
          refresh_token: r.refreshToken,
          // Cursor 没给过期时间：按 12 小时保守预估，到点重换（换取是免费的）
          expires_at: now() + 12 * 3600,
          cred_epoch: (Number(channel?.other?.cred_epoch) || 0) + 1,
          cred_updated_at: now(),
        });
        return r.accessToken;
      });
    }
    return c.accessToken;
  }
  if (!c.accessToken) {
    throw Object.assign(
      new Error("未填写 Cursor 凭据：请填官方 API Key（crsr_...），或粘贴 IDE 的 accessToken"),
      { code: "CHANNEL_AUTH_EXPIRED" }
    );
  }
  return c.accessToken;
}

/**
 * 把平台的 messages 拍成 Cursor 的 conversation 数组。
 * ConversationMessage.type 用**数字**（1=HUMAN, 2=AI）—— 写字符串会被静默丢弃。
 */
export function buildConversation({ messages, prompt }) {
  const out = [];
  const src = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: String(prompt || "") }];
  for (const m of src) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "user");
    // system 在 Cursor 里没有对应角色：并入第一条人类消息（网关层面已经拼过 prompt，
    // 这里保持简单 —— 官方 IDE 用的是独立字段，不属于我们要覆盖的普通对话场景）
    if (role === "system") continue;
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text || "" : "")).join("")
        : String(m.content ?? "");
    if (!text) continue;
    out.push({
      text,
      type: role === "assistant" ? 2 : 1, // 1=HUMAN, 2=AI（数字！）
      bubbleId: crypto.randomUUID(),
    });
  }
  if (!out.length) out.push({ text: String(prompt || ""), type: 1, bubbleId: crypto.randomUUID() });
  return out;
}

/**
 * 从一帧 StreamChatResponse 里取出增量。
 * 文本增量在 `text`（字段 1）。推理内容没有专用字段 —— 唯一看似合理的载体是
 * `intermediate_text`（字段 7），但**未用真实凭据验证过**，所以只把它当推理返回、
 * 不影响正文（若上游其实不用它，这段逻辑就是空转，不会污染输出）。
 */
export function pickDeltas(json) {
  if (!json || typeof json !== "object") return { text: "", reasoning: "" };
  const text = typeof json.text === "string" ? json.text : "";
  const reasoning = typeof json.intermediateText === "string" ? json.intermediateText : "";
  return { text, reasoning };
}

/**
 * 执行一次对话（流式）。与 openai-compat 的 chat 同签名，便于 router 统一调用。
 */
export async function chat({ channel, model, messages, prompt, onDelta, onReasoning, signal }) {
  const token = await ensureToken(channel);
  const conversation = buildConversation({ messages, prompt });
  const body = {
    conversation,
    modelDetails: { modelName: String(model || "composer-2.5") },
    requestId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    // isComposer=true 走 composer 通道（官方 IDE 的默认对话形态）；
    // 网页版/其它场景保持 false 更接近普通聊天
    isComposer: Boolean(channel?.other?.cursor_composer),
  };

  let content = "";
  let reasoning = "";
  let sawAny = false;
  let upstreamErr = null;

  const { status } = await connectPost({
    url: STREAM_CHAT,
    headers: baseHeaders(token),
    body,
    signal,
    timeoutMs: Math.min(600_000, Number(channel?.other?.probe_timeout_ms) || 180_000),
    onFrames: (frames) => {
      for (const f of frames) {
        const j = f.json;
        if (!j) continue;
        const err = detectFrameError(j);
        if (err) {
          upstreamErr = err;
          return;
        }
        sawAny = true;
        const { text, reasoning: r } = pickDeltas(j);
        if (r && onReasoning) {
          reasoning += r;
          onReasoning(r);
        }
        if (text) {
          content += text;
          if (onDelta) onDelta(text);
        }
      }
    },
  });

  if (upstreamErr) throw Object.assign(new Error(upstreamErr.message), { code: upstreamErr.code });
  // HTTP 层错误：Connect 的网关会用非 200 表示协议/路由问题
  if (status && status !== 200) {
    throw Object.assign(new Error(`Cursor 上游 HTTP ${status}`), {
      code: status === 401 || status === 403 ? "CHANNEL_AUTH_EXPIRED" : status >= 500 ? "CHANNEL_UPSTREAM_BUSY" : "CHANNEL_HTTP_ERROR",
    });
  }
  if (!content && !reasoning) {
    throw Object.assign(new Error(sawAny ? "Cursor 返回空内容" : "Cursor 未返回任何帧"), { code: "CHANNEL_EMPTY" });
  }
  return { content, reasoning, upstreamModel: model };
}

/** 健康检查：用 AvailableModels（一元、普通 JSON、不消耗额度）验证令牌有效 */
export async function verify(channel) {
  const started = Date.now();
  const token = await ensureToken(channel);
  // 一元方法**不需要 Connect 帧**（发帧反而 415）—— 实测结论，所以这里用普通 fetch
  const r = await fetch(`${API_HOST}/aiserver.v1.AiService/AvailableModels`, {
    method: "POST",
    headers: { ...baseHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => {
    throw Object.assign(new Error(`无法连接 Cursor：${e.message}`), { code: "CHANNEL_NETWORK" });
  });
  const text = await r.text();
  // 401 + ERROR_NOT_LOGGED_IN = 令牌无效（可归因的失败）
  if (r.status === 401 || /ERROR_NOT_LOGGED_IN|NOT_LOGGED_IN/i.test(text)) {
    throw Object.assign(new Error("Cursor 令牌无效或已过期，请重新填写 API Key 或重新获取凭据"), {
      code: "CHANNEL_AUTH_EXPIRED",
    });
  }
  if (!r.ok) {
    throw Object.assign(new Error(`Cursor 健康检查失败（HTTP ${r.status}）：${text.slice(0, 120)}`), {
      code: "CHANNEL_HTTP_ERROR",
    });
  }
  return Date.now() - started;
}

/**
 * 拉上游模型列表。
 * Cursor 的模型是**产品内档位**（composer / claude / gpt 系列），不是厂商原名 ——
 * 所以这里返回我们登记的默认模型（与 channel-types 的 defaultModels 一致），
 * 而不是去猜上游的可用清单（AvailableModels 需要有效令牌，且返回的是内部结构）。
 */
export async function fetchUpstreamModels() {
  return ["composer-2.5", "composer-2.5-fast", "claude-4.5-sonnet", "gpt-5.6-luna", "gemini-3.1-pro", "grok-4.6"];
}

/**
 * 凭据导入（粘贴）。
 * 接受两种形态：
 *   · 官方 API Key：`crsr_...`（裸串）或 { "api_key": "crsr_..." }
 *   · IDE 凭据：{ "accessToken": "...", "machineId": "..." }（从本地 state.vscdb 取）
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
  let apiKey = "";
  let accessToken = "";
  let refreshToken = "";
  let machineId = "";
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    apiKey = String(obj.api_key || obj.apiKey || obj.cursor_api_key || "").trim();
    accessToken = String(obj.accessToken || obj.access_token || obj.token || "").trim();
    refreshToken = String(obj.refreshToken || obj.refresh_token || "").trim();
    machineId = String(obj.machineId || obj.machine_id || "").trim();
  } else if (/^crsr_/i.test(raw)) {
    apiKey = raw;
  } else {
    // 裸串且不是 crsr_：按 IDE 的 accessToken 处理
    accessToken = raw;
  }
  // API Key 形态：**当场换一次 token 验证可用**，避免存进一个错的 Key
  let verified = null;
  if (apiKey) {
    verified = await exchangeApiKey(apiKey); // 失败会抛（凭据错就该当场报）
  }
  if (!apiKey && !accessToken) {
    throw Object.assign(new Error("没找到 Cursor 凭据：请粘贴 crsr_ 开头的 API Key，或含 accessToken 的 JSON"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  return {
    // api_key 存 API Key（若只有 accessToken 则存它，便于通用展示）
    token: apiKey || accessToken,
    other: {
      ...(apiKey ? { cursor_api_key: apiKey } : {}),
      ...(verified ? { access_token: verified.accessToken, refresh_token: verified.refreshToken, expires_at: now() + 12 * 3600 } : {}),
      ...(!verified && accessToken ? { access_token: accessToken } : {}),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(machineId ? { machine_id: machineId } : {}),
    },
    accountLabel: apiKey ? `Cursor API Key · ${apiKey.slice(0, 10)}…` : "Cursor IDE 凭据",
  };
}

/** 该接入方式的登录形态：粘贴（没有可用的服务端设备授权流程） */
export function loginModes() {
  return ["paste"];
}

export { assertCursorHost, connectUnary };
