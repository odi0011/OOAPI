// Incoming request products, NOT upstream vendors or model manufacturers.
// All IDs/labels/icons are allowlisted: never render a header as an image URL.
export interface CallerClient {
  id: string;
  name: string;
  kind: "client" | "relay" | "unknown";
  icon?: string;
}

const CLIENTS: readonly CallerClient[] = [
  { id: "sub2api", name: "sub2api", kind: "relay", icon: "sub2api.svg" },
  { id: "new-api", name: "New API", kind: "relay", icon: "new-api.png" },
  { id: "one-api", name: "One API", kind: "relay", icon: "one-api.png" },
  // No verified CPA product logo in the original: use a neutral relay icon.
  { id: "cpa", name: "CPA / CLIProxyAPI", kind: "relay" },
  { id: "litellm", name: "LiteLLM", kind: "relay", icon: "litellm.svg" },
  { id: "one-hub", name: "One Hub", kind: "relay", icon: "one-hub.svg" },
  { id: "codex", name: "Codex", kind: "client", icon: "codex.svg" },
  { id: "claude-code", name: "Claude Code", kind: "client", icon: "claude-code.png" },
  { id: "opencode", name: "OpenCode", kind: "client", icon: "opencode.png" },
  { id: "zcode", name: "ZCode", kind: "client", icon: "zcode.png" },
  { id: "qoder", name: "Qoder", kind: "client", icon: "qoder.svg" },
  { id: "openclaw", name: "OpenClaw", kind: "client", icon: "openclaw.svg" },
  { id: "gemini-cli", name: "Gemini CLI", kind: "client", icon: "gemini-cli.png" },
  { id: "kilo", name: "Kilo", kind: "client", icon: "kilo.svg" },
  { id: "roo-code", name: "Roo Code", kind: "client", icon: "roo-code.svg" },
  { id: "copilot", name: "GitHub Copilot", kind: "client", icon: "copilot.png" },
  { id: "cursor", name: "Cursor", kind: "client", icon: "cursor.svg" },
  { id: "cline", name: "Cline", kind: "client", icon: "cline.png" },
  { id: "kiro", name: "Kiro", kind: "client", icon: "kiro.svg" },
  { id: "trae", name: "TRAE", kind: "client", icon: "trae.png" },
  { id: "workbuddy", name: "WorkBuddy", kind: "client", icon: "workbuddy.svg" },
  { id: "codebuddy", name: "CodeBuddy", kind: "client", icon: "codebuddy.svg" },
  { id: "windsurf", name: "Windsurf", kind: "client" },
  { id: "aider", name: "Aider", kind: "client", icon: "aider.svg" },
  { id: "continue", name: "Continue", kind: "client", icon: "continue.svg" },
  { id: "goose", name: "Goose", kind: "client", icon: "goose.svg" },
];

const aliases: Record<string, string> = {
  newapi: "new-api", oneapi: "one-api", cliproxyapi: "cpa", claude: "claude-code",
};
const unknown: CallerClient = { id: "", name: "未知客户端", kind: "unknown" };

export function callerClient(value?: string): CallerClient {
  const id = value?.trim().toLowerCase() ?? "";
  return CLIENTS.find((client) => client.id === (aliases[id] ?? id)) ?? unknown;
}

export function callerClientIcon(client: CallerClient): string | undefined {
  // These verified original project assets live in their own caller namespace.
  return client.icon ? `/callers/${client.icon}` : undefined;
}
