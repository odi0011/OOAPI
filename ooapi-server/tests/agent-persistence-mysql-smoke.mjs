// 仅用于随机命名的独立候选库；不访问收费模型、生产数据或真实账号。
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pool, migrate } from "../src/db.js";
import { createSession, deleteSession } from "../src/services/harness/sessions.js";
import { createLongRunStore } from "../src/services/harness/long-runs.js";
import { signToken } from "../src/middleware/auth.js";

const BASE = process.env.BASE || "http://127.0.0.1:4125";
if (!/^ooapi_agent_gate_[a-f0-9]{8}$/.test(process.env.DB_NAME || "") || BASE !== "http://127.0.0.1:4125") throw new Error("拒绝在非隔离候选环境执行。");
const [[database]] = await pool.query("SELECT DATABASE() AS name"); assert.equal(database.name, process.env.DB_NAME);
const sessions = [], store = createLongRunStore(); let passed = 0;
const check = (condition, label) => { assert.ok(condition, label); passed++; console.log("PASS " + label); };
const token = id => signToken({ id, role: 1, token_version: 0 });
async function api(userId, endpoint, body, method = "GET") {
  const response = await fetch(BASE + endpoint, { method, headers: { Authorization: `Bearer ${token(userId)}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); return { status: response.status, value };
}
try {
  await migrate(); await migrate();
  for (const table of ["chat_agent_runs", "chat_agent_tasks"]) { const [rows] = await pool.query("SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=?", [table]); check(rows.length > 3, table + " 建表/重复迁移可用"); }
  const session = await createSession({ userId: 11 }); sessions.push(session.id);
  const begin = await Promise.allSettled([store.begin(11, session.id, { model: "fixture-no-model-call" }), store.begin(11, session.id, { model: "fixture-no-model-call" })]);
  check(begin.filter(r => r.status === "fulfilled").length === 1 && begin.filter(r => r.status === "rejected" && r.reason.code === "RUN_PENDING").length === 1, "真实MySQL FOR UPDATE 并发begin只有一个执行租约");
  let run = begin.find(r => r.status === "fulfilled").value;
  await store.checkpoint(run, { phase: "planned", budget: { usedSteps: 3 } }); check((await store.get(11, session.id)).version === 1, "检查点版本递增/真实JSON落库");
  check(await store.get(22, session.id) === null, "其他用户不能读取持久运行");
  await store.heartbeat(run);
  const task = { id: crypto.randomUUID(), agentId: "explore", status: "planned", label: "隔离子任务", checkpoint: { phase: "task-planned" } };
  await store.saveTask(11, session.id, run.id, task, run.owner); check((await store.tasks(11, session.id, run.id)).length === 1, "子任务checkpoint由真实有效owner写入");
  await assert.rejects(store.saveTask(11, session.id, run.id, { ...task, status: "completed" }, "not-owner"), { code: "RUN_CHANGED" }); passed++; console.log("PASS 错owner不能保存子任务");
  const originalOwner = { ...run };
  await store.finish(run, "paused"); const claims = await Promise.allSettled([store.claim(11, session.id), store.claim(11, session.id)]);
  check(claims.filter(r => r.status === "fulfilled").length === 1 && claims.filter(r => r.status === "rejected" && r.reason.code === "RUN_NOT_RESUMABLE").length === 1, "真实MySQL并发恢复只有一个新租约"); run = claims.find(r => r.status === "fulfilled").value;
  await assert.rejects(store.checkpoint(originalOwner, { phase: "stale" }), { code: "RUN_CHANGED" }); passed++; console.log("PASS 旧owner不能覆盖恢复后的checkpoint");
  await assert.rejects(store.heartbeat(originalOwner), { code: "RUN_CHANGED" }); passed++; console.log("PASS 旧owner不能续租");
  await store.checkpoint(run, { phase: "updated" }); const staleVersion = { ...run };
  await store.checkpoint(run, { phase: "newer" });
  let versionBlocked = false; try { await store.checkpoint(staleVersion, { phase: "stale-same-owner" }); } catch (error) { versionBlocked = error.code === "RUN_CHANGED"; }
  check(versionBlocked, "同owner旧version被真实SQL CAS拒绝");
  await pool.query("UPDATE chat_agent_runs SET lease_until = 0 WHERE id=?", [run.id]); check((await store.get(11, session.id)).status === "interrupted", "过期租约显示interrupted而不是已完成"); run = await store.claim(11, session.id);
  const status = await api(11, `/api/chat/sessions/${session.id}/work`); check(status.status === 200 && status.value.data.run.id === run.id, "真实HTTP work状态读取");
  check((await api(22, `/api/chat/sessions/${session.id}/work`)).status === 404, "真实HTTP跨用户work拒绝");
  check((await api(11, `/api/chat/sessions/${session.id}/pause`, {}, "POST")).status === 409, "没有内存执行器时pause不伪装成功");
  await store.finish(run, "paused"); check((await api(11, `/api/chat/sessions/${session.id}/message`, { message: "用户主动提供的隔离补充说明" }, "POST")).status === 200, "暂停后的主动补充说明持久化");
  check((await store.get(11, session.id)).config.inbox.includes("用户主动提供的隔离补充说明"), "恢复前inbox真实保存");
  check((await api(11, `/api/chat/sessions/${session.id}/stop`, {}, "POST")).status === 200, "真实HTTP停止未完成持久任务");
  check((await store.get(11, session.id)).status === "stopped", "停止状态保存"); await assert.rejects(store.claim(11, session.id), { code: "RUN_NOT_RESUMABLE" }); passed++; console.log("PASS stopped任务不能继续");
  const meta = JSON.parse(await fs.readFile(".candidate-meta.json", "utf8")); let unchanged = true;
  for (const [name, previous] of Object.entries(meta.protectedHashes)) { const bytes = await fs.readFile("/opt/ooapi/ooapi-server/" + name).catch(e => { if (e.code === "ENOENT") return null; throw e; }); unchanged &&= (bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : null) === previous; }
  check(unchanged, "生产受保护配置摘要不变");
  console.log(`RESULT ${passed} assertions passed; same-owner CAS=${versionBlocked ? "enforced" : "runtime-serialized-only"}; no model/upstream or production writes.`);
} finally {
  for (const sessionId of sessions) { await pool.query("DELETE FROM chat_agent_tasks WHERE session_id=?", [sessionId]); await pool.query("DELETE FROM chat_agent_runs WHERE session_id=?", [sessionId]); await deleteSession(11, sessionId); }
  await pool.end();
}
