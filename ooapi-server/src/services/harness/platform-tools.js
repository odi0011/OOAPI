import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../db.js";
import { PLATFORM_CATALOG, platformAction, visiblePlatformCatalog } from "./platform-catalog.js";
import { callFingerprint } from "./tool-call-guards.js";
import { DEFAULT_OPTIONS, SECRET_OPTIONS, SUPER_OPTIONS } from "../../config.js";
import { platformChangePresentation, toolPresentation } from "./tool-presentation.js";
import { PRICE_FIELDS as priceFields, priceSnapshot } from "../config-precondition.js";

const grants = new WeakMap();
const preparations = new WeakMap();
const argumentPreparations = new WeakMap();
// 授权只存在服务端内存，绑定人、方法、完整参数并消费一次；模型参数不能伪造“已同意”。
export function grantToolCall(tool, args, userId) {
  const grant = {};
  grants.set(grant, { fingerprint: callFingerprint({ tool, args }), userId: Number(userId), expires: Date.now() + 60000 });
  return grant;
}
const secretKey = /(?:password|passwd|secret|credential|cookie|authorization|key_str|access_token|refresh_token|api_?key|jwt|private_key|^key$|^other$|^raw$|^input_text$|^upstream_request$|^upstream_response$|^detail$)/i;
export function cleanPlatformResult(value, depth = 0) {
  if (depth > 10) return "（嵌套内容省略）";
  if (typeof value === "string") return value.replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[^\s"<>]+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/g, "[已隐藏凭据]").replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[已隐藏凭据]@").slice(0, 16000);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => cleanPlatformResult(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !secretKey.test(k) && !SECRET_OPTIONS.has(k) && !["__proto__", "prototype", "constructor"].includes(k)).map(([k, v]) => [k, cleanPlatformResult(v, depth + 1)]));
}
function hasSensitiveInput(value) {
  return value && typeof value === "object" && Object.entries(value).some(([k, v]) => secretKey.test(k) || SECRET_OPTIONS.has(k) || ["__proto__", "prototype", "constructor", "agent_flow"].includes(k) || hasSensitiveInput(v));
}
const object = value => value && typeof value === "object" && !Array.isArray(value);
export function platformRequest(tool, args, user, sessionId) {
  const action = platformAction(tool, args);
  if (!action) throw new Error("未知平台方法，请先用 describe 查看可用方法和参数。");
  if (!user?.id || Number(user.role) < action.role) throw new Error("当前账号没有此操作的权限。");
  const params = args.params ?? {}, data = args.data ?? {};
  if (!object(params) || !object(data)) throw new Error("params 和 data 必须是 JSON 对象。");
  if (JSON.stringify({ params, data }).length > 64000) throw new Error("操作内容过长，请缩小范围。");
  if (hasSensitiveInput(data)) throw new Error("密码、密钥、凭据和智能体权限配置请在对应设置页面操作，不要放进对话。");
  if (tool === "users" && args.action === "edit" && data.role !== undefined) {
    if (Number(user.role) < 1000) throw new Error("只有超级管理员可以变更用户角色，当前账号没有权限。");
    if (String(params.id) === String(user.id)) throw new Error("不能修改自己的角色。");
  }
  if (tool === "system" && args.action === "save_options") {
    for (const key of Object.keys(data)) {
      if (!Object.hasOwn(DEFAULT_OPTIONS, key)) throw new Error(`未知系统设置项：${key}`);
      if (SUPER_OPTIONS.has(key) && Number(user.role) < 1000) throw new Error(`设置项 ${key} 需要超级管理员权限，当前账号没有权限。`);
    }
  }
  const pathKeys = [...action.path.matchAll(/:(\w+)/g)].map(m => m[1]);
  for (const k of Object.keys(params)) if (![...pathKeys, ...action.query].includes(k)) throw new Error(`不支持的查询或路径参数：${k}`);
  for (const k of Object.keys(data)) if (!action.fields.includes("*") && !action.fields.includes(k)) throw new Error(`不支持的操作字段：${k}`);
  if (!action.write && Object.keys(data).length) throw new Error("查询操作不接受 data。");
  let path = action.path.replace(/:(\w+)/g, (_, k) => {
    const v = String(params[k] ?? "");
    if (!v || v.length > 180 || /[/?#\\\x00-\x1f]/.test(v) || v === "." || v === ".." || (k !== "model" && !/^[a-zA-Z0-9_-]+$/.test(v))) throw new Error(`请提供有效的 ${k} 编号。`);
    return encodeURIComponent(v);
  });
  if (tool === "workspace" && action.write && sessionId && (String(params.id) === String(sessionId) || Array.isArray(data.ids) && data.ids.map(String).includes(String(sessionId)))) throw new Error("当前对话正在执行，请在本轮结束后从会话栏修改或停止它。");
  const query = new URLSearchParams();
  for (const k of action.query) if (params[k] !== undefined) {
    if (!["string", "number", "boolean"].includes(typeof params[k]) || String(params[k]).length > 1000) throw new Error(`查询参数 ${k} 格式无效。`);
    query.set(k, String(params[k]));
  }
  if (query.size) path += `?${query}`;
  return { action, path, data };
}
const enabledFor = (ctx, tool) => ctx.enabledTools == null || new Set(ctx.enabledTools).has(tool);
function inheritedArgs(tool, args, ctx) {
  return tool === "models" && args.action === "available" && args.params?.keyId === undefined && Number(ctx.keyId) > 0
    ? { ...args, params: { ...args.params, keyId: Number(ctx.keyId) } } : args;
}
// 准备和读回只可读固定业务地址，不能通过模型参数指定 URL 或跳过原路由鉴权。
async function serverRequest(path, method, data, ctx, fetchImpl, label) {
  if (ctx.signal?.aborted) throw Object.assign(new Error("已停止"), { code: "ABORTED" });
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("平台端口未配置");
  const controller = new AbortController(), abort = () => controller.abort();
  ctx.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 25000);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, { method, redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${jwt.sign({ id: ctx.user.id, tv: Number(ctx.user.token_version) || 0 }, JWT_SECRET, { expiresIn: 120 })}`, "Content-Type": "application/json", "X-OOAPI-Tool": label },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("平台没有返回内容");
    const decoder = new TextDecoder();
    let raw = "", bytes = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("结果过大"); } raw += decoder.decode(value, { stream: true }); }
    raw += decoder.decode();
    let result; try { result = JSON.parse(raw); } catch { throw new Error("平台响应格式不正确"); }
    if (!res.ok || result.success === false) throw Object.assign(new Error(String(cleanPlatformResult(result.message || "平台拒绝了本次操作"))), { status: res.status, businessRejected: true });
    return result;
  } finally { clearTimeout(timer); ctx.signal?.removeEventListener("abort", abort); }
}
const serverRead = (path, ctx, fetchImpl) => serverRequest(path, "GET", undefined, ctx, fetchImpl, "platform.prepare");
async function currentSnapshot(tool, args, ctx, fetchImpl) {
  if (tool === "people") {
    const result = await serverRead("/api/user/self", ctx, fetchImpl);
    if (!object(result.data?.setting)) throw new Error("未能读取原偏好设置；为避免覆盖其他配置，本次不执行修改。");
    return structuredClone(result.data.setting);
  }
  const model = String(args.data?.model || "").trim();
  if (!model) throw new Error("缺少模型 ID。");
  const result = await serverRead(`/api/pricing?keyword=${encodeURIComponent(model)}`, ctx, fetchImpl);
  if (!Array.isArray(result.data)) throw new Error("模型定价响应格式不正确。");
  return priceSnapshot(result.data.find(row => String(row.model).toLowerCase() === model.toLowerCase()));
}
function mergeSettings(before, patch) {
  const out = structuredClone(before);
  for (const [key, value] of Object.entries(patch)) out[key] = object(value) && object(before[key]) ? mergeSettings(before[key], value) : structuredClone(value);
  return out;
}
const preparedWrite = (tool, args) => tool === "pricing" && args.action === "set" || tool === "people" && args.action === "settings";

/** 审批前调用：无业务写入。canonicalArgs 同时用于审批、grant 和执行，prepared 是不可由模型伪造的服务端凭据。 */
export async function preparePlatformCall(tool, args, ctx, { fetchImpl = fetch } = {}) {
  if (!ctx.user?.id) throw new Error("需要登录后使用平台工具。");
  if (!enabledFor(ctx, tool)) throw new Error("当前平台策略未开放此工具。");
  let canonicalArgs = structuredClone(inheritedArgs(tool, args, ctx));
  if (tool === "platform" || canonicalArgs.action === "describe") return { canonicalArgs, presentation: toolPresentation(tool, canonicalArgs), prepared: null };
  platformRequest(tool, canonicalArgs, ctx.user, ctx.sessionId);
  if (tool === "users" && (args.action === "delete" || args.action === "edit" && Number(args.data?.status) === 2)) {
    if (String(args.params?.id) === String(ctx.user.id)) throw new Error("不能删除或停用自己的账号。");
    if (Number(ctx.user.role) < 1000) {
      const target = await serverRead(`/api/profile/u/${encodeURIComponent(args.params.id)}`, ctx, fetchImpl);
      if (Number(target.data?.role) >= 100) throw new Error("只有超级管理员可以删除或停用管理员账号，当前账号没有权限。");
      if (!Number(target.data?.role)) throw new Error("未能核对目标账号权限，本次不执行修改。");
    }
  }
  if (!preparedWrite(tool, canonicalArgs)) return { canonicalArgs, presentation: toolPresentation(tool, canonicalArgs), prepared: null };
  const before = await currentSnapshot(tool, canonicalArgs, ctx, fetchImpl);
  if (tool === "people") {
    if (hasSensitiveInput(before)) throw new Error("原偏好含敏感配置，请在个人设置页面修改，避免将凭据带入对话。");
    canonicalArgs.data = mergeSettings(before, canonicalArgs.data || {});
    if (JSON.stringify(canonicalArgs.data).length > 16000) throw new Error("合并后的偏好设置过大，请缩小修改范围。");
  } else {
    const patch = canonicalArgs.data;
    if (!before && (patch.input_price == null || patch.output_price == null)) throw new Error("新模型定价必须提供输入和输出单价。");
    canonicalArgs.data = { ...(before || { cache_price: 0, channel_type: "", remark: "", offpeak_input_price: null, offpeak_output_price: null, offpeak_cache_price: null, offpeak_rule: null }), ...patch, model: before?.model || String(patch.model).trim() };
    for (const key of priceFields.filter(key => key.endsWith("_price"))) {
      const value = canonicalArgs.data[key];
      if (key.startsWith("offpeak_") && (value == null || value === "" || Number(value) === 0)) { canonicalArgs.data[key] = null; continue; }
      if (value == null || value === "" || !["number", "string"].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100000) throw new Error(`${key} 必须是 0–100000 的单价。`);
      canonicalArgs.data[key] = Number(Number(value).toFixed(6));
    }
    if (typeof canonicalArgs.data.offpeak_rule === "string" && canonicalArgs.data.offpeak_rule) {
      try { canonicalArgs.data.offpeak_rule = JSON.parse(canonicalArgs.data.offpeak_rule); } catch { throw new Error("闲时规则不是合法 JSON。"); }
    }
    canonicalArgs.data.offpeak_rule ||= null;
    if (object(canonicalArgs.data.offpeak_rule)) {
      const rule = canonicalArgs.data.offpeak_rule;
      canonicalArgs.data.offpeak_rule = { offset: Number(rule.offset || 0), days: rule.days || [1, 2, 3, 4, 5], peak: rule.peak, ...(rule.offpeakDates ? { offpeakDates: rule.offpeakDates } : {}) };
    }
  }
  platformRequest(tool, canonicalArgs, ctx.user, ctx.sessionId);
  const prepared = {};
  preparations.set(prepared, { tool, before, fingerprint: callFingerprint({ tool, args: canonicalArgs }), userId: Number(ctx.user.id) });
  argumentPreparations.set(canonicalArgs, prepared);
  return { canonicalArgs, presentation: platformChangePresentation(tool, canonicalArgs, before, canonicalArgs.data), prepared };
}
function encodeResult(value) {
  const cleaned = cleanPlatformResult(value);
  let output = JSON.stringify(cleaned);
  // 保留完整 JSON，超长列表逐项减少并说明，不能切断对象后让模型猜测残余内容。
  if (output.length > 22000) {
    const reduce = v => Array.isArray(v) ? v.slice(0, 15).map(reduce) : object(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reduce(x)])) : typeof v === "string" ? v.slice(0, 1800) : v;
    output = JSON.stringify({ data: reduce(cleaned), truncated: true, note: "内容过长，仅展示部分；请用筛选、分页或具体编号继续查询。" });
  }
  return output.length > 24000 ? JSON.stringify({ note: "结果过大，请缩小筛选范围后重查。" }) : output;
}
export async function runPlatformTool(tool, args, ctx, { fetchImpl = fetch } = {}) {
  const role = Number(ctx.user?.role) || 0;
  if (!ctx.user?.id) return { ok: false, output: "需要登录后使用平台工具。" };
  if (!enabledFor(ctx, tool)) return { ok: false, output: "当前平台策略未开放此工具。" };
  args = inheritedArgs(tool, args, ctx);
  if (args.action === "describe" || tool === "platform") {
    if (tool === "platform" && !["catalog", "describe"].includes(args.action)) return { ok: false, output: "platform 支持 catalog 和 describe。" };
    const groups = visiblePlatformCatalog(role, ctx.enabledTools).filter(g => tool === "platform" ? !args.group || g.id === args.group : g.id === tool);
    if (!groups.length) return { ok: false, output: "工具不存在或当前账号无权限。" };
    // 总目录先返回可发现的方法名；指定组再取完整参数，避免一轮耗尽上下文。
    const value = tool === "platform" && !args.group ? groups.map(g => ({ id: g.id, name: g.name, methods: g.actions.map(a => ({ action: a.action, title: a.title, write: a.write })) })) : groups;
    return { ok: true, output: JSON.stringify(value) };
  }
  let request;
  try { request = platformRequest(tool, args, ctx.user, ctx.sessionId); }
  catch (e) { return { ok: false, output: e.message }; }
  const { action, path, data } = request;
  let preparation;
  if (action.write) {
    const grant = grants.get(ctx.toolGrant);
    grants.delete(ctx.toolGrant);
    if (!grant || grant.userId !== Number(ctx.user.id) || grant.expires < Date.now() || grant.fingerprint !== callFingerprint({ tool, args })) return { ok: false, output: "此操作需要用户确认完整内容，尚未获得本次操作的授权。" };
    if (preparedWrite(tool, args)) {
      const prepared = ctx.platformPrepared || argumentPreparations.get(args);
      preparation = preparations.get(prepared);
      preparations.delete(prepared);
      if (!preparation || preparation.userId !== Number(ctx.user.id) || preparation.fingerprint !== grant.fingerprint || preparation.tool !== tool) return { ok: false, outcome: "not_executed", output: "此修改尚未读取原值并展示完整变更，请重新准备后交用户确认。" };
      try {
        const current = await currentSnapshot(tool, args, ctx, fetchImpl);
        if (!isDeepStrictEqual(current, preparation.before)) return { ok: false, outcome: "not_executed", output: "审批期间原配置已变化，本次没有写入；请读取最新值并重新确认，避免覆盖他人的修改。" };
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return { ok: false, outcome: "not_executed", output: "执行前未能核对最新配置，本次没有写入；请稍后重新读取并确认。" };
      }
    }
  }
  let writeAccepted = false;
  try {
    let payload = action.write ? { ...data } : undefined;
    if (preparation) payload = tool === "pricing" ? { ...payload, _internal_expected: preparation.before } : { _internal_setting: payload, _internal_expected: preparation.before };
    if (tool === "messages" && args.action === "send") payload.client_id ||= crypto.randomUUID();
    if (tool === "trading" && args.action === "create_demo") payload.environment = "demo";
    if (tool === "trading" && ["order", "close"].includes(args.action)) payload.client_order_id ||= crypto.randomUUID();
    const result = await serverRequest(path, action.verb, payload, ctx, fetchImpl, `${tool}.${args.action}`);
    writeAccepted = action.write;
    if (preparation) {
      // HTTP 成功只说明接口接收了请求；价格和偏好必须与实际保存值对账。
      const actual = await currentSnapshot(tool, args, ctx, fetchImpl);
      const expected = tool === "pricing" ? priceSnapshot(data) : data;
      const verified = tool === "pricing" ? actual && Object.entries(expected).every(([key, value]) => key === "channel_type" && !value || isDeepStrictEqual(actual[key], value)) : isDeepStrictEqual(actual, expected);
      if (!verified) return { ok: false, outcome: "unknown", output: "接口已接收修改，但读回结果与确认内容不一致；请先核查实际配置，禁止自动重试写入。", meta: { action: args.action, write: true, verified: false } };
      return { ok: true, outcome: "verified", output: encodeResult({ ...result, data: actual, verified: true }), meta: { action: args.action, write: true, verified: true } };
    }
    if (tool === "people" && args.action === "preferences") result.data = { setting: result.data?.setting || {} };
    if (tool === "models" && ["available", "prices"].includes(args.action)) {
      const query = String(args.params?.q || "").toLowerCase(), vendor = String(args.params?.vendor || "").toLowerCase();
      const items = (result.data?.models || result.data?.items || []).filter(m => (!query || String(m.id || m.model || "").toLowerCase().includes(query)) && (!vendor || String(m.vendor || m.type || "").toLowerCase() === vendor));
      const page = Math.max(1, Number(args.params?.p) || 1), size = Math.min(30, Math.max(1, Number(args.params?.size) || 15));
      result.data = { [args.action === "available" ? "models" : "items"]: items.slice((page - 1) * size, page * size), total: items.length, page, size, has_more: page * size < items.length, active_key: result.data?.active_key || null, note: args.action === "available" ? "这是当前密钥可用模型，不是历史调用模型；更多结果请递增 p 查询。" : "价格为 OD/百万 Token。" };
    }
    return { ok: true, outcome: action.write ? "accepted" : "read", output: encodeResult(result), meta: { action: args.action, write: action.write } };
  } catch (e) {
    if (ctx.signal?.aborted) throw Object.assign(new Error(action.write ? "已停止等待；操作可能已送达，请查询实际状态。" : "已停止"), { code: "ABORTED" });
    if (e.businessRejected && !writeAccepted && (!action.write || e.status < 500)) return { ok: false, outcome: "rejected", output: encodeResult({ error: e.message, status: e.status }) };
    return { ok: false, outcome: action.write ? "unknown" : "failed", output: action.write ? "尚未确认操作结果，请先查询实际状态，避免重复发送或重复修改。" : "平台查询暂未成功，请稍后重试或缩小查询范围。" };
  }
}
export function platformToolSpecs(role = 1000, enabledTools = null) {
  return [{ id: "platform", name: "平台工具目录", desc: "发现平台工具和完整方法；catalog 查询目录，describe 配合 group 查询某组参数。查询现有模型请用 models；发帖评论请用 community。", args: '{"action":"catalog|describe","group":"可选工具组"}' },
    ...visiblePlatformCatalog(role, enabledTools).map(g => ({ id: g.id, name: g.name, desc: `${g.name}。方法：${g.actions.map(a => `${a.action}(${a.title})`).join("、")}。先 describe 查看参数，所有写入需用户逐次确认，失败不得宣称成功。`, args: '{"action":"方法名或describe","params":{"id":"路径编号及查询字段"},"data":{"字段":"写入内容；查询时省略"}}' }))];
}
export function platformNativeSchema(id, role = 1000) {
  return { type: "object", properties: { action: { type: "string", enum: id === "platform" ? ["catalog", "describe"] : ["describe", ...Object.values(PLATFORM_CATALOG[id].actions).filter(a => a.role <= role).map(a => a.action)] },
    ...(id === "platform" ? { group: { type: "string", description: "指定工具组查看完整方法参数" } } : { params: { type: "object", additionalProperties: true, description: "路径编号与查询参数，先 describe 查看允许字段" }, data: { type: "object", additionalProperties: true, description: "写入字段，先 describe 查看允许字段；完整内容会呈现给用户确认" } }) }, required: ["action"], additionalProperties: false };
}
