import React, { useEffect, useState } from "react";
import { Tabs, Form, Input, Button, App as AntApp, Space } from "antd";
import {
  UserOutlined,
  LockOutlined,
  ApiOutlined,
  KeyOutlined,
  FundOutlined,
  CheckCircleFilled,
} from "@ant-design/icons";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import ThemeSwitch from "../components/ThemeSwitch";

const POINTS = [
  { icon: <ApiOutlined />, text: "OpenAI 兼容接口，改个 baseURL 即可接入" },
  { icon: <KeyOutlined />, text: "独立令牌分发，支持额度上限与模型白名单" },
  { icon: <FundOutlined />, text: "按 token 精确计费，用量与账单实时可查" },
];

export default function AuthPage({ initialTab = "login" }) {
  const { user, status, login, register, loading } = useApp();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [loginForm] = Form.useForm();
  const [regForm] = Form.useForm();

  useEffect(() => {
    setTab(location.pathname === "/register" ? "register" : "login");
  }, [location.pathname]);

  if (!loading && user) return <Navigate to="/console" replace />;

  const onFinish = async (kind, values) => {
    setBusy(true);
    try {
      if (kind === "login") {
        await login(values.username, values.password);
        message.success("登录成功");
      } else {
        await register(values.username, values.password);
        message.success("注册成功");
      }
      const to = location.state?.from?.pathname || "/console";
      navigate(to, { replace: true });
    } catch (e) {
      message.error(e.message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const nameInput = (
    <Form.Item
      name="username"
      label="用户名"
      rules={[
        { required: true, message: "请输入用户名" },
        { pattern: /^[a-zA-Z0-9_]{2,32}$/, message: "2-32 位字母、数字或下划线" },
      ]}
    >
      <Input prefix={<UserOutlined style={{ color: "var(--oo-text-muted)" }} />} placeholder="用户名" size="large" autoComplete="username" />
    </Form.Item>
  );

  // 登录只要求非空：历史密码可能不满足当前强度规则，强度校验只用于注册/改密
  const loginPwdRules = [{ required: true, message: "请输入密码" }];

  const registerPwdRules = [
    { required: true, message: "请输入密码" },
    { min: 8, message: "密码至少 8 位" },
    {
      validator: (_, v) =>
        !v || /^[0-9]+$/.test(v) || /^[a-zA-Z]+$/.test(v)
          ? Promise.reject(new Error("密码需同时包含字母和数字"))
          : Promise.resolve(),
    },
  ];

  const loginFormEl = (
    <Form form={loginForm} layout="vertical" onFinish={(v) => onFinish("login", v)} disabled={busy} requiredMark={false}>
      {nameInput}
      <Form.Item name="password" label="密码" rules={loginPwdRules}>
        <Input.Password
          prefix={<LockOutlined style={{ color: "var(--oo-text-muted)" }} />}
          placeholder="密码"
          size="large"
          autoComplete="current-password"
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" size="large" block loading={busy} style={{ marginTop: 4 }}>
        登录
      </Button>
    </Form>
  );

  const registerFormEl = (
    <Form form={regForm} layout="vertical" onFinish={(v) => onFinish("register", v)} disabled={busy} requiredMark={false}>
      {nameInput}
      <Form.Item name="password" label="密码" rules={registerPwdRules}>
        <Input.Password
          prefix={<LockOutlined style={{ color: "var(--oo-text-muted)" }} />}
          placeholder="8 位以上，字母 + 数字"
          size="large"
          autoComplete="new-password"
        />
      </Form.Item>
      <Form.Item
        name="confirm"
        label="确认密码"
        dependencies={["password"]}
        rules={[
          { required: true, message: "请再次输入密码" },
          ({ getFieldValue }) => ({
            validator(_, v) {
              return !v || getFieldValue("password") === v
                ? Promise.resolve()
                : Promise.reject(new Error("两次密码不一致"));
            },
          }),
        ]}
      >
        <Input.Password
          prefix={<LockOutlined style={{ color: "var(--oo-text-muted)" }} />}
          placeholder="确认密码"
          size="large"
          autoComplete="new-password"
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" size="large" block loading={busy} style={{ marginTop: 4 }}>
        创建账户
      </Button>
    </Form>
  );

  return (
    <div className="oo-auth">
      {/* 左侧：品牌面板（网格 + 辉光） */}
      <div className="oo-auth-brand">
        <div className="oo-auth-brand-inner">
          <Space size={10} align="center">
            <img
              src={status?.logo || "/logo.jpg"}
              alt="logo"
              style={{ width: 34, height: 34, borderRadius: 9, objectFit: "cover", border: "1px solid var(--oo-border)" }}
            />
            <span style={{ fontWeight: 650, fontSize: 16 }}>{status?.system_name || "OOAPI"}</span>
          </Space>

          <h1 className="oo-auth-headline">
            大模型 API
            <br />
            网关与分发平台
          </h1>
          <p className="oo-auth-sub">
            {status?.about || "统一接入多家大模型，签发令牌、精确计费、全链路审计，开箱即用。"}
          </p>

          <div className="oo-auth-points">
            {POINTS.map((p) => (
              <div className="oo-auth-point" key={p.text}>
                {p.icon}
                <span>{p.text}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="oo-auth-brand-inner" style={{ fontSize: 12, color: "var(--oo-text-muted)" }}>
          {status?.footer || `© ${new Date().getFullYear()} OOAPI`}
        </div>
      </div>

      {/* 右侧：表单区 */}
      <div className="oo-auth-form">
        <div style={{ position: "absolute", top: 20, right: 20 }}>
          <ThemeSwitch size="small" />
        </div>

        <div className="oo-auth-box">
          <img className="oo-auth-logo" src={status?.logo || "/logo.jpg"} alt="logo" />
          <h2 className="oo-auth-title">{tab === "login" ? "欢迎回来" : "创建账户"}</h2>
          <div className="oo-auth-desc">
            {tab === "login" ? "登录以管理你的令牌与用量" : "注册后即可创建令牌并调用接口"}
          </div>

          <Tabs
            activeKey={tab}
            onChange={(k) => {
              setTab(k);
              navigate(k === "register" ? "/register" : "/login", { replace: true });
            }}
            items={[
              { key: "login", label: "登录", children: loginFormEl },
              {
                key: "register",
                label: "注册",
                children:
                  status?.password_register_enabled === false ? (
                    <div
                      style={{
                        padding: "28px 0",
                        textAlign: "center",
                        color: "var(--oo-text-muted)",
                        fontSize: 13,
                      }}
                    >
                      <CheckCircleFilled style={{ fontSize: 22, display: "block", marginBottom: 10, color: "var(--oo-text-disabled)" }} />
                      系统当前未开放注册，请联系管理员开通
                    </div>
                  ) : (
                    registerFormEl
                  ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
