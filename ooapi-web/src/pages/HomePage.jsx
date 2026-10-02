import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "antd";
import { ApiOutlined, ArrowRightOutlined, CheckOutlined, CodeOutlined, DashboardOutlined, KeyOutlined, MessageOutlined, HomeOutlined, FileTextOutlined, TeamOutlined, WalletOutlined, MonitorOutlined, PauseOutlined, CaretRightOutlined } from "@ant-design/icons";
import { useApp } from "../context/AppContext";
import { API } from "../services/api";
import { apiEndpoint } from "../services/format";
import { safeHref } from "../components/Markdown";
import { StudioPage, StudioHeader, StudioFooter, StudioCat, useStudioMotion } from "../components/StudioUI";
import { ConnectionDemo, ProviderDemo, UsageDemo } from "../components/HomeExperience";
import ProviderExplorer from "../components/ProviderExplorer";
import BrandLogo from "../components/BrandLogo";
import HomeWallpaper from "../components/HomeWallpaper";
import HomeQuickstart from "../components/HomeQuickstart";
import StudioBento from "../components/StudioBento";
import StudioCompanion from "../components/StudioCompanion";
import StudioWindow, { useStudioCarousel } from "../components/StudioWindow";
import "../home-refresh.css";
import "../home-desktop.css";

const TABS = [
  { key: "connect", label: "连接你的应用", icon: <CodeOutlined />, kicker: "01 / CONNECT", title: <>兼容现有 SDK</>, text: "创建应用令牌并设置网关地址，即可通过以下协议调用模型。", points: ["Chat Completions", "Anthropic Messages", "OpenAI Responses"], link: "#quickstart", action: "查看接入指南" },
  { key: "vendors", label: "选择模型与厂商", icon: <ApiOutlined />, kicker: "02 / EXPLORE", title: <>已集成的模型厂商</>, text: "查看各厂商支持的接入方式。可用模型由账户分组和令牌权限决定。", points: ["真实厂商目录", "分组与模型权限", "多渠道调度"], link: "#providers", action: "查看厂商目录" },
  { key: "usage", label: "查看调用用量", icon: <DashboardOutlined />, kicker: "03 / UNDERSTAND", title: <>调用明细与用量</>, text: "查询 Token 用量、响应耗时、调用状态和实际扣费。", points: ["用量与消费明细", "调用结果与耗时", "个人数据看板"], link: "/console", action: "打开数据看板" },
];

function scrollHomeSection(id, behavior = "smooth") {
  if (id === "top") document.querySelector(".studio-window-scroll")?.scrollTo({ top: 0, behavior });
  else document.getElementById(id)?.scrollIntoView({ behavior, block: "start" });
}

export default function HomePage() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const { status, user } = useApp();
  const motion = useStudioMotion();
  const [providers, setProviders] = useState(__OOAPI_PUBLIC_CATALOG__);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState("connect");
  const [companionPose, setCompanionPose] = useState("wave");
  const [windowOpen, setWindowOpen] = useState(true);
  const [carouselPaused, setCarouselPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inView, setInView] = useState(false);
  const experienceRef = useRef(null);
  const name = status?.system_name || "OOAPI";
  const entry = user ? "/console" : status?.password_register_enabled === true ? "/register" : "/login";
  const entryLabel = user ? "进入工作台" : status?.password_register_enabled === true ? "注册账户" : "登录工作台";
  const endpoint = apiEndpoint(status?.api_endpoint);
  const customDocs = safeHref(status?.docs_link);
  const externalDocs = customDocs && !/docs\.newapi\.pro/i.test(customDocs) && !["/#quickstart", "#quickstart"].includes(customDocs) ? customDocs : "";
  const tabs = TABS.filter((t) => t.key !== "vendors" || status?.home_show_models !== false);
  const active = tabs.find((t) => t.key === tab) || tabs[0];
  const progressRef = useStudioCarousel({ active: active.key, enabled: motion.active && windowOpen && inView && !carouselPaused && !hovered && !focused,
    onNext: () => setTab(tabs[(tabs.findIndex((t) => t.key === active.key) + 1) % tabs.length].key) });
  const demoMotion = { ...motion, active: motion.active && windowOpen && inView && !carouselPaused };
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: .15 });
    if (experienceRef.current) observer.observe(experienceRef.current);
    return () => observer.disconnect();
  }, []);
  const openAnchor = (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault(); setWindowOpen(true);
    navigate({ pathname: "/", hash: a.getAttribute("href") });
    requestAnimationFrame(() => scrollHomeSection(a.getAttribute("href").slice(1), motion.active ? "smooth" : "instant"));
  };
  useEffect(() => {
    let activeRequest = true;
    setError("");
    API.get("/catalog").then((d) => { if (activeRequest) setProviders(d.providers || []); })
      .catch(() => { if (activeRequest) setProviders(__OOAPI_PUBLIC_CATALOG__); });
    return () => { activeRequest = false; };
  }, [retry]);
  useEffect(() => {
    if (hash) { setWindowOpen(true); requestAnimationFrame(() => scrollHomeSection(hash.slice(1), "instant")); }
  }, [hash, providers]);

  return <StudioPage motion={motion} className="studio-home studio-desktop" onClickCapture={openAnchor}>
    <StudioHeader status={status} motion={motion} user={user} />
    <HomeWallpaper />
    <aside className="studio-shortcuts shortcuts-left" aria-label="桌面快捷入口">
      {[[<HomeOutlined />, '首页', '#top'], [<ApiOutlined />, '工作方式', '#products'], ...(status?.home_show_models !== false ? [[<CodeOutlined />, '厂商目录', '#providers']] : []), [<FileTextOutlined />, '接入文档', '#quickstart'], [<MessageOutlined />, '开始对话', '/chat']].map(([icon, label, href]) => <a key={label} href={href}><span>{icon}</span><b>{label}</b></a>)}
    </aside>
    <aside className="studio-shortcuts shortcuts-right" aria-label="工作台快捷入口">
      {[[<DashboardOutlined />, '数据看板', '/console'], [<KeyOutlined />, 'API 令牌', '/token'], [<FileTextOutlined />, '使用记录', '/log'], [<TeamOutlined />, '社区', '/community'], ...(user?.role >= 100 ? [[<MonitorOutlined />, '运维监控', '/admin/monitor']] : [])].map(([icon, label, href]) => <a key={label} href={href}><span>{icon}</span><b>{label}</b></a>)}
    </aside>
    <StudioCompanion motion={motion} preferredPose={companionPose} />
    {!windowOpen && <div className="studio-desktop-welcome"><StudioCat pose="code" /><h2>首页窗口已收起</h2><p>可以通过两侧快捷入口打开功能。</p><Button className="studio-button" onClick={() => setWindowOpen(true)}>重新打开首页 <ArrowRightOutlined /></Button></div>}
    <StudioWindow name={name} open={windowOpen} onClose={() => setWindowOpen(false)} motion={motion}>
      <Link to="/" className="studio-wordmark"><BrandLogo size={35}/><strong>{name}</strong></Link>
      <section className="studio-hero">
        <div className="studio-hero-copy" data-reveal>
          <span className="studio-eyebrow"><span className="studio-status-dot" /> 多模型 API 服务</span>
          <h1>多模型<br /><em>API 网关</em><span className="studio-title-star" aria-hidden="true">✳</span></h1>
          <p>统一模型接入、应用令牌和用量计费。<br />兼容现有 SDK，支持多渠道调度。</p>
          <div className="studio-hero-actions"><Link className="studio-button" to={entry}>{entryLabel}<ArrowRightOutlined /></Link><a className="studio-text-link" href="#products">查看功能演示 <span>↘</span></a></div>
          <div className="studio-hero-note"><span><CheckOutlined /> 三种兼容协议</span><span><CheckOutlined /> 按实际用量计费</span></div>
        </div>
        <div className="studio-start-wrap" data-reveal>
          <StudioCat pose="peek" className="studio-start-cat" eager />
          <div className="studio-start-card"><h2><strong><BrandLogo size={21}/> {name}</strong> 控制台</h2><ul><li><CheckOutlined /> 三种兼容协议，连接已有应用</li><li><CheckOutlined /> 独立应用令牌，额度与权限可控</li><li><CheckOutlined /> 按实际用量计费，调用明细可查</li></ul><div><Link className="studio-button" to={entry}>{entryLabel}</Link><a className="studio-button studio-button-secondary" href="#quickstart">阅读接入指南</a></div></div>
        </div>
      </section>



      <section ref={experienceRef} className="studio-section studio-experience" id="products" data-reveal
        onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
        <div className="studio-section-heading"><div><span className="studio-eyebrow">功能介绍</span><h2>平台功能</h2></div><p>选择下方标签查看功能。</p></div>
        <div className="studio-experience-tabs" role="tablist" aria-label="产品能力">{tabs.map((t) => <button type="button" key={t.key} id={`home-tab-${t.key}`} role="tab" aria-selected={active.key === t.key} aria-controls="home-product-panel" tabIndex={active.key === t.key ? 0 : -1} onClick={() => setTab(t.key)} onKeyDown={(e) => {
          const index = tabs.findIndex((item) => item.key === t.key);
          const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : e.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
          if (next >= 0) { e.preventDefault(); setTab(tabs[next].key); document.getElementById(`home-tab-${tabs[next].key}`)?.focus(); }
        }}>{t.icon}{t.label}<span className="studio-tab-progress" aria-hidden="true">{active.key === t.key && <i ref={progressRef} />}</span></button>)}</div>
        <div className={`studio-experience-panel panel-${active.key}`} id="home-product-panel" role="tabpanel" aria-labelledby={`home-tab-${active.key}`}>
          {!motion.reduced && <Button className="studio-panel-pause" type="text" icon={carouselPaused ? <CaretRightOutlined /> : <PauseOutlined />} aria-label={carouselPaused ? "继续自动演示" : "暂停自动演示"} onClick={() => setCarouselPaused((v) => !v)} />}
          <div className="studio-demo-stage" key={active.key}>{active.key === "connect" ? <ConnectionDemo endpoint={endpoint} motion={demoMotion} /> : active.key === "vendors" ? <ProviderDemo providers={providers} error={error} name={name} motion={demoMotion} /> : <UsageDemo motion={demoMotion} />}</div>
          <div className="studio-experience-copy" key={`${active.key}-copy`}><span className="studio-eyebrow">{active.kicker}</span><h3>{active.title}</h3><p>{active.text}</p><ul>{active.points.map((point) => <li key={point}><CheckOutlined />{point}</li>)}</ul><a className="studio-text-link" href={active.link}>{active.action}<ArrowRightOutlined /></a><span className="studio-drawn-spark" aria-hidden="true">✳</span></div>
        </div>
      </section>

      {status?.home_show_models !== false && <ProviderExplorer providers={providers || []} />}

      <StudioBento motion={motion} onCompanionChange={setCompanionPose} />

      <HomeQuickstart endpoint={endpoint} docs={externalDocs}/>

      <section className="studio-last-call" data-reveal><div><span className="studio-eyebrow">WORKSPACE</span><h2>进入工作台</h2><Link to={entry} className="studio-button">{entryLabel}<ArrowRightOutlined /></Link></div><StudioCat pose="nap" /><span className="studio-sleep-z" aria-hidden="true">z <i>z</i> <b>z</b></span></section>
      <StudioFooter status={status} motion={motion} />
    </StudioWindow>
  </StudioPage>;
}
