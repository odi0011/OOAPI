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
import { now, assertPublicUrlCached } from "../../utils.js";
import { assertNoContentError } from "./content-error.js";
import { applyVendorRequest, effectiveModelOf, reasoningDeltaOf, splitThinkTags } from "./vendor-quirks.js";

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

/**
 * 该渠道是否被允许访问内网上游。
 * 只有适配器在**自己做过白名单校验**之后才敢设 other.allow_private_upstream；
 * 它绝不能来自用户可编辑的表单字段（那等于给 SSRF 开后门）。
 */
function isPrivateUpstream(channel) {
  return channel?.other?.allow_private_upstream === true;
}

/**
 * 带 SSRF 防护的 fetch —— 本文件所有出站请求都必须走这里。
 *
 * 两件事：
 *  ① 请求前校验目标为公网地址（`assertPublicUrlCached`，60 秒 DNS 缓存不拖慢网关）。
 *     之所以不能只在「拉模型」那条路径校验：`channel.api_key` 是在 chat 里发出去的，
 *     而 base_url 有两个不可信来源 —— 管理员填的表单，以及适配器从**凭据 JSON** 里
 *     取出的 endpoint（Qoder 就是）。只校验拉模型路径等于留了条把 Bearer 送到任意
 *     地址（含内网、云元数据 169.254.169.254）的路。
 *  ② 手动逐跳重定向并在每跳重新校验 —— fetch 默认跟随 302，上游只要重定向到内网
 *     就能绕过校验。
 *
 * 例外：`allowPrivate` 为真时跳过公网校验（见 isPrivateUpstream）。
 */
async function guardedFetch(url, init = {}, { allowPrivate = false } = {}) {
  const check = async (target) => {
    if (allowPrivate) return;
    await assertPublicUrlCached(target);
  };
  let target = url;
  await check(target);
  for (let hop = 0; hop < 4; hop++) {
    const resp = await fetch(target, { ...init, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) throw new Error("上游返回了空重定向");
      target = new URL(loc, target).toString();
      await check(target);
      continue;
    }
    return resp;
  }
  throw new Error("重定向次数过多");
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
  // 专属接入方式（WorkBuddy 等）通过 other.extra_headers 注入设备/企业风控头
  const extra = channel?.other?.extra_headers;
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(extra && typeof extra === "object" ? extra : {}),
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
          // **必须先把 content 归一成字符串，再交给 imageContent**。
          //
          // 这里踩过一个会让模型收到垃圾输入的坑（黑盒测试实测，P0）：
          // OpenAI SDK / Responses API 会把 content 传成**分片数组**
          // （`[{type:"text",text:"..."},{type:"image_url",...}]`），
          // 而这里直接 `String(array)` —— JS 会把每个对象转成 "[object Object]"，
          // 于是模型真正收到的是 `[object Object],[object Object]`。
          // 用户看到的是模型答非所问（还在讨论 "[object Object] 这个占位符"），
          // 却照常被计费；而日志里存的 prompt 是对的，排查时会以为模型疯了。
          const norm = normalizeContentToText(out[i].content);
          out[i] = { role: "user", content: imageContent(images, norm) };
          break;
        }
      }
    }
    return out;
  }
  return [{ role: "user", content: imageContent(images, String(prompt || "")) }];
}

/**
 * 把 messages 里的 content 归一成纯文本。
 * 分片数组只取文本片（图片片由 imageContent 统一追加，避免重复）。
 * 这个函数存在的唯一原因就是上面那条注释里的 P0 —— 不要把 String() 用在这里。
 */
export function normalizeContentToText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text") return String(part.text ?? part.content ?? "");
        // image_url 片由 imageContent 从 images 参数统一加（避免同一张图加两次）
        return "";
      })
      .join("");
  }
  if (typeof content === "object") {
    return String(content.text ?? "");
  }
  return String(content);
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
    const resp = await guardedFetch(models, { headers: authHeaders(channel), signal: ac.signal }, { allowPrivate: isPrivateUpstream(channel) });
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
    const resp = await guardedFetch(
      models,
      { headers: authHeaders(channel), signal: ac.signal },
      { allowPrivate: isPrivateUpstream(channel) }
    );
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
  // 可选：解包上游的响应包封（Cline 官方 SDK 定义里带 responseEnvelope: "success-data"，
  // 社区报告非流式会把 choices 包在 data 里）。传进来的函数对「标准形状」应原样返回，
  // 只有真存在包封时才解 —— 这样对绝大多数厂商是零影响的空操作。
  unwrap,
}) {
  // 上游 5xx（503 Service is too busy / 502 Bad Gateway …）是**上游瞬时过载**，
  // 不是这个渠道坏了 —— 线上实测：DeepSeek 官方 API 的 503 是随机的，
  // 同一把 key 连打 6 次全部 200（503 与请求内容、key 有效性都无关）。
  // 这种错误原地等一下再打常常就好了，比「冷却渠道 + 换下一个渠道」代价小得多：
  //   · 换渠道会绕远路（用户可能只有这一个渠道，那就直接失败）；
  //   · 冷却渠道还会把一次上游抖动记成渠道故障（成功率被污染）。
  // 所以这里先原地重试两次（0.6s / 1.8s 退避），都不成才交给上层换渠道。
  // 只在**还没吐出任何内容**时重试：已经流式输出过就不能重来，
  // 否则客户端会收到两份拼接的内容（与 execute 的 sawOutput 判定同源）。
  const BUSY_RETRIES = 2;
  let sawOutput = false;
  const emitDelta = (t) => {
    sawOutput = true;
    if (onDelta) onDelta(t);
  };
  const emitReasoning = (t) => {
    sawOutput = true;
    if (onReasoning) onReasoning(t);
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chatOnce({
        channel,
        model,
        prompt,
        messages,
        thinkingOverride,
        images,
        onDelta: emitDelta,
        onReasoning: emitReasoning,
        signal,
        unwrap,
      });
    } catch (e) {
      const busy = e?.code === "CHANNEL_UPSTREAM_BUSY";
      if (!busy || attempt >= BUSY_RETRIES || sawOutput || signal?.aborted) throw e;
      const waitMs = 600 * 3 ** attempt;
      console.warn(`[openai-compat] 上游过载（${e.message.slice(0, 80)}），${waitMs}ms 后原地重试（第 ${attempt + 1}/${BUSY_RETRIES} 次）`);
      await new Promise((r) => setTimeout(r, waitMs));
      // 等待期间客户端可能已断开：别白打一次上游
      if (signal?.aborted) throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    }
  }
}

async function chatOnce({
  channel,
  model,
  prompt,
  messages,
  thinkingOverride,
  images = [],
  onDelta,
  onReasoning,
  signal,
  unwrap,
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

  // 厂商协议差异在这统一落地（MiniMax 的 reasoning_split 必须开、
  // 方舟的 thinking 格式与 max_tokens 互斥、StepFun 的参数裁剪），见 vendor-quirks.js
  applyVendorRequest(body, { channel, model });

  const resp = await guardedFetch(
    url,
    {
      method: "POST",
      headers: { ...authHeaders(channel, nextKey(channel)), Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    },
    { allowPrivate: isPrivateUpstream(channel) }
  ).catch((e) => {
    if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    // 地址被拒（SSRF 防护）是可归因的配置错误，不能混进 CHANNEL_NETWORK
    // ——那会让渠道被当成「网络抖动」换个号重试，实际配置永远不会自愈。
    if (/内网|协议不允许|携带凭据|解析|重定向/.test(String(e.message || ""))) {
      throw Object.assign(new Error(`接口地址被拒绝：${e.message}`), { code: "CHANNEL_NOT_READY" });
    }
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
    // 5xx 单独归类为 CHANNEL_UPSTREAM_BUSY：那是**上游自己过载**（DeepSeek 的
    // 「Service is too busy」、各家网关的 502/504），不是这个渠道的凭据或配置有问题。
    // 交给 chat() 的循环原地重试；重试仍失败才算渠道异常。
    const code =
      resp.status === 401 || resp.status === 403
        ? "CHANNEL_AUTH_EXPIRED"
        : resp.status === 429
          ? "CHANNEL_RATE_LIMIT"
          : resp.status >= 500
            ? "CHANNEL_UPSTREAM_BUSY"
            : [400, 404, 409, 413, 422].includes(resp.status)
              ? "CHANNEL_BAD_REQUEST"
              : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`上游返回 HTTP ${resp.status}：${msg}`), { code, status: resp.status });
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
    // 思维链字段各家不同：reasoning_content / reasoning / MiniMax 的 reasoning_details
    let reasoning =
      typeof msg.reasoning_content === "string"
        ? msg.reasoning_content
        : typeof msg.reasoning === "string"
          ? msg.reasoning
          : reasoningDeltaOf(msg);
    let content = typeof msg.content === "string" ? msg.content : "";
    // 兜底剥离正文里的 <think> 块（理由见流式分支的同名处理）
    const split = splitThinkTags(content);
    if (split.reasoning) {
      reasoning += split.reasoning;
      content = split.content;
    }
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
      // 方舟自动降级：非流式响应同样带 service_status
      billModel: effectiveModelOf(j),
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
  // 上游「实际生效」的模型（方舟自动降级时会与请求的 model 不同）。
  // 与 upstreamModel 分开：后者是上游回显的名字，前者是**该按谁计费**的依据。
  let fallbackModel = "";

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
    // 上游可能把结果包一层（Cline 的 data 包封）：解包后再按标准形状读。
    // unwrap 是适配器传入的可选钩子，未传时完全不执行（对其它厂商零影响）。
    if (unwrap) ev = unwrap(ev) || ev;
    // 火山方舟会在容量紧张时自动降级到别的模型跑，这里读**实际生效**的模型名，
    // 计费与日志都据此（否则会按 A 的价收 B 的钱）——见 vendor-quirks.js
    const eff = effectiveModelOf(ev);
    if (eff) fallbackModel = eff;
    if (ev.model) upstreamModel = ev.model;
    if (ev.usage) usage = ev.usage;
    const d = ev.choices?.[0]?.delta;
    if (!d) return;
    // 部分厂商把思考链放在 reasoning_content，另有 reasoning 的写法；
    // MiniMax 开 reasoning_split 后放在 reasoning_details（数组）——统一在这里读
    const r = d.reasoning_content ?? d.reasoning ?? reasoningDeltaOf(d);
    if (typeof r === "string" && r) {
      reasoning += r;
      if (onReasoning) onReasoning(r);
    }
    if (typeof d.content === "string" && d.content) {
      // 兜底剥离正文里的 <think> 块：个别版本/中转即使开了 reasoning_split
      // 仍可能把思维链混在 content 里，那种内容不该当正文展示
      const { content: c, reasoning: r2 } = splitThinkTags(d.content);
      if (r2) {
        reasoning += r2;
        if (onReasoning) onReasoning(r2);
      }
      if (c) {
        content += c;
        if (onDelta) onDelta(c);
      }
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
  // 上游可能把错误写成正常正文（模型下线/权限不足/额度耗尽），HTTP 200 且
  // 有正文。这类响应按成功处理会让渠道测试写 ok=1、重置冷却，而真实用户
  // 必然失败（线上实测抓到过，见 AI协作.md 第 46 批）。这里是**所有走
  // openai-compat 的渠道**的公共出口，一处拦截覆盖大部分厂商。
  assertNoContentError(content, "上游");

  return {
    content,
    reasoning,
    usage: pickUsage(usage),
    upstreamModel,
    // 实际生效模型（方舟降级时非空）：计费按它算，见 vendor-quirks.js 的说明
    billModel: fallbackModel,
  };
}

/** 登录方式：API 渠道不需要登录 */
export function loginModes() {
  return ["apikey"];
}
