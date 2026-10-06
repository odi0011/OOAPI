import { Card } from "../components/arc/card/card";
import React, { useEffect, useState } from "react";
import {
  Form, Input, Button, Tabs, App as ArcApp, Space, Typography,
 } from "../components/arc/index";
import { UserOutlined, LockOutlined  } from "../components/arc/icons";
import { useApp } from "../context/AppContext";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import UserAvatar from "../components/UserAvatar";
import AvatarUploader from "../components/AvatarUploader";
import { fmtDate, unitsPerOd } from "../services/format";
import { userDataVisibility } from "../services/visibility";
import OdAmount from "../components/OdAmount";

const { Text } = Typography;

// 面板铺满内容区（曾限宽 560px，宽屏下右侧空出一半以上）。
// 表单本身用下面的 .oo-form-grid 自适应多列，不靠外层限宽来控制行长。
function Section({ title, desc, children, className, style }) { return <Card title={title} description={desc} className={className} style={style}>{children}</Card>; }

function ProfileTab() {
  const { user, refreshUser, status } = useApp();
  const { message } = ArcApp.useApp();
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
  const visibility = userDataVisibility(status, user);

  return (
    <Space direction="vertical" align="stretch" size={16} style={{ width: "100%" }}>
      <div className="oo-stats-cards">
        {visibility.balance ? <StatCard
          label="剩余额度"
          value={<OdAmount quota={user?.quota} perUnit={perUnit} size={20} />}
          icon={<UserOutlined />}
        /> : null}
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

        <Form form={form} className="oo-profile-form" layout="vertical" onFinish={save} requiredMark={false}>
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
  const { message } = ArcApp.useApp();
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
      <Form form={form} className="oo-profile-form" layout="vertical" onFinish={save} requiredMark={false}>
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

        ]}
      />
    </div>
  );
}
