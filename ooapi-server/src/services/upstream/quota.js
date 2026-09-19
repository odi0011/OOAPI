// 账号额度 / 用量查询（渠道维度）
// ===========================================================================
// 解决的问题：反代与订阅渠道在界面上只显示「能不能通」，看不到账号还剩多少额度，
// 管理员无法判断「这个号是不是快用完了」。
//
// 设计原则（**风控优先**）：
//   1. 额度查询**绝不能进请求主链路**（每次对话都去问额度 = 明显的脚本特征）。
//      只有两个入口：管理员显式点「查额度」、或低频定时任务（默认关闭、最小间隔 30 分钟）。
//   2. 单账号同一时刻只允许一个额度查询在飞（withQuotaLock），避免并发打同一账号。
//   3. 查询失败**不写渠道 last_error、不冷却、不降级** —— 额度接口挂了不代表渠道不可用。
//   4. 拿不到额度的厂商如实返回 unsupported，不做猜测性请求。
//
// 端点来源（2026-09 调研，均为各家 CLI / 官方前端实际调用的接口）：
//   · Codex        GET  chatgpt.com/backend-api/wham/usage                （openai/codex 仓库同款）
//   · Claude 订阅  GET  api.anthropic.com/api/oauth/usage                 （claude-code CLI /usage）
//   · Antigravity  POST daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
//   · Grok 订阅    GET  cli-chat-proxy.grok.com/v1/billing?format=credits （grok CLI /usage）
//   · Kiro         GET  codewhisperer.{region}.amazonaws.com/getUsageLimits
//   · ChatGPT 网页 POST chatgpt.com/backend-api/conversation/init         （limits_progress）
//   · DeepSeek API GET  api.deepseek.com/user/balance                     （官方文档端点）
//   其余（GLM/Kimi/豆包/通义的网页版）上游没有可读额度接口 → 明确返回不支持。
// ---------------------------------------------------------------------------
import { codexIdentity, claudeIdentity } from "./cli-profile.js";

const QUOTA_TIMEOUT_MS = 25_000;
/** 同一渠道的额度查询串行化：并发打同一账号是最容易被风控标记的行为之一 */
const inflight = new Map(); // channelId -> Promise
function withQuotaLock(channelId, task) {
  const key = String(channelId);
  const prev = inflight.get(key);
  if (prev) return prev;
  const p = (async () => task())().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 百分比归一：不同厂商口径不一（0-1 小数 / 0-100 整数），统一成 0-100 */
function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const val = n > 0 && n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(val * 10) / 10));
}

function windowLabel(seconds) {
  const s = Number(seconds) || 0;
  if (!s) return "";
  if (s % 604800 === 0) return `${s / 604800} 天`;
  if (s % 3600 === 0) return `${s / 3600} 小时`;
  return `${Math.round(s / 60)} 分钟`;
}

function epochOf(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.floor(n > 1e12 ? n / 1000 : n);
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

async function getJson(url, { headers = {}, method = "GET", body, signal } = {}) {
  const resp = await fetch(url, {
    method,
    headers: { accept: "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    signal: signal || AbortSignal.timeout(QUOTA_TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`额度接口返回 HTTP ${resp.status}：${text.slice(0, 200)}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("额度接口返回的不是 JSON"), { body: text.slice(0, 200) });
  }
}

/** 取可用 access_token（复用各适配器的刷新逻辑，刷新会写回渠道） */
async function freshToken(channel, adapterModule) {
  const other = channel?.other || {};
  const exp = Number(other.expires_at || 0);
  const soon = !exp || exp - 300 <= Math.floor(Date.now() / 1000);
  if (soon && adapterModule?.refreshAuth) {
    await adapterModule.refreshAuth(channel, { force: !exp });
  }
  const token = String(channel?.other?.access_token || channel?.api_key || "");
  if (!token) throw Object.assign(new Error("渠道没有可用凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  return token;
}

// ---------------------------------------------------------------------------
// 各厂商实现
// ---------------------------------------------------------------------------

async function quotaCodex(channel) {
  const mod = await import("./codex.js");
  const token = await freshToken(channel, mod);
  const identity = codexIdentity(channel);
  const j = await getJson("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      authorization: `Bearer ${token}`,
      // 缺这个头会打到错误的 workspace，甚至 401
      ...(channel?.other?.account_id ? { "chatgpt-account-id": String(channel.other.account_id) } : {}),
      originator: "codex-tui",
      "user-agent": identity.userAgent,
    },
  });
  const windows = [];
  for (const [key, label] of [
    ["primary_window", "主窗口"],
    ["secondary_window", "次窗口"],
  ]) {
    const w = rl[key];
    if (!w) continue;
    windows.push({
      key,
      label: `${label}（${windowLabel(w.limit_window_seconds) || "?"}）`,
      usedPercent: pct(w.used_percent),
      windowSeconds: Number(w.limit_window_seconds) || 0,
      resetAt: Number(w.reset_at) || 0,
      resetAfterSeconds: Number(w.reset_after_seconds) || 0,
    });
  }
  return {
    account: String(j.email || channel?.other?.email || ""),
    plan: String(j.plan_type || channel?.other?.plan_type || ""),
    windows,
    credits: j.credits
      ? {
          hasCredits: Boolean(j.credits.has_credits),
          unlimited: Boolean(j.credits.unlimited),
          balance: String(j.credits.balance ?? ""),
        }
      : null,
    limitReached: Boolean(rl.limit_reached) || Boolean(j.rate_limit_reached_type),
    resetCredits: Number(j.rate_limit_reset_credits?.available_count) || 0,
  };
}

async function quotaClaude(channel) {
  const mod = await import("./claude-oauth.js");
  const token = await freshToken(channel, mod);
  const identity = claudeIdentity(channel);
  const j = await getJson("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${token}`,
      // oauth beta 头解锁 limits / spend 富字段；缺了只有 five_hour/seven_day
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "user-agent": identity.userAgent,
      "x-app": "cli",
    },
  });
  const windows = [];
  const push = (key, label, raw, seconds) => {
    if (!raw) return;
    windows.push({
      key,
      label,
      usedPercent: pct(raw.utilization),
      windowSeconds: seconds,
      resetAt: epochOf(raw.resets_at),
    });
  };
  push("five_hour", "5 小时窗口", j.five_hour, 5 * 3600);
  push("seven_day", "7 天窗口", j.seven_day, 7 * 86400);
  push("seven_day_sonnet", "7 天 Sonnet 窗口", j.seven_day_sonnet, 7 * 86400);
  // limits[] 里的 scoped 窗口（如 Opus 专属）单独展示
  for (const [i, l] of (Array.isArray(j.limits) ? j.limits : []).entries()) {
    if (!l || l.kind !== "weekly_scoped") continue;
    windows.push({
      key: `scoped_${i}`,
      label: `7 天 ${l.scope?.model?.display_name || "限定模型"}窗口`,
      usedPercent: pct(l.percent),
      windowSeconds: 7 * 86400,
      resetAt: epochOf(l.resets_at),
      severity: l.severity || "",
    });
  }
  return {
    account: String(channel?.other?.email || ""),
    plan: String(channel?.other?.plan_type || ""),
    windows,
    extraUsage: j.extra_usage
      ? {
          enabled: Boolean(j.extra_usage.is_enabled),
          monthlyLimit: Number(j.extra_usage.monthly_limit) || 0,
          usedCredits: Number(j.extra_usage.used_credits) || 0,
          utilization: pct(j.extra_usage.utilization),
        }
      : null,
  };
}

async function quotaAntigravity(channel) {
  const mod = await import("./antigravity.js");
  const token = await freshToken(channel, mod);
  const j = await getJson("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "antigravity",
    },
    body: {},
  });
  const windows = [];
  for (const g of Array.isArray(j.groups) ? j.groups : []) {
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      if (b.remainingFraction === undefined) continue;
      windows.push({
        key: String(b.bucketId || ""),
        label: `${g.displayName || "配额"} · ${b.window || ""}`.trim(),
        // 注意：这里给的是**剩余**比例（1 = 满），与其他厂商的 usedPercent 相反
        usedPercent: pct((1 - Number(b.remainingFraction)) * 100),
        resetAt: epochOf(b.resetTime),
        note: b.description || "",
      });
    }
  }
  return { account: String(channel?.other?.email || ""), plan: String(channel?.other?.plan_tier || channel?.other?.tier || ""), windows };
}

async function quotaGrok(channel) {
  const mod = await import("./grok.js");
  const token = await freshToken(channel, mod);
  const j = await getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: {
      authorization: `Bearer ${token}`,
      // 缺这两个头会被网关直接拒（426 / 401）
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.112",
      "x-grok-client-mode": "interactive",
      "user-agent": "grok-pager/0.2.112 grok-shell/0.2.112",
    },
  });
  const cfg = j.config || j;
  const used = pct(cfg.creditUsagePercent);
  const period = cfg.currentPeriod || {};
  const windows = [];
  if (used !== null) {
    windows.push({
      key: "credits",
      label: period.type === "USAGE_PERIOD_TYPE_MONTHLY" ? "本月额度" : "本周额度",
      usedPercent: used,
      resetAt: epochOf(period.end),
      note: period.start ? `${period.start} ~ ${period.end || ""}` : "",
    });
  }
  const cents = (v) => (v === undefined || v === null ? null : Number(v?.val ?? v) / 100);
  return {
    account: String(channel?.other?.email || channel?.other?.user_id || ""),
    plan: String(channel?.other?.subscription_tier || ""),
    windows,
    credits: {
      prepaidBalance: cents(cfg.prepaidBalance),
      onDemandCap: cents(cfg.onDemandCap),
      onDemandUsed: cents(cfg.onDemandUsed),
      unlimited: Boolean(cfg.unlimited),
    },
  };
}

async function quotaKiro(channel) {
  const mod = await import("./kiro.js");
  const token = await freshToken(channel, mod);
  const region = String(channel?.other?.region || "us-east-1");
  const profileArn = String(channel?.other?.profile_arn || channel?.other?.profileArn || "");
  const qs = new URLSearchParams({ origin: "AI_EDITOR", resourceType: "AGENTIC_REQUEST", isEmailRequired: "true" });
  if (profileArn) qs.set("profileArn", profileArn);
  const j = await getJson(`https://codewhisperer.${region}.amazonaws.com/getUsageLimits?${qs.toString()}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-amzn-codewhisperer-optout": "true",
      "user-agent": "aws-sdk-js/1.0.0 KiroIDE-0.8.0",
      "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE-0.8.0",
    },
  });
  const windows = [];
  const credits = { lines: [] };
  for (const b of Array.isArray(j.usageBreakdownList) ? j.usageBreakdownList : []) {
    const limit = Number(b.usageLimit) || 0;
    const cur = Number(b.currentUsage) || 0;
    // 单位取决于 unit 字段（历史上出现过 CREDIT 与小数计数两种形态），原样展示不换算
    credits.lines.push({
      label: `${b.resourceType || "额度"}（${b.unit || ""}）`,
      used: cur,
      limit,
      overageRate: Number(b.overageRate) || 0,
    });
    if (limit > 0) {
      windows.push({
        key: String(b.resourceType || "usage"),
        label: `${b.resourceType || "额度"}（${b.unit || ""}）`,
        usedPercent: pct((cur / limit) * 100),
        used: cur,
        limit,
        resetAt: Number(j.nextDateReset) || 0,
      });
    }
  }
  return {
    account: String(j.userInfo?.email || channel?.other?.email || ""),
    plan: String(j.subscriptionInfo?.subscriptionType || j.subscriptionInfo?.subscriptionTitle || ""),
    windows,
    credits,
  };
}

async function quotaOpenaiWeb(channel) {
  const mod = await import("./openai-web.js");
  const token = await freshToken(channel, mod);
  // 网页版没有独立额度接口，只能问「开新会话」返回的 limits_progress。
  // 这个请求会在上游留下一次会话初始化的痕迹，因此只在管理员显式查询时执行。
  const j = await getJson("https://chatgpt.com/backend-api/conversation/init", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      // 必须是浏览器 UA：CLI UA 会被 challenge 页拦掉
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      origin: "https://chatgpt.com",
      referer: "https://chatgpt.com/",
    },
    body: {
      conversation_id: null,
      gizmo_id: null,
      requested_default_model: null,
      system_hints: [],
      timezone: "Asia/Shanghai",
      timezone_offset_min: -480,
    },
  });
  const windows = [];
  for (const l of Array.isArray(j.limits_progress) ? j.limits_progress : []) {
    windows.push({
      key: String(l.feature_name || ""),
      label: `${l.feature_name || "功能"} 剩余`,
      // 网页版只给剩余次数、不给总量：用 remaining 直接展示，usedPercent 留空
      remaining: Number(l.remaining) || 0,
      resetAt: epochOf(l.reset_after),
      note: "上游只返回剩余次数，不提供总量",
    });
  }
  for (const m of Array.isArray(j.model_limits) ? j.model_limits : []) {
    windows.push({
      key: `model:${m.model_slug}`,
      label: `${m.model_slug} 已用尽`,
      usedPercent: 100,
      resetAt: epochOf(m.resets_after),
      note: "该模型当前已触发限额",
    });
  }
  return { account: String(channel?.other?.email || ""), plan: String(channel?.other?.plan_type || ""), windows, note: j.limits_progress ? "" : "该账号没有返回额度信息" };
}

async function quotaDeepseekApi(channel) {
  // 仅官方 API 渠道有余额接口（网页版无）。base_url 可能是自建兼容端点，必须先确认。
  const base = String(channel?.base_url || "").trim();
  if (!/deepseek\.com/i.test(base)) {
    throw Object.assign(new Error("仅 DeepSeek 官方 API（api.deepseek.com）支持余额查询"), { code: "QUOTA_UNSUPPORTED" });
  }
  const key = String(channel?.api_key || "").split("\n")[0].trim();
  if (!key) throw Object.assign(new Error("渠道没有 API Key"), { code: "CHANNEL_AUTH_EXPIRED" });
  const j = await getJson(`${base.replace(/\/+$/, "")}/user/balance`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const lines = (Array.isArray(j.balance_infos) ? j.balance_infos : []).map((b) => ({
    label: `余额（${b.currency}）`,
    total: Number(b.total_balance) || 0,
    granted: Number(b.granted_balance) || 0,
    toppedUp: Number(b.topped_up_balance) || 0,
  }));
  return {
    account: "",
    plan: "",
    windows: [],
    credits: { available: j.is_available !== false, lines },
  };
}

// ---------------------------------------------------------------------------
// 分派
// ---------------------------------------------------------------------------
const SUPPORTED = new Set(["codex", "claude-oauth", "antigravity", "grok-oauth", "kiro", "openai-web", "deepseek-api"]);

/** 该渠道是否支持额度查询（前端据此决定要不要显示「查额度」按钮） */
export function quotaSupportFor(channel = {}) {
  // 接入方式既可能作为顶层 method 传进来（rowToChannel 形状），也可能只在 other.method 里
  // （直接拿数据库行调用时），两种都要认，否则会误判成「不支持」。
  const m = String(channel.method || channel?.other?.method || "relay");
  const type = String(channel.type || "");
  if (SUPPORTED.has(m)) return { supported: true, key: m };
  if (m === "api" && type === "deepseek" && /deepseek\.com/i.test(String(channel.base_url || ""))) {
    return { supported: true, key: "deepseek-api" };
  }
  return { supported: false, key: "" };
}

/**
 * 查询某个渠道的账号额度。
 * @param {object} channel rowToChannel 形状（含 id/type/other/api_key/base_url）
 * @returns {Promise<object>} 归一化后的额度快照（含 fetchedAt）
 */
export async function fetchQuota(channel) {
  const support = quotaSupportFor(channel);
  if (!support.supported) {
    throw Object.assign(new Error("该接入方式上游没有可用的额度接口"), { code: "QUOTA_UNSUPPORTED" });
  }
  const run = async () => {
    let data;
    switch (support.key) {
      case "codex":
        data = await quotaCodex(channel);
        break;
      case "claude-oauth":
        data = await quotaClaude(channel);
        break;
      case "antigravity":
        data = await quotaAntigravity(channel);
        break;
      case "grok-oauth":
        data = await quotaGrok(channel);
        break;
      case "kiro":
        data = await quotaKiro(channel);
        break;
      case "openai-web":
        data = await quotaOpenaiWeb(channel);
        break;
      case "deepseek-api":
        data = await quotaDeepseekApi(channel);
        break;
      default:
        throw Object.assign(new Error("该接入方式上游没有可用的额度接口"), { code: "QUOTA_UNSUPPORTED" });
    }
    return {
      ...data,
      provider: support.key,
      fetchedAt: Date.now(),
    };
  };
  return withQuotaLock(channel.id, run);
}
