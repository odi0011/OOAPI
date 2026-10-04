import assert from "node:assert/strict";
import test from "node:test";
import { createTaskRuntime } from "../src/services/harness/task-runtime.js";
import { persistedWorkspaceParts, persistedBillCall } from "../src/services/harness/workspace-privacy.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test("子任务最多三并发，依赖真正收到前置结果，汇合不会漏掉尚未启动的任务", async () => {
  let active = 0, peak = 0; const prompts = [], ctrl = new AbortController();
  const runtime = createTaskRuntime({ save: async () => delay(1) });
  const api = runtime.bind({ signal: ctrl.signal, runAgent: async o => {
    prompts.push(o.prompt); peak = Math.max(peak, ++active); await delay(15); active--;
    return { text: `result:${o.prompt}` };
  } });
  const jobs = await Promise.all([1, 2, 3, 4].map(i => api.start({ agent: "explore", prompt: `job${i}` })));
  const summary = await api.start({ agent: "explore", prompt: "汇总", dependencies: jobs.map(t => t.id) });
  const result = await runtime.settle();
  assert.equal(result.pending, 0); assert.equal(peak, 3); assert.equal(active, 0);
  assert.equal((await api.get(summary.id)).status, "completed");
  assert.ok(prompts.at(-1).includes("result:job4"));
});
test("终态继续只追加一次指令，恢复完成检查点不重新运行原任务", async () => {
  const calls = [], ctrl = new AbortController();
  const runtime = createTaskRuntime({ initial: [{ id: "existing", agentId: "explore", prompt: "原任务", dependencies: [], status: "running", checkpoint: { phase: "done" } }] });
  const api = runtime.bind({ signal: ctrl.signal, runAgent: async o => { calls.push(o); return { text: "结果" }; } });
  await runtime.settle(); assert.equal(calls[0].recoverFinal, true);
  await api.steer("existing", "继续检查"); await runtime.settle();
  assert.equal(calls[1].prompt, "继续检查"); assert.equal(calls[1].recoverFinal, false);
  assert.deepEqual(calls[1].inbox.drain(), []);
});
test("取消等待真实任务收尾，partial前置结果不能伪装成完成", async () => {
  let finished = false; const ctrl = new AbortController();
  const runtime = createTaskRuntime();
  const api = runtime.bind({ signal: ctrl.signal, runAgent: async o => {
    if (o.prompt === "partial") return { text: "未完成", partial: true };
    await new Promise(resolve => o.signal.addEventListener("abort", resolve, { once: true }));
    await delay(5); finished = true; throw new Error("取消");
  } });
  const partial = await api.start({ prompt: "partial" });
  const blocked = await api.start({ prompt: "不能运行", dependencies: [partial.id] });
  const cancelled = await api.start({ prompt: "取消我" });
  await delay(10); await api.cancel(cancelled.id); const settled = await runtime.settle();
  assert.equal(finished, true); assert.equal(settled.pending, 0);
  assert.equal((await api.get(partial.id)).status, "partial"); assert.equal((await api.get(blocked.id)).status, "blocked");
});
test("本地任务的私有说明先保存本机，云记录不包含文件内容或生成摘要", async () => {
  const privateRecords = [], cloud = [], ctrl = new AbortController();
  const runtime = createTaskRuntime({ sensitive: true, savePrivate: async t => privateRecords.push(structuredClone(t)), save: async t => cloud.push(t) });
  const api = runtime.bind({ signal: ctrl.signal, runAgent: async o => ({ text: `LOCAL_SENTINEL:${o.prompt}` }) });
  await api.start({ prompt: "LOCAL_SENTINEL文件", label: "LOCAL_SENTINEL标题" }); await runtime.settle();
  assert.ok(JSON.stringify(privateRecords).includes("LOCAL_SENTINEL"));
  assert.ok(!JSON.stringify(cloud).includes("LOCAL_SENTINEL"));
  assert.ok(JSON.stringify(runtime.snapshots).includes("LOCAL_SENTINEL"));
});
test("本地错误/文本/工具参数全部脱敏，计费仍保存实际usage", () => {
  const parts = persistedWorkspaceParts([{ type: "text", text: "LOCAL_SENTINEL" }, { type: "tool", tool: "local", args: { path: "LOCAL_SENTINEL" }, output: "LOCAL_SENTINEL" }, { type: "error", code: "ERR", message: "LOCAL_SENTINEL" }], true);
  const call = persistedBillCall({ model: "fixture", prompt: "LOCAL_SENTINEL", output: "LOCAL_SENTINEL", usage: { prompt_tokens: 17, completion_tokens: 3 } });
  assert.ok(!JSON.stringify({ parts, call }).includes("LOCAL_SENTINEL"));
  assert.equal(call.tokens.promptTokens, 17); assert.equal(call.tokens.completionTokens, 3);
});
test("父暂停保留运行和排队子任务，父停止取消两者，不再接受新的子任务指令", async () => {
  for (const paused of [true, false]) {
    const ctrl = new AbortController(), runtime = createTaskRuntime({ concurrency: 1 });
    let entered; const started = new Promise(resolve => { entered = resolve; });
    const api = runtime.bind({ signal: ctrl.signal, runAgent: async o => {
      entered(); await new Promise(resolve => o.signal.addEventListener("abort", resolve, { once: true })); throw o.signal.reason;
    } });
    const first = await api.start({ prompt: "当前任务" }); await started;
    const queued = await api.start({ prompt: "排队任务" });
    ctrl.abort(Object.assign(new Error(paused ? "暂停" : "停止"), { code: paused ? "HARNESS_PAUSED" : "ABORTED" }));
    await assert.rejects(api.start({ prompt: "不应接受" }), { code: "TASK_PARENT_INACTIVE", status: 409 });
    await assert.rejects(api.steer(first.id, "不应接受"), { code: "TASK_PARENT_INACTIVE", status: 409 });
    const result = await runtime.settle({ cancel: true });
    assert.equal(result.pending, paused ? 2 : 0);
    for (const id of [first.id, queued.id]) assert.equal((await api.get(id)).status, paused ? "pending" : "cancelled");
  }
});
test("子任务预算/本机断线进入可恢复状态，依赖汇合不挂起，清理不丢恢复点", async () => {
  for (const code of ["HARNESS_BUDGET", "LOCAL_OUTCOME_UNKNOWN"]) {
    const runtime = createTaskRuntime(), ctrl = new AbortController();
    const api = runtime.bind({ signal: ctrl.signal, runAgent: async o => {
      await o.onCheckpoint({ phase: "paused", nativeToolCallId: "original-call" });
      throw Object.assign(new Error("需用户继续"), { code });
    } });
    const first = await api.start({ prompt: "需要恢复" });
    const next = await api.start({ prompt: "等前置任务", dependencies: [first.id] });
    const settled = await runtime.settle();
    assert.equal(settled.pending, 2); assert.equal((await api.wait({ timeoutMs: 0 })).complete, true);
    const status = code === "HARNESS_BUDGET" ? "paused" : "waiting_local";
    assert.deepEqual(runtime.snapshots.map(t => t.status), [status, status]);
    await runtime.settle({ cancel: true, resumable: true }); await runtime.settle({ cancel: true });
    assert.deepEqual(runtime.snapshots.map(t => t.status), [status, status]);
    const invocations = [], resumed = createTaskRuntime({ initial: [...runtime.records.values()].map(t => structuredClone(t)) });
    const restoredApi = resumed.bind({ signal: new AbortController().signal, runAgent: async o => {
      invocations.push(o); return { text: `已完成:${o.prompt}` };
    } });
    const result = await resumed.settle(); assert.equal(result.pending, 0); assert.equal(invocations.length, 2);
    assert.equal(invocations[0].resumeState.nativeToolCallId, "original-call");
    assert.equal((await restoredApi.get(next.id)).status, "completed");
  }
});
test("父控制异常无需中止父 signal，也能暂停正在执行的子任务与排队任务", async () => {
  const runtime = createTaskRuntime({ concurrency: 1 }), ctrl = new AbortController();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const api = runtime.bind({ signal: ctrl.signal, runAgent: async o => {
    entered(); await new Promise(resolve => o.signal.addEventListener("abort", resolve, { once: true })); throw o.signal.reason;
  } });
  await api.start({ prompt: "当前" }); await started; await api.start({ prompt: "排队" });
  const result = await runtime.settle({ cancel: true, resumable: true });
  assert.equal(ctrl.signal.aborted, false); assert.equal(result.pending, 2);
  assert.deepEqual(runtime.snapshots.map(t => t.status), ["pending", "pending"]);
  await assert.rejects(api.steer(runtime.snapshots[0].id, "新指令"), { code: "TASK_PARENT_INACTIVE" });
});
test("显式取消与父暂停同时发生不会把已取消子任务复活", async () => {
  const ctrl = new AbortController(), runtime = createTaskRuntime();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const api = runtime.bind({ signal: ctrl.signal, runAgent: async o => {
    entered(); await new Promise(resolve => o.signal.addEventListener("abort", resolve, { once: true })); await delay(5); throw o.signal.reason;
  } });
  const job = await api.start({ prompt: "取消我" }); await started;
  ctrl.abort(Object.assign(new Error("暂停"), { code: "HARNESS_PAUSED" })); await api.cancel(job.id);
  const result = await runtime.settle({ cancel: true });
  assert.equal(result.pending, 0); assert.equal((await api.get(job.id)).status, "cancelled");
});
test("加载恢复点期间取消，不得继续发起子模型调用", async () => {
  let hydrateDone; const ready = new Promise(resolve => { hydrateDone = resolve; });
  let calls = 0;
  const runtime = createTaskRuntime({ hydrate: async () => ready });
  const api = runtime.bind({ signal: new AbortController().signal, runAgent: async () => { calls++; return { text: "不应执行" }; } });
  const job = await api.start({ prompt: "取消恢复" }); await api.cancel(job.id); hydrateDone(null);
  await runtime.settle(); assert.equal(calls, 0); assert.equal((await api.get(job.id)).status, "cancelled");
});
