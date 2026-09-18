// codex-state-kit —— ChatGPT/Codex 反代的「292 通行证 + 312 降智监控 + 轮换」模块
// ===========================================================================
// 机制来源（2026-09 社区逆向，见 blog.caowo.de「292 State 注入」）：
//   · ChatGPT 在特定条件下对 chat/completions 返回 **HTTP 292**（非标准状态码），
//     响应携带 `current_turn_state` —— 这是「不降智/不 overload」的通行证；
//   · 使用过程中服务端会主动下发 **HTTP 312**（降智信号），即使 292 未到期也作废；
//   · 通行证名义 TTL ≈ 1 小时，收到 312 必须立即重新采集；
//   · state 与**账号绑定**（A 账号的 state 不能给 B 用）；
//   · 采集时用模型、使用时用模型需要一致（社区实现限定 gpt-6-astra）；
//   · 采集建议用住宅 IP，使用可在其他 IP（当前观察未严格绑定 IP）。
//
// 工程化（codex-state-kit 架构，本模块 = 服务端版）：
//
//   ┌──────────────────────┐  ①注入（x-codex-turn-state / 可配 body 字段）
//   │  StateStore（内存）  │ ────────────────────────────────────┐
//   │  key: 渠道id+模型    │                                     ▼
//   │  {state,at,account}  │  ④捕获（响应头 / 响应体 / SSE）  ┌───────────────┐
//   └──────────▲───────────┘ ◀──────────────────────────────  │ codex.js      │
//              │                                              │ chat/verify   │
//              │                                              └───────┬───────┘
//   ┌──────────┴──────────┐   ⑤信号分类（312/过载/截断指纹）         │ ③上游响应
//   │ detectSignal()      │ ────────────────────────────────────────┘
//   │  · status 312→清state│        CHANNEL_DEGRADED + cooldownSec
//   │  · 过载关键词        │        execute.js 立即换号（其他账号可能持有有效 state）
//   │  · 516 截断指纹      │
//   └─────────────────────┘
//
// 限制与降级：
//   · 292 签发条件未知、且与出口 IP 相关：数据中心的出口可能拿不到 292，
//     此时 kit 自动退化为「无 state 直连」——不注入、不报错（与未启用一致）。
//   · 上游协议变化时不伪造字段：注入被拒（400/404 提到 turn state）→ 清除后重试一次。
//   · 不落盘：state 是短生命周期凭据，重启后由下一次响应自然重建。
// ---------------------------------------------------------------------------

const STATES = new Map(); // `${channelId}:${model}` -> { value, at, account, source }
const DEFAULT_TTL_MS = 55 * 60 * 1000; // 名义 1 小时，保守按 55 分钟
export const EXPIRING_MS = 5 * 60 * 1000; // 距过期不足 5 分钟视为「待续期」
export const DEGRADED_CODE = "CHANNEL_DEGRADED";
export const DEGRADED_COOLDOWN_SEC = 90; // 降智信号后的短冷却：只跳过该账号，不重罚

function stateKey(channel, model) {
  return `${Number(channel?.id) || 0}:${String(model || "")}`;
}

function accountKey(channel) {
  const o = channel?.other || {};
  const raw = String(o.account_id || o.chatgpt_account_id || o.account_uuid || o.email || o.refresh_token || channel?.id || "");
  return raw.slice(-24);
}

/** 是否启用 state kit（渠道可显式关闭：other.state_kit === false） */
export function isEnabled(channel) {
  return channel?.other?.state_kit !== false;
}

function storeState(channel, model, value, source) {
  if (!channel?.id || !value) return;
  STATES.set(stateKey(channel, model), {
    value: String(value),
    at: Date.now(),
    account: accountKey(channel),
    model: String(model || ""),
    source,
  });
}

/** 读取「该渠道 + 该模型」最近一次通行证（过期/换号自动失效） */
export function getState(channel, model, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const key = stateKey(channel, model);
  const s = STATES.get(key);
  if (!s) return null;
  if (Date.now() - s.at > ttlMs) {
    STATES.delete(key);
    return null;
  }
  if (s.account !== accountKey(channel)) {
    STATES.delete(key);
    return null;
  }
  return s;
}

/** 剩余有效期（毫秒）；无 state 返回 0 */
export function stateRemainingMs(channel, model) {
  const s = getState(channel, model);
  if (!s) return 0;
  return Math.max(0, DEFAULT_TTL_MS - (Date.now() - s.at));
}

/**
 * 请求前注入：返回要附加的请求头（无 state 时为空对象）。
 * bodyField 为 true 时额外返回 body 字段（部分中转要求放到请求体）。
 */
export function stateHeaders(channel, model) {
  if (!isEnabled(channel)) return {};
  const s = getState(channel, model);
  if (!s) return {};
  const headers = { "x-codex-turn-state": s.value };
  // 兼容把 state 放在 body 的网关（默认关闭，避免未知字段被上游 400）
  if (channel?.other?.state_in_body === true) headers.__stateBodyField = s.value;
  return headers;
}

/** 从响应头捕获（HTTP 路径） */
export function captureFromHeaders(channel, model, headers) {
  if (!isEnabled(channel)) return "";
  const v = headers?.get?.("x-codex-turn-state") || headers?.get?.("current_turn_state");
  if (v) storeState(channel, model, v, "header");
  return v || "";
}

/** 从响应体捕获：292/普通响应里的 current_turn_state 字段（JSON 或裸文本） */
export function captureFromBody(channel, model, bodyText) {
  if (!isEnabled(channel) || !bodyText) return "";
  const text = String(bodyText);
  let v = "";
  try {
    const j = JSON.parse(text);
    v = findTurnState(j);
  } catch {
    // 非严格 JSON：退化为正则提取（SSE 片段/混合体也适用）
    const m = /"current_turn_state"\s*:\s*"([^"]+)"/.exec(text) || /"x-codex-turn-state"\s*:\s*"([^"]+)"/.exec(text);
    v = m ? m[1] : "";
  }
  if (v) storeState(channel, model, v, "body");
  return v || "";
}

/** 深度优先找 current_turn_state / turn_state 字段 */
function findTurnState(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return "";
  for (const [k, val] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if ((key === "current_turn_state" || key === "turn_state" || key === "x-codex-turn-state") && typeof val === "string") {
      return val;
    }
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const found = findTurnState(val, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

/** 从 SSE 事件捕获（response.metadata / client_metadata / headers） */
export function captureFromEvent(channel, model, ev) {
  if (!isEnabled(channel) || !ev || typeof ev !== "object") return "";
  const v =
    ev?.headers?.["x-codex-turn-state"] ||
    ev?.headers?.["X-Codex-Turn-State"] ||
    ev?.response?.metadata?.headers?.["x-codex-turn-state"] ||
    ev?.metadata?.headers?.["x-codex-turn-state"] ||
    ev?.client_metadata?.["x-codex-turn-state"] ||
    ev?.current_turn_state ||
    "";
  if (typeof v === "string" && v) {
    storeState(channel, model, v, "event");
    return v;
  }
  return "";
}

/** 清除该渠道的状态（312 作废 / 上游拒绝 / 换号）。不传 model 清全部。 */
export function clearState(channelId, model) {
  const id = Number(channelId);
  if (model === undefined) {
    for (const k of [...STATES.keys()]) {
      if (k.startsWith(`${id}:`)) STATES.delete(k);
    }
    return;
  }
  STATES.delete(`${id}:${String(model)}`);
}

// ---------------------------------------------------------------------------
// 降智信号
// ---------------------------------------------------------------------------

const DEGRADED_STATUS_CODES = new Set(
  String(process.env.CODEX_DEGRADED_STATUS_CODES || "312")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
);

// 只在「错误路径」上匹配关键词，避免误伤正常回答里的文字
const DEGRADED_PATTERN = /overload|overloaded|capacity|degrad|\u964d\u667a|\u8fc7\u8f7d|\u5bb9\u91cf\u4e0d\u8db3/i;

/** 「思考截断」指纹：reasoning_tokens == 518n − 2（516、1034…） */
export function isTruncatedReasoning(usage) {
  const r = Number(
    usage?.output_tokens_details?.reasoning_tokens ??
      usage?.output_tokens_details?.thinking_tokens ??
      usage?.reasoning_tokens ??
      0
  );
  return Number.isFinite(r) && r > 0 && r % 518 === 516;
}

/**
 * 判定降智/过载信号。
 * @returns {{degraded:boolean, kind?:string, message?:string, cooldownSec?:number, invalidatesState?:boolean}}
 */
export function detectSignal({ status = 0, text = "", usage = null } = {}) {
  if (DEGRADED_STATUS_CODES.has(Number(status))) {
    return {
      degraded: true,
      kind: "status",
      message: `上游下发降智信号（HTTP ${status}），当前通行证已作废`,
      cooldownSec: DEGRADED_COOLDOWN_SEC,
      invalidatesState: true, // 312：立即作废当前 state，换到持有有效 state 的账号
    };
  }
  if (text && DEGRADED_PATTERN.test(String(text).slice(0, 800))) {
    return {
      degraded: true,
      kind: "text",
      message: "上游返回过载/降智提示",
      cooldownSec: DEGRADED_COOLDOWN_SEC,
    };
  }
  if (isTruncatedReasoning(usage)) {
    return {
      degraded: true,
      kind: "reasoning-truncated",
      message: "思考被上游截断（516 指纹），本轮按降智处理并轮换账号",
      cooldownSec: DEGRADED_COOLDOWN_SEC,
    };
  }
  return { degraded: false };
}

/** 仅供测试/诊断：当前状态快照（不含完整 state，避免误打印） */
export function _snapshot() {
  return new Map(
    [...STATES.entries()].map(([k, v]) => [k, { at: v.at, model: v.model, source: v.source, valueLen: v.value.length }])
  );
}
