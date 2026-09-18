// 会话存储（chat_sessions / chat_messages）
// ---------------------------------------------------------------------------
// 消息体是 parts JSON 数组（opencode 的 message → parts 结构），
// 好处：思考链、工具调用、待办、错误都属于「同一条回复的一部分」，
// 落库与前端渲染是同一个结构，不需要为每种事件加列。
import crypto from "node:crypto";
import { pool } from "../../db.js";
import { now, safeJSONParse } from "../../utils.js";

export const MAX_STEPS_LIMIT = 16;
export const DEFAULT_MAX_STEPS = 6;
export const TOOL_IDS = ["search", "fetch", "task", "todowrite"];

// 会话 id：短、可读、无歧义字符（前端会拼进 URL/命令面板）
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function newSessionId() {
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** 会话设定归一化：非法值一律回落到默认，避免前端传什么就存什么 */
export function sanitizeSettings(raw = {}, { previous = {} } = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const base = previous && typeof previous === "object" ? previous : {};
  const pick = (key, fallback) => (src[key] === undefined ? fallback : src[key]);
  const boolOrNull = (v, fallback) => (typeof v === "boolean" ? v : v === null ? null : fallback);
  const tools = pick("tools", base.tools);
  return {
    thinking: boolOrNull(pick("thinking", base.thinking ?? null), null),
    search: boolOrNull(pick("search", base.search ?? null), null),
    tools: Array.isArray(tools) ? tools.filter((t) => TOOL_IDS.includes(t)) : null,
    maxSteps: clamp(Number(pick("maxSteps", base.maxSteps ?? DEFAULT_MAX_STEPS)) || DEFAULT_MAX_STEPS, 1, MAX_STEPS_LIMIT),
    instructions: String(pick("instructions", base.instructions ?? "")).slice(0, 4000),
  };
}

export function sessionToResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || "新对话",
    agent: row.agent || "general",
    model: row.model || "",
    settings: sanitizeSettings(safeJSONParse(row.settings, {}), {}),
    todo: safeJSONParse(row.todo, []),
    message_count: Number(row.message_count) || 0,
    cost: Number(row.cost_units || 0) / 10000,
    prompt_tokens: Number(row.prompt_tokens) || 0,
    completion_tokens: Number(row.completion_tokens) || 0,
    created_time: Number(row.created_time) || 0,
    updated_time: Number(row.updated_time) || 0,
  };
}

export async function createSession({ userId, agent = "general", model = "", settings = {} }) {
  const id = newSessionId();
  const t = now();
  const clean = sanitizeSettings(settings);
  await pool.query(
    "INSERT INTO chat_sessions (id, user_id, title, agent, model, settings, todo, created_time, updated_time) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, userId, "新对话", String(agent).slice(0, 32), String(model).slice(0, 128), JSON.stringify(clean), "[]", t, t]
  );
  return getSession(userId, id);
}

export async function listSessions(userId, { q = "", limit = 60 } = {}) {
  const like = `%${String(q).trim().slice(0, 60)}%`;
  const [rows] = await pool.query(
    q
      ? "SELECT * FROM chat_sessions WHERE user_id = ? AND title LIKE ? ORDER BY updated_time DESC LIMIT ?"
      : "SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_time DESC LIMIT ?",
    q ? [userId, like, clamp(Number(limit) || 60, 1, 200)] : [userId, clamp(Number(limit) || 60, 1, 200)]
  );
  return rows.map(sessionToResponse);
}

export async function getSession(userId, id) {
  const [rows] = await pool.query("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?", [String(id), userId]);
  return sessionToResponse(rows[0]);
}

export async function getSessionMessages(sessionId, { limit = 200 } = {}) {
  const [rows] = await pool.query(
    "SELECT seq, role, parts, agent, model, cost, prompt_tokens, completion_tokens, created_time FROM chat_messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?",
    [String(sessionId), clamp(Number(limit) || 200, 1, 500)]
  );
  return rows.map((r) => ({
    seq: Number(r.seq),
    role: r.role,
    parts: safeJSONParse(r.parts, []),
    agent: r.agent || "",
    model: r.model || "",
    cost: Number(r.cost) || 0,
    tokens: { prompt: Number(r.prompt_tokens) || 0, completion: Number(r.completion_tokens) || 0 },
    created_time: Number(r.created_time) || 0,
  }));
}

/**
 * 追加一条消息。seq 由数据库端算（派生表取 MAX+1），避免并发两条消息抢同一个序号。
 * 会话上的计数/花费/时间戳同步更新，供会话列表直接展示。
 */
export async function appendMessage({
  sessionId,
  userId,
  role,
  parts = [],
  agent = "",
  model = "",
  cost = 0,
  promptTokens = 0,
  completionTokens = 0,
}) {
  const t = now();
  const [ret] = await pool.query(
    `INSERT INTO chat_messages (session_id, user_id, seq, role, parts, agent, model, cost, prompt_tokens, completion_tokens, created_time)
     SELECT ?,?, COALESCE(MAX(seq),0)+1, ?,?,?,?,?,?,?,? FROM chat_messages WHERE session_id = ?`,
    [
      String(sessionId),
      userId,
      role,
      JSON.stringify(parts),
      String(agent).slice(0, 32),
      String(model).slice(0, 128),
      Number(cost) || 0,
      Number(promptTokens) || 0,
      Number(completionTokens) || 0,
      t,
      String(sessionId),
    ]
  );
  const costUnits = Math.round((Number(cost) || 0) * 10000);
  await pool.query(
    "UPDATE chat_sessions SET message_count = message_count + 1, cost_units = cost_units + ?, prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, updated_time = ? WHERE id = ? AND user_id = ?",
    [costUnits, Number(promptTokens) || 0, Number(completionTokens) || 0, t, String(sessionId), userId]
  );
  return Number(ret.insertId) || 0;
}

export async function updateSession(userId, id, patch = {}) {
  const sets = [];
  const args = [];
  // 白名单：只有这些字段允许被前端/PATCH 改写
  if (patch.title !== undefined) {
    sets.push("title = ?");
    args.push(String(patch.title).trim().slice(0, 120) || "新对话");
  }
  if (patch.agent !== undefined) {
    sets.push("agent = ?");
    args.push(String(patch.agent).slice(0, 32));
  }
  if (patch.model !== undefined) {
    sets.push("model = ?");
    args.push(String(patch.model).slice(0, 128));
  }
  if (patch.todo !== undefined) {
    sets.push("todo = ?");
    args.push(JSON.stringify(Array.isArray(patch.todo) ? patch.todo.slice(0, 20) : []));
  }
  if (patch.settings !== undefined) {
    const current = await getSession(userId, id);
    sets.push("settings = ?");
    args.push(JSON.stringify(sanitizeSettings(patch.settings, { previous: current?.settings || {} })));
  }
  if (!sets.length) return getSession(userId, id);
  sets.push("updated_time = ?");
  args.push(now(), String(id), userId);
  await pool.query(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, args);
  return getSession(userId, id);
}

export async function deleteSession(userId, id) {
  const [ret] = await pool.query("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?", [String(id), userId]);
  if (ret.affectedRows) await pool.query("DELETE FROM chat_messages WHERE session_id = ?", [String(id)]);
  return Boolean(ret.affectedRows);
}

/**
 * 回退到某条消息之前（重新生成用）。
 * 为什么必须由服务端做：如果只让前端把消息从界面删掉再重发，
 * 数据库里那轮「用户提问 + 失败回答」仍在，下一轮的上下文就会出现同一问题问两遍。
 * 同时重算会话统计 —— cost 是展示用的聚合值（用户额度早已实际扣除，这里只回滚统计口径）。
 */
export async function rewindSession(userId, id, fromSeq) {
  const seq = Math.max(1, Number(fromSeq) || 1);
  const session = await getSession(userId, id);
  if (!session) return null;
  await pool.query("DELETE FROM chat_messages WHERE session_id = ? AND seq >= ?", [String(id), seq]);
  const [aggRows] = await pool.query(
    "SELECT COUNT(*) AS c, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct FROM chat_messages WHERE session_id = ?",
    [String(id)]
  );
  const a = aggRows[0] || {};
  await pool.query(
    "UPDATE chat_sessions SET message_count = ?, cost_units = ?, prompt_tokens = ?, completion_tokens = ?, updated_time = ? WHERE id = ? AND user_id = ?",
    [Number(a.c) || 0, Math.round((Number(a.cost) || 0) * 10000), Number(a.pt) || 0, Number(a.ct) || 0, now(), String(id), userId]
  );
  return getSession(userId, id);
}

/** 会话完整返回（含消息），回退/重发后前端用它整体替换本地状态 */
export async function sessionWithMessages(userId, id) {
  const session = await getSession(userId, id);
  if (!session) return null;
  return { session, messages: await getSessionMessages(session.id) };
}

/** 首条用户消息直接当标题：比再调一次模型总结便宜得多，也够用（可手动重命名） */
export function titleFromText(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "新对话";
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}
