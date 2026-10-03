import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../db.js";
import { PLATFORM_CATALOG, platformAction, visiblePlatformCatalog } from "./platform-catalog.js";
import { callFingerprint } from "./tool-call-guards.js";
import { SECRET_OPTIONS } from "../../config.js";

const grants = new WeakMap();
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
  if (args.action === "describe" || tool === "platform") {
    if (tool === "platform" && !["catalog", "describe"].includes(args.action)) return { ok: false, output: "platform 支持 catalog 和 describe。" };
    const groups = visiblePlatformCatalog(role).filter(g => tool === "platform" ? !args.group || g.id === args.group : g.id === tool);
    if (!groups.length) return { ok: false, output: "工具不存在或当前账号无权限。" };
    // 总目录先返回可发现的方法名；指定组再取完整参数，避免一轮耗尽上下文。
    const value = tool === "platform" && !args.group ? groups.map(g => ({ id: g.id, name: g.name, methods: g.actions.map(a => ({ action: a.action, title: a.title, write: a.write })) })) : groups;
    return { ok: true, output: JSON.stringify(value) };
  }
  let request;
  try { request = platformRequest(tool, args, ctx.user, ctx.sessionId); }
  catch (e) { return { ok: false, output: e.message }; }
  const { action, path, data } = request;
  if (action.write) {
    const grant = grants.get(ctx.toolGrant);
    grants.delete(ctx.toolGrant);
    if (!grant || grant.userId !== Number(ctx.user.id) || grant.expires < Date.now() || grant.fingerprint !== callFingerprint({ tool, args })) return { ok: false, output: "此操作需要用户确认完整内容，尚未获得本次操作的授权。" };
  }
  if (ctx.signal?.aborted) throw Object.assign(new Error("已停止"), { code: "ABORTED" });
  const controller = new AbortController(), abort = () => controller.abort();
  ctx.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 25000);
  try {
    // 只连本进程固定回环端口；沿用原业务路由的权限、归属、限流、校验和审计。
    const port = Number(process.env.PORT || 3001);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("平台端口未配置");
    const payload = action.write ? { ...data } : undefined;
    if (tool === "messages" && args.action === "send") payload.client_id ||= crypto.randomUUID();
    if (tool === "trading" && args.action === "create_demo") payload.environment = "demo";
    if (tool === "trading" && ["order", "close"].includes(args.action)) payload.client_order_id ||= crypto.randomUUID();
    const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, { method: action.verb, redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${jwt.sign({ id: ctx.user.id, tv: Number(ctx.user.token_version) || 0 }, JWT_SECRET, { expiresIn: 120 })}`, "Content-Type": "application/json", "X-OOAPI-Tool": `${tool}.${args.action}` },
      ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const reader = res.body?.getReader();
    let raw = "", bytes = 0;
    if (!reader) throw new Error("平台没有返回内容");
    const decoder = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("结果过大"); } raw += decoder.decode(value, { stream: true }); }
    raw += decoder.decode();
    let result; try { result = JSON.parse(raw); } catch { throw new Error("平台响应格式不正确"); }
    if (!res.ok || result.success === false) return { ok: false, output: encodeResult({ error: result.message || "平台拒绝了本次操作", status: res.status }) };
    if (tool === "models" && ["available", "prices"].includes(args.action)) {
      const query = String(args.params?.q || "").toLowerCase(), vendor = String(args.params?.vendor || "").toLowerCase();
      const items = (result.data?.models || result.data?.items || []).filter(m => (!query || String(m.id || m.model || "").toLowerCase().includes(query)) && (!vendor || String(m.vendor || m.type || "").toLowerCase() === vendor));
      const page = Math.max(1, Number(args.params?.p) || 1), size = Math.min(30, Math.max(1, Number(args.params?.size) || 15));
      result.data = { [args.action === "available" ? "models" : "items"]: items.slice((page - 1) * size, page * size), total: items.length, page, size, has_more: page * size < items.length, active_key: result.data?.active_key || null, note: args.action === "available" ? "这是当前密钥可用模型，不是历史调用模型；更多结果请递增 p 查询。" : "价格为 OD/百万 Token。" };
    }
    return { ok: true, output: encodeResult(result), meta: { action: args.action, write: action.write } };
  } catch (e) {
    if (ctx.signal?.aborted) throw Object.assign(new Error(action.write ? "已停止等待；操作可能已送达，请查询实际状态。" : "已停止"), { code: "ABORTED" });
    return { ok: false, output: action.write ? "尚未确认操作结果，请先查询实际状态，避免重复发送或重复修改。" : "平台查询暂未成功，请稍后重试或缩小查询范围。" };
  } finally { clearTimeout(timer); ctx.signal?.removeEventListener("abort", abort); }
}
export function platformToolSpecs(role = 1000) {
  return [{ id: "platform", name: "平台工具目录", desc: "发现平台工具和完整方法；catalog 查询目录，describe 配合 group 查询某组参数。查询现有模型请用 models；发帖评论请用 community。", args: '{"action":"catalog|describe","group":"可选工具组"}' },
    ...visiblePlatformCatalog(role).map(g => ({ id: g.id, name: g.name, desc: `${g.name}。方法：${g.actions.map(a => `${a.action}(${a.title})`).join("、")}。先 describe 查看参数，所有写入需用户逐次确认，失败不得宣称成功。`, args: '{"action":"方法名或describe","params":{"id":"路径编号及查询字段"},"data":{"字段":"写入内容；查询时省略"}}' }))];
}
export function platformNativeSchema(id, role = 1000) {
  return { type: "object", properties: { action: { type: "string", enum: id === "platform" ? ["catalog", "describe"] : ["describe", ...Object.values(PLATFORM_CATALOG[id].actions).filter(a => a.role <= role).map(a => a.action)] },
    ...(id === "platform" ? { group: { type: "string", description: "指定工具组查看完整方法参数" } } : { params: { type: "object", additionalProperties: true, description: "路径编号与查询参数，先 describe 查看允许字段" }, data: { type: "object", additionalProperties: true, description: "写入字段，先 describe 查看允许字段；完整内容会呈现给用户确认" } }) }, required: ["action"], additionalProperties: false };
}
