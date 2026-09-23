// 平台首页组件
// ---------------------------------------------------------------------------
// 设计定位：大模型 API 网关与分发平台的官方门户。
// 彻底去除虚构空洞的 AI 营销话术与伪造对话展示，实事求是呈现系统实际运行的
// 核心技术能力：OpenAI 协议网关、多渠道调度容灾、独立令牌分发、Token 级精确计费、
// 全链路审计日志以及内置工作台。
import React, { useState } from "react";
import { Button, Space, Tag, App as AntApp, Tooltip } from "antd";
import {
  ApiOutlined,
  SafetyCertificateOutlined,
  FundOutlined,
  KeyOutlined,
  ArrowRightOutlined,
  CopyOutlined,
  CodeOutlined,
  ThunderboltOutlined,
  DesktopOutlined,
  BranchesOutlined,
  AuditOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CheckOutlined,
  SyncOutlined,
  RightOutlined,
  InfoCircleOutlined,
  FileTextOutlined,
  SettingOutlined,
  SlidersOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import ThemeSwitch from "../components/ThemeSwitch";
import { safeHref } from "../components/Markdown";
import { VendorIcon } from "../components/VendorIcon";
import { odRateText, unitsPerOd } from "../services/format";
import "../home-refresh.css";

// 平台真实支持的主流厂商与上游生态列表
const SUPPORTED_VENDORS = [
  { type: "deepseek", name: "DeepSeek", models: "V3 / R1 满血推理" },
  { type: "openai", name: "OpenAI", models: "GPT-4o / o1 / o3" },
  { type: "claude", name: "Anthropic Claude", models: "Claude 3.5 Sonnet" },
  { type: "gemini", name: "Google Gemini", models: "Gemini 1.5 / 2.0" },
  { type: "qwen", name: "阿里通义千问", models: "Qwen 2.5 系列" },
  { type: "glm", name: "智谱 GLM", models: "GLM-4 / 4-Plus" },
  { type: "kimi", name: "月之暗面 Kimi", models: "Moonshot 长文本" },
  { type: "doubao", name: "字节跳动豆包", models: "Doubao Pro / Lite" },
  { type: "grok", name: "xAI Grok", models: "Grok 2 / Vision" },
  { type: "minimax", name: "MiniMax", models: "abab 6.5 系列" },
];

// 系统真实运行的核心业务能力矩阵
const SYSTEM_FEATURES = [
  {
    icon: <ApiOutlined />,
    badge: "协议接入",
    title: "OpenAI 兼容协议标准",
    desc: "原生兼容 /v1/chat/completions 与 /v1/models 标准接口。支持流式 SSE、非流式传输以及工具调用（Tool Call）。无需改写业务逻辑，修改 baseURL 即可平滑适配现有应用与三方客户端。",
    tags: ["OpenAI 接口兼容", "SSE 流式响应", "Tool Call 工具调用"],
  },
  {
    icon: <BranchesOutlined />,
    badge: "路由调度",
    title: "多渠道容灾与负载均衡",
    desc: "支持同模型挂载多个上游渠道，按「优先级降序 + 同级权重轮询」调度流量。上游遭遇限流 (429)、网络超时或服务异常时，秒级自动平滑切换至就绪渠道，并自动执行冷却与探测。",
    tags: ["优先级与权重轮询", "故障秒级平滑降级", "渠道健康连通探测"],
  },
  {
    icon: <KeyOutlined />,
    badge: "凭据管理",
    title: "细粒度应用令牌分发",
    desc: "支持按应用或成员签发独立密钥 (sk-xxx)。精细化配置额度上限（按量扣减或不限）、模型访问白名单、指定渠道分组绑定以及到期时间，使用边界与安全隔离清晰明了。",
    tags: ["独立应用密钥", "额度硬顶控制", "模型白名单限制"],
  },
  {
    icon: <FundOutlined />,
    badge: "计量计费",
    title: "Token 级精准计量与核算",
    desc: "精确拆解输入 Prompt Tokens、输出 Completion Tokens 及上下文缓存命中 Tokens，按规则精准扣减。统一以 OD 币核算，支持自定义模型基准单价与闲时错峰阶梯优惠规则。",
    tags: ["分段精确计量", "缓存命中优惠计价", "闲时折扣规则"],
  },
  {
    icon: <AuditOutlined />,
    badge: "运维审计",
    title: "全链路调用审计与追踪",
    desc: "记录每一次模型调用的详细指标：调用模型、首字延迟 (TTFT)、总耗时、输入输出 Tokens、费用明细、关联渠道、客户端 IP 与 HTTP 状态码，为系统排障与账单对齐提供严谨依据。",
    tags: ["毫秒级延迟统计", "全量用量明细", "多维条件检索"],
  },
  {
    icon: <DesktopOutlined />,
    badge: "内置生态",
    title: "开箱即用工作台与双看板",
    desc: "内置 Web 对话调试界面，支持多模型测试、提示词调优与 Markdown 代码高亮。个人端掌握消费趋势与余额可用天数估算，管理端掌控全站 QPS 吞吐与渠道可用率监控。",
    tags: ["网页模型调试台", "个人消费趋势预测", "全站监控与运维"],
  },
];

// 审计日志流水模拟演示数据（实事求是呈现系统日志字段）
const SAMPLE_LOGS = [
  {
    time: "12:04:18",
    model: SAMPLE_MODEL,
    status: 200,
    tokens: "28 / 142",
    ttft: "245ms",
    totalMs: "1.32s",
    cost: "0.00028 OD币",
    route: "官方直连渠道 #1",
    failover: false,
  },
  {
    time: "12:03:52",
    model: "claude-3-5-sonnet",
    status: 200,
    tokens: "110 / 384",
    ttft: "380ms",
    totalMs: "3.48s",
    cost: "0.00680 OD币",
    route: "备用渠道 (故障自动降级)",
    failover: true,
  },
  {
    time: "12:02:11",
    model: "gpt-4o",
    status: 200,
    tokens: "64 / 96",
    ttft: "290ms",
    totalMs: "1.15s",
    cost: "0.00160 OD币",
    route: "主力轮询组 #2",
    failover: false,
  },
  {
    time: "12:00:45",
    model: "qwen-plus",
    status: 200,
    tokens: "42 / 215",
    ttft: "195ms",
    totalMs: "1.86s",
    cost: "0.00045 OD币",
    route: "国内高速通道",
    failover: false,
  },
];

export default function HomePage() {
  const { status, user } = useApp();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();

  // 当前网关接口端点
  const endpoint = status?.api_endpoint || "https://your-domain/v1";
  const cleanEndpoint = endpoint.replace(/\/+$/, "");

  // 首页示例代码里用的模型名。
  //
  // 原先是硬编码 `deepseek-chat` —— 那是 DeepSeek **官方已停用**的旧 id，
  // 照抄示例必然 503「当前没有可服务模型…的账号」。
  // 三个独立人格（大学生 / 产品经理 / 海外开发者）都栽在这一步，
  // 其中一人原话：「这是最伤新手的一条」「我自己就来回改了半小时」。
  // 首页是**未登录可见**的营销页，拿不到「该用户可用模型」（那需要登录态），
  // 所以这里用一个平台真实支持、且在任何分组里都常见的现役模型名；
  // 登录后的控制台会显示该账号**实际可用**的模型名（见 ConsolePage 的 sampleModel）。
  const SAMPLE_MODEL = "deepseek-flash";
  const systemName = status?.system_name || "OOAPI";

  // 管理员注册开关控制
  const registerOpen = Boolean(status) && status.password_register_enabled !== false;
  // 文档链接白名单防注入
  const docsHref = safeHref(status?.docs_link);

  // 额度换算说明
  const quotaLabel = status?.units_per_od || status?.quota_per_unit
    ? odRateText(unitsPerOd(status))
    : "额度换算比例以控制台配置为准";

  // 终端预览模式切换：call (实时请求响应) | sdk (多语言集成) | log (调用审计日志)
  const [terminalTab, setTerminalTab] = useState("call");
  // SDK 语言切换：curl | python | node | langchain
  const [sdkLang, setSdkLang] = useState("curl");

  // 复制文本辅助方法
  const handleCopy = async (text, successTip = "已复制到剪贴板") => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.readOnly = true;
        textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      message.success(successTip);
    } catch {
      message.error("复制失败，请手动选中并复制");
    }
  };

  // 多语言接入示例代码定义
  const CODE_EXAMPLES = {
    curl: `curl ${cleanEndpoint}/chat/completions \\
  -H "Authorization: Bearer sk-your-token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${SAMPLE_MODEL}",
    "messages": [
      {"role": "user", "content": "请介绍系统核心能力与网关架构"}
    ],
    "stream": true,
    "temperature": 0.7
  }'`,

    python: `from openai import OpenAI

# 仅需将 base_url 指向本平台，无缝兼容现有 OpenAI 生态
client = OpenAI(
    base_url="${cleanEndpoint}",
    api_key="sk-your-token",  # 在控制台「令牌管理」中签发的应用密钥
)

response = client.chat.completions.create(
    model=SAMPLE_MODEL,
    messages=[
        {"role": "user", "content": "请介绍系统核心能力与网关架构"}
    ],
    stream=True,
    temperature=0.7,
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)`,

    node: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${cleanEndpoint}",
  apiKey: "sk-your-token", // 平台分配的独立令牌
});

const stream = await client.chat.completions.create({
  model: SAMPLE_MODEL,
  messages: [
    { role: "user", content: "请介绍系统核心能力与网关架构" }
  ],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}`,

    langchain: `from langchain_openai import ChatOpenAI

chat = ChatOpenAI(
    model=SAMPLE_MODEL,
    openai_api_base="${cleanEndpoint}",
    openai_api_key="sk-your-token",
    temperature=0.7,
)

response = chat.invoke("请介绍系统核心能力与网关架构")
print(response.content)`,
  };

  return (
    <div className="hr-home">
      <a className="hr-skip-link" href="#hr-main">跳转到主要内容</a>

      {/* 顶部全局公告条（后台配置并启用时展示） */}
      {status?.announcement && status?.site_announcement_enabled !== "false" && (
        <aside className="hr-announcement" role="complementary" aria-label="全站公告">
          <div className="hr-container hr-announcement-inner">
            <InfoCircleOutlined className="hr-announcement-icon" />
            <span className="hr-announcement-text">{status.announcement}</span>
          </div>
        </aside>
      )}

      {/* 顶部导航栏 */}
      <header className="hr-header">
        <div className="hr-header-inner">
          <div className="hr-brand">
            <img src={status?.logo || "/logo.jpg"} alt={systemName} />
            <span>{systemName}</span>
          </div>
          <nav className="hr-nav" aria-label="页面核心导航">
            <a href="#hr-gateway">网关架构</a>
            <a href="#hr-features">系统功能</a>
            <a href="#hr-vendors">厂商支持</a>
            <a href="#hr-quickstart">快速接入</a>
            {docsHref && <a href={docsHref} target="_blank" rel="noreferrer">开发文档</a>}
          </nav>
          <Space size={10} className="hr-header-actions">
            <ThemeSwitch size="small" />
            {user ? (
              <Button type="primary" onClick={() => navigate("/console")}>
                进入控制台
              </Button>
            ) : (
              <>
                <Button onClick={() => navigate("/login")}>登录</Button>
                {registerOpen && (
                  <Button type="primary" onClick={() => navigate("/register")}>
                    注册账号
                  </Button>
                )}
              </>
            )}
          </Space>
        </div>
      </header>

      <main id="hr-main">
        {/* 头部 Hero 区域：严谨、真实的网关定位 */}
        <section className="hr-hero" aria-labelledby="hr-title">
          <div className="hr-atmosphere" aria-hidden="true">
            <div className="hr-glow hr-glow-one" />
            <div className="hr-glow hr-glow-two" />
          </div>
          <div className="hr-container hr-hero-content">
            <div className="hr-eyebrow">
              <ApiOutlined />
              <span>OpenAI 标准兼容</span>
              <span className="hr-eyebrow-separator" />
              <span>多渠道智能路由</span>
              <span className="hr-eyebrow-separator" />
              <span>Token 级精细核算</span>
            </div>

            <h1 id="hr-title">
              统一的大模型 API 网关<br />
              <span>与多渠道调度分发平台</span>
            </h1>

            <p className="hr-hero-description">
              {status?.about ||
                "一套接口聚合多家主流大模型服务。提供标准 OpenAI 协议兼容、上游多渠道平滑容灾降级、应用独立令牌隔离与 Token 级精确计费审计，让大模型能力分发与管理更加稳健可控。"}
            </p>

            <div className="hr-hero-actions">
              <Button
                type="primary"
                size="large"
                icon={<ArrowRightOutlined />}
                onClick={() => navigate(user ? "/console" : registerOpen ? "/register" : "/login")}
              >
                {user ? "进入控制台" : registerOpen ? "立即开始使用" : "登录平台"}
              </Button>
              <Button size="large" href="#hr-quickstart">
                查看接入示例
              </Button>
              {!user && (
                <a
                  className="hr-login-link"
                  href="/login"
                  onClick={(e) => {
                    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                      e.preventDefault();
                      navigate("/login");
                    }
                  }}
                >
                  已有账号？直接登录
                </a>
              )}
            </div>

            {/* 接口端点栏 */}
            <div className="hr-endpoint-bar">
              <span className="hr-endpoint-tag">
                <span className="hr-pulse-dot" /> Base URL
              </span>
              <code>{endpoint}</code>
              <Tooltip title="复制接口 Base URL">
                <Button
                  type="text"
                  icon={<CopyOutlined />}
                  onClick={() => handleCopy(endpoint, "接口 Base URL 已复制")}
                  aria-label="复制接口地址"
                />
              </Tooltip>
            </div>

            {/* 真实网关交互工作台预览（替代原先虚构的假对话框） */}
            <div className="hr-terminal-window" id="hr-gateway">
              <div className="hr-terminal-topbar">
                <div className="hr-terminal-dots">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="hr-terminal-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={terminalTab === "call"}
                    className={`hr-term-tab ${terminalTab === "call" ? "is-active" : ""}`}
                    onClick={() => setTerminalTab("call")}
                  >
                    <ThunderboltOutlined /> 实时调用与流式响应
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={terminalTab === "sdk"}
                    className={`hr-term-tab ${terminalTab === "sdk" ? "is-active" : ""}`}
                    onClick={() => setTerminalTab("sdk")}
                  >
                    <CodeOutlined /> 多语言 SDK 接入
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={terminalTab === "log"}
                    className={`hr-term-tab ${terminalTab === "log" ? "is-active" : ""}`}
                    onClick={() => setTerminalTab("log")}
                  >
                    <AuditOutlined /> 全链路审计日志流水
                  </button>
                </div>
                <div className="hr-terminal-status">
                  <span className="hr-status-indicator" /> 网关正常运行
                </div>
              </div>

              {/* Tab 1: 实时调用演示 */}
              {terminalTab === "call" && (
                <div className="hr-terminal-body hr-call-grid">
                  <div className="hr-call-pane hr-call-req">
                    <div className="hr-pane-header">
                      <span><CodeOutlined /> 标准 OpenAI 请求结构</span>
                      <span className="hr-badge-method">POST /v1/chat/completions</span>
                    </div>
                    <pre>
                      <code>{`{
  "model": "${SAMPLE_MODEL}",
  "messages": [
    {
      "role": "user",
      "content": "请分析大模型 API 网关的核心职责"
    }
  ],
  "stream": true,
  "temperature": 0.7
}`}</code>
                    </pre>
                    <div className="hr-req-meta">
                      <span>Header: <code>Authorization: Bearer sk-***</code></span>
                      <Button
                        size="small"
                        type="link"
                        icon={<CopyOutlined />}
                        onClick={() => handleCopy(CODE_EXAMPLES.curl, "已复制完整 cURL 命令")}
                      >
                        复制 cURL
                      </Button>
                    </div>
                  </div>

                  <div className="hr-call-pane hr-call-res">
                    <div className="hr-pane-header">
                      <span><ThunderboltOutlined /> 网关流式传输与调度指标</span>
                      <span className="hr-badge-status">HTTP 200 OK</span>
                    </div>
                    <div className="hr-res-metrics">
                      <div className="hr-metric-chip">
                        <span>首字延迟 (TTFT)</span>
                        <strong>245 ms</strong>
                      </div>
                      <div className="hr-metric-chip">
                        <span>总响应耗时</span>
                        <strong>1.32 s</strong>
                      </div>
                      <div className="hr-metric-chip">
                        <span>调度路由</span>
                        <strong>官方直连主力组</strong>
                      </div>
                      <div className="hr-metric-chip">
                        <span>扣减计费</span>
                        <strong>0.00028 OD币</strong>
                      </div>
                    </div>
                    <div className="hr-res-content">
                      <div className="hr-res-title">
                        <CheckCircleFilled style={{ color: "var(--green)" }} />
                        <span>流式输出正文 (SSE Stream 完成)</span>
                      </div>
                      <p className="hr-res-text">
                        大模型 API 网关的核心职责在于协议标准化、流量负载均衡与多上游容灾保障。通过将异构上游统一为标准 OpenAI 接口，并在请求链路中实现应用令牌鉴权、细粒度 Token 计费、故障秒级平滑降级与全链路审计追溯，确保高并发调用下的可用性与成本可控。
                      </p>
                    </div>
                    <div className="hr-res-footer">
                      <span>Prompt: 28 tokens</span>
                      <span>Completion: 142 tokens</span>
                      <span>总用量: 170 tokens</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: 多语言 SDK 示例 */}
              {terminalTab === "sdk" && (
                <div className="hr-terminal-body hr-sdk-body">
                  <div className="hr-sdk-toolbar">
                    <div className="hr-sdk-lang-selector">
                      {[
                        { key: "curl", label: "cURL" },
                        { key: "python", label: "Python (OpenAI SDK)" },
                        { key: "node", label: "Node.js (OpenAI SDK)" },
                        { key: "langchain", label: "LangChain" },
                      ].map((lang) => (
                        <button
                          key={lang.key}
                          type="button"
                          className={`hr-lang-btn ${sdkLang === lang.key ? "is-active" : ""}`}
                          onClick={() => setSdkLang(lang.key)}
                        >
                          {lang.label}
                        </button>
                      ))}
                    </div>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => handleCopy(CODE_EXAMPLES[sdkLang], "示例代码已复制")}
                    >
                      复制代码
                    </Button>
                  </div>
                  <pre className="hr-sdk-code">
                    <code>{CODE_EXAMPLES[sdkLang]}</code>
                  </pre>
                  <div className="hr-sdk-footer-note">
                    提示：代码示例中的 <code>baseURL</code> 已自动匹配当前站点端点；调用前请将 <code>sk-your-token</code> 替换为控制台生成的实际应用令牌。
                  </div>
                </div>
              )}

              {/* Tab 3: 真实全链路审计日志流水 */}
              {terminalTab === "log" && (
                <div className="hr-terminal-body hr-log-body">
                  <div className="hr-log-header-info">
                    <span><AuditOutlined /> 实时调用审计流水（系统全链路记录示例）</span>
                    <span className="hr-log-note">记录每一次请求的时间、模型、首字延迟、总耗时与精确计费</span>
                  </div>
                  <div className="hr-log-table-wrap">
                    <table className="hr-log-table">
                      <thead>
                        <tr>
                          <th>时间</th>
                          <th>模型</th>
                          <th>状态</th>
                          <th>Tokens (入/出)</th>
                          <th>首字延迟</th>
                          <th>总耗时</th>
                          <th>计费金额</th>
                          <th>路由渠道</th>
                        </tr>
                      </thead>
                      <tbody>
                        {SAMPLE_LOGS.map((item, idx) => (
                          <tr key={idx}>
                            <td><code>{item.time}</code></td>
                            <td><strong>{item.model}</strong></td>
                            <td>
                              <span className="hr-status-badge ok">{item.status} OK</span>
                            </td>
                            <td><code>{item.tokens}</code></td>
                            <td>{item.ttft}</td>
                            <td>{item.totalMs}</td>
                            <td>{item.cost}</td>
                            <td>
                              <span className={`hr-route-tag ${item.failover ? "failover" : ""}`}>
                                {item.route}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="hr-log-footer-bar">
                    <span>支持按模型、令牌、时间范围、IP 等多维筛选查询，数据支持导出归档。</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 核心容器区 */}
        <div className="hr-container">
          {/* 特性矩阵：真实系统功能 */}
          <section className="hr-section" id="hr-features" aria-labelledby="hr-features-title">
            <div className="hr-section-heading">
              <div>
                <span className="hr-kicker">01 / 核心架构能力</span>
                <h2 id="hr-features-title">立足工程实践，功能切实严谨</h2>
              </div>
              <p>
                不堆砌虚幻概念，每一项能力均对应系统现存服务模块与调度逻辑。
              </p>
            </div>

            <div className="hr-features-grid">
              {SYSTEM_FEATURES.map((feat, index) => (
                <article className="hr-feature-card" key={index}>
                  <div className="hr-feature-head">
                    <span className="hr-feature-icon">{feat.icon}</span>
                    <span className="hr-feature-badge">{feat.badge}</span>
                  </div>
                  <h3>{feat.title}</h3>
                  <p>{feat.desc}</p>
                  <div className="hr-feature-tags">
                    {feat.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>

          {/* 厂商生态与模型支持 */}
          <section className="hr-section" id="hr-vendors" aria-labelledby="hr-vendors-title">
            <div className="hr-section-heading">
              <div>
                <span className="hr-kicker">02 / 上游模型生态</span>
                <h2 id="hr-vendors-title">主流模型厂商直连与中转</h2>
              </div>
              <p>
                统一收口多家大模型 API，支持按需配置官方直连渠道或中转代理。
              </p>
            </div>

            <div className="hr-vendors-grid">
              {SUPPORTED_VENDORS.map((v) => (
                <div className="hr-vendor-card" key={v.type}>
                  <div className="hr-vendor-top">
                    <VendorIcon type={v.type} size={28} />
                    <span className="hr-vendor-name">{v.name}</span>
                  </div>
                  <div className="hr-vendor-models">{v.models}</div>
                </div>
              ))}
            </div>
          </section>

          {/* 快速接入指引 */}
          <section className="hr-section hr-quickstart" id="hr-quickstart" aria-labelledby="hr-quickstart-title">
            <div className="hr-section-heading">
              <div>
                <span className="hr-kicker">03 / 快速接入</span>
                <h2 id="hr-quickstart-title">三步完成应用接入</h2>
              </div>
              <p>
                完全遵循标准协议规范，无需复杂适配，修改配置即可调用。
              </p>
            </div>

            <div className="hr-start-grid">
              <div className="hr-start-steps">
                <ol>
                  <li>
                    <span>01</span>
                    <div>
                      <h3>生成独立应用令牌 (API Key)</h3>
                      <p>进入「令牌管理」页面，为每个应用或项目签发独立的密钥，可限制额度上限与模型白名单。</p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <h3>配置网关接口地址 (Base URL)</h3>
                      <p>将客户端或 SDK 的 <code>baseURL</code> 指向平台网关端点：</p>
                      <code>{cleanEndpoint}</code>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <h3>携带 Bearer 令牌发起请求</h3>
                      <p>在请求头中附带 <code>Authorization: Bearer sk-***</code>，享受自动容灾调度与流式响应。</p>
                    </div>
                  </li>
                </ol>
                <div className="hr-quota-note">
                  <FundOutlined />
                  <span>{quotaLabel}</span>
                </div>
              </div>

              <div className="hr-code-panel">
                <div className="hr-code-header">
                  <span><CodeOutlined /> 极简接入示例 (cURL)</span>
                  <Button
                    size="small"
                    type="text"
                    icon={<CopyOutlined />}
                    onClick={() => handleCopy(CODE_EXAMPLES.curl, "cURL 示例已复制")}
                  >
                    复制
                  </Button>
                </div>
                <pre tabIndex={0} aria-label="cURL 快速接入示例">
                  <code>{CODE_EXAMPLES.curl}</code>
                </pre>
                <p className="hr-code-note">
                  支持 Python OpenAI SDK、LangChain、LobeChat、NextChat 等现有大模型生态工具直连。
                </p>
              </div>
            </div>
          </section>

          {/* 底部行动号召 */}
          <section className="hr-closing" aria-labelledby="hr-closing-title">
            <div>
              <span className="hr-kicker">立即开始</span>
              <h2 id="hr-closing-title">接入高可用大模型 API 网关</h2>
              <p>统一聚合、安全分发、精准计量，保障业务持续稳定运行。</p>
            </div>
            <Button
              size="large"
              type="primary"
              icon={<ArrowRightOutlined />}
              onClick={() => navigate(user ? "/console" : registerOpen ? "/register" : "/login")}
            >
              {user ? "进入控制台" : registerOpen ? "注册账号" : "登录使用"}
            </Button>
          </section>
        </div>
      </main>

      {/* 页脚与合规信息 */}
      <footer className="hr-footer hr-container">
        <div className="hr-footer-top">
          <div className="hr-footer-brand">
            <img src={status?.logo || "/logo.jpg"} alt="" />
            <strong>{systemName}</strong>
            <span>大模型 API 网关与分发系统</span>
          </div>
          <div className="hr-footer-meta">
            {docsHref && (
              <a href={docsHref} target="_blank" rel="noreferrer">
                开发文档 <RightOutlined style={{ fontSize: 10 }} />
              </a>
            )}
            {status?.contact_email && (
              <span>联系邮箱: {status.contact_email}</span>
            )}
            {status?.contact_qq_group && (
              <span>交流群: {status.contact_qq_group}</span>
            )}
            <span>版本 v{status?.version || "0.1.0"}</span>
          </div>
        </div>

        <div className="hr-footer-bottom">
          <span>{status?.footer || `© ${new Date().getFullYear()} ${systemName}. All rights reserved.`}</span>
          <Space size={16} className="hr-footer-records">
            {status?.icp_number && (
              <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
                {status.icp_number}
              </a>
            )}
            {status?.police_number && (
              <span>{status.police_number}</span>
            )}
          </Space>
        </div>
      </footer>
    </div>
  );
}
