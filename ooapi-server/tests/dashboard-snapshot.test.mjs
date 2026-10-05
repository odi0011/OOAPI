// 看板只读快照必须先完成事务再返回，并在失败时释放连接、保留最初的诊断。
import assert from 'node:assert/strict';
import { withDashboardSnapshot } from '../src/services/dashboard-snapshot.js';

let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('  ok ' + name); }
function fixture(failAt = '', rollbackFailure = false) {
  const primary = new Error('fixture ' + failAt), cleanup = new Error('fixture rollback');
  const events = [];
  let borrowed = false, transaction = false, destroyed = false;
  const connection = {
    async query(sql) {
      if (sql.startsWith('SET ')) {
        events.push('configure');
        assert.equal(sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        if (failAt === 'configure') throw primary;
      } else if (sql.startsWith('START ')) {
        events.push('start');
        assert.equal(sql, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        if (failAt === 'start') throw primary;
        transaction = true;
      } else {
        assert.equal(transaction, true, 'statistic read requires an active transaction');
        events.push('read');
        if (failAt === 'read') throw primary;
        return [[{ calls: 2 }]];
      }
    },
    async commit() {
      events.push('commit');
      if (failAt === 'commit') throw primary;
      transaction = false;
    },
    async rollback() {
      events.push('rollback');
      if (rollbackFailure) throw cleanup;
      transaction = false;
    },
    release() {
      assert.equal(transaction, false, 'an open transaction cannot return to the pool');
      events.push('release'); borrowed = false;
    },
    destroy() { events.push('destroy'); transaction = false; borrowed = false; destroyed = true; },
  };
  const database = {
    async getConnection() {
      events.push('acquire');
      if (failAt === 'acquire') throw primary;
      assert.equal(borrowed, false, 'released connection must be available to the next request');
      assert.equal(destroyed, false, 'destroyed connections cannot be borrowed again');
      borrowed = true;
      return connection;
    },
  };
  return { database, connection, events, primary, available: () => !borrowed, failAt };
}
const read = async (query) => { const [[row]] = await query('SELECT fixture_statistic'); return row; };

await check('成功响应前提交并释放，同一池连接可服务下一次请求', async () => {
  const f = fixture();
  assert.deepEqual(await withDashboardSnapshot(read, f.database), { calls: 2 });
  assert.deepEqual(f.events, ['acquire', 'configure', 'start', 'read', 'commit', 'release']);
  assert.ok(f.available());
  await withDashboardSnapshot(read, f.database);
  assert.equal(f.events.filter(e => e === 'release').length, 2);
});
await check('借连接失败不执行查询或清理，不改变原始错误', async () => {
  const f = fixture('acquire');
  await assert.rejects(withDashboardSnapshot(read, f.database), error => error === f.primary);
  assert.deepEqual(f.events, ['acquire']);
});
await check('隔离配置失败释放连接，未开始事务不额外回滚', async () => {
  const f = fixture('configure');
  await assert.rejects(withDashboardSnapshot(read, f.database), error => error === f.primary);
  assert.deepEqual(f.events, ['acquire', 'configure', 'release']);
  assert.ok(f.available());
});
for (const failure of ['start', 'read', 'commit']) {
  await check(failure + ' 失败回滚、释放，并保留引发失败的错误对象', async () => {
    const f = fixture(failure);
    await assert.rejects(withDashboardSnapshot(read, f.database), error => error === f.primary);
    assert.deepEqual(f.events.slice(-2), ['rollback', 'release']);
    assert.ok(f.available());
    assert.equal(f.events.filter(e => e === 'destroy').length, 0);
  });
}
await check('回滚再次失败销毁连接，清理错误不覆盖原始查询错误', async () => {
  const f = fixture('read', true);
  await assert.rejects(withDashboardSnapshot(read, f.database), error => error === f.primary);
  assert.deepEqual(f.events.slice(-2), ['rollback', 'destroy']);
  assert.equal(f.events.filter(e => e === 'release').length, 0);
  assert.ok(f.available());
});
await check('提交尚未完成时不能拿到响应数据，也不能复用其连接', async () => {
  const f = fixture();
  let allowCommit, enteredCommit, resolved = false;
  const commitReady = new Promise(resolve => { enteredCommit = resolve; });
  const commitGate = new Promise(resolve => { allowCommit = resolve; });
  const commit = f.connection.commit;
  f.connection.commit = async () => { enteredCommit(); await commitGate; await commit(); };
  const pending = withDashboardSnapshot(read, f.database).then(result => { resolved = true; return result; });
  await commitReady;
  assert.equal(resolved, false); assert.equal(f.available(), false);
  assert.ok(!f.events.includes('release'));
  allowCommit();
  assert.deepEqual(await pending, { calls: 2 });
  assert.ok(f.available());
});
console.log('Dashboard snapshot: ' + checks + ' checks passed');
process.exit(0);
