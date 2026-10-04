// 原路由+真实MySQL+真实本机运行器：历史正文临时恢复，云库始终只留引用。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { pool } from "../src/db.js";
import chatRoutes from "../src/routes/chat.js";
import localRoutes from "../src/routes/local-workspaces.js";
import { localWorkspaces, saveLocalCheckpoint } from "../src/services/harness/local-workspaces.js";
import { archiveLocalMessage } from "../src/services/harness/local-history.js";
import { persistedWorkspaceParts } from "../src/services/harness/workspace-privacy.js";
import { createSession, appendMessage, deleteSession } from "../src/services/harness/sessions.js";
import { createLongRunStore } from "../src/services/harness/long-runs.js";
import { signToken } from "../src/middleware/auth.js";
import { runConnected } from "../../ooapi-companion/runner.mjs";

if (!/^ooapi_agent_gate_[a-f0-9]{8}$/.test(process.env.DB_NAME || "") || Number(process.env.PORT) !== 4125) throw new Error("拒绝在非隔离候选环境执行。");
const [[database]] = await pool.query("SELECT DATABASE() AS name"); assert.equal(database.name, process.env.DB_NAME);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ooapi-local-history-")), root = path.join(temporary, "root"), stateDirectory = path.join(temporary, "private"); await fs.mkdir(root);
const app = express(); app.use("/api/chat", chatRoutes); app.use("/api/local-workspaces", localRoutes);
const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
const origin = `http://127.0.0.1:${server.address().port}`, ctrl = new AbortController(), store = createLongRunStore();
let connected, session, deviceId;
async function get(userId) { const response = await fetch(`${origin}/api/chat/sessions/${session.id}`, { headers: { Authorization: `Bearer ${signToken({ id: userId, role: 1, token_version: 0 })}` } }); return { status: response.status, value: await response.json() }; }
try {
  session = await createSession({ userId: 11 });
  const pairing = await localWorkspaces.startPairing(); await localWorkspaces.confirmPairing(11, pairing.code); deviceId = pairing.deviceId;
  const workspaceId = crypto.randomUUID(); let ready; const registered = new Promise(r => ready = r);
  connected = runConnected({ server: origin, bearer: pairing.bearer, workspaceId, root, stateDirectory, allowHttpLocalhost: true }, { signal: ctrl.signal, onStatus: status => { if (status === "connected") ready(); } });
  // 撤销设备时运行器会主动拒绝，先挂处理器，避免 GET 占用期间变成未处理拒绝。
  connected.catch(() => {}); await registered;
  await localWorkspaces.bind(11, session.id, workspaceId);
  const workspace = await localWorkspaces.get(11, session.id), run = await store.begin(11, session.id, { workspaceId });
  const marker = "private-history-source-" + crypto.randomBytes(6).toString("hex"), parts = [{ id: "private-text", type: "text", text: marker }, { id: "private-tool", type: "tool", tool: "local", args: { path: "synthetic-code.js" }, output: "local-private-code", status: "done" }];
  const localCtx = { userId: 11, sessionId: session.id, expectedWorkspaceId: workspaceId };
  const reference = await archiveLocalMessage({ workspace, run, segment: 0, parts, save: (ref, value) => saveLocalCheckpoint({ ...localCtx, runId: ref }, value) });
  await saveLocalCheckpoint({ ...localCtx, runId: run.id }, { runId: run.id, parts, billingSegment: 0, phase: "done" });
  await store.checkpoint(run, { phase: "done", localRef: run.id });
  await appendMessage({ sessionId: session.id, userId: 11, role: "assistant", parts: [...persistedWorkspaceParts(parts, true), reference], durableRunId: run.id, leaseOwner: run.owner, billingSegment: 0 }); await store.finish(run, "completed");
  const hydrated = await get(11); assert.equal(hydrated.status, 200); assert.equal(hydrated.value.data.messages.at(-1).parts[0].text, marker); console.log("PASS authenticated realHTTP history hydrates private archive from local runner");
  assert.equal((await get(22)).status, 404); console.log("PASS other account cannot request or hydrate this history");
  await fs.unlink(path.join(stateDirectory, "contexts", `${workspaceId}-${reference.ref}.json`));
  const fallback = await get(11); assert.equal(fallback.value.data.messages.at(-1).parts[0].text, marker); console.log("PASS missing archive falls back only to same run and matching last billing segment");
  const [messages] = await pool.query("SELECT parts FROM chat_messages WHERE session_id=?", [session.id]), [runs] = await pool.query("SELECT checkpoint,config FROM chat_agent_runs WHERE session_id=?", [session.id]);
  const cloud = JSON.stringify({ messages, runs }); for (const privateValue of [marker, "local-private-code", "synthetic-code.js", root]) assert.ok(!cloud.includes(privateValue)); console.log("PASS cloud messages/checkpoints remain blank of original paths/content after history GET");
  await localWorkspaces.revoke(11, deviceId); const offline = await get(11); assert.equal(offline.status, 200); assert.ok(!JSON.stringify(offline.value.data.messages).includes(marker)); console.log("PASS revoked local device returns cloud placeholder without private content");
  console.log("RESULT real local history HTTP/MySQL privacy and fallback gates passed; synthetic content only.");
} finally {
  ctrl.abort(); await connected?.catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r));
  if (session) { await pool.query("DELETE FROM chat_agent_tasks WHERE session_id=?", [session.id]); await pool.query("DELETE FROM chat_agent_runs WHERE session_id=?", [session.id]); await deleteSession(11, session.id); }
  if (deviceId) { await pool.query("DELETE FROM local_workspaces WHERE device_id=?", [deviceId]); await pool.query("DELETE FROM local_devices WHERE id=?", [deviceId]); }
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(temporary, { recursive: true, force: true }); await pool.end();
}
