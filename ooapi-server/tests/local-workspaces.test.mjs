import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { inflateRawSync } from "node:zlib";
process.env.JWT_SECRET = "local-workspace-synthetic-test-secret";
const { createLocalWorkspaceService } = await import("../src/services/harness/local-workspaces.js");
const { localWorkspaceRouter } = await import("../src/routes/local-workspaces.js");
const { runConnected, createApi } = await import("../../ooapi-companion/runner.mjs");
const { signToken } = await import("../src/middleware/auth.js");
const { pool } = await import("../src/db.js");

function fixture(options = {}) {
  const devices = new Map(), workspaces = new Map(), sessions = new Map([["session-own", 11], ["session-other", 22]]), bindings = new Map(), runs = new Map(), writes = [];
  const db = { query: async (sql, args) => {
    assert.equal((sql.match(/\?/g) || []).length, args.length, "SQL参数个数一致");
    if (sql.startsWith("INSERT INTO local_devices")) { writes.push(args); devices.set(args[0], { id: args[0], user_id: args[1], token_hash: args[2], status: 1 }); return [{ affectedRows: 1 }]; }
    if (sql.startsWith("SELECT d.id")) return [[...devices.values()].filter(d => d.token_hash === args[0] && d.status === 1)];
    if (sql.startsWith("SELECT id FROM local_devices")) return [[...devices.values()].filter(d => d.id === args[0] && d.user_id === args[1] && d.status === 1)];
    if (sql.startsWith("SELECT id,device_id")) return [[...workspaces.values()].filter(w => w.id === args[0])];
    if (sql.startsWith("INSERT INTO local_workspaces")) { writes.push(args); workspaces.set(args[0], { id: args[0], device_id: args[1], user_id: args[2] }); return [{ affectedRows: 1 }]; }
    if (sql.startsWith("UPDATE local_devices SET last_seen_at")) return [{ affectedRows: 1 }];
    if (sql.startsWith("SELECT id FROM chat_sessions")) return [sessions.get(args[0]) === args[1] ? [{ id: args[0] }] : []];
    if (sql.startsWith("SELECT status FROM chat_agent_runs")) return [runs.has(args[0]) ? [{ status: runs.get(args[0]) }] : []];
    if (sql.startsWith("INSERT INTO local_session_workspaces")) { writes.push(args); bindings.set(args[0], { user_id: args[1], workspace_id: args[2] }); return [{ affectedRows: 1 }]; }
    if (sql.startsWith("DELETE FROM local_session_workspaces")) { bindings.delete(args[0]); return [{ affectedRows: 1 }]; }
    if (sql.startsWith("SELECT w.id,w.device_id FROM local_session_workspaces")) { const b = bindings.get(args[0]), w = workspaces.get(b?.workspace_id); return [b?.user_id === args[1] && w?.user_id === args[2] && devices.get(w?.device_id)?.status === 1 ? [w] : []]; }
    if (sql.startsWith("SELECT w.id,w.device_id FROM local_workspaces")) return [[...workspaces.values()].filter(w => (args.length === 1 ? w.user_id === args[0] : w.id === args[0] && w.user_id === args[1]) && devices.get(w.device_id)?.status === 1)];
    if (sql.startsWith("UPDATE local_devices SET status")) { const d = devices.get(args[0]); if (d?.user_id === args[1]) d.status = 0; return [{ affectedRows: 1 }]; }
    throw new Error("Unexpected query");
  } };
  const service = createLocalWorkspaceService({ db, pollMs: 5, ...options });
  return { service, writes, devices, runs };
}
async function paired(f, capabilities = { read: true, write: true, exec: false, docker: false }) {
  const pair = await f.service.startPairing(); await f.service.confirmPairing(11, pair.code);
  const device = await f.service.deviceFromBearer(pair.bearer), workspaceId = crypto.randomUUID();
  await f.service.register(device, [{ id: workspaceId, label: "测试项目", capabilities }]);
  await f.service.bind(11, "session-own", workspaceId); return { pair, device, workspaceId };
}
test("配对短码一次性、token只存哈希、路径/工具结果不落云DB", async () => {
  const f = fixture(), { pair, device } = await paired(f);
  assert.equal(device.user_id, 11); assert.ok(!JSON.stringify(f.writes).includes(pair.bearer)); assert.ok(f.writes[0][2].match(/^[a-f0-9]{64}$/));
  await assert.rejects(f.service.confirmPairing(22, pair.code), /无效|过期/);
  const run = f.service.run("read", { path: "private-relative-file.js" }, { userId: 11, sessionId: "session-own", callId: crypto.randomUUID() });
  const poll = await f.service.poll(device); assert.equal(poll.calls.length, 1);
  f.service.result(device, { callId: poll.calls[0].callId, ok: true, output: "private-file-result" });
  assert.equal((await run).output, "private-file-result");
  assert.ok(!JSON.stringify(f.writes).includes("private-relative-file")); assert.ok(!JSON.stringify(f.writes).includes("private-file-result"));
});
test("工作区仅属于配对用户，管理员身份不会突破本机授权", async () => {
  const f = fixture(), { workspaceId } = await paired(f, { read: true, write: false, exec: false });
  const deviceId = (await f.service.list(11))[0].deviceId;
  await assert.rejects(f.service.revoke(22, deviceId), /不属于当前用户/);
  assert.equal((await f.service.list(11))[0].online, true);
  await assert.rejects(f.service.bind(22, "session-other", workspaceId), /不属于当前用户/);
  await assert.rejects(f.service.bind(11, "session-other", workspaceId), /对话不存在/);
  assert.equal(await f.service.get(22, "session-own"), null);
  await assert.rejects(f.service.run("read", { path: "file" }, { userId: 11, sessionId: "session-own", expectedWorkspaceId: crypto.randomUUID() }), error => error.code === "LOCAL_CONTEXT_MISSING" && error.outcome === "not_executed");
  for (const status of ["running", "paused", "waiting_local", "interrupted"]) { f.runs.set("session-own", status); await assert.rejects(f.service.bind(11, "session-own", null), /未完成任务/); }
  f.runs.delete("session-own");
  const denied = await f.service.run("write", { path: "file", content: "bad", expectedSha256: null }, { userId: 11, sessionId: "session-own" }); assert.equal(denied.ok, false); assert.match(denied.output, /本机未授权/);
  const exec = await f.service.run("exec", { command: "must-not-run" }, { userId: 11, sessionId: "session-own" }); assert.equal(exec.ok, false); assert.match(exec.output, /Docker/);
});

test("投递前本机撤销写权限不能再发送旧写入请求", async () => {
  const f = fixture(), { device, workspaceId } = await paired(f);
  const running = f.service.run("write", { path: "file", content: "must-not-dispatch", expectedSha256: null }, { userId: 11, sessionId: "session-own", expectedWorkspaceId: workspaceId });
  await new Promise(r => setTimeout(r, 0));
  await f.service.register(device, [{ id: workspaceId, label: "测试项目", capabilities: { read: true, write: false } }]);
  assert.deepEqual((await f.service.poll(device)).calls, []);
  assert.equal((await running).meta.outcome, "not_executed");
});
test("离线等待可中断；已投递调用不得切换根关联，跨设备不能回传结果", async () => {
  const f = fixture({ now: () => 1000000 }), { device, workspaceId } = await paired(f), ctrl = new AbortController();
  const run = f.service.run("write", { path: "file", content: "x", expectedSha256: null }, { userId: 11, sessionId: "session-own", signal: ctrl.signal });
  await new Promise(r => setTimeout(r, 0));
  await assert.rejects(f.service.bind(11, "session-own", null), /先停止/);
  const poll = await f.service.poll(device); const callId = poll.calls[0].callId;
  assert.throws(() => f.service.result({ id: "other-device", user_id: 22 }, { callId, output: "bad" }), /不属于/);
  ctrl.abort(); await assert.rejects(run, { code: "ABORTED" });
  assert.ok((await f.service.poll(device)).cancel.includes(callId));
  assert.equal((await f.service.get(11, "session-own")).id, workspaceId);
});
test("本地检查点可承载原始上下文而云库只记录关联，设备撤销立即终止", async () => {
  const f = fixture(), { device } = await paired(f);
  const state = { runId: crypto.randomUUID(), messages: [{ content: "private-checkpoint-code" }], pending: { content: "private-write" } };
  const saving = f.service.run("context_save", { runId: state.runId, state }, { userId: 11, sessionId: "session-own" });
  const poll = await f.service.poll(device); assert.deepEqual(poll.calls[0].args.state, state);
  f.service.result(device, { callId: poll.calls[0].callId, ok: true, output: JSON.stringify({ ref: state.runId }) }); assert.equal((await saving).ok, true);
  assert.ok(!JSON.stringify(f.writes).includes("private-checkpoint"));
  const pending = f.service.run("read", { path: "something" }, { userId: 11, sessionId: "session-own" }); await new Promise(r => setTimeout(r, 0));
  await f.service.revoke(11, device.id); assert.equal((await pending).ok, false); assert.equal(await f.service.get(11, "session-own"), null);
});
test("未派发与已派发超时明确区分；离线检查点立即等待，不重复写", async () => {
  let clock = 1000000;
  const f = fixture({ now: () => clock }), { device } = await paired(f);
  const notOffered = f.service.run("write", { path: "file", content: "one", expectedSha256: null }, { userId: 11, sessionId: "session-own", timeoutMs: 5 });
  await assert.rejects(notOffered, error => error.code === "WAITING_LOCAL" && error.outcome === "not_executed");
  const offered = f.service.run("exec", { command: "no-running-in-test" }, { userId: 11, sessionId: "session-own", timeoutMs: 5 });
  assert.equal((await offered).ok, false, "没有Docker时命令在投递前拒绝");
  const dispatched = f.service.run("write", { path: "file", content: "one", expectedSha256: null }, { userId: 11, sessionId: "session-own", timeoutMs: 10 });
  const unknown = assert.rejects(dispatched, error => error.code === "LOCAL_OUTCOME_UNKNOWN" && error.outcome === "unknown");
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await f.service.poll(device)).calls.length, 1);
  await unknown;
  clock += 60000;
  const started = Date.now();
  await assert.rejects(f.service.run("context_load", { runId: crypto.randomUUID() }, { userId: 11, sessionId: "session-own" }), error => error.code === "WAITING_LOCAL" && error.outcome === "not_executed");
  assert.ok(Date.now() - started < 100);
});

test("失败命令已执行状态透传，旧runner未知副作用按unknown保守处理", async () => {
  const f = fixture(), { device } = await paired(f, { read: true, write: true, exec: true, docker: true });
  for (const [outcome, expected] of [["executed", "executed"], ["not_executed", "not_executed"], ["invalid", "unknown"]]) {
    const running = f.service.run("exec", { command: "test-only" }, { userId: 11, sessionId: "session-own" });
    const { calls } = await f.service.poll(device);
    f.service.result(device, { callId: calls[0].callId, ok: false, outcome, output: "exit7" });
    const result = await running; assert.equal(result.meta.outcome, expected); assert.equal(result.meta.uncertain, expected === "unknown");
  }
});
test("真实HTTP/本机执行器配对、读写、patch、断线重连日志防重、源码ZIP可用", async t => {
  const f = fixture({ pollMs: 20 }), directory = await fs.mkdtemp(path.join(os.tmpdir(), "ooapi-runner-http-test-"));
  const root = path.join(directory, "root"), stateDirectory = path.join(directory, "state"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "source.js"), "const count = 1;\n");
  const originalQuery = pool.query;
  pool.query = async (sql, args) => { assert.equal(sql, "SELECT * FROM users WHERE id = ?"); return [[{ id: Number(args[0]), role: 1, status: 1, token_version: 0 }]]; };
  const app = express(); app.use("/api/local-workspaces", localWorkspaceRouter(f.service));
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}`, userToken = signToken({ id: 11, role: 1, token_version: 0 });
  let ctrl = new AbortController(), connected;
  t.after(async () => { ctrl.abort(); await connected?.catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); pool.query = originalQuery; assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const publicApi = createApi(origin, null, { allowHttpLocalhost: true }), pair = await publicApi("/pair/start");
  async function web(endpoint, body, method = "POST") { const response = await fetch(origin + "/api/local-workspaces" + endpoint, { method, headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; }
  assert.equal((await web("/pair/confirm", { code: pair.code })).status, 200);
  const runnerApi = createApi(origin, pair.bearer, { allowHttpLocalhost: true }); assert.equal((await runnerApi("/runner/status")).paired, true);
  const workspaceId = crypto.randomUUID(), config = { server: origin, bearer: pair.bearer, workspaceId, root, stateDirectory, allowWrite: true, allowHttpLocalhost: true };
  let resolveReady; const ready = new Promise(r => resolveReady = r);
  connected = runConnected(config, { signal: ctrl.signal, onStatus: status => { if (status === "connected") resolveReady(); } }); await ready;
  const listing = await web("/workspaces", undefined, "GET"); assert.equal(listing.value.data.workspaces[0].id, workspaceId); assert.equal(listing.value.data.workspaces[0].capabilities.exec, false);
  assert.equal((await web("/sessions/session-own", { workspaceId }, "PUT")).status, 200);
  const read = await f.service.run("read", { path: "source.js" }, { userId: 11, sessionId: "session-own" }); assert.equal(read.ok, true); const file = JSON.parse(read.output); assert.equal(file.content, "const count = 1;\n");
  const callId = crypto.randomUUID(), args = { path: "source.js", patches: [{ find: "count = 1", replace: "count = 0" }, { find: "count = 0", replace: "count = 2" }], expectedSha256: file.sha256 };
  const patched = await f.service.run("patch", args, { userId: 11, sessionId: "session-own", callId }); assert.equal(patched.ok, true); assert.equal(await fs.readFile(path.join(root, "source.js"), "utf8"), "const count = 2;\n");
  ctrl.abort(); await connected; ctrl = new AbortController();
  let resolveReconnected; const reconnected = new Promise(r => resolveReconnected = r);
  connected = runConnected(config, { signal: ctrl.signal, onStatus: status => { if (status === "connected") resolveReconnected(); } }); await reconnected;
  const repeated = await f.service.run("patch", args, { userId: 11, sessionId: "session-own", callId }); assert.deepEqual(repeated, patched); assert.equal(await fs.readFile(path.join(root, "source.js"), "utf8"), "const count = 2;\n");
  const savedState = { runId: crypto.randomUUID(), messages: [{ content: "private-context-http-test" }] };
  const save = await f.service.run("context_save", { runId: savedState.runId, state: savedState }, { userId: 11, sessionId: "session-own" }); assert.equal(save.ok, true);
  const load = await f.service.run("context_load", { runId: savedState.runId }, { userId: 11, sessionId: "session-own" }); assert.deepEqual(JSON.parse(load.output), savedState);
  assert.ok(!JSON.stringify(f.writes).includes("private-context-http-test"));
  const zipResponse = await fetch(origin + "/api/local-workspaces/download"), zip = Buffer.from(await zipResponse.arrayBuffer()); assert.equal(zipResponse.headers.get("content-type"), "application/zip");
  let offset = 0, zipFiles = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) { const size = zip.readUInt32LE(offset + 18), nameSize = zip.readUInt16LE(offset + 26), extraSize = zip.readUInt16LE(offset + 28), name = zip.subarray(offset + 30, offset + 30 + nameSize).toString(); const start = offset + 30 + nameSize + extraSize; const source = inflateRawSync(zip.subarray(start, start + size)).toString(); assert.ok(name.startsWith("ooapi-companion/")); assert.ok(source.length > 100); zipFiles++; offset = start + size; }
  assert.equal(zipFiles, 7);
});
