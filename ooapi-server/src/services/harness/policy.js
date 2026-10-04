import { getOption, setOption } from "../../config.js";
import { TOOL_IDS, MAX_STEPS_LIMIT } from "./sessions.js";
import { PLATFORM_TOOL_IDS } from "./platform-catalog.js";

// 编排只组合已有服务端能力，不执行浏览器提交的代码或任意工具名。
export const DEFAULT_AGENT_FLOW = {
  version: 1,
  instructions: "",
  nodes: [
    { id: "input", kind: "input", label: "接住你的问题", x: 300, y: 35, config: {} },
    { id: "memory", kind: "context", label: "整理记忆", x: 300, y: 175, config: { threshold: 0.7, keepRecent: 6 } },
    { id: "model", kind: "model", label: "思考与规划", x: 300, y: 315, config: {} },
    { id: "tools", kind: "tools", label: "执行工具", x: 610, y: 455, config: { tools: TOOL_IDS, maxSteps: 96 } },
    { id: "answer", kind: "answer", label: "整理好，交给你", x: 300, y: 595, config: {} },
  ],
  edges: [{ from: "input", to: "memory" }, { from: "memory", to: "model" }, { from: "model", to: "tools" }, { from: "tools", to: "model" }, { from: "model", to: "answer" }],
};
export function validateAgentFlow(raw) {
  if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length !== 5 || !Array.isArray(raw.edges)) throw new Error("流程需要输入、上下文、模型、工具和回答五个节点");
  const nodes = DEFAULT_AGENT_FLOW.nodes.map(template => {
    const n = raw.nodes.find(n => n.id === template.id && n.kind === template.kind);
    if (!n) throw new Error("缺少必需节点");
    if (![n.x, n.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1600)) throw new Error("节点位置无效");
    let config = {};
    if (n.kind === "context") {
      if (!Number.isFinite(n.config?.threshold) || n.config.threshold < .3 || n.config.threshold > .85 || !Number.isInteger(n.config.keepRecent) || n.config.keepRecent < 2 || n.config.keepRecent > 16) throw new Error("压缩阈值为 30%–85%，保留消息为 2–16 条");
      config = { threshold: n.config.threshold, keepRecent: n.config.keepRecent };
    }
    if (n.kind === "tools") {
      if (!Array.isArray(n.config?.tools) || n.config.tools.some(t => !TOOL_IDS.includes(t)) || !Number.isInteger(n.config.maxSteps) || n.config.maxSteps < 1 || n.config.maxSteps > MAX_STEPS_LIMIT) throw new Error("工具或探索步数无效");
      config = { tools: [...new Set(n.config.tools)], maxSteps: n.config.maxSteps };
    }
    return { ...template, label: String(n.label || template.label).slice(0, 40), x: n.x, y: n.y, config };
  });
  const edges = raw.edges.map(e => ({ from: e.from, to: e.to }));
  const required = DEFAULT_AGENT_FLOW.edges.filter(e => ![e.from, e.to].includes("tools"));
  if (edges.length > 5 || edges.some(e => !DEFAULT_AGENT_FLOW.edges.some(d => d.from === e.from && d.to === e.to)) || required.some(e => !edges.some(d => d.from === e.from && d.to === e.to)) || new Set(edges.map(e => `${e.from}:${e.to}`)).size !== edges.length) throw new Error("连线必须保留输入、记忆、模型与收尾路径");
  const toolEdges = edges.filter(e => [e.from, e.to].includes("tools"));
  if (toolEdges.length !== 0 && toolEdges.length !== 2) throw new Error("工具分支必须同时连接派发和结果回传");
  return { version: 1, instructions: String(raw.instructions || "").slice(0, 4000), nodes, edges };
}
export function agentFlow() {
  try {
    const raw = JSON.parse(getOption("agent_flow") || "null");
    // 旧默认全工具配置随本次能力扩展升级；人工收窄过的清单保持原来的限制。
    const oldTools = raw?.nodes?.find(n => n.kind === "tools")?.config?.tools;
    // 移除停用能力时只收窄旧策略，不能因校验失败回落成全工具默认。
    if (Array.isArray(oldTools)) for (let index = oldTools.length - 1; index >= 0; index--) if (oldTools[index] === "local") oldTools.splice(index, 1);
    if (raw?.version === 1 && Array.isArray(oldTools) && oldTools.length === 7 && ["account", "binance", "search", "fetch", "github", "task", "todowrite"].every(id => oldTools.includes(id))) oldTools.push(...PLATFORM_TOOL_IDS);
    const toolNode = raw?.nodes?.find(n => n.kind === "tools");
    if (raw?.version === 1 && toolNode?.config?.maxSteps === 12 && oldTools?.length === TOOL_IDS.length && DEFAULT_AGENT_FLOW.nodes.every(n => raw.nodes.some(r => r.id === n.id && r.label === n.label)) && !raw.instructions) toolNode.config.maxSteps = 96;
    return validateAgentFlow(raw);
  }
  catch { return structuredClone(DEFAULT_AGENT_FLOW); }
}
export function agentPolicy() {
  const flow = agentFlow(), tools = flow.nodes.find(n => n.kind === "tools").config;
  return { tools: flow.edges.some(e => e.to === "tools") ? tools.tools : [], maxSteps: tools.maxSteps, compaction: flow.nodes.find(n => n.kind === "context").config, policyInstructions: flow.instructions };
}
/** 会话执行保护遵守平台上限；工具只响应本次显式收窄，历史隐藏开关不重新启用。 */
export function resolveSessionPolicySettings(sessionSettings, policy, { requestedTools } = {}) {
  return {
    ...sessionSettings,
    ...policy,
    maxSteps: Math.min(sessionSettings.maxSteps, policy.maxSteps),
    tools: Array.isArray(requestedTools) ? policy.tools.filter(id => requestedTools.includes(id)) : [...policy.tools],
    search: null,
  };
}
export async function saveAgentFlow(raw) {
  const flow = validateAgentFlow(raw);
  await setOption("agent_flow", JSON.stringify(flow));
  return flow;
}
