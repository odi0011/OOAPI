// 临时暴露原路由私有结算函数，真实 MySQL 验证同段恢复防重与预占退回。
// 不改生产源码，不调用上游；随机候选库以外直接拒绝。
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "../src/db.js";
import { createSession, deleteSession } from "../src/services/harness/sessions.js";
import { createLongRunStore } from "../src/services/harness/long-runs.js";
import { holdTokenQuota } from "../src/services/token-quota.js";

if (!/^ooapi_agent_gate_[a-f0-9]{8}$/.test(process.env.DB_NAME || "") || Number(process.env.PORT) !== 4125) throw new Error("拒绝在非隔离候选环境执行。");
const [[database]] = await pool.query("SELECT DATABASE() AS name"); assert.equal(database.name, process.env.DB_NAME);
const suffix = crypto.randomBytes(6).toString("hex"), model = "ooapi-billing-cas-" + suffix, at = Math.floor(Date.now() / 1000), originalQuota = 1000000;
const routeFile = fileURLToPath(new URL("../src/routes/chat.js", import.meta.url));
const exposedFile = fileURLToPath(new URL(`../src/routes/.candidate-billing-${suffix}.mjs`, import.meta.url));
const store = createLongRunStore(); let userId, keyId, session, run;
try {
  await fs.writeFile(exposedFile, await fs.readFile(routeFile, "utf8") + "\nexport { chargeUser };\n", { flag: "wx", mode: 0o600 });
  const { chargeUser } = await import(pathToFileURL(exposedFile).href); await fs.unlink(exposedFile);
  const [user] = await pool.query("INSERT INTO users (username,password,display_name,role,status,quota,created_time) VALUES (?,?,?,1,1,?,?)", ["isolated_bill_" + suffix, "!disabled-fixture-login!", "结算隔离用户", originalQuota, at]); userId = user.insertId;
  const [key] = await pool.query("INSERT INTO tokens (user_id,name,key_str,status,unlimited_quota,remain_quota,created_time) VALUES (?,?,?,1,0,?,?)", [userId, "isolated-billing", "sk-" + crypto.randomBytes(24).toString("hex"), originalQuota, at]); keyId = key.insertId;
  await pool.query("INSERT INTO model_prices (model,input_price,output_price,cache_price,channel_type,updated_time) VALUES (?,2,3,0.2,'openai',?)", [model, at]);
  session = await createSession({ userId }); run = await store.begin(userId, session.id, { model });
  const keyInfo = { id: keyId, unlimited_quota: 0 }, requestId = `bill:${run.id}:0`;
  const args = { user: { id: userId, username: "isolated_bill_" + suffix }, model, prompt: "synthetic", output: "synthetic", tokens: { promptTokens: 20000, completionTokens: 10000, cacheTokens: 0 }, kind: "隔离结算测试", keyId, sessionId: session.id, sensitive: true, requestId, billingRunId: run.id, billingSegment: 0, leaseOwner: run.owner };
  async function balance() {
    const [[account]] = await pool.query("SELECT quota,used_quota,request_count FROM users WHERE id=?", [userId]);
    const [[token]] = await pool.query("SELECT remain_quota,used_quota FROM tokens WHERE id=?", [keyId]);
    const [[logs]] = await pool.query("SELECT COUNT(*) AS n FROM logs WHERE user_id=? AND request_id=? AND is_usage=1", [userId, requestId]);
    return { account, token, logs: Number(logs.n) };
  }
  const firstHold = await holdTokenQuota(keyInfo); assert.equal(firstHold.ok, true);
  const first = await chargeUser({ ...args, tokenQuotaHold: firstHold.amount }); firstHold.consume(); await firstHold.refund();
  assert.ok(first.units > 0); const billed = await balance(), persistedDetails = JSON.parse(JSON.stringify(first.billingDetails));
  assert.deepEqual(billed, { account: { quota: originalQuota - first.units, used_quota: first.units, request_count: 1 }, token: { remain_quota: originalQuota - first.units, used_quota: first.units }, logs: 1 });
  console.log("PASS 原chargeUser真实MySQL首段结算：账户/令牌/日志一致且预占仅还一次");
  const altered = { ...args, tokens: { promptTokens: 70000, completionTokens: 20000, cacheTokens: 0 } };
  const retryHold = await holdTokenQuota(keyInfo), reused = await chargeUser({ ...altered, tokenQuotaHold: retryHold.amount }); retryHold.consume(); await retryHold.refund();
  assert.equal(reused.logId, first.logId); assert.equal(reused.units, first.units); assert.deepEqual(reused.billingDetails, persistedDetails); assert.deepEqual(await balance(), billed);
  console.log("PASS 不同usage恢复仍返回旧账单真实明细并退回新预占；没有第二次扣费/用量/日志");
  const holds = await Promise.all([holdTokenQuota(keyInfo), holdTokenQuota(keyInfo)]);
  const concurrent = await Promise.all(holds.map(hold => chargeUser({ ...args, tokenQuotaHold: hold.amount })));
  holds.forEach(hold => hold.consume()); await Promise.all(holds.map(hold => hold.refund()));
  assert.ok(concurrent.every(value => value.logId === first.logId)); assert.deepEqual(await balance(), billed);
  console.log("PASS 真实FOR UPDATE并发恢复串行复用同日志，两份预占都退回");
  const rejectedHold = await holdTokenQuota(keyInfo);
  await assert.rejects(chargeUser({ ...args, leaseOwner: "old-owner", tokenQuotaHold: rejectedHold.amount }), error => error.code === "BILLING_FAILED" && error.cause?.code === "RUN_CHANGED");
  const afterRejected = await balance(); assert.equal(afterRejected.token.remain_quota, billed.token.remain_quota - rejectedHold.amount);
  await rejectedHold.refund(); await rejectedHold.refund(); assert.deepEqual(await balance(), billed);
  console.log("PASS 旧租约在结算行锁内拒绝，不错还预占；退出幂等退款恢复原余额");
  // 模拟 COMMIT 已落库但确认包丢失，原 SQL/真实数据库仍负责结算。
  const uncertainHold = await holdTokenQuota(keyInfo), originalGet = pool.getConnection, connection = await originalGet.call(pool), originalCommit = connection.commit;
  pool.getConnection = async () => connection; connection.commit = async function () { await originalCommit.call(this); throw new Error("synthetic-commit-ack-lost"); };
  try {
    await assert.rejects(chargeUser({ ...altered, tokenQuotaHold: uncertainHold.amount }), error => {
      assert.equal(error.code, "BILLING_UNCERTAIN"); assert.equal(error.billingResult.logId, first.logId);
      assert.deepEqual(error.billingDetails, persistedDetails); assert.deepEqual(error.billingResult.billingDetails, persistedDetails); return true;
    });
    uncertainHold.consume(); await uncertainHold.refund();
  } finally { pool.getConnection = originalGet; connection.commit = originalCommit; }
  assert.deepEqual(await balance(), billed); console.log("PASS 真COMMIT后确认丢失保留旧账单明细且不再次退款/扣费");
  const [[durable]] = await pool.query("SELECT billing_segment,bill_calls FROM chat_agent_runs WHERE id=?", [run.id]); assert.equal(durable.billing_segment, 1); assert.equal(durable.bill_calls, "[]");
  console.log("RESULT real MySQL ledger reuse/concurrency/quota gates passed; no upstream or production writes.");
} finally {
  await fs.unlink(exposedFile).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (session) { await pool.query("DELETE FROM chat_agent_tasks WHERE session_id=?", [session.id]); await pool.query("DELETE FROM chat_agent_runs WHERE session_id=?", [session.id]); await deleteSession(userId, session.id); }
  if (userId) { await pool.query("DELETE FROM logs WHERE user_id=?", [userId]); await pool.query("DELETE FROM tokens WHERE user_id=?", [userId]); await pool.query("DELETE FROM users WHERE id=?", [userId]); }
  await pool.query("DELETE FROM model_prices WHERE model=?", [model]); await pool.end();
}
