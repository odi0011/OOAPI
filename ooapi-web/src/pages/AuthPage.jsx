import React, { useRef, useState } from "react";
import { Form, Input, Button, App as AntApp, Alert, Modal, Spin } from "antd";
import { ArrowRightOutlined, LockOutlined, MailOutlined, KeyOutlined, UserOutlined } from "@ant-design/icons";
import { useNavigate, useLocation, Navigate, Link } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { StudioPage, StudioHeader, StudioFooter, useStudioMotion } from "../components/StudioUI";
import AuthShowcase from "../components/AuthShowcase";

export default function AuthPage() {
  const { user, status, login, register, loading, refreshStatus } = useApp();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const motion = useStudioMotion();
  const tab = location.pathname === "/register" ? "register" : "login";
  const isRegister = tab === "register";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [privateFocus, setPrivateFocus] = useState(false);
  const [legal, setLegal] = useState(null);
  const pending = useRef(false);
  const [loginForm] = Form.useForm();
  const [regForm] = Form.useForm();
  const minLength = Math.max(6, Number(status?.password_min_length) || 8);
  const closed = isRegister ? status?.password_register_enabled === false : status?.password_login_enabled === false;
  const from = location.state?.from;
  const requested = from ? `${from.pathname || "/console"}${from.search || ""}${from.hash || ""}` : "/console";
  const destination = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/console";
  if (!loading && user) return <Navigate to={destination} replace />;

  const changeTab = (next) => {
    setError(""); setPrivateFocus(false);
    navigate(next === "register" ? "/register" : "/login", { replace: true, state: from ? { from } : undefined });
  };
  const onFinish = async (values) => {
    if (pending.current || closed || !status) return;
    pending.current = true; setBusy(true); setError("");
    try {
      if (isRegister) await register(values.username.trim(), values.password, { email: values.email?.trim(), invite_code: values.invite_code?.trim() });
      else await login(values.username.trim(), values.password);
      message.success(isRegister ? "注册成功" : "登录成功");
      navigate(destination, { replace: true });
    } catch (e) {
      const text = e.message || "操作失败，请稍后再试";
      setError(text); message.error(text);
    } finally { pending.current = false; setBusy(false); }
  };
  const passwordRules = [{ required: true, message: "请输入密码" }, ...(isRegister ? [
    { min: minLength, message: `密码至少 ${minLength} 位` },
    { validator: (_, v) => !v || (/\S/.test(v) && !/^[0-9]+$/.test(v) && !/^[a-zA-Z]+$/.test(v)) ? Promise.resolve() : Promise.reject(new Error("密码不能全是空格、纯字母或纯数字")) },
    { validator: (_, v) => !v || new TextEncoder().encode(v).length <= 72 ? Promise.resolve() : Promise.reject(new Error("密码过长（最多 72 字节）")) },
  ] : [])];

  return <StudioPage motion={motion} className="studio-auth">
    <StudioHeader status={status} motion={motion} auth />
    <main className="studio-auth-main">
      <AuthShowcase isRegister={isRegister} privateFocus={privateFocus} motion={motion}/>
      <section className="studio-auth-form-area">
        <div className="studio-auth-paper">
          <span className="studio-auth-paper-mark" aria-hidden="true">✳</span>
          <div className="studio-auth-switch" role="tablist" aria-label="账户入口"><Button type="text" role="tab" aria-selected={!isRegister} disabled={busy} onClick={() => changeTab("login")} className={!isRegister ? "is-active" : ""}>登录</Button><Button type="text" role="tab" aria-selected={isRegister} disabled={busy} onClick={() => changeTab("register")} className={isRegister ? "is-active" : ""}>注册</Button></div>
          <div className="studio-auth-heading"><span className="studio-eyebrow">{isRegister ? "CREATE ACCOUNT" : "SIGN IN"}</span><h2>{isRegister ? "注册账户" : "登录账户"}</h2><p>{isRegister ? "填写以下信息完成注册。" : "输入用户名和密码。"}</p></div>
          {status?.login_page_notice && <Alert type="info" showIcon message={status.login_page_notice} />}
          {!status ? <div className="studio-auth-config">{loading ? <Spin tip="正在读取站点设置" /> : <Alert type="warning" showIcon message="暂时无法读取登录设置" action={<Button onClick={refreshStatus}>重试</Button>} />}</div> : closed ? <div className="studio-auth-closed"><LockOutlined /><h3>{isRegister ? "暂未开放注册" : "密码登录暂未开放"}</h3><p>{isRegister ? "已有账号可以直接登录。新账号请联系管理员开通。" : "请联系管理员获取当前可用的登录方式。"}</p>{isRegister && <Button onClick={() => changeTab("login")}>我有账号，去登录 <ArrowRightOutlined /></Button>}</div> : <Form
            key={tab} form={isRegister ? regForm : loginForm} name={tab} layout="vertical" onFinish={onFinish} disabled={busy} requiredMark={false}
            className="studio-auth-fields" onValuesChange={() => setError("")} onFocusCapture={(e) => setPrivateFocus(/password|confirm/.test(e.target.id || ""))} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setPrivateFocus(false); }}
          >
            {error && <Alert type="error" showIcon message={error} role="alert" />}
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }, { pattern: /^[a-zA-Z0-9_]{2,32}$/, message: "2–32 位字母、数字或下划线" }]}><Input prefix={<UserOutlined />} placeholder={isRegister ? "设置用户名" : "输入用户名"} size="large" autoComplete="username" maxLength={32} /></Form.Item>
            {isRegister && status.register_email_required && <Form.Item name="email" label="邮箱" rules={[{ required: true, message: "请输入邮箱" }, { type: "email", message: "请输入有效邮箱" }]}><Input prefix={<MailOutlined />} placeholder="用于账号联系的邮箱" size="large" autoComplete="email" /></Form.Item>}
            {isRegister && status.register_invite_only && <Form.Item name="invite_code" label="邀请码" rules={[{ required: true, message: "请输入邀请码" }]}><Input prefix={<KeyOutlined />} placeholder="输入邀请人提供的邀请码" size="large" autoComplete="off" /></Form.Item>}
            <Form.Item name="password" label="密码" rules={passwordRules} extra={isRegister ? `至少 ${minLength} 位，不能仅由字母或数字组成` : undefined}><Input.Password prefix={<LockOutlined />} placeholder={isRegister ? "设置一个可靠的密码" : "输入密码"} size="large" autoComplete={isRegister ? "new-password" : "current-password"} /></Form.Item>
            {isRegister && <Form.Item name="confirm" label="确认密码" dependencies={["password"]} rules={[{ required: true, message: "请再次输入密码" }, ({ getFieldValue }) => ({ validator: (_, value) => !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error("两次密码不一致")) })]}><Input.Password prefix={<LockOutlined />} placeholder="再次输入密码" size="large" autoComplete="new-password" /></Form.Item>}
            <Button className="studio-button studio-auth-submit" htmlType="submit" size="large" block loading={busy}>{isRegister ? "注册账户" : "登录工作台"}<ArrowRightOutlined /></Button>
          </Form>}
          <div className="studio-auth-help">{isRegister ? "已有账户？" : "还没有账户？"}<Button type="link" disabled={busy} onClick={() => changeTab(isRegister ? "login" : "register")}>{isRegister ? "去登录" : status?.password_register_enabled === false ? "查看注册说明" : "注册账户"}<ArrowRightOutlined /></Button></div>
          {(status?.legal_user_agreement || status?.legal_privacy_policy) && <div className="studio-auth-legal">{status?.legal_user_agreement && <Button type="link" onClick={() => setLegal("terms")}>用户协议</Button>}{status?.legal_privacy_policy && <Button type="link" onClick={() => setLegal("privacy")}>隐私政策</Button>}</div>}
        </div>
        <Link className="studio-auth-guide" to="/#quickstart"><CodeHint /> API 接入指南 <ArrowRightOutlined /></Link>
      </section>
    </main>
    <StudioFooter status={status} motion={motion} />
    <Modal open={Boolean(legal)} title={legal === "terms" ? "用户协议" : "隐私政策"} footer={null} onCancel={() => setLegal(null)}><div className="studio-legal-content">{legal === "terms" ? status?.legal_user_agreement : status?.legal_privacy_policy}</div></Modal>
  </StudioPage>;
}

function CodeHint() { return <span aria-hidden="true">⌘</span>; }
