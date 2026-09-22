// 上游适配器：TypeSafe AI（Jev / System One）
// ===========================================================================
// 为什么必须单独一个适配器（不能走 openai-compat）：
//
// **Jev 不生成文本。** 它是 TypeSafe AI 的「System One Model」，
// 输入 state（上下文）+ 一组**类型化问题**，输出**类型化的判断 + 概率 + 置信度**，
// 三种原语：noul（是/否）、choice（多选，上限 255 项）、score（评分）。
// 全程没有 free-text 输出 —— 所以它**刻意不兼容 OpenAI**，
// 只有一个端点 `POST /v1/systemone`，请求体是 `{state, model, questions}`。
// 把 /v1/chat/completions 的 {messages} 直接发过去会被 422 拒。
//
// 与网关的映射（网关内部全是「聊天气泡」，这里做双向转换）：
//   · 入站：把 messages 拼成 state；若调用方在最后一条里给了结构化问题
//     （JSON 数组），就用它；否则**自动构造一个 noul 问题**，让 Jev 对
//     "上述对话/陈述是否成立" 给出是/否 + 概率 —— 这是唯一能把它塞进
//     聊天语义的合理方式，且结果对调用方是有意义的（概率即置信度）。
//   · 出站：把 answers 渲染成一段可读文本（含每个答案的概率/置信度），
//     作为 assistant 的 content 返回。**同时把原始结构化结果放在 x_ 字段**，
//     调用方需要精确数据时不必解析文本。
//
// 计费：输入 $0.042/M，**输出免费**。所以 usage 只需上报输入侧，
// 输出 token 记 0 —— 按输出计价会凭空多收（这一点在 pricing 侧也要对齐）。
//
// 已知约束（官方文档）：单请求 64k 上下文；state + 最长单个问题 ≤ 32k；
// choice 最多 255 项；限流 250k tokens/s、1200 req/min。
// 中文准确率官方称低于英文。
import { getNumberOption } from "../../config.js";

const DEFAULT_BASE = "https://api.typesafe.ai";
const MAX_STATE_CHARS = 32_000 * 4; // 官方按 token 限，这里用字符做粗保护（4 char/token 保守估算）
const MAX_CHOICES = 255;

/** Base URL → systemone 端点 */
export function endpoints(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "") || DEFAULT_BASE;
  if (/\/systemone$/.test(raw)) return { systemone: raw, models: raw.replace(/\/systemone$/, "/models") };
  if (/\/models$/.test(raw)) return { models: raw, systemone: raw.replace(/\/models$/, "/systemone") };
  if (/\/v\d+[a-z]*$/i.test(raw)) return { systemone: `${raw}/systemone`, models: `${raw}/models` };
  return { systemone: `${raw}/v1/systemone`, models: `${raw}/v1/models` };
}

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

function headers(key) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
    accept: "application/json",
    // 官方未要求特定 UA，但带一个明确标识便于上游识别来源（而非匿名的 undici）
    "user-agent": "OOAPI-Gateway/1.0",
  };
}

/* ---------------------------------------------------------------------------
   入站：聊天消息 → {state, questions}
   --------------------------------------------------------------------------- */

/** messages → 一段 state 文本（Jev 不看角色，只看内容，所以标出说话人便于它理解） */
function buildState(messages, prompt) {
  const list = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: prompt }];
  const parts = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const text = typeof m.content === "string" ? m.content : String(m.content ?? "");
    if (!text.trim()) continue;
    if (m.role === "system") parts.push(`[系统指令]\n${text}`);
    else if (m.role === "assistant") parts.push(`[助手]\n${text}`);
    else parts.push(text);
  }
  return parts.join("\n\n").slice(0, MAX_STATE_CHARS);
}

/**
 * 从最后一条用户消息里识别结构化问题。
 *
 * 支持两种写法（都不写就自动生成一个 noul 问题）：
 *   1) 纯 JSON 数组：[{"id":"q1","type":"choice","text":"…","choices":[{"id":"a","text":"A"}]}]
 *   2) 代码块包裹的 JSON 数组（```json ... ```）—— 调用方常这么贴
 * 识别失败就当作自然语言，交给自动 noul。
 */
export function parseQuestions(text) {
  const raw = String(text || "").trim();
  const candidates = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  if (raw.startsWith("[") && raw.endsWith("]")) candidates.push(raw);
  for (const c of candidates) {
    let j;
    try {
      j = JSON.parse(c);
    } catch {
      continue; // 不是 JSON，试下一个候选
    }
    if (!Array.isArray(j) || !j.length || !j.every((q) => q && typeof q === "object" && q.type)) {
      continue;
    }
    // normalQuestions 的异常（如 choice 超 255 项）必须**向上抛**，
    // 不能被当成「解析失败」吞掉 —— 吞掉的后果是超限请求照原样发给上游，
    // 上游回一个语焉不详的 422，用户看不懂哪里错了。
    // （这条是单测抓出来的：原来 JSON.parse 与 normalizeQuestions 共用一个 try。）
    return normalizeQuestions(j);
  }
  return null;
}

/** 校验并规整问题数组（官方硬约束：choice ≤ 255 项；每项要有 id/type/text） */
function normalizeQuestions(list) {
  const out = [];
  for (const q of list) {
    if (!q || typeof q !== "object") continue;
    const type = String(q.type || "").toLowerCase();
    if (!["noul", "choice", "score"].includes(type)) continue;
    const item = {
      id: String(q.id || `q${out.length + 1}`),
      type,
      text: String(q.text || "").slice(0, 4000),
    };
    if (type === "choice") {
      const choices = Array.isArray(q.choices) ? q.choices : [];
      if (!choices.length) {
        throw Object.assign(new Error(`choice 问题「${item.id}」缺少 choices`), { code: "CHANNEL_BAD_REQUEST" });
      }
      if (choices.length > MAX_CHOICES) {
        throw Object.assign(
          new Error(`choice 问题「${item.id}」有 ${choices.length} 个选项，超过官方上限 ${MAX_CHOICES}`),
          { code: "CHANNEL_BAD_REQUEST" },
        );
      }
      item.choices = choices.map((c, i) => ({
        id: String(c?.id ?? i),
        text: String(c?.text ?? c ?? "").slice(0, 1000),
      }));
    }
    if (type === "score") {
      // score 的区间由调用方给（官方叫 min/max 或 range，两种写法都收）
      const min = Number(q.min ?? q.range?.[0] ?? 0);
      const max = Number(q.max ?? q.range?.[1] ?? 1);
      item.min = Number.isFinite(min) ? min : 0;
      item.max = Number.isFinite(max) && max > item.min ? max : item.min + 1;
    }
    out.push(item);
  }
  return out.length ? out : null;
}

/** 没有结构化问题时：自动构造一个 noul，让 Jev 对 state 做判定 */
function autoQuestion(prompt, state) {
  const ask = String(prompt || "").trim() || state.slice(-400);
  return [
    {
      id: "auto",
      type: "noul",
      text: `基于上述内容，以下判断是否成立：「${ask.slice(0, 1200)}」。若不成立请给出否定判断。`,
    },
  ];
}

/* ---------------------------------------------------------------------------
   出站：answers → 可读文本
   --------------------------------------------------------------------------- */

/** 人类可读的答案渲染（含概率/置信度），同时保留结构化字段供 x_ 返回 */
export function renderAnswers(answers) {
  const list = Array.isArray(answers) ? answers : [];
  const lines = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const id = a.id ?? a.question_id ?? "?";
    const type = String(a.type || "").toLowerCase();
    // 概率字段名各家写法不一，逐个兜底（官方文档给的是 probability/confidence）
    const p = a.probability ?? a.confidence ?? a.prob ?? a.value;
    const pct = Number.isFinite(Number(p)) ? `（${(Number(p) * 100).toFixed(1)}%）` : "";
    if (type === "choice") {
      const chosen = a.choice ?? a.selected ?? a.answer ?? a.choice_id;
      const idx = list.length && a.choices ? a.choices.findIndex((c) => String(c.id) === String(chosen)) : -1;
      const label = idx >= 0 ? a.choices[idx]?.text || chosen : chosen;
      lines.push(`${id}: ${label ?? "—"}${pct}`);
    } else if (type === "score") {
      lines.push(`${id}: ${a.score ?? a.value ?? "—"}${pct}`);
    } else {
      // noul：是/否
      const yes = a.answer ?? a.noul ?? a.value;
      const word = yes === true || yes === "true" || yes === "yes" || yes === 1 ? "是" : "否";
      lines.push(`${id}: ${word}${pct}`);
    }
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------------------------
   适配器契约
   --------------------------------------------------------------------------- */

export async function chat({ channel, model, prompt, messages, onDelta, signal }) {
  const { systemone } = endpoints(channel?.base_url);
  const key = nextKey(channel);
  if (!key) throw Object.assign(new Error("未填写 TypeSafe API Key"), { code: "CHANNEL_AUTH_EXPIRED" });

  const state = buildState(messages, prompt);
  if (!state.trim()) {
    throw Object.assign(new Error("state 不能为空（至少给一条消息）"), { code: "CHANNEL_BAD_REQUEST" });
  }
  // 最后一条用户消息里若带了结构化问题，就用它；否则自动构造 noul
  const lastUser = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((m) => m && m.role !== "assistant" && m.role !== "system");
  const provided = parseQuestions(typeof lastUser?.content === "string" ? lastUser.content : "");
  // 带结构化问题时，state 里要把那段 JSON 去掉（否则同一内容算两遍，纯浪费 token）
  const stateClean = provided
    ? state.replace(/```(?:json)?[\s\S]*?```/i, "").replace(/\s+$/, "") || "（见问题）"
    : state;
  if (!stateClean.trim()) {
    throw Object.assign(new Error("state 不能为空"), { code: "CHANNEL_BAD_REQUEST" });
  }
  const questions = provided || autoQuestion(prompt, stateClean);

  let resp;
  try {
    resp = await fetch(systemone, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ state: stateClean, model: model || "jev-latest", questions }),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    throw Object.assign(new Error(`无法连接 TypeSafe 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  }

  const text = await resp.text();
  if (!resp.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j?.detail?.message || j?.detail?.error_type || j?.error?.message || msg;
    } catch {
      /* 非 JSON 就用原文 */
    }
    // 401/403 是鉴权问题，单独给 code，好走「重新登录」引导
    const code =
      resp.status === 401 || resp.status === 403
        ? "CHANNEL_AUTH_EXPIRED"
        : resp.status === 429
          ? "CHANNEL_RATE_LIMIT"
          : resp.status === 422
            ? "CHANNEL_BAD_REQUEST"
            : "CHANNEL_ERROR";
    throw Object.assign(new Error(`TypeSafe 上游返回 ${resp.status}：${msg}`), { code });
  }

  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`TypeSafe 返回的不是 JSON：${text.slice(0, 160)}`), {
      code: "CHANNEL_BAD_RESPONSE",
    });
  }

  const rendered = renderAnswers(j?.answers) || "（上游没有返回答案）";
  // 流式：Jev 是**单次响应**（非 SSE），一次性把结果交给网关。
  // 转发整段而不是拆字符：拆开只是视觉上像流式，没有实际收益，
  // 反而让「概率/置信度」这种需要整体阅读的内容被切碎。
  if (onDelta) onDelta(rendered);

  return {
    content: rendered,
    // 结构化结果原样回传：调用方需要精确数据（概率、选项 id）时不必解析文本
    structured: {
      model: j?.model || model,
      answers: j?.answers || [],
      usage: j?.usage || null,
    },
    // Jev 输出免费，这里只报输入侧；网关侧会按 prompt/completion 分别计价
    usage: {
      prompt_tokens: Number(j?.usage?.prompt_tokens ?? j?.usage?.input_tokens) || 0,
      completion_tokens: 0,
    },
  };
}

/** 渠道可用性：能连通且鉴权通过即可（用最小合法请求探活） */
export async function verify(channel) {
  const { systemone } = endpoints(channel?.base_url);
  const key = nextKey(channel);
  if (!key) throw Object.assign(new Error("未填写 TypeSafe API Key"), { code: "CHANNEL_AUTH_EXPIRED" });
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(systemone, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({
        state: "connectivity check",
        model: channel?.test_model || "jev-latest",
        questions: [{ id: "ping", type: "noul", text: "Is this a connectivity check?" }],
      }),
      signal: AbortSignal.timeout(getNumberOption("request_timeout_ms") || 60_000),
    });
  } catch (e) {
    throw Object.assign(new Error(`无法连接 TypeSafe 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  }
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("TypeSafe API Key 无效或已失效"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (!resp.ok) {
    throw Object.assign(new Error(`TypeSafe 探活失败 ${resp.status}：${text.slice(0, 200)}`), { code: "CHANNEL_ERROR" });
  }
  return Date.now() - t0;
}

/** 模型清单：官方 GET /v1/models（无 key 会 403，所以带上 key） */
export async function fetchUpstreamModels(channel) {
  const { models } = endpoints(channel?.base_url);
  const key = nextKey(channel);
  const resp = await fetch(models, { headers: headers(key), signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`拉取模型失败（HTTP ${resp.status}）`);
  const j = await resp.json();
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  const ids = list.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
  // 官方 /v1/models 只返回别名；补上版本号便于管理员指定
  return ids.length ? ids : ["jev-latest"];
}
