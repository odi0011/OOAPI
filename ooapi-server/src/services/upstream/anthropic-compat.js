// 上游适配器：Anthropic 兼容 API（API Key）
// ===========================================================================
// 用途：接入**任何 Anthropic Messages 协议**的第三方服务（官方 api.anthropic.com、
// 各家中转、自建网关）。区别于 `claude-oauth`（Claude Code 订阅 OAuth，带 CLI 身份头 +
// 身份提示词注入），这里就是标准 `POST /v1/messages` + `x-api-key`，不做任何身份伪装。
//
// 与 openai-compat 同一设计：Base URL 归一到 /v1/messages 与 /v1/models，
// api_key 支持多行轮换（逐请求轮换，降低单 Key 限流影响）。

const DEFAULT_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MAX_LINE_BUF = 8 * 1024 * 1024;

const keyCursor = new Map();
function listKeys(channel) {
  return String(channel?.api_key || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
function nextKey(channel) {
  const keys = listKeys(channel);
  if (!keys.length) return "";
  const i = (keyCursor.get(channel.id) || 0) % keys.length;
  keyCursor.set(channel.id, i + 1);
  return keys[i];
}

/** Base URL → messages / models 端点（支持直填完整端点） */
export function endpoints(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "") || DEFAULT_BASE;
  if (/\/messages$/.test(raw)) return { messages: raw, models: raw.replace(/\/messages$/, "/models") };
  if (/\/models$/.test(raw)) return { models: raw, messages: raw.replace(/\/models$/, "/messages") };
  if (/\/v\d+[a-z]*$/i.test(raw)) return { messages: `${raw}/messages`, models: `${raw}/models` };
  return { messages: `${raw}/v1/messages`, models: `${raw}/v1/models` };
}

function headers(channel, key) {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": API_VERSION,
    accept: "application/json",
    ...(channel?.other?.extra_headers && typeof channel.other.extra_headers === "object"
      ? channel.other.extra_headers
      : {}),
  };
}

/** system 消息 → system 字段；其余严格交替 user/assistant（Anthropic 协议要求） */
function buildMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || typeof m !== "object" || m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const text = String(m.content ?? "");
    if (!out.length && role !== "user") continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  if (!out.length) out.push({ role: "user", content: "你好" });
  if (out[out.length - 1].role === "assistant") out.push({ role: "user", content: "继续" });
  return out;
}

function systemOf(messages) {
  return (messages || [])
    .filter((m) => m && m.role === "system")
    .map((m) => String(m.content ?? ""))
    .join("\n\n");
}

function injectImages(blocks, images) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role !== "user") continue;
    const arr = Array.isArray(blocks[i].content)
      ? blocks[i].content
      : [{ type: "text", text: String(blocks[i].content || "") }];
    for (const img of images) {
      arr.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType || "image/png",
          data: img.buffer.toString("base64"),
        },
      });
    }
    blocks[i].content = arr;
    break;
  }
}

export async function chat({ channel, model, prompt, messages, thinkingOverride, images = [], onDelta, onReasoning, signal }) {
  const { messages: url } = endpoints(channel?.base_url);
  const key = nextKey(channel);
  if (!key) throw Object.assign(new Error("未填写 API Key"), { code: "CHANNEL_AUTH_EXPIRED" });
  const useMessages = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: prompt }];
  const blocks = buildMessages(useMessages);
  if (images?.length) injectImages(blocks, images);
  const thinking = thinkingOverride === true;
  const body = {
    model,
    max_tokens: thinking ? 16000 : 8192,
    messages: blocks,
    stream: true,
  };
  const system = systemOf(useMessages);
  if (system) body.system = system;
  if (thinking) body.thinking = { type: "enabled", budget_tokens: 12000 };

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: headers(channel, key),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    throw Object.assign(new Error(`无法连接 Anthropic 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  }
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
      resp.status === 401 || resp.status === 403
        ? "CHANNEL_AUTH_EXPIRED"
        : resp.status === 429
          ? "CHANNEL_RATE_LIMIT"
          : [400, 404, 413, 422].includes(resp.status)
            ? "CHANNEL_BAD_REQUEST"
            : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`Anthropic 上游 HTTP ${resp.status}：${msg}`), { code, upstream: text.slice(0, 2000) });
  }
  if (!resp.body) throw Object.assign(new Error("Anthropic 上游未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let upstreamModel = model;
  let promptTokens = 0;
  let cacheRead = 0;
  let cacheCreate = 0;

  const handle = (ev) => {
    const type = String(ev?.type || "");
    if (type === "message_start" && ev.message) {
      if (ev.message.model) upstreamModel = ev.message.model;
      const u = ev.message.usage || {};
      promptTokens = Number(u.input_tokens) || 0;
      cacheRead = Number(u.cache_read_input_tokens) || 0;
      cacheCreate = Number(u.cache_creation_input_tokens) || 0;
      return;
    }
    if (type === "content_block_delta" && ev.delta) {
      const d = ev.delta;
      if (d.type === "text_delta" && d.text) {
        content += d.text;
        if (onDelta) onDelta(d.text);
      } else if (d.type === "thinking_delta" && d.thinking) {
        reasoning += d.thinking;
        if (onReasoning) onReasoning(d.thinking);
      }
      return;
    }
    if (type === "message_delta") {
      const u = ev.usage || {};
      const outTokens = Number(u.output_tokens) || 0;
      usage = {
        // Anthropic 的 input_tokens 不含缓存读写，按 OpenAI 口径合并（与 claude-oauth 一致）
        prompt_tokens: promptTokens + cacheRead + cacheCreate,
        completion_tokens: outTokens,
        total_tokens: promptTokens + cacheRead + cacheCreate + outTokens,
        cached_tokens: cacheRead,
      };
      if (ev.delta?.stop_reason === "max_tokens" && !content) {
        throw Object.assign(new Error("Anthropic 输出被 max_tokens 截断（无正文）"), { code: "CHANNEL_EMPTY" });
      }
      return;
    }
    if (type === "error") {
      const msg = ev.error?.message || "Anthropic 上游返回错误事件";
      throw Object.assign(new Error(msg), { code: "CHANNEL_BIZ_ERROR" });
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > MAX_LINE_BUF) {
        throw Object.assign(new Error("Anthropic 数据帧异常（单行超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
      }
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        handle(ev);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content && !reasoning) throw Object.assign(new Error("Anthropic 返回空内容"), { code: "CHANNEL_EMPTY" });
  return { content: content || reasoning, reasoning, usage, upstreamModel };
}

/** 健康检查：GET /v1/models（免费） */
export async function verify(channel) {
  const { models } = endpoints(channel?.base_url);
  if (!listKeys(channel).length) {
    throw Object.assign(new Error("未填写 API Key"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const resp = await fetch(models, { headers: headers(channel, listKeys(channel)[0]), signal: ac.signal });
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error(`上游拒绝鉴权（HTTP ${resp.status}），请检查 API Key`), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw Object.assign(new Error(`上游返回 HTTP ${resp.status}${body ? `：${body.slice(0, 160)}` : ""}`), {
        code: "CHANNEL_HTTP_ERROR",
      });
    }
    return Date.now() - started;
  } catch (e) {
    if (e.code) throw e;
    if (e.name === "AbortError") throw Object.assign(new Error("连接上游超时"), { code: "CHANNEL_TIMEOUT" });
    throw Object.assign(new Error(`无法连接上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取上游模型列表 */
export async function fetchUpstreamModels(channel) {
  const { models } = endpoints(channel?.base_url);
  const key = listKeys(channel)[0];
  if (!key) throw new Error("未填写 API Key");
  const resp = await fetch(models, { headers: headers(channel, key), signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`获取模型列表失败：HTTP ${resp.status}`);
  const data = await resp.json().catch(() => null);
  return (data?.data || data?.models || []).map((m) => m.id || m.name).filter(Boolean);
}
