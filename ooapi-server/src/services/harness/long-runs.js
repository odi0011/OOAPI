import crypto from "node:crypto";
import { pool } from "../../db.js";

const ACTIVE = new Set(["running", "paused", "waiting_local", "interrupted"]);
const decode = v => { try { return JSON.parse(v || "null"); } catch { return null; } };
const error = (message, code, status = 409) => Object.assign(new Error(message), { code, status });

// 运行检查点与普通聊天消息分开；重连读状态，显式继续才取得执行租约。
export function createLongRunStore(db = pool, { clock = Date.now } = {}) {
  function parse(row) {
    return row ? { id: row.id, sessionId: row.session_id, userId: Number(row.user_id), status: row.status,
      checkpoint: decode(row.checkpoint), config: decode(row.config) || {}, calls: decode(row.bill_calls) || [],
      version: Number(row.version) || 0, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      billingSegment: Number(row.billing_segment) || 0, assistantSegment: Number(row.assistant_segment ?? -1), assistantMessageId: Number(row.assistant_message_id) || 0, owner: row.lease_owner || "",
      leaseUntil: Number(row.lease_until) || 0, errorCode: row.error_code || "" } : null;
  }
  async function get(userId, sessionId) {
    const [rows] = await db.query("SELECT * FROM chat_agent_runs WHERE user_id = ? AND session_id = ?", [userId, sessionId]);
    const row = parse(rows[0]);
    // 服务重启/异常退出不会使任务被当成完成；过期租约交由用户确认继续。
    if (row?.status === "running" && row.leaseUntil < clock()) row.status = "interrupted";
    return row;
  }
  async function begin(userId, sessionId, config) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [owned] = await conn.query("SELECT id FROM chat_sessions WHERE id = ? AND user_id = ? FOR UPDATE", [sessionId, userId]);
      if (!owned.length) throw error("会话不存在", "NO_SESSION", 404);
      const [rows] = await conn.query("SELECT * FROM chat_agent_runs WHERE session_id = ? FOR UPDATE", [sessionId]);
      if (rows[0] && ACTIVE.has(rows[0].status)) throw error("这个会话有未结束的任务，请继续或停止它。", "RUN_PENDING");
      const id = crypto.randomUUID(), owner = crypto.randomUUID(), t = clock();
      await conn.query(`INSERT INTO chat_agent_runs (id, session_id, user_id, status, config, checkpoint, bill_calls, version, lease_owner, lease_until, error_code, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id), status=VALUES(status), config=VALUES(config), checkpoint=NULL, bill_calls='[]', version=0, billing_segment=0, assistant_segment=-1, assistant_message_id=0, lease_owner=VALUES(lease_owner), lease_until=VALUES(lease_until), error_code='', created_at=VALUES(created_at), updated_at=VALUES(updated_at)`,
      [id, sessionId, userId, "running", JSON.stringify(config), null, "[]", 0, owner, t + 90000, "", t, t]);
      await conn.commit();
      return { id, sessionId, userId, status: "running", config, checkpoint: null, calls: [], version: 0, billingSegment: 0, assistantSegment: -1, owner };
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }
  async function claim(userId, sessionId) {
    const owner = crypto.randomUUID(), t = clock();
    const [ret] = await db.query(`UPDATE chat_agent_runs SET status='running', lease_owner=?, lease_until=?, updated_at=?
      WHERE user_id=? AND session_id=? AND (status IN ('paused','waiting_local','interrupted') OR (status='running' AND lease_until<?))`,
    [owner, t + 90000, t, userId, sessionId, t]);
    if (!ret.affectedRows) throw error("任务已经在执行，或没有可以恢复的任务。", "RUN_NOT_RESUMABLE");
    return { ...await get(userId, sessionId), owner };
  }
  async function checkpoint(run, state, { calls, status = "running", errorCode = "" } = {}) {
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw error("任务检查点过大，请缩小工作范围。", "CHECKPOINT_LIMIT", 413);
    const t = clock();
    const [ret] = await db.query(`UPDATE chat_agent_runs SET checkpoint=?, bill_calls=?, status=?, version=version+1, lease_until=?, error_code=?, updated_at=?
      WHERE id=? AND user_id=? AND lease_owner=? AND version=? AND status NOT IN ('completed','stopped')`,
    [data, JSON.stringify(calls ?? run.calls ?? []), status, t + 90000, errorCode, t, run.id, run.userId, run.owner, run.version || 0]);
    if (!ret.affectedRows) throw error("任务状态已改变，请重新读取。", "RUN_CHANGED");
    run.checkpoint = state; run.calls = calls ?? run.calls ?? []; run.status = status; run.version = (run.version || 0) + 1;
  }
  async function finish(run, status, { calls = [], errorCode = "" } = {}) {
    // 父任务终止与子任务取消必须一起提交，否则重连会看到永远 pending 的子任务。
    const terminal = ["stopped", "error"].includes(status), conn = terminal ? await db.getConnection() : db;
    try {
      if (terminal) await conn.beginTransaction();
      const [ret] = await conn.query("UPDATE chat_agent_runs SET status=?, bill_calls=?, lease_owner='', lease_until=0, error_code=?, updated_at=? WHERE id=? AND user_id=? AND lease_owner=?", [status, JSON.stringify(calls), errorCode, clock(), run.id, run.userId, run.owner]);
      if (!ret.affectedRows) throw error("任务执行租约已改变。", "RUN_CHANGED");
      if (terminal) { await cancelUnfinishedTasks(conn, run.id, run.userId, run.sessionId); await conn.commit(); }
    } catch (e) { if (terminal) await conn.rollback(); throw e; }
    finally { if (terminal) conn.release(); }
    run.status = status; run.calls = calls;
  }
  async function cancelUnfinishedTasks(conn, runId, userId, sessionId) {
    await conn.query(`UPDATE chat_agent_tasks SET status='cancelled',updated_at=?
      WHERE run_id=? AND user_id=? AND session_id=? AND status IN ('pending','running','paused','waiting_local','interrupted')`,
    [clock(), runId, userId, sessionId]);
  }
  async function heartbeat(run) {
    const [ret] = await db.query("UPDATE chat_agent_runs SET lease_until=?, updated_at=? WHERE id=? AND user_id=? AND lease_owner=? AND status='running'", [clock() + 90000, clock(), run.id, run.userId, run.owner]);
    if (!ret.affectedRows) throw error("任务执行租约已改变。", "RUN_CHANGED");
  }
  async function calls(run, records) {
    const [ret] = await db.query("UPDATE chat_agent_runs SET bill_calls=?, updated_at=? WHERE id=? AND user_id=? AND lease_owner=?", [JSON.stringify(records), clock(), run.id, run.userId, run.owner]);
    if (!ret.affectedRows) throw error("任务执行租约已改变。", "RUN_CHANGED");
    run.calls = records;
  }
  async function config(run, value) {
    const [ret] = await db.query("UPDATE chat_agent_runs SET config=?, updated_at=? WHERE id=? AND user_id=? AND lease_owner=?", [JSON.stringify(value), clock(), run.id, run.userId, run.owner]);
    if (!ret.affectedRows) throw error("任务执行租约已改变。", "RUN_CHANGED");
    run.config = value;
  }
  async function tasks(userId, sessionId, runId) {
    const [rows] = await db.query("SELECT * FROM chat_agent_tasks WHERE user_id=? AND session_id=? AND run_id=? ORDER BY created_at ASC", [userId, sessionId, runId]);
    return rows.map(r => ({ ...decode(r.payload), id: r.id, status: r.status, checkpoint: decode(r.checkpoint), updatedAt: Number(r.updated_at) }));
  }
  async function saveTask(userId, sessionId, runId, task, owner = "") {
    const { checkpoint: state, ...payload } = task;
    const [ret] = await db.query(`INSERT INTO chat_agent_tasks (id,run_id,session_id,user_id,status,payload,checkpoint,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? FROM chat_agent_runs WHERE id=? AND user_id=? AND lease_owner=?
      ON DUPLICATE KEY UPDATE status=VALUES(status),payload=VALUES(payload),checkpoint=VALUES(checkpoint),updated_at=VALUES(updated_at)`,
    [task.id, runId, sessionId, userId, task.status, JSON.stringify(payload), state ? JSON.stringify(state) : null, task.createdAt || clock(), clock(), runId, userId, owner]);
    if (!ret.affectedRows) throw error("子任务执行租约已改变。", "RUN_CHANGED");
  }
  async function stop(userId, sessionId) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query("SELECT * FROM chat_agent_runs WHERE user_id=? AND session_id=? FOR UPDATE", [userId, sessionId]);
      const row = parse(rows[0]), t = clock();
      // interrupted 有时仅由过期租约派生；数据库里的 running 也必须能被停止。
      if (!row || !(["paused", "waiting_local", "interrupted"].includes(row.status) || (row.status === "running" && row.leaseUntil < t))) {
        await conn.commit(); return false;
      }
      await conn.query("UPDATE chat_agent_runs SET status='stopped',lease_owner='',lease_until=0,version=version+1,updated_at=? WHERE id=? AND user_id=?", [t, row.id, userId]);
      await cancelUnfinishedTasks(conn, row.id, userId, sessionId);
      await conn.commit(); return true;
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }
  return { get, begin, claim, checkpoint, finish, heartbeat, calls, config, tasks, saveTask, stop };
}

export const longRunStore = createLongRunStore();
export function publicLongRun(row) {
  return row ? { id: row.id, status: row.status, resumable: ["paused", "waiting_local", "interrupted"].includes(row.status),
    version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, errorCode: row.errorCode,
    budget: row.checkpoint?.budget || null, local: Boolean(row.config?.workspaceId) } : null;
}
