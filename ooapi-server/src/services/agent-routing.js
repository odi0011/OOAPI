import { agentId, safeReasoning } from "./client-agents.js";

const modes = new Set(["preserve", "model-default", "unsupported-default", "none", "low", "medium", "high", "xhigh", "max"]);
const numeric = (value, min, max, label) => {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min}–${max} 的整数`);
  return value;
};
export function parseAgentRouting(raw) {
  const v = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!v || v.version !== 1 || !Array.isArray(v.rules) || v.rules.length > 40) throw new Error("Agent 规则格式无效，最多 40 条");
  if (JSON.stringify(v).length > 40000) throw new Error("Agent 规则过大");
  const seen = new Set();
  const rules = v.rules.map(r => {
    if (!r || !/^[a-zA-Z0-9_-]{1,40}$/.test(r.id) || seen.has(r.id)) throw new Error("规则编号无效或重复");
    seen.add(r.id);
    if (!agentId(r.agent) || typeof r.enabled !== "boolean") throw new Error("请选择有效 Agent 并设置启用状态");
    if (!Array.isArray(r.models) || r.models.length > 30 || r.models.some(m => typeof m !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_./:+-]{0,127}$/.test(m))) throw new Error("模型范围无效（留空表示全部模型）");
    if (!Array.isArray(r.preferredChannels) || r.preferredChannels.length > 20 || r.preferredChannels.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("优先渠道编号无效");
    if (!modes.has(r.reasoning)) throw new Error("推理兼容方式无效");
    return { id: r.id, enabled: r.enabled, agent: agentId(r.agent), models: [...new Set(r.models)], preferredChannels: [...new Set(r.preferredChannels)], reasoning: r.reasoning,
      timeoutMs: numeric(r.timeoutMs, 1000, 86400000, "超时"), retries: numeric(r.retries, 0, 10, "重试次数") };
  });
  return { version: 1, rules };
}
export function matchAgentRule(config, agent, model, canonical = x => x) {
  if (!agent?.id || agent.conflict) return null;
  return config.rules.find(r => r.enabled && r.agent === agent.id && (!r.models.length || r.models.some(m => canonical(m) === canonical(model)))) || null;
}
export function agentReasoning(rule, requested, capabilities) {
  const level = safeReasoning(requested);
  if (!rule || rule.reasoning === "preserve") return level;
  if (rule.reasoning === "model-default") return "";
  if (rule.reasoning === "unsupported-default") return capabilities.reasoning.levels.includes(level) ? level : "";
  return rule.reasoning;
}
export function orderAgentChannels(channels, rule) {
  if (!rule?.preferredChannels.length) return channels;
  // 仅重排调度器已鉴权/匹配/过滤冷却后的候选，不能凭客户端标记新增候选。
  const rank = id => { const i = rule.preferredChannels.indexOf(id); return i < 0 ? Infinity : i; };
  return [...channels].sort((a, b) => rank(a.id) - rank(b.id));
}
