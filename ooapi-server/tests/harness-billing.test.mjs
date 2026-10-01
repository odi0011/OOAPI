// 真跑 harness/工具/执行器的内存上游：验证失败步只收一次、停止可打断响应体。
// 只替换模块依赖，不访问数据库/公网，不需要额外运行参数或测试依赖。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeUsage } from "../src/services/pricing.js";
import { USAGE_SQL } from "../src/services/log.js";

const audit = {
  crypto,
  normalizeUsage,
  USAGE_SQL,
  complete: null,
  adapter: null,
  pool: { query: async () => [[], []] },
  // 把工具的 15s 截止缩短，验证的是响应体仍受同一截止控制。
  setTimeout: (fn, ms) => setTimeout(fn, ms === 15000 ? 25 : ms),
};
globalThis.__ooHarnessAudit = audit;
const loadMocked = async (relativePath, prelude) => {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
  return import(`data:text/javascript;base64,${Buffer.from(`const audit=globalThis.__ooHarnessAudit;\n${prelude}\n${source}`).toString("base64")}`);
};
const tools = await loadMocked("../src/services/harness/tools.js", `
  const assertPublicUrl=async (v)=>new URL(v);
  const pool=audit.pool;
  const runCompletion=(o)=>audit.complete(o);
  const billableFailedCall=(...args)=>audit.executor.billableFailedCall(...args);
  const modelForChannelMatch=(v)=>v;
  const setTimeout=audit.setTimeout;
  const USAGE_SQL=audit.USAGE_SQL;
`);
audit.tools = tools;
const harness = await loadMocked("../src/services/harness/loop.js", `
  const crypto=audit.crypto;
  const runCompletion=(o)=>audit.complete(o);
  const modelForChannelMatch=(v)=>v;
  const buildSystemPrompt=()=>"SYSTEM_CONTEXT";
  const SUBAGENTS=[{id:"explore",tools:[]}];
  const {toolSpecs,runTool}=audit.tools;
  const DEFAULT_MAX_STEPS=8;
`);
const executor = await loadMocked("../src/services/execute.js", `
  const pool=audit.pool;
  const getNumberOption=(key)=>key==="request_timeout_ms"?1000:(audit.retryTimes || 0);
  const selectChannels=async ()=>audit.channels || [{id:1,name:"mock",type:"mock"}];
  const getAdapter=async ()=>audit.adapter;
  const markChannelError=async ()=>{};
  const markChannelOk=async ()=>{};
  const withChannelLimit=(_channel,fn)=>fn();
  const explainNoChannel=async ()=>null;
  const resolveAliasSync=(v)=>v;
  const recordChannelSwitch=()=>{};
  const normalizeUsage=audit.normalizeUsage;
`);
audit.executor = executor;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const mockResult = (content) => ({ content, usage: { prompt_tokens: 10, completion_tokens: 20 }, channel: { id: 1, name: "mock" } });
const harnessOptions = (toolIds, calls) => ({
  session: {}, agent: { tools: toolIds }, settings: { tools: toolIds }, model: "mock-model",
  userText: "test", onCall: (call) => calls.push(call),
});
const interrupted = () => Object.assign(new Error("mock stream interrupted"), {
  code: "CHANNEL_STREAM_ERROR", upstreamStarted: true, billable: true, channelId: 1, channelName: "mock",
});

await test("失败步上下文只含该步原始正文和思考，不重复成功步", async () => {
  const calls = [];
  let count = 0;
  audit.complete = async (o) => {
    if (++count === 2) {
      o.onDelta("FAILED_BODY");
      o.onReasoning("FAILED_REASONING");
      throw interrupted();
    }
    const content = 'FIRST_BODY<tool_call>{"tool":"todowrite","args":{"todos":[{"content":"one","status":"pending"}]}}</tool_call>';
    o.onDelta(content);
    return mockResult(content);
  };
  await assert.rejects(() => harness.runHarness(harnessOptions(["todowrite"], calls)), (e) => {
    assert.equal(e.billingOutput, "FAILED_BODYFAILED_REASONING");
    assert.ok(e.billingPrompt.includes("SYSTEM_CONTEXT"));
    assert.ok(e.billingFirstTokenAt >= e.billingStartedAt);
    assert.equal(e.channelId, 1);
    assert.equal(calls.length, 1);
    return true;
  });
});

await test("成功子代理与主代理每个实际调用只记一次", async () => {
  const calls = [];
  let count = 0;
  audit.complete = async (o) => {
    const content = ++count === 1
      ? '<tool_call>{"tool":"task","args":{"agent":"explore","prompt":"child"}}</tool_call>'
      : `answer-${count}`;
    o.onDelta(content);
    return mockResult(content);
  };
  const out = await harness.runHarness(harnessOptions(["task"], calls));
  assert.equal(count, 3);
  assert.equal(calls.length, 3);
  assert.equal(out.calls.length, 3);
});

await test("子代理部分失败可继续回答，已产生的失败调用仍只记一次", async () => {
  const calls = [];
  let count = 0;
  audit.complete = async (o) => {
    ++count;
    if (count === 2) {
      o.onDelta("CHILD_PARTIAL");
      throw interrupted();
    }
    const content = count === 1
      ? '<tool_call>{"tool":"task","args":{"agent":"explore","prompt":"child"}}</tool_call>'
      : "final answer";
    o.onDelta(content);
    return mockResult(content);
  };
  const out = await harness.runHarness(harnessOptions(["task"], calls));
  assert.equal(out.text, "final answer");
  assert.equal(count, 3);
  assert.equal(calls.length, 3);
  assert.equal(out.calls.length, 3);
  assert.equal(calls[1].output, "CHILD_PARTIAL");
  assert.equal(calls[1].failed, true);
  assert.equal(calls[1].channelId, 1);
});

await test("在子代理生成时停止，成功步与失败子步骤各留一条账单", async () => {
  const ctrl = new AbortController();
  const calls = [];
  let count = 0;
  audit.complete = async (o) => {
    if (++count === 2) {
      o.onReasoning("CHILD_REASONING");
      ctrl.abort();
      throw interrupted();
    }
    const content = '<tool_call>{"tool":"task","args":{"agent":"explore","prompt":"child"}}</tool_call>';
    o.onDelta(content);
    return mockResult(content);
  };
  await assert.rejects(() => harness.runHarness({ ...harnessOptions(["task"], calls), signal: ctrl.signal }), (e) => {
    assert.equal(e.billingRecorded, true);
    assert.equal(e.calls.length, 2);
    return true;
  });
  assert.equal(count, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].output, "CHILD_REASONING");
});

await test("联网检索部分失败保留隐式调用的正文、思考、上下文和时间", async () => {
  const calls = [];
  audit.complete = async (o) => {
    o.onDelta("SEARCH_BODY");
    o.onReasoning("SEARCH_REASONING");
    throw interrupted();
  };
  const out = await tools.runTool("search", { query: "test query" }, { model: "mock", record: (c) => calls.push(c) });
  assert.equal(out.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].output, "SEARCH_BODYSEARCH_REASONING");
  assert.ok(calls[0].prompt.includes("test query"));
  assert.ok(calls[0].firstTokenAt >= calls[0].startedAt);
});

await test("检索停止后的失败账单先记录，再原样冒泡，防路由重复合成", async () => {
  const ctrl = new AbortController();
  const calls = [];
  const err = interrupted();
  audit.complete = async (o) => {
    o.onDelta("SEARCH_PARTIAL");
    ctrl.abort();
    throw err;
  };
  await assert.rejects(() => tools.runTool("search", { query: "test" }, {
    model: "mock", signal: ctrl.signal, record: (c) => calls.push(c),
  }), (e) => e === err && e.billingRecorded === true);
  assert.equal(calls.length, 1);
  assert.equal(tools.recordFailedCall(err, { record: (c) => calls.push(c) }), false);
  assert.equal(calls.length, 1);
});

await test("无渠道或本地校验失败的检索不合成收费调用", async () => {
  const calls = [];
  audit.complete = async () => { throw Object.assign(new Error("local rejection"), { code: "NO_CHANNEL" }); };
  const out = await tools.runTool("search", { query: "test" }, { model: "mock", record: (c) => calls.push(c) });
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
});

await test("执行器保留主动停止时已经开始的上游消耗标记", async () => {
  const ctrl = new AbortController();
  audit.adapter = { chat: async ({ onDelta }) => {
    onDelta("partial"); ctrl.abort(); throw Object.assign(new Error("aborted"), { code: "CHANNEL_ABORTED" });
  } };
  await assert.rejects(() => executor.runCompletion({ model: "mock", prompt: "context", signal: ctrl.signal }),
    (e) => e.upstreamStarted === true && e.channelId === 1);
});

await test("执行器排除适配器明确的本地能力拒绝", async () => {
  audit.adapter = { chat: async () => { throw Object.assign(new Error("unsupported input"), { code: "VISION_NOT_SUPPORTED" }); } };
  await assert.rejects(() => executor.runCompletion({ model: "mock", prompt: "context", images: [{}] }),
    (e) => e.upstreamStarted === false);
});

await test("开始调用前已停止时不进入适配器也不生成消耗标记", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let entered = false;
  audit.adapter = { chat: async () => { entered = true; return mockResult("unexpected"); } };
  await assert.rejects(() => executor.runCompletion({ model: "mock", prompt: "context", signal: ctrl.signal }),
    (e) => e.upstreamStarted === false);
  assert.equal(entered, false);
});

for (const status of [400, 401, 429, 502]) {
  await test(`HTTP ${status} 拒绝不凭发起标记收整段输入费`, async () => {
    audit.adapter = { chat: async () => {
      throw Object.assign(new Error("upstream rejected"), { code: "CHANNEL_BAD_REQUEST", status });
    } };
    await assert.rejects(() => executor.runCompletion({ model: "mock", prompt: "long input context" }), (e) => {
      assert.equal(e.upstreamStarted, true);
      assert.equal(e.billable, false);
      assert.equal(executor.billableFailedCall(e), null);
      assert.equal(e.status, status);
      assert.equal(e.billingFirstTokenAt, 0);
      return true;
    });
  });
}

await test("零用量零正文拒绝无消费，真实输入用量无正文仍保留账单", async () => {
  for (const promptTokens of [0, 12]) {
    audit.adapter = { chat: async ({ onUsage }) => {
      onUsage({ prompt_tokens: promptTokens, completion_tokens: 0, cached_tokens: 4 });
      throw Object.assign(new Error("stream ended"), { code: "CHANNEL_STREAM_ERROR" });
    } };
    await assert.rejects(() => executor.runCompletion({ model: "mock", prompt: "context" }), (e) => {
      assert.equal(e.billable, promptTokens > 0);
      const call = executor.billableFailedCall(e);
      if (promptTokens > 0) {
        assert.equal(call.usage.prompt_tokens, 12);
        assert.equal(call.usage.cached_tokens, 4);
        assert.equal(call.output, "");
        assert.equal(call.firstTokenAt, 0);
      } else assert.equal(call, null);
      return true;
    });
  }
});

await test("执行器部分失败保留真实usage、正文、推理和首token，工具只记一次", async () => {
  audit.adapter = { chat: async ({ onDelta, onReasoning, onUsage }) => {
    onDelta("PARTIAL"); onReasoning("THINKING");
    onUsage({ prompt_tokens: 15, completion_tokens: 3, cached_tokens: 5 });
    throw Object.assign(new Error("stream failed"), { code: "CHANNEL_STREAM_ERROR", status: 200, retryCount: 2 });
  } };
  const calls = [];
  await assert.rejects(() => executor.runCompletion({ model: "mock", prompt: "context" }), (e) => {
    assert.equal(e.billingOutput, "PARTIALTHINKING");
    assert.equal(e.retryCount, 2);
    assert.ok(e.billingFirstTokenAt >= e.billingStartedAt);
    assert.equal(tools.recordFailedCall(e, { record: (c) => calls.push(c) }), true);
    assert.equal(tools.recordFailedCall(e, { record: (c) => calls.push(c) }), false);
    assert.equal(executor.billableFailedCall(e), null);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].usage.completion_tokens, 3);
});

await test("零消费拒绝可换渠道，所有原地/换渠道重试次数保留且仅成功一单", async () => {
  audit.channels = [{ id: 1, name: "first" }, { id: 2, name: "second" }]; audit.retryTimes = 1;
  const tried = [];
  audit.adapter = { chat: async ({ channel, onDelta }) => {
    tried.push(channel.id);
    if (channel.id === 1) throw Object.assign(new Error("busy"), { code: "CHANNEL_UPSTREAM_BUSY", status: 502, retryCount: 2 });
    onDelta("OK"); return { ...mockResult("OK"), retryCount: 0 };
  } };
  try {
    const r = await executor.runCompletion({ model: "mock", prompt: "context" });
    assert.deepEqual(tried, [1, 2]); assert.equal(r.retryCount, 3); assert.equal(r.channel.id, 2);
  } finally { delete audit.channels; delete audit.retryTimes; }
});

await test("真实usage无输出也不能换渠道重复生成或漏掉前次账单", async () => {
  audit.channels = [{ id: 1, name: "first" }, { id: 2, name: "second" }]; audit.retryTimes = 1;
  let tried = 0;
  audit.adapter = { chat: async ({ onUsage }) => {
    tried += 1; onUsage({ prompt_tokens: 42, completion_tokens: 0 });
    throw Object.assign(new Error("usage then EOF"), { code: "CHANNEL_STREAM_ERROR" });
  } };
  try {
    await assert.rejects(() => executor.runCompletion({ model: "mock", prompt: "context" }), (e) => {
      assert.equal(e.billable, true); assert.equal(e.usage.prompt_tokens, 42); assert.equal(e.channelId, 1);
      assert.equal(e.retryCount, 0); assert.equal(executor.billableFailedCall(e).firstTokenAt, 0); return true;
    });
    assert.equal(tried, 1);
  } finally { delete audit.channels; delete audit.retryTimes; }
});

await test("截止竞争保留usage且阻止迟到回调在结算后追加正文/用量", async () => {
  let deltas = 0;
  audit.adapter = { chat: async ({ onDelta, onUsage }) => {
    onUsage({ prompt_tokens: 42, completion_tokens: 0 });
    await new Promise((r) => setTimeout(r, 1050));
    onDelta("LATE"); onUsage({ prompt_tokens: 999, completion_tokens: 999 });
    return mockResult("LATE");
  } };
  await assert.rejects(() => executor.runCompletion({ model: "mock", prompt: "context", onDelta: () => { deltas += 1; } }), (e) => {
    assert.equal(e.code, "CHANNEL_TIMEOUT"); assert.equal(e.billable, true);
    assert.equal(e.usage.prompt_tokens, 42); assert.equal(e.billingOutput, ""); return true;
  });
  await new Promise((r) => setTimeout(r, 100)); assert.equal(deltas, 0);
});

await test("账号overview/usage/recent含失败和停止使用，排除普通操作错误", async () => {
  const originalQuery = audit.pool.query;
  const rows = [
    { type: 2, is_usage: 0, quota: 100, status: "success", model: "ok-model" },
    { type: 4, is_usage: 1, quota: 200, status: "error", model: "failed-model" },
    { type: 4, is_usage: 1, quota: 0, status: "stopped", model: "stopped-model" },
    { type: 4, is_usage: 0, quota: 9000, status: "", model: "operation-error" },
  ];
  const queries = [];
  audit.pool.query = async (sql, args) => {
    assert.equal((sql.match(/\?/g) || []).length, args.length);
    assert.equal(args[0], 77, "account only reads the current user");
    queries.push(sql);
    if (sql.includes("FROM users")) return [[{ username: "fixture", quota: 1000, used_quota: 300, request_count: 2 }]];
    if (sql.includes("FROM tokens")) return [[{ n: 1, on_: 1 }]];
    assert.ok(sql.includes(USAGE_SQL), "usage queries share the full success/failure predicate");
    const usage = rows.filter(r => r.type === 2 || (r.type === 4 && r.is_usage === 1));
    if (sql.includes("ORDER BY id DESC")) return [usage.map(r => ({ ...r, created_at: 1, elapsed_ms: 10 }))];
    if (sql.includes("GROUP BY model")) return [usage.map(r => ({ model: r.model, n: 1, cost: r.quota }))];
    return [[{ n: usage.length, cost: usage.reduce((n, r) => n + r.quota, 0), d: 1 }]];
  };
  try {
    const ctx = { user: { id: 77 } };
    const overview = await tools.runTool("account", { action: "overview" }, ctx);
    assert.equal(overview.ok, true); assert.match(overview.output, /近 24 小时：3 次调用，消耗 0\.03 OD币/);
    const recent = await tools.runTool("account", { action: "recent" }, ctx);
    assert.equal(recent.ok, true); assert.match(recent.output, /failed-model.*失败/); assert.match(recent.output, /stopped-model.*已停止/);
    assert.ok(!recent.output.includes("operation-error"));
    const usage = await tools.runTool("account", { action: "usage" }, ctx);
    assert.equal(usage.ok, true); assert.match(usage.output, /failed-model/); assert.ok(!usage.output.includes("operation-error"));
    assert.equal(queries.filter(sql => sql.includes("FROM logs")).length, 4);
  } finally { audit.pool.query = originalQuery; }
});

const originalFetch = globalThis.fetch;
try {
  for (const name of ["fetch", "github"]) {
    const args = name === "fetch" ? { url: "https://example.test/page" } : { action: "list", repo: "example/test" };
    for (const stopping of [true, false]) {
      await test(`${name} 的${stopping ? "停止" : "截止"}覆盖收到响应头后的响应体`, async () => {
        const ctrl = new AbortController();
        let bodyAborted = false;
        globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
          start(controller) {
            const timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(name === "github" ? "[]" : "body"));
              controller.close();
            }, 200);
            init.signal.addEventListener("abort", () => {
              bodyAborted = true; clearTimeout(timer);
              controller.error(Object.assign(new Error("mock abort"), { name: "AbortError" }));
            }, { once: true });
          },
        }), { headers: { "content-type": name === "github" ? "application/json" : "text/plain" } });
        const stopTimer = stopping ? setTimeout(() => ctrl.abort(), 5) : null;
        try {
          if (stopping) await assert.rejects(() => tools.runTool(name, args, { signal: ctrl.signal }), (e) => e.name === "AbortError");
          else assert.equal((await tools.runTool(name, args, {})).ok, false);
          assert.equal(bodyAborted, true);
        } finally { clearTimeout(stopTimer); }
      });
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.__ooHarnessAudit;
}
console.log(`  harness 执行/计费回归 ${passed} 项通过`);
// 真实环回 HTTP 覆盖错误日志、事务和前置失败，不能只验证记录函数的调用次数。
await import("./upstream-failures.test.mjs");
await import("./gateway-failure-billing.test.mjs");
await import("./chat-usage.test.mjs");
await import("./harness-runs.test.mjs");
