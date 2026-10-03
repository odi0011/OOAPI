import { ToolCallBuffer, applyToolDefinitions, responsesMessages } from "../tool-wire.js";
import { reasoningBody } from "../model-capabilities.js";
// Zen 官方端点表明确区分 Responses 与 SystemOne。仅转换已确认的模型，
// 不把 Jev 的结构化判定伪造成聊天，也不影响 GO 的兼容接口。
// 来源：opencode.ai/docs/zen/；docs.typesafe.ai/api。
import { authHeaders, endpoints, guardedFetch, nextKey, readTextCapped, normalizeContentToText } from "./openai-compat.js";
import { classifyUpstreamHttp } from "./http-error.js";
import { parseSystemOneInput, renderAnswers } from "./typesafe.js";
import { getNumberOption } from "../../config.js";

export function nativeProtocol(model) {
  const id = String(model || "").toLowerCase().split("/").pop();
  if (["muse-spark-1.2", "muse-spark-1.3", "muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"].includes(id)) return "responses";
  if (["jev-1.13", "jev-1.13-free"].includes(id)) return "systemone";
  return "";
}

function nativeUrl(base, protocol) {
  const raw = String(base || "").replace(/\/+$/, "");
  if (!raw) return "";
  if (/\/(?:responses|systemone|models|chat\/completions)$/.test(raw)) {
    return raw.replace(/\/(?:responses|systemone|models|chat\/completions)$/, `/${protocol}`);
  }
  return endpoints(raw).chat.replace(/\/chat\/completions$/, `/${protocol}`);
}

function usageOf(u) {
  if (!u || typeof u !== "object") return undefined;
  return {
    prompt_tokens: Math.max(0, Number(u.input_tokens ?? u.prompt_tokens) || 0),
    completion_tokens: Math.max(0, Number(u.output_tokens ?? u.completion_tokens) || 0),
    cached_tokens: Math.max(0, Number(u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? u.cached_tokens) || 0),
    ...(u.output_tokens_details?.reasoning_tokens == null ? {} : { reasoning_tokens: Math.max(0, Number(u.output_tokens_details.reasoning_tokens) || 0) }),
  };
}
const used = (usage) => Boolean(usage && (usage.prompt_tokens > 0 || usage.completion_tokens > 0));
const makeError = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function responsesBody(args, model) {
  const messages = Array.isArray(args.messages) && args.messages.length ? args.messages : [{ role: "user", content: args.prompt || "" }];
  const instructions = messages.filter((m) => m?.role === "system" || m?.role === "developer").map((m) => normalizeContentToText(m.content)).filter(Boolean).join("\n\n");
  const input = messages.filter((m) => m && !["system", "developer"].includes(m.role)).map((m) => {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = [{ type: role === "assistant" ? "output_text" : "input_text", text: normalizeContentToText(m.content) }];
    if (role === "user" && Array.isArray(m.content) && !args.images?.length) {
      for (const part of m.content) {
        const image = part?.type === "image_url" ? part.image_url?.url : part?.type === "input_image" ? part.image_url : null;
        if (image) content.push({ type: "input_image", image_url: image });
      }
    }
    return { role, content };
  });
  if (messages.some(m => m.tool_calls || m.role === "tool")) input.splice(0, input.length, ...responsesMessages(messages));
  if (args.images?.length) {
    const last = [...input].reverse().find((m) => m.role === "user");
    if (last) for (const img of args.images) last.content.push({ type: "input_image", image_url: `data:${img.mimeType || "image/png"};base64,${img.buffer.toString("base64")}` });
  }
  const body = { model, input, ...(instructions ? { instructions } : {}), stream: true, store: false };
  const max = Number(args.maxOutputTokens ?? args.max_output_tokens ?? args.max_completion_tokens ?? args.max_tokens ?? args.maxTokens);
  if (Number.isFinite(max) && max > 0) body.max_output_tokens = Math.floor(max);
  for (const name of ["temperature", "top_p"]) {
    if (args[name] != null && Number.isFinite(Number(args[name]))) body[name] = Number(args[name]);
  }
  if (args.reasoning && typeof args.reasoning === "object") {
    body.reasoning = Object.fromEntries(["effort", "summary"].filter((key) => args.reasoning[key] != null).map((key) => [key, args.reasoning[key]]));
  } else if (args.reasoning_effort != null) body.reasoning = { effort: String(args.reasoning_effort) };
  else if (args.thinkingOverride != null) body.reasoning = { effort: args.thinkingOverride ? "medium" : "none" };
  Object.assign(body, reasoningBody(args.reasoningConfig, "responses"));
  applyToolDefinitions(body, args.tools, args.toolChoice, "responses");
  return body;
}

function responseText(response, reasoning = false) {
  return (Array.isArray(response?.output) ? response.output : []).flatMap((item) => {
    if (reasoning) return item?.type === "reasoning" ? (item.summary || []).map((x) => x.text || "") : [];
    return (item?.content || []).filter((x) => x.type === "output_text").map((x) => x.text || "");
  }).join("");
}

export async function chatNative(args, protocol, model) {
  const { channel, onDelta, onReasoning, onUsage } = args;
  const toolBuffer = new ToolCallBuffer(args.onToolCall);
  const url = nativeUrl(channel.base_url, protocol);
  if (!url) throw makeError("未填写接口地址", "CHANNEL_NOT_READY", { upstreamStarted: false, billable: false });
  const key = nextKey(channel);
  if (!key) throw makeError("未填写 API Key", "CHANNEL_AUTH_EXPIRED", { upstreamStarted: false, billable: false });
  let body;
  if (protocol === "systemone") {
    if (args.images?.length) throw makeError("Jev 不支持图片", "VISION_NOT_SUPPORTED", { upstreamStarted: false, billable: false });
    const last = [...(args.messages || [])].reverse().find((m) => m?.role === "user");
    body = { model, ...parseSystemOneInput(normalizeContentToText(last?.content ?? args.prompt)) };
  } else body = responsesBody(args, model);
  // 免费档在最后一刻补 agent 工具（仅 Responses；SystemOne 是结构化判定请求，
  // 不是 agent 流量，注入流式或工具定义反而会被上游拒绝）
  if (protocol !== "systemone" && typeof args.bodyHook === "function") args.bodyHook(body);
  const signal = args.signal || AbortSignal.timeout(getNumberOption("request_timeout_ms") || 60_000);
  let content = "", reasoning = "", usage, upstreamModel = model, status = 0, truncated = false;
  const acceptUsage = (value) => {
    const parsed = usageOf(value);
    if (parsed) { usage = parsed; onUsage?.(usage); }
  };
  const emit = (text, think = false) => {
    if (!text) return;
    if (think) { reasoning += text; onReasoning?.(text); }
    else { content += text; onDelta?.(text); }
  };
  const finalResponse = (response) => {
    toolBuffer.responses({ response });
    upstreamModel = response?.model || upstreamModel;
    acceptUsage(response?.usage);
    for (const think of [false, true]) {
      const full = responseText(response, think), current = think ? reasoning : content;
      if (full && full.startsWith(current)) emit(full.slice(current.length), think);
    }
  };
  try {
    const resp = await guardedFetch(url, { method: "POST", headers: {
      ...authHeaders(channel, key), Accept: protocol === "responses" ? "text/event-stream" : "application/json",
    }, body: JSON.stringify(body), signal }, { allowPrivate: channel.other?.allow_private_upstream === true });
    status = resp.status;
    if (!resp.ok) {
      const text = await readTextCapped(resp);
      let parsed;
      try { parsed = JSON.parse(text); } catch { /* HTML errors are classified by status. */ }
      acceptUsage(parsed?.usage);
      const classified = classifyUpstreamHttp(status, text);
      throw makeError(`上游返回 HTTP ${status}`, classified.code, { status, hint: classified.hint, upstreamRejected: true, billable: used(usage) });
    }
    if (protocol === "systemone" || !/text\/event-stream/i.test(resp.headers.get("content-type") || "")) {
      let json;
      try { json = JSON.parse(await readTextCapped(resp)); }
      catch (e) { throw e.code ? e : makeError("上游返回非 JSON 数据", "CHANNEL_BAD_RESPONSE"); }
      acceptUsage(json?.usage);
      if (json?.error) throw makeError("上游返回错误响应", "CHANNEL_STREAM_ERROR", { upstreamRejected: true });
      if (protocol === "systemone") {
        upstreamModel = json?.model || upstreamModel;
        const rendered = renderAnswers(json?.answers);
        if (!rendered) throw makeError("SystemOne 未返回判断答案", "CHANNEL_BAD_RESPONSE");
        emit(rendered);
        return { content, reasoning, usage, upstreamModel, toolCalls: toolBuffer.finish(), assistantExtras: toolBuffer.assistantExtras, retryCount: 0, structured: { model: upstreamModel, answers: json.answers, usage: json.usage } };
      }
      finalResponse(json);
      truncated = json.status === "incomplete" && json.incomplete_details?.reason === "max_output_tokens";
      if (json.status === "failed" || (json.status === "incomplete" && !truncated)) throw makeError("Responses 生成未完成", "CHANNEL_STREAM_ERROR");
    } else {
      const reader = resp.body?.getReader();
      if (!reader) throw makeError("上游返回空响应体", "CHANNEL_BAD_RESPONSE");
      const decoder = new TextDecoder();
      let buffer = "", terminal = false;
      const frame = (data) => {
        if (!data || data === "[DONE]") return;
        let ev;
        try { ev = JSON.parse(data); } catch { throw makeError("上游返回无效 SSE 数据", "CHANNEL_BAD_RESPONSE"); }
        toolBuffer.responses(ev);
        if (ev.type === "response.output_text.delta") emit(String(ev.delta || ""));
        else if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(ev.type)) emit(String(ev.delta || ""), true);
        if (ev.response) { upstreamModel = ev.response.model || upstreamModel; acceptUsage(ev.response.usage); }
        else acceptUsage(ev.usage);
        if (["response.completed", "response.done"].includes(ev.type)) { finalResponse(ev.response || ev); terminal = true; }
        if (ev.type === "response.incomplete" && ev.response?.incomplete_details?.reason === "max_output_tokens") {
          finalResponse(ev.response); truncated = true; terminal = true;
        } else if (["error", "response.failed", "response.incomplete"].includes(ev.type)) {
          finalResponse(ev.response || ev);
          throw makeError("Responses 上游生成失败", "CHANNEL_STREAM_ERROR", { upstreamRejected: true });
        }
      };
      const consume = (final = false) => {
        buffer = buffer.replace(/\r\n/g, "\n");
        let at;
        while (!terminal && (at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          frame(block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"));
        }
        if (final && buffer.trim() && !terminal) frame(buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"));
      };
      try {
        while (!terminal) {
          const { done, value } = await reader.read();
          if (done) { buffer += decoder.decode(); consume(true); break; }
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 8 * 1024 * 1024) throw makeError("上游 SSE 数据过大", "CHANNEL_BAD_RESPONSE");
          consume();
        }
        if (!terminal) throw makeError("Responses 未收到完成事件", "CHANNEL_STREAM_ERROR");
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (truncated && toolBuffer.size) throw makeError("工具调用响应被截断", "CHANNEL_STREAM_ERROR");
    if (!content && !reasoning && !toolBuffer.size) throw makeError("上游未返回内容", "CHANNEL_BAD_RESPONSE");
    return { content, reasoning, usage, upstreamModel, reasoningApplied: Object.keys(reasoningBody(args.reasoningConfig, "responses")).length > 0, toolCalls: toolBuffer.finish(), assistantExtras: toolBuffer.assistantExtras, retryCount: 0, ...(truncated ? { truncated: true, finishReason: "length" } : {}) };
  } catch (error) {
    const addressRejected = !status && /内网|协议不允许|携带凭据|解析|重定向/.test(String(error.message || ""));
    const code = typeof error.code === "string" && error.code.startsWith("CHANNEL_") ? error.code
      : signal.aborted || error.name === "AbortError" ? "CHANNEL_ABORTED" : addressRejected ? "CHANNEL_NOT_READY" : "CHANNEL_NETWORK";
    // AbortError 是 DOMException，code 是只读数字属性；换成普通 Error 再挂网关元数据。
    throw Object.assign(new Error(error.message || "上游请求失败"), { ...error, code, status: error.status || status || undefined, content, reasoning, usage, upstreamModel,
      ...(addressRejected ? { upstreamStarted: false } : {}),
      billable: error.billable ?? (Boolean(content || reasoning) || used(usage)), retryCount: 0 });
  }
}
