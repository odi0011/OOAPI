// 通用 OpenAI 兼容适配器
// ===========================================================================
// 用途：所有「官方 API」接入方式的渠道都走这里。
// 目前绝大多数厂商都提供 OpenAI 兼容协议（/chat/completions），
// 所以不需要给每家单独写一个适配器 —— 差异只在 base_url 和 Key。
//
// 路径拼接规则（实测过主流几家的文档路径形态）：
//   · 地址已带版本段（/v1、/v3、/v4）→ 直接用
//   · 否则补 /v1
//   · 若用户直接把完整端点填进来（以 /chat/completions 结尾）→ 原样使用
//   例：
//     https://api.openai.com                      → /v1/chat/completions
//     https://api.deepseek.com                    → /v1/chat/completions
//     https://open.bigmodel.cn/api/paas/v4        → /api/paas/v4/chat/completions
//     https://ark.cn-beijing.volces.com/api/v3    → /api/v3/chat/completions
//     https://dashscope.aliyuncs.com/compatible-mode → /compatible-mode/v1/chat/completions
import { now, assertPublicUrl } from "../../utils.js";

// 一次性文本读取必须有上限：SSE 路径有单行 8MB 限制，JSON/错误兜底却直接 resp.text()，
// 异常或恶意上游可以用超大响应把内存打爆。分块读取并在超限时取消响应体。
const MAX_TEXT_BUF = 8 * 1024 * 1024;
async function readTextCapped(resp, max = MAX_TEXT_BUF) {
  const cl = Number(resp.headers.get("content-length") || 0);
  if (cl && cl > max) {
    await resp.body?.cancel().catch(() => {});
    throw Object.assign(new Error("上游响应体过大"), { code: "CHANNEL_BAD_RESPONSE" });
  }
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error("上游响应体过大"), { code: "CHANNEL_BAD_RESPONSE" });
      }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* ignore */
    }
  }
  return text;
}

/** 把 Base URL 归一化成 chat/completions 与 models 两个端点 */
export function endpoints(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return { chat: "", models: "" };
  // 用户直接填了完整端点
  if (/\/chat\/completions$/.test(raw)) {
    return { chat: raw, models: raw.replace(/\/chat\/completions$/, "/models") };
  }
  if (/\/models$/.test(raw)) {
    return { models: raw, chat: raw.replace(/\/models$/, "/chat/completions") };
  }
  // 已带版本段
  if (/\/v\d+[a-z]*$/i.test(raw) || /\/compatible-mode$/i.test(raw)) {
    const base = /\/compatible-mode$/i.test(raw) ? `${raw}/v1` : raw;
    return { chat: `${base}/chat/completions`, models: `${base}/models` };
  }
  return { chat: `${raw}/v1/chat/completions`, models: `${raw}/v1/models` };
}

// 多 Key 轮换：api_key 支持多行，按请求轮换（put 到 Map 的游标自增）
const keyCursor = new Map();
function listKeys(channel) {
  return String(channel.api_key || "")
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

function authHeaders(channel, keyOverride) {
  const key = keyOverride || listKeys(channel)[0] || "";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
}

/** 把入参图片转成 OpenAI 的 image_url 结构（内存中转，不落盘） */
function imageContent(images, text) {
  if (!images?.length) return text;
  const parts = [{ type: "text", text }];
  for (const img of images) {
    const mime = img.mimeType || "image/png";
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${img.buffer.toString("base64")}` },
    });
  }
  return parts;
}

/**
 * 组装请求消息。
 * 优先用原始 messages（保留 system/user/assistant 角色），
 * 没有时才退回把 prompt 当成单条 user 消息。
 */
function buildMessages({ messages, prompt, images }) {
  if (Array.isArray(messages) && messages.length) {
    // 过滤非对象元素（防御性）：调用方已过滤，这里兜底避免 TypeError 打断整条渠道链
    const out = messages
      .filter((m) => m && typeof m === "object")
      .map((m) => ({ role: m.role, content: m.content ?? "" }));
    // 图片挂在最后一条 user 消息上
    if (images?.length) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === "user") {
          out[i] = { role: "user", content: imageContent(images, String(out[i].content || "")) };
          break;
        }
      }
    }
    return out;
  }
  return [{ role: "user", content: imageContent(images, String(prompt || "")) }];
}

/** 健康检查：请求 /models（免费且不消耗额度） */
export async function verify(channel) {
  const { models } = endpoints(channel.base_url);
  if (!models) {
    throw Object.assign(new Error("未填写接口地址（Base URL）"), { code: "CHANNEL_NOT_READY" });
  }
  if (!String(channel.api_key || "").trim()) {
    throw Object.assign(new Error("未填写 API Key"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const resp = await fetch(models, { headers: authHeaders(channel), signal: ac.signal });
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
    if (e.name === "AbortError") {
      throw Object.assign(new Error("连接上游超时"), { code: "CHANNEL_TIMEOUT" });
    }
    throw Object.assign(new Error(`无法连接上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取上游模型列表（管理端「获取模型」用） */
export async function fetchUpstreamModels(channel) {
  const { models } = endpoints(channel.base_url);
  if (!models) throw new Error("未填写接口地址（Base URL）");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    // 手动逐跳重定向：调用方虽已做过一次 assertPublicUrl，但 fetch 默认跟随 302，
    // 上游只要重定向到内网地址就能绕过校验（SSRF）。每跳都校验后才继续。
    let target = models;
    let resp = null;
    for (let hop = 0; hop < 4; hop++) {
      await assertPublicUrl(target);
      resp = await fetch(target, { headers: authHeaders(channel), signal: ac.signal, redirect: "manual" });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) throw new Error("上游返回了空重定向");
        target = new URL(loc, target).toString();
        continue;
      }
      break;
    }
    if (!resp || (resp.status >= 300 && resp.status < 400)) throw new Error("重定向次数过多");
    const data = await resp.json().catch(() => null);
    return (data?.data || data?.models || []).map((m) => m.id || m.name).filter(Boolean);
  } catch (e) {
    throw new Error(`获取模型列表失败：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把上游 usage 归一为网关口径（兼容 OpenAI 标准字段、输入/输出字段别名与各家缓存字段）
 * @returns {{prompt_tokens,completion_tokens,total_tokens,cached_tokens}|null}
 */
function pickUsage(u) {
  if (!u || typeof u !== "object") return null;
  return {
    prompt_tokens: Number(u.prompt_tokens ?? u.input_tokens) || 0,
    completion_tokens: Number(u.completion_tokens ?? u.output_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
    // 缓存命中字段各家写法不一：OpenAI/新版兼容用 prompt_tokens_details.cached_tokens，
    // DeepSeek 官方用 prompt_cache_hit_tokens，部分厂商直接给 cached_tokens
    cached_tokens:
      Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens) || 0,
  };
}

/**
 * 执行一次对话（流式）
 * @returns {Promise<{content, reasoning, usage, upstreamModel}>}
 */
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
  const { chat: url } = endpoints(channel.base_url);
  if (!url) {
    throw Object.assign(new Error("未填写接口地址（Base URL）"), { code: "CHANNEL_NOT_READY" });
  }
  if (!String(channel.api_key || "").trim()) {
    throw Object.assign(new Error("未填写 API Key"), { code: "CHANNEL_AUTH_EXPIRED" });
  }

  const body = {
    model,
    messages: buildMessages({ messages, prompt, images }),
    stream: true,
    // 让上游把用量一并带回来，便于精确计费
    stream_options: { include_usage: true },
  };

  // 深度思考开关：不同厂商字段名不同。
  // 默认**不下发**厂商私有字段 —— OpenAI 等对未知请求字段直接 400。
  // 需要的渠道在 other.thinking_mode 声明：thinking | enable_thinking | both
  if (thinkingOverride !== undefined) {
    const on = Boolean(thinkingOverride);
    const m = String(model || "").toLowerCase();
    const mode = String(channel?.other?.thinkingMode ?? channel?.other?.thinking_mode ?? "").toLowerCase();
    if (!/reasoner|thinking|r1/.test(m) && mode) {
      if (mode === "thinking" || mode === "both") body.thinking = on ? { type: "enabled" } : { type: "disabled" };
      if (mode === "enable_thinking" || mode === "both") body.enable_thinking = on;
    }
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(channel, nextKey(channel)), Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  }).catch((e) => {
    if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    throw Object.assign(new Error(`无法连接上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  });

  if (!resp.ok) {
    const text = await readTextCapped(resp).catch(() => "");
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || msg;
    } catch {
      /* 保留原始文本 */
    }
    // 400/404/409/422 是请求本身的问题（模型名错、上下文超长等），换渠道也没用；
    // 这类错误不可重试，直接抛给调用方，避免把健康渠道全部冷却。
    const code =
      resp.status === 401 || resp.status === 403
        ? "CHANNEL_AUTH_EXPIRED"
        : resp.status === 429
          ? "CHANNEL_RATE_LIMIT"
          : [400, 404, 409, 413, 422].includes(resp.status)
            ? "CHANNEL_BAD_REQUEST"
            : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`上游返回 HTTP ${resp.status}：${msg}`), { code });
  }
  if (!resp.body) {
    throw Object.assign(new Error("上游未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });
  }

  // 兼容忽略 stream:true 的一次性 JSON 响应：只认 SSE 会把健康渠道误判为
  // CHANNEL_EMPTY（execute 会冷却渠道 300s），部分中转/自建网关就是这种返回
  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    const text = await readTextCapped(resp).catch(() => "");
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("上游返回了非法的 JSON"), { code: "CHANNEL_BAD_RESPONSE" });
    }
    const msg = j?.choices?.[0]?.message || {};
    const content = typeof msg.content === "string" ? msg.content : "";
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    if (reasoning && onReasoning) onReasoning(reasoning);
    if (content && onDelta) onDelta(content);
    if (!content) {
      throw Object.assign(new Error(reasoning ? "上游只返回了思考内容，没有正文" : "上游返回空内容"), {
        code: "CHANNEL_EMPTY",
      });
    }
    return {
      content,
      reasoning,
      usage: pickUsage(j?.usage),
      upstreamModel: j?.model || model,
    };
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const MAX_SSE_BUF = 8 * 1024 * 1024; // 单行（未遇到换行的缓冲）上限，防异常上游撑爆内存
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let upstreamModel = model;

  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      return;
    }
    // data: null / data: 123 等也是合法 JSON，直接读属性会抛 TypeError 打断整个流
    if (!ev || typeof ev !== "object") return;
    if (ev.model) upstreamModel = ev.model;
    if (ev.usage) usage = ev.usage;
    const d = ev.choices?.[0]?.delta;
    if (!d) return;
    // 部分厂商把思考链放在 reasoning_content，另有 reasoning 的写法
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === "string" && r) {
      reasoning += r;
      if (onReasoning) onReasoning(r);
    }
    if (typeof d.content === "string" && d.content) {
      content += d.content;
      if (onDelta) onDelta(d.content);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // 异常上游持续发送不含换行的数据会无限撑大 buf（Kimi/DeepSeek 适配器已有同样上限）
      if (buf.length > MAX_SSE_BUF) {
        throw Object.assign(new Error("上游数据帧异常（单行超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
      }
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    if (buf.trim()) handleLine(buf);
  } finally {
    // 提前结束（空内容抛错、回调抛错、客户端断开）都要归还连接，否则响应体悬挂
    reader.cancel().catch(() => {});
  }

  // 只返回思维链、没有正文的响应按失败处理：
  // 否则用户拿到空回答还会被正常计费（思考 token 已经产生，但答案缺失）。
  if (!content) {
    throw Object.assign(new Error(reasoning ? "上游只返回了思考内容，没有正文" : "上游返回空内容"), { code: "CHANNEL_EMPTY" });
  }

  return {
    content,
    reasoning,
    usage: pickUsage(usage),
    upstreamModel,
  };
}

/** 登录方式：API 渠道不需要登录 */
export function loginModes() {
  return ["apikey"];
}
