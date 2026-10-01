// 真 HTTP 网关→调度→OpenAI适配器→环回上游；DB换成支持提交/回滚的内存账本。
// 同时检查实际余额、Key预占、唯一usage行与原文。任何未覆盖SQL立即失败。
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { pool } from "../src/db.js";
import gateway from "../src/routes/gateway.js";
import { invalidateChannelCache, resetChannelState, channelRuntimeState } from "../src/services/router.js";
import { computeCost, splitTokens, getPrice } from "../src/services/pricing.js";

const model = "fixture-billing-model";
const initial = 1000000;
const input = "  客户原文 <｜User｜> 保留模板\n第二行  ";
const system = "FIXTURE_SYSTEM_DO_NOT_USE_AS_USER_INPUT";
const actualUsage = { prompt_tokens: 1700, completion_tokens: 300, cached_tokens: 500 };
const frame = (ev) => `data: ${JSON.stringify(ev)}\n\n`;
const delta = { choices: [{ delta: { content: "PARTIAL" } }] };
const fail = { error: { code: "fixture_error", message: "fixture rejected" } };
const unsafeMessage = "https://fixture-secret.invalid/?key=sk-fixture-DO_NOT_LEAK Bearer fixture-DO_NOT_LEAK";
let behavior;
let state;
let channelId = 9000;
let insertFailures = 0;
let tokenFailures = 0;
let ambiguousCommit = false;
let commits = 0;
let rollbacks = 0;
let upstreamRequests = 0;
let channelWrites = [];
let warnings = [];
const originalWarn = console.warn;
console.warn = (...values) => { warnings.push(values.join(" ")); originalWarn(...values); };
const upstream = http.createServer((req, res) => { req.resume(); upstreamRequests += 1; behavior(req, res); });
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
const clone = (v) => structuredClone(v);
const query = async (store, sql, params = []) => {
  const s = String(sql).replace(/\s+/g, " ").trim();
  assert.equal((s.match(/\?/g) || []).length, params.length, `SQL placeholder count: ${s}`);
  if (/FROM tokens WHERE key_str =/.test(s)) return [[clone(store.token)]];
  if (/FROM users WHERE id =/.test(s)) return [[clone(store.user)]];
  if (/FROM model_prices/.test(s)) return [[{ model, input_price: 1, output_price: 2, cache_price: 0.5,
    offpeak_input_price: null, offpeak_output_price: null, offpeak_cache_price: null }]];
  if (/FROM channels/.test(s)) return [[{ id: channelId, name: "fixture-channel", type: "openai", status: 1,
    models: model, group_list: "[]", base_url: upstreamBase, api_key: "fixture-upstream-only",
    other: JSON.stringify({ method: "api", allow_private_upstream: true }) }]];
  if (/^UPDATE channels/.test(s)) { channelWrites.push({ sql: s, params: clone(params) }); return [{ affectedRows: 1 }]; }
  if (/^UPDATE users SET quota = quota -/.test(s)) {
    const [units] = params;
    if (s.includes("AND quota >=") && store.user.quota < units) return [{ affectedRows: 0 }];
    store.user.quota -= units; store.user.used_quota += units; store.user.request_count += 1;
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE tokens SET remain_quota = remain_quota -/.test(s)) {
    if (store.token.remain_quota < params[0]) return [{ affectedRows: 0 }];
    store.token.remain_quota -= params[0]; return [{ affectedRows: 1 }];
  }
  if (/^UPDATE tokens SET remain_quota = remain_quota \+/.test(s)) {
    store.token.remain_quota += params[0]; return [{ affectedRows: 1 }];
  }
  if (/^UPDATE tokens SET used_quota/.test(s)) {
    if (tokenFailures > 0) { tokenFailures -= 1; throw new Error("fixture token update failed"); }
    store.token.used_quota += params[0];
    store.token.remain_quota = Math.max(0, store.token.remain_quota + params[2] - params[3]);
    return [{ affectedRows: 1 }];
  }
  if (/SELECT remain_quota FROM tokens/.test(s)) return [[{ remain_quota: store.token.remain_quota }]];
  if (/^INSERT INTO logs/.test(s)) {
    if (insertFailures > 0) { insertFailures -= 1; throw new Error("fixture usage INSERT failed"); }
    const columns = s.match(/^INSERT INTO logs \((.*?)\) VALUES/)[1].split(",").map((v) => v.trim());
    const row = Object.fromEntries(columns.map((key, i) => [key, params[i]]));
    store.logs.push(row); return [{ affectedRows: 1, insertId: store.logs.length }];
  }
  throw new Error(`Uncovered fixture SQL: ${s}`);
};
const originalQuery = pool.query;
const originalGetConnection = pool.getConnection;
pool.query = (sql, args) => query(state, sql, args);
pool.getConnection = async () => {
  let pending;
  let committed = false;
  return {
    beginTransaction: async () => { pending = clone(state); },
    query: (sql, args) => query(pending, sql, args),
    commit: async () => { state = pending; committed = true; commits += 1;
      if (ambiguousCommit) { ambiguousCommit = false; throw new Error("fixture connection lost after commit"); } },
    rollback: async () => { if (!committed) rollbacks += 1; },
    release() {},
  };
};
const app = express();
app.use("/v1", gateway);
app.use((err, _req, res, _next) => res.status(500).json({ error: { message: err.message } }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const paths = ["chat/completions", "messages", "responses"];
const bodyOf = (path, stream = false) => path === "responses"
  ? { model, stream, instructions: system, input: [{ role: "user", content: [{ type: "input_text", text: input }] }] }
  : path === "messages" ? { model, stream, system, max_tokens: 200, messages: [{ role: "user", content: input }] }
    : { model, stream, messages: [{ role: "system", content: system }, { role: "user", content: [{ type: "text", text: input }] }] };
const post = (path, extra = {}) => fetch(`${base}/v1/${path}`, {
  method: "POST", headers: { authorization: "Bearer fixture-gateway-only", "content-type": "application/json" },
  body: JSON.stringify(bodyOf(path, extra.stream)), ...extra,
});
const reset = () => {
  state = { user: { id: 101, username: "fixture", status: 1, quota: initial, used_quota: 0, request_count: 0, group_name: "default" },
    token: { id: 102, user_id: 101, name: "fixture", key_str: "fixture-gateway-only", status: 1, expired_time: -1,
      group_name: "default", model_limits: model, remain_quota: initial, used_quota: 0, unlimited_quota: 0 }, logs: [] };
  channelId += 1; resetChannelState(channelId); invalidateChannelCache();
  insertFailures = 0; tokenFailures = 0; commits = 0; rollbacks = 0; upstreamRequests = 0; channelWrites = []; warnings = [];
};
const sse = (frames) => { behavior = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(frames); }; };
const log = () => {
  assert.equal(state.logs.length, 1, "one usage row per request");
  const row = state.logs[0]; assert.equal(row.is_usage, 1); assert.equal(row.model, model); assert.equal(row.channel_id, channelId);
  assert.equal(row.input_text, input, "raw final user text is preserved");
  assert.ok(row.request_prompt_text.includes(system)); assert.ok(row.request_prompt_text.includes(input));
  assert.equal(row.token_id, 102); assert.ok(row.elapsed_ms >= 0); return row;
};
const balance = (units) => {
  assert.equal(state.user.used_quota, units); assert.equal(state.user.quota, initial - units);
  assert.equal(state.token.used_quota, units); assert.equal(state.token.remain_quota, initial - units);
  assert.equal(state.user.request_count, units > 0 ? 1 : 0);
};
let passed = 0;
const test = async (name, fn) => { reset(); await fn(); passed += 1; console.log(`  ok  ${name}`); };
try {
  for (const path of paths) {
    for (const status of [400, 401, 429, 502]) {
      await test(`${path} HTTP${status}一份失败usage，余额/预占不变`, async () => {
        behavior = (_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(fail)); };
        const r = await post(path); await r.text();
        assert.equal(r.status, status); const row = log(); balance(0);
        assert.equal(row.type, 4); assert.equal(row.status, "error"); assert.equal(row.quota, 0);
        assert.equal(row.prompt_tokens, 0); assert.equal(row.completion_tokens, 0); assert.equal(row.first_token_known, 0);
        assert.equal(JSON.parse(row.detail).http_status, status); assert.equal(row.retry_count, status === 502 ? 2 : 0);
        assert.equal(upstreamRequests, status === 502 ? 3 : 1); assert.equal(commits, 0);
      });
    }
    for (const reason of ["illegal short-input; distillation; heartbeat probing", "unknown upstream failure"]) {
      await test(`${path} 拒绝说明安全且模型/HTTP/错误码保留(${reason.startsWith("illegal") ? "短输入" : "未知"})`, async () => {
        behavior = (_req, res) => { res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "fixture_error", message: `${reason} ${unsafeMessage}` } })); };
        const r = await post(path); const text = await r.text(); const row = log(); balance(0);
        assert.equal(r.status, 400); assert.equal(row.error_code, "CHANNEL_BAD_REQUEST");
        assert.equal(JSON.parse(row.detail).http_status, 400); assert.equal(row.model, model);
        assert.ok(!/fixture-secret\.invalid|DO_NOT_LEAK|Bearer/.test(text + JSON.stringify(row)), "body/URL/key never copied to public error or usage log");
        assert.ok(text.includes(reason.startsWith("illegal") ? "上游按请求审核策略拒绝" : "HTTP 400"));
        assert.ok(row.content.includes(reason.startsWith("illegal") ? "核查" : "稍后重试"));
      });
    }
    for (const status of [401, 502]) {
      await test(`${path} 可重试HTTP${status}渠道状态/持久化/console不泄漏body`, async () => {
        behavior = (_req, res) => { res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "fixture_error", message: unsafeMessage } })); };
        const r = await post(path); const text = await r.text(); const row = log(); balance(0);
        assert.equal(r.status, status); assert.equal(JSON.parse(row.detail).http_status, status);
        assert.equal(row.retry_count, status === 502 ? 2 : 0); assert.equal(upstreamRequests, status === 502 ? 3 : 1);
        const runtime = channelRuntimeState(channelId);
        assert.ok(runtime.last_error.length > 0); assert.ok(channelWrites.some((entry) => entry.sql.includes("last_error")));
        const stored = JSON.stringify({ row, runtime, channelWrites, warnings });
        assert.ok(!/fixture-secret\.invalid|DO_NOT_LEAK|Bearer/.test(text + stored), "retry, runtime recent and UPDATE params contain safe reason only");
      });
    }
    await test(`${path} partial SSE安全失败文案不丢真实usage`, async () => {
      sse(frame(delta) + frame({ usage: actualUsage }) + frame({ error: { code: "fixture_error", message: unsafeMessage } }));
      const r = await post(path, { stream: true }); const text = await r.text(); const row = log();
      assert.ok(text.includes("PARTIAL")); assert.equal(row.output_text, "PARTIAL");
      assert.ok(!/fixture-secret\.invalid|DO_NOT_LEAK|Bearer/.test(text + JSON.stringify(row)));
      assert.equal(row.type, 4); assert.equal(row.prompt_tokens, 1700); assert.equal(row.completion_tokens, 300);
      assert.equal(row.cache_tokens, 500); assert.ok(row.quota > 0); balance(row.quota); assert.equal(commits, 1);
    });
    await test(`${path} partial SSE错误只有一条type4且真实用量/缓存/扣费一致`, async () => {
      sse(frame(delta) + frame({ usage: actualUsage }) + frame(fail));
      const r = await post(path); await r.text(); const row = log();
      const expected = computeCost({ price: await getPrice(model), promptTokens: 1700, completionTokens: 300, cacheTokens: 500 });
      assert.equal(row.type, 4); assert.equal(row.status, "error"); assert.equal(row.prompt_tokens, 1700);
      assert.equal(row.completion_tokens, 300); assert.equal(row.cache_tokens, 500); assert.equal(row.quota, expected);
      assert.equal(row.output_text, "PARTIAL"); assert.equal(row.first_token_known, 1); balance(expected);
      assert.equal(commits, 1); assert.equal(upstreamRequests, 1);
    });
    await test(`${path} usage-only失败输入计费但首T仍未知`, async () => {
      sse(frame({ usage: { prompt_tokens: 1700, completion_tokens: 0, cached_tokens: 500 } }) + frame(fail));
      await (await post(path)).text(); const row = log();
      assert.equal(row.prompt_tokens, 1700); assert.equal(row.completion_tokens, 0); assert.equal(row.output_text, "");
      assert.equal(row.first_token_known, 0); assert.ok(row.quota > 0); balance(row.quota); assert.equal(commits, 1);
    });
    await test(`${path} partial EOF保留原文并按pricing估算一份账单`, async () => {
      sse(frame(delta)); await (await post(path)).text(); const row = log();
      assert.equal(row.error_code, "CHANNEL_STREAM_ERROR"); assert.equal(row.output_text, "PARTIAL");
      const tokens = splitTokens({ prompt: row.request_prompt_text, output: "PARTIAL", upstreamTotal: null });
      const expected = computeCost({ price: await getPrice(model), ...tokens });
      assert.equal(row.quota, expected); balance(expected); assert.equal(commits, 1);
    });
    await test(`${path} 首包前EOF无输入收费和预占损失`, async () => {
      sse(""); await (await post(path)).text(); const row = log(); balance(0);
      assert.equal(row.error_code, "CHANNEL_STREAM_ERROR"); assert.equal(row.first_token_known, 0);
    });
    await test(`${path} 成功也是一份usage且同事务扣费`, async () => {
      sse(frame(delta) + frame({ usage: actualUsage }) + "data: [DONE]\n\n");
      const r = await post(path); await r.text(); assert.equal(r.status, 200); const row = log();
      assert.equal(row.type, 2); assert.equal(row.status, "success"); assert.equal(row.output_text, "PARTIAL");
      balance(row.quota); assert.equal(commits, 1);
    });
    for (const failure of ["insert", "token"]) {
      await test(`${path} ${failure}失败事务回滚，不留扣费无记录`, async () => {
        sse(frame(delta) + frame({ usage: actualUsage }) + frame(fail));
        if (failure === "insert") insertFailures = 1; else tokenFailures = 1;
        await (await post(path)).text(); const row = log(); balance(0);
        assert.equal(row.type, 4); assert.equal(row.quota, 0); assert.equal(row.output_text, "PARTIAL");
        assert.equal(commits, 0); assert.equal(rollbacks, 1);
      });
    }
    await test(`${path} 已提交后连接丢失也不重复扣费/写账单`, async () => {
      sse(frame(delta) + frame({ usage: actualUsage }) + frame(fail)); ambiguousCommit = true;
      await (await post(path)).text(); const row = log(); balance(row.quota);
      assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(state.logs.length, 1);
    });
    await test(`${path} 客户端停止不先退hold再重复补回`, async () => {
      behavior = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame(delta)); };
      const ctrl = new AbortController();
      const r = await post(path, { stream: true, signal: ctrl.signal });
      const reader = r.body.getReader(); await reader.read(); ctrl.abort();
      for (let i = 0; i < 100 && !state.logs.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      const row = log(); assert.equal(row.status, "stopped"); assert.equal(row.type, 4); balance(row.quota);
      assert.equal(commits, 1);
    });
  }
} finally {
  server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
  pool.query = originalQuery; pool.getConnection = originalGetConnection;
  console.warn = originalWarn;
}
console.log(`  网关真实 HTTP 失败账单回归 ${passed} 项通过`);
