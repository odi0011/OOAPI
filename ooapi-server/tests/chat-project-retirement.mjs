// 真实隔离数据库：模拟旧项目绑定，验证升级只删除分类元数据。
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool, migrate } from "../src/db.js";
import { listSessions, sessionCounts, getSessionMessages, batchSessions } from "../src/services/harness/sessions.js";

let userId;
const suffix = crypto.randomBytes(6).toString("hex");
const ids = [`retire${suffix}a`, `retire${suffix}b`];
try {
  assert.equal(process.env.DB_HOST, "127.0.0.1");
  const [[db]] = await pool.query("SELECT DATABASE() AS name, @@sql_mode AS mode");
  assert.match(db.name, /^ooapi_agent_gate_[a-f0-9]{8}$/, "Only a dedicated candidate database may be altered");
  assert.ok(db.mode.includes("ONLY_FULL_GROUP_BY"));
  await migrate();
  const [[fresh]] = await pool.query("SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'chat_sessions' AND column_name = 'project_id'");
  assert.equal(Number(fresh.c), 0);
  await pool.query("CREATE TABLE chat_projects (id VARCHAR(32) PRIMARY KEY, user_id INT, name VARCHAR(64))");
  await pool.query("ALTER TABLE chat_sessions ADD COLUMN project_id VARCHAR(32) NOT NULL DEFAULT ''");
  const [user] = await pool.query("INSERT INTO users (username,password,role,status) VALUES (?, ?, 1, 1)", [`retire_${suffix}`, "!disabled-fixture-login!"]);
  userId = user.insertId;
  await pool.query("INSERT INTO chat_projects (id,user_id,name) VALUES (?, ?, ?)", [suffix, userId, "旧分类"]);
  for (const [index, id] of ids.entries()) {
    await pool.query("INSERT INTO chat_sessions (id,user_id,title,project_id,archived,pinned,message_count,cost_units,prompt_tokens,completion_tokens) VALUES (?,?,?,?,?,?,1,123,100,20)", [id,userId,`保留对话${index}`,suffix,index,1-index]);
    await pool.query("INSERT INTO chat_messages (session_id,user_id,seq,role,parts,cost,prompt_tokens,completion_tokens) VALUES (?,?,1,'assistant',?,0.0123,100,20)", [id,userId,JSON.stringify([{ id: "kept", type: "text", text: "历史内容完整保留" }])]);
  }
  const [before] = await pool.query("SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY id", [userId]);
  const messagesBefore = await Promise.all(ids.map(id => getSessionMessages(id)));
  for (let run = 0; run < 2; run++) {
    await migrate();
    const [after] = await pool.query("SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY id", [userId]);
    assert.deepEqual(after, before.map(({ project_id, ...row }) => row), "All session fields except project binding must survive repeated upgrades");
    assert.deepEqual(await Promise.all(ids.map(id => getSessionMessages(id))), messagesBefore);
    assert.deepEqual(await sessionCounts(userId), { active: 1, archived: 1 });
    assert.equal((await listSessions(userId))[0].id, ids[0]);
    assert.equal((await listSessions(userId, { archived: "true" }))[0].id, ids[1]);
    assert.equal((await listSessions(userId, { archived: "all" })).length, 2);
    const [[tables]] = await pool.query("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'chat_projects'");
    assert.equal(Number(tables.c), 0);
  }
  await assert.rejects(batchSessions({ userId, ids, action: "move" }), { code: "BAD_ACTION" });
  assert.deepEqual(await sessionCounts(userId), { active: 1, archived: 1 });
  console.log("Project retirement passed: fresh schema, legacy upgrade twice, complete history/billing preservation, both lists/counts, retired move rejected.");
} finally {
  if (userId) {
    await pool.query("DELETE FROM chat_messages WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM chat_sessions WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM users WHERE id = ? AND username = ?", [userId, `retire_${suffix}`]);
  }
  await pool.end();
}
