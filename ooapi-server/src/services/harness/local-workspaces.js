import crypto from "node:crypto";
import { pool } from "../../db.js";

const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const id = () => crypto.randomUUID();
const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(value);
const fail = (message, code = "LOCAL_INVALID", status = 400) => Object.assign(new Error(message), { code, status });
const abortError = () => fail("本地任务已停止；已经送达的写入或命令请核对本机执行记录。", "ABORTED", 409);
const waitingError = () => Object.assign(fail("本地执行器离线或尚未接收任务，请连接设备后恢复。", "WAITING_LOCAL", 409), { outcome: "not_executed" });
export const LOCAL_ACTIONS = ["list", "read", "search", "write", "patch", "exec"];
const INTERNAL_ACTIONS = ["context_save", "context_load", "result_get"];

// 云端只持久身份及关联。工具参数、结果、根目录和终端输出均不进入数据库。
export function createLocalWorkspaceService({ db = pool, now = Date.now, pollMs = 25000, offlineMs = 45000 } = {}) {
  const pairing = new Map(), devices = new Map(), jobs = new Map();
  const seconds = () => Math.floor(now() / 1000);
  const runtime = deviceId => {
    if (!devices.has(deviceId)) devices.set(deviceId, { seen: 0, capabilities: new Map(), waiters: new Set(), cancelled: new Set() });
    return devices.get(deviceId);
  };
  const wake = deviceId => { for (const resolve of runtime(deviceId).waiters) resolve(); };
  const cleanPairs = () => { for (const [key, value] of pairing) if (value.expires <= now()) pairing.delete(key); };
  async function deviceFromBearer(bearer, allowPending = false) {
    if (!/^olc_[a-f0-9]{64}$/.test(String(bearer))) throw fail("本地执行器认证失败。", "LOCAL_AUTH", 401);
    const hash = digest(bearer);
    const [[device]] = await db.query("SELECT d.id, d.user_id, d.status FROM local_devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ? AND u.status = 1", [hash]);
    if (device && Number(device.status) === 1) return device;
    cleanPairs();
    if (allowPending && [...pairing.values()].some(p => p.tokenHash === hash)) return null;
    throw fail("本地执行器未配对、已撤销或账号不可用。", "LOCAL_AUTH", 401);
  }
  async function startPairing() {
    cleanPairs();
    if (pairing.size >= 200) throw fail("待配对设备过多，请稍后重试。", "LOCAL_BUSY", 429);
    const bearer = `olc_${crypto.randomBytes(32).toString("hex")}`, deviceId = id();
    const code = crypto.randomBytes(5).toString("hex").toUpperCase();
    const expires = now() + 300000;
    pairing.set(digest(code), { deviceId, tokenHash: digest(bearer), expires });
    return { deviceId, code, bearer, expiresAt: expires };
  }
  async function confirmPairing(userId, code) {
    cleanPairs();
    const key = digest(String(code || "").replace(/[\s-]/g, "").toUpperCase()), pending = pairing.get(key);
    if (!pending) throw fail("配对码无效或已过期。", "LOCAL_PAIR_EXPIRED");
    // 先消费短码，两个浏览器不能同时抢占同一台设备。
    pairing.delete(key);
    await db.query("INSERT INTO local_devices (id,user_id,token_hash,status,created_at,last_seen_at) VALUES (?,?,?,1,?,?)", [pending.deviceId, userId, pending.tokenHash, seconds(), 0]);
    return { deviceId: pending.deviceId };
  }
  async function register(device, workspaces) {
    if (!Array.isArray(workspaces) || !workspaces.length || workspaces.length > 16) throw fail("需要提供 1–16 个本地工作区标识。");
    const state = runtime(device.id), next = new Map();
    for (const workspace of workspaces) {
      if (!validId(workspace.id)) throw fail("工作区标识无效。");
      const [[existing]] = await db.query("SELECT id,device_id,user_id FROM local_workspaces WHERE id = ?", [workspace.id]);
      if (existing && (existing.device_id !== device.id || Number(existing.user_id) !== Number(device.user_id))) throw fail("工作区标识已被其他设备使用。", "LOCAL_FORBIDDEN", 403);
      if (!existing) await db.query("INSERT INTO local_workspaces (id,device_id,user_id,created_at) VALUES (?,?,?,?)", [workspace.id, device.id, device.user_id, seconds()]);
      const label = typeof workspace.label === "string" && !/[\\/:\r\n]/.test(workspace.label) ? workspace.label.slice(0, 60) : "本地工作区";
      next.set(workspace.id, { label, read: workspace.capabilities?.read === true, write: workspace.capabilities?.write === true, exec: workspace.capabilities?.exec === true && workspace.capabilities?.docker === true, docker: workspace.capabilities?.docker === true });
    }
    state.capabilities = next; state.seen = now();
    await db.query("UPDATE local_devices SET last_seen_at = ? WHERE id = ?", [seconds(), device.id]);
    wake(device.id);
    return { deviceId: device.id, workspaceIds: [...next.keys()] };
  }
  async function list(userId) {
    const [rows] = await db.query("SELECT w.id,w.device_id FROM local_workspaces w JOIN local_devices d ON d.id = w.device_id WHERE w.user_id = ? AND d.status = 1", [userId]);
    return rows.map(w => { const d = devices.get(w.device_id), capabilities = d?.capabilities.get(w.id) || null; return { id: w.id, deviceId: w.device_id, label: capabilities?.label || "本地工作区", online: Boolean(d && now() - d.seen < offlineMs), capabilities }; });
  }
  async function bind(userId, sessionId, workspaceId) {
    const [[session]] = await db.query("SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?", [sessionId, userId]);
    if (!session) throw fail("对话不存在。", "LOCAL_NOT_FOUND", 404);
    const [[unfinished]] = await db.query("SELECT status FROM chat_agent_runs WHERE session_id = ? AND user_id = ? AND status IN ('running','paused','waiting_local','interrupted')", [sessionId, userId]);
    if (unfinished && (await get(userId, sessionId))?.id !== workspaceId) throw fail("当前会话有未完成任务，请先完成或停止，再切换或解绑工作区。", "LOCAL_BUSY", 409);
    if ([...jobs.values()].some(j => j.sessionId === sessionId && Number(j.userId) === Number(userId))) throw fail("请先停止当前本地任务，再切换工作区。", "LOCAL_BUSY", 409);
    if (workspaceId === null) { await db.query("DELETE FROM local_session_workspaces WHERE session_id = ? AND user_id = ?", [sessionId, userId]); return null; }
    const [[workspace]] = await db.query("SELECT w.id,w.device_id FROM local_workspaces w JOIN local_devices d ON d.id = w.device_id WHERE w.id = ? AND w.user_id = ? AND d.status = 1", [workspaceId, userId]);
    if (!workspace) throw fail("工作区不存在或不属于当前用户。", "LOCAL_FORBIDDEN", 403);
    await db.query("INSERT INTO local_session_workspaces (session_id,user_id,workspace_id,created_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE workspace_id=VALUES(workspace_id),created_at=VALUES(created_at)", [sessionId, userId, workspaceId, seconds()]);
    return { id: workspace.id, deviceId: workspace.device_id };
  }
  async function get(userId, sessionId) {
    const [[row]] = await db.query("SELECT w.id,w.device_id FROM local_session_workspaces s JOIN local_workspaces w ON w.id = s.workspace_id JOIN local_devices d ON d.id = w.device_id WHERE s.session_id = ? AND s.user_id = ? AND w.user_id = ? AND d.status = 1", [sessionId, userId, userId]);
    if (!row) return null;
    const d = devices.get(row.device_id);
    return { id: row.id, deviceId: row.device_id, label: d?.capabilities.get(row.id)?.label || "本地工作区", online: Boolean(d && now() - d.seen < offlineMs), capabilities: d?.capabilities.get(row.id) || null };
  }
  async function revoke(userId, deviceId) {
    const [[owned]] = await db.query("SELECT id FROM local_devices WHERE id = ? AND user_id = ? AND status = 1", [deviceId, userId]);
    if (!owned) throw fail("设备不存在或不属于当前用户。", "LOCAL_FORBIDDEN", 403);
    await db.query("UPDATE local_devices SET status = 0 WHERE id = ? AND user_id = ?", [deviceId, userId]);
    for (const job of jobs.values()) if (job.deviceId === deviceId && Number(job.userId) === Number(userId)) job.finish({ ok: false, output: "本地设备授权已撤销；已经派发的操作请核对本机日志。", meta: { local: true, callId: job.callId, uncertain: Boolean(job.offeredAt), outcome: job.offeredAt ? "unknown" : "not_executed" } });
    wake(deviceId); devices.delete(deviceId);
  }
  async function poll(device, active = [], signal) {
    const state = runtime(device.id); state.seen = now();
    if (state.waiters.size) throw fail("当前设备已有一个长轮询连接。", "LOCAL_BUSY", 429);
    for (const callId of active.slice(0, 32)) { const job = jobs.get(callId); if (job?.deviceId === device.id) { job.offeredAt = now(); job.onState?.({ state: "running_local", callId }); } }
    const ready = () => {
      const pending = [...jobs.values()].filter(j => j.deviceId === device.id);
      for (const job of pending) {
        const permission = ["write", "patch"].includes(job.action) ? "write" : job.action === "exec" ? "exec" : "read";
        if (!state.capabilities.get(job.workspaceId)?.[permission]) job.finish({ ok: false, output: "本机工作区或此类操作的授权已改变，请核对设备。", meta: { local: true, callId: job.callId, uncertain: Boolean(job.offeredAt), outcome: job.offeredAt ? "unknown" : "not_executed" } });
      }
      return [...jobs.values()].filter(j => j.deviceId === device.id && (!j.offeredAt || now() - j.offeredAt >= 30000));
    };
    if (!ready().length && !state.cancelled.size && !signal?.aborted) await new Promise(resolve => {
      let timer;
      const finish = () => { clearTimeout(timer); state.waiters.delete(finish); signal?.removeEventListener("abort", finish); resolve(); };
      state.waiters.add(finish); signal?.addEventListener("abort", finish, { once: true }); timer = setTimeout(finish, pollMs);
    });
    state.seen = now();
    if (signal?.aborted) return { calls: [], cancel: [] };
    const calls = ready().slice(0, 1).map(job => {
      job.offeredAt = now(); job.onState?.({ state: "running_local", callId: job.callId });
      return { callId: job.callId, workspaceId: job.workspaceId, action: job.action, args: job.args };
    });
    const cancel = [...state.cancelled]; state.cancelled.clear();
    return { calls, cancel };
  }
  function result(device, value) {
    const job = jobs.get(value?.callId);
    if (!job) return { accepted: false, orphaned: true };
    if (job.deviceId !== device.id || Number(job.userId) !== Number(device.user_id)) throw fail("任务不属于当前设备。", "LOCAL_FORBIDDEN", 403);
    const output = String(value.output || "");
    if (Buffer.byteLength(output) > 4 * 1024 * 1024 - 2048) throw fail("本地结果超过上限。");
    const outcome = value.uncertain === true ? "unknown" : ["executed", "not_executed", "unknown"].includes(value.outcome) ? value.outcome : value.ok === true ? "executed" : ["write", "patch", "exec"].includes(job.action) ? "unknown" : "not_executed";
    job.finish({ ok: value.ok === true, output, meta: { local: true, callId: job.callId, uncertain: outcome === "unknown", outcome } });
    return { accepted: true };
  }
  async function run(action, args, { userId, sessionId, signal, onState, expectedWorkspaceId, callId = id(), timeoutMs = 30 * 60 * 1000 } = {}) {
    if (![...LOCAL_ACTIONS, ...INTERNAL_ACTIONS].includes(action) || !validId(callId)) throw fail("未知本地工具或调用编号。");
    if (!args || typeof args !== "object" || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 4 * 1024 * 1024 - 2048) throw fail("本地参数无效或过长。");
    const workspace = await get(userId, sessionId);
    if (expectedWorkspaceId && workspace?.id !== expectedWorkspaceId) throw Object.assign(fail("工作区关联已改变，请连接原工作区后继续。", "LOCAL_CONTEXT_MISSING", 409), { outcome: "not_executed" });
    if (!workspace) return { ok: false, output: "当前对话未关联本地工作区，请先配对本地执行器并选择工作区。", meta: { local: true, callId, outcome: "not_executed" } };
    const permission = ["write", "patch"].includes(action) ? "write" : action === "exec" ? "exec" : "read";
    if (!workspace.capabilities) throw waitingError();
    if (workspace.capabilities && !workspace.capabilities[permission]) return { ok: false, output: permission === "exec" ? "本机未授权隔离命令执行，或未检测到已配置的 Docker 镜像。" : "本机未授权此类文件操作，请在本地执行器中授权。", meta: { local: true, callId, outcome: "not_executed" } };
    if (signal?.aborted) throw Object.assign(abortError(), { outcome: "not_executed" });
    if (!workspace.online) { onState?.({ state: "waiting_local_offline", callId }); throw waitingError(); }
    if (jobs.has(callId)) throw fail("此本地调用正在等待结果。", "LOCAL_BUSY", 409);
    const bytes = Buffer.byteLength(JSON.stringify(args));
    if (jobs.size >= 128 || [...jobs.values()].reduce((n, j) => n + j.bytes, bytes) > 16 * 1024 * 1024 || [...jobs.values()].filter(j => Number(j.userId) === Number(userId)).length >= 16) throw fail("本地任务过多。", "LOCAL_BUSY", 429);
    return new Promise((resolve, reject) => {
      let timer;
      const finish = result => { if (!jobs.delete(callId)) return; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(result); };
      const abort = () => { const job = jobs.get(callId); if (!jobs.delete(callId)) return; clearTimeout(timer); signal?.removeEventListener("abort", abort); runtime(workspace.deviceId).cancelled.add(callId); wake(workspace.deviceId); reject(Object.assign(abortError(), { outcome: job.offeredAt ? "unknown" : "not_executed" })); };
      jobs.set(callId, { callId, action, args: structuredClone(args), bytes, workspaceId: workspace.id, deviceId: workspace.deviceId, sessionId, userId, onState, finish, offeredAt: 0 });
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        const job = jobs.get(callId); if (!job || !jobs.delete(callId)) return;
        signal?.removeEventListener("abort", abort); runtime(workspace.deviceId).cancelled.add(callId); wake(workspace.deviceId);
        reject(job.offeredAt ? Object.assign(fail("本地调用已派发，但结果未确认；请恢复本机日志，不能重新执行写入或命令。", "LOCAL_OUTCOME_UNKNOWN", 409), { outcome: "unknown", callId }) : waitingError());
      }, Math.max(1, Math.min(Number(timeoutMs) || 1800000, 86400000)));
      onState?.({ state: workspace.online ? "waiting_local" : "waiting_local_offline", callId }); wake(workspace.deviceId);
    });
  }
  return { startPairing, confirmPairing, deviceFromBearer, register, list, bind, get, revoke, poll, result, run };
}
export const localWorkspaces = createLocalWorkspaceService();
export const bindSessionWorkspace = (...args) => localWorkspaces.bind(...args);
export const getSessionWorkspace = (...args) => localWorkspaces.get(...args);
export const runLocalTool = (...args) => localWorkspaces.run(...args);
async function internalResult(action, args, ctx) {
  const result = await localWorkspaces.run(action, args, { ...ctx, callId: ctx.requestId || id(), timeoutMs: Math.min(Number(ctx.timeoutMs) || 4000, 10000) });
  if (!result.ok) throw fail(result.output, "LOCAL_CHECKPOINT_UNAVAILABLE", 409);
  try { return JSON.parse(result.output); } catch { throw fail("本地检查点格式无效。", "LOCAL_CHECKPOINT_INVALID", 409); }
}
export const saveLocalCheckpoint = (ctx, state) => internalResult("context_save", { runId: ctx.runId || state.runId || ctx.callId, state }, ctx.signal?.aborted ? { ...ctx, signal: undefined, timeoutMs: 4000 } : ctx);
export const loadLocalCheckpoint = (ctx, runId) => internalResult("context_load", { runId }, ctx);
export const getLocalResult = (ctx, callId) => internalResult("result_get", { callId }, ctx);
