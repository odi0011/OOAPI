import React, { useRef, useState } from "react";
import { Form, Input, Button, App as AntApp, Alert, Modal, Spin } from "antd";
import { ArrowRightOutlined, CheckOutlined, LockOutlined, MailOutlined, KeyOutlined, UserOutlined } from "@ant-design/icons";
import { useNavigate, useLocation, Navigate, Link } from "react-router-dom";
import { useApp } from "../context/AppContext";
import BrandLogo, { BrandName } from "../components/BrandLogo";
import { StudioPage, StudioHeader, StudioFooter, StudioCat, useStudioMotion } from "../components/StudioUI";

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
      message.success(isRegister ? "注册成功，欢迎加入" : "欢迎回来");
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
      <section className="studio-auth-story" aria-label="欢迎来到工作室">
        <span className="studio-eyebrow"><span className="studio-status-dot" /> 你的灵感，有个落脚的地方</span>
        <h1>{isRegister ? <>好点子，<br />在这里<span>发芽。</span></> : <>回来啦。<br />一起做点<span>好东西。</span></>}</h1>
        <p>模型、应用与下一次灵感，<br />在同一个工作台里相遇。</p>
        <div className="studio-auth-scene"><img className="studio-auth-garden" src="/illustrations/studio-world.webp" alt="纸雕云端工作室" /><div className="studio-auth-scene-label"><span><BrandLogo size={19}/> <BrandName/> MODEL WORKSPACE</span><i>一个入口 · 三种兼容协议</i></div><StudioCat pose={privateFocus ? "nap" : isRegister ? "wave" : "code"} interactive={!privateFocus} motion={motion.active} className={`studio-auth-cat${privateFocus ? " is-sleeping" : ""}`} eager /><span className="studio-auth-cat-caption" aria-live="polite">{privateFocus ? "我先闭会儿眼，你慢慢输入。" : isRegister ? "你好，新朋友。" : "给灵感留个位，也给小猫留个位。"}</span></div>
        <div className="studio-auth-points"><span><CheckOutlined /> 熟悉的 API</span><span><CheckOutlined /> 独立应用令牌</span><span><CheckOutlined /> 清晰的用量记录</span></div>
      </section>
      <section className="studio-auth-form-area">
        <div className="studio-auth-paper">
          <span className="studio-auth-paper-mark" aria-hidden="true">✳</span>
          <div className="studio-auth-switch" role="tablist" aria-label="账户入口"><Button type="text" role="tab" aria-selected={!isRegister} disabled={busy} onClick={() => changeTab("login")} className={!isRegister ? "is-active" : ""}>登录</Button><Button type="text" role="tab" aria-selected={isRegister} disabled={busy} onClick={() => changeTab("register")} className={isRegister ? "is-active" : ""}>注册</Button></div>
          <div className="studio-auth-heading"><span className="studio-eyebrow">{isRegister ? "NICE TO MEET YOU" : "GOOD TO SEE YOU AGAIN"}</span><h2>{isRegister ? "创建你的工作台" : "欢迎回到工作台"}</h2><p>{isRegister ? "从一个账号，开始下一件作品。" : "继续你的对话、应用和未完的好点子。"}</p></div>
          {status?.login_page_notice && <Alert type="info" showIcon message={status.login_page_notice} />}
          {!status ? <div className="studio-auth-config">{loading ? <Spin tip="正在读取站点设置" /> : <Alert type="warning" showIcon message="暂时无法读取登录设置" action={<Button onClick={refreshStatus}>重试</Button>} />}</div> : closed ? <div className="studio-auth-closed"><LockOutlined /><h3>{isRegister ? "工作室暂未开放注册" : "密码登录暂未开放"}</h3><p>{isRegister ? "已有账号可以直接登录。新账号请联系管理员开通。" : "请联系管理员获取当前可用的登录方式。"}</p>{isRegister && <Button onClick={() => changeTab("login")}>我有账号，去登录 <ArrowRightOutlined /></Button>}</div> : <Form
            key={tab} form={isRegister ? regForm : loginForm} name={tab} layout="vertical" onFinish={onFinish} disabled={busy} requiredMark={false}
            className="studio-auth-fields" onValuesChange={() => setError("")} onFocusCapture={(e) => setPrivateFocus(/password|confirm/.test(e.target.id || ""))} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setPrivateFocus(false); }}
          >
            {error && <Alert type="error" showIcon message={error} role="alert" />}
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }, { pattern: /^[a-zA-Z0-9_]{2,32}$/, message: "2–32 位字母、数字或下划线" }]}><Input prefix={<UserOutlined />} placeholder={isRegister ? "给你的账号取个名字" : "输入用户名"} size="large" autoComplete="username" maxLength={32} /></Form.Item>
            {isRegister && status.register_email_required && <Form.Item name="email" label="邮箱" rules={[{ required: true, message: "请输入邮箱" }, { type: "email", message: "请输入有效邮箱" }]}><Input prefix={<MailOutlined />} placeholder="用于账号联系的邮箱" size="large" autoComplete="email" /></Form.Item>}
            {isRegister && status.register_invite_only && <Form.Item name="invite_code" label="邀请码" rules={[{ required: true, message: "请输入邀请码" }]}><Input prefix={<KeyOutlined />} placeholder="输入邀请人提供的邀请码" size="large" autoComplete="off" /></Form.Item>}
            <Form.Item name="password" label="密码" rules={passwordRules} extra={isRegister ? `至少 ${minLength} 位，不能仅由字母或数字组成` : undefined}><Input.Password prefix={<LockOutlined />} placeholder={isRegister ? "设置一个可靠的密码" : "输入密码"} size="large" autoComplete={isRegister ? "new-password" : "current-password"} /></Form.Item>
            {isRegister && <Form.Item name="confirm" label="确认密码" dependencies={["password"]} rules={[{ required: true, message: "请再次输入密码" }, ({ getFieldValue }) => ({ validator: (_, value) => !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error("两次密码不一致")) })]}><Input.Password prefix={<LockOutlined />} placeholder="再输入一次，确认无误" size="large" autoComplete="new-password" /></Form.Item>}
            <Button className="studio-button studio-auth-submit" htmlType="submit" size="large" block loading={busy}>{isRegister ? "创建账户，开始构建" : "登录工作台"}<ArrowRightOutlined /></Button>
          </Form>}
          <div className="studio-auth-help">{isRegister ? "已经有账号？" : "第一次来这里？"}<Button type="link" disabled={busy} onClick={() => changeTab(isRegister ? "login" : "register")}>{isRegister ? "欢迎回来" : status?.password_register_enabled === false ? "查看注册说明" : "创建一个账号"}<ArrowRightOutlined /></Button></div>
          {(status?.legal_user_agreement || status?.legal_privacy_policy) && <div className="studio-auth-legal">{status?.legal_user_agreement && <Button type="link" onClick={() => setLegal("terms")}>用户协议</Button>}{status?.legal_privacy_policy && <Button type="link" onClick={() => setLegal("privacy")}>隐私政策</Button>}</div>}
        </div>
        <Link className="studio-auth-guide" to="/#quickstart"><CodeHint /> 第一次接入 API？从这份指南开始 <ArrowRightOutlined /></Link>
      </section>
    </main>
    <StudioFooter status={status} />
    <Modal open={Boolean(legal)} title={legal === "terms" ? "用户协议" : "隐私政策"} footer={null} onCancel={() => setLegal(null)}><div className="studio-legal-content">{legal === "terms" ? status?.legal_user_agreement : status?.legal_privacy_policy}</div></Modal>
  </StudioPage>;
}

function CodeHint() { return <span aria-hidden="true">⌘</span>; }
