// 真运行循环与检查点，仅替换上游/工具执行；不访问数据库、设备或收费模型。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as runtime from "../src/services/harness/runtime.js";
import * as context from "../src/services/harness/context.js";
import * as wire from "../src/services/tool-wire.js";
import { splitTokens } from "../src/services/pricing.js";
import { callFingerprint } from "../src/services/harness/tool-call-guards.js";
import { createTaskRuntime } from "../src/services/harness/task-runtime.js";
import { createExecutor } from "../../ooapi-companion/runner.mjs";

const fixture = { crypto, runtime, context, wire, splitTokens, callFingerprint, complete: null, tool: null };
globalThis.__ooOrchestrationFixture = fixture;
const source = readFileSync(new URL("../src/services/harness/loop.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const prelude = `
const f=globalThis.__ooOrchestrationFixture;
const {crypto,splitTokens,callFingerprint}=f;
const {createHarnessRuntime,harnessInterruption,isLocalTool,fingerprintHash,privateToolPart,sanitizeCheckpoint,mapConcurrent}=f.runtime;
const {contextBudget,messageTokens,compressionSplit,latestMemory}=f.context;
const {callsText,chatCalls,textToolMessages}=f.wire;
const PLATFORM_TOOL_IDS=['pricing'];
const needsToolApproval=(tool,args)=>tool==='pricing'&&args.action==='set';
const grantToolCall=()=>({});
const platformRequest=()=>({});
const preparePlatformCall=async(tool,args)=>({canonicalArgs:args,presentation:{},prepared:{}});
const cleanPlatformResult=value=>value;
const toolPresentation=()=>({});
const modelForChannelMatch=value=>value;
const DEFAULT_MAX_STEPS=12,MAX_STEPS_LIMIT=256;
const SUBAGENTS=[{id:'explore',tools:['local'],name:'Explore'}];
const buildSystemPrompt=opts=>f.systemPrompt?.(opts)||'';
const toolSpecs=ids=>ids.map(id=>({id,name:id}));
const nativeToolSpecs=()=>[];
const runTool=(id,args,ctx)=>f.tool(id,args,ctx);
const runCompletion=opts=>f.complete(opts);
`;
const { runHarness, historyToMessages } = await import(`data:text/javascript;base64,${Buffer.from(prelude + source).toString("base64")}`);
const call = (id, tool, args) => ({ id, name: tool, arguments: JSON.stringify(args) });
const answer = content => ({ content, usage: { prompt_tokens: 10, completion_tokens: 3 } });
const options = extra => ({ session: { id: "fixture-root" }, model: "fixture", agent: {}, user: { id: 1, role: 100 },
  settings: { tools: ["pricing", "account", "task", "todowrite", "local"] }, userText: "执行任务", authorizeTool: async () => true, ...extra });
let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`  ok  ${name}`); }

await test("改价后相同读取必须重新执行，失败查询允许恢复，重复写不重发", async () => {
  let value = 1, reads = 0, writes = 0, step = 0;
  const requests = [];
  const script = [call("r1", "pricing", { action: "list" }), call("w1", "pricing", { action: "set", data: { value: 2 } }), call("r2", "pricing", { action: "list" }), call("w2", "pricing", { action: "set", data: { value: 2 } })];
  fixture.complete = async o => { requests.push(structuredClone(o.messages)); return step < script.length ? { content: "", toolCalls: [script[step++]] } : answer("已核实"); };
  fixture.tool = async (_, args) => args.action === "set" ? (writes++, value = 2, { ok: true, output: "updated" }) : (reads++, { ok: true, output: `price=${value}` });
  await runHarness(options());
  assert.equal(reads, 2); assert.equal(writes, 1);
  assert.ok(requests.at(-1).some(m => m.content === "price=2"));
  step = 0; reads = 0;
  fixture.complete = async () => step++ < 2 ? { content: "", toolCalls: [call(`retry${step}`, "account", { action: "overview" })] } : answer("恢复了");
  fixture.tool = async () => ++reads === 1 ? { ok: false, output: "暂时不可用" } : { ok: true, output: "fresh" };
  await runHarness(options()); assert.equal(reads, 2);
});

await test("跨轮保留已执行实体编号与状态，本地工具内容不进入历史", async () => {
  const out = historyToMessages([{ seq: 1, role: "assistant", parts: [{ type: "text", text: "已发布" },
    { type: "tool", tool: "community", status: "done", args: { action: "publish" }, output: '{"id":777}' },
    { type: "tool", tool: "local", args: { action: "read" }, output: "LOCAL_FILE_SENTINEL" }] }]);
  assert.ok(JSON.stringify(out).includes("777")); assert.ok(JSON.stringify(out).includes("publish"));
  assert.ok(!JSON.stringify(out).includes("LOCAL_FILE_SENTINEL"));
});

await test("同批只读子任务真实重叠执行，最多三并发且返回结果顺序不变", async () => {
  let rootStep = 0, active = 0, peak = 0;
  fixture.complete = async o => {
    if (o.sessionId === "fixture-root") return rootStep++ === 0 ? { content: "", toolCalls: [1, 2, 3, 4].map(i => call(`t${i}`, "task", { agent: "explore", prompt: `task${i}` })) } : answer("汇总");
    peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, 12)); active--;
    return answer(o.messages.at(-1).content);
  };
  fixture.tool = async (_, args, ctx) => { const out = await ctx.runAgent({ agentId: args.agent, prompt: args.prompt }); return { ok: true, output: out.text }; };
  const out = await runHarness(options());
  assert.equal(peak, 3); assert.equal(active, 0);
  assert.equal(out.parts.filter(p => p.type === "tool").length, 4);
  assert.equal(out.budget.modelCalls, 6);
});

await test("写入后暂停的检查点恢复先核实结果，绝不再次发出写入", async () => {
  const ctrl = new AbortController(); let writes = 0, state, generated = 0;
  fixture.complete = async () => { generated++; return { content: "", toolCalls: [call("write-stable", "pricing", { action: "set", data: { value: 2 } })] }; };
  fixture.tool = async () => { writes++; ctrl.abort({ kind: "pause" }); throw Object.assign(new Error("response lost"), { code: "ABORTED" }); };
  await assert.rejects(runHarness(options({ signal: ctrl.signal, onCheckpoint: async s => { state = structuredClone(s); } })), { code: "HARNESS_PAUSED" });
  assert.equal(state.phase, "paused"); assert.equal(state.pendingCalls[0].status, "unknown");
  fixture.complete = async o => { assert.ok(o.messages.some(m => m.role === "tool" && /禁止自动重发|禁止重新发送/.test(m.content))); return answer("写入结果未确认，请核实"); };
  await runHarness(options({ resumeState: state }));
  assert.equal(writes, 1); assert.equal(generated, 1);
});

await test("已完成读取在工具检查点恢复不重读，不重跑上一个模型请求", async () => {
  let state, step = 0, reads = 0;
  fixture.complete = async () => step++ === 0 ? { content: "", toolCalls: [call("read1", "account", { action: "overview" })] } : answer("结束");
  fixture.tool = async () => (reads++, { ok: true, output: "id=123" });
  await runHarness(options({ onCheckpoint: async s => { if (s.pendingCalls[0]?.status === "done") state = structuredClone(s); } }));
  fixture.complete = async o => { assert.ok(o.messages.some(m => m.content === "id=123")); return answer("恢复总结"); };
  await runHarness(options({ resumeState: state })); assert.equal(reads, 1);
});

await test("本地内容给本轮模型但不进入可持久化检查点、工具胶囊与计费文本", async () => {
  const secret = "LOCAL_FILE_PRIVATE_SENTINEL"; let step = 0, persisted, full, billing;
  fixture.complete = async o => step++ === 0 ? { content: "", toolCalls: [call("local1", "local", { action: "read", path: "private.txt" })] }
    : (assert.ok(JSON.stringify(o.messages).includes(secret)), answer(`得到 ${secret}`));
  fixture.tool = async () => ({ ok: true, output: secret });
  const out = await runHarness(options({ localSensitive: true, onCall: c => { billing = c; }, onCheckpoint: async (s, meta) => { full = s; persisted = meta.persistable; } }));
  assert.equal(out.sensitive, true); assert.ok(JSON.stringify(full).includes(secret));
  assert.ok(!JSON.stringify(persisted).includes(secret)); assert.equal(persisted.requiresLocalContext, true);
  assert.ok(!JSON.stringify(out.parts.filter(p => p.type === "tool")).includes(secret));
  assert.ok(!JSON.stringify(billing).includes(secret)); assert.ok(billing.tokens.promptTokens > 0);
  await assert.rejects(runHarness(options({ resumeState: persisted })), { code: "WAITING_LOCAL" });
});

await test("子代理本地写入在审批之前拒绝，保留只读能力", async () => {
  let main = 0, child = 0, localWrites = 0;
  fixture.complete = async o => o.sessionId === "fixture-root" ? main++ === 0 ? { content: "", toolCalls: [call("delegate", "task", { agent: "explore", prompt: "inspect" })] } : answer("完成分析")
    : child++ === 0 ? { content: "", toolCalls: [call("bad-write", "local", { action: "write", path: "x", content: "x" })] } : answer("只读，未修改");
  fixture.tool = async (id, args, ctx) => { if (id === "local") { localWrites++; return { ok: true }; } const out = await ctx.runAgent({ agentId: args.agent, prompt: args.prompt }); return { ok: true, output: out.text }; };
  await runHarness(options()); assert.equal(localWrites, 0);
});

await test("总模型预算在下次调用前停止并留下可恢复检查点", async () => {
  let calls = 0, state;
  fixture.complete = async () => (calls++, { content: "", toolCalls: [call(`r${calls}`, "account", { action: `read${calls}` })] });
  fixture.tool = async () => ({ ok: true, output: "value" });
  await assert.rejects(runHarness(options({ settings: { tools: ["account"], budget: { maxModelCalls: 2 } }, onCheckpoint: async s => { state = s; } })), { code: "HARNESS_BUDGET" });
  assert.equal(calls, 2); assert.equal(state.phase, "paused"); assert.equal(state.budget.modelCalls, 2);
});

await test("并发请求预留Token/OD，价格检查不绕过预算，运行时间截止会中止等待", async () => {
  const tokens = runtime.createHarnessRuntime({ budget: { maxTokens: 256 } });
  const first = await tokens.beforeModel({ promptTokens: 100, maxOutputTokens: 156 });
  await assert.rejects(tokens.beforeModel({ promptTokens: 1 }), { code: "HARNESS_BUDGET" });
  await tokens.settleModel(first, { tokens: { promptTokens: 100, completionTokens: 10 } });
  assert.equal(tokens.snapshot().tokens, 110); tokens.dispose();
  const od = runtime.createHarnessRuntime({ budget: { maxOd: 1 }, costOfCall: async () => .6 });
  const accepted = await od.beforeModel({ promptTokens: 10, maxOutputTokens: 20, model: "fixture" });
  await assert.rejects(od.beforeModel({ promptTokens: 10, maxOutputTokens: 20, model: "fixture" }), { code: "HARNESS_BUDGET" });
  await od.settleModel(accepted, { tokens: { promptTokens: 10, completionTokens: 1 } });
  assert.equal(od.snapshot().od, .6); od.dispose();
  const expired = runtime.createHarnessRuntime({ budget: { maxWallTimeMs: 1000 }, state: { elapsedMs: 1000 } });
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.equal(expired.signal.aborted, true); assert.throws(expired.check, { code: "HARNESS_BUDGET" }); expired.dispose();
});

await test("每次模型调用前重查身份，主/子读取使用同一个父工作区绑定", async () => {
  let allowed = true, checks = 0, toolSteps = 0, lookedUp;
  fixture.complete = async o => o.sessionId === "fixture-root" ? toolSteps++ === 0 ? { content: "", toolCalls: [call("child", "task", { agent: "explore", prompt: "inspect" })] } : answer("总结")
    : toolSteps++ === 1 ? { content: "", toolCalls: [call("local-read", "local", { action: "read", path: "x" })] } : answer("分析");
  fixture.tool = async (id, args, ctx) => { if (id === "local") { lookedUp = ctx.workspaceSessionId; return { ok: true, output: "read" }; } const out = await ctx.runAgent({ agentId: args.agent, prompt: args.prompt }); return { ok: true, output: out.text }; };
  await runHarness(options({ workspaceSessionId: "actual-parent", beforeModel: async () => { checks++; if (!allowed) throw Object.assign(new Error("disabled"), { code: "AUTH_FAILED" }); } }));
  assert.equal(lookedUp, "actual-parent"); assert.ok(checks >= 3);
  allowed = false;
  await assert.rejects(runHarness(options({ beforeModel: async () => { if (!allowed) throw Object.assign(new Error("disabled"), { code: "AUTH_FAILED" }); } })), { code: "AUTH_FAILED" });
});

await test("未完成待办保留为partial，不能靠一条最终正文冒充全部完成", async () => {
  fixture.complete = async () => answer("暂时的结论");
  const out = await runHarness(options({ session: { id: "fixture-root", todo: [{ content: "尚待验证", status: "pending" }] } }));
  assert.equal(out.partial, true); assert.equal(out.todo[0].status, "pending"); assert.match(out.text, /未完成/);
});

await test("最终检查点后崩溃只重放已完成结果，不重跑原始请求或增加费用", async () => {
  let calls = 0, state;
  fixture.complete = async () => (calls++, answer("原任务已完成"));
  const original = await runHarness(options({ onCheckpoint: async s => { state = structuredClone(s); } }));
  assert.equal(state.phase, "done");
  fixture.complete = async () => { throw new Error("恢复最终结果不能调用模型"); };
  fixture.tool = async () => { throw new Error("恢复最终结果不能调用工具"); };
  const recovered = await runHarness(options({ resumeState: state, recoverFinal: true, userText: "原始用户请求" }));
  assert.deepEqual(recovered.parts, original.parts); assert.equal(recovered.text, original.text);
  assert.equal(recovered.calls.length, 0); assert.equal(recovered.budget.modelCalls, original.budget.modelCalls); assert.equal(calls, 1);
});

await test("本地设备明确未派发的写入恢复可以首次执行，不误判未知写入", async () => {
  let modelStep = 0, writes = 0, state;
  fixture.complete = async () => modelStep++ === 0 ? { content: "", toolCalls: [call("offline-write", "local", { action: "write", path: "x", content: "x" })] } : answer("写入已核实");
  fixture.tool = async () => { if (++writes === 1) throw Object.assign(new Error("设备离线，尚未派发"), { code: "WAITING_LOCAL", outcome: "not_executed" }); return { ok: true, output: "written" }; };
  await assert.rejects(runHarness(options({ onCheckpoint: async s => { state = structuredClone(s); } })), { code: "WAITING_LOCAL" });
  assert.equal(state.pendingCalls[0].status, "queued"); assert.equal(state.completedWrites.length, 0);
  await runHarness(options({ resumeState: state })); assert.equal(writes, 2);
});

await test("提高预算后从已暂停检查点继续，满预算的最终结果仍能无调用恢复", async () => {
  let step = 0, state;
  fixture.complete = async () => step++ === 0 ? { content: "", toolCalls: [call("budget-read", "account", { action: "overview" })] } : answer("预算扩大后完成");
  fixture.tool = async () => ({ ok: true, output: "id=55" });
  await assert.rejects(runHarness(options({ settings: { tools: ["account"], budget: { maxModelCalls: 1 } }, onCheckpoint: async s => { state = structuredClone(s); } })), { code: "HARNESS_BUDGET" });
  const resumed = await runHarness(options({ resumeState: state, settings: { tools: ["account"], budget: { maxModelCalls: 2 } } }));
  assert.equal(resumed.text, "预算扩大后完成"); assert.equal(resumed.budget.modelCalls, 2);
  const exhausted = { ...resumed.checkpoint, budget: { ...resumed.budget, elapsedMs: 2000, tokens: 256 } };
  fixture.complete = async () => { throw new Error("最终结果恢复不能消费额外预算"); };
  const recovered = await runHarness(options({ recoverFinal: true, resumeState: exhausted, settings: { budget: { maxModelCalls: 1, maxTokens: 256, maxWallTimeMs: 1000 } } }));
  assert.equal(recovered.text, resumed.text); assert.equal(recovered.calls.length, 0);
});

await test("真实异步任务图并行运行且传递依赖结果，父代理等待汇合后综合并结清调用", async () => {
  let rootStep = 0, active = 0, peak = 0;
  const ids = new Map(), events = [];
  const tasks = createTaskRuntime({ emit: ev => events.push(ev), save: async () => {} });
  fixture.complete = async o => {
    if (o.sessionId === "fixture-root") {
      rootStep++;
      if (rootStep === 1) return { content: "", toolCalls: ["A", "B"].map(label => call(`start-${label}`, "task", { action: "start", agent: "explore", label, prompt: `分析 ${label}` })) };
      if (rootStep === 2) return { content: "", toolCalls: [call("start-C", "task", { action: "start", agent: "explore", label: "C", prompt: "综合 C", dependencies: [ids.get("A")] })] };
      if (rootStep === 3) return answer("先给一个初步回答");
      assert.ok(o.messages.some(m => /子任务已汇合/.test(m.content) && /A 的结果/.test(m.content) && /C 的结果/.test(m.content)));
      return answer("已汇合所有任务并核实");
    }
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 12));
    active--;
    const prompt = o.messages.at(-1).content;
    if (prompt.startsWith("综合 C")) { assert.match(prompt, /A 的结果/); return answer("C 的结果"); }
    return answer(prompt.endsWith("A") ? "A 的结果" : "B 的结果");
  };
  fixture.tool = async (_, args, ctx) => {
    const task = await ctx.tasks.start({ ...args, agentId: args.agent });
    ids.set(args.label, task.id); return { ok: true, output: JSON.stringify(task) };
  };
  const out = await runHarness(options({ taskRuntime: tasks }));
  assert.equal(peak, 2); assert.equal(active, 0); assert.equal(out.text, "已汇合所有任务并核实");
  assert.equal(out.calls.length, 7); assert.equal(out.budget.modelCalls, 7);
  assert.equal(tasks.snapshots.filter(t => t.status === "completed").length, 3);
  assert.ok(events.some(e => e.task?.status === "running"));
});

await test("子任务保存最终检查点后进程退出，恢复汇合原结果而不再次执行子模型", async () => {
  const saved = { version: 1, phase: "done", messages: [{ role: "user", content: "旧子任务说明" }, { role: "assistant", content: "已核实编号 888" }],
    parts: [{ id: "saved-answer", type: "text", text: "已核实编号 888" }, { id: "saved-track", type: "trajectory", status: "done", partial: false }],
    todo: [], lastText: "已核实编号 888", nextStep: 2, pendingCalls: [], budget: { modelCalls: 1, tokens: 13, elapsedMs: 1 }, completedWrites: [] };
  const tasks = createTaskRuntime({ initial: [{ id: "child-crashed", agentId: "explore", prompt: "旧子任务说明", dependencies: [], status: "running", checkpoint: saved }] });
  let parentCalls = 0;
  fixture.complete = async o => {
    assert.equal(o.sessionId, "fixture-root", "子模型不能重新请求");
    if (++parentCalls > 1) assert.ok(o.messages.some(m => /子任务已汇合/.test(m.content) && /888/.test(m.content)));
    return answer("汇合已恢复的原结果");
  };
  const out = await runHarness(options({ taskRuntime: tasks }));
  assert.equal(parentCalls, 2); assert.equal(out.calls.length, 2);
  assert.equal(tasks.snapshots[0].status, "completed"); assert.match(tasks.snapshots[0].summary, /888/);
});

await test("短原生调用编号映射稳定设备执行编号，恢复从本机 journal 核实写入而不重发", async () => {
  const ctrl = new AbortController(); let state, persisted, writes = 0, executionId;
  const resultText = 'PRIVATE_JOURNAL_RESULT';
  fixture.complete = async () => ({ content: "", toolCalls: [call("0", "local", { action: "write", path: "local.txt", content: "local" })] });
  fixture.tool = async (_, __, ctx) => {
    writes++; executionId = ctx.callId; assert.match(executionId, /^local_[a-f0-9]{32}$/);
    ctrl.abort({ kind: "pause" }); throw Object.assign(new Error("响应丢失"), { code: "ABORTED" });
  };
  await assert.rejects(runHarness(options({ signal: ctrl.signal, onCheckpoint: async (s, meta) => { state = structuredClone(s); persisted = meta.persistable; } })), { code: "HARNESS_PAUSED" });
  assert.equal(state.pendingCalls[0].id, "0"); assert.equal(state.pendingCalls[0].executionId, executionId);
  assert.equal(persisted.pendingCalls[0].executionId, executionId);
  fixture.complete = async o => {
    assert.ok(o.messages.some(m => m.role === "tool" && m.tool_call_id === "0" && m.content === resultText));
    return answer("已核实本机执行记录");
  };
  await runHarness(options({ resumeState: state, localResults: { get: async id => { assert.equal(id, executionId); return { found: true, ok: true, output: resultText }; } } }));
  assert.equal(writes, 1);
});

await test("上游跨步及续段复用编号时实际本机 journal 不碰撞，暂停恢复仍复用原写入编号", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ooapi-call-id-fixture-"));
  const workspaceId = crypto.randomUUID(), executionIds = [];
  let reads = 0, writes = 0, executions = 0, step = 0, state;
  const executor = await createExecutor({ stateDirectory: path.join(temporary, "private"), workspaceId,
    root: path.join(temporary, "workspace"), allowWrite: true, allowExec: true,
    workspaceFactory: async root => ({ root, capabilities: { read: true, write: true, exec: true, docker: true },
      execute: async action => action === "read" ? (reads++, { content: "synthetic source", sha256: "a".repeat(64) })
        : action === "write" ? (writes++, { verified: true, changed: true })
          : (executions++, { exitCode: 0, output: "synthetic command result" }) }) });
  try {
    const ctrl = new AbortController();
    fixture.complete = async () => ({ content: "", toolCalls: [++step === 1
      ? call("0", "local", { action: "read", path: "synthetic.txt" })
      : call("0", "local", { action: "write", path: "synthetic.txt", content: "updated", expectedSha256: "a".repeat(64) })] });
    fixture.tool = async (_, args, ctx) => {
      executionIds.push(ctx.callId);
      const result = await executor.execute({ callId: ctx.callId, workspaceId, action: args.action, args });
      assert.equal(result.ok, true, result.output);
      if (args.action === "write") { ctrl.abort({ kind: "pause" }); throw Object.assign(new Error("synthetic response lost"), { code: "ABORTED" }); }
      return result;
    };
    await assert.rejects(runHarness(options({ signal: ctrl.signal, localSensitive: true,
      onCheckpoint: async s => { state = structuredClone(s); } })), { code: "HARNESS_PAUSED" });
    assert.equal(state.pendingCalls[0].status, "unknown");
    assert.equal(state.pendingCalls[0].executionId, executionIds[1]);
    assert.notEqual(executionIds[0], executionIds[1]);
    fixture.complete = async o => {
      assert.ok(o.messages.some(m => m.role === "tool" && m.tool_call_id === "0" && m.content.includes('"verified":true')));
      return answer("写入日志已核实");
    };
    const restored = await runHarness(options({ resumeState: state, localSensitive: true, localResults: {
      get: async callId => {
        assert.equal(callId, executionIds[1]);
        const result = await executor.execute({ callId: `lookup_${crypto.randomBytes(16).toString("hex")}`, workspaceId,
          action: "result_get", args: { callId } });
        return JSON.parse(result.output);
      },
    } }));
    assert.equal(reads, 1); assert.equal(writes, 1);
    step = 0;
    fixture.complete = async () => ++step === 1 ? { content: "", toolCalls: [call("0", "local", { action: "exec", command: "synthetic fixture command" })] } : answer("续段已核实");
    fixture.tool = async (_, args, ctx) => {
      executionIds.push(ctx.callId);
      const result = await executor.execute({ callId: ctx.callId, workspaceId, action: args.action, args });
      assert.equal(result.ok, true, result.output); return result;
    };
    const continued = await runHarness(options({ resumeState: restored.checkpoint, userText: "继续执行新的本机任务", localSensitive: true }));
    assert.equal(continued.checkpoint.turnId, restored.checkpoint.turnId);
    assert.equal(continued.text, "续段已核实");
    assert.equal(executions, 1); assert.equal(new Set(executionIds).size, 3);
    assert.equal(reads, 1); assert.equal(writes, 1);
  } finally { executor.stop(); await fs.rm(temporary, { recursive: true, force: true }); }
});

await test("本地命令非零退出保留已执行结果不重跑；明确未执行时允许重新批准", async () => {
  let step = 0, executions = 0;
  fixture.complete = async () => step++ < 2 ? { content: "", toolCalls: [call(`exec-${step}`, "local", { action: "exec", command: "fixture-command" })] } : answer("命令已执行但失败，请核实部分更改");
  fixture.tool = async () => (executions++, { ok: false, outcome: "executed", output: '{"exitCode":1,"modifiedFiles":1}' });
  await runHarness(options()); assert.equal(executions, 1);
  step = executions = 0;
  fixture.complete = async () => step++ < 2 ? { content: "", toolCalls: [call(`retry-exec-${step}`, "local", { action: "exec", command: "fixture-command" })] } : answer("设备已授权执行");
  fixture.tool = async () => ++executions === 1 ? { ok: false, outcome: "not_executed", output: "设备权限尚未开启" } : { ok: true, outcome: "executed", output: '{"exitCode":0}' };
  await runHarness(options()); assert.equal(executions, 2);
});
delete globalThis.__ooOrchestrationFixture;
await test("本地结果未知异常保留 waiting_local 和执行编号，重连只核实 journal 不重发命令", async () => {
  let state, calls = 0, modelCalls = 0;
  fixture.complete = async () => ++modelCalls === 1 ? { content: "", toolCalls: [call("0", "local", { action: "exec", command: "fixture command" })] } : answer("本机日志确认完成");
  fixture.tool = async () => { calls++; throw Object.assign(new Error("设备结果暂不可用"), { code: "LOCAL_OUTCOME_UNKNOWN" }); };
  await assert.rejects(runHarness(options({ onCheckpoint: async s => { state = structuredClone(s); } })), { code: "LOCAL_OUTCOME_UNKNOWN" });
  assert.equal(state.phase, "waiting_local"); assert.equal(state.pendingCalls[0].status, "unknown");
  const executionId = state.pendingCalls[0].executionId; assert.match(executionId, /^local_[a-f0-9]{32}$/);
  const restored = await runHarness(options({ resumeState: state, localResults: { get: async id => {
    assert.equal(id, executionId); return { found: true, uncertain: false, ok: true, output: "journal confirmed" };
  } } }));
  assert.equal(calls, 1); assert.equal(restored.text, "本机日志确认完成");
});

await test("角色权限刷新后原生/text 工具路径都重新构建当前用户的系统说明", async () => {
  const user = { id: 1, role: 100 }, built = [];
  fixture.systemPrompt = o => { built.push(o); return `ROLE=${o.userRole}`; };
  fixture.complete = async o => {
    assert.equal(user.role, 1);
    for (const nativeTools of [true, false]) {
      const prepared = o.prepareRequest({ nativeTools });
      assert.equal(prepared.messages[0].content, "ROLE=1"); assert.ok(prepared.prompt.includes("ROLE=1"));
    }
    return answer("按用户权限解释支持范围");
  };
  try {
    await runHarness(options({ user, beforeModel: async () => { user.role = 1; } }));
    assert.ok(built.some(o => o.userRole === 100));
    assert.ok(built.some(o => o.userRole === 1 && o.nativeTools === true));
    assert.ok(built.some(o => o.userRole === 1 && o.nativeTools === false));
  } finally { fixture.systemPrompt = null; }
});

console.log(`  编排/恢复/预算/本地隐私回归 ${count} 项通过`);
