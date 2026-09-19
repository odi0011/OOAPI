import { pool } from "./db.js";

// 系统设置默认值（管理员可在后台修改，存于 options 表）
// 分组约定（与后台「系统设置」页签一致）：站点 / 外观 / 认证 / 计费 / 用户 / 安全 / 网关 / 邮件 / 备份
export const DEFAULT_OPTIONS = {
  // ---------- 站点 ----------
  system_name: "OOAPI",
  logo: "/logo.jpg",
  favicon: "",
  footer: "© 2026 OOAPI · 大模型 API 网关",
  about: "OOAPI 是新一代大模型 API 网关与分发系统，支持多模型统一接入、令牌分发与用量统计。",
  api_endpoint: "",
  docs_link: "https://docs.newapi.pro",
  server_address: "",
  icp_number: "",
  police_number: "",
  contact_qq_group: "",
  contact_telegram: "",
  contact_discord: "",
  contact_email: "",
  announcement: "",
  announcement_type: "banner", // off / banner / modal
  announcement_version: "0",
  legal_user_agreement: "",
  legal_privacy_policy: "",
  header_nav_links: "",
  home_content: "",

  // ---------- 外观 ----------
  default_theme: "system", // light / dark / system
  default_primary: "blue",
  default_collapse_sidebar: "false",
  enable_theme_switch: "true",
  enable_primary_switch: "true",
  login_page_notice: "",
  home_show_models: "true",
  home_show_pricing: "true",

  // ---------- 认证 ----------
  password_register_enabled: "false",
  password_login_enabled: "true",
  register_email_required: "false",
  register_invite_only: "false",
  register_ip_limit: "0", // 同 IP 注册上限（0=不限）
  login_fail_lock_count: "5", // 登录失败几次锁定（0=不锁）
  login_fail_lock_minutes: "15",
  password_min_length: "8",
  session_days: "30",

  // ---------- 计费 ----------
  quota_per_unit: "10000", // 旧键（保留兼容，计费不读它）；默认值必须与新币制一致，
  // 否则设置页会把 500000 写回库，migrate2 误判为旧库再次换算（历史事故根因之一）
  usd_rate: "1", // 旧键（保留兼容）；OD币固定 1 OD = 1 美元，无汇率换算
  general_setting_quota_display: "true",
  quota_for_new_user: "2000000", // 新用户初始额度（1 OD = 10000 单位 → 200 OD = $200）
  topup_link: "",
  expose_pricing_to_user: "true", // 允许用户查看模型定价
  quota_remind_threshold: "100000", // 余额低于此值时前端提醒
  invite_reward_inviter: "0",
  invite_reward_invitee: "0",
  checkin_enabled: "false",
  checkin_min_quota: "1000",
  checkin_max_quota: "10000",
  currency_name: "OD币",
  currency_symbol: "OD币",
  units_per_od: "10000", // 1 OD 币 = 10000 额度单位（支持 0.0001 精度）

  // ---------- 用户默认值 ----------
  default_user_group: "", // 新用户默认分组（空=公共池）
  user_visible_quota_detail: "full", // full / summary / hidden
  allow_user_edit_profile: "true",
  chat_enabled: "true", // 是否开放站内对话（对话工作台合并了原智能体功能，一并由此开关控制）
  // 用户默认并发与限速（0 = 不限）
  default_user_concurrency: "0",
  default_user_rpm: "0",
  default_user_tpm: "0",
  log_retention_days: "0", // 日志保留天数（0 = 永久保留；>0 时每 6 小时自动清理）
  data_export_enabled: "true",
  data_export_interval: "5", // 看板刷新间隔（分钟）
  data_export_default_range: "7d",

  // ---------- 安全 ----------
  rate_limit_enabled: "false",
  rate_limit_window_minutes: "1",
  rate_limit_count: "0", // 窗口内请求上限（0=不限）
  sensitive_check_enabled: "false",
  sensitive_check_on_prompt: "true",
  sensitive_words: "",
  channel_disable_threshold: "5", // 连续失败几次自动禁用渠道
  auto_disable_channel: "false",
  auto_enable_channel: "false",
  auto_disable_status_codes: "401,403",
  auto_disable_keywords: "",
  auto_test_channel_enabled: "false", // 定时检测总闸（每渠道的 auto_test 是子开关）
  auto_test_channel_minutes: "60",
  auto_test_concurrency: "1",
  perf_metrics_enabled: "true",
  perf_metrics_retention_days: "0",

  // ---------- 网关 ----------
  request_timeout_ms: "600000", // 单次上游请求超时（毫秒）
  retry_times: "3", // 换渠道重试次数
  gateway_ping_interval: "0", // 流式保活心跳（秒，0=关闭）
  gateway_log_body: "false", // 是否在日志里记录提示词/回复摘要（更占空间但便于排障）

  // ---------- 邮件（SMTP）----------
  smtp_enabled: "false",
  smtp_host: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_pass: "",
  smtp_from: "",
  smtp_ssl: "false",
  smtp_starttls: "true",
  smtp_insecure: "false",

  // ---------- 备份 ----------
  backup_enabled: "false",
  backup_interval_hours: "24",
  backup_keep: "7", // 保留份数
  backup_dir: "", // 留空 = <server 根>/data/backups

  // 历史键：智能体曾是独立开关，现已合并进对话；保留默认值只为了让老库里残留的设置项不报错
  agent_enabled: "true",
  // --- 兼容旧键（前端历史版本可能读取，保留避免报错）---
  ds_enabled: "true",
  ds_price_1m_prompt: "0.3",
  ds_price_1m_completion: "1.2",
  ds_request_timeout_ms: "600000",
  // 模型白名单下拉：站内对话/令牌的模型来源已改为「分组 ∩ 渠道声明」，
  // 这个键不再参与任何逻辑，仅保留以避免老库里的残留值报错
  model_list: "",
};

// 敏感设置项：GET /api/option 一律掩码，PUT 收到掩码值时跳过不写
export const SECRET_OPTIONS = new Set(["smtp_pass"]);

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
// 原则：只下发「前端渲染必须知道」的项；敏感项（smtp_pass）与纯后台项一律不下发。
export function publicStatus() {
  return {
    system_name: getOption("system_name"),
    logo: getOption("logo"),
    favicon: getOption("favicon"),
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
    header_nav_links: getOption("header_nav_links"),
    announcement: getOption("announcement"),
    announcement_type: getOption("announcement_type") || "banner",
    announcement_version: getNumberOption("announcement_version"),
    login_page_notice: getOption("login_page_notice"),
    // 备案与联系方式（页脚渲染）
    icp_number: getOption("icp_number"),
    police_number: getOption("police_number"),
    contact_qq_group: getOption("contact_qq_group"),
    contact_telegram: getOption("contact_telegram"),
    contact_discord: getOption("contact_discord"),
    contact_email: getOption("contact_email"),
    // 合规文档（渲染为弹窗/页面）
    legal_user_agreement: getOption("legal_user_agreement"),
    legal_privacy_policy: getOption("legal_privacy_policy"),
    // 外观默认值（用户在 localStorage 覆盖）
    default_theme: getOption("default_theme") || "system",
    default_primary: getOption("default_primary") || "blue",
    default_collapse_sidebar: getBoolOption("default_collapse_sidebar"),
    enable_theme_switch: getBoolOption("enable_theme_switch"),
    enable_primary_switch: getBoolOption("enable_primary_switch"),
    home_content: getOption("home_content"),
    home_show_models: getBoolOption("home_show_models"),
    home_show_pricing: getBoolOption("home_show_pricing"),
    chat_enabled: getBoolOption("chat_enabled"),
    expose_pricing_to_user: getBoolOption("expose_pricing_to_user"),
    // 注册相关（注册页据此显示/隐藏字段）
    register_email_required: getBoolOption("register_email_required"),
    register_invite_only: getBoolOption("register_invite_only"),
    password_min_length: getNumberOption("password_min_length") || 8,
    version: VERSION,
  };
}

export const START_TIME = Math.floor(Date.now() / 1000);
export const VERSION = "0.1.0";
