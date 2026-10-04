// 标准 Responses 协议；鉴权沿用渠道 Key，不附加 Codex OAuth 或客户端身份。
import { guardedFetch, readTextCapped, authHeaders } from "./openai-compat.js";
import { classifyUpstreamHttp } from "./http-error.js";
import { upstreamModelForChannel } from "./vendor-quirks.js";
import { normalizeContentToText } from "./content-text.js";
import { ToolCallBuffer, applyToolDefinitions, responsesMessages } from "../tool-wire.js";
import { reasoningBody } from "../model-capabilities.js";
import { normalizeUsage } from "../pricing.js";
import { attachUpstreamDiagnostics } from "./error-diagnostics.js";

export async function chatOnce({ channel, endpoint, model, prompt, messages, images = [], tools = [], toolChoice, reasoningConfig, maxOutputTokens, onDelta, onReasoning, onToolCall, onUsage, signal }) {
  const source = messages?.length ? messages : [{ role: "user", content: prompt || "" }];
  const input = responsesMessages(source);
  if (images.length) {
    let last = input.findLast(m => m.role === "user");
    if (!last) { last = { role: "user", content: [] }; input.push(last); }
    for (const img of images) last.content.push({ type: "input_image", image_url: `data:${img.mimeType || "image/png"};base64,${img.buffer.toString("base64")}` });
  }
  const mapping = reasoningBody(reasoningConfig, "responses");
  const body = { model: upstreamModelForChannel(channel, model), input, stream: true, store: false, ...mapping };
  const instructions = source.filter(m => ["system", "developer"].includes(m.role)).map(m => normalizeContentToText(m.content)).join("\n\n");
  if (instructions) body.instructions = instructions;
  if (maxOutputTokens) body.max_output_tokens = maxOutputTokens;
  applyToolDefinitions(body, tools, toolChoice, "responses");
  const resp = await guardedFetch(endpoint, { method: "POST", headers: { ...authHeaders(channel), Accept: "text/event-stream" }, body: JSON.stringify(body), signal }, { allowPrivate: channel.other?.allow_private_upstream === true });
  let content = "", reasoning = "", usage = null, upstreamModel = body.model, terminated = false, truncated = false;
  const toolBuffer = new ToolCallBuffer(onToolCall);
  const updateUsage = u => {
    if (!u) return;
    const normalized = normalizeUsage({ ...u, cached_tokens: u.cached_tokens ?? u.input_tokens_details?.cached_tokens });
    usage = { prompt_tokens: normalized.promptTokens, completion_tokens: normalized.completionTokens, cached_tokens: normalized.cacheTokens, total_tokens: normalized.totalTokens };
    onUsage?.(usage);
  };
  const errorOf = (j, status) => {
    const message = j?.error?.message || j?.message || "上游拒绝请求";
    const classified = classifyUpstreamHttp(status, message);
    const rawCode = String(j?.error?.code ?? j?.error?.type ?? j?.code ?? "");
    return attachUpstreamDiagnostics(Object.assign(new Error(message), { status, code: classified.code === "CHANNEL_NOT_APPROVED" || [401, 403].includes(status) ? classified.code : status === 429 ? "CHANNEL_RATE_LIMIT" : [400, 404, 405, 415, 422].includes(status) ? "CHANNEL_BAD_REQUEST" : "CHANNEL_HTTP_ERROR",
      upstreamRejected: true, upstreamErrorCode: /^[a-zA-Z0-9_-]{1,40}$/.test(rawCode) ? rawCode : "" }), { status, body: j, channel });
  };
  if (!resp.ok) {
    const text = await readTextCapped(resp); let j;
    try { j = JSON.parse(text); } catch { j = { message: text }; }
    updateUsage(j?.usage);
    throw Object.assign(errorOf(j, resp.status), { usage, billable: normalizeUsage(usage).totalTokens > 0 });
  }
  const snapshot = response => {
    if (!response) return;
    if (response.model) upstreamModel = response.model;
    updateUsage(response.usage);
    const full = response.output?.filter(i => i.type === "message").flatMap(i => i.content || []).filter(p => p.type === "output_text").map(p => p.text || "").join("") || response.output_text || "";
    if (full.startsWith(content) && full.length > content.length) { const delta = full.slice(content.length); content = full; onDelta?.(delta); }
    const thought = response.output?.filter(i => i.type === "reasoning").flatMap(i => i.summary || []).map(p => p.text || "").join("") || "";
    if (thought.startsWith(reasoning) && thought.length > reasoning.length) { const delta = thought.slice(reasoning.length); reasoning = thought; onReasoning?.(delta); }
    toolBuffer.responses({ response });
    if (response.error || response.status === "failed") throw errorOf(response, 200);
    truncated = response.status === "incomplete";
  };
  const handle = event => {
    if (!event || typeof event !== "object") return;
    toolBuffer.responses(event);
    if (event.type === "response.output_text.delta" && event.delta) { content += event.delta; onDelta?.(event.delta); }
    if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type) && event.delta) { reasoning += event.delta; onReasoning?.(event.delta); }
    if (["response.completed", "response.incomplete", "response.failed"].includes(event.type)) { snapshot(event.response); terminated = true; }
    if (event.type === "error") throw errorOf(event, 200);
  };
  let reader;
  try {
    if ((resp.headers.get("content-type") || "").includes("application/json")) {
      const j = JSON.parse(await readTextCapped(resp)); snapshot(j);
      terminated = ["completed", "incomplete"].includes(j.status) || Array.isArray(j.output);
    } else {
      if (!resp.body) throw Object.assign(new Error("上游没有返回响应流"), { code: "CHANNEL_BAD_RESPONSE" });
      reader = resp.body.getReader(); const dec = new TextDecoder(); let buffer = "";
      const line = value => { if (!value.startsWith("data:")) return; const data = value.slice(5).trim(); if (!data || data === "[DONE]") return; let j; try { j = JSON.parse(data); } catch { return; } handle(j); };
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += dec.decode(value, { stream: true });
        if (buffer.length > 8 * 1024 * 1024) throw Object.assign(new Error("上游响应帧过大"), { code: "CHANNEL_BAD_RESPONSE" });
        let split; while ((split = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, split).trim()); buffer = buffer.slice(split + 1); }
      }
      buffer += dec.decode(); if (buffer.trim()) line(buffer.trim());
    }
    if (!terminated || truncated && toolBuffer.size) throw Object.assign(new Error("Responses 响应未完整结束"), { code: "CHANNEL_STREAM_ERROR" });
    if (!content && !toolBuffer.size) throw Object.assign(new Error("Responses 没有返回正文"), { code: "CHANNEL_EMPTY" });
    return { content, reasoning, usage, upstreamModel, truncated, httpStatus: resp.status, toolCalls: toolBuffer.finish(), assistantExtras: toolBuffer.assistantExtras, reasoningApplied: Object.keys(mapping).length > 0 };
  } catch (error) {
    const failure = typeof error.code === "string" ? error : Object.assign(new Error("Responses 响应中断或格式无效"), { code: signal?.aborted ? "CHANNEL_ABORTED" : "CHANNEL_BAD_RESPONSE" });
    throw Object.assign(failure, { content, reasoning, usage, upstreamModel, billable: Boolean(content || reasoning || toolBuffer.size) || normalizeUsage(usage).totalTokens > 0 });
  } finally { if (reader) await reader.cancel().catch(() => {}); }
}
