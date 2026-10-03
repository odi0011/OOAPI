import fs from "node:fs";

export const CLIENT_AGENTS = Object.freeze(JSON.parse(fs.readFileSync(new URL("./client-agents.json", import.meta.url), "utf8")));
const ids = new Set(CLIENT_AGENTS.map(a => a.id));
const aliases = { "claude-cli": "claude-code", "claudecode": "claude-code", "codex-cli": "codex", "codex_cli_rs": "codex", "gemini_cli": "gemini-cli", "kilocode": "kilo", "kilo-code": "kilo" };
export function agentId(value) {
  const id = String(value || "").trim().toLowerCase();
  return ids.has(id) ? id : Object.hasOwn(aliases, id) ? aliases[id] : "";
}
const patterns = [
  ["zcode", /\bZCode\/([\w.+-]+)/i], ["opencode", /\bopencode\/([\w.+-]+)/i],
  ["claude-code", /\bclaude-(?:cli|code)\/([\w.+-]+)/i],
  ["codex", /\bcodex(?:_cli_rs|[-_](?:cli|desktop))?\/([\w.+-]+)/i],
  ["qoder", /\bQoder(?:CLI)?\/([\w.+-]+)/i], ["openclaw", /\bOpenClaw\/([\w.+-]+)/i],
  ["gemini-cli", /\bGemini[-_]CLI\/([\w.+-]+)/i], ["kilo", /\b(?:KiloCode|Kilo[- ]?Code|Kilo)\/([\w.+-]+)/i],
  ...["cursor", "cline", "kiro", "trae", "workbuddy", "codebuddy", "windsurf"].map(id => [id, new RegExp(`\\b${id}\\/([\\w.+-]+)`, "i")]),
];
const versionOf = v => /^[\w.+-]{1,40}$/.test(String(v || "")) ? String(v) : "";
export function detectClientAgent(headers = {}, enabled = true) {
  if (!enabled) return { id: "", version: "", source: "disabled", conflict: false };
  const ua = String(headers["user-agent"] || "").slice(0, 1024);
  const matches = patterns.map(([id, rx]) => ({ id, match: rx.exec(ua) })).filter(x => x.match);
  const observed = matches.length === 1 ? matches[0] : null;
  const declared = agentId(headers["x-ooapi-agent"]);
  // 声明是兼容提示，不是身份认证；冲突时停止套用 Agent 策略，避免含糊的路由依据。
  const conflict = matches.length > 1 || Boolean(declared && observed && declared !== observed.id);
  return { id: declared || observed?.id || "", version: versionOf(declared ? headers["x-ooapi-agent-version"] || (declared === observed?.id ? observed.match[1] : "") : observed?.match[1]),
    source: declared ? "header" : observed ? "user-agent" : "unknown", conflict };
}
export function publicClientAgent(value, ua = "") {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { value = null; } }
  const source = ["header", "user-agent", "unknown", "disabled"].includes(value?.source) ? value.source : "unknown";
  if (!value) return detectClientAgent({ "user-agent": ua });
  return { id: agentId(value.id), version: versionOf(value.version), source, conflict: value.conflict === true };
}
export function safeReasoning(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,23}$/.test(text) ? text : text ? "invalid" : "";
}
