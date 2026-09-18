import { pool } from "./db.js";

// 系统设置默认值（管理员可在后台修改，存于 options 表）
export const DEFAULT_OPTIONS = {
  system_name: "OOAPI",
  logo: "/logo.jpg",
  footer: "© 2026 OOAPI · 大模型 API 网关",
  about: "OOAPI 是新一代大模型 API 网关与分发系统，支持多模型统一接入、令牌分发与用量统计。",
  api_endpoint: "",
  docs_link: "https://docs.newapi.pro",
  server_address: "",

  // 计费 / 额度
  quota_per_unit: "10000", // 旧键（保留兼容，计费不读它）；默认值必须与新币制一致，
  // 否则设置页会把 500000 写回库，migrate2 误判为旧库再次换算（历史事故根因之一）
  usd_rate: "1", // 旧键（保留兼容）；OD币固定 1 OD = 1 美元，无汇率换算
  general_setting_quota_display: "true",
  quota_for_new_user: "2000000", // 新用户初始额度（1 OD = 10000 单位 → 200 OD = $200）
  topup_link: "",

  // 认证（注册默认关闭：公开注册 + 赠送额度易被刷，需要管理员显式开启）
  password_register_enabled: "false",
  password_login_enabled: "true",

  // 模型（用于令牌模型限制的下拉列表）
  model_list: "gpt-4o,gpt-4o-mini,gpt-3.5-turbo,claude-3-5-sonnet-20241022,deepseek-chat,deepseek-reasoner,qwen-plus",

  // 显示
  header_nav_links: "",
  announcement: "",

  // 计费货币：OD 币，1 OD = 1 美元（1:1）
  currency_name: "OD币",
  currency_symbol: "OD币",
  units_per_od: "10000", // 1 OD 币 = 10000 额度单位（支持 0.0001 精度）
  request_timeout_ms: "600000", // 单次上游请求超时（毫秒）
  log_retention_days: "0", // 日志保留天数（0 = 永久保留；>0 时每 6 小时自动清理）
  chat_enabled: "true", // 是否开放站内对话（对话工作台合并了原智能体功能，一并由此开关控制）
  // 历史键：智能体曾是独立开关，现已合并进对话；保留默认值只为了让老库里残留的设置项不报错
  agent_enabled: "true",
  // --- 兼容旧键（前端历史版本可能读取，保留避免报错）---
  ds_enabled: "true",
  ds_price_1m_prompt: "0.3",
  ds_price_1m_completion: "1.2",
  ds_request_timeout_ms: "600000",
};

const cache = new Map();

export async function loadOptions() {
  cache.clear();
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    cache.set(key, DEFAULT_OPTIONS[key]);
  }
  const [rows] = await pool.query("SELECT key_str, value FROM options");
  for (const r of rows) cache.set(r.key_str, r.value);
}

export function getOption(key) {
  return cache.has(key) ? cache.get(key) : DEFAULT_OPTIONS[key] ?? "";
}

export function getBoolOption(key) {
  return getOption(key) === "true" || getOption(key) === "1";
}

export function getNumberOption(key) {
  return Number(getOption(key)) || 0;
}

export async function setOption(key, value) {
  const v = String(value);
  await pool.query(
    "INSERT INTO options (key_str, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [key, v]
  );
  cache.set(key, v);
}

// 公开给前端的 /api/status 配置子集
export function publicStatus() {
  return {
    system_name: getOption("system_name"),
    logo: getOption("logo"),
    footer: getOption("footer"),
    about: getOption("about"),
    api_endpoint: getOption("api_endpoint") || `${getOption("server_address") || ""}/v1`,
    docs_link: getOption("docs_link"),
    start_time: START_TIME,
    quota_per_unit: getNumberOption("quota_per_unit"),
    usd_rate: getNumberOption("usd_rate"),
    // 货币信息下发给前端，避免各页面自己硬编码符号（曾出现有的地方还写 $）
    currency_name: getOption("currency_name") || "OD币",
    currency_symbol: getOption("currency_symbol") || "OD币",
    // 额度换算固定 10000：计费代码（pricing.UNITS_PER_OD）是硬编码的，
    // 这里若读库可能和实际扣费漂移（历史：设置页可改该值 → 展示缩水但扣费不变）
    units_per_od: 10000,
    general_setting_quota_display: getBoolOption("general_setting_quota_display"),
    quota_for_new_user: getNumberOption("quota_for_new_user"),
    password_register_enabled: getBoolOption("password_register_enabled"),
    password_login_enabled: getBoolOption("password_login_enabled"),
    model_list: getOption("model_list").split(",").map((s) => s.trim()).filter(Boolean),
    header_nav_links: getOption("header_nav_links"),
    announcement: getOption("announcement"),
    version: VERSION,
  };
}

export const START_TIME = Math.floor(Date.now() / 1000);
export const VERSION = "0.1.0";
