import React, { useState } from "react";
import {
  Form, Input, Button, Tabs, App as AntApp, Space, ColorPicker, Typography, Divider,
} from "antd";
import { UserOutlined, LockOutlined, BgColorsOutlined, CheckOutlined } from "@ant-design/icons";
import { useApp } from "../context/AppContext";
import { API } from "../services/api";
import ThemeSwitch from "../components/ThemeSwitch";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { PRIMARY_PRESETS, DEFAULT_PRIMARY } from "../theme/presets";
import { useTheme } from "../theme/ThemeContext";
import { fmtDate, fmtOd, odOf, unitsPerOd } from "../services/format";
import { OdStatValue } from "../components/OdCoin";

const { Text } = Typography;

function Section({ title, desc, children, width = 560 }) {
  return (
    <div className="oo-panel" style={{ maxWidth: width }}>
      <div className="oo-panel-head">
        <div>
          <div className="oo-panel-title">{title}</div>
          {desc ? (
            <div style={{ fontSize: 12, color: "var(--oo-text-muted)", marginTop: 2 }}>{desc}</div>
          ) : null}
        </div>
      </div>
      <div className="oo-panel-body">{children}</div>
    </div>
  );
}

function ProfileTab() {
  const { user, refreshUser, status } = useApp();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);

  const save = async (v) => {
    setBusy(true);
    try {
      await API.put("/users/self", { display_name: v.display_name, email: v.email });
      message.success("保存成功");
      refreshUser();
    } catch (e) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const perUnit = unitsPerOd(status);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, maxWidth: 900 }}>
        <StatCard
          label="剩余额度"
          value={<OdStatValue od={odOf(user?.quota, perUnit)} />}
          icon={<UserOutlined />}
        />
        <StatCard
          label="注册时间"
          value={<span style={{ fontSize: 16 }}>{fmtDate(user?.created_time, "YYYY-MM-DD")}</span>}
        />
        <StatCard
          label="最后登录"
          value={<span style={{ fontSize: 16 }}>{fmtDate(user?.last_login_time, "MM-DD HH:mm")}</span>}
        />
      </div>

      <Section title="个人信息" desc="这些信息用于后台展示与通知">
        <Form
          form={form}
          layout="vertical"
          initialValues={{ display_name: user?.display_name, email: user?.email }}
          onFinish={save}
          requiredMark={false}
        >
          <Form.Item label="用户名">
            <Input value={user?.username} disabled />
          </Form.Item>
          <Form.Item name="display_name" label="显示名称">
            <Input placeholder="显示名称" maxLength={64} />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: "email", message: "邮箱格式不正确" }]}>
            <Input placeholder="用于接收通知（选填）" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>
            保存修改
          </Button>
        </Form>
      </Section>
    </Space>
  );
}

function PasswordTab() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);

  const save = async (v) => {
    setBusy(true);
    try {
      await API.put("/users/self/password", { old_password: v.old_password, new_password: v.new_password });
      message.success("密码修改成功");
      form.resetFields();
    } catch (e) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="修改密码" desc="建议使用字母与数字组合，长度至少 8 位">
      <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
        <Form.Item
          name="old_password"
          label="当前密码"
          rules={[{ required: true, message: "请输入当前密码" }]}
        >
          <Input.Password placeholder="当前登录密码" autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="new_password"
          label="新密码"
          rules={[
            { required: true, message: "请输入新密码" },
            { min: 8, message: "密码至少 8 位" },
            {
              validator: (_, v) =>
                !v || /^[0-9]+$/.test(v) || /^[a-zA-Z]+$/.test(v)
                  ? Promise.reject(new Error("密码需同时包含字母和数字"))
                  : Promise.resolve(),
            },
          ]}
        >
          <Input.Password placeholder="8 位以上，字母 + 数字" autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新密码"
          dependencies={["new_password"]}
          rules={[
            { required: true, message: "请再次输入新密码" },
            ({ getFieldValue }) => ({
              validator(_, v) {
                return !v || getFieldValue("new_password") === v
                  ? Promise.resolve()
                  : Promise.reject(new Error("两次密码不一致"));
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>
          修改密码
        </Button>
      </Form>
    </Section>
  );
}

function AppearanceTab() {
  const { primary, setPrimary } = useTheme();

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Section title="界面主题" desc="「跟随系统」会自动匹配操作系统的明暗设置">
        <ThemeSwitch />
      </Section>

      <Section title="主题色" desc="影响按钮、链接、选中态等交互元素" width={640}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          {PRIMARY_PRESETS.map((p) => {
            const active = primary.toLowerCase() === p.color.toLowerCase();
            return (
              <div key={p.key} style={{ textAlign: "center" }}>
                <div
                  onClick={() => setPrimary(p.color)}
                  title={p.label}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: p.color,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 13,
                    boxShadow: active ? `0 0 0 2px var(--oo-bg-surface), 0 0 0 4px ${p.color}` : "none",
                    transition: "box-shadow 140ms ease",
                  }}
                >
                  {active ? <CheckOutlined /> : null}
                </div>
                <div style={{ fontSize: 11, color: "var(--oo-text-muted)", marginTop: 6 }}>{p.label}</div>
              </div>
            );
          })}
          <Divider type="vertical" style={{ height: 30 }} />
          <ColorPicker value={primary} onChange={(c) => setPrimary(c.toHexString())} showText />
          {primary.toLowerCase() !== DEFAULT_PRIMARY ? (
            <Button size="small" type="link" onClick={() => setPrimary(DEFAULT_PRIMARY)}>
              恢复默认
            </Button>
          ) : null}
        </div>
      </Section>
    </Space>
  );
}

export default function ProfilePage() {
  const { user } = useApp();

  return (
    <div className="oo-page">
      <PageHeader title="个人设置" desc={`${user?.username} · ${user?.role >= 100 ? "管理员" : "普通用户"}`} />
      <Tabs
        items={[
          {
            key: "profile",
            label: (
              <span>
                <UserOutlined /> 个人信息
              </span>
            ),
            children: <ProfileTab />,
          },
          {
            key: "password",
            label: (
              <span>
                <LockOutlined /> 密码
              </span>
            ),
            children: <PasswordTab />,
          },
          {
            key: "appearance",
            label: (
              <span>
                <BgColorsOutlined /> 外观
              </span>
            ),
            children: <AppearanceTab />,
          },
        ]}
      />
    </div>
  );
}
