import React, { useEffect, useRef, useState } from "react";
import {
  Form, Input, Button, Switch, InputNumber, App as AntApp, Tabs, Typography,
} from "antd";
import {
  SettingOutlined, DollarOutlined, SafetyCertificateOutlined, ApiOutlined, SaveOutlined, CloudDownloadOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import PageHeader from "../components/PageHeader";

const { Text } = Typography;

// 统一设置面板：标题 + 说明 + 表单 + 保存按钮
function SettingsPanel({ title, desc, children, form, onFinish, loading, saving }) {
  return (
    <div className="oo-panel" style={{ maxWidth: 720, opacity: loading ? 0.6 : 1 }}>
      <div className="oo-panel-head">
        <div>
          <div className="oo-panel-title">{title}</div>
          {desc ? (
            <div style={{ fontSize: 12, color: "var(--oo-text-muted)", marginTop: 2 }}>{desc}</div>
          ) : null}
        </div>
      </div>
      <div className="oo-panel-body">
        <Form form={form} layout="vertical" onFinish={onFinish} disabled={loading} requiredMark={false}>
          {children}
          <Button type="primary" htmlType="submit" loading={saving} icon={<SaveOutlined />} style={{ marginTop: 4 }}>
            保存设置
          </Button>
        </Form>
      </div>
    </div>
  );
}

function useSettingsForm() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { message } = AntApp.useApp();
  const { refreshStatus } = useApp();

  const load = async () => {
    try {
      const data = await API.get("/option/");
      const norm = { ...data };
      for (const k of ["password_register_enabled", "password_login_enabled", "general_setting_quota_display", "ds_enabled"]) {
        norm[k] = data[k] === "true" || data[k] === true;
      }
      form.setFieldsValue(norm);
    } catch (e) {
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
        if (v === undefined) continue;
        payload[k] = typeof v === "boolean" ? String(v) : String(v);
      }
      await API.put("/option/", payload);
      // 改站点名/汇率/额度换算后必须刷新全局 status，否则全站展示仍用旧值
      await refreshStatus();
      message.success("设置已保存");
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return { form, loading, saving, load, save };
}

function GeneralTab() {
  const s = useSettingsForm();
  useEffect(() => {
    s.load();
  }, []);
  return (
    <SettingsPanel
      title="站点信息"
      desc="影响首页、登录页与浏览器标签的展示"
      form={s.form}
      onFinish={s.save}
      loading={s.loading}
      saving={s.saving}
    >
      <Form.Item name="system_name" label="系统名称">
        <Input placeholder="OOAPI" />
      </Form.Item>
      <Form.Item name="logo" label="Logo 地址" extra="建议使用正方形图片">
        <Input placeholder="/logo.jpg" />
      </Form.Item>
      <Form.Item name="server_address" label="服务器地址" extra="用于拼接展示接口地址，如 https://api.example.com">
        <Input placeholder="https://..." />
      </Form.Item>
      <Form.Item name="about" label="站点简介">
        <Input.TextArea rows={3} placeholder="显示在首页与登录页" />
      </Form.Item>
      <Form.Item name="announcement" label="公告" extra="留空则不显示">
        <Input.TextArea rows={2} />
      </Form.Item>
      <Form.Item name="footer" label="页脚文案">
        <Input.TextArea rows={2} />
      </Form.Item>
      <Form.Item name="log_retention_days" label="日志保留天数" extra="0 = 永久保留；大于 0 时每 6 小时自动清理过期日志">
        <InputNumber style={{ width: "100%" }} min={0} step={30} />
      </Form.Item>
    </SettingsPanel>
  );
}

function AuthTab() {
  const s = useSettingsForm();
  useEffect(() => {
    s.load();
  }, []);
  return (
    <SettingsPanel
      title="认证与注册"
      desc="控制用户如何登录与注册"
      form={s.form}
      onFinish={s.save}
      loading={s.loading}
      saving={s.saving}
    >
      <Form.Item
        name="password_register_enabled"
        label="允许新用户注册"
        valuePropName="checked"
        extra="关闭后注册页将显示为不可用状态"
      >
        <Switch />
      </Form.Item>
      <Form.Item name="password_login_enabled" label="允许密码登录" valuePropName="checked">
        <Switch />
      </Form.Item>
    </SettingsPanel>
  );
}

function QuotaTab() {
  const s = useSettingsForm();
  useEffect(() => {
    s.load();
  }, []);
  return (
    <SettingsPanel
      title="额度与计费"
      desc="决定额度换算比例与新用户初始额度"
      form={s.form}
      onFinish={s.save}
      loading={s.loading}
      saving={s.saving}
    >
      <Form.Item
        name="units_per_od"
        label="额度换算"
        extra="多少额度单位等于 1 OD币，默认 10,000；计费与展示均以此为准"
      >
        <InputNumber style={{ width: "100%" }} min={1} step={1000} />
      </Form.Item>
      <Form.Item name="quota_for_new_user" label="新用户初始额度" extra="注册时自动赠送（单位：额度，10,000 单位 = 1 OD币 = $1）">
        <InputNumber style={{ width: "100%" }} min={0} step={100000} />
      </Form.Item>
      <Form.Item name="general_setting_quota_display" label="前台展示额度" valuePropName="checked">
        <Switch />
      </Form.Item>
    </SettingsPanel>
  );
}

function ModelsTab() {
  const s = useSettingsForm();
  useEffect(() => {
    s.load();
  }, []);
  return (
    <SettingsPanel
      title="模型列表"
      desc="用于令牌的模型白名单下拉选项"
      form={s.form}
      onFinish={s.save}
      loading={s.loading}
      saving={s.saving}
    >
      <Form.Item name="model_list" label="可用模型" extra="多个模型用英文逗号分隔">
        <Input.TextArea rows={5} placeholder="deepseek-chat,deepseek-reasoner,deepseek-vision" />
      </Form.Item>
      <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: -6, marginBottom: 12 }}>
        提示：DeepSeek 通道支持的模型名可包含 vision（看图）、reasoner（深度思考）、search（联网）关键词。
      </Text>
    </SettingsPanel>
  );
}

/* ============================ 在线更新 ============================ */
function UpdateTab() {
  const { message, modal } = AntApp.useApp();
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [steps, setSteps] = useState([]);
  const [stamp, setStamp] = useState(null);
  const timersRef = useRef([]);

  useEffect(() => {
    return () => {
      for (const t of timersRef.current) {
        clearInterval(t);
        clearTimeout(t);
      }
    };
  }, []);

  const loadStamp = async () => {
    try {
      const r = await API.get("/update/status");
      setStamp(r?.stamp || null);
    } catch {
      /* 忽略 */
    }
  };

  useEffect(() => {
    loadStamp();
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      const r = await API.get("/update/check");
      setInfo(r);
      if (r.upToDate) message.success("已是最新版本");
      else if (!r.local?.commit) message.info(`发现远端版本 ${r.remote.short}（本地无版本记录，首次更新）`);
      else message.info(`发现新版本：${r.changedCount} 个文件有变化`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setChecking(false);
    }
  };

  const doApply = async () => {
    setApplying(true);
    setSteps([]);
    try {
      const r = await API.post("/update/apply");
      setSteps(r?.steps || []);
      message.success("更新完成，服务正在重启…");
      // 重启期间后端会短暂不可用，轮询等它回来
      let tries = 0;
      const timer = setInterval(async () => {
        tries++;
        try {
          await API.get("/status");
          clearInterval(timer);
          await loadStamp();
          message.success("服务已重启完成，请刷新页面");
        } catch {
          if (tries > 30) clearInterval(timer);
        }
      }, 2000);
      timersRef.current.push(timer);
    } catch (e) {
      // 重启可能中断本次响应，属正常情况
      message.warning(`更新已提交：${e.message}`);
      timersRef.current.push(setTimeout(loadStamp, 8000));
    } finally {
      setApplying(false);
    }
  };

  const apply = () => {
    modal.confirm({
      title: "确认更新到最新版本？",
      width: 520,
      content: (
        <div style={{ fontSize: 13 }}>
          <p style={{ marginBottom: 8 }}>更新过程会：</p>
          <ol style={{ paddingLeft: 18, marginBottom: 10, lineHeight: 1.9 }}>
            <li>拉取 GitHub 最新源码</li>
            <li>备份当前源码（可回滚）</li>
            <li>覆盖后端与前端源码</li>
            <li>安装依赖、构建前端、执行数据库迁移</li>
            <li>重启服务（期间约 3-10 秒不可用）</li>
          </ol>
          <p style={{ color: "var(--oo-text-muted)", marginBottom: 0 }}>
            你的配置（.env）、运行数据（data/）与用户数据不会被覆盖。
          </p>
        </div>
      ),
      okText: "开始更新",
      cancelText: "取消",
      onOk: doApply,
    });
  };

  const r = info?.remote;

  return (
    <div className="oo-panel" style={{ maxWidth: 760 }}>
      <div className="oo-panel-head">
        <div>
          <div className="oo-panel-title">在线更新</div>
          <div style={{ fontSize: 12, color: "var(--oo-text-muted)", marginTop: 2 }}>
            从 GitHub 仓库拉取最新代码并自动完成构建与重启
          </div>
        </div>
      </div>
      <div className="oo-panel-body">
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <Button onClick={check} loading={checking}>检查更新</Button>
          <Button type="primary" danger onClick={apply} loading={applying} disabled={!info?.ok || info?.upToDate}>
            立即更新
          </Button>
        </div>

        <div style={{ fontSize: 13 }}>
          <div style={{ display: "flex", padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ width: 96, color: "var(--ink-3)", flexShrink: 0 }}>仓库</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, minWidth: 0, wordBreak: "break-all" }}>
              {info?.repo || stamp?.repo || "—"}
              {info?.branch ? ` (${info.branch})` : ""}
            </span>
          </div>
          <div style={{ display: "flex", padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ width: 96, color: "var(--ink-3)", flexShrink: 0 }}>当前版本</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
              {stamp?.short || "未记录"}
              {stamp?.date ? ` · ${String(stamp.date).slice(0, 19).replace("T", " ")}` : ""}
            </span>
          </div>
          {r ? (
            <>
              <div style={{ display: "flex", padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
                <span style={{ width: 96, color: "var(--ink-3)", flexShrink: 0 }}>远端最新</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
                  {r.short} · {String(r.date || "").slice(0, 19)}
                </span>
              </div>
              <div style={{ display: "flex", padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
                <span style={{ width: 96, color: "var(--ink-3)", flexShrink: 0 }}>更新说明</span>
                <span>{r.message || "—"}</span>
              </div>
              <div style={{ display: "flex", padding: "7px 0" }}>
                <span style={{ width: 96, color: "var(--ink-3)", flexShrink: 0 }}>状态</span>
                <span>
                  {info.upToDate ? (
                    <span className="bui-chip" style={{ color: "var(--green)" }}>已是最新</span>
                  ) : (
                    <span className="bui-chip bui-chip--orange">
                      有更新 · {info.changedCount} 个文件变化
                    </span>
                  )}
                </span>
              </div>
            </>
          ) : null}
        </div>

        {info?.changed?.length ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12.5, fontWeight: 550, marginBottom: 6 }}>有变化的文件</div>
            <div
              style={{
                maxHeight: 220,
                overflow: "auto",
                background: "var(--inset)",
                borderRadius: "var(--r-card)",
                padding: "8px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                lineHeight: 1.8,
                color: "var(--ink-2)",
              }}
            >
              {info.changed.map((f) => (
                <div key={f}>{f}</div>
              ))}
            </div>
          </div>
        ) : null}

        {steps.length ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12.5, fontWeight: 550, marginBottom: 6 }}>更新过程</div>
            <div style={{ fontSize: 12.5, lineHeight: 2, color: "var(--ink-2)" }}>
              {steps.map((s, i) => (
                <div key={i}>· {s}</div>
              ))}
            </div>
          </div>
        ) : null}

        <p style={{ marginTop: 16, fontSize: 12, color: "var(--oo-text-muted)", lineHeight: 1.8 }}>
          更新需要服务器能访问 github.com，且运行用户对安装目录有写权限。
          更新前会自动备份源码到 <code>.backup-&lt;时间戳&gt;</code>，最多保留 3 份。
        </p>
      </div>
    </div>
  );
}

export default function AdminSettingsPage() {
  return (
    <div className="oo-page">
      <PageHeader title="系统设置" desc="站点信息、认证策略、计费规则与模型列表" />
      <Tabs
        items={[
          {
            key: "general",
            label: (
              <span>
                <SettingOutlined /> 站点
              </span>
            ),
            children: <GeneralTab />,
          },
          {
            key: "auth",
            label: (
              <span>
                <SafetyCertificateOutlined /> 认证
              </span>
            ),
            children: <AuthTab />,
          },
          {
            key: "quota",
            label: (
              <span>
                <DollarOutlined /> 计费
              </span>
            ),
            children: <QuotaTab />,
          },
          {
            key: "models",
            label: (
              <span>
                <ApiOutlined /> 模型
              </span>
            ),
            children: <ModelsTab />,
          },
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
