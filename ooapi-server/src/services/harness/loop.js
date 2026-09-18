// Harness 运行循环（对话机制 + 智能体编排的执行体）
// ---------------------------------------------------------------------------
// 一轮对话怎么跑（对应 opencode 的「一次会话 = 若干 step」）：
//   ① 读取会话历史 → 拼装系统提示词（角色 + 环境 + 工具协议 + 会话指令）
//   ② 调一次上游模型，边流边把 text / reasoning 作为 part 推给前端
//   ③ 流结束后嗅探本轮输出里的工具调用块：
//        · 有调用 → 执行工具，把结果作为 <tool_result> 交回模型，进入下一个 step
//        · 没有   → 这就是最终回答，本轮结束
//   ④ 步数上限（maxSteps）兜底，防止模型自己绕圈把用户额度烧穿
//
// 为什么用「提示词 + JSON 调用块」而不是原生 tool calling：
//   本平台渠道既有 OpenAI 兼容 API，也有网页版反代，后者不支持 tools 参数。
//   统一走文本协议，所有渠道行为一致；代价是解析要靠嗅探器（见 StepStream）。
import crypto from "node:crypto";
import { runCompletion } from "../execute.js";
import { modelForChannelMatch } from "../models.js";
import { findAgent, buildSystemPrompt, SUBAGENTS } from "./agents.js";
import { toolSpecs, runTool } from "./tools.js";
import { DEFAULT_MAX_STEPS } from "./sessions.js";

const MAX_DEPTH = 1; // 子代理不允许再派子代理
const SUBAGENT_MAX_STEPS = 3;
const HISTORY_MAX_CHARS = 48000;
const HISTORY_KEEP_TAIL = 12;

const uid = () => crypto.randomBytes(6).toString("hex");

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";

/* ------------------------------------------------------------------ *
 * 工具调用嗅探：既要「边流边显示」，又不能把调用 JSON 当正文显示出来。
 * 做法是保留 9 个字符的尾巴不立即下发（可能是被切开的 <tool_call>），
 * 一旦看到调用起点就停住，等标签闭合后整体交给循环。
 * ------------------------------------------------------------------ */
function matchBraceJson(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function locateCallStart(acc, from) {
  const marks = [];
  const xml = acc.indexOf(OPEN_TAG, from);
  if (xml >= 0) marks.push(xml);
  const fence = acc.indexOf("```", from);
  if (fence >= 0 && /^\s*```[a-z]*\s*\{\s*"tool"\s*:/.test(acc.slice(fence, fence + 40))) marks.push(fence);
  const bare = acc.indexOf("{");
  if (bare >= from && /^\s*\{\s*"tool"\s*:/.test(acc.slice(bare, bare + 40))) marks.push(bare);
  return marks.length ? Math.min(...marks) : -1;
}

function parseCall(jsonText) {
  try {
    const v = JSON.parse(String(jsonText).trim());
    if (v && typeof v === "object" && v.tool) {
      return { tool: String(v.tool), args: v.args && typeof v.args === "object" ? v.args : {} };
    }
  } catch {
    /* 交给调用方按「格式不合法」处理 */
  }
  return null;
}

/** 返回 { call, end } | { call: null, end, bad: true } | null（还没结束） */
function extractCall(acc, start) {
  if (acc.startsWith(OPEN_TAG, start)) {
    const end = acc.indexOf(CLOSE_TAG, start + OPEN_TAG.length);
    if (end < 0) return null;
    return { call: parseCall(acc.slice(start + OPEN_TAG.length, end)), end: end + CLOSE_TAG.length, bad: false };
  }
  if (acc.startsWith("```", start)) {
    const close = acc.indexOf("```", start + 3);
    if (close < 0) return null;
    const body = acc.slice(start + 3, close).replace(/^[a-z]*\s*/i, "");
    return { call: parseCall(body), end: close + 3, bad: false };
  }
  const end = matchBraceJson(acc, start);
  if (end < 0) return null;
  return { call: parseCall(acc.slice(start, end + 1)), end: end + 1, bad: false };
}

// 导出仅为自测（.tmp 脚本 / 后续单测）：正常调用请走 runHarness
export class StepStream {
  constructor() {
    this.acc = "";
    this.emitted = 0;
    this.start = -1;
    this.call = null;
    this.bad = false;
    this.scanFrom = 0;
  }

  push(delta) {
    this.acc += delta;
    return this.pump(false);
  }

  /** 流结束：返回剩余的正文（未闭合的调用块按正文吐出，避免吞内容） */
  finish() {
    const rest = this.pump(true);
    return { text: rest, call: this.call, bad: this.bad };
  }

  take(upto) {
    if (upto <= this.emitted) return "";
    const s = this.acc.slice(this.emitted, upto);
    this.emitted = upto;
    return s;
  }

  pump(final) {
    if (this.call || this.bad) return "";

    if (this.start < 0) {
      // 只扫「还没扫过」的尾部窗口：调用标记最长约 40 字符，窗口取 64 足够，
      // 每个字符因此只被检查一次（否则长回答逐字符 delta 会退化成 O(n²)）。
      const from = Math.max(this.emitted, this.scanFrom);
      const start = locateCallStart(this.acc, from);
      if (start < 0) {
        this.scanFrom = Math.max(this.scanFrom, this.acc.length - 64);
        // 末尾 10 个字符先扣住：可能正是被切开的 "<tool_call"
        const safe = final ? this.acc.length : Math.max(this.emitted, this.acc.length - (OPEN_TAG.length - 1));
        return this.take(safe);
      }
      this.start = start;
      const head = this.take(start);
      const m = extractCall(this.acc, start);
      if (m) {
        if (m.call) this.call = m.call;
        else this.bad = true;
      } else if (final) {
        return head + this.take(this.acc.length); // 没闭合，按正文
      }
      return head;
    }

    const m = extractCall(this.acc, this.start);
    if (m) {
      if (m.call) this.call = m.call;
      else this.bad = true;
      return "";
    }
    if (final) {
      this.start = -1;
      return this.take(this.acc.length);
    }
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * 历史消息 → 模型消息
 * 上下文预算：超长就丢最早的几轮，只保留最近若干条（简单、可预期，不额外花钱）。
 * ------------------------------------------------------------------ */
export function historyToMessages(history = []) {
  const out = [];
  for (const m of history) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const texts = parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n\n").trim();
    const tools = [...new Set(parts.filter((p) => p.type === "tool").map((p) => p.name || p.tool))];
    const images = parts.filter((p) => p.type === "image").length;
    let content = texts;
    if (m.role === "assistant" && tools.length) content = `${content}\n（本轮使用过工具：${tools.join("、")}）`.trim();
    if (m.role === "user" && images) content = `${content}\n（用户附了 ${images} 张图片）`.trim();
    if (!content) continue;
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: content.slice(0, 6000) });
  }
  let total = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > HISTORY_KEEP_TAIL && total > HISTORY_MAX_CHARS) {
    total -= out[0].content.length;
    out.shift();
  }
  return out;
}

function flattenPrompt(system, messages) {
  const chunks = [];
  if (system) chunks.push(system);
  for (const m of messages) {
    if (m.role === "system") continue;
    chunks.push(m.role === "assistant" ? `<｜Assistant｜>${m.content}<｜end▁of▁sentence｜>` : `<｜User｜>${m.content}`);
  }
  return chunks.join("\n");
}

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */
/**
 * @param {object} opts
 * @param {object} opts.session   会话行（含 settings/todo）
 * @param {object} opts.agent     智能体定义
 * @param {string} opts.model     模型 id
 * @param {object} opts.settings  会话设定
 * @param {Array}  opts.history   历史消息（parts 结构）
 * @param {string} opts.userText  本轮用户输入
 * @param {Array}  opts.images    本轮图片 [{buffer,mimeType,filename}]
 * @param {string} opts.groupName 用户分组（渠道过滤）
 * @param {AbortSignal} opts.signal
 * @param {Function} opts.emit    (event) => void，SSE 事件
 * @param {Function} opts.onTodo  待办清单变更回调（route 负责落库）
 * @param {Function} opts.onCall  记账回调 {prompt, output, usage}
 */
export async function runHarness(opts) {
  const billing = [];
  try {
    const out = await loop(opts, billing);
    return { ...out, calls: billing };
  } catch (err) {
    // 失败时把已产生的调用与内容带出去：route 按实际消耗部分计费
    err.calls = billing;
    throw err;
  }
}
async function loop(opts, billing, depth = 0) {
  const sink = { parts: [] };
  try {
    return await loopInner(opts, billing, depth, sink);
  } catch (err) {
    // 已产生的 parts 带出去：前端能保留已看到的内容，route 也能把它落库
    err.parts = sink.parts;
    throw err;
  }
}

async function loopInner({ session, agent, model, settings = {}, history = [], userText = "", images = [], groupName = null, signal, emit, onTodo, onCall, modelCaps = null }, billing, depth, sink) {
  const record = (c) => {
    billing.push(c);
    if (onCall) onCall(c);
  };
  const parts = sink.parts;
  const emitPart = (part) => {
    parts.push(part);
    emit?.({ type: "part", part });
  };
  const patchPart = (part, patch) => {
    Object.assign(part, patch);
    emit?.({ type: "part_update", id: part.id, patch });
  };

  const tools = (settings.tools ?? agent.tools ?? []).filter((t) => (depth >= MAX_DEPTH ? t !== "task" : true));
  const maxSteps = depth === 0 ? Math.max(1, Math.min(settings.maxSteps || DEFAULT_MAX_STEPS, 16)) : SUBAGENT_MAX_STEPS;
  let todo = Array.isArray(session?.todo) ? session.todo : [];

  // 子代理的 runAgent：主智能体通过 task 工具调用；深度到顶后为 null（工具会拒绝）
  const childRunAgent =
    depth < MAX_DEPTH
      ? async ({ agentId, prompt }) => {
          const sub = SUBAGENTS.find((a) => a.id === agentId) || SUBAGENTS.find((a) => a.id === "explore");
          if (!sub) throw Object.assign(new Error("没有可用的子代理"), { code: "NO_SUBAGENT" });
          const r = await loop(
            {
              session: { todo: [] },
              agent: sub,
              model,
              settings: { ...settings, tools: sub.tools, maxSteps: SUBAGENT_MAX_STEPS },
              history: [],
              userText: prompt,
              images: [],
              groupName,
              signal,
              emit: null, // 子代理过程不直接展示，结果通过 task 工具返回
              onTodo: null,
              onCall: record,
              modelCaps,
            },
            billing,
            depth + 1
          );
          return { text: r.text };
        }
      : null;

  const messages = [...historyToMessages(history), { role: "user", content: userText }];
  let lastText = "";
  let hitLimit = false;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) throw Object.assign(new Error("已停止"), { code: "ABORTED" });

    const specs = toolSpecs(tools);
    const system = buildSystemPrompt({
      agent,
      model,
      settings,
      toolSpecs: specs,
      todo,
      subagents: SUBAGENTS,
      depth,
    });

    const stream = new StepStream();
    let textPart = null;
    let reasoningPart = null;
    const appendText = (t) => {
      if (!t) return;
      if (!textPart) {
        textPart = { id: uid(), type: "text", text: "" };
        emitPart(textPart);
      }
      textPart.text += t;
      emit?.({ type: "delta", id: textPart.id, field: "text", delta: t });
    };
    const appendReasoning = (t) => {
      if (!t) return;
      if (!reasoningPart) {
        reasoningPart = { id: uid(), type: "reasoning", text: "" };
        emitPart(reasoningPart);
      }
      reasoningPart.text += t;
      emit?.({ type: "delta", id: reasoningPart.id, field: "text", delta: t });
    };

    const result = await runCompletion({
      model: modelForChannelMatch(model) || model,
      prompt: flattenPrompt(system, messages),
      messages: [{ role: "system", content: system }, ...messages],
      thinking: typeof settings.thinking === "boolean" ? settings.thinking : agent.thinking,
      search: typeof settings.search === "boolean" ? settings.search : Boolean(agent.search),
      images: step === 1 ? images : [],
      groupName,
      signal,
      onDelta: (t) => appendText(stream.push(t)),
      onReasoning: appendReasoning,
    });

    const { text: tail, call, bad } = stream.finish();
    appendText(tail);

    record({
      prompt: flattenPrompt(system, messages),
      output: `${result.content || ""}${result.reasoning || ""}`,
      usage: result.usage,
      channel: result.channel?.name || "",
    });

    const stepText = (textPart?.text || "").trim();
    if (stepText) lastText = stepText;
    if (!call && !bad) break; // 没有工具调用 → 最终回答

    if (bad) {
      messages.push({ role: "assistant", content: stepText || "（工具调用格式不合法）" });
      messages.push({
        role: "user",
        content:
          "你上一条的工具调用格式无法解析。调用必须严格写成：\n" +
          `${OPEN_TAG}{"tool":"工具名","args":{...}}${CLOSE_TAG}\n` +
          "请重新输出合法的调用，或者直接给出最终回答。",
      });
      if (step === maxSteps) hitLimit = true;
      continue;
    }

    const spec = specs.find((s) => s.id === call.tool);
    const toolPart = { id: uid(), type: "tool", tool: call.tool, name: spec?.name || call.tool, args: call.args, status: "running", output: "", started: Date.now() };
    emitPart(toolPart);

    const res = spec
      ? await runTool(call.tool, call.args, {
          model,
          groupName,
          signal,
          record,
          runAgent: childRunAgent,
          todo,
          // 某些上游（如网页版反代）不支持联网搜索：工具要据此拒绝，而不是发一次必定失败的请求
          searchSupported: modelCaps?.supportsSearch !== false,
        })
      : { ok: false, output: `工具「${call.tool}」在本轮不可用；可用工具：${specs.map((s) => s.id).join("、") || "（无）"}` };

    const patch = { status: res.ok ? "done" : "failed", output: String(res.output || "").slice(0, 12000), ended: Date.now() };
    if (res.meta) patch.meta = res.meta;
    if (Array.isArray(res.todo)) {
      todo = res.todo;
      patch.todo = todo;
      onTodo?.(todo);
      emit?.({ type: "todo", todo });
    }
    patchPart(toolPart, patch);

    messages.push({ role: "assistant", content: stepText || `（调用工具 ${call.tool}）` });
    messages.push({
      role: "user",
      content:
        `<tool_result tool="${call.tool}" ok="${res.ok}">\n${patch.output}\n</tool_result>\n` +
        (step === maxSteps ? "这已经是最后一步：不要再调用工具，请直接给出最终回答。" : "需要更多信息就继续调用工具，否则直接给出最终回答。"),
    });
    if (step === maxSteps) hitLimit = true;
  }

  if (hitLimit) {
    const notice = { id: uid(), type: "error", message: `已达到本轮最大步数（${maxSteps}）并停止继续调用工具；需要继续请再发一条消息。` };
    emitPart(notice);
  }

  return { parts, text: lastText, todo };
}
