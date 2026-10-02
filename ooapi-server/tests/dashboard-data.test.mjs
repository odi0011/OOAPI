// 真 SQL + 真 HTTP：样本只写入事务并回滚，不依赖线上流量与上游厂商。
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { pool } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
import dashboard from '../src/routes/dashboard.js';

if (!/(test|gate|ooapi_home_)/i.test(process.env.DB_NAME || '')) throw new Error('仅允许在独立测试数据库运行');
const connection = await pool.getConnection();
const originalQuery = pool.query;
pool.query = connection.query.bind(connection);
const app = express();
app.use('/dashboard', dashboard);
app.use((err, req, res, next) => res.status(500).json({ message: err.message }));
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = 'http://127.0.0.1:' + server.address().port;
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('  ok ' + name); }
try {
  await connection.query("SET SESSION sql_mode = CONCAT_WS(',', @@sql_mode, 'ONLY_FULL_GROUP_BY')");
  await connection.beginTransaction();
  const now = Math.floor(Date.now() / 1000), today = Math.floor((now + 28800) / 86400) * 86400 - 28800;
  const since = today - 6 * 86400;
  const suffix = crypto.randomBytes(6).toString('hex');
  const [u] = await connection.query('INSERT INTO users (username,password,role,status,aff_code) VALUES (?,?,1000,1,?)', ['dash_' + suffix, 'unusable-test-hash', suffix]);
  const userId = u.insertId;
  const [c] = await connection.query("INSERT INTO channels (name,type,status) VALUES ('事务验收渠道','openai',1)");
  const channelId = c.insertId;
  const headers = { authorization: 'Bearer ' + signToken({ id: userId, role: 1000, token_version: 0 }) };
  const get = async (path) => { const res = await fetch(base + path, { headers }); const body = await res.json(); assert.equal(res.status, 200, body.message); return body.data; };
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
  const admin = await get('/dashboard/admin?range=7d');
  const channel = admin.by_channel.find(r => r.channel_id === channelId);
  check('严格 GROUP BY 下用户和渠道排行可执行', () => { assert.ok(admin.top_users.some(r=>r.user_id===userId)); assert.ok(channel); });
  check('渠道错误率分母不重复，真实 0ms 首字参与平均', () => { assert.equal(channel.calls, 5); assert.equal(channel.errors, 2); assert.equal(channel.success_rate, 40); assert.equal(channel.avg_first_token, 100); });
  for (const [range, n] of [['30d',30],['90d',90],['__proto__',30]]) { const result = await get('/dashboard/self?range='+range); check('日期范围 ' + range, () => assert.equal(result.trend.length,n)); }
} finally {
  await connection.rollback(); pool.query = originalQuery; connection.release();
  await new Promise(resolve => server.close(resolve)); await pool.end();
}
console.log('Dashboard data: ' + checks + ' checks passed');
process.exit(0);
