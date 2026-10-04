// 真运行持久任务仓库；内存行锁/事务复现重启、租约竞争与子任务取消，无实际数据库。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/services/harness/long-runs.js", import.meta.url), "utf8")
  .replace('import { pool } from "../../db.js";', "const pool = {};");
const { createLongRunStore } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const clone = v => structuredClone(v), time = 100000;
function fixture({ status = "paused", leaseUntil = 0, owner = "worker", failTasks = false } = {}) {
  let data = { run: { id: "run", session_id: "session", user_id: 7, status, checkpoint: '{"phase":"paused"}',
    config: "{}", bill_calls: '[{"usage":{"prompt_tokens":21}}]', version: 5, lease_owner: owner, lease_until: leaseUntil,
    created_at: 1, updated_at: 2, billing_segment: 1, assistant_segment: 0 },
    tasks: ["pending", "running", "paused", "waiting_local", "completed", "partial", "cancelled"].map((s, i) => ({
      id: `task${i}`, run_id: "run", session_id: "session", user_id: 7, status: s, payload: JSON.stringify({ prompt: "任务", status: s }), checkpoint: "{}", updated_at: 2,
    })).concat([{ id: "other", run_id: "other-run", session_id: "session", user_id: 7, status: "pending", payload: "{}" }]) };
  let gate = Promise.resolve(), commits = 0, rollbacks = 0;
  async function query(store, sql, args = []) {
    const s = sql.replace(/\s+/g, " ").trim();
    assert.equal((s.match(/\?/g) || []).length, args.length, `SQL占位符：${s}`);
    const whereIndex = s.indexOf(" WHERE"), where = s.slice(whereIndex);
    const argumentAt = index => args[(s.slice(0, index).match(/\?/g) || []).length];
    const matches = row => [...where.matchAll(/\b(id|run_id|session_id|user_id|lease_owner|version)\s*=\s*\?/g)]
      .every(m => String(row[m[1]]) === String(argumentAt(whereIndex + m.index)));
    if (s.startsWith("SELECT") && s.includes("FROM chat_agent_runs")) return [[store.run].filter(matches).map(clone)];
    if (s.startsWith("SELECT") && s.includes("FROM chat_agent_tasks")) return [store.tasks.filter(matches).map(clone)];
    if (s.startsWith("UPDATE chat_agent_tasks")) {
      if (failTasks) throw new Error("fixture cancel write failed");
      let affectedRows = 0;
      for (const row of store.tasks) if (matches(row) && ["pending", "running", "paused", "waiting_local", "interrupted"].includes(row.status)) {
        row.status = "cancelled"; row.updated_at = args[0]; affectedRows++;
      }
      return [{ affectedRows }];
    }
    if (s.startsWith("UPDATE chat_agent_runs")) {
      const row = store.run;
      let match = matches(row);
      if (where.includes("status IN ('paused','waiting_local','interrupted') OR")) match &&= ["paused", "waiting_local", "interrupted"].includes(row.status)
        || (row.status === "running" && row.lease_until < args.at(-1));
      if (where.includes("status NOT IN ('completed','stopped')")) match &&= !["completed", "stopped"].includes(row.status);
      if (!match) return [{ affectedRows: 0 }];
      const setStart = s.indexOf(" SET") + 4, set = s.slice(setStart, whereIndex);
      for (const m of set.matchAll(/\b(\w+)\s*=\s*(version\s*\+\s*1|\?|'[^']*'|0)/g)) {
        row[m[1]] = m[2] === "?" ? argumentAt(setStart + m.index)
          : m[2].startsWith("version") ? Number(row.version) + 1 : m[2].startsWith("'") ? m[2].slice(1, -1) : 0;
      }
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected fixture SQL: ${s}`);
  }
  const db = { query: (...args) => query(data, ...args), async getConnection() {
    let pending, unlock;
    return {
      async beginTransaction() { const before = gate; gate = new Promise(resolve => { unlock = resolve; }); await before; pending = clone(data); },
      query: (...args) => query(pending, ...args),
      async commit() { data = pending; commits++; }, async rollback() { rollbacks++; }, release() { unlock?.(); },
    };
  } };
  return { store: createLongRunStore(db, { clock: () => time }), get data() { return data; }, get commits() { return commits; }, get rollbacks() { return rollbacks; } };
}

test("重启后过期 running 显示 interrupted，停止同时取消未完成子任务且保留计费证据", async () => {
  const f = fixture({ status: "running", leaseUntil: time - 1 });
  assert.equal((await f.store.get(7, "session")).status, "interrupted");
  assert.equal(await f.store.stop(7, "session"), true);
  assert.equal(f.data.run.status, "stopped"); assert.equal(f.data.run.version, 6); assert.equal(f.data.run.lease_owner, "");
  assert.equal(f.data.run.bill_calls, '[{"usage":{"prompt_tokens":21}}]');
  assert.deepEqual(f.data.tasks.map(t => t.status), ["cancelled", "cancelled", "cancelled", "cancelled", "completed", "partial", "cancelled", "pending"]);
  assert.equal((await f.store.tasks(7, "session", "run"))[0].status, "cancelled");
  await assert.rejects(f.store.claim(7, "session"), { code: "RUN_NOT_RESUMABLE" });
});
test("未过期工作者与其他用户不能停止任务，停止终态具有幂等行为", async () => {
  const f = fixture({ status: "running", leaseUntil: time + 1 });
  assert.equal(await f.store.stop(7, "session"), false); assert.equal(await f.store.stop(8, "session"), false);
  assert.equal(f.data.run.status, "running"); assert.equal(f.data.tasks[0].status, "pending");
  const done = fixture({ status: "completed" }); assert.equal(await done.store.stop(7, "session"), false);
  const paused = fixture(); const results = await Promise.all([paused.store.stop(7, "session"), paused.store.stop(7, "session")]);
  assert.deepEqual(results, [true, false]);
});
test("子任务取消写入失败回滚父停止，保留恢复租约和子任务检查点", async () => {
  const f = fixture({ failTasks: true }), before = clone(f.data);
  await assert.rejects(f.store.stop(7, "session"), /fixture cancel write failed/);
  assert.deepEqual(f.data, before); assert.equal(f.rollbacks, 1); assert.equal(f.commits, 0);
});
test("运行父任务 stopped/error 与子任务取消原子提交，旧租约不能修改新工作者", async () => {
  for (const status of ["stopped", "error"]) {
    const f = fixture({ status: "running", leaseUntil: time + 1 }), run = await f.store.get(7, "session");
    await f.store.finish(run, status, { calls: [{ usage: { completion_tokens: 9 } }] });
    assert.equal(f.data.run.status, status); assert.equal(run.status, status); assert.equal(f.data.tasks[0].status, "cancelled");
    assert.equal(JSON.parse(f.data.run.bill_calls)[0].usage.completion_tokens, 9); assert.equal(f.commits, 1);
  }
  const stale = fixture({ owner: "new-worker" }), before = clone(stale.data);
  await assert.rejects(stale.store.finish({ id: "run", userId: 7, sessionId: "session", owner: "old-worker" }, "stopped"), { code: "RUN_CHANGED" });
  assert.deepEqual(stale.data, before); assert.equal(stale.rollbacks, 1);
});
test("finish 子取消故障回滚而 paused 保留子任务，继续只替换工作者租约", async () => {
  const failed = fixture({ status: "running", failTasks: true }), run = await failed.store.get(7, "session"), before = clone(failed.data);
  await assert.rejects(failed.store.finish(run, "error"), /fixture cancel write failed/);
  assert.deepEqual(failed.data, before); assert.equal(run.status, "interrupted");
  const paused = fixture({ status: "running" }), active = await paused.store.get(7, "session");
  await paused.store.finish(active, "paused"); assert.equal(paused.data.tasks[0].status, "pending");
  const claimed = await paused.store.claim(7, "session"); assert.equal(claimed.status, "running"); assert.ok(claimed.owner);
  assert.equal(paused.data.run.checkpoint, '{"phase":"paused"}');
});
