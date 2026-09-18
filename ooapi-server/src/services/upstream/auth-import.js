// 统一凭据导入：兼容 CPA（CLIProxyAPI）auth 文件 与 sub2api 导出文件
// ===========================================================================
// 支持的输入形态：
//   1) sub2api 导出：{ exported_at, accounts: [{ platform, type, credentials, name, priority }] }
//   2) CPA auth 文件（auths/*.json）：{ type: "codex|claude|antigravity|gemini|xai", access_token, ... }
//   3) 多个对象拼接/数组/目录内容（自动按顶层对象切分）
//   4) 裸凭据（Codex auth.json / Claude .credentials.json / 裸 access_token 对象）
//
// 映射规则（把“它们能导入的”映射到我们已实现的接入方式）：
//   openai/anthropic/gemini 的 API Key → 对应厂商的 api（openai-compat）
//   openai + oauth（Codex）           → openai / codex
//   anthropic + oauth（Claude Code）  → anthropic / claude-oauth
//   gemini/antigravity + oauth        → gemini / antigravity（记录 oauth_client 供刷新用）
//   xai/grok + oauth                  → grok / grok-oauth
//   xai/grok + apikey                 → grok / api
//   kimi + oauth（JWT）               → kimi / relay（尽力而为，非 JWT 会明确拒绝）
//
// 返回：{ accounts: [{ type, method, name, priority, token, other, accountLabel }], errors: [...] }
// 说明：不直接写库；由调用方（/api/channel/import）落库并做去重。
import { getMethod } from "../channel-types.js";
import { getAdapter } from "../router.js";

const PLATFORM_MAP = {
  openai: { oauth: { type: "openai", method: "codex" }, apikey: { type: "openai", method: "api" } },
  anthropic: { oauth: { type: "anthropic", method: "claude-oauth" }, apikey: { type: "anthropic", method: "api" } },
  claude: { oauth: { type: "anthropic", method: "claude-oauth" }, apikey: { type: "anthropic", method: "api" } },
  gemini: { oauth: { type: "gemini", method: "antigravity", oauthClient: "gemini" }, apikey: { type: "gemini", method: "api" } },
  antigravity: { oauth: { type: "gemini", method: "antigravity", oauthClient: "antigravity" } },
  grok: { oauth: { type: "grok", method: "grok-oauth" }, apikey: { type: "grok", method: "api" } },
  xai: { oauth: { type: "grok", method: "grok-oauth" }, apikey: { type: "grok", method: "api" } },
  kimi: { oauth: { type: "kimi", method: "relay" } },
  moonshot: { oauth: { type: "kimi", method: "relay" } },
};

// CPA auth 文件的 type 字段
const CPA_TYPE_MAP = {
  codex: { type: "openai", method: "codex" },
  claude: { type: "anthropic", method: "claude-oauth" },
  anthropic: { type: "anthropic", method: "claude-oauth" },
  antigravity: { type: "gemini", method: "antigravity", oauthClient: "antigravity" },
  gemini: { type: "gemini", method: "antigravity", oauthClient: "gemini" },
  xai: { type: "grok", method: "grok-oauth" },
  grok: { type: "grok", method: "grok-oauth" },
};

function detectKind(kind) {
  const k = String(kind || "").toLowerCase();
  return k === "apikey" || k === "api_key" || k === "api" ? "apikey" : "oauth";
}

/** 判断对象里的 type 字段是否是「凭据类型」（codex/claude/xai…），而不是 sub2api 的 oauth/apikey */
function cpaTypeOf(item) {
  if (item.platform) return undefined;
  const t = String(item.type || "").toLowerCase();
  if (!t) return undefined;
  if (["oauth", "apikey", "api_key", "api"].includes(t)) return undefined;
  return item.type; // 原样返回，normalizeOne 里对不支持的类型给出准确报错
}

/** 顶层 JSON 对象切分：支持把多个 CPA auth 文件直接拼接粘贴 */
function splitTopLevelObjects(text) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* 忽略坏块 */
        }
        start = -1;
      }
    }
  }
  return out;
}

/** 单账号归一化：识别平台/类型 → 调用目标适配器解析凭据 */
async function normalizeOne({ platform, kind, credentials, cpaType, name, priority }) {
  let mapping = null;
  if (platform) {
    const m = PLATFORM_MAP[String(platform).toLowerCase()];
    if (!m) throw new Error(`暂不支持该平台：${platform}`);
    mapping = m[detectKind(kind)];
    if (!mapping) throw new Error(`平台 ${platform} 不支持 ${kind || "oauth"} 类型`);
  } else if (cpaType) {
    mapping = CPA_TYPE_MAP[String(cpaType).toLowerCase()];
    if (!mapping) throw new Error(`暂不支持该凭据类型：${cpaType}`);
  } else {
    mapping = sniffMapping(credentials);
    if (!mapping) throw new Error("无法识别凭据格式（既不是 sub2api 导出，也不是 CPA/官方凭据）");
  }

  const { type, method, oauthClient } = mapping;
  const mCfg = getMethod(type, method);
  if (!mCfg) throw new Error(`平台 ${type} 未配置接入方式 ${method}`);

  // API Key 账号：直接构造 api 接入（不经过 OAuth 适配器）
  if (method === "api" || detectKind(kind) === "apikey") {
    const apiKey = String(credentials.api_key || credentials.key || credentials.apiKey || "").trim();
    if (!apiKey) throw new Error("API Key 账号缺少 api_key");
    return {
      type,
      method: "api",
      name: name || `${type}-key`,
      priority: Number(priority) || 0,
      token: apiKey.slice(0, 60_000),
      other: { method: "api" },
      accountLabel: name || "",
      base_url: String(credentials.base_url || credentials.baseUrl || "").trim(),
    };
  }

  // OAuth：交给目标适配器解析（各厂商字段差异全部在 importAuth 内消化）
  const adapter = await getAdapter({ type, other: { method } });
  if (!adapter?.importAuth) throw new Error(`平台 ${type} 的 ${method} 适配器未实现凭据导入`);
  const r = await adapter.importAuth({ token: JSON.stringify(credentials) });
  const other = { method, ...(r.other || {}) };
  if (oauthClient) other.oauth_client = oauthClient;
  return {
    type,
    method,
    name: name || r.accountLabel || `${type}-oauth`,
    priority: Number(priority) || 0,
    token: String(r.token || "").slice(0, 60_000),
    other,
    accountLabel: r.accountLabel || "",
    base_url: mCfg.baseUrl || "",
  };
}

/** 无平台/类型字段时按凭据形态嗅探（裸 codex auth.json / claude 凭据 / gemini oauth） */
function sniffMapping(cred) {
  if (!cred || typeof cred !== "object") return null;
  if (cred.tokens || cred.token_data) return { type: "openai", method: "codex" };
  if (cred.claudeAiOauth || cred.oauth?.access_token) return { type: "anthropic", method: "claude-oauth" };
  if (cred.type === "codex" || cred.account_id || cred.chatgpt_account_id) return { type: "openai", method: "codex" };
  if (cred.type === "claude" || cred.account_uuid) return { type: "anthropic", method: "claude-oauth" };
  if (cred.type === "xai" || cred.auth_kind === "oauth") return { type: "grok", method: "grok-oauth" };
  if (cred.project_id || cred.expiry || cred.expiry_date || cred.expired) {
    return { type: "gemini", method: "antigravity", oauthClient: "gemini" };
  }
  if (cred.api_key) return null; // 缺平台信息，无法确定厂商
  return null;
}

/**
 * 解析导入文本（sub2api 导出 / CPA auth / 裸凭据 / 多对象拼接）
 */
export async function parseCredentialFile(raw) {
  const text = String(raw || "").trim();
  if (!text) return { accounts: [], errors: [{ name: "（文件）", reason: "内容为空" }] };
  let root = null;
  try {
    root = JSON.parse(text);
  } catch {
    root = null;
  }

  const tasks = [];
  if (root && Array.isArray(root.accounts)) {
    // sub2api 导出
    for (const a of root.accounts) {
      tasks.push({ platform: a.platform, kind: a.type, credentials: a.credentials || {}, name: a.name, priority: a.priority });
    }
  } else if (root && Array.isArray(root)) {
    for (const item of root) {
      tasks.push({
        platform: item.platform,
        kind: item.type,
        cpaType: cpaTypeOf(item),
        credentials: item.credentials || item,
        name: item.name,
        priority: item.priority,
      });
    }
  } else if (root && typeof root === "object") {
    tasks.push({
      platform: root.platform,
      kind: root.type,
      cpaType: cpaTypeOf(root),
      credentials: root.credentials || root,
      name: root.name,
      priority: root.priority,
    });
  } else {
    // 拼接/目录内容：按顶层对象逐个解析
    for (const obj of splitTopLevelObjects(text)) {
      tasks.push({
        platform: obj.platform,
        kind: obj.type,
        cpaType: cpaTypeOf(obj),
        credentials: obj.credentials || obj,
        name: obj.name,
        priority: obj.priority,
      });
    }
  }
  if (!tasks.length) return { accounts: [], errors: [{ name: "（文件）", reason: "没有可识别的账号条目" }] };

  const accounts = [];
  const errors = [];
  for (const t of tasks) {
    try {
      accounts.push(await normalizeOne(t));
    } catch (e) {
      errors.push({ name: t.name || "（未命名）", reason: e.message });
    }
  }
  return { accounts, errors };
}
