// 真 SQL + 真 HTTP：仅在独立 gate 库提交临时样本，最后按本次创建的 ID 精准清理。
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
if (!/^ooapi_agent_gate_[a-f0-9]{8}$/.test(process.env.DB_NAME || '')) throw new Error('仅允许在明确的独立 gate 数据库运行');
process.env.DB_POOL_SIZE = '4'; // 小池并发检验：快照释放前不得再借连接查品牌元数据。
const { pool } = await import('../src/db.js');
const { signToken } = await import('../src/middleware/auth.js');
const dashboard = (await import('../src/routes/dashboard.js')).default;
const { withDashboardSnapshot } = await import('../src/services/dashboard-snapshot.js');
const connection = await pool.getConnection();
const originalConnection = pool.getConnection;
let afterAggregate = null, pendingWriter = null;
pool.getConnection = async () => {
  const actual = await originalConnection.call(pool);
  return {
    query: async (sql, args = []) => {
      const result = await actual.query(sql, args);
      if (afterAggregate && String(sql).includes('COUNT(DISTINCT model) AS models')) {
        const hook = afterAggregate; afterAggregate = null; await hook(args);
      }
      return result;
    },
    commit: () => actual.commit(), rollback: () => actual.rollback(), release: () => actual.release(), destroy: () => actual.destroy(),
  };
};
const fixtureUsers = [], fixtureChannels = [];
const app = express();
app.use('/dashboard', dashboard);
app.use((err, req, res, next) => res.status(500).json({ message: err.message }));
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = 'http://127.0.0.1:' + server.address().port;
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('  ok ' + name); }
try {
  await connection.query("SET SESSION sql_mode = CONCAT_WS(',', @@sql_mode, 'ONLY_FULL_GROUP_BY')");
  const now = Math.floor(Date.now() / 1000), today = Math.floor((now + 28800) / 86400) * 86400 - 28800;
  const since = today - 6 * 86400;
  const suffix = crypto.randomBytes(6).toString('hex');
  const [u] = await connection.query('INSERT INTO users (username,password,role,status,aff_code) VALUES (?,?,1000,1,?)', ['dash_' + suffix, 'unusable-test-hash', suffix]);
  const userId = u.insertId;
  fixtureUsers.push(userId);
  const [c] = await connection.query("INSERT INTO channels (name,type,status) VALUES ('事务验收渠道','openai',1)");
  const channelId = c.insertId;
  fixtureChannels.push(channelId);
  const headers = { authorization: 'Bearer ' + signToken({ id: userId, role: 1000, token_version: 0 }) };
  const get = async (path) => { const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) }); const body = await res.json(); assert.equal(res.status, 200, body.message); return body.data; };
  const empty = await get('/dashboard/self?range=7d');
  check('未绑定账户分组时不虚构 default', () => assert.equal(empty.account.group_name, ''));
  check('空样本成功率为 null，上期同样为空', () => { assert.equal(empty.totals.success_rate, null); assert.equal(empty.previous.success_rate, null); });
  check('7 天恰好返回 7 个北京日期', () => { assert.equal(empty.trend.length, 7); assert.equal(empty.trend[0].day_ts, since); assert.equal(empty.trend.at(-1).day_ts, today); });
  const rows = [
    [2, 0, 'success', 'fixture-model', since, 100, 1, 0],
    [2, 1, 'success', 'fixture-model', now, 200, 0, 0],
    [4, 1, 'partial', 'fixture-model', now, 50, 1, 200],
    [4, 1, 'error', '', now, 0, 0, 0],
    [4, 1, 'stopped', 'fixture-model', now, 10, 0, 0],
    [4, 0, 'error', 'fixture-model', now, 999, 0, 0],
    [2, 1, 'success', 'fixture-model', since - 1, 80, 1, 400],
  ];
  for (const row of rows) await connection.query('INSERT INTO logs (user_id,channel_id,type,is_usage,status,model,created_at,quota,first_token_known,first_token_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [userId, channelId, ...row]);
  for (const [enabled, expiry, unlimited, remaining] of [[1,-1,1,0],[1,now-1,1,0],[1,-1,0,0],[1,-1,0,100],[2,-1,1,100]]) {
    await connection.query('INSERT INTO tokens (user_id,name,key_str,status,expired_time,unlimited_quota,remain_quota) VALUES (?,?,?,?,?,?,?)', [userId, 'fixture', crypto.randomBytes(16).toString('hex'), enabled, expiry, unlimited, remaining]);
  }
  const d = await get('/dashboard/self?range=7d');
  check('失败和停止各计一次，旧错误日志不混入', () => { assert.equal(d.totals.calls, 5); assert.equal(d.totals.errors, 2); assert.equal(d.totals.successes, 2); assert.equal(d.totals.success_rate, 40); assert.equal(d.totals.units, 360); });
  check('未知模型仍计入模型分布，分项与汇总一致', () => { assert.equal(d.by_model.reduce((s,r)=>s+r.calls,0), 5); assert.equal(d.by_model.reduce((s,r)=>s+r.units,0), 360); assert.ok(d.by_model.some(r=>r.model==='未记录模型')); });
  check('日期边界与上期无重叠', () => { assert.equal(d.previous.calls, 1); assert.equal(d.previous.units, 80); assert.equal(d.trend.reduce((s,r)=>s+r.calls,0), 5); });
  check('有效令牌排除过期、耗尽与禁用', () => { assert.equal(d.account.active_tokens, 2); assert.equal(d.account.total_tokens, 5); });
  const admin = await get('/dashboard/admin?range=7d&user_id='+userId);
  const channel = admin.by_channel.find(r => r.channel_id === channelId);
  check('严格 GROUP BY 下用户和渠道排行可执行', () => { assert.ok(admin.top_users.some(r=>r.user_id===userId)); assert.ok(channel); });
  check('渠道错误率分母不重复，真实 0ms 首字参与平均', () => { assert.equal(channel.calls, 5); assert.equal(channel.errors, 2); assert.equal(channel.success_rate, 40); assert.equal(channel.avg_first_token, 100); });
  check('管理端成功/停止/部分完成口径与个人一致', () => {
    assert.equal(admin.totals.successes, 2); assert.equal(admin.totals.stopped, 1); assert.equal(admin.totals.partial, 1);
    assert.equal(admin.totals.success_rate, 40); assert.equal(admin.totals.remaining, 0); assert.equal(admin.totals.avg_first_token, 100);
  });
  check('同范围最近记录与趋势均未读入前一周期记录', () => {
    assert.equal(admin.recent_logs.length, 5); assert.ok(admin.recent_logs.every(r=>r.created_at >= since));
    assert.equal(admin.trend.reduce((sum,r)=>sum+r.calls,0), admin.totals.calls);
    assert.equal(admin.top_models.reduce((sum,r)=>sum+r.calls,0), admin.totals.calls);
  });
  const [other] = await connection.query('INSERT INTO users (username,password,role,status,aff_code) VALUES (?,?,1,1,?)', ['dash_other_' + suffix, 'unusable-test-hash', 'a'+suffix]);
  fixtureUsers.push(other.insertId);
  const [key] = await connection.query('INSERT INTO tokens (user_id,name,key_str,status,expired_time,unlimited_quota) VALUES (?,?,?,1,-1,1)', [userId, 'Scoped fixture key', crypto.randomBytes(16).toString('hex')]);
  const detail = JSON.stringify({ source_vendors: ['opencode'], requested_model: 'fixture-alias', upstream_model: 'fixture-model-free', pricing_model: 'fixture-model', secret: 'EXCLUDED_DETAIL_FIXTURE' });
  await connection.query('INSERT INTO logs (user_id,token_id,channel_id,type,is_usage,status,model,created_at,quota,prompt_tokens,completion_tokens,cache_tokens,detail) VALUES (?,?,?,2,1,\'success\',\'fixture-model\',?,17,100,10,60,?)', [userId,key.insertId,channelId,now,detail]);
  await connection.query('INSERT INTO logs (user_id,channel_id,type,is_usage,status,model,created_at,quota) VALUES (?,?,2,1,\'success\',\'future-excluded\',?,99999)', [userId,channelId,now+3600]);
  await connection.query('INSERT INTO logs (user_id,token_id,channel_id,type,is_usage,status,model,created_at,quota) VALUES (?,?,?,2,1,\'success\',\'other-user-excluded\',?,99999)', [other.insertId,key.insertId,channelId,now]);
  await connection.query('UPDATE users SET avatar_media_id=42 WHERE id=?', [userId]);
  const scoped = await get(`/dashboard/admin?range=7d&user_id=${userId}&token_id=${key.insertId}`);
  check('真 SQL 用户与密钥筛选、金额和 Token 对齐', () => {
    assert.equal(scoped.totals.calls,1); assert.equal(scoped.totals.units,17); assert.equal(scoped.totals.total_tokens,110);
    assert.equal(scoped.totals.cache_tokens,60); assert.equal(scoped.totals.uncached_tokens,40);
    assert.equal(scoped.by_channel[0].total_tokens,110); assert.equal(scoped.trend.reduce((sum,r)=>sum+r.total_tokens,0),110);
  });
  check('真 SQL 来源快照优先、头像更新与安全模型明细', () => {
    assert.deepEqual(scoped.top_models[0].source_vendors,['opencode']);
    const r=scoped.recent_logs[0]; assert.equal(r.avatar_url,`/api/media/avatar/${userId}?v=42`);
    assert.equal(r.requested_model,'fixture-alias'); assert.equal(r.original_model,'fixture-model-free'); assert.equal(r.billing_model,'fixture-model');
    assert.ok(!JSON.stringify(scoped).includes('EXCLUDED_DETAIL_FIXTURE'));
  });
  for (let i=0;i<13;i++) await connection.query('INSERT INTO logs (user_id,channel_id,type,is_usage,status,model,created_at,quota) VALUES (?,?,2,1,\'success\',?,?,0)', [userId,channelId,`fixture-zero-model-${i}`,now]);
  const complete = await get('/dashboard/admin?range=7d&user_id='+userId);
  check('完整型号不提前归并其他、免费型号保留、未来型号不计入', () => {
    assert.equal(complete.top_models.length,15); assert.ok(!complete.top_models.some(r=>['其他模型','future-excluded','other-user-excluded'].includes(r.model)));
    assert.equal(complete.top_models.reduce((sum,r)=>sum+r.calls,0),complete.totals.calls);
    assert.equal(complete.top_models.reduce((sum,r)=>sum+r.units,0),complete.totals.units);
    assert.equal(complete.top_models.filter(r=>r.model.startsWith('fixture-zero-model-')).length,13);
  });
  const personal = await get('/dashboard/self?range=7d');
  check('个人最近明细不包含管理员上游字段与他人身份', () => {
    assert.ok(personal.recent_logs.every(r=>!Object.hasOwn(r,'upstream_model')&&!Object.hasOwn(r,'original_model')&&!Object.hasOwn(r,'user_id')));
    assert.equal(personal.totals.calls,complete.totals.calls);
  });
  for (const [model,quota] of [['claude-opus-4-6',3],['claude-opus-4-6-thinking',5],['3-auto',2],['4-auto',4]]) {
    await connection.query('INSERT INTO logs (user_id,channel_id,type,is_usage,status,model,created_at,quota) VALUES (?,?,2,1,\'success\',?,?,?)', [userId,channelId,model,now,quota]);
  }
  const aliases = await get('/dashboard/admin?range=7d&user_id='+userId);
  check('真 SQL 聚合后合并历史别名、渠道专属 auto 不合并', () => {
    const model=aliases.top_models.find(r=>r.model==='claude-opus-4-6'); assert.equal(model.calls,2); assert.equal(model.units,8);
    assert.ok(!aliases.top_models.some(r=>r.model.endsWith('-thinking')));
    assert.ok(aliases.top_models.some(r=>r.model==='3-auto')); assert.ok(aliases.top_models.some(r=>r.model==='4-auto'));
    assert.equal(aliases.totals.models,aliases.top_models.length);
    assert.equal(aliases.top_models.reduce((sum,r)=>sum+r.units,0),aliases.totals.units);
  });
  afterAggregate = async (args) => connection.query("INSERT INTO logs (user_id,token_id,channel_id,type,is_usage,status,model,created_at,quota,prompt_tokens,completion_tokens) VALUES (?,?,?,2,1,'success','same-second-admin',?,50,25,5)", [userId,key.insertId,channelId,args.at(-1)-1]);
  const stableAdmin = await get('/dashboard/admin?range=7d&user_id='+userId);
  check('管理端同秒新日志提交不混入已开始的快照', () => {
    assert.equal(stableAdmin.totals.calls,aliases.totals.calls); assert.equal(stableAdmin.totals.units,aliases.totals.units);
    assert.equal(stableAdmin.top_models.reduce((sum,r)=>sum+r.calls,0),stableAdmin.totals.calls);
    assert.equal(stableAdmin.trend.reduce((sum,r)=>sum+r.units,0),stableAdmin.totals.units);
    assert.equal(stableAdmin.by_channel.reduce((sum,r)=>sum+r.calls,0),stableAdmin.totals.calls);
    assert.ok(!stableAdmin.recent_logs.some(r=>r.model==='same-second-admin'));
  });
  const nextAdmin = await get('/dashboard/admin?range=7d&user_id='+userId);
  check('下一次管理端请求能看到上一响应期间已提交的新日志', () => {
    assert.equal(nextAdmin.totals.calls,aliases.totals.calls+1); assert.equal(nextAdmin.totals.units,aliases.totals.units+50);
    assert.ok(nextAdmin.recent_logs.some(r=>r.model==='same-second-admin'));
  });
  const beforeSelf = await get('/dashboard/self?range=7d');
  afterAggregate = async (args) => connection.query("INSERT INTO logs (user_id,channel_id,type,is_usage,status,model,created_at,quota) VALUES (?,?,2,1,'success','same-second-self',?,30)", [userId,channelId,args.at(-1)-1]);
  const stableSelf = await get('/dashboard/self?range=7d');
  check('个人端同秒提交在模型、趋势、小时、近期里都不混入当前快照', () => {
    assert.equal(stableSelf.totals.calls,beforeSelf.totals.calls);
    assert.equal(stableSelf.by_model.reduce((sum,r)=>sum+r.calls,0),stableSelf.totals.calls);
    assert.equal(stableSelf.trend.reduce((sum,r)=>sum+r.units,0),stableSelf.totals.units);
    assert.equal(stableSelf.by_hour.reduce((sum,r)=>sum+r.calls,0),stableSelf.totals.calls);
    assert.ok(!stableSelf.recent_logs.some(r=>r.model==='same-second-self'));
  });
  const nextSelf = await get('/dashboard/self?range=7d');
  check('个人端下次刷新可见已提交的新日志', () => assert.equal(nextSelf.totals.calls,beforeSelf.totals.calls+1));
  pendingWriter = await originalConnection.call(pool);
  await pendingWriter.beginTransaction();
  await pendingWriter.query("INSERT INTO logs (user_id,channel_id,type,is_usage,status,model,created_at,quota) VALUES (?,?,2,1,'success','delayed-existing-id',?,9)", [userId,channelId,now]);
  afterAggregate = async () => pendingWriter.commit();
  const delayed = await get('/dashboard/admin?range=7d&user_id='+userId);
  check('快照开始前已分配的小 ID 延迟提交仍不改变读视图', () => {
    assert.equal(delayed.totals.calls,nextSelf.totals.calls); assert.equal(delayed.top_models.reduce((sum,r)=>sum+r.calls,0),delayed.totals.calls);
    assert.ok(!delayed.recent_logs.some(r=>r.model==='delayed-existing-id'));
  });
  pendingWriter.release(); pendingWriter=null;
  const afterDelayed = await get('/dashboard/admin?range=7d&user_id='+userId);
  check('延迟事务提交后下次请求正常读取', () => assert.equal(afterDelayed.totals.calls,nextSelf.totals.calls+1));
  for (let i=0;i<13;i++) {
    const [row] = await connection.query("INSERT INTO channels (name,type,status) VALUES (?,'openai',1)", [`gate-channel-${suffix}-${i}`]);
    fixtureChannels.push(row.insertId);
    await connection.query("INSERT INTO logs (user_id,channel_id,type,is_usage,status,model,created_at,quota) VALUES (?,?,2,1,'success','fixture-model',?,0)", [userId,row.insertId,now]);
  }
  const manyChannels = await get('/dashboard/admin?range=7d&user_id='+userId);
  check('渠道超过12个时仍完整返回，分项调用总数不漏掉尾部渠道', () => {
    assert.equal(manyChannels.by_channel.length,14);
    assert.equal(manyChannels.by_channel.reduce((sum,r)=>sum+r.calls,0),manyChannels.totals.calls);
  });
  await Promise.all(Array.from({length:8},()=>get('/dashboard/admin?range=7d&user_id='+userId)));
  check('4连接小池下8个并发看板可完成，事务后品牌读取不会互等', () => assert.ok(true));
  await assert.rejects(withDashboardSnapshot((query)=>query('UPDATE users SET request_count=request_count+1 WHERE id=?',[userId])), error=>error.code==='ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION');
  await assert.rejects(withDashboardSnapshot((query)=>query('SELECT nonexistent_gate_column FROM logs')), error=>error.code==='ER_BAD_FIELD_ERROR');
  const afterErrors = await get('/dashboard/self?range=7d');
  check('真实只读事务拒绝写入，SQL失败回滚释放后看板仍可读取', () => {
    assert.equal(afterErrors.totals.calls,manyChannels.totals.calls);
    assert.equal(afterErrors.account.request_count,0);
  });
  for (const [range, n] of [['30d',30],['90d',90],['__proto__',30]]) { const result = await get('/dashboard/self?range='+range); check('日期范围 ' + range, () => assert.equal(result.trend.length,n)); }
} finally {
  afterAggregate=null; pool.getConnection=originalConnection;
  await new Promise(resolve => server.close(resolve));
  if (pendingWriter) { await pendingWriter.rollback(); pendingWriter.release(); }
  if (fixtureUsers.length) {
    const marks=fixtureUsers.map(()=>'?').join(',');
    await connection.query(`DELETE FROM logs WHERE user_id IN (${marks})`,fixtureUsers);
    await connection.query(`DELETE FROM tokens WHERE user_id IN (${marks})`,fixtureUsers);
    await connection.query(`DELETE FROM users WHERE id IN (${marks})`,fixtureUsers);
  }
  if (fixtureChannels.length) await connection.query(`DELETE FROM channels WHERE id IN (${fixtureChannels.map(()=>'?').join(',')})`,fixtureChannels);
  connection.release(); await pool.end();
}
console.log('Dashboard data: ' + checks + ' checks passed');
process.exit(0);
