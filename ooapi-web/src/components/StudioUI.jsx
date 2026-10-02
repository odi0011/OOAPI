import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Dropdown, Input, Modal } from "antd";
import { ArrowLeftOutlined, ArrowRightOutlined, PauseOutlined, CaretRightOutlined, SearchOutlined, DownOutlined } from "@ant-design/icons";
import ThemeSwitch from "./ThemeSwitch";
import BrandLogo from "./BrandLogo";
import "../studio.css";

export function useStudioMotion() {
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    const visibility = () => setVisible(!document.hidden);
    media.addEventListener("change", change);
    document.addEventListener("visibilitychange", visibility);
    return () => { media.removeEventListener("change", change); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return { active: !paused && !reduced && visible, reduced, paused, toggle: () => setPaused((p) => !p) };
}

export function StudioPage({ children, motion, className = "", onClickCapture }) {
  const root = useRef(null);
  useEffect(() => {
    if (!window.IntersectionObserver) return undefined;
    const el = root.current;
    el.classList.add("studio-ready");
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add("is-revealed"); observer.unobserve(entry.target); }
    }), { threshold: 0.08 });
    el.querySelectorAll("[data-reveal]").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  return <div ref={root} onClickCapture={onClickCapture} className={`studio ${className}`} data-motion={motion.active ? "on" : "off"}>{children}</div>;
}

export function StudioHeader({ status, motion, auth = false, user }) {
  const name = status?.system_name || "OOAPI";
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  const destinations = [
    { label: "首页", hint: "返回首页", to: "/#top" },
    { label: "接入文档", hint: "Base URL、创建令牌与 SDK 示例", to: "/#quickstart" },
    { label: "工作方式", hint: "协议接入、模型厂商和用量说明", to: "/#products" },
    { label: "对话工作台", hint: "对话、附件与智能体工具", to: "/chat" },
    { label: "API 令牌", hint: "应用密钥、额度与模型权限", to: "/token" },
    { label: "数据看板", hint: "个人用量与消费趋势", to: "/console" },
    { label: "使用记录", hint: "调用详情、用量与扣费", to: "/log" },
    { label: "社区", hint: "讨论、分享与交流", to: "/community" },
    ...(status?.home_show_models !== false ? [{ label: "厂商目录", hint: "平台实际集成的厂商与接入方式", to: "/#providers" }] : []),
    ...(status?.home_show_pricing !== false ? [{ label: "模型定价", hint: "查看当前模型价格", to: "/pricing" }] : []),
    ...(user?.role >= 100 ? [{ label: "运维监控", hint: "系统资源、渠道与告警", to: "/admin/monitor" }] : []),
  ];
  const results = destinations.filter((d) => `${d.label} ${d.hint}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    if (auth) return undefined;
    const keydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen((v) => !v); } };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [auth]);
  const menu = (items) => ({ items: items.map((d) => ({ key: d.to, label: <Link className="studio-menu-item" to={d.to}><b>{d.label}</b><span>{d.hint}</span></Link> })) });
  return <header className="studio-header">
    <Link to="/" className="studio-brand"><BrandLogo size={29}/><b>{name}</b><span>模型网关</span></Link>
    {!auth && <nav aria-label="首页导航"><Dropdown menu={menu(destinations.filter((d) => ["工作方式", "对话工作台", "API 令牌", "数据看板", "使用记录"].includes(d.label)))} trigger={["hover", "click"]}><button className="studio-menu-trigger" type="button">工作方式 <DownOutlined /></button></Dropdown>{status?.home_show_models !== false && <a href="#providers">厂商目录</a>}{status?.home_show_pricing !== false && <Link to="/pricing">定价</Link>}<a href="#quickstart">文档</a><Link to="/community">社区</Link></nav>}
    <div className="studio-header-actions">
      {!auth && <Button type="text" icon={<SearchOutlined />} aria-label="搜索页面" title="搜索页面 · Ctrl K" onClick={() => setSearchOpen(true)} />}
      <ThemeSwitch size="small" />
      {auth ? <Link to="/" className="studio-back"><ArrowLeftOutlined /> 返回首页</Link> : <Link className="studio-button studio-button-small" to={user ? "/console" : "/login"}>{user ? "控制台" : "登录"}<ArrowRightOutlined /></Link>}
    </div>
    {!auth && <Modal className="studio-search-modal" open={searchOpen} title="搜索页面" footer={null} onCancel={() => setSearchOpen(false)} afterOpenChange={(open) => { if (open) searchRef.current?.focus(); else setQuery(""); }}>
      <Input ref={searchRef} prefix={<SearchOutlined />} placeholder="搜索文档、模型、令牌、用量…" value={query} onChange={(e) => setQuery(e.target.value)} size="large" onPressEnter={() => { if (results[0]) { navigate(results[0].to); setSearchOpen(false); } }} />
      <div className="studio-search-results">{results.length ? results.map((d) => <Link key={d.to} to={d.to} onClick={() => setSearchOpen(false)}><span><b>{d.label}</b><small>{d.hint}</small></span><ArrowRightOutlined /></Link>) : <p>没有匹配的页面，换个关键词试试。</p>}</div><div className="studio-search-help">Enter 打开第一项 · Esc 关闭</div>
    </Modal>}
  </header>;
}

const CAT_LABELS = { code: "正在写代码的灰白小猫", peek: "从卡片后探头的小猫", nap: "顶着小黄鱼打盹的小猫", wave: "举起粉色肉垫打招呼的小猫", stretch: "伸懒腰的小猫", read: "捧着书的小猫", sit: "歪着头的小猫", doze: "蜷起来睡觉的小猫", listen: "戴着耳机的小猫" };
export function StudioCat({ pose = "code", className = "", interactive = false, motion = true, eager = false }) {
  const [boop, setBoop] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const picture = <img src={`/illustrations/cat-${pose}.webp`} alt={interactive ? "" : CAT_LABELS[pose]} loading={eager ? "eager" : "lazy"} decoding="async" draggable="false" />;
  if (!interactive) return <span className={`studio-cat ${className}`} aria-hidden="true">{picture}</span>;
  return <button type="button" className={`studio-cat studio-cat-button ${className}`} aria-label="和小猫打个招呼" onClick={(event) => {
    setBoop(true); clearTimeout(timer.current); timer.current = setTimeout(() => setBoop(false), 2400);
    if (motion) {
      // 短促起跳、轻微越过终点后收住，让点击有弹性但不持续晃动。
      event.currentTarget.getAnimations().forEach((a) => a.cancel());
      event.currentTarget.animate([
        { transform: "translateY(0) rotate(0) scale(1)" },
        { transform: "translateY(5px) rotate(-3deg) scale(.95,1.02)", offset: .16 },
        { transform: "translateY(-16px) rotate(3deg) scale(1.03,.98)", offset: .4 },
        { transform: "translateY(3px) rotate(-1deg) scale(.99,1.01)", offset: .72 },
        { transform: "translateY(0) rotate(0) scale(1)" },
      ], { duration: 650, easing: "cubic-bezier(.22,.68,.32,1)" });
    }
  }}>{picture}<span className={`studio-cat-hello${boop ? " is-visible" : ""}`} aria-live="polite">{boop ? "喵～" : ""}</span></button>;
}

export function StudioFooter({ status, motion }) {
  return <footer className="studio-footer"><span><BrandLogo size={16}/> {status?.footer || `© ${new Date().getFullYear()} ${status?.system_name || "OOAPI"}`}</span><div>{motion && !motion.reduced && <Button type="text" size="small" icon={motion.paused ? <CaretRightOutlined/> : <PauseOutlined/>} onClick={motion.toggle} aria-label={motion.paused ? "播放动效" : "暂停动效"}>{motion.paused ? "播放动效" : "暂停动效"}</Button>}<Link to="/#quickstart">接入文档</Link>{status?.contact_email && <a href={`mailto:${status.contact_email}`}>联系我们</a>}{status?.icp_number && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">{status.icp_number}</a>}{status?.police_number && <span>{status.police_number}</span>}</div></footer>;
}
