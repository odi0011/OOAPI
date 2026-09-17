import React from "react";
import { Button, Space, App as AntApp } from "antd";
import {
  ApiOutlined,
  SafetyCertificateOutlined,
  FundOutlined,
  KeyOutlined,
  ArrowRightOutlined,
  CopyOutlined,
  MessageOutlined,
  BulbOutlined,
  CheckOutlined,
  CodeOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import ThemeSwitch from "../components/ThemeSwitch";
import "../home-refresh.css";
import { odRateText, unitsPerOd } from "../services/format";

const FEATURES = [
  { icon: <ApiOutlined />, title: "统一接入，让连接更简单", desc: "通过一套 OpenAI 兼容接口接入模型，在现有应用中配置 baseURL 与 API Key。", tags: ["OpenAI 兼容", "统一接口"], kind: "connection" },
  { icon: <KeyOutlined />, title: "每个应用，都有自己的令牌", desc: "独立签发 API Key，设置额度上限、模型白名单与过期时间，让使用边界更清晰。", tags: ["额度上限", "模型白名单", "过期时间"], kind: "keys" },
  { icon: <FundOutlined />, title: "消耗有明细，账单有依据", desc: "按 token 消耗计费，在控制台查看余额与请求明细，了解每一次调用的用量。", tags: ["用量明细", "余额查询"], kind: "billing" },
  { icon: <SafetyCertificateOutlined />, title: "访问可管理，调用可追溯", desc: "通过账号鉴权与令牌管理控制访问，结合调用日志排查问题。", tags: ["账号鉴权", "调用日志"], kind: "security" },
];

function ConversationPreview() {
  return (
    <figure className="hr-preview" aria-labelledby="hr-preview-caption">
      <div className="hr-window">
        <div className="hr-window-bar">
          <span className="hr-window-dots" aria-hidden="true"><i /><i /><i /></span>
          <span><MessageOutlined /> 对话工作台</span>
          <span className="hr-example">示例</span>
        </div>
        <div className="hr-workspace">
          <aside className="hr-preview-sidebar" aria-label="示例会话信息">
            <div className="hr-sidebar-brand"><ApiOutlined /> 工作空间</div>
            <span className="hr-small-label">当前对话</span>
            <div className="hr-selected-thread"><MessageOutlined /> 规划一个知识库</div>
            <div className="hr-sidebar-note"><BulbOutlined /><p>从一个问题开始，<br />到一份清晰的方案。</p></div>
            <span className="hr-sidebar-foot">对话 · 智能体 · API</span>
          </aside>
          <div className="hr-conversation">
            <div className="hr-conversation-head"><strong>个人知识库方案</strong><span>智能体对话 · 示例</span></div>
            <div className="hr-user-message"><span className="hr-small-label">你</span><p>帮我规划一个个人知识管理系统的技术选型。</p></div>
            <div className="hr-assistant-message">
              <div className="hr-assistant-avatar" aria-hidden="true"><BulbOutlined /></div>
              <div className="hr-assistant-content">
                <strong>规划助手 <span className="hr-small-label">示例回复</span></strong>
                <p>先拆解需求，再比较方案，最后整理实施建议。</p>
                <div className="hr-plan">
                  <div className="hr-plan-title"><BulbOutlined /><strong>任务规划</strong><span>示例步骤</span></div>
                  <ol>
                    <li><span className="hr-step-mark"><CheckOutlined /></span><div><strong>明确使用场景</strong><span>笔记收集、分类整理与内容检索</span></div></li>
                    <li><span className="hr-step-mark"><CheckOutlined /></span><div><strong>比较技术方案</strong><span>从维护成本与扩展需求出发</span></div></li>
                    <li><span className="hr-step-mark"><CheckOutlined /></span><div><strong>整理实施建议</strong><span>先完成核心流程，再逐步扩展</span></div></li>
                  </ol>
                </div>
                <p className="hr-preview-answer">建议先构建轻量版本，围绕「记录 → 整理 → 检索」完成最小可用闭环。</p>
              </div>
            </div>
            <div className="hr-preview-composer"><span>继续讨论你的想法…</span><span>静态示例 · 不发送请求</span></div>
          </div>
        </div>
      </div>
      <figcaption id="hr-preview-caption">产品交互示意 · 规划与回复呈现在同一段对话中，非实时任务或运行状态。</figcaption>
    </figure>
  );
}

export default function HomePage() {
  const { status, user } = useApp();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const endpoint = status?.api_endpoint || "https://your-domain/v1";
  const systemName = status?.system_name || "OOAPI";
  // 管理员关闭注册后，首页不再引导用户去 /register（否则点进去只会看到关闭提示）
  const registerOpen = status?.password_register_enabled !== false;
  const quotaLabel = status?.units_per_od || status?.quota_per_unit
    ? odRateText(unitsPerOd(status))
    : "额度换算以控制台配置为准";

  // Keep this local: the shared helper does not check execCommand's return value.
  const copyEndpoint = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(endpoint);
      } else {
        const previousFocus = document.activeElement;
        const textarea = document.createElement("textarea");
        textarea.value = endpoint;
        textarea.readOnly = true;
        textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) throw new Error("Copy failed");
        } finally {
          textarea.remove();
          previousFocus?.focus?.({ preventScroll: true });
        }
      }
      message.success("接口地址已复制");
    } catch {
      message.error("复制失败，请选中接口地址手动复制");
    }
  };

  const curlExample = `curl ${endpoint.replace(/\/+$/, "")}/chat/completions \\
  -H "Authorization: Bearer sk-xxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "user", "content": "你好"}
    ],
    "stream": true
  }'`;

  return (
    <div className="hr-home">
      <a className="hr-skip-link" href="#hr-main">跳转到主要内容</a>
      <header className="hr-header">
        <div className="hr-header-inner">
          <div className="hr-brand"><img src={status?.logo || "/logo.jpg"} alt="" /><span>{systemName}</span></div>
          <nav className="hr-nav" aria-label="首页导航"><a href="#hr-features">平台能力</a><a href="#hr-quickstart">快速接入</a></nav>
          <Space size={8} className="hr-header-actions">
            <ThemeSwitch size="small" />
            {user ? <Button type="primary" onClick={() => navigate("/console")}>控制台</Button> : <><Button onClick={() => navigate("/login")}>登录</Button>{registerOpen ? <Button type="primary" onClick={() => navigate("/register")}>开始使用</Button> : null}</>}
          </Space>
        </div>
      </header>
      <main id="hr-main">
        <section className="hr-hero" aria-labelledby="hr-title">
          <div className="hr-atmosphere" aria-hidden="true"><div className="hr-glow hr-glow-one" /><div className="hr-glow hr-glow-two" /></div>
          <div className="hr-container hr-hero-content">
            <div className="hr-eyebrow"><ApiOutlined /><span>OpenAI 兼容接口</span><span className="hr-eyebrow-separator" />为你的下一次构建</div>
            <h1 id="hr-title">连接模型的能力，<br /><span>专注创造的可能。</span></h1>
            <p className="hr-hero-description">{status?.about || "从第一段对话，到你的下一个 AI 应用。统一接入大模型，集中管理令牌、用量与账单，让想法更快进入实践。"}</p>
            <div className="hr-hero-actions">
              <Button type="primary" size="large" icon={<ArrowRightOutlined />} onClick={() => navigate(user ? "/console" : registerOpen ? "/register" : "/login")}>{user ? "进入控制台" : registerOpen ? "开始构建" : "登录使用"}</Button>
              <Button size="large" href="#hr-quickstart">查看接入示例</Button>
              {!user && <a className="hr-login-link" href="/login" onClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigate("/login"); } }}>已有账号？登录</a>}
            </div>
            <div className="hr-endpoint"><span>{status?.api_endpoint ? "API 地址" : "示例地址"}</span><code>{endpoint}</code><Button type="text" icon={<CopyOutlined />} onClick={copyEndpoint} aria-label="复制接口地址" title="复制接口地址" /></div>
            <ConversationPreview />
          </div>
        </section>
        <div className="hr-container">
          <section className="hr-section" id="hr-features" aria-labelledby="hr-features-title">
            <div className="hr-section-heading"><div><span className="hr-kicker">01 / 平台能力</span><h2 id="hr-features-title">连接之外，管理也井然有序。</h2></div><p>从接口到令牌，从用量到日志。<br />把常用能力放在同一个工作空间。</p></div>
            <div className="hr-bento">
              {FEATURES.map((feature, index) => <article className={`hr-feature hr-feature-${feature.kind}`} key={feature.kind}>
                <div className="hr-feature-top"><span className="hr-feature-icon">{feature.icon}</span><span className="hr-feature-number">0{index + 1}</span></div>
                <h3>{feature.title}</h3><p>{feature.desc}</p>
                {index === 0 && <div className="hr-connection-diagram" aria-label="应用通过统一 API 接入模型"><span>你的应用</span><span aria-hidden="true">→</span><strong><ApiOutlined /> 统一 API</strong><span aria-hidden="true">→</span><span>模型</span></div>}
                <div className="hr-feature-tags">{feature.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              </article>)}
            </div>
          </section>
          <section className="hr-section hr-quickstart" id="hr-quickstart" aria-labelledby="hr-quickstart-title">
            <div className="hr-section-heading"><div><span className="hr-kicker">02 / 快速接入</span><h2 id="hr-quickstart-title">从第一条请求开始。</h2></div><p>沿用熟悉的调用方式，<br />配置地址与令牌即可开始接入。</p></div>
            <div className="hr-start-grid">
              <div className="hr-start-steps">
                <ol>
                  <li><span>01</span><div><h3>创建你的 API Key</h3><p>注册并登录，在「令牌管理」创建独立令牌。</p></div></li>
                  <li><span>02</span><div><h3>设置接口地址</h3><p>将 baseURL 指向下方地址。未配置时显示示例域名。</p><code>{endpoint}</code></div></li>
                  <li><span>03</span><div><h3>发起第一条请求</h3><p>请求头携带 Authorization: Bearer 和你的令牌，选择可用模型。</p></div></li>
                </ol>
                <div className="hr-quota"><FundOutlined /><span>{quotaLabel}</span></div>
              </div>
              <div className="hr-code-panel">
                <div className="hr-code-header"><span><CodeOutlined /> 第一条请求</span><span>cURL · 示例</span></div>
                <pre tabIndex={0} aria-label="cURL 请求示例"><code>{curlExample}</code></pre>
                <p className="hr-code-note">请替换示例地址与 sk-xxx；模型名称及可用性以平台配置为准。</p>
              </div>
            </div>
          </section>
          <section className="hr-closing" aria-labelledby="hr-closing-title"><div><span className="hr-kicker">把想法变成下一步</span><h2 id="hr-closing-title">准备好，开始你的构建。</h2><p>从一次对话或一条 API 请求开始。</p></div><Button size="large" type="primary" icon={<ArrowRightOutlined />} onClick={() => navigate(user ? "/console" : "/register")}>{user ? "打开控制台" : "创建账号"}</Button></section>
        </div>
      </main>
      <footer className="hr-footer hr-container"><span>{status?.footer || `© ${new Date().getFullYear()} ${systemName}`}</span><Space size={20}>{status?.docs_link && <a href={status.docs_link} target="_blank" rel="noreferrer">文档 <ArrowRightOutlined /></a>}<span>v{status?.version || "0.1.0"}</span></Space></footer>
    </div>
  );
}
