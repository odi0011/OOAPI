// 真HTTP站内对话→harness→环回OpenAI SSE，内存事务账本，无真实DB/账号/凭据。
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const filename = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || '') !== filename) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`chat usage HTTP回归失败(${code})`)));
  });
} else {
process.env.JWT_SECRET = 'chat-usage-fixture-signing-only';
const { pool } = await import('../src/db.js');
const originalQuery = pool.query;
const originalConnection = pool.getConnection;
const { invalidatePrices, getPrice, computeCost } = await import('../src/services/pricing.js');
const { invalidateChannelCache, resetChannelState } = await import('../src/services/router.js');
const { clearGroupConfigCache } = await import('../src/services/group-rate.js');
const { signToken } = await import('../src/middleware/auth.js');
const { default: chat } = await import('../src/routes/chat.js');
const { default: logs } = await import('../src/routes/log.js');
const model = 'fixture-chat-billing-model';
const initial = 1000000;
const input = '  用户原文 <｜User｜> 不删除\n第二行  ';
const usage = { prompt_tokens: 1700, completion_tokens: 300, cached_tokens: 500 };
const frame = (v) => `data: ${JSON.stringify(v)}\n\n`;
let behavior;
let state;
let channelId = 97000;
let channelType = 'openai';
let channelModels = model;
let fixtureRate = 1;
let userId = 98000;
let queries = [];
let messageFailures = 0;
let tokenFailures = 0;
let insertFailures = 0;
let ambiguousCommit = false;
let requests = 0;
let commits = 0;
let rollbacks = 0;
let jwt;
const clone = (v) => structuredClone(v);
const upstream = http.createServer((req, res) => { req.resume(); requests++; behavior(req, res); });
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;

function filteredLogs(store, sql, args) {
  let rows = store.logs;
  if (sql.includes('NOT (type = 2 OR')) rows = rows.filter((r) => !(r.type === 2 || (r.type === 4 && r.is_usage === 1)));
  else if (sql.includes('(type = 2 OR')) rows = rows.filter((r) => r.type === 2 || (r.type === 4 && r.is_usage === 1));
  if (sql.includes('user_id = ?')) rows = rows.filter((r) => r.user_id === Number(args[0]));
  if (/COALESCE\(NULLIF\(status,\s*''\), IF\(type = 4,\s*'error',\s*'success'\)\) = \?/.test(sql)) {
    const value = args.find((a) => ['error', 'success', 'stopped'].includes(a));
    rows = rows.filter((r) => (r.status || (r.type === 4 ? 'error' : 'success')) === value);
  }
  return rows;
}
const query = async (store, sql, args = []) => {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  queries.push(s);
  assert.equal((s.match(/\?/g) || []).length, args.length, `SQL占位符: ${s}`);
  if (s === 'SELECT * FROM users WHERE id = ?') return [[clone(store.user)].filter((u) => u.id === Number(args[0]))];
  if (s.includes('FROM model_prices')) return [[{ model, input_price: 1, output_price: 2, cache_price: .5 },
    { model: 'glm-4.7', input_price: .6, output_price: 2.2, cache_price: .11 }]];
  if (s === 'SELECT * FROM tokens WHERE id = ? AND user_id = ?') return [[clone(store.token)].filter((t) => t.id === Number(args[0]) && t.user_id === Number(args[1]))];
  if (s.includes('FROM tokens WHERE user_id = ?')) return [[clone(store.token)].filter((t) => t.user_id === Number(args[0]) && t.status === 1)];
  if (s.includes('FROM channels')) return [[{ id: channelId, type: channelType, name: 'fixture-channel', status: 1, models: channelModels,
    group_name: 'fixture', group_list: '["fixture"]', base_url: upstreamBase, api_key: 'fixture-upstream-only',
    other: JSON.stringify({ method: 'api', allow_private_upstream: true }) }]];
  if (s.includes('FROM channel_groups')) return [[{ name: 'fixture', rate: fixtureRate, models: '[]' }]];
  if (s === 'SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?' || s.startsWith('SELECT id FROM chat_sessions')) {
    return [[clone(store.session)].filter((v) => v.id === args[0] && v.user_id === Number(args[1]))];
  }
  if (s.startsWith('SELECT id, seq, role, parts')) return [[...store.messages].sort((a, b) => b.seq - a.seq).map(clone)];
  if (s.startsWith('SELECT id, role FROM chat_messages')) return [[...store.messages].filter((m) => m.seq === Number(args[1]) && m.user_id === Number(args[2])).map(clone)];
  if (s.startsWith('SELECT id FROM chat_messages')) return [store.messages.filter((m) => m.seq >= Number(args[1])).map((m) => ({ id: m.id }))];
  if (s.startsWith('SELECT COALESCE(MAX(seq)')) return [[{ seq: Math.max(0, ...store.messages.map((m) => m.seq)) }]];
  if (s.startsWith('SELECT COUNT(*) AS c FROM chat_messages')) return [[{ c: store.messages.length }]];
  if (s.startsWith('SELECT id, seq, created_time FROM chat_messages')) return [store.messages.filter((m) => m.id === Number(args[0])).map(clone)];
  if (s.startsWith('SELECT DISTINCT media_id FROM media_refs')) return [[]];
  if (s.startsWith('DELETE FROM chat_messages')) { store.messages = store.messages.filter((m) => m.seq < Number(args[1])); return [{ affectedRows: 1 }]; }
  if (s.startsWith('INSERT INTO chat_messages')) {
    if (messageFailures > 0) { messageFailures--; throw new Error('fixture message insert failed'); }
    const cols = s.match(/^INSERT INTO chat_messages \((.*?)\) VALUES/)[1].split(',').map((v) => v.trim());
    const row = Object.fromEntries(cols.map((v, i) => [v, args[i]])); row.id = ++store.nextMessage;
    store.messages.push(row); return [{ affectedRows: 1, insertId: row.id }];
  }
  if (s.startsWith('UPDATE chat_sessions SET message_count')) {
    store.session.message_count = args[0]; store.session.cost_units += args[1];
    store.session.prompt_tokens += args[2]; store.session.completion_tokens += args[3];
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith('UPDATE chat_sessions SET todo')) { store.session.todo = args[0]; return [{ affectedRows: 1 }]; }
  if (s.startsWith('UPDATE users SET quota = quota -')) {
    if (s.includes('AND quota >=') && store.user.quota < args[0]) return [{ affectedRows: 0 }];
    store.user.quota -= args[0]; store.user.used_quota += args[0]; store.user.request_count++;
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith('UPDATE tokens SET remain_quota = remain_quota -')) {
    if (store.token.remain_quota < args[0]) return [{ affectedRows: 0 }];
    store.token.remain_quota -= args[0]; return [{ affectedRows: 1 }];
  }
  if (s.startsWith('UPDATE tokens SET remain_quota = remain_quota +')) { store.token.remain_quota += args[0]; return [{ affectedRows: 1 }]; }
  if (s.startsWith('UPDATE tokens SET used_quota')) {
    if (tokenFailures) { tokenFailures--; throw new Error('fixture token write failed'); }
    assert.equal(args[4], store.token.id); assert.equal(args[5], store.user.id);
    store.token.used_quota += args[0]; store.token.remain_quota = Math.max(0, store.token.remain_quota + args[2] - args[3]);
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith('UPDATE channels')) return [{ affectedRows: 1 }];
  if (s.startsWith('INSERT INTO logs')) {
    if (insertFailures) { insertFailures--; throw new Error('fixture log write failed'); }
    const cols = s.match(/^INSERT INTO logs \((.*?)\) VALUES/)[1].split(',').map((v) => v.trim());
    const row = Object.fromEntries(cols.map((v, i) => [v, args[i]])); row.id = ++store.nextLog;
    store.logs.push(row); return [{ affectedRows: 1, insertId: row.id }];
  }
  if (s.startsWith('UPDATE logs SET type')) {
    const row = store.logs.find((r) => r.id === args[3] && r.user_id === args[4]);
    if (row) { row.type = args[0]; row.status = args[1]; row.error_code = args[2]; } return [{ affectedRows: row ? 1 : 0 }];
  }
  if (s.includes('FROM logs')) {
    const rows = filteredLogs(store, s, args);
    if (s.startsWith('SELECT COUNT(*) AS total')) return [[{ total: rows.length }]];
    if (s.startsWith('SELECT COUNT(*) AS calls')) return [[{ calls: rows.length,
      success_calls: rows.filter((r) => r.status === 'success' || (!r.status && r.type === 2)).length,
      error_calls: rows.filter((r) => r.status === 'error').length, stopped_calls: rows.filter((r) => r.status === 'stopped').length,
      units: rows.reduce((v, r) => v + r.quota, 0), prompt_tokens: rows.reduce((v, r) => v + r.prompt_tokens, 0),
      completion_tokens: rows.reduce((v, r) => v + r.completion_tokens, 0), cache_tokens: rows.reduce((v, r) => v + r.cache_tokens, 0) }]];
    return [rows.map((row) => { const r = clone(row); const detail = JSON.parse(r.detail || '{}') || {};
      r.input_recorded = r.input_text != null ? 1 : 0;
      r.output_recorded = r.output_text != null || Object.hasOwn(detail, 'output_text') ? 1 : 0;
      r.output_text ||= detail.output_text || ''; r.billing_unknown = detail.billing_known === false ? 1 : 0;
      r.input_truncated = detail.input_truncated ? 1 : 0; r.output_truncated = detail.output_truncated ? 1 : 0;
      r.request_prompt_truncated = detail.request_prompt_truncated ? 1 : 0;
      r.billing_details = detail.billing_details || null;
      if (!s.includes(', detail, user_agent')) { delete r.detail; delete r.user_agent; delete r.request_prompt_text; } return r; })];
  }
  throw new Error(`Uncovered fixture SQL: ${s}`);
};
pool.query = (sql, args) => query(state, sql, args);
pool.getConnection = async () => {
  let pending;
  let committed = false;
  return {
    beginTransaction: async () => { pending = clone(state); }, query: (sql, args) => query(pending, sql, args),
    commit: async () => { state = pending; committed = true; commits++;
      if (ambiguousCommit && pending.logs.length) { ambiguousCommit = false; throw new Error('fixture committed then connection lost'); } },
    rollback: async () => { if (!committed) rollbacks++; }, release() {},
  };
};
const app = express(); app.use('/api/chat', chat); app.use('/api/log', logs);
app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.code || 'fixture-error' }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const reset = () => {
  channelType = 'openai'; channelModels = model; fixtureRate = 1;
  userId++; channelId++; queries = []; requests = commits = rollbacks = messageFailures = tokenFailures = insertFailures = 0; ambiguousCommit = false;
  state = { user: { id: userId, username: 'fixture', role: 1, status: 1, token_version: 0, quota: initial, used_quota: 0, request_count: 0 },
    token: { id: userId + 1000, user_id: userId, name: 'fixture', key_str: 'fixture-chat-only', status: 1, expired_time: -1,
      group_name: 'fixture', model_limits: model, remain_quota: initial, used_quota: 0, unlimited_quota: 0 },
    session: { id: `fixture-${userId}`, user_id: userId, title: '测试会话', model, agent: 'general', settings: '{}', todo: '[]',
      message_count: 0, cost_units: 0, prompt_tokens: 0, completion_tokens: 0 }, messages: [], logs: [], nextMessage: 0, nextLog: 0 };
  jwt = signToken(state.user); invalidatePrices(); clearGroupConfigCache(); invalidateChannelCache(); resetChannelState(channelId);
};
const api = (url, body = null) => fetch(base + url, { method: body ? 'POST' : 'GET',
  headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
const run = async (extra = {}) => {
  const res = await api('/api/chat/run', { sessionId: state.session.id, text: input, keyId: state.token.id, ...extra });
  const body = await res.text();
  if (res.status !== 200) return { status: res.status, data: JSON.parse(body) };
  await new Promise((r) => setTimeout(r, 10)); // refund完成后比较余额
  const events = body.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  return { status: res.status, events, final: events.findLast((e) => ['done', 'error', 'stopped'].includes(e.type)) };
};
const get = async (url) => { const res = await api(url); assert.equal(res.status, 200); return (await res.json()).data; };
const until = async (predicate) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('fixture等待超时'); };
const balance = (units) => {
  assert.equal(state.user.quota, initial - units); assert.equal(state.user.used_quota, units);
  assert.equal(state.token.remain_quota, initial - units); assert.equal(state.token.used_quota, units);
};
const finalMessage = (result, status) => {
  assert.equal(result.status, 200); assert.ok(result.final, '有最终SSE事件'); assert.equal(result.final.message.status, status);
  assert.equal(state.messages.length, 2); assert.equal(result.final.message.seq, 2); assert.ok(result.final.message.id > 0);
  const row = state.messages[1]; assert.equal(row.status, status); assert.ok(row.elapsed_ms >= 0);
  return result.final.message;
};
const oneLog = (status) => {
  assert.equal(state.logs.length, 1); const row = state.logs[0];
  assert.equal(row.is_usage, 1); assert.equal(row.status, status); assert.equal(row.input_text, input);
  assert.equal(row.token_id, state.token.id); assert.equal(row.user_id, state.user.id);
  const bill = JSON.parse(row.detail).billing_details;
  assert.equal(bill.version, 1); assert.equal(bill.multiplier, fixtureRate);
  if (JSON.parse(row.detail).billing_known !== false) assert.equal(bill.charged_cost_units, row.quota);
  return row;
};
const sse = (frames) => { behavior = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frames); }; };
const seed = () => { state.messages = [
  { id: 1, session_id: state.session.id, user_id: userId, seq: 1, role: 'user', parts: '[{"type":"text","text":"旧提问"}]', cost: 0 },
  { id: 2, session_id: state.session.id, user_id: userId, seq: 2, role: 'assistant', parts: '[{"type":"text","text":"旧回答"}]', cost: .003, prompt_tokens: 30, completion_tokens: 3 },
]; state.nextMessage = 2; state.session.message_count = 2; state.session.cost_units = 30; state.session.prompt_tokens = 30; state.session.completion_tokens = 3; };
let passed = 0;
const test = async (name, fn) => { reset(); await fn(); passed++; console.log(`  ok  ${name}`); };
try {
  for (const status of [400, 401, 429, 502]) await test(`HTTP${status}仅失败usage且刷新保留错误/0费用/未知首T`, async () => {
    behavior = (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":{"message":"https://secret.invalid/?key=DO_NOT_LEAK","code":"fixture_error"}}'); };
    const result = await run(); const message = finalMessage(result, 'error'); const row = oneLog('error'); balance(0);
    assert.equal(row.type, 4); assert.equal(row.prompt_tokens, 0); assert.equal(row.completion_tokens, 0); assert.equal(row.quota, 0);
    assert.equal(message.cost, 0); assert.equal(message.firstTokenMs, null); assert.equal(row.first_token_known, 0);
    assert.ok(row.request_prompt_text.includes('用户原文')); assert.ok(row.request_prompt_text !== input);
    assert.equal(JSON.parse(row.detail).http_status, status);
    assert.equal(row.retry_count, status === 502 ? 2 : 0); assert.equal(message.retryCount, row.retry_count);
    assert.ok(!JSON.stringify(message).includes('DO_NOT_LEAK')); assert.ok(!row.content.includes('DO_NOT_LEAK'));
    const history = (await get(`/api/chat/sessions/${state.session.id}`)).messages;
    assert.equal(history[1].id, message.id); assert.equal(history[1].seq, message.seq); assert.equal(history[1].status, 'error');
    assert.ok(history[1].parts.some((p) => p.type === 'error')); assert.deepEqual(history[1].tokens, message.tokens);
    assert.equal(history[1].cost, 0); assert.equal(history[1].firstTokenMs, null);
    const own = await get('/api/log/usage?status=error'); assert.equal(own.total, 1); assert.equal(own.items[0].input_text, input);
    assert.equal(own.items[0].input_recorded, true); assert.equal(own.items[0].output_recorded, true);
    assert.ok(!('request_prompt_text' in own.items[0])); assert.ok(!('detail' in own.items[0]));
    assert.equal((await get('/api/log/operation')).total, 0); const summary = await get('/api/log/usage/summary?status=error');
    assert.equal(summary.calls, 1); assert.equal(summary.errors, 1); assert.equal(summary.units, 0);
  });
  await test('部分输出错误真实usage/缓存/首T/费用在同事务保存且无重复行', async () => {
    sse(frame({ choices: [{ delta: { content: 'PARTIAL' } }] }) + frame({ usage }) + frame({ error: { code: 'fixture_error', message: 'fixture failed' } }));
    const result = await run(); const message = finalMessage(result, 'error'); const row = oneLog('error');
    const expected = computeCost({ price: await getPrice(model), promptTokens: 1700, completionTokens: 300, cacheTokens: 500 });
    balance(expected); assert.equal(row.quota, expected); assert.equal(message.cost, expected / 10000);
    assert.deepEqual(message.tokens, { prompt: 1700, completion: 300, cache: 500 }); assert.equal(row.output_text, 'PARTIAL');
    assert.equal(row.first_token_known, 1); assert.ok(message.parts.some((p) => p.text === 'PARTIAL'));
    const audit = JSON.parse(row.detail).model_calls[0];
    assert.equal(audit.requested_model, model); assert.equal(audit.upstream_model, model);
    assert.equal(audit.pricing_model, model);
    assert.ok(message.parts.some((p) => p.type === 'error')); assert.equal(commits, 3); // user + settle + assistant
  });
  await test('usage-only失败有输入费用但首T未知', async () => {
    sse(frame({ usage: { prompt_tokens: 1700, completion_tokens: 0, cached_tokens: 500 } }) + frame({ error: { code: 'fixture_error', message: 'fixture failed' } }));
    const message = finalMessage(await run(), 'error'); const row = oneLog('error'); balance(row.quota);
    assert.ok(row.quota > 0); assert.equal(row.output_text, ''); assert.equal(message.firstTokenMs, null); assert.equal(row.first_token_known, 0);
  });
  await test('上游明确降档后部分失败按实际档扣费且顶层审计模型/单价一致', async () => {
    sse(frame({ model: 'glm-4.7', service_status: { model_fallback: { fallback_triggered: true, original_model: model } },
      choices: [{ delta: { content: 'FALLBACK_PARTIAL' } }] }) + frame({ usage }) + frame({ error: { message: 'fixture failed' } }));
    finalMessage(await run(), 'error'); const row = oneLog('error'); const audit = JSON.parse(row.detail);
    const price = await getPrice('glm-4.7'); const expected = computeCost({ price, promptTokens: 1700, completionTokens: 300, cacheTokens: 500 });
    balance(expected); assert.equal(row.quota, expected); assert.equal(row.model, 'glm-4.7');
    assert.equal(audit.requested_model, model); assert.equal(audit.upstream_model, 'glm-4.7');
    assert.equal(audit.pricing_model, 'glm-4.7'); assert.deepEqual(audit.price, { in: .6, out: 2.2, cache: .11 });
    assert.equal(audit.model_calls[0].pricing_model, audit.pricing_model);
  });
  await test('完整回复成功一行消费日志且默认Key正确扣费', async () => {
    sse(frame({ choices: [{ delta: { content: 'COMPLETE' } }] }) + frame({ usage }) + 'data: [DONE]\n\n');
    const message = finalMessage(await run({ keyId: 0 }), 'success'); const row = oneLog('success'); balance(row.quota);
    assert.equal(row.type, 2); assert.deepEqual(message.tokens, { prompt: 1700, completion: 300, cache: 500 });
    assert.equal(message.id, (await get(`/api/chat/sessions/${state.session.id}`)).messages[1].id);
  });
  for (const partial of [false, true]) await test(`Cline实际free SKU${partial ? '部分失败' : '成功'}渠道价0与平台原始费/倍率扣费分别保存`, async () => {
    channelType = 'cline'; channelModels = `${model}:free`; fixtureRate = 1.7;
    let sentModel;
    behavior = (req, res) => {
      let body = ''; req.on('data', (part) => { body += part; });
      req.on('end', () => {
        sentModel = JSON.parse(body).model;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frame({ model, choices: [{ delta: { content: 'FREE_SKU_RESULT' } }] }) + frame({ usage }) +
          (partial ? frame({ error: { message: 'fixture partial failure' } }) : 'data: [DONE]\n\n'));
      });
    };
    finalMessage(await run(), partial ? 'error' : 'success'); const row = oneLog(partial ? 'error' : 'success');
    const bill = JSON.parse(row.detail).billing_details;
    assert.equal(sentModel, `${model}:free`, '实际发出的SKU，而非SSE返回的规范名');
    assert.deepEqual(bill.channel_quote.price, { in: 0, out: 0, cache: 0 });
    assert.equal(bill.channel_quote.model, sentModel); assert.equal(bill.channel_quote.provider, 'cline');
    assert.equal(bill.raw_cost_od, .00205); assert.equal(bill.base_cost_units, 21);
    assert.equal(bill.multiplier, 1.7); assert.equal(bill.charged_cost_units, 36); balance(36);
    const own = (await get('/api/log/usage')).items[0];
    assert.equal(own.billing_details.raw_cost_od, .00205);
    assert.equal(own.billing_details.charged_cost_units, 36);
    assert.ok(!('channel_quote' in own.billing_details)); assert.ok(!('calls' in own.billing_details));
    assert.ok(!JSON.stringify(own).includes('channel_free_sku'));
    state.user.role = 100; jwt = signToken(state.user); const admin = (await get('/api/log/usage')).items[0];
    assert.deepEqual(admin.original_price, { in: 0, out: 0, cache: 0 });
  });
  await test('连续两次非法工具协议持久化失败，真实两次calls各记费一次且刷新仍有错误', async () => {
    sse(frame({ choices: [{ delta: { content: '<tool_call>这不是 JSON</tool_call>' } }] }) + frame({ usage }) + 'data: [DONE]\n\n');
    const result = await run(); const message = finalMessage(result, 'error'); const row = oneLog('error');
    const bill = JSON.parse(row.detail).billing_details;
    assert.equal(requests, 2); assert.equal(row.error_code, 'TOOL_PROTOCOL_ERROR');
    assert.equal(bill.call_count, 2); assert.equal(bill.calls.length, 2);
    assert.equal(bill.base_cost_units, 42); assert.equal(bill.charged_cost_units, 42); balance(42);
    assert.equal(row.prompt_tokens, 3400); assert.equal(row.completion_tokens, 600); assert.equal(row.cache_tokens, 1000);
    assert.equal(bill.raw_cost_od, .0041); assert.equal(bill.components.input.tokens, 2400);
    assert.ok(message.parts.some((p) => p.type === 'error' && p.code === 'TOOL_PROTOCOL_ERROR'));
    assert.ok(!JSON.stringify(message.parts).includes('这不是 JSON'));
    const saved = (await get(`/api/chat/sessions/${state.session.id}`)).messages[1];
    assert.equal(saved.status, 'error'); assert.equal(saved.cost, .0042); assert.equal(saved.id, message.id);
    assert.ok(saved.parts.some((p) => p.type === 'error' && p.code === 'TOOL_PROTOCOL_ERROR'));
    const own = (await get('/api/log/usage?status=error')).items[0];
    assert.equal(own.billing_details.call_count, 2); assert.ok(!('calls' in own.billing_details));
  });
  await test('Key更新失败账户/Key/消费日志一起回滚，费用显示待核查', async () => {
    sse(frame({ choices: [{ delta: { content: 'COMPLETE' } }] }) + frame({ usage }) + 'data: [DONE]\n\n'); tokenFailures = 1;
    const message = finalMessage(await run(), 'error'); const row = oneLog('error'); balance(0);
    assert.equal(message.cost, null); assert.equal(row.quota, 0); assert.ok(rollbacks > 0);
    assert.equal((await get(`/api/chat/sessions/${state.session.id}`)).messages[1].cost, null);
  });
  await test('usage INSERT失败扣费全回滚，不重扣，仍保存失败消息', async () => {
    sse(frame({ choices: [{ delta: { content: 'COMPLETE' } }] }) + frame({ usage }) + 'data: [DONE]\n\n'); insertFailures = 1;
    const message = finalMessage(await run(), 'error'); oneLog('error'); balance(0); assert.equal(message.cost, null); assert.ok(rollbacks > 0);
  });
  await test('COMMIT已生效后断连接不重复扣费/记录/退预占', async () => {
    sse(frame({ choices: [{ delta: { content: 'COMPLETE' } }] }) + frame({ usage }) + 'data: [DONE]\n\n'); ambiguousCommit = true;
    const message = finalMessage(await run(), 'error'); const row = oneLog('error'); balance(row.quota);
    assert.ok(row.quota > 0); assert.equal(message.cost, null); assert.equal(state.user.request_count, 1);
  });
  await test('重试模型校验失败保留旧轮原始数据', async () => {
    seed(); const old = clone(state.messages); const result = await run({ retryFromSeq: 1, model: 'unavailable-fixture' });
    assert.equal(result.status, 400); assert.equal(result.data.data.accepted, false); assert.deepEqual(state.messages, old);
    assert.equal(requests, 0); balance(0); assert.equal(state.logs.length, 0);
  });
  await test('重试新消息INSERT失败事务恢复已删旧轮', async () => {
    seed(); const old = clone(state.messages); messageFailures = 1; const result = await run({ retryFromSeq: 1 });
    assert.equal(result.status, 500); assert.equal(result.data.data.accepted, false); assert.deepEqual(state.messages, old); balance(0);
    assert.equal(requests, 0); assert.equal(state.session.cost_units, 30);
  });
  await test('重试成功使用稳定seq/新id，不退旧实际费用和累计tokens', async () => {
    seed(); sse(frame({ choices: [{ delta: { content: 'RETRY' } }] }) + frame({ usage }) + 'data: [DONE]\n\n');
    const result = await run({ retryFromSeq: 1 }); const message = finalMessage(result, 'success'); const row = oneLog('success'); balance(row.quota);
    assert.equal(result.events[0].userMessage.seq, 1); assert.ok(result.events[0].userMessage.id > 2); assert.ok(message.id > 2);
    assert.equal(state.session.message_count, 2); assert.equal(state.session.cost_units, 30 + row.quota);
    assert.equal(state.session.prompt_tokens, 30 + row.prompt_tokens);
  });
  await test('文档-only重新生成不误判空输入', async () => {
    sse(frame({ choices: [{ delta: { content: 'DOC_OK' } }] }) + frame({ usage }) + 'data: [DONE]\n\n');
    const result = await run({ text: '', docs: [{ name: 'fixture.txt', text: 'fixture document' }] });
    assert.equal(result.status, 200); assert.equal(result.final.type, 'done'); assert.ok(result.events[0].userMessage.parts.some((p) => p.type === 'file'));
  });
  await test('管理员额外上游prompt，本人原文不会冒充系统模板', async () => {
    behavior = (_req, res) => { res.writeHead(400); res.end('{"error":{"message":"fixture fail"}}'); }; await run();
    state.user.role = 100; jwt = signToken(state.user); const admin = (await get('/api/log/usage')).items[0];
    assert.equal(admin.input_text, input); assert.ok(admin.request_prompt_text.includes('用户原文')); assert.ok('detail' in admin);
  });
  for (const partial of [false, true]) await test(`${partial ? '部分输出' : '零输出'}停止落库stopped并只收费真实消耗`, async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      if (partial) res.write(frame({ choices: [{ delta: { content: 'STOP_PARTIAL' } }] }) + frame({ usage }));
    };
    const pending = run(); await until(() => requests === 1); await new Promise((r) => setTimeout(r, 20));
    const stopped = await api(`/api/chat/sessions/${state.session.id}/stop`, {}); assert.equal(stopped.status, 200);
    const message = finalMessage(await pending, 'stopped'); const row = oneLog('stopped'); balance(row.quota);
    assert.equal(row.type, 4); assert.equal(row.status, 'stopped'); assert.ok(message.parts.some((p) => p.type === 'error'));
    assert.equal((await get(`/api/chat/sessions/${state.session.id}`)).messages[1].status, 'stopped');
    if (partial) { assert.ok(row.quota > 0); assert.deepEqual(message.tokens, { prompt: 1700, completion: 300, cache: 500 }); }
    else { assert.equal(row.quota, 0); assert.equal(message.firstTokenMs, null); }
    const summary = await get('/api/log/usage/summary?status=stopped'); assert.equal(summary.stopped, 1); assert.equal(summary.errors, 0);
  });
  await test('客户端断开不终止后台，失败轮完成后刷新可恢复完整内容', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ choices: [{ delta: { content: 'DISCONNECTED_PARTIAL' } }] }) + frame({ usage }));
      setTimeout(() => res.end(frame({ error: { code: 'fixture_error', message: 'fixture failed' } })), 50);
    };
    const response = await api('/api/chat/run', { sessionId: state.session.id, text: input, keyId: state.token.id });
    assert.equal(response.status, 200); await response.body.cancel();
    await until(async () => !(await get(`/api/chat/sessions/${state.session.id}/running`)).running);
    const history = (await get(`/api/chat/sessions/${state.session.id}`)).messages;
    assert.equal(history.length, 2); assert.equal(history[1].status, 'error');
    assert.equal(history[1].parts.find((p) => p.type === 'text').text, 'DISCONNECTED_PARTIAL');
    const row = oneLog('error'); balance(row.quota); assert.ok(row.quota > 0);
  });
  await test('同会话运行锁拒绝重试时不会删现有轮或多扣费', async () => {
    behavior = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); };
    const pending = run(); await until(() => requests === 1); const old = clone(state.messages);
    const result = await run({ retryFromSeq: 1 }); assert.equal(result.status, 409); assert.equal(result.data.data.accepted, false);
    assert.deepEqual(state.messages, old); assert.equal(requests, 1);
    await api(`/api/chat/sessions/${state.session.id}/stop`, {}); finalMessage(await pending, 'stopped'); balance(0);
  });
  await test('历史type2输出本人可读，type4不回填usage；三个状态筛选不重复统计', async () => {
    const base = { user_id: userId, username: 'fixture', created_at: Math.floor(Date.now()/1000), quota: 0, prompt_tokens: 0, completion_tokens: 0, cache_tokens: 0 };
    state.logs = [
      { ...base, id: 1, type: 2, is_usage: 0, status: '', detail: JSON.stringify({ prompt_text: 'HISTORICAL_SYSTEM_TEMPLATE', output_text: '历史输出' }) },
      { ...base, id: 2, type: 4, is_usage: 0, status: '', detail: '{}' },
      { ...base, id: 3, type: 4, is_usage: 1, status: 'error', detail: '{}' },
      { ...base, id: 4, type: 4, is_usage: 1, status: 'stopped', detail: '{}' },
    ];
    const rows = await get('/api/log/usage'); assert.equal(rows.total, 3);
    assert.equal(rows.items[0].input_text, ''); assert.equal(rows.items[0].output_text, '历史输出');
    assert.equal(rows.items[0].input_recorded, false); assert.equal(rows.items[0].output_recorded, true);
    assert.equal(rows.items[1].input_recorded, false); assert.equal(rows.items[1].output_recorded, false);
    assert.ok(!JSON.stringify(rows).includes('HISTORICAL_SYSTEM_TEMPLATE'));
    for (const status of ['success', 'error', 'stopped']) {
      assert.equal((await get(`/api/log/usage?status=${status}`)).total, 1);
      assert.equal((await get(`/api/log/usage/summary?status=${status}`)).calls, 1);
    }
    assert.equal((await get('/api/log/operation')).total, 1);
  });
  await test('HTTP400短输入原因安全展示，URL/凭据不传入最终消息和日志', async () => {
    behavior = (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'input is too short; https://private.invalid/key=DO_NOT_LEAK; minimum length 10', code: 'fixture_error' } })); };
    const message = finalMessage(await run(), 'error'); const row = oneLog('error'); balance(0);
    const error = message.parts.find((p) => p.type === 'error'); assert.ok(error.message.includes('HTTP 400')); assert.ok(error.message.includes('输入内容过短'));
    assert.ok(!JSON.stringify(message).includes('DO_NOT_LEAK')); assert.ok(!row.content.includes('private.invalid'));
  });
  await test('新增空用户文本与无模型输出均明确recorded，不冒充历史缺失', async () => {
    behavior = (_req, res) => { res.writeHead(400); res.end('{"error":{"message":"fixture rejected"}}'); };
    await run({ text: '', docs: [{ name: 'fixture.txt', text: 'fixture doc' }] });
    const row = (await get('/api/log/usage')).items[0]; assert.equal(row.input_text, ''); assert.equal(row.output_text, '');
    assert.equal(row.input_recorded, true); assert.equal(row.output_recorded, true); balance(0);
  });
  await test('HTTP400非法短输入/蒸馏/心跳探测为固定中文说明，无上游敏感串', async () => {
    behavior = (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Illegal short-input detected: distillation or heartbeat probing. https://private.invalid/credentials?key=DO_NOT_LEAK', code: 'fixture_error' } })); };
    const message = finalMessage(await run(), 'error'); const row = oneLog('error'); balance(0);
    const error = message.parts.find((p) => p.type === 'error'); assert.ok(error.message.includes('HTTP 400'));
    assert.ok(error.message.includes('上游按请求审核策略拒绝')); assert.ok(!JSON.stringify(message).includes('DO_NOT_LEAK'));
    assert.ok(!error.message.includes('补充实际问题'), '不能把上游审核结论当成用户提问无效');
    assert.ok(!row.content.includes('private.invalid')); assert.equal(row.error_code, 'CHANNEL_BAD_REQUEST');
  });
  await test('未知上游失败正文不转发，只保留HTTP状态与分类code', async () => {
    behavior = (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'unknown private body Authorization=Bearer DO_NOT_LEAK at https://private.invalid/internal', code: 'fixture_error' } })); };
    const message = finalMessage(await run(), 'error'); const row = oneLog('error'); balance(0);
    const error = message.parts.find((p) => p.type === 'error'); assert.equal(error.message, '上游请求失败（HTTP 400），请检查模型或稍后重试。');
    assert.ok(!JSON.stringify(message).includes('DO_NOT_LEAK')); assert.ok(!row.content.includes('private.invalid'));
    assert.equal(row.error_code, 'CHANNEL_BAD_REQUEST'); assert.equal(JSON.parse(row.detail).http_status, 400);
  });
  console.log(`  chat 失败/原文/账单 HTTP 回归 ${passed} 项通过`);
} finally {
  pool.query = originalQuery; pool.getConnection = originalConnection;
  invalidatePrices(); clearGroupConfigCache(); invalidateChannelCache();
  await new Promise((r) => server.close(r)); await new Promise((r) => upstream.close(r)); await pool.end();
}
}
