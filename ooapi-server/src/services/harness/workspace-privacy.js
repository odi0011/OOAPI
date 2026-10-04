import { splitTokens } from "../pricing.js";

export const LOCAL_CONTENT_NOTICE = "这段本地工作区内容保存在已连接的电脑上，重新连接后可恢复。";
export function persistedWorkspaceParts(parts = [], sensitive = false) {
  if (!sensitive) return parts;
  return parts.map(p => {
    const base = { id: p.id, type: p.type, status: p.status, created: p.created, started: p.started, ended: p.ended, step: p.step };
    if (p.type === "tool" || p.type === "approval") return { ...base, tool: p.tool, name: p.name, callId: p.callId || p.id,
      args: { local: true }, output: LOCAL_CONTENT_NOTICE, sensitive: true };
    if (p.type === "error") return { ...base, code: p.code, message: "本地工作区任务未完成，请连接本机查看记录或继续任务。", billing_known: p.billing_known };
    if (p.type === "trajectory") return { ...base, partial: p.partial, reason: p.reason, budget: p.budget };
    return { ...base, text: LOCAL_CONTENT_NOTICE, sensitive: true };
  });
}
export function persistedBillCall(c) {
  // 原文只用于当次推理；估算 token 在丢弃原文前固化，计费仍由 pricing.js 负责。
  const tokens = c.tokens || splitTokens({ prompt: c.prompt || "", output: c.output || "", upstreamTotal: c.usage });
  const fields = ["model", "requestedModel", "billModel", "upstreamModel", "channel", "channelId", "channelQuote", "startedAt", "firstTokenAt", "elapsed", "retryCount", "reasoningEffort", "reasoningApplied", "requestId", "usage"];
  return { ...Object.fromEntries(fields.filter(k => c[k] !== undefined).map(k => [k, c[k]])), tokens, prompt: "", output: "" };
}
