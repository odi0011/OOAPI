import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

const attempts = new AsyncLocalStorage();
// 只保存协议路由：域名、查询串、凭据以及动态资源标识均不属于账单端点。
const publicSegments = new Set("api api-open v0 v1 v2 v3 v4 v1beta v1internal zen go openai anthropic claude backend-api codex f chat chats completions completion responses message messages systemone generateAssistantResponse streamGenerateContent generateContent models text bot ide llm streaming stream conversation conversations generate answer answers aiserver.v1.AiService StreamChat apiv2 kimi.gateway.chat.v1.ChatService Chat dialog samantha archon session agent capy.agent.v1.AgentService ChatStream".split(" "));
export function endpointPath(value) {
  if (typeof value !== "string" || !value || value.length > 4096) return "";
  let path;
  try { path = new URL(value, "https://endpoint.invalid").pathname; } catch { return ""; }
  if (path === "/api/chat/run") return path;
  if (!/(?:\/(?:chat|completions?|responses|messages?|systemone|generateAssistantResponse|streamGenerateContent|generateContent|StreamChat|ChatStream|conversation)|:(?:streamGenerateContent|generateContent))\/?$/i.test(path)) return "";
  return ("/" + path.split("/").filter(Boolean).map(part => {
    if (publicSegments.has(part)) return part;
    if (/^v\d+(?:beta\d*)?:(?:streamGenerateContent|generateContent)$/.test(part)) return part;
    if (/:(?:streamGenerateContent|generateContent)$/.test(part)) return ":model:" + part.split(":").at(-1);
    return ":id";
  }).join("/")).slice(0, 240);
}

export function recordUpstreamEndpoint(value) {
  const state = attempts.getStore();
  if (!state || state.closed) return;
  const endpoint = endpointPath(value);
  if (endpoint && !state.endpoints.includes(endpoint) && state.endpoints.length < 12) state.endpoints.push(endpoint);
}

// Node 内置 fetch 的实际发出事件；调用级上下文隔离并发，刷新凭据/模型目录不匹配。
channel("undici:request:create").subscribe(({ request }) => {
  if (request?.method === "POST") recordUpstreamEndpoint(request.path);
});
export const withEndpointAudit = (state, fn) => attempts.run(state, fn);
export function recordEndpointAttempt(url, protocol, status, code = "", upstreamCode = "") {
  const state = attempts.getStore();
  if (!state || state.closed) return;
  const entries = state.attempts ||= [];
  if (entries.length >= 36) return;
  entries.push({ endpoint: endpointPath(url), protocol, status: Number(status) || 0,
    code: /^CHANNEL_[A-Z_]{1,48}$/.test(code) ? code : "",
    upstream_code: /^[a-zA-Z0-9_-]{1,40}$/.test(String(upstreamCode)) ? String(upstreamCode) : "" });
}
export function endpointList(values) {
  return [...new Set((Array.isArray(values) ? values : []).flatMap(value => Array.isArray(value) ? value : [value]).map(endpointPath).filter(Boolean))].slice(0, 12);
}
