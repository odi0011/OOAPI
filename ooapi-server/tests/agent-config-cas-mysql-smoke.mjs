// 隔离库中的真实 HTTP 并发前提核对；绝不能指向生产数据库。
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
import { priceSnapshot } from "../src/services/config-precondition.js";

const BASE = process.env.BASE || "http://127.0.0.1:4125";
if (!/^ooapi_agent_gate_[a-f0-9]{8}$/.test(process.env.DB_NAME || "") || BASE !== "http://127.0.0.1:4125") throw new Error("拒绝在非隔离候选环境执行。");
const [[database]] = await pool.query("SELECT DATABASE() AS name"); assert.equal(database.name, process.env.DB_NAME);
const suffix = crypto.randomBytes(6).toString("hex"), model = "ooapi-config-cas-" + suffix, now = Math.floor(Date.now() / 1000);
let userId, channelId;
async function request(id, path, body) {
  const token = signToken({ id, role: id === 99 ? 1000 : 1, token_version: 0 });
  const response = await fetch(BASE + path, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, value: await response.json() };
}
try {
  const [channel] = await pool.query("INSERT INTO channels (name,type,models,status,other,created_time) VALUES (?,'openai',?,1,?,?)", ["isolated-config-cas-" + suffix, model, JSON.stringify({ method: "api" }), now]); channelId = channel.insertId;
  const rule = { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"]] };
  await pool.query("INSERT INTO model_prices (model,input_price,output_price,cache_price,offpeak_input_price,offpeak_output_price,offpeak_cache_price,offpeak_rule,channel_type,remark,updated_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [model, 1, 2, 0.15, 0.5, 1, 0.075, JSON.stringify(rule), "openai", "must preserve unrelated fields", now]);
  const [[original]] = await pool.query("SELECT * FROM model_prices WHERE model=?", [model]), expected = priceSnapshot(original);
  const prices = await Promise.all([request(99, "/api/pricing", { ...expected, input_price: 3, _internal_expected: expected }), request(99, "/api/pricing", { ...expected, input_price: 4, _internal_expected: expected })]);
  assert.deepEqual(prices.map(r => r.status).sort(), [200, 409]);
  const [[updated]] = await pool.query("SELECT * FROM model_prices WHERE model=?", [model]), actual = priceSnapshot(updated);
  assert.ok([3, 4].includes(actual.input_price)); assert.deepEqual({ ...actual, input_price: expected.input_price }, expected);
  console.log("PASS pricing 同一快照真实HTTP并发只有一个200、另一个409；缓存/错峰/说明/输出价不丢失");
  const setting = { theme: "fixture", appearance: { font: "normal" }, unrelated: { keep: true } };
  const [user] = await pool.query("INSERT INTO users (username,password,display_name,role,status,quota,setting,created_time) VALUES (?,?,?,1,1,0,?,?)", ["isolated_cas_" + suffix, "!disabled-fixture-login!", "CAS隔离用户", JSON.stringify(setting), now]); userId = user.insertId;
  const settings = await Promise.all([request(userId, "/api/users/self/settings", { _internal_setting: { ...setting, theme: "a" }, _internal_expected: setting }), request(userId, "/api/users/self/settings", { _internal_setting: { ...setting, theme: "b" }, _internal_expected: setting })]);
  assert.deepEqual(settings.map(r => r.status).sort(), [200, 409]);
  const [[saved]] = await pool.query("SELECT setting FROM users WHERE id=?", [userId]), final = JSON.parse(saved.setting);
  assert.ok(["a", "b"].includes(final.theme)); assert.deepEqual({ ...final, theme: setting.theme }, setting);
  console.log("PASS settings 同一快照真实HTTP并发只有一个200、另一个409；嵌套无关偏好保留");
  console.log("RESULT real MySQL/HTTP configuration CAS gates passed; isolated fixtures only.");
} finally {
  if (channelId) { await pool.query("DELETE FROM channels WHERE id=?", [channelId]); await pool.query("DELETE FROM model_prices WHERE model=?", [model]); await pool.query("DELETE FROM logs WHERE user_id=99 AND created_at>=? AND content=?", [now, `保存模型定价「${model}」`]); }
  if (userId) await pool.query("DELETE FROM users WHERE id=?", [userId]);
  await pool.end();
}
