// 原生工具的统一边界：定义、调用与结果分别保留，正文不能冒充工具结果。
import crypto from "node:crypto";
import { normalizeContentToText as textOf } from "./upstream/content-text.js";

export const callOf = (c) => ({ id: String(c.id || ""), name: String(c.name || c.function?.name || ""), arguments: typeof (c.arguments ?? c.function?.arguments) === "string" ? (c.arguments ?? c.function.arguments) : JSON.stringify(c.arguments ?? c.function?.arguments ?? {}) });
export const chatCalls = (calls) => calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments }, ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}) }));
export const callsText = (calls = []) => calls.map((c) => JSON.stringify(callOf(c))).join("\n");

/** 只拼接增量；done快照覆盖，不能再次累加而造成参数重复。 */
export class ToolCallBuffer {
  constructor(onToolCall) { this.items = new Map(); this.onToolCall = onToolCall; this.bytes = 0; this.thinking = new Map(); this.reasoning = new Map(); }
  add(key, patch = {}, full = false) {
    key = String(key ?? 0);
    if (!this.items.has(key)) {
      if (this.items.size >= 64) throw Object.assign(new Error("上游工具调用数量超限"), { code: "CHANNEL_BAD_RESPONSE" });
      this.items.set(key, { id: "", name: "", arguments: "" });
    }
    const item = this.items.get(key), before = item.arguments.length;
    if (patch.id) item.id = String(patch.id);
    if (patch.name) item.name = String(patch.name);
    if (patch.thoughtSignature) item.thoughtSignature = patch.thoughtSignature;
    if (patch.arguments != null) item.arguments = full ? String(patch.arguments) : item.arguments + String(patch.arguments);
    this.bytes += item.arguments.length - before;
    if (this.bytes > 1024 * 1024 || item.name.length > 256 || item.id.length > 256) throw Object.assign(new Error("上游工具参数过大"), { code: "CHANNEL_BAD_RESPONSE" });
    // 此回调只通知产生了工具输出；执行必须等适配器确认完整响应成功。
    this.onToolCall?.({ index: [...this.items.keys()].indexOf(key), ...item });
    return item;
  }
  get size() { return this.items.size; }
  finish() {
    return [...this.items.values()].map((c) => {
      if (!c.name) throw Object.assign(new Error("上游工具调用缺少名称"), { code: "CHANNEL_BAD_RESPONSE" });
      return { ...c, id: c.id || `call_${crypto.randomUUID().replaceAll("-", "")}` , arguments: c.arguments || "{}" };
    });
  }
  responses(ev) {
    const item = ev.item;
    if (item?.type === "reasoning" && ev.type === "response.output_item.done") this.reasoning.set(item.id || ev.output_index, item);
    for (const [i, c] of (ev.response?.output || []).entries()) if (c.type === "reasoning") this.reasoning.set(c.id || i, c);
    if (["response.output_item.added", "response.output_item.done"].includes(ev.type) && item?.type === "function_call")
      this.add(item.id || ev.output_index, { id: item.call_id, name: item.name, ...(item.arguments ? { arguments: item.arguments } : {}) }, true);
    if (ev.type === "response.function_call_arguments.delta") this.add(ev.item_id || ev.output_index, { arguments: ev.delta || "" });
    if (ev.type === "response.function_call_arguments.done") this.add(ev.item_id || ev.output_index, { ...(ev.arguments != null ? { arguments: ev.arguments } : {}), name: ev.name }, true);
    for (const [i, c] of (ev.response?.output || []).entries()) if (c.type === "function_call") this.add(c.id || i, { id: c.call_id, name: c.name, arguments: c.arguments || "{}" }, true);
  }
  anthropic(ev) {
    const b = ev.content_block;
    if (ev.type === "content_block_start" && ["thinking", "redacted_thinking"].includes(b?.type)) this.thinking.set(ev.index, { ...b });
    const thought = this.thinking.get(ev.index);
    if (thought && ev.type === "content_block_delta") {
      if (ev.delta?.type === "thinking_delta") thought.thinking = (thought.thinking || "") + ev.delta.thinking;
      if (ev.delta?.type === "signature_delta") thought.signature = (thought.signature || "") + ev.delta.signature;
    }
    if (ev.type === "content_block_start" && b?.type === "tool_use") this.add(ev.index, { id: b.id, name: b.name, ...(b.input && Object.keys(b.input).length ? { arguments: JSON.stringify(b.input) } : {}) }, true);
    if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") this.add(ev.index, { arguments: ev.delta.partial_json || "" });
  }
  get assistantExtras() { return { anthropicThinking: [...this.thinking.values()], responsesReasoning: [...this.reasoning.values()] }; }
}

export function applyToolDefinitions(body, tools = [], choice, protocol = "chat") {
  if (!tools.length) return;
  if (protocol === "anthropic") {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (choice) body.tool_choice = typeof choice === "object" ? { type: "tool", name: choice.name } : { type: choice === "required" ? "any" : choice };
  } else if (protocol === "gemini") {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    if (choice) body.toolConfig = { functionCallingConfig: { mode: choice === "none" ? "NONE" : choice === "required" || typeof choice === "object" ? "ANY" : "AUTO", ...(typeof choice === "object" ? { allowedFunctionNames: [choice.name] } : {}) } };
  } else {
    body.tools = tools.map((t) => protocol === "responses" ? { type: "function", ...t, strict: false } : { type: "function", function: t });
    if (choice) body.tool_choice = typeof choice === "object" ? protocol === "responses" ? { type: "function", name: choice.name } : { type: "function", function: { name: choice.name } } : choice;
  }
}

export function anthropicMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (!m || ["system", "developer"].includes(m.role)) continue;
    const role = m.role === "assistant" ? "assistant" : "user", content = [];
    if (m.role === "tool") content.push({ type: "tool_result", tool_use_id: m.tool_call_id, content: textOf(m.content), ...(m.is_error ? { is_error: true } : {}) });
    else {
      if (role === "assistant") content.push(...(m.anthropicThinking || []));
      const text = textOf(m.content); if (text) content.push({ type: "text", text });
      for (const c of m.tool_calls || []) { const v = callOf(c); content.push({ type: "tool_use", id: v.id, name: v.name, input: JSON.parse(v.arguments) }); }
    }
    if (!content.length) continue;
    const prev = out.at(-1); if (prev?.role === role) prev.content.push(...content); else out.push({ role, content });
  }
  return out;
}

export function responsesMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (!m || ["system", "developer"].includes(m.role)) continue;
    if (m.role === "tool") { out.push({ type: "function_call_output", call_id: m.tool_call_id, output: textOf(m.content) }); continue; }
    const role = m.role === "assistant" ? "assistant" : "user", text = textOf(m.content);
    if (role === "assistant") out.push(...(m.responsesReasoning || []));
    if (text) out.push({ role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
    for (const c of m.tool_calls || []) { const v = callOf(c); out.push({ type: "function_call", call_id: v.id, name: v.name, arguments: v.arguments }); }
  }
  return out;
}

export function geminiMessages(messages = []) {
  const out = [], names = new Map();
  for (const m of messages) {
    if (!m || ["system", "developer"].includes(m.role)) continue;
    const role = m.role === "assistant" ? "model" : "user", parts = [];
    if (m.role === "tool") parts.push({ functionResponse: { id: m.tool_call_id, name: names.get(m.tool_call_id) || m.name, response: { output: textOf(m.content) } } });
    else {
      const text = textOf(m.content); if (text) parts.push({ text });
      for (const c of m.tool_calls || []) { const v = callOf(c); names.set(v.id, v.name); parts.push({ functionCall: { id: v.id, name: v.name, args: JSON.parse(v.arguments) }, ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}) }); }
    }
    if (!parts.length) continue;
    const prev = out.at(-1); if (prev?.role === role) prev.parts.push(...parts); else out.push({ role, parts });
  }
  return out;
}

/** 换到网页渠道时完整保留已执行工具的来回，不能把role:tool静默丢弃。 */
export function textToolMessages(messages = []) {
  const names = new Map(messages.flatMap(m => (m.tool_calls || []).map(c => { const v = callOf(c); return [v.id, v.name]; })));
  return messages.map((m) => m.role === "tool" ? { role: "user", content: `<tool_result tool="${m.name || names.get(m.tool_call_id) || "tool"}" id="${m.tool_call_id}" ok="${!m.is_error}">\n${textOf(m.content)}\n</tool_result>` }
    : { role: m.role, content: [textOf(m.content), ...(m.tool_calls || []).map((c) => { const v = callOf(c); return `<tool_call>${JSON.stringify({ tool: v.name, args: JSON.parse(v.arguments) })}</tool_call>`; })].filter(Boolean).join("\n") });
}
