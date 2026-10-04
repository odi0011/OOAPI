import fs from "node:fs";

export const CLIENT_AGENTS = Object.freeze(JSON.parse(fs.readFileSync(new URL("./client-agents.json", import.meta.url), "utf8")));
const ids = new Set(CLIENT_AGENTS.map(a => a.id));
const relays = new Set(CLIENT_AGENTS.filter(a => a.kind === "relay").map(a => a.id));
const aliases = { "newapi": "new-api", "new api": "new-api", "oneapi": "one-api", "one api": "one-api", "onehub": "one-hub", "one hub": "one-hub", "litellm-proxy": "litellm", "claude-cli": "claude-code", "claudecode": "claude-code", "codex-cli": "codex", "codex-tui": "codex", "codex_tui": "codex", "codex_cli_rs": "codex", "gemini_cli": "gemini-cli", "geminicli": "gemini-cli", "kilocode": "kilo", "kilo-code": "kilo" };
export function agentId(value) {
  const id = String(value || "").trim().toLowerCase();
  return ids.has(id) ? id : Object.hasOwn(aliases, id) ? aliases[id] : "";
}
const patterns = [
  ...[["sub2api", "sub2api"], ["new-api", "new[-_ ]?api"], ["one-api", "one[-_ ]?api"], ["litellm", "litellm(?:[-_ ]proxy)?"], ["one-hub", "one[-_ ]?hub"]].map(([id, name]) => [id, new RegExp(`(?:^|[\\s;(])${name}(?:[ /]v?([0-9][\\w.+-]*))?(?=$|[\\s;)])`, "i")]),
  ["zcode", /\bZCode\/([\w.+-]+)/i], ["opencode", /\bopencode\/([\w.+-]+)/i],
  ["claude-code", /\bclaude-(?:cli|code)\/([\w.+-]+)/i],
  ["codex", /\bcodex(?:_cli_rs|[-_](?:cli|tui|desktop|vscode))?\/([\w.+-]+)/i],
  ["codex", /\bCodex [A-Za-z][\w .+-]{0,48}\/([\w.+-]+)/i],
  ["qoder", /\bQoder(?:CLI)?\/([\w.+-]+)/i], ["openclaw", /\bOpenClaw\/([\w.+-]+)/i],
  ["gemini-cli", /\bGemini[-_]?CLI(?:-[\w-]+)?\/([\w.+-]+)/i],
  ["gemini-cli", /\bCloudCodeVSCode\/([\w.+-]+)(?=[\s\S]*[\s;(]proxy_client=geminicli(?=$|[\s;)]))/i],
  ["kilo", /\b(?:KiloCode|Kilo[- ]?Code|Kilo)\/([\w.+-]+)/i],
  ["roo-code", /\bRoo[-_]?Code\/([\w.+-]+)/i],
  ["copilot", /\bGitHubCopilotChat\/([\w.+-]+)/i],
  ...["cursor", "cline", "kiro", "trae", "workbuddy", "codebuddy", "windsurf"].map(id => [id, new RegExp(`\\b${id}\\/([\\w.+-]+)`, "i")]),
];
const versionOf = v => /^[\w.+-]{1,40}$/.test(String(v || "")) ? String(v) : "";
export function detectClientAgent(headers = {}, enabled = true) {
  if (!enabled) return { id: "", version: "", source: "disabled", confidence: "unknown", conflict: false };
  const ua = String(headers["user-agent"] || "").slice(0, 1024);
  // 同一产品可能同时出现 CLI 与 IDE 标记；去重后才判断不同产品是否冲突。
  const referer = String(headers["http-referer"] || "").trim().replace(/\/$/, "");
  const title = String(headers["x-title"] || "").trim();
  const projectAgent = title === "Roo Code" && referer === "https://github.com/RooVetGit/Roo-Cline" ? "roo-code"
    : headers["x-openrouter-title"] === "Continue" && referer === "https://www.continue.dev" ? "continue"
      : title === "Aider" && referer === "https://aider.chat" ? "aider"
        : title === "goose" && referer === "https://goose-docs.ai" ? "goose" : "";
  // Aider 的官方 OpenRouter 路径内嵌 LiteLLM SDK；库的 UA 不是额外的中转项目证据。
  const matches = [...new Map(patterns.map(([id, rx]) => ({ id, match: rx.exec(ua) })).filter(x => x.match && !(projectAgent === "aider" && x.id === "litellm")).map(m => [m.id, m])).values()];
  const relayMatches = matches.filter(m => relays.has(m.id));
  const observed = relayMatches.length === 1 ? relayMatches[0] : matches.length === 1 ? matches[0] : null;
  const declaredId = agentId(headers["x-ooapi-agent"]);
  // New API / One API 的官方 OpenRouter 接入会发送项目标题和来源；普通 API 接入未必发送。
  const project = headers["x-openrouter-title"] === "New API" && ["https://www.newapi.ai", "https://newapi.ai"].includes(referer) ? "new-api"
    : headers["x-title"] === "One API" && referer === "https://github.com/songquanpeng/one-api" ? "one-api" : "";
  const originator = String(headers.originator || "").trim().toLowerCase();
  const productHeader = ["codex_cli_rs", "codex-tui", "codex_tui", "codex_vscode", "codex"].includes(originator) ? "codex"
    : originator === "roo-code" ? "roo-code" : originator === "kilo" ? "kilo"
      : title === "Z Code@electron" && versionOf(headers["x-zcode-app-version"]) ? "zcode" : "";
  const declared = (declaredId === "ooapi" ? "" : declaredId) || project || (relays.has(observed?.id) ? "" : projectAgent || productHeader);
  // 声明是兼容提示，不是身份认证；冲突时停止套用 Agent 策略，避免含糊的路由依据。
  const conflict = (matches.length > 1 && relayMatches.length !== 1) || Boolean(declared && observed && declared !== observed.id && !(relays.has(declared) && !relays.has(observed.id)));
  const result = { id: declared || observed?.id || "", version: versionOf(declared ? headers["x-ooapi-agent-version"] || (declared === observed?.id ? observed.match[1] : declared === "zcode" ? headers["x-zcode-app-version"] : "") : observed?.match[1]),
    source: declared ? project && !declaredId ? "relay-header" : "header" : observed ? "user-agent" : "unknown", confidence: declared ? "declared" : observed ? "heuristic" : "unknown", conflict };
  // 中转项目和终端标记分开保存；转发或模拟的 UA 不能证明原始客户端身份。
  const claimed = agentId(headers["x-ooapi-client-agent"]);
  const terminalMatches = matches.filter(m => !relays.has(m.id));
  const leaf = claimed && !relays.has(claimed) && claimed !== "ooapi"
    ? { id: claimed, version: versionOf(headers["x-ooapi-client-agent-version"]), source: "header", confidence: "declared" }
    : terminalMatches.length === 1
      ? { id: terminalMatches[0].id, version: versionOf(terminalMatches[0].match[1]), source: "user-agent", confidence: "heuristic" }
      : projectAgent || productHeader ? { id: projectAgent || productHeader, version: "", source: "header", confidence: "declared" } : null;
  if (relays.has(result.id) && leaf) result.reported_client = leaf;
  return result;
}
export function resolveClientAgent(headers, bindings = [], tokenId = 0, enabled = true) {
  const observed = detectClientAgent(headers, enabled);
  if (!enabled) return observed;
  // 绑定依据只来自服务端已鉴权的密钥编号，绝不信任请求头/请求体提供的编号。
  const binding = bindings.find(b => b.tokenId === tokenId);
  if (!binding) return observed;
  const result = { id: binding.agent, version: "", source: "api-key", confidence: "configured", conflict: false };
  const signals = relays.has(result.id) ? detectClientAgent({ ...headers, "x-ooapi-agent": result.id }) : observed;
  const claimed = signals.reported_client || (observed.id && observed.id !== result.id ? { id: observed.id, version: observed.version, source: observed.source, confidence: observed.confidence } : null);
  if (claimed) result.reported_client = claimed;
  return result;
}
export function publicClientAgent(value, ua = "") {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { value = null; } }
  const source = ["header", "relay-header", "user-agent", "api-key", "unknown", "disabled", "internal"].includes(value?.source) ? value.source : "unknown";
  // 旧版保存的空 id 不能阻止新识别规则补展示；显式关闭识别的历史请求保持关闭。
  if (!value || (!agentId(value.id) && source !== "disabled")) return detectClientAgent({ "user-agent": ua });
  const confidence = source === "api-key" ? "configured" : source === "internal" ? "internal" : source === "user-agent" ? "heuristic" : ["header", "relay-header"].includes(source) ? "declared" : "unknown";
  const result = { id: source === "disabled" ? "" : agentId(value.id), version: versionOf(value.version), source, confidence, conflict: value.conflict === true };
  const reported = value.reported_client;
  if (reported && agentId(reported.id) && reported.id !== "ooapi" && ["user-agent", "header", "relay-header"].includes(reported.source)) {
    result.reported_client = { id: agentId(reported.id), version: versionOf(reported.version), source: reported.source, confidence: reported.source === "user-agent" ? "heuristic" : "declared" };
  }
  return result;
}
export function safeReasoning(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,23}$/.test(text) ? text : text ? "invalid" : "";
}
