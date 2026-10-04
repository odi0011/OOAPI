import fs from "node:fs/promises";
import path from "node:path";
import { openWorkspace, sha256 } from "./workspace.mjs";
import { createJournal, atomicJson, privateDirectory, validId } from "./journal.mjs";

const MAX_BODY = 4 * 1024 * 1024;
const delay = (ms, signal) => new Promise(resolve => { let timer; const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }; signal?.addEventListener("abort", done, { once: true }); timer = setTimeout(done, ms); if (signal?.aborted) done(); });
export function validateServer(value, allowHttpLocalhost = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("服务地址必须是不带账号、路径或查询参数的 HTTPS 来源。");
  if (url.protocol !== "https:" && !(allowHttpLocalhost && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("云端连接必须使用 HTTPS；HTTP 仅可显式用于本机开发。");
  return url.origin;
}
export function createApi(server, bearer, { allowHttpLocalhost = false, fetchImpl = fetch } = {}) {
  const origin = validateServer(server, allowHttpLocalhost);
  return async (endpoint, body = {}, signal) => {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_BODY) throw new Error("本地传输超过 4 MB 上限。");
    const ctrl = new AbortController(), abort = () => ctrl.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 35000);
    if (signal?.aborted) abort();
    try {
      const response = await fetchImpl(`${origin}/api/local-workspaces${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: encoded, redirect: "error", signal: ctrl.signal });
      const reader = response.body?.getReader(); let data = "", bytes = 0; const decoder = new TextDecoder();
      if (!reader) throw new Error("云端未返回内容。");
      for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > MAX_BODY) { await reader.cancel(); throw new Error("云端返回超过 4 MB 上限。"); } data += decoder.decode(next.value, { stream: true }); }
      data += decoder.decode(); const result = JSON.parse(data);
      if (!response.ok || result.success !== true) throw Object.assign(new Error("云端请求被拒绝；请检查登录、配对或服务器状态。"), { status: response.status });
      return result.data;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
}
export function assertPrivateStateLocation(root, privateRoot) {
  const overlap = path.relative(root, privateRoot);
  if (!overlap || overlap !== ".." && !overlap.startsWith(`..${path.sep}`) && !path.isAbsolute(overlap)) throw new Error("私有状态目录必须位于授权工作区之外，避免日志和设备凭据被工具读取。");
}
export async function createExecutor({ stateDirectory, workspaceId, root, allowWrite, allowExec, dockerImage, label = "本地工作区", workspaceFactory = openWorkspace }) {
  if (!validId(workspaceId)) throw new Error("工作区标识无效。");
  const privateRoot = await privateDirectory(stateDirectory), workspace = await workspaceFactory(root, { allowWrite, allowExec, dockerImage });
  assertPrivateStateLocation(workspace.root, privateRoot);
  const journal = await createJournal(path.join(privateRoot, "calls", workspaceId));
  const checkpoints = await privateDirectory(path.join(privateRoot, "contexts"));
  const active = new Map();
  let workspaceQueue = Promise.resolve(), checkpointQueue = Promise.resolve();
  const description = { id: workspaceId, label: String(label).replace(/[\\/:\r\n]/g, "").slice(0, 60) || "本地工作区", capabilities: workspace.capabilities };
  async function executeNew(call, signal) {
    if (call.action === "context_save") {
      if (!validId(call.args.runId) || !call.args.state || typeof call.args.state !== "object") throw new Error("无效的本地检查点。");
      if (Buffer.byteLength(JSON.stringify(call.args.state)) > 3 * 1024 * 1024) throw new Error("本地检查点超过 3 MB 上限，请先压缩上下文。");
      await atomicJson(path.join(checkpoints, `${workspaceId}-${call.args.runId}.json`), call.args.state);
      return { ref: call.args.runId };
    }
    if (call.action === "context_load") {
      if (!validId(call.args.runId)) throw new Error("无效的检查点编号。");
      return JSON.parse(await fs.readFile(path.join(checkpoints, `${workspaceId}-${call.args.runId}.json`), "utf8"));
    }
    if (call.action === "result_get") {
      if (!validId(call.args.callId)) throw new Error("无效的结果编号。");
      const record = await journal.get(call.args.callId);
      if (!record) return { found: false };
      return record.state === "completed" ? { found: true, ...record.result } : { found: true, ok: false, uncertain: true, outcome: "unknown", output: "上次进程在完成记录前退出；操作可能已经执行，不会再次执行。" };
    }
    return workspace.execute(call.action, call.args || {}, { signal });
  }
  async function perform(call, signal) {
    if (call.workspaceId !== workspaceId || !validId(call.callId)) throw new Error("调用不属于当前工作区。");
    const fingerprint = sha256(JSON.stringify({ workspaceId, action: call.action, args: call.args }));
    const started = await journal.begin(call.callId, fingerprint);
    if (!started.created) {
      if (started.record?.fingerprint !== fingerprint) return { callId: call.callId, ok: false, outcome: "not_executed", output: "重复调用编号的参数不一致，已拒绝执行。" };
      if (started.record.state === "completed") return started.record.result;
      const result = { callId: call.callId, ok: false, uncertain: true, outcome: "unknown", output: "上次执行没有可靠的完成记录；可能已产生副作用，已阻止自动重跑，请在本机核对。" };
      await journal.finish(started.record, result); return result;
    }
    let result;
    try {
      const value = await executeNew(call, signal);
      // 非零退出码只说明命令失败，不能证明它没改文件；已执行失败也必须进入防重账本。
      result = { callId: call.callId, ok: value?.exitCode === undefined || value.exitCode === 0 && !value.stopped, uncertain: value?.stopped === true, outcome: value?.stopped === true ? "unknown" : "executed", output: JSON.stringify(value) };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_BODY - 2048) throw new Error("本地结果超过传输上限，请缩小查询范围。");
    } catch (error) {
      // 宿主机异常包含绝对路径。已知错误仅返回稳定说明，不把路径或凭据送上云。
      const uncertain = error.outcome === "unknown" || signal?.aborted === true || ["write", "patch", "exec"].includes(call.action) && !error.code?.startsWith("LOCAL_");
      result = { callId: call.callId, ok: false, uncertain, outcome: uncertain ? "unknown" : "not_executed", output: error.code?.startsWith("LOCAL_") || error.code === "ABORTED" ? error.message : "本地操作未完成，请检查参数、文件状态或本机执行器。" };
    }
    await journal.finish(started.record, result); return result;
  }
  function execute(call) {
    const existing = active.get(call.callId);
    const fingerprint = sha256(JSON.stringify(call));
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.resolve({ callId: call.callId, ok: false, outcome: "not_executed", output: "重复调用编号的参数不一致，已拒绝执行。" });
    const controller = new AbortController();
    const checkpoint = ["context_save", "context_load"].includes(call.action), internal = checkpoint || call.action === "result_get";
    // 同一工作区的项目操作串行：Docker 内创建链接/改文件不能与宿主机文件校验交错。
    // 云端保存超时后，旧context_save仍可能在落盘；独立队列禁止旧快照晚提交覆盖新快照。
    const operation = checkpoint ? checkpointQueue.then(() => perform(call, controller.signal)) : internal ? perform(call, controller.signal) : workspaceQueue.then(() => perform(call, controller.signal));
    if (checkpoint) checkpointQueue = operation.catch(() => {});
    if (!internal) workspaceQueue = operation.catch(() => {});
    const promise = operation.finally(() => active.delete(call.callId));
    active.set(call.callId, { controller, promise, fingerprint }); return promise;
  }
  return { description, execute, activeIds: () => [...active.keys()], cancel: callId => active.get(callId)?.controller.abort(), stop: () => { for (const entry of active.values()) entry.controller.abort(); } };
}
export async function runConnected(config, { signal, onStatus = () => {}, fetchImpl = fetch } = {}) {
  const executor = await createExecutor(config), api = createApi(config.server, config.bearer, { allowHttpLocalhost: config.allowHttpLocalhost, fetchImpl });
  const pending = new Map(); let registered = false;
  signal?.addEventListener("abort", executor.stop, { once: true });
  try {
    while (!signal?.aborted) {
      try {
        if (!registered) { await api("/runner/register", { workspaces: [executor.description] }, signal); registered = true; onStatus("connected", executor.description); }
        for (const [callId, result] of pending) { await api("/runner/results", result, signal); pending.delete(callId); }
        const response = await api("/runner/poll", { active: executor.activeIds() }, signal);
        for (const callId of response.cancel || []) executor.cancel(callId);
        for (const call of response.calls || []) {
          // 命令运行期间继续长轮询，接收取消；断线恢复重复投递由本地 journal 防重。
          executor.execute(call).then(async result => { pending.set(call.callId, result); try { await api("/runner/results", result, signal); pending.delete(call.callId); } catch { /* 本地 journal 已保存；等待连接恢复回传。 */ } }, () => pending.set(call.callId, { callId: call.callId, ok: false, uncertain: true, outcome: "unknown", output: "本机执行日志不可用，已停止此调用，请检查本机存储。" }));
        }
      } catch (error) {
        if (signal?.aborted) break;
        if (error.status === 401 || error.status === 403) { executor.stop(); throw new Error("设备授权已失效；请重新配对。本次本机操作不会自动重跑。"); }
        registered = false; onStatus("offline"); await delay(2500, signal);
      }
    }
  } finally { executor.stop(); signal?.removeEventListener("abort", executor.stop); }
}
