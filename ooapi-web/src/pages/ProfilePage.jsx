import React, { useEffect, useState } from "react";
import {
  Form, Input, Button, Tabs, App as AntApp, Space, ColorPicker, Typography, Divider,
} from "antd";
import { UserOutlined, LockOutlined, BgColorsOutlined, CheckOutlined } from "@ant-design/icons";
import { useApp } from "../context/AppContext";
import { API } from "../services/api";
import ThemeSwitch from "../components/ThemeSwitch";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import UserAvatar from "../components/UserAvatar";
import AvatarUploader from "../components/AvatarUploader";
import { PRIMARY_PRESETS, DEFAULT_PRIMARY } from "../theme/presets";
import { useTheme } from "../theme/ThemeContext";
import { fmtDate, odOf, unitsPerOd } from "../services/format";
import { OdStatValue } from "../components/OdCoin";

const { Text } = Typography;

// 面板铺满内容区（曾限宽 560px，宽屏下右侧空出一半以上）。
// 表单本身用下面的 .oo-form-grid 自适应多列，不靠外层限宽来控制行长。
function Section({ title, desc, children, className, style }) {
  return (
    <div className={`oo-panel${className ? ` ${className}` : ""}`} style={style}>
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

// 表单栅格：按可用宽度自动决定列数（每列 260~320px）。
// 短字段（用户名/邮箱/链接）各占一列，长字段（简介）跨整行。
const FORM_GRID = `
  .oo-form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    column-gap: 18px;
    row-gap: 0;
  }
  .oo-form-grid .oo-form-field { min-width: 0; margin-bottom: 14px; }
  .oo-form-grid .oo-form-field--wide,
  .oo-form-grid .oo-form-actions { grid-column: 1 / -1; }
  .oo-form-grid .oo-form-field--wide textarea { max-width: 1100px; }
  @media (max-width: 640px) {
    .oo-form-grid { grid-template-columns: minmax(0, 1fr); column-gap: 0; }
    .oo-form-grid .oo-form-field--wide,
    .oo-form-grid .oo-form-actions { grid-column: auto; }
  }
`;

function ProfileTab() {
  const { user, refreshUser, status } = useApp();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);

  useEffect(() => {
    form.setFieldsValue({
      display_name: user?.display_name || "",
      email: user?.email || "",
      bio: user?.bio || "",
      website: user?.website || "",
      location: user?.location || "",
    });
  }, [form, user?.display_name, user?.email, user?.bio, user?.website, user?.location]);

  const save = async (v) => {
    setBusy(true);
    try {
      await API.put("/users/self", {
        display_name: v.display_name,
        email: v.email,
        bio: v.bio,
        website: v.website,
        location: v.location,
      });
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
      <style>{FORM_GRID}</style>
      <div className="oo-stats-cards">
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

      <Section title="个人信息">
        {/* 头像：点击打开裁剪弹窗（纯 Canvas 处理，不引依赖） */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 18 }}>
          <UserAvatar user={user} size={64} />
          <div>
            <Space size={8}>
              <Button size="small" onClick={() => setAvatarOpen(true)}>
                {user?.avatar_url ? "更换头像" : "上传头像"}
              </Button>
            </Space>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
              支持 PNG / JPEG / GIF / WebP，会自动裁成正方形并压缩
            </div>
          </div>
        </div>

        <Form form={form} className="oo-form-grid" layout="vertical" onFinish={save} requiredMark={false}>
          <Form.Item className="oo-form-field" label="用户名">
            <Input value={user?.username} disabled />
          </Form.Item>
          <Form.Item className="oo-form-field" name="display_name" label="显示名称">
            <Input placeholder="显示名称" maxLength={64} />
          </Form.Item>
          <Form.Item
            className="oo-form-field"
            name="email"
            label="邮箱"
            rules={[{ type: "email", message: "邮箱格式不正确" }]}
          >
            <Input placeholder="用于接收通知（选填）" />
          </Form.Item>
          <Form.Item className="oo-form-field" name="website" label="个人链接">
            <Input placeholder="https://（选填）" maxLength={255} />
          </Form.Item>
          <Form.Item className="oo-form-field" name="location" label="所在地">
            <Input placeholder="如：杭州（选填）" maxLength={64} />
          </Form.Item>
          <Form.Item
            className="oo-form-field oo-form-field--wide"
            name="bio"
            label="个人简介"
            tooltip="会在个人主页展示"
          >
            <Input.TextArea placeholder="一句话介绍自己（选填）" maxLength={255} rows={3} showCount />
          </Form.Item>
          <div className="oo-form-actions">
            <Button type="primary" htmlType="submit" loading={busy}>
              保存修改
            </Button>
          </div>
        </Form>
      </Section>

      <AvatarUploader open={avatarOpen} onClose={() => setAvatarOpen(false)} onDone={refreshUser} />
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
      <Section title="修改密码">
      <Form form={form} className="oo-form-grid" layout="vertical" onFinish={save} requiredMark={false}>
        <Form.Item
          className="oo-form-field"
          name="old_password"
          label="当前密码"
          rules={[{ required: true, message: "请输入当前密码" }]}
        >
          <Input.Password placeholder="当前登录密码" autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          className="oo-form-field"
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
          className="oo-form-field"
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
        <div className="oo-form-actions">
          <Button type="primary" htmlType="submit" loading={busy}>
            修改密码
          </Button>
        </div>
      </Form>
    </Section>
  );
}

function AppearanceTab() {
  const { primary, setPrimary } = useTheme();

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Section title="界面主题">
        <ThemeSwitch />
      </Section>

      <Section title="主题色">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          {PRIMARY_PRESETS.map((p) => {
            const active = primary.toLowerCase() === p.color.toLowerCase();
            return (
              <div key={p.key} style={{ textAlign: "center" }}>
                <button
                  type="button"
                  onClick={() => setPrimary(p.color)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPrimary(p.color);
                    }
                  }}
                  aria-label={`选择主题色：${p.label}`}
                  aria-pressed={active}
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
                    border: 0,
                    padding: 0,
                  }}
                >
                  {active ? <CheckOutlined /> : null}
                </button>
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
      <PageHeader title="个人设置" />
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
