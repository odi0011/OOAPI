import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Alert, App as AntApp, Button, Empty, Skeleton } from "antd";
import { ApiOutlined, ArrowRightOutlined, CheckOutlined, CodeOutlined, CopyOutlined, DashboardOutlined, FileTextOutlined, HomeOutlined, KeyOutlined, MessageOutlined, MonitorOutlined, TeamOutlined, WalletOutlined, ExpandOutlined, CompressOutlined } from "@ant-design/icons";
import { useApp } from "../context/AppContext";
import { API } from "../services/api";
import { apiEndpoint, copyText } from "../services/format";
import { VendorIcon } from "../components/VendorIcon";
import ThemeSwitch from "../components/ThemeSwitch";
import { safeHref } from "../components/Markdown";
import "../home-refresh.css";

const PROTOCOLS = [
  { name: "Chat Completions", path: "/v1/chat/completions", note: "OpenAI 兼容对话" },
  { name: "Messages", path: "/v1/messages", note: "Anthropic 兼容消息" },
  { name: "Responses", path: "/v1/responses", note: "OpenAI Responses" },
];
const FEATURES = [
  { icon: <ApiOutlined />, title: "统一 API", text: "通过三种兼容协议接入应用，按模型与分组分发请求。", href: "#quickstart" },
  { icon: <KeyOutlined />, title: "应用令牌", text: "为应用创建独立密钥，设置额度、有效期与模型范围。", href: "/token" },
  { icon: <MessageOutlined />, title: "对话工作台", text: "在浏览器中使用模型，管理会话、附件与智能体工具。", href: "/chat" },
  { icon: <WalletOutlined />, title: "用量与账单", text: "按输入、输出与缓存用量计费，每次扣费都有记录。", href: "/log" },
  { icon: <DashboardOutlined />, title: "数据看板", text: "查看自己的调用趋势、模型消费和账户余额。", href: "/console" },
  { icon: <TeamOutlined />, title: "社区与消息", text: "交流接入经验，在社区讨论，通过私信保持联系。", href: "/community" },
];
function DesktopLink({ icon, label, href }) {
  return <a className="home-shortcut" href={href}><span>{icon}</span><b>{label}</b></a>;
}

export default function HomePage() {
  const { hash } = useLocation();
  const { status, user } = useApp();
  const { message } = AntApp.useApp();
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState("connect");
  const [expanded, setExpanded] = useState(false);
  const systemName = status?.system_name || "OOAPI";
  const entry = user ? "/console" : status?.password_register_enabled === true ? "/register" : "/login";
  const entryLabel = user ? "进入控制台" : status?.password_register_enabled === true ? "创建账号" : "登录使用";
  const endpoint = apiEndpoint(status?.api_endpoint);
  // 旧服务端的模板文档地址也要兜底；站长的自定义文档保留为扩展入口。
  const customDocs = safeHref(status?.docs_link);
  const externalDocs = customDocs && !/docs\.newapi\.pro/i.test(customDocs) && !["/#quickstart", "#quickstart"].includes(customDocs) ? customDocs : "";
  useEffect(() => {
    let active = true;
    setError("");
    API.get("/catalog").then((d) => { if (active) setProviders(d.providers || []); })
      .catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [retry]);
  useEffect(() => {
    // 从看板的站内链接进入文档时，React Router 不会替新挂载的页面滚动到锚点。
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash, providers]);
  const copy = async (value) => {
    try { await copyText(value); message.success("已复制"); }
    catch { message.error("复制失败，请手动选择复制"); }
  };
  const docsCommand = `curl ${endpoint}/models -H "Authorization: Bearer your-api-key"`;

  return <div className={`home-desktop${expanded ? " is-expanded" : ""}`}>
    <div className="home-wallpaper" aria-hidden="true" />
    <header className="home-menubar">
      <a href="#top" className="home-menu-brand" aria-label={`${systemName} 首页`}><img src={status?.logo || "/logo.jpg"} alt="" /><strong>{systemName}</strong></a>
      <nav aria-label="首页导航"><a href="#products">产品</a>{status?.home_show_models !== false && <a href="#providers">厂商</a>}{status?.home_show_pricing !== false && <Link to="/pricing">定价</Link>}<a href="#quickstart">文档</a><Link to="/community">社区</Link></nav>
      <div className="home-menu-actions"><Link className="home-button home-button-small" to={entry}>{entryLabel} <ArrowRightOutlined /></Link><ThemeSwitch size="small" /></div>
    </header>
    <aside className="home-dock home-dock-left" aria-label="桌面快捷入口">
      <DesktopLink icon={<HomeOutlined />} label="首页" href="#top" />
      <DesktopLink icon={<ApiOutlined />} label="统一接入" href="#products" />
      {status?.home_show_models !== false && <DesktopLink icon={<CodeOutlined />} label="厂商目录" href="#providers" />}
      {status?.home_show_pricing !== false && <DesktopLink icon={<WalletOutlined />} label="模型定价" href="/pricing" />}
      <DesktopLink icon={<FileTextOutlined />} label="接入文档" href="#quickstart" />
      <DesktopLink icon={<MessageOutlined />} label="开始对话" href="/chat" />
    </aside>
    <aside className="home-dock home-dock-right" aria-label="工作台快捷入口">
      <DesktopLink icon={<DashboardOutlined />} label="数据看板" href="/console" />
      <DesktopLink icon={<KeyOutlined />} label="API 令牌" href="/token" />
      <DesktopLink icon={<FileTextOutlined />} label="使用记录" href="/log" />
      <DesktopLink icon={<TeamOutlined />} label="社区" href="/community" />
      {user?.role >= 100 && <DesktopLink icon={<MonitorOutlined />} label="运维监控" href="/admin/monitor" />}
    </aside>
    <main className="home-window" id="top">
      <div className="home-window-bar"><span>{systemName} / 首页</span><Button type="text" size="small" icon={expanded ? <CompressOutlined /> : <ExpandOutlined />} aria-label={expanded ? "还原窗口" : "展开窗口"} onClick={() => setExpanded(!expanded)} /></div>
      <div className="home-window-content">
        <a href="#top" className="home-wordmark"><img src={status?.logo || "/logo.jpg"} alt="" /><strong>{systemName}</strong><span>让模型连接你的应用</span></a>
        <section className="home-hero">
          <div><h1>你的模型，<br /><mark>一个入口。</mark></h1><p>把<span className="home-highlight">模型接入、令牌分发、<br className="home-desktop-break" />用量计费</span>放在一起。<br />从第一条请求，到每天的工作流。</p><p className="home-hero-note">为开发者和团队准备的大模型 API 工作台。</p></div>
          <div className="home-start-card"><h2>从 <strong>{systemName}</strong> 开始构建</h2><ul><li><CheckOutlined /> 三种兼容协议，接入已有应用</li><li><CheckOutlined /> 每个应用，独立的 API 令牌</li><li><CheckOutlined /> 按实际用量计费，消费明细可查</li></ul><div className="home-start-actions"><Link className="home-button" to={entry}>{entryLabel}</Link><a className="home-button is-secondary" href="#quickstart">阅读接入指南</a></div><small>1 OD币 = 1 美元 · 价格以模型定价页为准</small></div>
        </section>
        <section className={`home-showcase home-showcase-${tab}`} id="products">
          <div className="home-tabs" role="tablist" aria-label="产品能力">{[['connect', '连接你的应用'], ...(status?.home_show_models !== false ? [['vendors', '选择模型与厂商']] : []), ['usage', '掌握每一次调用']].map(([value, label]) => <button key={value} id={`home-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="home-product-panel" tabIndex={tab === value ? 0 : -1} onKeyDown={(e) => { const tabs = [...e.currentTarget.parentElement.children]; const index = tabs.indexOf(e.currentTarget); const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : e.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1; if (next >= 0) { e.preventDefault(); tabs[next].focus(); tabs[next].click(); } }} onClick={() => setTab(value)}>{label}</button>)}</div>
          <div className="home-showcase-body" id="home-product-panel" role="tabpanel" aria-labelledby={`home-tab-${tab}`}>
            <div className="home-demo-window">
              <div className="home-demo-title"><span><i /><i /><i /></span><b>{tab === 'connect' ? 'gateway.config' : tab === 'vendors' ? 'providers.directory' : 'request.lifecycle'}</b><CodeOutlined /></div>
              {tab === "connect" ? <div className="home-protocol-demo"><div className="home-gateway-mark"><img src={status?.logo || "/logo.jpg"} alt="" /><b>{systemName} Gateway</b><span>一个入口，三种协议</span></div>{PROTOCOLS.map((p) => <div className="home-protocol-row" key={p.path}><ApiOutlined /><div><b>{p.name}</b><code>{p.path}</code></div><ArrowRightOutlined /></div>)}</div>
                : tab === "vendors" ? <div className="home-provider-demo"><h3>系统已集成的厂商</h3>{providers?.length ? <div className="home-provider-cloud">{providers.slice(0, 12).map((p) => <span key={p.key}><VendorIcon type={p.icon} size={24} />{p.name}</span>)}</div> : <p>{error ? "厂商目录暂不可用" : providers ? "尚未登记厂商" : "正在读取厂商目录…"}</p>}<small>来自平台厂商注册表，不代表当前账号的可用模型。</small></div>
                : <div className="home-lifecycle"><h3>从请求到用量记录</h3>{[['01', '携带应用令牌', '校验额度、模型权限与分组'], ['02', '路由到上游渠道', '按渠道优先级和权重调度'], ['03', '返回模型响应', '支持流式输出与非流式响应'], ['04', '记录实际用量', '输入 / 输出 / 缓存 / 消费']].map(([n, title, desc]) => <div key={n}><b>{n}</b><span><strong>{title}</strong><small>{desc}</small></span></div>)}</div>}
            </div>
            <div className="home-showcase-copy"><span className="home-eyebrow">{tab === 'connect' ? 'BUILD WITH OOAPI' : tab === 'vendors' ? 'YOUR MODELS, CONNECTED' : 'KNOW YOUR USAGE'}</span><h2>{tab === 'connect' ? '熟悉的接口。\n更直接的连接。' : tab === 'vendors' ? '让不同的模型，\n进入同一个工作流。' : '用得明白，\n花得清楚。'}</h2><p>{tab === 'connect' ? '将应用的 API 地址指向 OOAPI，使用平台令牌发起请求。在工作台中调试，再接入你的产品。' : tab === 'vendors' ? '厂商、接入方式与模型权限由平台统一管理。登录后，按你的分组与令牌查看实际可调用的模型。' : '查看每次调用的模型、耗时、Token 明细和扣费。个人看板与平台看板分开呈现，统计范围清晰可见。'}</p><a className="home-button" href={tab === 'connect' ? '#quickstart' : tab === 'vendors' ? '#providers' : '/console'}>{tab === 'connect' ? '接入第一个应用' : tab === 'vendors' ? '打开厂商目录' : '打开数据看板'} <ArrowRightOutlined /></a><div className="home-capabilities"><span><ApiOutlined /> 三种协议</span><span><KeyOutlined /> 独立令牌</span><span><MessageOutlined /> 对话工作台</span><span><DashboardOutlined /> 用量分析</span></div></div>
          </div>
        </section>
        {status?.home_show_models !== false && <section className="home-section" id="providers"><div className="home-section-heading"><div><span className="home-eyebrow">CONNECTED ECOSYSTEM</span><h2>你的模型工具箱</h2></div><span>{providers ? `${providers.length} 个已集成厂商` : '厂商目录'}</span></div><p>直接使用平台现有的厂商与接入方式。具体模型的可用性，以登录后的模型列表为准。</p>{error ? <Alert type="warning" showIcon message="厂商目录加载失败" description={error} action={<Button size="small" onClick={() => setRetry(retry + 1)}>重试</Button>} /> : providers === null ? <Skeleton active paragraph={{ rows: 3 }} /> : providers.length ? <div className="home-vendor-grid">{providers.map((p) => <div className="home-vendor" key={p.key}><VendorIcon type={p.icon} size={30} /><div><strong>{p.name}</strong><small title={p.methods.join(' · ')}>{p.methods.join(' · ')}</small></div></div>)}</div> : <Empty description="暂无已登记厂商" image={Empty.PRESENTED_IMAGE_SIMPLE} />}</section>}
        <section className="home-section"><span className="home-eyebrow">EVERYTHING IN ONE PLACE</span><h2>接入之后，还有这些。</h2><div className="home-feature-grid">{FEATURES.map((f) => <a key={f.title} href={f.href}><span>{f.icon}</span><h3>{f.title} <ArrowRightOutlined /></h3><p>{f.text}</p></a>)}</div></section>
        <section className="home-section home-guide" id="quickstart"><div><span className="home-eyebrow">OOAPI DOCUMENTATION</span><h2>第一条请求，<br />从这里开始。</h2><ol><li><b>创建应用令牌</b><p>登录后打开「令牌管理」，为应用创建密钥。</p></li><li><b>配置 API 地址</b><p>将客户端 Base URL 设置为本站网关地址。</p></li><li><b>获取可用模型</b><p>通过下方请求读取当前令牌可用的模型 ID，再发起对话。</p></li></ol>{externalDocs && <a href={externalDocs} target="_blank" rel="noreferrer">更多文档 <ArrowRightOutlined /></a>}</div><div className="home-guide-code"><div className="home-code-heading"><b>Base URL</b><Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(endpoint)} aria-label="复制 API 地址" /></div><code className="home-endpoint">{endpoint}</code><div className="home-code-heading"><b>查询可用模型 / cURL</b><Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(docsCommand)} aria-label="复制接入示例" /></div><pre><code>{docsCommand}</code></pre><p>将 your-api-key 替换为你的平台令牌。模型权限随令牌与分组变化，请使用接口实际返回的 ID。</p><div className="home-doc-protocols">{PROTOCOLS.map((p) => <div key={p.path}><span>{p.note}</span><code>{p.path}</code></div>)}</div></div></section>
        <footer className="home-footer"><div><strong>{systemName}</strong><span>{status?.footer || `© ${new Date().getFullYear()} ${systemName} · 大模型 API 网关`}</span></div><div><a href="#quickstart">接入文档</a>{status?.contact_email && <a href={`mailto:${status.contact_email}`}>联系我们</a>}{status?.icp_number && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">{status.icp_number}</a>}{status?.police_number && <span>{status.police_number}</span>}</div></footer>
      </div>
    </main>
  </div>;
}
