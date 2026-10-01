// 统一 CLI 指纹模块（所有订阅型 OAuth 渠道共用）
// ===========================================================================
// 目标：同一账号每次请求都带**稳定且各账号互不相同**的客户端身份。
// 上游把「同一账号短时间多设备/多会话/身份乱跳」当作风控特征，所以：
//   · 所有身份由种子（渠道 id + 账号标识）确定性派生，重启后不变；
//   · 渠道换账号（重新导入凭据）后身份自然整体更换；
//   · 不同渠道/账号之间互不关联（种子里带 type+id+account）。
//
// 各厂商用到的身份字段：
//   Codex       : Session-Id（UUID）、client_metadata.x-codex-*、UA/originator
//   Claude Code : metadata.user_id = JSON{device_id,account_uuid,session_id}、
//                 X-Claude-Code-Session-Id、UA/axios UA
//   Antigravity : requestId（agent-<uuid>）、request.sessionId（-<int63>）
//
// 说明：这里只生成「客户端身份」，不涉及任何浏览器指纹；订阅渠道走的是
// CLI 协议（HTTPS + OAuth），TLS/JS 指纹由官方 CLI 决定，服务端无法也无需复刻。
import crypto from "node:crypto";

const NS = "ooapi-cli-profile";

function digest(seed, tag, bytes = 32) {
  return crypto
    .createHash("sha256")
    .update(`${NS}|${tag}|${seed}`)
    .digest("hex")
    .slice(0, bytes * 2);
}

/** 确定性 UUID（格式合法，内容由种子决定） */
export function seededUuid(seed, tag = "uuid") {
  const h = digest(seed, tag, 16);
  // 版本位 4（0100），变体位 8/9/a/b
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 确定性 64 位小写 hex（Claude device_id 要求 64 hex） */
export function seededHex64(seed, tag = "device") {
  return digest(seed, tag, 32);
}

/** 确定性正整数（< 2^63，Antigravity sessionId 用） */
export function seededInt63(seed, tag = "session") {
  const h = digest(seed, tag, 8);
  return Number(BigInt(`0x${h}`) & 0x7fffffffffffffffn);
}

/** 渠道身份种子：只取稳定字段（渠道类型 + id）。
 * 不能带 account/email 等「刷新后才补齐」的字段：否则刷新一次凭据就把整套
 * device/session 换掉，反而触发上游「身份乱跳」风控。 */
export function profileSeed(channel) {
  return `${channel?.type || "unknown"}:${channel?.id || 0}`;
}

// ---------------------------------------------------------------------------
// 官方 CLI 版本与 UA 常量
// 版本号可通过渠道 other.client_version 覆盖（上游升级后管理员无需改代码）
// ---------------------------------------------------------------------------
export const CLI_VERSIONS = {
  codex: "0.154.0",
  claude: "2.1.258",
  claudeStainless: "0.112.1",
  claudeRuntime: "v26.3.0",
  axios: "1.15.2",
  antigravity: "2.9.1",
  antigravityNodeApi: "10.3.0",
  antigravityGoogApi: "gl-node/22.21.1",
  grok: "0.2.120",
  // 官方发布 v1.18.34（2026-09-30）；与该 tag 的 session/llm/request.ts 保持一致。
  opencode: "1.18.34",
};

export function codexUserAgent(channel) {
  const v = String(channel?.other?.client_version || "").trim() || CLI_VERSIONS.codex;
  return `codex-tui/${v} (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; ${v})`;
}

export function claudeUserAgent(channel) {
  const v = String(channel?.other?.client_version || "").trim() || CLI_VERSIONS.claude;
  return `claude-cli/${v} (external, cli)`;
}

export function antigravityUserAgent(channel, { withNodeClient = false } = {}) {
  const v = String(channel?.other?.client_version || "").trim() || CLI_VERSIONS.antigravity;
  return withNodeClient
    ? `antigravity/hub/${v} darwin/arm64 google-api-nodejs-client/${CLI_VERSIONS.antigravityNodeApi}`
    : `antigravity/hub/${v} darwin/arm64`;
}

// ---------------------------------------------------------------------------
// 各厂商身份
// ---------------------------------------------------------------------------

/** Codex：会话/线程/安装 id 全部按渠道稳定派生 */
export function codexIdentity(channel) {
  const seed = profileSeed(channel);
  return {
    sessionId: seededUuid(seed, "codex-session"),
    threadId: seededUuid(seed, "codex-thread"),
    windowId: seededUuid(seed, "codex-window"),
    installationId: seededUuid(seed, "codex-installation"),
    userAgent: codexUserAgent(channel),
  };
}

/** Claude Code：device_id/account_uuid/session_id 三元组（user_id 用 JSON 字符串） */
export function claudeIdentity(channel) {
  const seed = profileSeed(channel);
  const deviceId = seededHex64(seed, "claude-device");
  const accountUuid = String(channel?.other?.account_uuid || "").trim() || seededUuid(seed, "claude-account");
  const sessionId = String(channel?.other?.session_id || "").trim() || seededUuid(seed, "claude-session");
  return {
    deviceId,
    accountUuid,
    sessionId,
    userId: JSON.stringify({ device_id: deviceId, account_uuid: accountUuid, session_id: sessionId }),
    userAgent: claudeUserAgent(channel),
  };
}

/** Antigravity：请求 id 与会话 id */
export function antigravityIdentity(channel) {
  const seed = profileSeed(channel);
  const sessionInt = seededInt63(seed, "ag-session");
  return {
    requestId: `agent-${seededUuid(seed, "ag-request")}`,
    sessionId: `-${sessionInt}`,
    userAgent: antigravityUserAgent(channel),
  };
}

/** Grok（xAI）：会话 id 同时用于 x-grok-conv-id 头与 prompt_cache_key */
export function grokIdentity(channel) {
  const seed = profileSeed(channel);
  const v = String(channel?.other?.client_version || "").trim() || CLI_VERSIONS.grok;
  return {
    sessionId: seededUuid(seed, "grok-session"),
    clientVersion: v,
    userAgent: `xai-grok-workspace/${v}`,
  };
}

let opencodeLastTimestamp = 0;
let opencodeRequestCounter = 0;

/** OpenCode Zen：session 稳定派生，单次 request 使用官方 msg_ + 26 字符编码。 */
export function opencodeIdentity(channel) {
  const seed = profileSeed(channel);
  const timestamp = Date.now();
  if (timestamp !== opencodeLastTimestamp) {
    opencodeLastTimestamp = timestamp;
    opencodeRequestCounter = 0;
  }
  // v1.18.34 schema/identifier.ts：低 6 字节时间/计数 + 14 字符 base62 后缀。
  const current = BigInt(timestamp) * 0x1000n + BigInt(++opencodeRequestCounter);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((current >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const suffix = [...crypto.randomBytes(14)].map((byte) => alphabet[byte % 62]).join("");
  const version = String(channel?.other?.client_version || CLI_VERSIONS.opencode).trim();
  return {
    // 官方 SessionID 只校验 ses 前缀；确定性后缀保持 26 字符，避免重启后身份改变。
    sessionId: `ses_${digest(seed, "opencode-session", 16).slice(0, 26)}`,
    requestId: `msg_${time}${suffix}`,
    // 官方 ProjectID.global 是无 Git 项目时的标识，网关没有调用方的本地仓库信息。
    projectId: "global",
    userAgent: `opencode/${version}`,
  };
}
