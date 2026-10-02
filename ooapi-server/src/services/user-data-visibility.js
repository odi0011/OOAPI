import { getOption } from "../config.js";

export const USER_DATA_FIELDS = ["balance", "usage_summary", "usage_records", "request_content", "pricing"];
const all = (value) => Object.fromEntries(USER_DATA_FIELDS.map((key) => [key, value]));

/** 配置只控制本人业务数据；上游渠道、凭据和管理员字段永不成为可公开权限。 */
export function parseUserDataVisibility(raw) {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some((key) => key !== "version" && !USER_DATA_FIELDS.includes(key)) ||
      USER_DATA_FIELDS.some((key) => !Object.hasOwn(value, key) || typeof value[key] !== "boolean")) {
    throw new Error("数据可见权限必须包含 version:1 和五项布尔权限");
  }
  return { version: 1, ...Object.fromEntries(USER_DATA_FIELDS.map((key) => [key, value[key]])), request_content: value.usage_records && value.request_content };
}

// 不在模块初始化时读取 config，避免配置服务与公开状态之间的循环初始化。
export function configuredUserDataVisibility(read = getOption) {
  const raw = read("user_data_visibility");
  if (raw) {
    try { return parseUserDataVisibility(raw); }
    catch { return { version: 1, ...all(false) }; } // 损坏的旧配置从严，不扩大暴露。
  }
  const show = ["true", "1"].includes(String(read("general_setting_quota_display")));
  const mode = String(read("user_visible_quota_detail"));
  return { version: 1, balance: show && ["full", "summary"].includes(mode),
    usage_summary: show && ["full", "summary"].includes(mode),
    usage_records: show && mode === "full", request_content: show && mode === "full",
    pricing: ["true", "1"].includes(String(read("expose_pricing_to_user"))) };
}

export function userDataVisibility(user) {
  return Number(user?.role) >= 100 ? { version: 1, ...all(true) } : configuredUserDataVisibility();
}

export function visibleAccountData(data, user) {
  const out = { ...data }, policy = userDataVisibility(user);
  if (!policy.balance) for (const key of ["quota", "remain_quota", "balance"]) delete out[key];
  if (!policy.usage_summary) for (const key of ["used_quota", "request_count", "consume_in_logs", "daily", "account_used_quota", "keys_used_quota", "deleted_used_quota"]) delete out[key];
  if (!policy.pricing) for (const key of ["rate", "group_rate"]) delete out[key];
  return out;
}

export function requireUserData(field) {
  return (req, res, next) => userDataVisibility(req.user)[field]
    ? next() : res.status(403).json({ success: false, message: "管理员未开放此项数据查看权限" });
}

/** 只投影会话结构与运行事件的审计字段，正文和任意工具输入不作内容改写。 */
export function visibleChatAudit(value, policy, { isAdmin = false } = {}) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => visibleChatAudit(item, policy, { isAdmin }));
  const out = { ...value };
  if (!policy.usage_records) for (const key of ["cost", "cost_units", "tokens", "usage", "promptTokens", "completionTokens", "cacheTokens", "prompt_tokens", "completion_tokens", "cache_tokens", "firstTokenMs", "elapsedMs", "retryCount", "first_token_ms", "elapsed_ms", "retry_count"]) delete out[key];
  if (!policy.pricing) for (const key of ["price", "unit_price", "rate", "group_rate", "billing_details"]) delete out[key];
  if (!isAdmin) for (const key of ["channel", "channelId", "channel_id", "channel_name", "channelQuote", "channel_quote", "upstream_model", "request_prompt_text"]) delete out[key];
  for (const key of ["session", "sessions", "messages", "message", "userMessage", "parts", "part", "patch"]) {
    if (out[key] && typeof out[key] === "object") out[key] = visibleChatAudit(out[key], policy, { isAdmin });
  }
  return out;
}
