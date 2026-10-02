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
import { buildSystemPrompt, SUBAGENTS } from "./agents.js";
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
 * 工具调用嗅探：既要「边流边显示」，又不能把调用块当正文显示出来。
 *
 * 真实事故（用户截图）：DeepSeek 系模型经常**不按我们约定的 <tool_call> 写**，
 * 而是吐出自己训练时的原生格式 ——
 *   <｜DSML｜function_calls><｜DSML｜invoke name="github"><｜DSML｜parameter name="args" …>
 * 原嗅探器只认 <tool_call> 与 {"tool":…}，于是这段标记被原样当正文推给用户（「乱码」），
 * 而工具也根本没被执行。现在四类写法都识别并执行：
 *   ① <tool_call>{"tool":"x","args":{}}</tool_call>（约定写法；也兼容 name/arguments）
 *   ② 整条回答为裸 {"tool":…}；Markdown 代码示例不执行
 *   ③ <function_calls><invoke name="x"><parameter name="k">v</parameter></invoke></function_calls>
 *      —— 含 DSML 分隔符的变体（｜DSML｜ / |DSML| 各种写法先归一化再解析）
 *   ④ DeepSeek V3 特殊 token：<｜tool▁calls▁begin｜>…<｜tool▁calls▁end｜>
 * 标记类（①③④）开了头就**绝不按正文吐出**：解析失败或流结束仍未闭合，都按「格式不合法」
 * 让模型重试 —— 宁可多一步，也不能把半截协议标记给用户看。
 * ------------------------------------------------------------------ */
const D = "(?:[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}\\s*)?"; // 可选的 DSML 分隔符
const START_RE = new RegExp(
  [
    "<tool_call\\s*>",
    `<\\s*${D}(?:function_)?calls\\s*>`,
    `<\\s*${D}invoke\\s+name\\s*=`,
    "<[｜|]\\s*tool[▁_]calls[▁_]begin\\s*[｜|]>",
    '\\{\\s*"tool"\\s*:',
  ].join("|"),
  "gi"
);
const CLOSE_FC_RE = new RegExp(`<\\/\\s*${D}(?:function_)?calls\\s*>`, "i");
const CLOSE_INVOKE_RE = new RegExp(`<\\/\\s*${D}invoke\\s*>`, "i");
const CLOSE_V3_RE = /<[｜|]\s*tool[▁_]calls[▁_]end\s*[｜|]>/i;
// 模型偶尔把对话模板的特殊 token 也吐进正文（<｜end▁of▁sentence｜> 等），显示前剥掉
const STRAY_TOKEN_RE = /<[｜|]\s*(?:end▁of▁sentence|begin▁of▁sentence|Assistant|User|tool▁[a-z▁]+)\s*[｜|]>/g;
const HOLD = 48; // 流式时末尾扣住的最大字符数（最长的起始标记约 40 字符）
const INTERNAL_TOOL_ERRORS = ["（工具调用格式不合法）", "(工具调用格式不合法)"];
const internalLines = (text) => String(text || "").trim().split(/\r?\n/).map((line) => line.trim());
const isInternalToolError = (text) => internalLines(text).every((line) => INTERNAL_TOOL_ERRORS.includes(line));
const couldBeInternalToolError = (text) => internalLines(text).every((line) => INTERNAL_TOOL_ERRORS.some((value) => value.startsWith(line)));

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

const tryJson = (s) => {
  try {
    return JSON.parse(String(s).trim());
  } catch {
    return undefined;
  }
};
const asArgs = (v) => {
  if (v === undefined) return {};
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string") {
    const j = tryJson(v);
    if (j && typeof j === "object" && !Array.isArray(j)) return j;
  }
  return null;
};

/** JSON 形态的调用：{"tool","args"} / {"name","arguments"} / {"function":{"name","arguments"}} */
export function parseCall(jsonText) {
  let v = typeof jsonText === "string" ? tryJson(jsonText) : jsonText;
  // 文本协议每步只接受一个调用；兼容单条原生包装，不能悄悄丢掉数组里的第二个调用。
  if (Array.isArray(v?.tool_calls)) v = v.tool_calls;
  if (Array.isArray(v)) { if (v.length !== 1) return null; v = v[0]; }
  if (!v || typeof v !== "object") return null;
  const fn = v.function && typeof v.function === "object" ? v.function : null;
  const tool = v.tool || v.name || fn?.name;
  if (!tool || typeof tool !== "string") return null;
  const name = String(tool).trim().replace(/^(?:functions|tools)\./, "");
  const rawArgs = Object.hasOwn(v, "args") ? v.args : Object.hasOwn(v, "arguments") ? v.arguments : Object.hasOwn(v, "parameters") ? v.parameters : fn?.arguments;
  const args = asArgs(rawArgs);
  if (!name || !args) return null;
  return { tool: name, args };
}

/** Laguna 等模型的训练格式：tool 名后跟 arg_key/arg_value，仍只接受完整配对参数。 */
export function parseKeyValueCall(text) {
  const head = String(text).match(/^\s*([\w.-]+)\s*(?=<arg_key>)/i);
  if (!head) return null;
  const args = {};
  const rest = String(text).slice(head[0].length);
  const pairs = /<arg_key>\s*([\w.-]+)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
  let end = 0, pair, count = 0;
  while ((pair = pairs.exec(rest))) {
    if (rest.slice(end, pair.index).trim() || ["__proto__", "constructor", "prototype"].includes(pair[1]) || Object.hasOwn(args, pair[1])) return null;
    const body = pair[2].trim(), json = tryJson(body);
    args[pair[1]] = json === undefined ? body : json;
    end = pairs.lastIndex; count++;
  }
  if (!count || rest.slice(end).trim()) return null;
  return parseCall({ tool: head[1], args });
}

/** 把 DSML 分隔符归一化成普通 XML 写法 */
export function normalizeMarkup(s) {
  return String(s)
    .replace(/<\s*\/\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*/gi, "</")
    .replace(/<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*/gi, "<");
}

/** ③ invoke/parameter 形态 → { tool, args } */
export function parseInvokeMarkup(raw) {
  const s = normalizeMarkup(raw);
  const inv = s.match(/<invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)(?:<\/invoke>|$)/i);
  if (!inv) return null;
  const params = {};
  const re = /<parameter\s+name\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/parameter>/gi;
  let m;
  while ((m = re.exec(inv[2]))) {
    const [, name, attrs, body] = m;
    const val = body.trim();
    const isString = /string\s*=\s*["']true["']/i.test(attrs);
    const j = isString ? undefined : tryJson(val);
    params[name] = j === undefined ? val : j;
  }
  // 模型常把真正的参数整个塞进一个 args 参数（JSON 字符串），展开它
  let args = params;
  if (Object.hasOwn(params, "args") || Object.hasOwn(params, "arguments")) {
    const inner = asArgs(Object.hasOwn(params, "args") ? params.args : params.arguments);
    if (!inner) return null;
    const { args: _a, arguments: _b, tool: _t, ...rest } = params;
    args = { ...rest, ...inner };
  }
  return { tool: inv[1].trim(), args };
}

/** ④ DeepSeek V3 特殊 token 形态 */
function parseV3Markup(raw) {
  const m = String(raw).match(/tool[▁_]sep\s*[｜|]>\s*([\w.-]+)\s*([\s\S]*)/i);
  if (!m) return null;
  const start = m[2].indexOf("{");
  if (start < 0) return { tool: m[1], args: {} };
  const end = matchBraceJson(m[2], start);
  if (end < 0) return null;
  return parseCall({ tool: m[1], args: asArgs(m[2].slice(start, end + 1)) });
}

function kindOf(matched) {
  if (/^<tool_call\s*>$/i.test(matched)) return "tag";
  if (/tool[▁_]calls[▁_]begin/i.test(matched)) return "v3";
  if (matched.startsWith("<")) return /invoke/i.test(matched) ? "invoke" : "fc";
  return "bare";
}

/** 从 start 起找调用块的结束。返回 { call, end } | null（还没结束）。call 为 null 表示格式不合法 */
function extractCall(acc, start, kind, final) {
  const rest = acc.slice(start);
  if (kind === "tag") {
    const open = rest.match(/^<tool_call\s*>/i)?.[0]?.length || OPEN_TAG.length;
    const close = /<\/tool_call\s*>/i.exec(rest.slice(open));
    if (!close) {
      // 真实线上 Laguna 漏结束标签，但 JSON 已完整；只恢复严格合法的完整 JSON，不补猜括号/引号。
      return final ? { call: parseCall(rest.slice(open)), end: acc.length } : null;
    }
    const end = open + close.index, body = rest.slice(open, end);
    return { call: parseCall(body) || parseKeyValueCall(body), end: start + end + close[0].length };
  }
  if (kind === "fc" || kind === "invoke") {
    let endAt = -1;
    const fc = kind === "fc" ? CLOSE_FC_RE.exec(rest) : null;
    if (fc) endAt = fc.index + fc[0].length;
    else if (kind === "invoke" || final) {
      // 只有 invoke 没有外层 function_calls，或外层没闭合就结束了：取第一个 invoke 的结尾
      const iv = CLOSE_INVOKE_RE.exec(rest);
      if (iv) endAt = iv.index + iv[0].length;
    }
    if (endAt < 0) return final ? { call: null, end: acc.length } : null;
    return { call: parseInvokeMarkup(rest.slice(0, endAt)), end: start + endAt };
  }
  if (kind === "v3") {
    const m = CLOSE_V3_RE.exec(rest);
    if (!m) return final ? { call: null, end: acc.length } : null;
    return { call: parseV3Markup(rest.slice(0, m.index)), end: start + m.index + m[0].length };
  }
  const end = matchBraceJson(acc, start);
  if (end < 0) return null;
  if (!final) return null;
  // 普通解释里的 JSON 不是执行指令；无标签兼容仅限整个回答就是一个完整调用对象。
  if (acc.slice(0, start).trim() || acc.slice(end + 1).trim()) return null;
  return { call: parseCall(acc.slice(start, end + 1)), end: end + 1 };
}

/** Markdown 示例是用户可见的代码，不是工具指令。流式分片也使用同一上下文判定。 */
function insideCode(text, index) {
  const prefix = text.slice(0, index);
  const unquote = (line) => line.replace(/^(?: {0,3}>[ \t]?)+/, "");
  const currentLine = unquote(prefix.slice(prefix.lastIndexOf("\n") + 1));
  if (/^(?: {4}|\t)/.test(currentLine)) return true;
  let fence = "", inline = "";
  const markers = /`+|~{3,}/g;
  let marker;
  while ((marker = markers.exec(prefix))) {
    const token = marker[0];
    const lineStart = prefix.lastIndexOf("\n", marker.index - 1) + 1;
    const linePrefix = unquote(prefix.slice(lineStart, marker.index)).replace(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/, "");
    const atLineStart = /^[ \t]{0,3}$/.test(linePrefix);
    if (fence) {
      if (atLineStart && token[0] === fence[0] && token.length >= fence.length) fence = "";
    } else if (!inline && token.length >= 3 && atLineStart) fence = token;
    else if (token[0] === "`") { if (!inline) inline = token; else if (inline === token) inline = ""; }
  }
  return Boolean(fence || inline);
}

export function sanitizeVisible(s) {
  return String(s || "").replace(STRAY_TOKEN_RE, "");
}

// 导出供单测（tests/harness-sniffer.test.mjs）：正常调用请走 runHarness
export class StepStream {
  constructor() {
    this.acc = "";
    this.emitted = 0;
    this.start = -1;
    this.kind = "";
    this.call = null;
    this.bad = false;
  }

  push(delta) {
    this.acc += delta;
    return this.pump(false);
  }

  /** 流结束：返回剩余正文 */
  finish() {
    const rest = this.pump(true);
    return { text: rest, call: this.call, bad: this.bad };
  }

  take(upto) {
    if (upto <= this.emitted) return "";
    const s = this.acc.slice(this.emitted, upto);
    this.emitted = upto;
    return sanitizeVisible(s);
  }

  /** 未检测到调用时，最多能安全下发到哪：末尾可能是被切开的起始标记，扣住 */
  safeEnd() {
    const tail = this.acc.slice(-HOLD);
    const cut = Math.max(tail.lastIndexOf("<"), tail.lastIndexOf("`"), tail.lastIndexOf("{"));
    return cut < 0 ? this.acc.length : this.acc.length - tail.length + cut;
  }

  pump(final) {
    if (this.call || this.bad) return "";
    // 旧会话可能已有内部错误占位符：模型复述时仍按失败处理，不能冒充最终回答。
    const visible = this.acc.trim();
    if (isInternalToolError(visible)) { if (final) this.bad = true; return ""; }
    if (!final && couldBeInternalToolError(visible)) return "";
    let out = "";
    if (this.start < 0) {
      START_RE.lastIndex = this.emitted;
      let m;
      while ((m = START_RE.exec(this.acc))) {
        if (insideCode(this.acc, m.index)) continue;
        if (kindOf(m[0]) === "bare" && this.acc.slice(0, m.index).trim()) continue;
        break;
      }
      if (!m) return this.take(final ? this.acc.length : Math.max(this.emitted, this.safeEnd()));
      this.start = m.index;
      this.kind = kindOf(m[0]);
      out = this.take(this.start);
    }
    const r = extractCall(this.acc, this.start, this.kind, final);
    if (r) {
      if (r.call) this.call = r.call;
      else this.bad = true;
      return out;
    }
    if (final) {
      // 裸 JSON 没闭合，按正文吐出，不吞掉用户可见的普通示例。
      this.start = -1;
      return out + this.take(this.acc.length);
    }
    return out;
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
    const texts = parts.filter((p) => p.type === "text" && p.text && !(m.role === "assistant" && isInternalToolError(p.text))).map((p) => p.text).join("\n\n").trim();
    const tools = [...new Set(parts.filter((p) => p.type === "tool").map((p) => p.name || p.tool))];
    const images = parts.filter((p) => p.type === "image").length;
    let content = texts;
    // 文档附件的正文要留在上下文里：用户上传后往往会追问「第几段什么意思」，
    // 只在当轮 prompt 里给的话，下一轮模型就忘了。这里按总量预算截断，避免历史无限膨胀。
    const fileParts = parts.filter((x) => x.type === "file" && x.text);
    if (m.role === "user" && fileParts.length) {
      let used = 0;
      const chunks = [];
      for (const f of fileParts) {
        const body = String(f.text || "");
        const room = Math.max(0, 12000 - used);
        if (!room) break;
        const slice = body.slice(0, room);
        used += slice.length;
        chunks.push(`【附件：${f.name}${f.kind ? `（${f.kind}）` : ""}${slice.length < body.length ? "，已截断" : ""}】\n${slice}`);
      }
      content = [content, chunks.join("\n\n")].filter(Boolean).join("\n\n").trim();
    }
    if (m.role === "assistant" && tools.length) content = `${content}\n（本轮使用过工具：${tools.join("、")}）`.trim();
    if (m.role === "user" && images) content = `${content}\n（用户附了 ${images} 张图片）`.trim();
    if (!content) continue;
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: content.slice(0, 20000) });
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

async function loopInner({ session, agent, model, settings = {}, history = [], userText = "", images = [], docs = [], groupName = null, user = null, signal, emit, onTodo, onCall, modelCaps = null }, billing, depth, sink) {
  // 同一站内对话跨轮保留会话，每轮/工具步独立请求；子代理也有自己的上下文。
  const conversationId = String(session?.id || crypto.randomUUID());
  const turnId = crypto.randomUUID();
  const record = (c) => {
    billing.push(c);
    if (onCall) onCall(c);
  };
  const parts = sink.parts;
  // 事件里必须放**快照**：part 对象在流式过程中会被就地追加（text += delta），
  // 如果事件只存引用，断线续传回放时会把「最终文本」当成创建时的事件推一次，
  // 再叠加后续 delta，界面上就出现内容重复。字符串不可变，浅拷贝即可定格当时状态。
  const emitPart = (part) => {
    parts.push(part);
    emit?.({ type: "part", part: { ...part } });
  };
  const patchPart = (part, patch) => {
    Object.assign(part, patch);
    emit?.({ type: "part_update", id: part.id, patch: { ...patch } });
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
              session: { id: `${conversationId}:task:${uid()}`, todo: [] },
              agent: sub,
              model,
              settings: { ...settings, tools: sub.tools, maxSteps: SUBAGENT_MAX_STEPS },
              history: [],
              userText: prompt,
              images: [],
              groupName,
              user,
              signal,
              emit: null, // 子代理过程不直接展示，结果通过 task 工具返回
              onTodo: null,
              // 子循环共用 billing 数组；回调只通知路由，不能再经父 record 重复入账。
              onCall,
              modelCaps},
            billing,
            depth + 1
          );
          return { text: r.text };
        }
      : null;

  // 本轮上传的文档：正文随用户消息一起给模型（带文件名与类型，便于它引用来源）
  const currentUserText = docs.length
    ? [userText, ...docs.map((d) => `【附件：${d.name}${d.kind ? `（${d.kind}）` : ""}】\n${d.text}`)].filter(Boolean).join("\n\n").trim()
    : userText;
  const messages = [...historyToMessages(history), { role: "user", content: currentUserText }];
  let lastText = "";
  let hitLimit = false;
  let formatFailures = 0;

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
      depth});

    const stream = new StepStream();
    let textPart = null;
    let reasoningPart = null;
    // 本步耗时与首 token 时刻：只用于「使用记录」的延迟展示，不计入计费
    const stepStartedAt = Date.now();
    let stepFirstTokenAt = 0;
    let stepContent = "";
    let stepReasoning = "";
    const markStepFirstToken = () => {
      if (!stepFirstTokenAt) stepFirstTokenAt = Date.now();
    };
    const appendText = (t) => {
      if (!t) return;
      if (!textPart) {
        textPart = { id: uid(), type: "text", text: "" };
        emitPart(textPart);
      }
      textPart.text += t;
      emit?.({ type: "delta", id: textPart.id, field: "text", delta: t });
    };    const appendReasoning = (t) => {
      if (!t) return;
      if (!reasoningPart) {
        reasoningPart = { id: uid(), type: "reasoning", text: "" };
        emitPart(reasoningPart);
      }
      reasoningPart.text += t;
      emit?.({ type: "delta", id: reasoningPart.id, field: "text", delta: t });
    };

    // 本步的完整上下文（system + 历史 + 工具结果）在失败时也要能计费：
    // 失败步不进 billing（只有成功才 record），但它的 prompt 往往是整轮最长的。
    // 挂在错误对象上由 chat.js 的失败结算读取，避免在计费路径重新拼一遍上下文。
    const stepPrompt = flattenPrompt(system, messages);
    let result;
    try {
      result = await runCompletion({
        model: modelForChannelMatch(model) || model,
        prompt: stepPrompt,
        messages: [{ role: "system", content: system }, ...messages],
        thinking: typeof settings.thinking === "boolean" ? settings.thinking : agent.thinking,
        search: typeof settings.search === "boolean" ? settings.search : Boolean(agent.search),
        images: step === 1 ? images : [],
        groupName,
        channelType: settings.channelType || "",
        user,
        sessionId: conversationId,
        requestId: `${turnId}:${step}`,
        signal,
        onDelta: (t) => {
          if (!t) return;
          stepContent += t;
          markStepFirstToken();
          appendText(stream.push(t));
        },
        onReasoning: (t) => {
          if (!t) return;
          stepReasoning += t;
          markStepFirstToken();
          appendReasoning(t);
        }});
    } catch (e) {
      // 只带当前失败步的原始输出（含思考），不能拿整轮 parts 补账：
      // 之前的成功步已按 usage 计费，再拼进去会重复收取它们的正文。
      if (e && typeof e === "object") {
        e.billingPrompt = stepPrompt;
        e.billingStartedAt = stepStartedAt;
        e.billingOutput = `${stepContent}${stepReasoning}` || e.billingOutput || "";
        e.billingFirstTokenAt = stepFirstTokenAt || e.billingFirstTokenAt || 0;
      }
      // 流中断也要放出 sniffer 暂存的普通文本；否则短回复会有账单却在刷新后消失。
      appendText(stream.finish().text);
      throw e;
    }

    const { text: tail, call, bad } = stream.finish();
    appendText(tail);

    record({
      prompt: flattenPrompt(system, messages),
      output: `${result.content || ""}${result.reasoning || ""}`,
      usage: result.usage,
      channel: result.channel?.name || "",
      channelId: Number(result.channel?.id) || 0,
      channelQuote: result.channelQuote,
      // 单步耗时与首 token：使用记录里按「整轮」汇总展示（见 chat.js 的 chargeUser）
      startedAt: stepStartedAt,
      firstTokenAt: stepFirstTokenAt,
      elapsed: result.elapsed,
      retryCount: result.retryCount,
      model: result.billModel || model,
      requestedModel: model,
      upstreamModel: result.upstreamModel || "",
      billModel: result.billModel || ""});

    const stepText = (textPart?.text || "").trim();
    if (stepText) lastText = stepText;
    if (!call && !bad) break; // 没有工具调用 → 最终回答

    if (bad) {
      formatFailures++;
      if (formatFailures > 1 || step === maxSteps) {
        throw Object.assign(new Error("工具调用协议无法解析"), { code: "TOOL_PROTOCOL_ERROR" });
      }
      // 不把内部错误占位符伪装成助手回答；真实故障中模型在下一步原样复述了这个占位符。
      if (stepText) messages.push({ role: "assistant", content: stepText });
      messages.push({
        role: "user",
        content:
          "你上一条的工具调用格式无法解析。调用必须严格写成：\n" +
          `${OPEN_TAG}{"tool":"工具名","args":{...}}${CLOSE_TAG}\n` +
          "请重新输出合法的调用，或者直接给出最终回答。"});
      if (step === maxSteps) hitLimit = true;
      continue;
    }

    formatFailures = 0;

    const spec = specs.find((s) => s.id === call.tool);
    const toolPart = { id: uid(), type: "tool", tool: call.tool, name: spec?.name || call.tool, args: call.args, status: "running", output: "", started: Date.now() };
    emitPart(toolPart);

    let res;
    try {
      res = spec
      ? await runTool(call.tool, call.args, {
          model,
          groupName,
          channelType: settings.channelType || "",
          signal,
          record,
          runAgent: childRunAgent,
          todo,
          // 最近调用里显示调用方（工具触发的上游请求也归属到同一次对话的用户）
          user,
          // 某些上游（如网页版反代）不支持联网搜索：工具要据此拒绝，而不是发一次必定失败的请求
          searchSupported: modelCaps?.supportsSearch !== false})
      : { ok: false, output: `工具「${call.tool}」在本轮不可用；可用工具：${specs.map((s) => s.id).join("、") || "（无）"}` };
    } catch (e) {
      // 主动停止也要结束工具的运行状态，刷新后不能永久显示“执行中”。
      patchPart(toolPart, { status: "failed", output: signal?.aborted ? "工具已停止" : String(e.message || "工具执行失败"), ended: Date.now() });
      throw e;
    }

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
        (step === maxSteps ? "这已经是最后一步：不要再调用工具，请直接给出最终回答。" : "需要更多信息就继续调用工具，否则直接给出最终回答。")});
    if (step === maxSteps) hitLimit = true;
  }

  if (hitLimit) {
    const notice = { id: uid(), type: "error", message: `已达到本轮最大步数（${maxSteps}）并停止继续调用工具；需要继续请再发一条消息。` };
    emitPart(notice);
  }

  return { parts, text: lastText, todo };
}
