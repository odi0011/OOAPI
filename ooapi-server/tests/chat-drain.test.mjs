// 无DB/网络：退出控制须等待真正收尾，且一个不响应abort的任务不能无限阻塞退出。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
const fresh = async () => import(`../src/services/harness/drain.js?fixture=${passed}`);
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

await test("排空先拒绝新登记，并中止全部运行后等待各自完成", async () => {
  const { trackChatRun, isChatDraining, drainChatRuns } = await fresh();
  const first = new AbortController(), second = new AbortController();
  const finishFirst = trackChatRun(first), finishSecond = trackChatRun(second);
  let resolved = false;
  const pending = drainChatRuns({ timeoutMs: 500 }).then((v) => { resolved = true; return v; });
  assert.equal(isChatDraining(), true); assert.equal(trackChatRun(new AbortController()), null);
  assert.equal(first.signal.aborted, true); assert.equal(second.signal.aborted, true);
  finishFirst(); finishFirst(); // 完成回调幂等。
  await new Promise((r) => setTimeout(r, 5)); assert.equal(resolved, false);
  finishSecond();
  assert.deepEqual(await pending, { total: 2, completed: 2, pending: 0, timedOut: false });
  assert.deepEqual(await drainChatRuns(), { total: 0, completed: 0, pending: 0, timedOut: false });
});

await test("不响应abort的任务有截止且如实报告未完成，可随后继续排空", async () => {
  const { trackChatRun, drainChatRuns } = await fresh();
  const finish = trackChatRun(new AbortController());
  const started = Date.now();
  assert.deepEqual(await drainChatRuns({ timeoutMs: 20 }), { total: 1, completed: 0, pending: 1, timedOut: true });
  assert.ok(Date.now() - started < 500, "不永远await");
  finish();
  assert.deepEqual(await drainChatRuns(), { total: 0, completed: 0, pending: 0, timedOut: false });
});

await test("重复信号可并发等待同一任务，完成不能提前或重复计数", async () => {
  const { trackChatRun, drainChatRuns } = await fresh();
  const finish = trackChatRun(new AbortController());
  const first = drainChatRuns({ timeoutMs: 500 }), second = drainChatRuns({ timeoutMs: 500 });
  finish();
  for (const result of await Promise.all([first, second])) assert.deepEqual(result, { total: 1, completed: 1, pending: 0, timedOut: false });
});

await test("退款返回同一待完成Promise，consume后的finally不重复加回预占", async () => {
  let balance = 10, refunds = 0, release;
  const gate = new Promise((r) => { release = r; });
  const fixture = { query: async (sql, args) => {
    if (sql.includes('remain_quota -')) { balance -= args[0]; return [{ affectedRows: 1 }]; }
    refunds++; await gate; balance += args[0]; return [{ affectedRows: 1 }];
  } };
  globalThis.__ooRefundDrainFixture = fixture;
  try {
    const source = readFileSync(new URL('../src/services/token-quota.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
    const { holdTokenQuota } = await import('data:text/javascript;base64,' + Buffer.from(`const pool=globalThis.__ooRefundDrainFixture;\n${source}`).toString('base64'));
    const first = await holdTokenQuota({ id: 1, unlimited_quota: 0 });
    const pending = first.refund(); assert.equal(first.refund(), pending); assert.equal(refunds, 1);
    assert.equal(balance, 9); release(); await pending; assert.equal(balance, 10);
    const second = await holdTokenQuota({ id: 1, unlimited_quota: 0 });
    second.consume(); assert.equal(second.refund(), undefined); assert.equal(second.refund(), undefined);
    assert.equal(balance, 9); assert.equal(refunds, 1);
  } finally { delete globalThis.__ooRefundDrainFixture; }
});

console.log(`  chat 退出排空控制 ${passed} 项通过`);
