// 原对话 HTTP 路由+真实候选 MySQL+纯合成上游，验证预算/工具清单的实际执行配置。
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { pool } from "../src/db.js";
import { loadOptions } from "../src/config.js";
import chatRoutes from "../src/routes/chat.js";
import { signToken } from "../src/middleware/auth.js";
import { DEFAULT_AGENT_FLOW } from "../src/services/harness/policy.js";
import { deleteSession } from "../src/services/harness/sessions.js";

if (!/^ooapi_agent_gate_[a-f0-9]{8}$/.test(process.env.DB_NAME || "") || Number(process.env.PORT) !== 4125) throw new Error("拒绝在非隔离候选环境执行。");
const [[database]] = await pool.query("SELECT DATABASE() AS name"); assert.equal(database.name, process.env.DB_NAME);
const [[fixture]] = await pool.query("SELECT base_url FROM channels WHERE name='isolated-agent-fixture' AND status=1");
assert.equal(fixture?.base_url, "http://127.0.0.1:4135");
const [[oldFlow]] = await pool.query("SELECT value FROM options WHERE key_str='agent_flow'");
await loadOptions(); const suffix = crypto.randomBytes(6).toString("hex"), group = "ooapi-agent-isolated", sessions = [];
let userId, keyId; const app = express(); app.use("/api/chat", chatRoutes);
const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r)); const origin = `http://127.0.0.1:${server.address().port}`;
async function request(route, body, { user = userId, method = body === undefined ? "GET" : "POST" } = {}) {
  const response = await fetch(origin + "/api/chat" + route, { method, headers: { Authorization: `Bearer ${signToken({ id: user, role: user === 99 ? 1000 : 1, token_version: 0 })}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert.equal(response.status, 200, `HTTP ${route}: ${response.status}`);
  return response.headers.get("content-type")?.includes("text/event-stream") ? text : JSON.parse(text).data;
}
async function policy(maxSteps = 96, tools) {
  const flow = structuredClone(DEFAULT_AGENT_FLOW), node = flow.nodes.find(n => n.kind === "tools"); node.config.maxSteps = maxSteps;
  if (tools !== undefined) node.config.tools = tools;
  await request("/flow", flow, { user: 99, method: "PUT" });
}
async function make(settings = {}) { const session = await request("/sessions", { model: "gpt-4o-mini", settings }); sessions.push(session.id); return session; }
async function run(session, settings) {
  const sse = await request("/run", { sessionId: session.id, model: "gpt-4o-mini", keyId, text: "AGENT_POLICY_GATE_SYNTHETIC", ...(settings === undefined ? {} : { settings }) });
  assert.ok(sse.includes('"type":"start"')); assert.ok(sse.includes('"type":"done"'), "合成上游实际完成");
  const [[row]] = await pool.query("SELECT config,status FROM chat_agent_runs WHERE user_id=? AND session_id=?", [userId, session.id]);
  assert.equal(row.status, "completed"); return JSON.parse(row.config).settings;
}
try {
  const at = Math.floor(Date.now() / 1000), [user] = await pool.query("INSERT INTO users (username,password,display_name,role,status,quota,group_name,created_time) VALUES (?,?,?,1,1,1000000,?,?)", ["isolated_policy_" + suffix, "!disabled-fixture-login!", "策略隔离用户", group, at]); userId = user.insertId;
  const [key] = await pool.query("INSERT INTO tokens (user_id,name,key_str,status,unlimited_quota,group_name,created_time) VALUES (?,?,?,1,1,?,?)", [userId, "isolated-policy", "sk-" + crypto.randomBytes(24).toString("hex"), group, at]); keyId = key.insertId;
  await policy(); const meta = await request("/meta"); assert.equal(meta.defaults.maxSteps, 96); assert.equal(meta.defaults.maxStepsLimit, 96); assert.equal(meta.defaults.hardMaxStepsLimit, 256);
  const fresh = await make(); assert.equal(fresh.settings.maxSteps, 96); console.log("PASS 真实HTTP meta与新会话默认96，管理员上限96、硬上限256");
  const one = await request(`/sessions/${fresh.id}`, { settings: { maxSteps: 1 } }, { method: "PUT" }); assert.equal(one.settings.maxSteps, 1);
  assert.equal((await run(fresh)).maxSteps, 1); console.log("PASS 真实HTTP用户预算1实际落入执行config，平台96不会覆盖");
  const large = await make(), savedLarge = await request(`/sessions/${large.id}`, { settings: { maxSteps: 256 } }, { method: "PUT" }); assert.equal(savedLarge.settings.maxSteps, 256); assert.equal((await run(large)).maxSteps, 96); console.log("PASS 用户预算256可以保存，实际执行仍受管理员96上限约束");
  const legacy = await make(); await pool.query("UPDATE chat_sessions SET settings=? WHERE id=? AND user_id=?", [JSON.stringify({ maxSteps: 12 }), legacy.id, userId]);
  assert.equal((await request(`/sessions/${legacy.id}`)).session.settings.maxSteps, 12); assert.equal((await run(legacy)).maxSteps, 12); console.log("PASS 旧会话存量12读取与实际执行均保留");
  const hidden = await make({ tools: [], maxSteps: 1 }); assert.ok((await run(hidden)).tools.length > 0); console.log("PASS 旧会话隐藏空工具开关不屏蔽现有平台能力");
  await policy(3, ["account"]); const restricted = await make({ maxSteps: 256 });
  const settings = await run(restricted, { tools: ["account", "pricing"], maxSteps: 256 }); assert.equal(settings.maxSteps, 3); assert.deepEqual(settings.tools, ["account"]); console.log("PASS 管理员预算3/仅account后，用户要求256/pricing无法扩大实际权限");
  const empty = await make({ maxSteps: 2 }); assert.deepEqual((await run(empty, { tools: [] })).tools, []); console.log("PASS 本次显式空工具清单可进一步收窄，执行器实际无工具");
  console.log("RESULT real HTTP/MySQL/synthetic upstream session budget and tool policy gates passed.");
} finally {
  server.closeAllConnections(); await new Promise(r => server.close(r));
  if (oldFlow) await pool.query("UPDATE options SET value=? WHERE key_str='agent_flow'", [oldFlow.value]); else await pool.query("DELETE FROM options WHERE key_str='agent_flow'");
  for (const id of sessions) { await pool.query("DELETE FROM chat_agent_tasks WHERE session_id=?", [id]); await pool.query("DELETE FROM chat_agent_runs WHERE session_id=?", [id]); await deleteSession(userId, id); }
  if (userId) { await pool.query("DELETE FROM logs WHERE user_id=?", [userId]); await pool.query("DELETE FROM tokens WHERE user_id=?", [userId]); await pool.query("DELETE FROM users WHERE id=?", [userId]); }
  await pool.end();
}
