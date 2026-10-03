import * as toolPresentation from "../src/services/harness/tool-presentation.js";
import { callFingerprint } from "../src/services/harness/tool-call-guards.js";
// 真跑 harness/工具/执行器的内存上游：验证失败步只收一次、停止可打断响应体。
// 只替换模块依赖，不访问数据库/公网，不需要额外运行参数或测试依赖。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeUsage } from "../src/services/pricing.js";
import { USAGE_SQL } from "../src/services/log.js";
import { channelPriceQuote } from "../src/services/channel-price-quote.js";
import { userDataVisibility } from "../src/services/user-data-visibility.js";
import * as toolWire from "../src/services/tool-wire.js";
import * as contextTools from "../src/services/harness/context.js";
import * as capabilities from "../src/services/model-capabilities.js";
import * as agentRouting from "../src/services/agent-routing.js";
import { withEndpointAudit } from "../src/services/endpoint-audit.js";

const audit = {
  callFingerprint,
  toolPresentation,
  contextTools, capabilities, withEndpointAudit,
  agentRouting,
  toolWire,
  crypto,
  normalizeUsage,
  USAGE_SQL,
  channelPriceQuote,
  userDataVisibility,
  complete: null,
  adapter: null,
  pool: { query: async () => [[], []] },
  // 把工具的 15s 截止缩短，验证的是响应体仍受同一截止控制。
  setTimeout: (fn, ms) => setTimeout(fn, ms === 15000 ? 25 : ms),
};
globalThis.__ooHarnessAudit = audit;
const loadMocked = async (relativePath, prelude) => {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
  return import(`data:text/javascript;base64,${Buffer.from(`const audit=globalThis.__ooHarnessAudit;\nconst { TOOL_PRESENTATIONS, toolPresentation } = audit.toolPresentation;\n${prelude}\n${source}`).toString("base64")}`);
};
const tools = await loadMocked("../src/services/harness/tools.js", `
  const assertPublicUrl=async (v)=>new URL(v);
  const pool=audit.pool;
  const assertModelPriced=async()=>{};
  const runCompletion=(o)=>audit.complete(o);
  const billableFailedCall=(...args)=>audit.executor.billableFailedCall(...args);
  const modelForChannelMatch=(v)=>v;
  const setTimeout=audit.setTimeout;
  const USAGE_SQL=audit.USAGE_SQL;
  const userDataVisibility=audit.userDataVisibility;
`);
audit.tools = tools;
const harness = await loadMocked("../src/services/harness/loop.js", `
  const callFingerprint=audit.callFingerprint;
  const { contextBudget, messageTokens, compressionSplit, latestMemory } = audit.contextTools;
  const crypto=audit.crypto;
  const runCompletion=(o)=>audit.complete({...o,...o.prepareRequest?.({nativeTools:audit.nativeMode===true})});
  const modelForChannelMatch=(v)=>v;
  const buildSystemPrompt=()=>"SYSTEM_CONTEXT";
  const SUBAGENTS=[{id:"explore",tools:[]}];
  const {toolSpecs,nativeToolSpecs,runTool}=audit.tools;
  const {callsText,chatCalls,textToolMessages}=audit.toolWire;
  const DEFAULT_MAX_STEPS=8;
  const MAX_STEPS_LIMIT=32;
`);
const executor = await loadMocked("../src/services/execute.js", `
  const clientAgentContext = () => undefined;
  const { agentReasoning, orderAgentChannels } = audit.agentRouting;
  const withEndpointAudit = audit.withEndpointAudit;
  const {modelCapabilities, reasoningSelection} = audit.capabilities;
  const crypto=audit.crypto;
  const pool=audit.pool;
  const assertModelPriced=async()=>{};
  const getNumberOption=(key)=>key==="request_timeout_ms"?1000:(audit.retryTimes || 0);
  const selectChannels=async ()=>audit.channels || [{id:1,name:"mock",type:"mock"}];
  const getAdapter=async ()=>audit.adapter;
  const adapterKeyFor=(c)=>c.type;
  const {callsText}=audit.toolWire;
  const markChannelError=async ()=>{};
  const markChannelOk=async ()=>{};
  const withChannelLimit=(_channel,fn)=>fn();
  const explainNoChannel=async ()=>null;
  const resolveAliasSync=(v)=>v;
  const recordChannelSwitch=()=>{};
  const normalizeUsage=audit.normalizeUsage;
  const channelPriceQuote=audit.channelPriceQuote;
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

await test("长上下文产生独立计费摘要，保留近期消息并在下一轮复用记忆", async () => {
  const calls=[], events=[];
  const history=Array.from({length:24},(_,i)=>({seq:i+1,role:i%2?"assistant":"user",parts:[{type:"text",text:(i===0?"重要约束：只能用中文。":"历史材料")+"事实资料".repeat(180)}]}));
  const original=structuredClone(history);
  let summaries=0;
  audit.complete=async o=>{
    if(o.requestId.includes(":compact:")){summaries++;return mockResult("用户约束：只能用中文。已核实历史事实，继续处理最新问题。");}
    assert.ok(o.messages.some(m=>m.content?.includes("只能用中文")));
    assert.ok(o.messages.some(m=>m.content==="继续处理"));
    o.onDelta("继续用中文处理。");return mockResult("继续用中文处理。");
  };
  const out=await harness.runHarness({...harnessOptions([],calls),history,userText:"继续处理",modelCaps:{contextWindow:12000,maxOutputTokens:2048},emit:e=>events.push(e)});
  const memory=out.parts.find(p=>p.type==="compaction");
  assert.equal(memory.status,"done");assert.ok(memory.beforeTokens>memory.afterTokens);assert.ok(memory.throughSeq>0&&memory.throughSeq<24);
  assert.equal(calls.length,summaries+1);assert.equal(calls.filter(c=>c.purpose==="compaction").length,summaries);
  assert.deepEqual(history,original,"压缩不能删除存储历史");
  const next=harness.historyToMessages([...history,{seq:25,role:"assistant",parts:out.parts}]);
  assert.match(next[0].content,/只能用中文/);assert.ok(next.some(m=>m.content===history.at(-1).parts[0].text));
  assert.ok(next.length<history.length);
});

await test("无效压缩不伪造成功摘要，已消耗的摘要请求仍记账",async()=>{
  const calls=[];
  audit.complete=async()=>mockResult("重复".repeat(4000));
  await assert.rejects(()=>harness.runHarness({...harnessOptions([],calls),history:Array.from({length:20},(_,i)=>({seq:i+1,role:i%2?"assistant":"user",parts:[{type:"text",text:"资料".repeat(800)}]})),modelCaps:{contextWindow:12000,maxOutputTokens:2048}}),e=>{
    assert.equal(e.code,"CONTEXT_COMPACTION_FAILED");assert.equal(e.parts.find(p=>p.type==="compaction").status,"failed");return true;
  });assert.equal(calls.length,1);
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
  const contexts = [];
  let count = 0;
  audit.complete = async (o) => {
    contexts.push({ sessionId: o.sessionId, requestId: o.requestId });
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
  assert.equal(contexts[0].sessionId, contexts[2].sessionId, "主代理工具前后仍为同一会话");
  assert.notEqual(contexts[0].sessionId, contexts[1].sessionId, "子代理有独立会话");
  assert.equal(new Set(contexts.map(c => c.requestId)).size, 3, "三个模型步骤请求各自独立");
});

await test("站内对话跨轮保持session且新对话独立", async () => {
  const contexts = [];
  audit.complete = async o => { contexts.push(o); o.onDelta("answer"); return mockResult("answer"); };
  for (const id of ["fixture-conversation", "fixture-conversation", "fixture-other-conversation"]) {
    await harness.runHarness({ ...harnessOptions([], []), session: { id }, user: { id: 77 } });
  }
  assert.equal(contexts[0].sessionId, contexts[1].sessionId);
  assert.notEqual(contexts[0].requestId, contexts[1].requestId);
  assert.notEqual(contexts[0].sessionId, contexts[2].sessionId);
  assert.ok(contexts.every(o => o.user.id === 77));
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
  const contexts = [];
  audit.adapter = { chat: async ({ channel, onDelta, sessionId, requestId, userId }) => {
    tried.push(channel.id);
    contexts.push({ sessionId, requestId, userId });
    if (channel.id === 1) throw Object.assign(new Error("busy"), { code: "CHANNEL_UPSTREAM_BUSY", status: 502, retryCount: 2 });
    onDelta("OK"); return { ...mockResult("OK"), retryCount: 0 };
  } };
  try {
    const r = await executor.runCompletion({ model: "mock", prompt: "context", sessionId: "conversation", requestId: "turn", user: { id: 77 } });
    assert.deepEqual(tried, [1, 2]); assert.equal(r.retryCount, 3); assert.equal(r.channel.id, 2);
    assert.deepEqual(contexts, [{ sessionId: "conversation", requestId: "turn", userId: 77 }, { sessionId: "conversation", requestId: "turn", userId: 77 }]);
  } finally { delete audit.channels; delete audit.retryTimes; }
});

await test("没有会话上下文的执行请求不共用渠道session", async () => {
  const contexts = [];
  audit.adapter = { chat: async o => { contexts.push(o); o.onDelta("OK"); return mockResult("OK"); } };
  await executor.runCompletion({ model: "mock", prompt: "context" });
  await executor.runCompletion({ model: "mock", prompt: "context" });
  assert.ok(contexts[0].sessionId && contexts[0].requestId);
  assert.notEqual(contexts[0].sessionId, contexts[1].sessionId);
  assert.notEqual(contexts[0].requestId, contexts[1].requestId);
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
    for (const invalid of [null, "not-json", []]) assert.equal((await tools.runTool("account", invalid, ctx)).ok, false);
    assert.equal(queries.length, 0, "非法参数不能默认执行overview");
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

  for (const mode of ["whole", "char"]) {
  await test(`线上 Laguna 两种真实格式完成账号工具与最终回答（${mode}）`, async () => {
    const originalQuery = audit.pool.query;
    const queries = [], calls = [];
    audit.pool.query = async (sql, args) => {
      assert.equal(args[0], 77, "模型参数不能改变当前账号");
      assert.equal((sql.match(/\?/g) || []).length, args.length);
      queries.push(sql);
      if (sql.includes("FROM users")) return [[{ username: "fixture", quota: 12345, used_quota: 300, request_count: 2 }]];
      if (sql.includes("FROM tokens")) return [[{ n: 1, on_: 1 }]];
      if (sql.includes("ORDER BY id DESC")) return [[{ type: 2, model: "fixture-model", quota: 100, created_at: 1 }]];
      return [[{ n: 2, cost: 300 }]];
    };
    let step = 0;
    audit.complete = async (o) => {
      step++;
      if (step === 2) assert.ok(o.messages.some((m) => m.content.includes("余额：1.2345 OD币")));
      if (step === 3) assert.ok(o.messages.some((m) => m.content.includes("最近调用（1 条") && m.content.includes("fixture-model")));
      const content = step === 1
        ? '<tool_call>account<arg_key>action</arg_key><arg_value>balance</arg_value><arg_key>user_id</arg_key><arg_value>999</arg_value></tool_call>'
        : step === 2 ? '<tool_call>{"tool":"account","args":{"action":"recent","limit":5}}'
        : "余额 1.2345 OD币，最近调用包含 fixture-model。";
      for (const chunk of mode === "char" ? [...content] : [content]) o.onDelta(chunk);
      return mockResult(content);
    };
    try {
      const result = await harness.runHarness({ ...harnessOptions(["account"], calls), user: { id: 77 } });
      assert.match(result.text, /1\.2345 OD币.*fixture-model/);
      assert.deepEqual(result.parts.filter((p) => p.type === "tool").map((p) => p.status), ["done", "done"]);
      assert.equal(calls.length, 3);
      assert.equal(queries.length, 4);
    } finally { audit.pool.query = originalQuery; }
  });
}
for (const mode of ["whole", "char"]) {
  await test(`线上连续两个漏结束标签的查询均执行并汇总，模型用量不按工具个数重复（${mode}）`, async () => {
    const originalQuery = audit.pool.query, calls = [], queries = [];
    audit.pool.query = async (sql, args) => {
      assert.equal(args[0], 77, "整批查询均限定当前用户");
      queries.push(sql);
      if (sql.includes("FROM users")) return [[{username:"fixture",quota:12345}]];
      if (sql.includes("ORDER BY id DESC")) return [[{type:2,model:"fixture-model",quota:100,created_at:1}]];
      return [[{n:1,on_:1,cost:0}]];
    };
    let count = 0;
    audit.complete = async o => {
      const content = ++count === 1 ? '<tool_call>{"tool":"account","args":{"action":"overview"}}<tool_call>{"tool":"account","args":{"action":"recent","limit":5}}'
        : '余额 1.2345 OD币；最近调用包含 fixture-model。';
      if (count === 2) {
        const results = o.messages.filter(m => m.content.includes('<tool_result')).map(m => m.content).join('\n');
        assert.match(results, /余额：1\.2345 OD币/); assert.match(results, /fixture-model/);
        assert.equal((results.match(/<tool_result /g) || []).length, 2);
      }
      for (const chunk of mode === "char" ? [...content] : [content]) o.onDelta(chunk);
      return mockResult(content);
    };
    try {
      const result = await harness.runHarness({...harnessOptions(["account"],calls),user:{id:77}});
      assert.match(result.text,/1\.2345 OD币.*fixture-model/);
      assert.deepEqual(result.parts.filter(p=>p.type==='tool').map(p=>[p.args.action,p.status]),[['overview','done'],['recent','done']]);
      assert.equal(calls.length,2); assert.equal(count,2); assert.equal(queries.length,4);
    } finally { audit.pool.query = originalQuery; }
  });
  await test(`整批含损坏的第二调用时不先执行第一调用（${mode}）`, async () => {
    const originalQuery = audit.pool.query, calls = []; let count = 0, queried = false;
    audit.pool.query = async () => { queried = true; return [[],[]]; };
    audit.complete = async o => {
      const content = ++count === 1 ? '<tool_call>{"tool":"account","args":{"action":"overview"}}</tool_call><tool_call>{"tool":"account","args":{"action":' : '无法执行查询。';
      for(const chunk of mode === "char" ? [...content] : [content]) o.onDelta(chunk);
      return mockResult(content);
    };
    try {
      const result=await harness.runHarness({...harnessOptions(["account"],calls),user:{id:77}});
      assert.equal(queried,false); assert.equal(result.parts.filter(p=>p.type==='tool').length,0); assert.equal(calls.length,2);
    } finally { audit.pool.query = originalQuery; }
  });
  await test(`在第一工具后停止时不执行批次余下的工具（${mode}）`, async () => {
    const ctrl = new AbortController(), calls = [];
    audit.complete = async o => {
      const content='<tool_call>{"tool":"todowrite","args":{"todos":[{"content":"first","status":"pending"}]}}</tool_call><tool_call>{"tool":"todowrite","args":{"todos":[{"content":"second","status":"pending"}]}}</tool_call>';
      for(const chunk of mode === "char" ? [...content] : [content]) o.onDelta(chunk);
      return mockResult(content);
    };
    await assert.rejects(()=>harness.runHarness({...harnessOptions(["todowrite"],calls),signal:ctrl.signal,onTodo:()=>ctrl.abort()}),e=>{
      assert.equal(e.code,'ABORTED'); assert.equal(e.parts.filter(p=>p.type==='tool').length,1); assert.equal(e.calls.length,1); return true;
    });
  });
  await test(`线上只返回account recent占位符后纠正、取到两项数据并最终回答（${mode}）`, async () => {
    const originalQuery = audit.pool.query;
    const calls = [], queries = [], emitted = [];
    audit.pool.query = async (sql, args) => {
      assert.equal(args[0], 77);
      queries.push(sql);
      if (sql.includes("FROM users")) return [[{ username: "fixture", quota: 12345 }]];
      if (sql.includes("FROM tokens")) return [[{ n: 1, on_: 1 }]];
      if (sql.includes("ORDER BY id DESC")) return [[{ type: 2, model: "fixture-model", quota: 100, created_at: 1 }]];
      return [[{ n: 2, cost: 300 }]];
    };
    let count = 0;
    audit.complete = async o => {
      count++;
      assert.ok(!o.messages.some(m => m.role === "assistant" && /调用工具|本轮使用过工具/.test(m.content)), "不把内部状态作为助手消息交回模型");
      if (count >= 2) assert.ok(o.messages.some(m => m.content.includes('<tool_call>{"tool":"account","args":{"action":"overview"}}</tool_call>')), "上下文保留真实调用与参数");
      if (count >= 3) assert.ok(o.messages.some(m => m.content.includes("余额：1.2345 OD币")), "纠正不丢失已经取得的真实结果");
      const content = count === 1 ? '<tool_call>{"tool":"account","args":{"action":"overview"}}</tool_call>'
        : count === 2 ? '（调用工具 account recent）'
          : count === 3 ? '<tool_call>{"tool":"account","args":{"action":"recent","limit":5}}</tool_call>'
            : '余额 1.2345 OD币；最近调用包含 fixture-model。';
      for (const chunk of mode === "char" ? [...content] : [content]) o.onDelta(chunk);
      return mockResult(content);
    };
    try {
      const result = await harness.runHarness({ ...harnessOptions(["account"], calls), user: { id: 77 }, history: [{role:"assistant",parts:[{type:"tool",tool:"account"},{type:"text",text:"（调用工具 account recent）"}]}], emit:e => emitted.push(structuredClone(e)) });
      assert.match(result.text, /1\.2345 OD币.*fixture-model/);
      assert.equal(count, 4); assert.equal(calls.length, 4);
      assert.equal(queries.filter(s => s.includes("ORDER BY id DESC")).length, 1, "占位符不会被猜测为工具调用");
      assert.ok(!JSON.stringify(result.parts).includes("调用工具 account recent"));
      assert.ok(!JSON.stringify(emitted).includes("调用工具 account recent"));
      assert.deepEqual(result.parts.filter(p => p.type === "tool").map(p => p.args.action), ["overview", "recent"]);
    } finally { audit.pool.query = originalQuery; }
  });
}
await test("工具已完成但反复只返回状态时失败退出且保留工具结果/真实用量", async () => {
  const originalQuery = audit.pool.query;
  audit.pool.query = async sql => sql.includes("FROM users") ? [[{username:"fixture",quota:12345}]] : [[{n:1,on_:1,cost:0}]];
  let count = 0; const calls = [];
  audit.complete = async o => {
    const content = ++count === 1 ? '<tool_call>{"tool":"account","args":{"action":"overview"}}</tool_call>' : "（调用工具 account recent）";
    o.onDelta(content); return mockResult(content);
  };
  try {
    await assert.rejects(() => harness.runHarness({...harnessOptions(["account"],calls),user:{id:77}}), e => {
      assert.equal(e.code,"TOOL_RESPONSE_ERROR"); assert.equal(e.calls.length,3);
      assert.equal(e.parts.filter(p=>p.type==="tool").length,1);
      assert.ok(e.parts.find(p=>p.type==="tool").output.includes("余额：1.2345 OD币"));
      assert.ok(!e.parts.some(p=>p.type==="text" && p.text.includes("调用工具")));
      return true;
    });
    assert.equal(count,3); assert.equal(calls.length,3);
  } finally { audit.pool.query = originalQuery; }
});
await test("预算后预留无工具收尾，模型拒绝收尾时明确标记未完成", async () => {
  audit.complete = async o => { const content='<tool_call>{"tool":"todowrite","args":{"todos":[{"content":"pending","status":"pending"}]}}</tool_call>';o.onDelta(content);return mockResult(content); };
  for(const maxSteps of [1,1.5]){
    const calls=[];
    const out=await harness.runHarness({...harnessOptions(["todowrite"],calls),settings:{tools:["todowrite"],maxSteps}});
    assert.equal(calls.length,2);
    assert.equal(out.parts.filter(p=>p.type==="tool").length,1);
    assert.equal(out.parts.find(p=>p.type==="trajectory").partial,true);
    assert.match(out.text,/未给出完整总结/);
  }
});
await test("反复非法工具调用只纠正一次，真实用量保留且内部占位符不进历史", async () => {
  for (const content of ['<tool_call>{"tool":"account","args":"not-json"}</tool_call>', '（工具调用格式不合法）', '（工具调用格式不合法）\n（工具调用格式不合法）']) {
    let attempts = 0;
    const calls = [];
    audit.complete = async (o) => {
      attempts++;
      assert.ok(!o.messages.some((m) => m.role === "assistant" && m.content.includes("工具调用格式不合法")));
      o.onDelta(content);
      return mockResult(content);
    };
    await assert.rejects(() => harness.runHarness({ ...harnessOptions(["account"], calls), history: [{ role: "assistant", parts: [{ type: "text", text: "（工具调用格式不合法）\n（工具调用格式不合法）" }] }] }), (e) => {
      assert.equal(e.code, "TOOL_PROTOCOL_ERROR");
      assert.equal(e.calls.length, 2);
      assert.equal(e.calls[0].usage.prompt_tokens, 10);
      return true;
    });
    assert.equal(attempts, 2); assert.equal(calls.length, 2);
  }
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
await test("原生工具经过执行器、账号权限、结果回传及最终回答，两次模型调用只记两单", async () => {
  const originalQuery = audit.pool.query;
  let count = 0;
  audit.nativeMode = true;
  audit.channels = [{ id: 1, type: "kiro", name: "fixture" }];
  audit.pool.query = async (sql, args) => {
    assert.equal(args[0],77);
    if (sql.includes("FROM users")) return [[{username:"fixture",quota:12345}]];
    if (sql.includes("ORDER BY id DESC")) return [[{type:2,model:"fixture-model",quota:100,created_at:1}]];
    return [[{n:1,on_:1,cost:0}]];
  };
  audit.adapter = { chat: async o => {
    assert.equal(o.tools[0].name,"account");
    if (++count === 1) {
      const toolCalls = ["overview","recent"].map((action,i)=>({id:`call_${i}`,name:"account",arguments:JSON.stringify({action})}));
      toolCalls.forEach((c,index)=>o.onToolCall({index,...c}));
      return {...mockResult(""),toolCalls};
    }
    const previous=o.messages.find(m=>m.tool_calls);
    const results=o.messages.filter(m=>m.role==="tool");
    assert.equal(previous.tool_calls.length,2);assert.equal(results.length,2);
    assert.equal(results[0].tool_call_id,previous.tool_calls[0].id);
    assert.match(results[0].content,/余额：1\.2345 OD币/);assert.match(results[1].content,/fixture-model/);
    o.onDelta("余额 1.2345 OD币；最近调用包含 fixture-model。");
    return mockResult("余额 1.2345 OD币；最近调用包含 fixture-model。");
  }};
  audit.complete=o=>executor.runCompletion(o);
  try {
    const out=await harness.runHarness({...harnessOptions(["account"],[]),user:{id:77}});
    assert.equal(count,2);assert.equal(out.calls.length,2);assert.match(out.text,/fixture-model/);
    assert.deepEqual(out.parts.filter(p=>p.type==="tool").map(p=>p.status),["done","done"]);
    assert.ok(out.calls[0].firstTokenAt>0);assert.match(out.calls[0].output,/overview/);
  } finally { audit.pool.query=originalQuery;audit.channels=null;audit.nativeMode=false; }
});

await test("原生参数损坏时整批不执行，越权工具拒绝且不会执行本机命令",async()=>{
  audit.nativeMode=true;
  let count=0;
  audit.complete=async o=>{
    if (++count===1) return {...mockResult(""),toolMode:"native",toolCalls:[{id:"a",name:"todowrite",arguments:'{"todos":[]}'},{id:"b",name:"account",arguments:'{"broken"'}]};
    assert.match(o.messages.at(-1).content,/原生工具接口/);
    o.onDelta("无法读取"); return mockResult("无法读取");
  };
  try {
    const out=await harness.runHarness(harnessOptions(["todowrite"],[]));
    assert.equal(out.parts.filter(p=>p.type==="tool").length,0);
    count=0;
    audit.complete=async o=>{
      if(++count===1)return {...mockResult(""),toolCalls:[{id:"a",name:"bash",arguments:'{"command":"fixture"}'}]};
      assert.match(o.messages.at(-1).content,/本轮不可用/);o.onDelta("不可用");return mockResult("不可用");
    };
    const refused=await harness.runHarness(harnessOptions(["account"],[]));
    assert.equal(refused.parts.find(p=>p.type==="tool").status,"failed");
  } finally {audit.nativeMode=false;}
});

await test("原生工具产生增量后中断不重试，保留参数用量供单次结算",async()=>{
  audit.channels=[{id:1,type:"kiro",name:"fixture"},{id:2,type:"kiro",name:"other"}];audit.retryTimes=1;
  let count=0;
  audit.adapter={chat:async o=>{count++;o.onToolCall({index:0,id:"a",name:"account",arguments:'{"action":'});throw interrupted();}};
  try {
    await assert.rejects(()=>executor.runCompletion({model:"auto",prompt:"fixture",tools:tools.nativeToolSpecs(["account"])}),e=>{
      assert.match(e.billingOutput,/account/);assert.equal(e.billable,true);assert.ok(e.firstTokenAt>0);return true;
    });assert.equal(count,1);
  } finally {audit.channels=null;audit.retryTimes=0;}
});

await test("换到网页渠道时工具定义采用文本协议，已执行结果不丢；最终快照无delta仍能展示",async()=>{
  audit.nativeMode=true;
  audit.channels=[{id:1,type:"web-fixture",name:"fixture"}];
  let count=0;
  audit.adapter={chat:async o=>{
    assert.deepEqual(o.tools,[]);
    if(++count===1)return mockResult('<tool_call>{"tool":"todowrite","args":{"todos":[{"content":"fixture","status":"completed"}]}}</tool_call>');
    assert.ok(o.messages.some(m=>m.content.includes('<tool_result')));
    assert.ok(!o.messages.some(m=>m.role==="tool"));
    return mockResult('工具执行完毕，这是最终快照回答。');
  }};
  audit.complete=o=>executor.runCompletion(o);
  try{
    const result=await harness.runHarness(harnessOptions(["todowrite"],[]));
    assert.equal(result.text,'工具执行完毕，这是最终快照回答。');assert.equal(result.calls.length,2);
  }finally{audit.channels=null;audit.nativeMode=false;}
});

await test("探索预算用完后请求没有工具，结果正常收尾且保留用量", async () => {
  let attempts=0; const calls=[];
  audit.complete=async o=>{ attempts++; const content=attempts===1?'<tool_call>{"tool":"todowrite","args":{"todos":[{"content":"done","status":"completed"}]}}</tool_call>':"已完成查询，结果如下。"; if(attempts===2) assert.deepEqual(o.tools,[]);o.onDelta(content);return mockResult(content); };
  const out=await harness.runHarness({...harnessOptions(["todowrite"],calls),settings:{maxSteps:1,tools:["todowrite"]}});
  assert.equal(out.text,"已完成查询，结果如下。");assert.equal(calls.length,2);assert.equal(out.parts.find(p=>p.type==="trajectory").status,"done");
});
await test("相同查询复用结果，连续无进展自动收尾", async () => {
  let attempts=0,executed=0;
  audit.complete=async o=>{attempts++;const content=o.tools.length?'<tool_call>{"tool":"todowrite","args":{"todos":[{"content":"same","status":"pending"}]}}</tool_call>':"信息不足，已停止重复查询。";o.onDelta(content);return mockResult(content);};
  const out=await harness.runHarness({...harnessOptions(["todowrite"],[]),authorizeTool:async()=>{executed++;return true;}});
  assert.equal(executed,1);assert.equal(attempts,5);assert.match(out.text,/信息不足/);assert.equal(out.parts.find(p=>p.type==="trajectory").reason,"no_progress");
  assert.equal(out.parts.filter(p=>p.type==="tool").length,1,"复用不能制造重复胶囊");
});
await test("同批和跨步的相同原生调用只执行及展示一次，所有调用编号都有结果", async()=>{
  const events=[];let rounds=0,executed=0; audit.nativeMode=true;
  const one={todos:[{content:"same",status:"pending"}]}, same={todos:[{status:"pending",content:"same"}]};
  audit.complete=async o=>{
    rounds++;
    if(rounds===1)return {...mockResult(""),toolMode:"native",toolCalls:[{id:"first",name:"todowrite",arguments:JSON.stringify(one)},{id:"second",name:"todowrite",arguments:JSON.stringify(same)}]};
    const results=o.messages.filter(m=>m.role==="tool");
    assert.ok(results.some(m=>m.tool_call_id==="first"));assert.ok(results.some(m=>m.tool_call_id==="second"));
    if(rounds===2)return {...mockResult(""),toolMode:"native",toolCalls:[{id:"third",name:"todowrite",arguments:JSON.stringify(one)}]};
    assert.ok(results.some(m=>m.tool_call_id==="third"));return mockResult("小清单已经更新。");
  };
  try {
    const out=await harness.runHarness({...harnessOptions(["todowrite"],[]),emit:e=>events.push(e),authorizeTool:async()=>{executed++;return true;}});
    assert.equal(executed,1);assert.equal(out.parts.filter(p=>p.type==="tool").length,1);
    const ids=new Set(events.filter(e=>e.type==="part").map(e=>e.part.id));
    assert.ok(events.filter(e=>e.type==="part_update").every(e=>ids.has(e.id)),"不能更新从未创建的胶囊");
  } finally { audit.nativeMode=false; }
});
await test("审批拒绝后工具不执行，禁用工具无法通过调用参数重新开启", async()=>{
  let attempts=0;
  audit.complete=async o=>{const content=++attempts===1?'<tool_call>{"tool":"todowrite","args":{"todos":[{"content":"should not run","status":"completed"}]}}</tool_call>':"未获得许可。";o.onDelta(content);return mockResult(content);};
  const out=await harness.runHarness({...harnessOptions(["todowrite"],[]),authorizeTool:async()=>false});
  assert.deepEqual(out.todo,[]);assert.equal(out.parts.find(p=>p.type==="tool").status,"failed");
});
console.log(`  harness 执行/计费回归 ${passed} 项通过`);
// 真实环回 HTTP 覆盖错误日志、事务和前置失败，不能只验证记录函数的调用次数。
await import("./upstream-failures.test.mjs");
await import("./gateway-failure-billing.test.mjs");
await import("./chat-usage.test.mjs");
await import("./harness-runs.test.mjs");

await import("./harness-approvals.test.mjs");
