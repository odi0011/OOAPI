// 只保留上游明确返回的诊断字段；请求、响应头、账号资料和堆栈不能进入对话。
// WeakMap 保存投影来源，防止任意本地 Error.message 被误称为“实际接口返回”。
const captured = new WeakMap();
const REDACTED = "[已隐藏]";
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 6000;
const sensitiveKey = /(?:api.?key|access.?key|token|secret|pass(?:word|wd)?|cookie|authorization|credential|session|csrf|signature|private.?key|^auth$|^key$)/i;

function httpStatus(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

function parseBody(body) {
  if (typeof body !== "string") return body && typeof body === "object" ? body : null;
  if (!body.trim()) return null;
  if (body.length > MAX_BODY) return { message: "上游错误响应过长，已省略正文。" };
  if (/^\s*(?:<!doctype\b|<html\b|<head\b|<body\b)/i.test(body)) return { message: "上游返回了 HTML 错误页面，页面内容已省略。" };
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : { message: typeof parsed === "string" ? parsed : "上游返回了非结构化错误。" };
  } catch {
    // 对残缺 JSON 不作自由文本回显，否则会把截断的请求/凭据一并当作错误原因。
    return { message: /^\s*[\[{]/.test(body) ? "上游返回了无法解析的错误响应。" : body };
  }
}

function secretValues(channel, body) {
  const secrets = new Set();
  let count = 0, unsafe = false;
  const visited = new WeakSet();
  function add(value) {
    if (typeof value !== "string" || !value.trim()) return;
    if (value.length > MAX_BODY) { unsafe = true; return; }
    const pieces = [value, ...value.split(/[\r\n]/)];
    if (/^(?:Bearer|Basic)\s+/i.test(value)) pieces.push(value.replace(/^\S+\s+/, ""));
    for (const cookie of value.matchAll(/(?:^|;\s*)[^=;\s]+\s*=\s*([^;]+)/g)) pieces.push(cookie[1]);
    for (const piece of pieces) {
      const clean = piece.trim();
      if (!clean) continue;
      secrets.add(clean);
      secrets.add(encodeURIComponent(clean));
      secrets.add(JSON.stringify(clean).slice(1, -1));
    }
  }
  function urlSecrets(value) {
    if (typeof value !== "string" || value.length > MAX_BODY) return;
    for (const match of value.matchAll(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi)) {
      try {
        const url = new URL(match[0]);
        for (const part of [url.username, url.password]) {
          add(part);
          try { add(decodeURIComponent(part)); } catch { /* 畸形百分号无需继续解码。 */ }
        }
        for (const [key, part] of url.searchParams) if (sensitiveKey.test(key)) add(part);
      } catch { /* 不执行上游给出的地址；无效 URL 仍由文本投影整体隐藏。 */ }
    }
  }
  function visit(value, depth = 0, secret = false) {
    if (++count > 512 || depth > 8) { unsafe = true; return; }
    if (typeof value === "string") {
      if (secret) add(value);
      urlSecrets(value);
      return;
    }
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const entries = Object.entries(value);
    if (entries.length > 128) { unsafe = true; return; }
    for (const [key, child] of entries) visit(child, depth + 1, secret || sensitiveKey.test(key) || key.toLowerCase() === "headers");
  }
  add(channel?.api_key);
  urlSecrets(channel?.base_url);
  urlSecrets(channel?.proxy_url);
  let other = channel?.other;
  if (typeof other === "string") {
    if (other.length > MAX_BODY) unsafe = true;
    else { try { other = JSON.parse(other); } catch { add(other); } }
  }
  visit(other);
  visit(body);
  return { secrets: [...secrets].sort((a, b) => b.length - a.length), unsafe };
}

function projector(secrets) {
  let remaining = MAX_TEXT;
  return (value, maxLength = 2000) => {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (!value.trim() || !remaining) return undefined;
    if (value.length > MAX_BODY) return "上游诊断字段过长，已省略。";
    let text = value;
    // 先替换完整秘密再截断，避免截断后留下无法匹配的密钥前缀。
    for (const secret of secrets) text = text.split(secret).join(REDACTED);
    text = text
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi, "[上游地址已隐藏]")
      .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[=:]\s*[^\r\n]*/gi, (match) => `${match.split(/[=:]/)[0]}: ${REDACTED}`)
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi, REDACTED)
      .replace(/\b(api[ _-]?key|access[ _-]?key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|password|passwd|secret|client[ _-]?secret|credential|session[ _-]?id|csrf|signature)["']?\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'<>]+)/gi, (_, label) => `${label}: ${REDACTED}`)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
      .replace(/\b(?:sk|rk|sess|ghp|gho|ghs|github_pat)[-_][A-Za-z0-9_-]{8,}\b/g, REDACTED)
      .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED)
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
      .replace(/<[^>\r\n]{0,1000}>/g, "[标记已省略]")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
    const cap = Math.min(maxLength, remaining);
    const result = text.length > cap ? `${text.slice(0, Math.max(0, cap - 1))}…` : text;
    remaining -= result.length;
    return result || undefined;
  };
}

function projectResponse(body, channel) {
  const parsed = parseBody(body);
  if (!parsed) return undefined;
  const { secrets, unsafe } = secretValues(channel, parsed);
  if (unsafe) return { error: { message: "上游错误响应结构过于复杂，已省略正文。" } };
  const clean = projector(secrets);
  const source = parsed.error && typeof parsed.error === "object" ? parsed.error : parsed;
  const error = {};
  for (const key of ["code", "status", "type", "message", "param"]) {
    const value = clean(source[key], key === "message" ? 2000 : 160);
    if (value !== undefined) error[key] = value;
  }
  if (!error.message && typeof source.msg === "string") error.message = clean(source.msg);
  if (!error.message && typeof parsed.error === "string") error.message = clean(parsed.error);
  const details = [];
  for (const detail of Array.isArray(source.details) ? source.details.slice(0, 8) : []) {
    if (!detail || typeof detail !== "object") continue;
    const fieldViolations = [];
    for (const violation of Array.isArray(detail.fieldViolations) ? detail.fieldViolations.slice(0, 16) : []) {
      if (!violation || typeof violation !== "object") continue;
      const field = clean(violation.field, 240), description = clean(violation.description, 400);
      if (field || description) fieldViolations.push({ ...(field ? { field } : {}), ...(description ? { description } : {}) });
    }
    if (fieldViolations.length) details.push({ fieldViolations });
  }
  if (details.length) error.details = details;
  return Object.keys(error).length ? { error } : undefined;
}

/** 适配器拿到真实 HTTP/SSE 错误响应后调用；不改变错误分类、usage 或计费状态。 */
export function attachUpstreamDiagnostics(error, { status, body, channel } = {}) {
  if (!error || typeof error !== "object") return error;
  const { secrets, unsafe } = secretValues(channel, parseBody(body));
  if (typeof error.message === "string") error.message = unsafe ? "上游请求失败，错误响应已省略。" : projector(secrets)(error.message) || "上游请求失败。";
  const safeStatus = httpStatus(status);
  const response = projectResponse(body, channel);
  if (safeStatus !== undefined) error.httpStatus = safeStatus;
  const responseCode = response?.error?.code;
  // Google RPC 常把 HTTP 400 放在 code、把有用的 INVALID_ARGUMENT 放在 status；
  // 诊断码优先保留语义码，避免把 HTTP 状态误当成厂商错误码。
  const code = responseCode !== undefined && !(Number.isInteger(Number(responseCode)) && Number(responseCode) >= 100 && Number(responseCode) <= 599)
    ? responseCode
    : response?.error?.status ?? response?.error?.type ?? responseCode;
  if (code !== undefined) error.upstreamErrorCode = String(code);
  if (response) error.upstreamResponse = response;
  captured.set(error, JSON.parse(JSON.stringify({
    ...(safeStatus !== undefined ? { http_status: safeStatus } : {}),
    ...(code !== undefined ? { upstream_error_code: String(code) } : {}),
    ...(response ? { upstream_response: response } : {}),
  })));
  return error;
}

/** 对话持久化与 SSE 共用同一份安全投影，不回读可被外部改写的公开属性。 */
export function publicErrorDiagnostics(error) {
  const value = error && typeof error === "object" ? captured.get(error) : null;
  if (!value) {
    const status = httpStatus(error?.httpStatus ?? error?.status);
    return status === undefined ? {} : { http_status: status };
  }
  return JSON.parse(JSON.stringify(value));
}
