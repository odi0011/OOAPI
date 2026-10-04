import crypto from "node:crypto";
import { splitTokens } from "../pricing.js";

const finite = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
export function normalizeHarnessBudget(raw = {}) {
  return {
    maxWallTimeMs: finite(raw.maxWallTimeMs, 1800000, 1000, 14400000),
    maxModelCalls: Math.floor(finite(raw.maxModelCalls, 64, 1, 512)),
    maxTokens: Math.floor(finite(raw.maxTokens, 1000000, 256, 16000000)),
    ...(Number(raw.maxOd) > 0 ? { maxOd: finite(raw.maxOd, 1, .000001, 10000) } : {}),
  };
}
export function harnessInterruption(signal) {
  const reason = signal?.reason;
  if (reason?.code === "HARNESS_BUDGET") return reason;
  if (reason?.kind === "pause" || reason?.code === "HARNESS_PAUSED") return Object.assign(new Error("任务已暂停，可从已保存的位置继续"), { code: "HARNESS_PAUSED" });
  return Object.assign(new Error("已停止"), { code: "ABORTED" });
}
const exceeded = reason => Object.assign(new Error(`任务预算已用完（${reason}），已保存当前进度`), { code: "HARNESS_BUDGET", reason });

// 预算与额度结算分开：只计实际调用的已知消耗，价格必须由调用方复用 pricing.js 提供。
// 父子代理和检索共用同一实例；请求发起前预留 token，防并发子任务同时透支。
export function createHarnessRuntime({ budget = {}, state = {}, signal, costOfCall } = {}) {
  const limits = normalizeHarnessBudget(budget);
  const controller = new AbortController();
  const usage = {
    elapsedMs: Math.max(0, Number(state.elapsedMs) || 0),
    modelCalls: Math.max(0, Number(state.modelCalls) || 0),
    tokens: Math.max(0, Number(state.tokens) || 0),
    od: Math.max(0, Number(state.od) || 0),
  };
  const started = Date.now(), reservations = new Map();
  let sensitive = Boolean(state.sensitive), closed = false, persistenceTail = Promise.resolve(), budgetFailure;
  const aborted = () => controller.abort(signal.reason);
  if (signal?.aborted) aborted(); else signal?.addEventListener("abort", aborted, { once: true });
  const timer = setTimeout(() => controller.abort(exceeded("运行时间")), Math.max(1, limits.maxWallTimeMs - usage.elapsedMs));
  timer.unref?.();
  const snapshot = () => ({ ...usage, elapsedMs: usage.elapsedMs + Date.now() - started, sensitive, limits });
  const check = () => {
    if (budgetFailure) throw budgetFailure;
    if (controller.signal.aborted) throw harnessInterruption(controller.signal);
    if (snapshot().elapsedMs >= limits.maxWallTimeMs) throw exceeded("运行时间");
    if (usage.tokens >= limits.maxTokens) throw exceeded("Token");
    if (limits.maxOd && usage.od >= limits.maxOd) throw exceeded("OD币");
  };
  return {
    signal: controller.signal, limits, snapshot, check,
    get sensitive() { return sensitive; },
    markSensitive() { sensitive = true; },
    async beforeModel({ promptTokens = 0, maxOutputTokens = 8192, model = "" } = {}) {
      check();
      if (usage.modelCalls >= limits.maxModelCalls) throw exceeded("模型调用次数");
      if (limits.maxOd && typeof costOfCall !== "function") throw Object.assign(new Error("OD预算未接入统一计费估算，不能开始任务"), { code: "HARNESS_BUDGET_CONFIGURATION" });
      const reserved = [...reservations.values()].reduce((n, v) => n + v.tokens, 0);
      const available = Math.floor(limits.maxTokens - usage.tokens - reserved - promptTokens);
      if (available < 1) throw exceeded("Token");
      const output = Math.max(1, Math.min(maxOutputTokens || 8192, available));
      const id = crypto.randomUUID();
      reservations.set(id, { tokens: promptTokens + output, od: 0 });
      if (limits.maxOd) {
        try {
          const od = Number(await costOfCall({ model, tokens: { promptTokens, completionTokens: output, cacheTokens: 0, estimated: true }, budgetEstimate: true }));
          check();
          if (!Number.isFinite(od) || od < 0) throw Object.assign(new Error("无法核实任务预算价格"), { code: "HARNESS_BUDGET_CONFIGURATION" });
          const held = [...reservations.values()].reduce((n, v) => n + v.od, 0);
          if (usage.od + held + od > limits.maxOd) throw exceeded("OD币");
          reservations.get(id).od = od;
        } catch (e) { reservations.delete(id); throw e; }
      }
      // 价格预检可能让出事件循环，先排队的请求也可能已占满模型调用预算。
      if (usage.modelCalls >= limits.maxModelCalls) { reservations.delete(id); throw exceeded("模型调用次数"); }
      usage.modelCalls++;
      return { id, maxOutputTokens: output };
    },
    async settleModel(permit, call) {
      if (!permit || !reservations.has(permit.id)) return;
      reservations.delete(permit.id);
      if (call) {
        const t = call.tokens || splitTokens({ prompt: call.prompt || "", output: call.output || "", upstreamTotal: call.usage });
        usage.tokens += t.promptTokens + t.completionTokens;
        if (costOfCall) {
          try {
            const od = Number(await costOfCall({ ...call, tokens: t }));
            if (!Number.isFinite(od) || od < 0) throw new Error("unknown cost");
            usage.od += od;
          } catch {
            // 已成功生成的回复仍需 record/结算，不能因预算核价失败丢掉真实账单。
            budgetFailure = Object.assign(new Error("无法核实任务消耗，已暂停后续调用"), { code: "HARNESS_BUDGET_CONFIGURATION" });
          }
        }
      }
    },
    // 子任务 checkpoint 可能并发抵达。序列化外部落盘，不让较早快照覆盖较晚状态。
    persist(fn) {
      const next = persistenceTail.then(fn);
      persistenceTail = next.catch(() => {});
      return next;
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    },
  };
}

export const isLocalTool = (tool, spec) => spec?.sensitive === true || tool === "local" || String(tool).startsWith("local_");
export const fingerprintHash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const PRIVATE = "本地工作区内容仅保存在已连接设备";
export function privateToolPart(part) {
  return { id: part.id, type: part.type, tool: part.tool, name: part.name, status: part.status,
    step: part.step, started: part.started, ended: part.ended, created: part.created,
    args: { local: true, callId: part.callId || part.id }, output: PRIVATE,
    sensitive: true, callId: part.callId || part.id };
}
export function sanitizeCheckpoint(state, { localSensitive = false } = {}) {
  const copy = structuredClone(state);
  if (!localSensitive && !copy.sensitive) return copy;
  copy.sensitive = true;
  copy.requiresLocalContext = true;
  copy.messages = (copy.messages || []).map(m => ({ role: m.role, content: PRIVATE,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id, name: m.name } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls.map(c => ({ id: c.id, type: "function", function: { name: c.function?.name, arguments: "{}" } })) } : {}) }));
  copy.parts = (copy.parts || []).map(p => p.type === "tool" ? privateToolPart(p) : ({ id: p.id, type: p.type,
    status: p.status, started: p.started, ended: p.ended, step: p.step, ...(p.type === "trajectory" ? { budget: p.budget, reason: p.reason, partial: p.partial } : { text: PRIVATE }) }));
  copy.todo = (copy.todo || []).map((t, i) => ({ content: `本地任务 ${i + 1}`, status: t.status }));
  copy.pendingCalls = (copy.pendingCalls || []).map(c => ({ id: c.id, executionId: c.executionId, tool: c.tool, status: c.status, write: c.write, local: c.local, partId: c.partId, args: {} }));
  copy.completedWrites = (copy.completedWrites || []).map(([key, value]) => [key, { ok: value.ok, outcome: value.outcome, output: PRIVATE }]);
  copy.lastText = "";
  if (copy.pendingAssistant) copy.pendingAssistant = { role: "assistant", content: PRIVATE, tool_calls: copy.messages.at(-1)?.tool_calls || [] };
  return copy;
}

// 只读任务同批可以并行，但等待所有已启动任务结束再返回/抛错，不能留下失管的后台写入。
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0, failure;
  const worker = async () => {
    while (!failure && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await fn(items[index], index); } catch (e) { failure ||= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return results;
}
