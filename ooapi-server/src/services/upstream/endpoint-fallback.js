import { createHash } from "node:crypto";
import { normalizeUsage } from "../pricing.js";
import { recordEndpointAttempt } from "../endpoint-audit.js";

const suffixes = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages" };
const winners = new Map();
const TTL = 10 * 60 * 1000;

/** 只在同一来源和配置路径内协商，保留 /api 等前缀以及明确指定的 v2/v3。 */
export function endpointCandidates(baseUrl, preferred = "chat") {
  if (!String(baseUrl || "").trim()) return [];
  const url = new URL(String(baseUrl).trim());
  let base = url.pathname.replace(/\/+$/, "");
  const explicit = Object.entries(suffixes).find(([, suffix]) => base.endsWith(suffix));
  if (explicit) { preferred = explicit[0]; base = base.slice(0, -explicit[1].length); }
  else base = base.replace(/\/models$/, "");
  const versioned = /\/v\d+[a-z]*$/i.test(base);
  const bases = versioned ? [base, ...(/\/v1$/i.test(base) ? [base.slice(0, -3)] : [])] : explicit ? [base, `${base}/v1`] : [`${base}/v1`, base];
  return [preferred, ...Object.keys(suffixes).filter(p => p !== preferred)].flatMap(protocol => bases.map(prefix => {
    const target = new URL(url); target.pathname = prefix + suffixes[protocol]; target.hash = "";
    return { protocol, url: target.href };
  }));
}

export function canTryEndpoint(error, emitted = false, consumed = false, signal) {
  if (emitted || consumed || signal?.aborted || error?.billable || error?.content || error?.reasoning || error?.toolCalls?.length || normalizeUsage(error?.usage).totalTokens > 0) return false;
  // 凭据、权限、风控、限流不能靠改协议绕过；断流/超时也无法确认上游是否已生成。
  if (["CHANNEL_AUTH_EXPIRED", "CHANNEL_FORBIDDEN", "CHANNEL_NOT_APPROVED", "CHANNEL_RATE_LIMIT", "CHANNEL_RATE_LIMITED", "CHANNEL_ABORTED", "CHANNEL_NETWORK"].includes(error?.code)) return false;
  return error?.upstreamRejected === true && [400, 404, 405, 415, 422, 501].includes(Number(error.status));
}

export async function runEndpointFallback(args, preferred, primary) {
  const candidates = endpointCandidates(args.channel?.base_url, preferred);
  if (!candidates.length) return primary(args);
  const cacheKey = createHash("sha256").update(JSON.stringify([args.channel.id, args.channel.base_url, args.channel.api_key, args.model, preferred])).digest("hex");
  const cached = winners.get(cacheKey);
  if (cached && cached.until > Date.now()) candidates.sort((a, b) => Number(b.url === cached.url) - Number(a.url === cached.url));
  else winners.delete(cacheKey);
  let emitted = false, consumed = false, firstError;
  const options = { ...args,
    onDelta: text => { if (text) emitted = true; args.onDelta?.(text); },
    onReasoning: text => { if (text) emitted = true; args.onReasoning?.(text); },
    onToolCall: call => { emitted = true; args.onToolCall?.(call); },
    onUsage: usage => { if (normalizeUsage(usage).totalTokens > 0) consumed = true; args.onUsage?.(usage); },
  };
  for (const [index, candidate] of candidates.entries()) {
    if (args.signal?.aborted) throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED", billable: false });
    try {
      const run = candidate.protocol === preferred ? primary : candidate.protocol === "chat"
        ? (await import("./openai-compat.js")).chatOnce : candidate.protocol === "responses"
          ? (await import("./responses-compat.js")).chatOnce : (await import("./anthropic-compat.js")).chatOnce;
      const result = await run({ ...options, endpoint: candidate.url });
      recordEndpointAttempt(candidate.url, candidate.protocol, result.httpStatus || 200);
      if (winners.size >= 512) winners.delete(winners.keys().next().value);
      winners.set(cacheKey, { url: candidate.url, until: Date.now() + TTL });
      return { ...result, retryCount: (Number(result.retryCount) || 0) + index };
    } catch (error) {
      recordEndpointAttempt(candidate.url, candidate.protocol, error.status || 0, error.code, error.upstreamErrorCode);
      winners.delete(cacheKey);
      if (!firstError || Number(firstError.status) === 404) firstError = error;
      if (!canTryEndpoint(error, emitted, consumed, args.signal)) {
        error.retryCount = index + (Number(error.retryCount) || 0);
        throw error;
      }
      // 全部路径失败时保留有意义的原始拒绝，不能用最后一条 404 覆盖最初的参数错误。
      firstError.retryCount = index + (Number(error.retryCount) || 0);
    }
  }
  throw firstError;
}
