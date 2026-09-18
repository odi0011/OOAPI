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
export const TOOL_IDS = ["search", "fetch", "github", "task", "todowrite"];

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
    project_id: row.project_id || "",
    archived: Number(row.archived) === 1,
    pinned: Number(row.pinned) === 1,
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

export async function createSession({ userId, agent = "general", model = "", settings = {}, projectId = "" }) {
  const id = newSessionId();
  const t = now();
  const clean = sanitizeSettings(settings);
  await pool.query(
    "INSERT INTO chat_sessions (id, user_id, title, agent, model, project_id, settings, todo, created_time, updated_time) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      id,
      userId,
      "新对话",
      String(agent).slice(0, 32),
      String(model).slice(0, 128),
      String(projectId || "").slice(0, 32),
      JSON.stringify(clean),
      "[]",
      t,
      t,
    ]
  );
  return getSession(userId, id);
}

/**
 * 会话列表。默认只返回未归档的；archived=true 只看归档；archived="all" 全都返回。
 * 项目用 projectId 过滤（传 "__none" 表示「未归类」）。
 */
export async function listSessions(userId, { q = "", limit = 200, archived = "false", projectId = "" } = {}) {
  const where = ["user_id = ?"];
  const args = [userId];
  if (q) {
    where.push("title LIKE ?");
    args.push(`%${String(q).trim().slice(0, 60)}%`);
  }
  if (archived === "true") where.push("archived = 1");
  else if (archived === "false") where.push("archived = 0");
  if (projectId === "__none") where.push("project_id = ''");
  else if (projectId) {
    where.push("project_id = ?");
    args.push(String(projectId).slice(0, 32));
  }
  args.push(clamp(Number(limit) || 200, 1, 500));
  // 置顶优先，其次最近更新：与 ChatGPT 侧栏的排序习惯一致
  const [rows] = await pool.query(
    `SELECT * FROM chat_sessions WHERE ${where.join(" AND ")} ORDER BY pinned DESC, updated_time DESC LIMIT ?`,
    args
  );
  return rows.map(sessionToResponse);
}

/** 各归档/项目维度的计数（侧栏给项目与归档入口显示数量） */
export async function sessionCounts(userId) {
  const [rows] = await pool.query(
    "SELECT project_id, archived, COUNT(*) AS c FROM chat_sessions WHERE user_id = ? GROUP BY project_id, archived",
    [userId]
  );
  const out = { active: 0, archived: 0, byProject: {} };
  for (const r of rows) {
    const c = Number(r.c) || 0;
    if (Number(r.archived) === 1) out.archived += c;
    else {
      out.active += c;
      const p = r.project_id || "";
      out.byProject[p] = (out.byProject[p] || 0) + c;
    }
  }
  return out;
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
  if (patch.project_id !== undefined) {
    // 归入项目前校验归属：不能把会话塞进别人的项目
    const pid = String(patch.project_id || "").slice(0, 32);
    if (pid && !(await getProject(userId, pid))) throw Object.assign(new Error("项目不存在"), { code: "NO_PROJECT" });
    sets.push("project_id = ?");
    args.push(pid);
  }
  if (patch.archived !== undefined) {
    sets.push("archived = ?");
    args.push(patch.archived ? 1 : 0);
  }
  if (patch.pinned !== undefined) {
    sets.push("pinned = ?");
    args.push(patch.pinned ? 1 : 0);
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

/* --------------------------- 项目（ChatGPT 式分类） --------------------------- */

function newProjectId() {
  return `p${newSessionId().slice(0, 11)}`;
}

export function projectToResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || "未命名项目",
    remark: row.remark || "",
    created_time: Number(row.created_time) || 0,
    updated_time: Number(row.updated_time) || 0,
  };
}

export async function listProjects(userId) {
  const [rows] = await pool.query("SELECT * FROM chat_projects WHERE user_id = ? ORDER BY updated_time DESC LIMIT 200", [userId]);
  return rows.map(projectToResponse);
}

export async function getProject(userId, id) {
  const [rows] = await pool.query("SELECT * FROM chat_projects WHERE id = ? AND user_id = ?", [String(id), userId]);
  return projectToResponse(rows[0]);
}

export async function createProject({ userId, name = "", remark = "" }) {
  const id = newProjectId();
  const t = now();
  await pool.query("INSERT INTO chat_projects (id, user_id, name, remark, created_time, updated_time) VALUES (?,?,?,?,?,?)", [
    id,
    userId,
    String(name).trim().slice(0, 64) || "未命名项目",
    String(remark).slice(0, 255),
    t,
    t,
  ]);
  return getProject(userId, id);
}

export async function updateProject(userId, id, patch = {}) {
  const sets = [];
  const args = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(String(patch.name).trim().slice(0, 64) || "未命名项目");
  }
  if (patch.remark !== undefined) {
    sets.push("remark = ?");
    args.push(String(patch.remark).slice(0, 255));
  }
  if (!sets.length) return getProject(userId, id);
  sets.push("updated_time = ?");
  args.push(now(), String(id), userId);
  await pool.query(`UPDATE chat_projects SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, args);
  return getProject(userId, id);
}

/** 删除项目：项目下的会话不删，改为「未归类」（避免误删聊天记录） */
export async function deleteProject(userId, id) {
  const project = await getProject(userId, id);
  if (!project) return false;
  await pool.query("UPDATE chat_sessions SET project_id = '' WHERE project_id = ? AND user_id = ?", [String(id), userId]);
  await pool.query("DELETE FROM chat_projects WHERE id = ? AND user_id = ?", [String(id), userId]);
  return true;
}

/* --------------------------- 批量操作 --------------------------- */

/**
 * 批量归档 / 取消归档 / 删除 / 移动项目 / 置顶。
 * 只影响属于该用户且 id 在列表里的会话（SQL 层保证，不靠调用方过滤）。
 * @param {object} p { userId, ids: string[], action: string, projectId?: string }
 */
export async function batchSessions({ userId, ids = [], action, projectId = "" }) {
  const list = (Array.isArray(ids) ? ids : []).map((v) => String(v).slice(0, 32)).filter(Boolean).slice(0, 500);
  if (!list.length) return { affected: 0 };
  const ph = list.map(() => "?").join(",");

  if (action === "delete") {
    const [ret] = await pool.query(`DELETE FROM chat_sessions WHERE user_id = ? AND id IN (${ph})`, [userId, ...list]);
    // 消息按 session_id 删（这些 id 已确认属于该用户，直接删不会越权）
    await pool.query(`DELETE FROM chat_messages WHERE session_id IN (${ph})`, list);
    return { affected: ret.affectedRows };
  }

  const sets = [];
  const args = [];
  if (action === "archive") sets.push("archived = 1");
  else if (action === "unarchive") sets.push("archived = 0");
  else if (action === "pin") sets.push("pinned = 1");
  else if (action === "unpin") sets.push("pinned = 0");
  else if (action === "move") {
    const pid = String(projectId || "").slice(0, 32);
    if (pid && !(await getProject(userId, pid))) throw Object.assign(new Error("项目不存在"), { code: "NO_PROJECT" });
    sets.push("project_id = ?");
    args.push(pid);
  } else {
    throw Object.assign(new Error("不支持的批量操作"), { code: "BAD_ACTION" });
  }
  sets.push("updated_time = ?");
  const [ret] = await pool.query(
    `UPDATE chat_sessions SET ${sets.join(", ")} WHERE user_id = ? AND id IN (${ph})`,
    [...args, now(), userId, ...list]
  );
  return { affected: ret.affectedRows };
}

/** 首条用户消息直接当标题：比再调一次模型总结便宜得多，也够用（可手动重命名） */
export function titleFromText(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "新对话";
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}
