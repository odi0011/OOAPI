import test from "node:test";
import assert from "node:assert/strict";
import { archiveLocalMessage, hydrateLocalMessages } from "../src/services/harness/local-history.js";

const workspace = { id: "workspace-fixture", online: true };
const run = { id: "run-fixture-0123" };
const secretParts = [{ id: "tool-part", type: "tool", tool: "local", args: { path: "private-code.js", content: "private-file-content" }, output: "private-tool-output" }, { id: "text-part", type: "text", text: "private-answer" }];
const message = (part, seq = 1) => ({ id: seq, seq, role: "assistant", parts: [{ type: "text", text: "本地内容保存在已连接电脑" }, part], cost: .1 });

test("归档正文/工具完整保存到本机，云端返回仅安全引用", async () => {
  const saves = [];
  const ref = await archiveLocalMessage({ workspace, run, segment: 3, parts: secretParts, save: async (...args) => { saves.push(args); args[1].parts[0].output = "modified-private-copy"; } });
  assert.equal(ref.ref, `${run.id}-message-3`); assert.equal(ref.workspaceId, workspace.id);
  assert.deepEqual(Object.keys(ref).sort(), ["id", "ref", "type", "workspaceId"]);
  assert.ok(!JSON.stringify(ref).includes("private"));
  assert.equal(saves[0][0], ref.ref); assert.equal(saves[0][1].parts[1].text, "private-answer");
  assert.equal(secretParts[0].output, "private-tool-output", "不得修改当前流式正文");
});
test("设备离线/归档失败仍返回安全引用，不把异常或正文退回云端", async () => {
  let calls = 0;
  const off = await archiveLocalMessage({ workspace: { ...workspace, online: false }, run, segment: 0, parts: secretParts, save: () => { calls++; } });
  assert.equal(calls, 0);
  const failed = await archiveLocalMessage({ workspace, run, segment: 0, parts: secretParts, save: async () => { throw new Error("private-path-and-result"); } });
  assert.deepEqual(failed, off); assert.ok(!JSON.stringify(failed).includes("private"));
  await assert.rejects(archiveLocalMessage({ workspace, run: { id: "../private-path" }, segment: 0, parts: [] }), /编号无效/);
  await assert.rejects(archiveLocalMessage({ workspace, run, segment: "1", parts: [] }), /编号无效/);
});
test("绑定一致、在线时临时恢复正文和工具；不修改原cloud parts或本机缓存", async () => {
  const ref = await archiveLocalMessage({ workspace, run, segment: 0, parts: secretParts });
  const original = [message(ref)], originalJson = JSON.stringify(original), cache = { parts: structuredClone(secretParts) };
  const restored = await hydrateLocalMessages(original, { workspace, load: async (id, options) => { assert.equal(id, ref.ref); assert.ok(Object.hasOwn(options, "signal")); assert.equal(options.workspaceId, workspace.id); return cache; } });
  assert.deepEqual(restored[0].parts, secretParts); assert.equal(restored[0].cost, .1);
  restored[0].parts[0].output = "mutated-display";
  assert.equal(JSON.stringify(original), originalJson); assert.equal(cache.parts[0].output, "private-tool-output");
});
test("换工作区、离线、user伪ref或无效ref不能读取本机归档", async () => {
  const ref = await archiveLocalMessage({ workspace, run, segment: 0, parts: [] });
  const messages = [message(ref), { ...message(ref), role: "user" }, message({ ...ref, ref: "../../private-file" })];
  let calls = 0;
  const load = async () => { calls++; return { parts: secretParts }; };
  assert.deepEqual(await hydrateLocalMessages(messages, { workspace: { ...workspace, id: "different-workspace" }, load }), messages);
  assert.deepEqual(await hydrateLocalMessages(messages, { workspace: { ...workspace, online: false }, load }), messages);
  assert.deepEqual(await hydrateLocalMessages(messages.slice(1), { workspace, load }), messages.slice(1));
  assert.equal(calls, 0);
});
test("一份归档失败不丢其他历史，仅最新分段允许主run检查点兜底", async () => {
  const old = await archiveLocalMessage({ workspace, run, segment: 0, parts: [] });
  const newest = await archiveLocalMessage({ workspace, run, segment: 1, parts: [] });
  const calls = [], messages = [message(old, 1), message(newest, 2)];
  const result = await hydrateLocalMessages(messages, { workspace, fallbackRefs: new Set([newest.ref]), load: async id => { calls.push(id); if (id === run.id) return { phase: "done", billingSegment: 1, parts: secretParts }; throw new Error("offline file path"); } });
  assert.deepEqual(result[0], messages[0]); assert.deepEqual(result[1].parts, secretParts);
  assert.equal(calls.filter(id => id === run.id).length, 1);
  const denied = await hydrateLocalMessages(messages, { workspace, load: async id => { if (id === run.id) return { billingSegment: 1, parts: secretParts }; throw new Error("missing"); } });
  assert.deepEqual(denied, messages, "服务端未允许的主run回退不得读取");
  const wrongSegment = await hydrateLocalMessages(messages, { workspace, fallbackRefs: new Set([newest.ref]), load: async id => { if (id === run.id) return { billingSegment: 2, parts: secretParts }; throw new Error("missing"); } });
  assert.deepEqual(wrongSegment, messages, "新分段的检查点不能顶替旧消息");
});
test("仅恢复最近50份消息且读取并发最多3；非法响应保留占位", async () => {
  const messages = await Promise.all(Array.from({ length: 55 }, async (_, index) => message(await archiveLocalMessage({ workspace, run, segment: index, parts: [] }), index)));
  const seen = []; let active = 0, peak = 0;
  const result = await hydrateLocalMessages(messages, { workspace, load: async ref => {
    active++; peak = Math.max(peak, active); seen.push(ref); await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return { parts: [{ type: "text", text: ref }] };
  } });
  assert.equal(seen.length, 50); assert.equal(peak, 3);
  for (let index = 0; index < 5; index++) assert.deepEqual(result[index], messages[index]);
  assert.equal(result[54].parts[0].text, `${run.id}-message-54`);
  assert.deepEqual(await hydrateLocalMessages(messages.slice(-1), { workspace, load: async () => ({ parts: [null] }) }), messages.slice(-1));
  assert.deepEqual(await hydrateLocalMessages(messages.slice(-1), { workspace, load: async () => ({ parts: [{ type: "text", text: () => "invalid-cache" }] }) }), messages.slice(-1));
});
test("取消后不再派发新加载，迟到结果不覆盖云端占位", async () => {
  const ref = await archiveLocalMessage({ workspace, run, segment: 0, parts: [] }), messages = [message(ref)], ctrl = new AbortController();
  let calls = 0;
  const result = await hydrateLocalMessages(messages, { workspace, signal: ctrl.signal, load: async () => { calls++; ctrl.abort(); return { parts: secretParts }; } });
  assert.equal(calls, 1); assert.deepEqual(result, messages);
  assert.deepEqual(await hydrateLocalMessages(messages, { workspace, signal: ctrl.signal, load: async () => { calls++; } }), messages);
  assert.equal(calls, 1);
});
test("总deadline终止不遵守signal的本机加载，不再派发剩余请求或回写迟到结果", async () => {
  const messages = await Promise.all(Array.from({ length: 10 }, async (_, index) => message(await archiveLocalMessage({ workspace, run, segment: index, parts: [] }), index)));
  let calls = 0, resolveLate; const started = Date.now();
  const result = await hydrateLocalMessages(messages, { workspace, deadlineMs: 10, load: () => { calls++; return new Promise(resolve => { resolveLate = resolve; }); } });
  assert.deepEqual(result, messages); assert.equal(calls, 3); assert.ok(Date.now() - started < 500);
  resolveLate({ parts: secretParts }); await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(result, messages, "deadline后不能回写迟到正文");
});
test("相同归档重复出现只读取一次，恢复最近消息的各份临时显示副本", async () => {
  const ref = await archiveLocalMessage({ workspace, run, segment: 0, parts: [] }), messages = [message(ref, 1), message(ref, 2)];
  let calls = 0;
  const result = await hydrateLocalMessages(messages, { workspace, load: async () => { calls++; return { parts: secretParts }; } });
  assert.equal(calls, 1); assert.deepEqual(result[0].parts, secretParts); assert.deepEqual(result[1].parts, secretParts);
  result[0].parts[0].output = "display-only"; assert.equal(result[1].parts[0].output, "private-tool-output");
});
