import { Card as ArcPanel } from "../components/arc/card/card";
import { Card } from "../components/arc/card/card";
// 系统设置 —— 配置驱动
// ---------------------------------------------------------------------------
// 为什么改成配置驱动（原先是 5 个手写 Tab 组件）：设置项已经增长到 90+，
// 每加一项都要同时改「表单 JSX + 布尔归一化列表 + 数值范围校验」三处，
// 必然漏改（历史上就出现过「清空公告保存不掉」「布尔项被写成字符串 false」）。
// 现在全站设置项的字段定义只写一遍，三处自动一致。
//
// 分组：站点 / 外观 / 认证 / 计费 / 用户 / 安全 / 网关 / 邮件 / 备份（+ 更新）
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {   useSearchParams } from "react-router-dom";
import {
  Form, Input, Button, Switch, InputNumber, App as ArcApp, Tabs, Typography, Alert, Spin, Select, Tooltip,
 } from "../components/arc/index";
import {
  SettingOutlined, DollarOutlined, SafetyCertificateOutlined, CloudDownloadOutlined,
  BgColorsOutlined, LockOutlined, ApiOutlined, MailOutlined, DatabaseOutlined, UserOutlined,
 } from "../components/arc/icons";
import { API } from "../services/api";
import AgentRoutingSettings, { routingValue } from "../components/AgentRoutingSettings";
import { odOf, unitsPerOd } from "../services/format";
import { useApp } from "../context/AppContext";
import PageHeader from "../components/PageHeader";
import AppearanceSettings from "../components/AppearanceSettings";
import { OdCoin } from "../components/OdCoin";
import BrandLogo from "../components/BrandLogo";
import "./admin-settings.css";

const { Text } = Typography;

// ---------------------------------------------------------------------------
// 字段定义：type 决定控件，bool:true 的项保存时会归一化成 "true"/"false"
// ---------------------------------------------------------------------------
const F = {
  // ---------- 站点 ----------
  system_name: { g: "site", label: "系统名称", type: "text", ph: "OOAPI" },
  logo: { g: "site", label: "Logo 地址", type: "image", ph: "/logo.jpg", hint: "全站统一使用：导航、首页演示、登录注册页与平台默认标识。支持图片 URL 或站内路径。" },
  favicon: { g: "site", label: "站点图标", type: "image", ph: "留空则复用 Logo", hint: "浏览器标签页图标；留空跟随上面的 Logo。" },
  server_address: { g: "site", label: "服务器地址", type: "text", ph: "https://api.example.com" },
  api_endpoint: { g: "site", label: "API 端点", type: "text", ph: "留空自动拼接 服务器地址/v1" },
  docs_link: { g: "site", label: "文档链接", type: "text", ph: "https://..." },
  about: { g: "site", label: "站点简介", type: "textarea", rows: 3 },
  home_content: { g: "site", label: "首页内容", type: "textarea", rows: 4, ph: "支持 Markdown" },
  footer: { g: "site", label: "页脚文案", type: "textarea", rows: 2 },
  announcement: { g: "site", label: "公告内容", type: "textarea", rows: 3 },
  announcement_type: {
    g: "site", label: "公告展示方式", type: "select",
    options: [
      { value: "off", label: "关闭" },
      { value: "banner", label: "顶部横幅" },
      { value: "modal", label: "弹窗（每日一次）" },
    ],
  },
  announcement_version: { g: "site", label: "公告版本号", type: "number", min: 0, hint: "改公告后 +1 可让已读用户重新看到弹窗" },
  login_page_notice: { g: "site", label: "登录页提示", type: "textarea", rows: 2 },
  icp_number: { g: "site", label: "ICP 备案号", type: "text" },
  police_number: { g: "site", label: "公安备案号", type: "text" },
  contact_email: { g: "site", label: "客服邮箱", type: "text" },
  contact_qq_group: { g: "site", label: "客服 QQ 群", type: "text" },
  contact_telegram: { g: "site", label: "Telegram", type: "text" },
  contact_discord: { g: "site", label: "Discord", type: "text" },
  legal_user_agreement: { g: "site", label: "用户协议", type: "textarea", rows: 4, ph: "支持 Markdown；留空则不展示" },
  legal_privacy_policy: { g: "site", label: "隐私政策", type: "textarea", rows: 4, ph: "支持 Markdown；留空则不展示" },
  header_nav_links: { g: "site", label: "顶部导航链接", type: "textarea", rows: 2, ph: "每行一个：名称|地址" },

  // ---------- 认证 ----------
  password_login_enabled: { g: "auth", label: "允许密码登录", type: "switch", bool: true },
  password_register_enabled: { g: "auth", label: "允许注册", type: "switch", bool: true },
  register_email_required: { g: "auth", label: "注册必须填邮箱", type: "switch", bool: true },
  register_invite_only: { g: "auth", label: "仅邀请注册", type: "switch", bool: true },
  register_ip_limit: { g: "auth", label: "同 IP 注册上限", type: "number", min: 0, hint: "0 = 不限" },
  login_fail_lock_count: { g: "auth", label: "登录失败锁定阈值", type: "number", min: 0, hint: "0 = 不锁" },
  login_fail_lock_minutes: { g: "auth", label: "锁定时长（分钟）", type: "number", min: 1, max: 1440 },
  password_min_length: { g: "auth", label: "密码最小长度", type: "number", min: 6, max: 72 },
  session_days: { g: "auth", label: "登录有效期（天）", type: "number", min: 1, max: 365 },

  // ---------- 计费 ----------
  quota_for_new_user: { g: "billing", label: "注册赠送额度（OD币）", type: "number", min: 0, step: 0.0001, precision: 4, od: true },
  quota_remind_threshold: { g: "billing", label: "余额提醒阈值（OD币）", type: "number", min: 0, step: 0.0001, precision: 4, od: true },
  topup_link: { g: "billing", label: "充值链接", type: "text" },
  invite_reward_inviter: { g: "billing", label: "邀请人奖励（OD币）", type: "number", min: 0, step: 0.0001, precision: 4, od: true },
  invite_reward_invitee: { g: "billing", label: "被邀请人奖励（OD币）", type: "number", min: 0, step: 0.0001, precision: 4, od: true },
  checkin_enabled: { g: "billing", label: "启用签到", type: "switch", bool: true },
  checkin_min_quota: { g: "billing", label: "签到最小奖励（OD币）", type: "number", min: 0, step: 0.0001, precision: 4, od: true },
  checkin_max_quota: { g: "billing", label: "签到最大奖励（OD币）", type: "number", min: 0, step: 0.0001, precision: 4, od: true },

  // ---------- 用户 ----------
  default_user_group: { g: "user", label: "新用户默认分组", type: "text", ph: "留空 = 新用户无分组（需管理员指定）" },
  user_data_visibility: { g: "user", label: "用户可见数据", type: "visibility" },
  allow_user_edit_profile: { g: "user", label: "允许用户改资料", type: "switch", bool: true },
  chat_enabled: { g: "user", label: "开放站内对话", type: "switch", bool: true },
  default_user_concurrency: { g: "user", label: "新用户默认并发", type: "number", min: 0, hint: "0 = 不限" },
  default_user_rpm: { g: "user", label: "新用户默认 RPM", type: "number", min: 0, hint: "每分钟请求数，0 = 不限" },
  default_user_tpm: { g: "user", label: "新用户默认 TPM", type: "number", min: 0, hint: "每分钟 token 数，0 = 不限" },
  log_retention_days: { g: "user", label: "日志保留天数", type: "number", min: 0, hint: "0 = 永久；>0 时每 6 小时清理" },
  data_export_enabled: { g: "user", label: "启用数据看板", type: "switch", bool: true },
  data_export_interval: { g: "user", label: "看板刷新间隔（分钟）", type: "number", min: 1, max: 1440 },
  data_export_default_range: {
    g: "user", label: "看板默认时间范围", type: "select",
    options: [
      { value: "today", label: "今日" },
      { value: "7d", label: "近 7 天" },
      { value: "30d", label: "近 30 天" },
    ],
  },

  // ---------- 安全 ----------
  rate_limit_enabled: { g: "security", label: "启用请求限流", type: "switch", bool: true },
  rate_limit_window_minutes: { g: "security", label: "限流窗口（分钟）", type: "number", min: 1, max: 1440 },
  rate_limit_count: { g: "security", label: "窗口内请求上限", type: "number", min: 0, hint: "0 = 不限" },
  sensitive_check_enabled: { g: "security", label: "敏感词过滤", type: "switch", bool: true },
  sensitive_check_on_prompt: { g: "security", label: "检查提示词", type: "switch", bool: true },
  sensitive_words: { g: "security", label: "敏感词表", type: "textarea", rows: 4, ph: "每行一个" },
  auto_disable_channel: { g: "security", label: "渠道失败自动禁用", type: "switch", bool: true },
  auto_enable_channel: { g: "security", label: "渠道自动恢复", type: "switch", bool: true },
  channel_disable_threshold: { g: "security", label: "自动禁用阈值", type: "number", min: 1, hint: "连续失败几次" },
  auto_disable_status_codes: { g: "security", label: "自动禁用状态码", type: "text", ph: "401,403" },
  auto_disable_keywords: { g: "security", label: "自动禁用关键词", type: "text", ph: "逗号分隔" },
  auto_test_channel_enabled: { g: "security", label: "定时检测渠道", type: "switch", bool: true, hint: "各渠道仍需开启独立检测" },
  auto_test_channel_minutes: { g: "security", label: "检测间隔（分钟）", type: "number", min: 1, max: 1440 },
  auto_test_concurrency: { g: "security", label: "检测并发", type: "number", min: 1, max: 32 },
  perf_metrics_enabled: { g: "security", label: "性能指标采集", type: "switch", bool: true },
  perf_metrics_retention_days: { g: "security", label: "指标保留天数", type: "number", min: 0, hint: "0 = 永久" },

  // ---------- 网关 ----------
  gateway_agent_detection: { g: "gateway", label: "识别调用 Agent", type: "switch", bool: true, hint: "记录客户端与版本，并启用符合条件的 Agent 路由规则" },
  gateway_agent_rules: { g: "gateway", label: "Agent 路由规则", type: "agent-rules" },
  gateway_empty_cooldown_seconds: { g: "gateway", label: "空回复冷却（秒）", type: "number", min: 1, max: 300, hint: "上游未返回可用内容时暂缓使用该渠道，默认 30 秒" },
  request_timeout_ms: { g: "gateway", label: "单请求超时（毫秒）", type: "number", min: 1000, max: 86400000, step: 1000 },
  retry_times: { g: "gateway", label: "换渠道重试次数", type: "number", min: 0, max: 10 },
  gateway_ping_interval: { g: "gateway", label: "流式保活心跳（秒）", type: "number", min: 0, max: 600, hint: "0 = 关闭；长思考模型建议 15~30 防反代断流" },
  gateway_log_body: { g: "gateway", label: "记录提示词/回复摘要", type: "switch", bool: true, hint: "便于排障，但日志体积更大" },

  // ---------- 邮件 ----------
  smtp_enabled: { g: "email", label: "启用邮件", type: "switch", bool: true },
  smtp_host: { g: "email", label: "SMTP 服务器", type: "text", ph: "smtp.example.com" },
  smtp_port: { g: "email", label: "端口", type: "number", min: 1, max: 65535 },
  smtp_user: { g: "email", label: "账号", type: "text" },
  smtp_pass: { g: "email", label: "密码 / 授权码", type: "password" },
  smtp_from: { g: "email", label: "发件人", type: "text", ph: "OOAPI <no-reply@example.com>" },
  smtp_ssl: { g: "email", label: "使用 SSL", type: "switch", bool: true },
  smtp_starttls: { g: "email", label: "使用 STARTTLS", type: "switch", bool: true },
  smtp_insecure: { g: "email", label: "跳过证书校验", type: "switch", bool: true, hint: "仅自签证书时开启" },

  // ---------- 备份 ----------
  backup_enabled: { g: "backup", label: "启用自动备份", type: "switch", bool: true },
  backup_interval_hours: { g: "backup", label: "备份间隔（小时）", type: "number", min: 1, max: 8760 },
  backup_keep: { g: "backup", label: "保留份数", type: "number", min: 1, max: 365 },
  backup_dir: { g: "backup", label: "备份目录", type: "text", ph: "留空 = data/backups" },
};

const TABS = [
  { key: "site", label: "站点", icon: <SettingOutlined /> },
  { key: "appearance", label: "外观", icon: <BgColorsOutlined /> },
  { key: "auth", label: "认证", icon: <SafetyCertificateOutlined /> },
  { key: "billing", label: "计费", icon: <DollarOutlined /> },
  { key: "user", label: "用户", icon: <UserOutlined /> },
  { key: "security", label: "安全", icon: <LockOutlined /> },
  { key: "gateway", label: "网关", icon: <ApiOutlined /> },
  { key: "email", label: "邮件", icon: <MailOutlined /> },
  { key: "backup", label: "备份", icon: <DatabaseOutlined /> },
];

// 分区只组织布局；字段定义仍是归一化与提交白名单的唯一来源。
const SECTIONS = {
  site: [
    { title: "站点标识", fields: ["system_name", "logo", "favicon"] },
    { title: "访问地址", fields: ["server_address", "api_endpoint", "docs_link", "header_nav_links"] },
    { title: "页面内容", fields: ["about", "home_content", "footer", "login_page_notice"] },
    { title: "公告", fields: ["announcement_type", "announcement", "announcement_version"] },
    { title: "联系与支持", fields: ["contact_email", "contact_qq_group", "contact_telegram", "contact_discord"] },
    { title: "协议与备案", fields: ["legal_user_agreement", "legal_privacy_policy", "icp_number", "police_number"] },
  ],
  auth: [
    { title: "登录与注册", fields: ["password_login_enabled", "password_register_enabled", "register_email_required", "register_invite_only", "register_ip_limit"] },
    { title: "账号安全", fields: ["password_min_length", "session_days", "login_fail_lock_count", "login_fail_lock_minutes"] },
  ],
  billing: [
    { title: "平台币种", fixedCurrency: true, fields: [] },
    { title: "余额与充值", fields: ["quota_remind_threshold", "topup_link"] },
    { title: "注册与邀请奖励", fields: ["quota_for_new_user", "invite_reward_inviter", "invite_reward_invitee"] },
    { title: "签到奖励", fields: ["checkin_enabled", "checkin_min_quota", "checkin_max_quota"] },
  ],
  user: [
    { title: "用户可见数据", visibility: true, fields: ["user_data_visibility"] },
    { title: "权限与默认限额", fields: ["default_user_group", "allow_user_edit_profile", "chat_enabled", "default_user_concurrency", "default_user_rpm", "default_user_tpm"] },
    { title: "记录与看板", fields: ["log_retention_days", "data_export_enabled", "data_export_interval", "data_export_default_range"] },
  ],
  security: [
    { title: "请求限流", fields: ["rate_limit_enabled", "rate_limit_window_minutes", "rate_limit_count"] },
    { title: "敏感词过滤", fields: ["sensitive_check_enabled", "sensitive_check_on_prompt", "sensitive_words"] },
    { title: "渠道健康", fields: ["auto_disable_channel", "auto_enable_channel", "channel_disable_threshold", "auto_disable_status_codes", "auto_disable_keywords", "auto_test_channel_enabled", "auto_test_channel_minutes", "auto_test_concurrency"] },
    { title: "性能指标", fields: ["perf_metrics_enabled", "perf_metrics_retention_days"] },
  ],
  gateway: [{ title: "请求与流式响应", fields: ["request_timeout_ms", "retry_times", "gateway_ping_interval", "gateway_log_body", "gateway_empty_cooldown_seconds"] }, { title: "Agent 识别与路由", fields: ["gateway_agent_detection", "gateway_agent_rules"] }],
  email: [
    { title: "SMTP 连接", fields: ["smtp_enabled", "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from"] },
    { title: "传输安全", fields: ["smtp_ssl", "smtp_starttls", "smtp_insecure"] },
  ],
  backup: [{ title: "自动备份", fields: ["backup_enabled", "backup_interval_hours", "backup_keep", "backup_dir"] }],
};

const VISIBILITY_FIELDS = [
  { key: "balance", label: "余额", hint: "账户余额与令牌剩余预算" },
  { key: "usage_summary", label: "用量汇总", hint: "累计消耗、调用数与汇总趋势" },
  { key: "usage_records", label: "使用记录", hint: "逐次调用、最近记录与明细导出" },
  { key: "request_content", label: "请求与回复正文", hint: "使用记录中的输入、输出内容" },
  { key: "pricing", label: "定价与费率", hint: "价格表、调用单价与分组倍率" },
];

function normalizeVisibility(value, legacy = {}) {
  let parsed = value;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
  if (parsed?.version === 1 && VISIBILITY_FIELDS.every(({ key }) => typeof parsed[key] === "boolean")) {
    return { version: 1, ...Object.fromEntries(VISIBILITY_FIELDS.map(({ key }) => [key, key === "request_content" ? parsed.usage_records && parsed[key] : parsed[key]])) };
  }
  const enabled = legacy.general_setting_quota_display !== "false" && legacy.user_visible_quota_detail !== "hidden";
  const detailed = enabled && legacy.user_visible_quota_detail !== "summary";
  return { version: 1, balance: enabled, usage_summary: enabled, usage_records: detailed, request_content: detailed, pricing: legacy.expose_pricing_to_user !== "false" };
}

const BOOL_KEYS = Object.entries(F).filter(([, v]) => v.bool).map(([k]) => k);

// 兼容尚未下发权限元信息的旧后端：基础设施字段仍须先置灰，不能让管理员填完才吃 403。
const SUPER_OPTION_FALLBACK = [
  "smtp_enabled", "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from",
  "smtp_ssl", "smtp_starttls", "smtp_insecure",
  "request_timeout_ms", "retry_times", "gateway_ping_interval",
  "gateway_agent_detection", "gateway_agent_rules", "gateway_empty_cooldown_seconds",
  "backup_enabled", "backup_interval_hours", "backup_keep", "backup_dir",
];

// 控件会把未设置的文本显示为空串、数字显示为空值；比较相同的显示语义，
// 避免仅聚焦/清空空字段就误报修改。结构化设置按值比较，不依赖对象引用。
function settingValue(name, value) {
  const spec = F[name];
  if (spec.type === "visibility") return normalizeVisibility(value);
  if (spec.type === "agent-rules") return routingValue(value);
  if (spec.bool) return Boolean(value);
  if (spec.type === "number") return value == null || value === "" ? "" : Number(value);
  return String(value ?? "");
}

function sameSettingValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameSettingValue(a[key], b[key]));
}

function useSettingsForm() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState({ kind: "", text: "" });
  const [savedValues, setSavedValues] = useState(null);
  const [superOnly, setSuperOnly] = useState([]);
  const { message } = ArcApp.useApp();
  const { refreshStatus, user, status } = useApp();

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await API.get("/option/");
      const { super_only, is_super, ...values } = data || {};
      setSuperOnly(Array.isArray(super_only) ? super_only : Number(user?.role) >= 1000 ? [] : SUPER_OPTION_FALLBACK);
      const norm = { ...values };
      norm.gateway_agent_rules = routingValue(values.gateway_agent_rules ?? { version: 1, rules: [] });
      norm.user_data_visibility = normalizeVisibility(values.user_data_visibility, values);
      // 布尔归一化：库里存的是 "true"/"false" 字符串，Switch 需要真布尔
      for (const k of BOOL_KEYS) norm[k] = values[k] === "true" || values[k] === true;
      // 数值项归一化：空串→undefined，避免 InputNumber 显示 0（与实际「未设置」不符）
      for (const [k, spec] of Object.entries(F)) {
        if (spec.type !== "number") continue;
        const v = values[k];
        norm[k] = v === "" || v === null || v === undefined ? undefined : spec.od ? odOf(v, unitsPerOd(status)) : Number(v);
      }
      form.setFieldsValue(norm);
      // Keep a clean snapshot for the Arc settings discard action.  The form
      // adapter intentionally separates current values from its initial
      // values, so loading must update both snapshots together.
      form.initialize(norm);
      setSavedValues(norm);
      setSaveState({ kind: "", text: "" });
    } catch (e) {
      setError(e.message || "无法加载设置");
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  const save = async (values) => {
    setSaving(true);
    setSaveState({ kind: "", text: "" });
    try {
      const payload = {};
      for (const [k, v] of Object.entries(values)) {
        if (!Object.prototype.hasOwnProperty.call(F, k)) continue;
        // 禁用的字段仍可能在 Form 的值里；必须从提交体排除，避免整批保存被 403 拒绝。
        if (superOnly.includes(k)) continue;
        // 固定值不提交（units_per_od 由计费代码写死；后端也拒绝修改）
        if (["units_per_od", "currency_name", "currency_symbol"].includes(k)) continue;
        if (k === "user_data_visibility") {
          payload[k] = normalizeVisibility(v);
          continue;
        }
        if (k === "gateway_agent_rules") { payload[k] = v; continue; }
        if (F[k].od && (v === undefined || v === null || v === "")) {
          message.error(`请填写${F[k].label}；无额度请填 0`);
          return;
        }
        // null/空串是「清空」的语义：必须提交空串把库里的旧值清掉。
        // 历史 bug：跳过空值 → 管理员清空公告保存后旧公告还在。
        if (v === undefined || v === null) {
          payload[k] = "";
          continue;
        }
        // 此字段以 OD币输入，接口仍接收整数额度单位；四位小数对应最小一单位。
        payload[k] = F[k].od ? String(Math.round(Number(v) * unitsPerOd(status))) : String(v);
      }
      if (!Object.keys(payload).length) {
        message.info("当前账号没有可修改的设置项");
        return;
      }
      await API.put("/option/", payload);
      // 改站点名/外观默认值后必须刷新全局 status，否则全站展示仍用旧值
      await refreshStatus();
      // 下次放弃修改须回到本次保存值，而不是页面第一次加载的旧值。
      form.initialize(values);
      setSavedValues(values);
      setSaveState({ kind: "saved", text: "已保存" });
      message.success("设置已保存");
      return true;
    } catch (e) {
      setSaveState({ kind: "error", text: e.message || "保存失败，请重试" });
      message.error(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { form, loading, saving, error, superOnly, savedValues, saveState, setSaveState, load, save };
}

function Field({ spec, name, locked = false, ...controlProps }) {
  const disabled = Boolean(spec.disabled || locked || controlProps.disabled);
  // Form.Item 把 value/checked/onChange 注入自定义 Field；必须继续传给实际控件，
  // 否则用户改的是控件内部值，提交的仍是加载时的旧设置。
  const common = { ...controlProps, placeholder: spec.ph, disabled };
  if (spec.type === "image") return <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><BrandLogo src={controlProps.value} size={36} style={{ borderRadius: 7, padding: 3, background: 'var(--field)' }}/><Input {...common} /></div>;
  if (spec.type === "visibility") return <VisibilityFields {...controlProps} disabled={disabled} />;
  if (spec.type === "agent-rules") return <AgentRoutingSettings {...controlProps} disabled={disabled} />;
  if (spec.type === "switch") return <Switch {...controlProps} disabled={disabled} />;
  if (spec.type === "number") {
    return <InputNumber {...controlProps} style={{ width: "100%" }} min={spec.min} max={spec.max} step={spec.step || 1} precision={spec.precision} disabled={disabled} />;
  }
  if (spec.type === "select") return <Select {...controlProps} style={{ width: "100%" }} options={spec.options} allowClear={false} disabled={disabled} />;
  if (spec.type === "password") return <Input.Password {...common} autoComplete="new-password" />;
  if (spec.type === "textarea") return <Input.TextArea rows={spec.rows || 3} {...common} />;
  return <Input {...common} maxLength={spec.maxLength} />;
}

function VisibilityFields({ value, onChange, disabled }) {
  const visibility = normalizeVisibility(value);
  return <div className="oo-admin-visibility">
    <div className="oo-admin-settings-note">仅限制普通用户，管理员始终可查看。</div>
    {VISIBILITY_FIELDS.map(({ key, label, hint }) => <div className="oo-admin-visibility-row" key={key}>
      <div><label htmlFor={`visibility-${key}`}>{label}</label><span>{hint}</span></div>
      <Switch id={`visibility-${key}`} aria-label={label} checked={visibility[key]} disabled={disabled || key === "request_content" && !visibility.usage_records} onChange={(checked) => {
        const next = { ...visibility, [key]: checked };
        if (key === "usage_records" && !checked) next.request_content = false;
        onChange?.(next);
      }} />
    </div>)}
  </div>;
}

function SettingsField({ name, spec, locked, busy }) {
  const inputId = `system-setting-${name}`;
  const isSwitch = spec.type === "switch";
  const hint = spec.type === "password" ? "保持原值可保留凭据；清空后保存会删除。" : spec.hint;
  return <div className={`oo-admin-setting-row oo-admin-setting-row--${spec.type}`}>
    <div className="oo-admin-setting-label"><label htmlFor={inputId}>{spec.label}</label>{locked ? <Tooltip title="仅超级管理员可修改"><LockOutlined aria-label="仅超级管理员可修改" /></Tooltip> : null}</div>
    <Form.Item name={name} className="oo-admin-setting-control" valuePropName={isSwitch ? "checked" : "value"} extra={isSwitch ? undefined : hint} rules={spec.od ? [{ required: true, message: "请填写额度，无额度请填 0" }] : undefined}>
      <Field id={inputId} aria-label={spec.label} spec={spec} name={name} locked={locked} disabled={busy} />
    </Form.Item>
    {/* 开关说明占整行，不能撑宽右侧控件列而把左侧标题挤成竖排。 */}
    {isSwitch && hint ? <div className="oo-admin-setting-hint oo-admin-settings-note">{hint}</div> : null}
  </div>;
}

function SettingsTab({ group }) {
  const s = useSettingsForm();
  const tabRef = useRef(null);
  const [actionPosition, setActionPosition] = useState({ left: "50%", maxWidth: "calc(100vw - 32px)" });
  const reducedMotion = useReducedMotion();
  const formVersion = useSyncExternalStore(s.form.subscribe, s.form.snapshot);
  useEffect(() => {
    s.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fields = useMemo(() => Object.entries(F).filter(([, v]) => v.g === group), [group]);
  const sections = SECTIONS[group] || [];
  const changedCount = useMemo(() => {
    if (!s.savedValues) return 0;
    return fields.filter(([key, spec]) => !s.superOnly.includes(key) && !spec.disabled && !sameSettingValue(settingValue(key, s.form.getFieldValue(key)), settingValue(key, s.savedValues[key]))).length;
  }, [fields, s.form, s.savedValues, s.superOnly, formVersion]);
  const label = TABS.find((item) => item.key === group)?.label;
  useEffect(() => {
    const tab = tabRef.current;
    if (!tab) return undefined;
    const alignActions = () => {
      const { left, width } = tab.getBoundingClientRect();
      setActionPosition({ left: left + width / 2, maxWidth: Math.max(0, width - 24) });
    };
    alignActions();
    // 居中跟随内容区，侧栏折叠或窄屏切换时也不会偏向整个浏览器中央。
    const observer = new ResizeObserver(alignActions);
    observer.observe(tab);
    window.addEventListener("resize", alignActions);
    return () => { observer.disconnect(); window.removeEventListener("resize", alignActions); };
  }, []);
  const finish = async (values) => {
    if (changedCount) await s.save(values);
  };
  const discard = () => {
    s.form.resetFields();
    s.setSaveState({ kind: "", text: "" });
  };
  return (
    <div className={`oo-admin-settings-tab${changedCount > 0 ? " oo-admin-settings-tab--has-unsaved" : ""}`} ref={tabRef}>
      {s.error ? (
        <Alert
          type="error"
          showIcon
          message="设置加载失败"
          description={s.error}
          action={<Button size="small" onClick={s.load} loading={s.loading}>重试</Button>}
          className="oo-admin-settings-load-error"
        />
      ) : null}
        <Spin spinning={s.loading}>
          <Form
            form={s.form}
            className="oo-admin-settings-form"
            layout="vertical"
            onFinish={finish}
            onValuesChange={() => s.setSaveState({ kind: "", text: "" })}
            disabled={s.loading || Boolean(s.error) || s.saving}
            requiredMark={false}
          >
            {sections.map((section) => <Card title={section.title} className="oo-admin-settings-section" key={section.title}>
              <div className="oo-admin-settings-section-body">
                {section.fixedCurrency ? <div className="oo-admin-fixed-currency"><OdCoin size={36} /><div><strong>OD币</strong></div></div> : null}
                {section.visibility ? <Form.Item name="user_data_visibility" className="oo-admin-visibility-field"><Field spec={F.user_data_visibility} name="user_data_visibility" locked={s.superOnly.includes("user_data_visibility")} disabled={s.loading || Boolean(s.error) || s.saving} /></Form.Item> : section.fields.map((key) => <SettingsField key={key} name={key} spec={F[key]} locked={s.superOnly.includes(key)} busy={s.loading || Boolean(s.error) || s.saving} />)}
              </div>
            </Card>)}
            <AnimatePresence initial={false}>
              {changedCount > 0 && !s.loading && !s.error ? <motion.div
                key="unsaved-settings"
                className="oo-admin-settings-actions"
                style={{ ...actionPosition, x: "-50%" }}
                initial={{ opacity: 0, y: reducedMotion ? 0 : 20, scale: reducedMotion ? 1 : 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: reducedMotion ? 0 : 14, scale: reducedMotion ? 1 : 0.96 }}
                transition={reducedMotion ? { duration: 0.1 } : { type: "spring", stiffness: 420, damping: 26, mass: 0.7 }}
              >
                <div className={`oo-admin-settings-save-state${s.saveState.kind === "error" ? " oo-admin-settings-save-state--error" : ""}`} role="status" aria-live="polite">
                  {s.saveState.kind === "error" ? s.saveState.text : `${changedCount} 项修改未保存`}
                </div>
                <div className="oo-admin-settings-action-buttons">
                  <Button type="text" size="small" onClick={discard} disabled={s.saving}>放弃修改</Button>
                  <Button type="primary" size="small" htmlType="submit" aria-label={`保存${label}设置`} loading={s.saving}>
                    保存修改
                  </Button>
                </div>
              </motion.div> : null}
            </AnimatePresence>
          </Form>
        </Spin>
    </div>
  );
}

/* ============================ 在线更新 ============================ */
function UpdateTab() {
  const { message, modal } = ArcApp.useApp();
  const { user } = useApp();
  const isSuper = Number(user?.role) >= 1000;
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [steps, setSteps] = useState([]);
  const [error, setError] = useState("");
  const timerRef = useRef(null);
  const cancelPollRef = useRef(null);

  const check = async () => {
    setChecking(true);
    setError("");
    try {
      const r = await API.get("/update/check", { timeoutMs: 60_000 });
      setInfo(r);
    } catch (e) {
      setError(e.message);
      message.error(e.message);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    check();
    return () => {
      cancelPollRef.current?.();
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = info?.current || info?.local;
  const latest = info?.latest || info?.remote;
  const hasUpdate = Boolean(
    info?.hasUpdate !== undefined
      ? info.hasUpdate
      : info?.upToDate !== undefined
        ? !info.upToDate
        : false
  );

  const poll = (targetCommit) => {
    cancelPollRef.current?.();
    let attempts = 0;
    let inFlight = false;
    let finished = false;
    let timerId = null;
    const stop = () => {
      finished = true;
      clearInterval(timerId);
      if (timerRef.current === timerId) timerRef.current = null;
      if (cancelPollRef.current === stop) cancelPollRef.current = null;
    };
    const timeout = () => {
      if (finished || attempts < 40) return;
      stop();
      setApplying(false);
      setError("尚未确认更新完成，请刷新检查版本");
    };
    timerId = setInterval(async () => {
      // 状态请求可能跨过多个轮询间隔；完成或离开页面后忽略迟到响应。
      if (finished || inFlight) return;
      inFlight = true;
      attempts++;
      try {
        const r = await API.get("/update/status", { timeoutMs: 15_000 });
        if (finished) return;
        const currentCommit = r?.stamp?.commit;
        if ((targetCommit && currentCommit === targetCommit) || r?.done === true) {
          stop();
          setApplying(false);
          message.success("更新完成，服务已就绪");
          await check();
        } else timeout();
      } catch {
        // 更新期间服务会重启，轮询失败是正常的：继续等
        timeout();
      } finally {
        inFlight = false;
      }
    }, 3000);
    timerRef.current = timerId;
    cancelPollRef.current = stop;
  };

  const apply = async () => {
    if (!isSuper || applying) return;
    modal.confirm({
      title: "确认更新到最新版本？",
      content: `即将更新到版本 ${latest?.short || ""}：${latest?.message || ""}。更新将拉取 GitHub 最新代码、重新构建并热重启服务。`,
      okText: "立即更新",
      cancelText: "取消",
      onOk: async () => {
        setApplying(true);
        setError("");
        setSteps([]);
        try {
          const res = await API.post("/update/apply", undefined, { timeoutMs: 300_000 });
          if (Array.isArray(res?.steps)) {
            setSteps(res.steps);
          }
          poll(latest?.commit);
        } catch (e) {
          setApplying(false);
          message.error(e.message);
        }
      },
    });
  };

  return (
    <ArcPanel className="oo-panel oo-admin-update">
      <div className="oo-panel-body">
        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
          <div className="oo-admin-update-version">
            <span>当前版本</span><div><Text code>{current?.short || "—"}</Text>
            {current?.message ? <span style={{ color: "var(--ink-3)" }}> · {current.message}</span> : null}</div>
          </div>
          <div className="oo-admin-update-version">
            <span>最新版本</span><div><Text code>{latest?.short || "—"}</Text>
            {latest?.message ? <span style={{ color: "var(--ink-3)" }}> · {latest.message}</span> : null}</div>
          </div>
          {info && !hasUpdate ? (
            <Alert type="success" showIcon message="已是最新版本" />
          ) : null}
          {info && hasUpdate ? (
            <Alert
              type="info"
              showIcon
              message={`发现新版本：${latest?.short || ""}`}
              description={latest?.message || undefined}
            />
          ) : null}
          <div className="oo-admin-update-actions">
            <Button onClick={check} loading={checking}>检查更新</Button>
            <Button type="primary" onClick={apply} loading={applying} disabled={!hasUpdate || !isSuper}>
              立即更新
            </Button>
            {!isSuper ? <Text type="secondary">只有超级管理员可以执行更新</Text> : null}
          </div>
          {steps.length ? (
            <div className="oo-admin-update-steps">
              {steps.map((s, i) => (
                <div key={i}>{s}</div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </ArcPanel>
  );
}

export default function AdminSettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab");
  const activeKey = [...TABS.map(({ key }) => key), "update"].includes(tab) ? tab : "site";
  return (
    <div className="oo-page oo-admin-settings-page">
      <PageHeader title="系统设置" />
      <Tabs
        activeKey={activeKey}
        onChange={(key) => { const next = new URLSearchParams(searchParams); next.set("tab", key); setSearchParams(next, { replace: true }); }}
        destroyInactiveTabPane
        items={[
          ...TABS.map((t) => ({
            key: t.key,
            label: (
              <span>
                {t.icon} {t.label}
              </span>
            ),
            children: t.key === "appearance" ? <AppearanceSettings /> : <SettingsTab group={t.key} />,
          })),
          {
            key: "update",
            label: (
              <span>
                <CloudDownloadOutlined /> 更新
              </span>
            ),
            children: <UpdateTab />,
          },
        ]}
      />
    </div>
  );
}
