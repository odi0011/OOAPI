import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getBoolOption, getOption } from "../config.js";
import { canonicalModelName } from "./models.js";
import { detectClientAgent, safeReasoning } from "./client-agents.js";
import { parseAgentRouting, matchAgentRule } from "./agent-routing.js";

const context = new AsyncLocalStorage();
export const clientAgentContext = () => context.getStore();
export function withClientAgent(req, run) {
  const client = detectClientAgent(req.headers, getBoolOption("gateway_agent_detection"));
  let config;
  try { config = parseAgentRouting(getOption("gateway_agent_rules")); } catch { config = { version: 1, rules: [] }; }
  const rule = matchAgentRule(config, client, req.body?.model, canonicalModelName);
  const requested = safeReasoning(req.body?.reasoning_effort ?? req.body?.reasoning?.effort);
  return context.run({ client, rule, requested, applied: "", ruleVersion: rule ? createHash("sha256").update(JSON.stringify(rule)).digest("hex").slice(0, 12) : "" }, run);
}
export function clientAgentAudit() {
  const c = context.getStore();
  if (!c) return {};
  return { client_agent: c.client, reasoning_requested: c.requested, reasoning_selected: c.applied,
    agent_routing: c.rule ? { id: c.rule.id, version: c.ruleVersion, reasoning: c.rule.reasoning } : null };
}
