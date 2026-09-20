// 系统设置 —— 配置驱动
// ---------------------------------------------------------------------------
// 为什么改成配置驱动（原先是 5 个手写 Tab 组件）：设置项已经增长到 90+，
// 每加一项都要同时改「表单 JSX + 布尔归一化列表 + 数值范围校验」三处，
// 必然漏改（历史上就出现过「清空公告保存不掉」「布尔项被写成字符串 false」）。
// 现在全站设置项的字段定义只写一遍，三处自动一致。
//
// 分组：站点 / 外观 / 认证 / 计费 / 用户 / 安全 / 网关 / 邮件 / 备份（+ 更新）
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Form, Input, Button, Switch, InputNumber, App as AntApp, Tabs, Typography, Alert, Spin, Select,
} from "antd";
import {
  SettingOutlined, DollarOutlined, SafetyCertificateOutlined, SaveOutlined, CloudDownloadOutlined,
  BgColorsOutlined, TeamOutlined, LockOutlined, ApiOutlined, MailOutlined, DatabaseOutlined, UserOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import PageHeader from "../components/PageHeader";
import { PRIMARY_PRESETS } from "../theme/presets";

const { Text } = Typography;

// ---------------------------------------------------------------------------
// 字段定义：type 决定控件，bool:true 的项保存时会归一化成 "true"/"false"
// ---------------------------------------------------------------------------
const F = {
  // ---------- 站点 ----------
  system_name: { g: "site", label: "系统名称", type: "text", ph: "OOAPI" },
  logo: { g: "site", label: "Logo 地址", type: "text", ph: "/logo.jpg" },
  favicon: { g: "site", label: "站点图标", type: "text", ph: "留空则复用 Logo" },
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

  // ---------- 外观 ----------
  default_theme: {
    g: "appearance", label: "默认明暗模式", type: "select",
    options: [
      { value: "system", label: "跟随系统" },
      { value: "light", label: "浅色" },
      { value: "dark", label: "深色" },
    ],
  },
  default_primary: {
    g: "appearance", label: "默认主题色", type: "select",
    options: PRIMARY_PRESETS.map((p) => ({ value: p.key, label: p.label })),
  },
  default_collapse_sidebar: { g: "appearance", label: "默认折叠侧边栏", type: "switch", bool: true },
  enable_theme_switch: { g: "appearance", label: "允许用户切换明暗", type: "switch", bool: true },
  enable_primary_switch: { g: "appearance", label: "允许用户切换主题色", type: "switch", bool: true },
  home_show_models: { g: "appearance", label: "首页展示模型列表", type: "switch", bool: true },
  home_show_pricing: { g: "appearance", label: "首页展示定价入口", type: "switch", bool: true },

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
  currency_name: { g: "billing", label: "货币名称", type: "text" },
  currency_symbol: { g: "billing", label: "货币符号", type: "text" },
  units_per_od: { g: "billing", label: "额度换算", type: "number", disabled: true, hint: "固定 1 OD币 = 10,000 额度单位（计费代码写死）" },
  general_setting_quota_display: { g: "billing", label: "前台展示额度", type: "switch", bool: true },
  expose_pricing_to_user: { g: "billing", label: "允许用户查看定价", type: "switch", bool: true },
  quota_for_new_user: { g: "billing", label: "新用户初始额度", type: "number", min: 0, step: 100000, hint: "单位：额度（10,000 = 1 OD币）" },
  quota_remind_threshold: { g: "billing", label: "余额提醒阈值", type: "number", min: 0, hint: "低于该值前端提示" },
  topup_link: { g: "billing", label: "充值链接", type: "text" },
  invite_reward_inviter: { g: "billing", label: "邀请人奖励", type: "number", min: 0 },
  invite_reward_invitee: { g: "billing", label: "被邀请人奖励", type: "number", min: 0 },
  checkin_enabled: { g: "billing", label: "启用签到", type: "switch", bool: true },
  checkin_min_quota: { g: "billing", label: "签到最小奖励", type: "number", min: 0 },
  checkin_max_quota: { g: "billing", label: "签到最大奖励", type: "number", min: 0 },

  // ---------- 用户 ----------
  default_user_group: { g: "user", label: "新用户默认分组", type: "text", ph: "留空 = 公共池" },
  user_visible_quota_detail: {
    g: "user", label: "用户可见额度粒度", type: "select",
    options: [
      { value: "full", label: "完整（余额 + 明细）" },
      { value: "summary", label: "仅余额" },
      { value: "hidden", label: "不显示" },
    ],
  },
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
  auto_test_channel_enabled: { g: "security", label: "定时检测渠道", type: "switch", bool: true, hint: "总闸（每渠道的开关是子开关）" },
  auto_test_channel_minutes: { g: "security", label: "检测间隔（分钟）", type: "number", min: 1, max: 1440 },
  auto_test_concurrency: { g: "security", label: "检测并发", type: "number", min: 1, max: 32 },
  perf_metrics_enabled: { g: "security", label: "性能指标采集", type: "switch", bool: true },
  perf_metrics_retention_days: { g: "security", label: "指标保留天数", type: "number", min: 0, hint: "0 = 永久" },

  // ---------- 网关 ----------
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

const BOOL_KEYS = Object.entries(F).filter(([, v]) => v.bool).map(([k]) => k);

function useSettingsForm() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { message } = AntApp.useApp();
  const { refreshStatus } = useApp();

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await API.get("/option/");
      const norm = { ...data };
      // 布尔归一化：库里存的是 "true"/"false" 字符串，Switch 需要真布尔
      for (const k of BOOL_KEYS) norm[k] = data[k] === "true" || data[k] === true;
      // 数值项归一化：空串→undefined，避免 InputNumber 显示 0（与实际「未设置」不符）
      for (const [k, spec] of Object.entries(F)) {
        if (spec.type !== "number") continue;
        const v = data[k];
        norm[k] = v === "" || v === null || v === undefined ? undefined : Number(v);
      }
      form.setFieldsValue(norm);
    } catch (e) {
      setError(e.message || "无法加载设置");
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  const save = async (values) => {
    setSaving(true);
    try {
      const payload = {};
      for (const [k, v] of Object.entries(values)) {
        if (!Object.prototype.hasOwnProperty.call(F, k)) continue;
        // 固定值不提交（units_per_od 由计费代码写死；后端也拒绝修改）
        if (k === "units_per_od") continue;
        // null/空串是「清空」的语义：必须提交空串把库里的旧值清掉。
        // 历史 bug：跳过空值 → 管理员清空公告保存后旧公告还在。
        if (v === undefined || v === null) {
          payload[k] = "";
          continue;
        }
        payload[k] = typeof v === "boolean" ? String(v) : String(v);
      }
      await API.put("/option/", payload);
      // 改站点名/外观默认值后必须刷新全局 status，否则全站展示仍用旧值
      await refreshStatus();
      message.success("设置已保存");
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return { form, loading, saving, error, load, save };
}

function Field({ spec, name }) {
  const common = { placeholder: spec.ph, disabled: spec.disabled };
  if (spec.type === "switch") return <Switch />;
  if (spec.type === "number") {
    return <InputNumber style={{ width: "100%" }} min={spec.min} max={spec.max} step={spec.step || 1} disabled={spec.disabled} />;
  }
  if (spec.type === "select") return <Select style={{ width: "100%" }} options={spec.options} allowClear={false} />;
  if (spec.type === "password") return <Input.Password {...common} autoComplete="new-password" />;
  if (spec.type === "textarea") return <Input.TextArea rows={spec.rows || 3} {...common} />;
  return <Input {...common} maxLength={spec.maxLength} />;
}

function SettingsTab({ group }) {
  const s = useSettingsForm();
  useEffect(() => {
    s.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fields = useMemo(() => Object.entries(F).filter(([, v]) => v.g === group), [group]);
  return (
    <div className="oo-panel" style={{ maxWidth: 760, opacity: s.loading || s.error ? 0.72 : 1 }}>
      <style>{`
        .oo-settings-form {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          column-gap: 18px;
          row-gap: 0;
        }
        .oo-settings-form .oo-settings-field {
          min-width: 0;
          margin-bottom: 12px;
        }
        .oo-settings-form .oo-settings-field--wide,
        .oo-settings-form .oo-settings-actions {
          grid-column: 1 / -1;
        }
        .oo-settings-form .oo-settings-field .ant-form-item-label {
          padding-bottom: 4px;
        }
        .oo-settings-form .oo-settings-field .ant-form-item-control-input {
          min-height: 32px;
        }
        .oo-settings-form .oo-settings-actions {
          margin-top: 2px;
        }
        @media (max-width: 640px) {
          .oo-settings-form {
            grid-template-columns: minmax(0, 1fr);
            column-gap: 0;
          }
          .oo-settings-form .oo-settings-field--wide,
          .oo-settings-form .oo-settings-actions {
            grid-column: auto;
          }
        }
      `}</style>
      {s.error ? (
        <Alert
          type="error"
          showIcon
          message="设置加载失败"
          description={s.error}
          action={<Button size="small" onClick={s.load} loading={s.loading}>重试</Button>}
          style={{ margin: "16px 24px" }}
        />
      ) : null}
      <div className="oo-panel-body">
        <Spin spinning={s.loading}>
          <Form
            form={s.form}
            className="oo-settings-form"
            layout="vertical"
            onFinish={s.save}
            disabled={s.loading || Boolean(s.error)}
            requiredMark={false}
          >
            {fields.map(([key, spec]) => (
              <Form.Item
                key={key}
                className={`oo-settings-field${spec.type === "textarea" ? " oo-settings-field--wide" : ""}`}
                name={key}
                label={spec.label}
                valuePropName={spec.type === "switch" ? "checked" : "value"}
              >
                <Field spec={spec} name={key} />
              </Form.Item>
            ))}
            <div className="oo-settings-actions">
              <Button type="primary" htmlType="submit" loading={s.saving} icon={<SaveOutlined />}>
                保存设置
              </Button>
            </div>
          </Form>
        </Spin>
      </div>
    </div>
  );
}

/* ============================ 在线更新 ============================ */
function UpdateTab() {
  const { message, modal } = AntApp.useApp();
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [steps, setSteps] = useState([]);
  const [error, setError] = useState("");
  const timerRef = useRef(null);

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
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const poll = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(async () => {
      try {
        const r = await API.get("/update/status", { timeoutMs: 15_000 });
        setSteps(Array.isArray(r?.steps) ? r.steps : []);
        if (r?.done) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          setApplying(false);
          message.success("更新完成");
          await check();
        }
      } catch {
        // 更新期间服务会重启，轮询失败是正常的：继续等
      }
    }, 3000);
  };

  const apply = async () => {
    modal.confirm({
      title: "确认更新到最新版本？",
      content: "会拉取 GitHub 最新代码、重建前端并重启服务。更新前会自动备份当前源码。",
      okText: "立即更新",
      cancelText: "取消",
      onOk: async () => {
        setApplying(true);
        setSteps([]);
        try {
          await API.post("/update/apply", undefined, { timeoutMs: 30_000 });
          poll();
        } catch (e) {
          setApplying(false);
          message.error(e.message);
        }
      },
    });
  };

  return (
    <div className="oo-panel" style={{ maxWidth: 760 }}>
      <div className="oo-panel-body">
        {error ? (
          <Alert type="error" showIcon message="检查更新失败" description={error} style={{ marginBottom: 12 }} />
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
          <div>
            当前版本：<Text code>{info?.current?.short || "—"}</Text>
            {info?.current?.message ? <span style={{ color: "var(--ink-3)" }}> · {info.current.message}</span> : null}
          </div>
          <div>
            最新版本：<Text code>{info?.latest?.short || "—"}</Text>
            {info?.latest?.message ? <span style={{ color: "var(--ink-3)" }}> · {info.latest.message}</span> : null}
          </div>
          {info && !info.hasUpdate ? (
            <Alert type="success" showIcon message="已是最新版本" />
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={check} loading={checking}>检查更新</Button>
            <Button type="primary" onClick={apply} loading={applying} disabled={!info?.hasUpdate}>
              立即更新
            </Button>
          </div>
          {steps.length ? (
            <div style={{ marginTop: 8 }}>
              {steps.map((s, i) => (
                <div key={i} style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{s}</div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function AdminSettingsPage() {
  return (
    <div className="oo-page">
      <PageHeader title="系统设置" />
      <Tabs
        destroyInactiveTabPane
        items={[
          ...TABS.map((t) => ({
            key: t.key,
            label: (
              <span>
                {t.icon} {t.label}
              </span>
            ),
            children: <SettingsTab group={t.key} />,
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
