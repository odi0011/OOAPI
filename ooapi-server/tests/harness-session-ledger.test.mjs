// 真运行 appendMessage 事务，内存行锁模拟崩溃/并发，不访问实际数据库。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeHarnessBudget } from "../src/services/harness/runtime.js";

let state, gate = Promise.resolve(), failMark = false, lostCommit = false, cleanupStore;
const clone = value => structuredClone(value);
const fixture = { crypto, normalizeHarnessBudget, now: () => 1234, pool: {
  query: async (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();
    assert.equal((s.match(/\?/g) || []).length, args.length);
    cleanupStore.queries.push(s);
    if (s.startsWith("SELECT id FROM chat_sessions")) return [cleanupStore.sessions.filter(row => row.user_id === args[0] && args.slice(1).includes(row.id)).map(row => ({ id: row.id }))];
    if (s.startsWith("SELECT id FROM chat_messages")) return [[]]; // 无媒体消息的独立清理用例。
    if (s.startsWith("DELETE FROM chat_sessions")) {
      const batch = s.includes(" IN ("), userId = batch ? args[0] : args[1], ids = batch ? args.slice(1) : [args[0]];
      const removed = cleanupStore.sessions.filter(row => row.user_id === userId && ids.includes(row.id));
      if (cleanupStore.noDelete) return [{ affectedRows: 0 }];
      cleanupStore.sessions = cleanupStore.sessions.filter(row => !removed.includes(row));
      return [{ affectedRows: removed.length }];
    }
    if (s.startsWith("DELETE FROM chat_messages")) return [{ affectedRows: 0 }];
    const table = s.match(/^DELETE FROM (chat_agent_tasks|chat_agent_runs|local_session_workspaces) /)?.[1];
    if (table) {
      const removed = cleanupStore[table].filter(row => row.user_id === args[0] && args.slice(1).includes(row.session_id));
      cleanupStore[table] = cleanupStore[table].filter(row => !removed.includes(row));
      return [{ affectedRows: removed.length }];
    }
    throw new Error(`Unexpected cleanup SQL: ${s}`);
  },
  getConnection: async () => {
    let data, release, committed = false;
    return {
      async beginTransaction() {
        const previous = gate;
        gate = new Promise(resolve => { release = resolve; });
        await previous;
        data = clone(state);
      },
      async query(sql, args) {
        const s = sql.replace(/\s+/g, " ").trim();
        assert.equal((s.match(/\?/g) || []).length, args.length, `SQL 参数数 ${s}`);
        if (s.startsWith("SELECT id FROM chat_sessions")) return [[{ id: data.session.id }].filter(() => args[0] === data.session.id && args[1] === data.session.user_id)];
        if (s.startsWith("SELECT id, assistant_segment")) return [[data.run].filter(row => row.id === args[0] && row.user_id === args[1] && row.session_id === args[2]).map(clone)];
        if (s.startsWith("SELECT COALESCE(MAX(seq)")) return [[{ seq: Math.max(0, ...data.messages.map(m => m.seq)) }]];
        if (s.startsWith("INSERT INTO chat_messages")) {
          const columns = s.match(/\((.*?)\) VALUES/)[1].split(",").map(v => v.trim());
          const row = { ...Object.fromEntries(columns.map((name, i) => [name, args[i]])), id: ++data.nextId };
          data.messages.push(row);
          return [{ affectedRows: 1, insertId: row.id }];
        }
        if (s.startsWith("SELECT COUNT(*)")) return [[{ c: data.messages.length }]];
        if (s.startsWith("UPDATE chat_sessions")) {
          data.session.message_count = args[0]; data.session.cost_units += args[1];
          data.session.prompt_tokens += args[2]; data.session.completion_tokens += args[3];
          return [{ affectedRows: 1 }];
        }
        if (s.startsWith("SELECT id, seq, created_time")) return [data.messages.filter(m => m.id === Number(args[0]) && m.session_id === args[1] && m.user_id === args[2]).map(clone)];
        if (s.startsWith("UPDATE chat_agent_runs SET assistant_segment")) {
          if (failMark) { failMark = false; throw new Error("fixture ledger failed"); }
          const match = data.run.id === args[2] && data.run.user_id === args[3] && data.run.session_id === args[4]
            && data.run.assistant_segment < args[5] && (!s.includes("lease_owner") || data.run.lease_owner === args[6]);
          if (!match) return [{ affectedRows: 0 }];
          data.run.assistant_segment = args[0]; data.run.assistant_message_id = args[1];
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL: ${s}`);
      },
      async commit() { state = data; committed = true; if (lostCommit) { lostCommit = false; throw new Error("fixture committed then disconnected"); } },
      async rollback() { if (!committed) data = null; },
      release() { release?.(); },
    };
  },
} };
globalThis.__ooSessionLedgerFixture = fixture;
const source = readFileSync(new URL("../src/services/harness/sessions.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const prelude = `const {crypto,pool,now,normalizeHarnessBudget}=globalThis.__ooSessionLedgerFixture;
const PLATFORM_TOOL_IDS=[];
const safeJSONParse=(value,fallback)=>{try{return JSON.parse(value)}catch{return fallback}};
`;
const { appendMessage, deleteSession, batchSessions } = await import(`data:text/javascript;base64,${Buffer.from(prelude + source).toString("base64")}`);
const reset = () => {
  state = { session: { id: "session", user_id: 7, message_count: 0, cost_units: 0, prompt_tokens: 0, completion_tokens: 0 },
    run: { id: "durable", user_id: 7, session_id: "session", lease_owner: "owner-a", assistant_segment: -1, assistant_message_id: 0 },
    messages: [], nextId: 0 };
};
const args = extra => ({ sessionId: "session", userId: 7, role: "assistant", parts: [{ type: "text", text: "完整结果" }],
  cost: .01, promptTokens: 20, completionTokens: 5, durableRunId: "durable", billingSegment: 0, leaseOwner: "owner-a", returnMessage: true, ...extra });
let passed = 0;
const test = async (name, fn) => { reset(); await fn(); passed++; console.log(`  ok  ${name}`); };

await test("同一结算段并发落库只追加一次，并返回同一 message id/seq", async () => {
  const [first, second] = await Promise.all([appendMessage(args()), appendMessage(args())]);
  assert.deepEqual(first, second); assert.equal(state.messages.length, 1);
  assert.equal(state.session.cost_units, 100); assert.equal(state.session.prompt_tokens, 20); assert.equal(state.session.message_count, 1);
});
await test("账本写入失败整个助手事务回滚，重试只形成一条消息", async () => {
  failMark = true;
  await assert.rejects(appendMessage(args()), /fixture ledger failed/);
  assert.equal(state.messages.length, 0); assert.equal(state.session.cost_units, 0); assert.equal(state.run.assistant_segment, -1);
  await appendMessage(args()); assert.equal(state.messages.length, 1); assert.equal(state.session.cost_units, 100);
});
await test("COMMIT 生效后连接断开，恢复返回原消息而不重复计数", async () => {
  lostCommit = true;
  await assert.rejects(appendMessage(args()), /committed then disconnected/);
  const original = clone(state.messages[0]), recovered = await appendMessage(args());
  assert.equal(recovered.id, original.id); assert.equal(recovered.seq, original.seq);
  assert.equal(state.messages.length, 1); assert.equal(state.session.cost_units, 100);
});
await test("租约已交接的旧 worker 不得追加消息或更新计数", async () => {
  state.run.lease_owner = "owner-b";
  await assert.rejects(appendMessage(args()), { code: "RUN_CHANGED" });
  assert.equal(state.messages.length, 0); assert.equal(state.session.cost_units, 0);
});
await test("新段能够追加，旧段重放拒绝；账本与消息缺失不能默默新建", async () => {
  await appendMessage(args()); const next = await appendMessage(args({ billingSegment: 1 }));
  assert.equal(next.seq, 2); assert.equal(state.session.cost_units, 200);
  await assert.rejects(appendMessage(args()), { code: "RUN_SEGMENT_CHANGED" });
  state.messages = state.messages.filter(m => m.id !== next.id);
  await assert.rejects(appendMessage(args({ billingSegment: 1 })), { code: "RUN_MESSAGE_MISSING" });
});
await test("任务账本不能跨用户/会话使用，非助手与非法段号拒绝", async () => {
  await assert.rejects(appendMessage(args({ durableRunId: "other" })), { code: "RUN_CHANGED" });
  await assert.rejects(appendMessage(args({ role: "user" })), { code: "BAD_RUN_SEGMENT" });
  await assert.rejects(appendMessage(args({ billingSegment: -1 })), { code: "BAD_RUN_SEGMENT" });
  assert.equal(state.messages.length, 0);
});
const seedCleanup = () => {
  cleanupStore = { sessions: [{ id: "owned", user_id: 7 }, { id: "foreign", user_id: 8 }], queries: [] };
  for (const table of ["chat_agent_tasks", "chat_agent_runs", "local_session_workspaces"]) cleanupStore[table] = [{ user_id: 7, session_id: "owned" }, { user_id: 8, session_id: "foreign" }];
};
await test("单会话删除只清理本人成功删除会话的运行、任务与设备关联", async () => {
  seedCleanup();
  assert.equal(await deleteSession(7, "foreign"), false);
  assert.equal(cleanupStore.queries.filter(s => /DELETE FROM (chat_agent_tasks|chat_agent_runs|local_session_workspaces)/.test(s)).length, 0);
  assert.equal(await deleteSession(7, "owned"), true);
  for (const table of ["chat_agent_tasks", "chat_agent_runs", "local_session_workspaces"]) assert.deepEqual(cleanupStore[table], [{ user_id: 8, session_id: "foreign" }]);
});
await test("批量删除先限定归属；删除未成功时不得继续清理编排记录", async () => {
  seedCleanup(); cleanupStore.noDelete = true;
  assert.deepEqual(await batchSessions({ userId: 7, ids: ["owned", "foreign"], action: "delete" }), { affected: 0 });
  assert.equal(cleanupStore.queries.filter(s => /DELETE FROM (chat_agent_tasks|chat_agent_runs|local_session_workspaces)/.test(s)).length, 0);
  cleanupStore.noDelete = false;
  assert.deepEqual(await batchSessions({ userId: 7, ids: ["owned", "foreign"], action: "delete" }), { affected: 1 });
  for (const table of ["chat_agent_tasks", "chat_agent_runs", "local_session_workspaces"]) assert.deepEqual(cleanupStore[table], [{ user_id: 8, session_id: "foreign" }]);
});
delete globalThis.__ooSessionLedgerFixture;
console.log(`  助手消息原子账本回归 ${passed} 项通过`);
