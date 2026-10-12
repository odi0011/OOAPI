import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, Code2, Copy, FileText, FolderOpen, KeyRound, LayoutDashboard, LogOut, Moon, PanelTop, Search, ShieldCheck, Sun, Terminal, X } from "lucide-react";
import Accordion from "@/components/arc/accordion/accordion";
import Button from "@/components/arc/button/button";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import LineChart from "@/components/arc/line-chart/line-chart";
import BrushChart from "@/components/arc/brush-chart/brush-chart";
import WaffleChart from "@/components/arc/waffle-chart/waffle-chart";
import { useAuth } from "@/contexts/AuthContext";
import { useAuthProviders } from "@/contexts/AuthProvidersContext";
import ProviderWell, { PROVIDERS } from "./home/ProviderWell";
import { ChannelRouting, VectorRetrieval } from "./home/GatewayScenes";
import { MODEL_CATALOG } from "./home/home-data";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import styles from "./Home.module.css";

type View = "overview" | "models" | "analytics" | "guide";
interface SiteStatus { system_name: string; logo?: string; api_endpoint: string; currency_name: string; units_per_od: number }
const VIEW_LABELS: Record<View, string> = { overview: "首页", models: "模型目录", analytics: "调用分析", guide: "接入文档" };
const LEFT_ITEMS = [
  { id: "overview" as View, label: "首页", icon: FileText },
  { id: "models" as View, label: "模型目录", icon: FolderOpen },
  { id: "analytics" as View, label: "调用分析", icon: Activity },
  { id: "guide" as View, label: "接入文档", icon: BookOpen },
];
const CHART_END = Date.UTC(2026, 9, 8);
const DAY = 86400000;
const HISTORY = Array.from({ length: 30 }, (_, index) => ({
  date: CHART_END - (29 - index) * DAY,
  value: Math.round(21000 + index * 520 + Math.sin(index * .79) * 4900 + Math.cos(index * .24) * 2800),
}));
const SHARES = [
  { key: "openai", label: "OpenAI", value: 36, color: "var(--series-1)" },
  { key: "claude", label: "Claude", value: 27, color: "var(--series-2)" },
  { key: "deepseek", label: "DeepSeek", value: 19, color: "var(--series-4)" },
  { key: "kimi", label: "Kimi", value: 11, color: "var(--series-3)" },
  { key: "grok", label: "Grok", value: 7, color: "var(--text-muted)" },
];
function iconFor(vendor: string) {
  const id = ({ Anthropic: "claude", xAI: "grok", Moonshot: "kimi" } as Record<string, string>)[vendor] || vendor.toLowerCase();
  return PROVIDERS.find((provider) => provider.id === id);
}
function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [result, setResult] = useState("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setResult("copied"); } catch { setResult("failed"); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult("idle"), 2200);
  };
  return <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label={result === "copied" ? "已复制" : label}>{result === "copied" ? <Check size={13} /> : <Copy size={13} />}{result === "copied" ? "已复制" : result === "failed" ? "复制失败" : label}</Button>;
}

export default function Home() {
  const { user, loading, logout } = useAuth();
  const providers = useAuthProviders();
  const navigate = useNavigate();
  const [status, setStatus] = useState<SiteStatus | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [health, setHealth] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState("全部");
  const [language, setLanguage] = useState("python");
  const [period, setPeriod] = useState("7");
  const [range, setRange] = useState<[number, number]>([CHART_END - 6 * DAY, CHART_END]);
  const [selectedProvider, setSelectedProvider] = useState("openai");
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const read = async (url: string) => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    };
    void read("/api/status").then((body: { data?: SiteStatus }) => { if (body.data?.system_name) setStatus(body.data); }).catch(() => undefined);
    void read("/v1/models").then((body: { data?: { id: string }[] }) => {
      if (Array.isArray(body.data)) setModels(body.data.filter((model) => typeof model.id === "string").map((model) => model.id));
    }).catch(() => undefined);
    void fetch("/api/health", { signal: controller.signal }).then((response) => response.json()).then((body: { status?: string }) => { if (body.status) setHealth(body.status); }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  const name = status?.system_name || "OOAPI";
  const logo = status?.logo || "/logo.jpg";
  const endpoint = status?.api_endpoint || "https://ooapi.space/v1";
  // 没拿到明确的 register_enabled 之前去登录，不把人送进注册表单。
  const startPath = user ? "/dashboard" : providers.register_enabled === true ? "/register" : "/login";
  const visibleModels = MODEL_CATALOG.filter((model) => (vendor === "全部" || model.vendor === vendor) && (model.name + model.vendor + model.description).toLowerCase().includes(query.trim().toLowerCase()));
  const chartPoints = period === "7" ? HISTORY.slice(-7) : HISTORY;
  const count = chartPoints.reduce((sum, point) => sum + point.value, 0);
  const exampleModel = models?.[0] || MODEL_CATALOG[0].id;
  const code = language === "python"
    ? ['from openai import OpenAI', '', 'client = OpenAI(', '    api_key="YOUR_API_KEY",', '    base_url=' + JSON.stringify(endpoint), ')', '', 'response = client.chat.completions.create(', '    model=' + JSON.stringify(exampleModel) + ',', '    messages=[{"role": "user", "content": "你好"}],', ')', '', 'print(response.choices[0].message.content)'].join("\n")
    : language === "node"
      ? ['import OpenAI from "openai";', '', 'const client = new OpenAI({', '  apiKey: process.env.OOAPI_API_KEY,', '  baseURL: ' + JSON.stringify(endpoint) + ',', '});', '', 'const response = await client.chat.completions.create({', '  model: ' + JSON.stringify(exampleModel) + ',', '  messages: [{ role: "user", content: "你好" }],', '});', '', 'console.log(response.choices[0].message.content);'].join("\n")
      : ['curl ' + JSON.stringify(endpoint.replace(/\/$/, "") + "/chat/completions") + ' \\', '  -H "Authorization: Bearer YOUR_API_KEY" \\', '  -H "Content-Type: application/json" \\', "  -d '" + JSON.stringify({ model: exampleModel, messages: [{ role: "user", content: "你好" }] }, null, 2) + "'"].join("\n");

  const changeView = (next: View) => {
    setView(next);
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
  };
  const selectProvider = (id: string) => {
    setSelectedProvider(id);
    const mapping: Record<string, string> = { openai: "OpenAI", claude: "Anthropic", deepseek: "DeepSeek", grok: "xAI", kimi: "Moonshot" };
    if (mapping[id]) { setVendor(mapping[id]); setQuery(""); changeView("models"); }
    else { changeView("models"); }
  };
  const tabKeys = (event: KeyboardEvent<HTMLButtonElement>, current: View) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = Object.keys(VIEW_LABELS) as View[];
    const index = options.indexOf(current);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowRight" ? 1 : options.length - 1)) % options.length;
    changeView(options[next]);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>("#tab-" + options[next])?.focus();
  };
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };
  const modelRows = (compact = false) => <div className={styles.modelTable}>
    <div className={styles.tableHeading}><span>模型</span><span>任务</span><span>厂商</span><span /></div>
    {(compact ? MODEL_CATALOG.slice(0, 5) : visibleModels).map((model) => {
      const provider = iconFor(model.vendor);
      return <a className={styles.modelRow} key={model.id} href={model.source} target="_blank" rel="noreferrer"><span className={styles.modelIdentity}><img src={provider?.icon} data-monochrome={provider?.monochrome || undefined} data-surface={provider?.iconSurface} alt="" /><strong>{model.name}</strong></span><span>{model.description}</span><small>{model.vendor}</small><ArrowUpRight size={13} /></a>;
    })}
    {!compact && visibleModels.length === 0 && <div className={styles.empty}>没有找到模型<Button variant="ghost" size="sm" onClick={() => { setQuery(""); setVendor("全部"); }}>清除筛选</Button></div>}
  </div>;

  return <div className={styles.page}>
    <header className={styles.header}>
      <Link to="/" className={styles.brand}><img src={logo} alt="" /><strong>{name}</strong></Link>
      <nav aria-label="主导航" className={styles.nav}><button type="button" onClick={() => changeView("overview")}>产品</button><button type="button" onClick={() => changeView("models")}>模型</button><button type="button" onClick={() => changeView("analytics")}>调用分析</button><button type="button" onClick={() => changeView("guide")}>文档</button></nav>
      <div className={styles.headerActions}><Button variant="ghost" size="sm" aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} onClick={toggleTheme}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</Button>{!loading && (user ? <><Button variant="ghost" size="sm" aria-label="退出登录" onClick={() => void logout()}><LogOut size={15} /></Button><Button size="sm" onClick={() => navigate("/admin")}>控制台 <ArrowRight size={13} /></Button></> : <><Link to="/login" className={styles.login}>登录</Link><Button size="sm" onClick={() => navigate(startPath)}>开始使用 <ArrowRight size={13} /></Button></>)}</div>
    </header>

    <div className={styles.desktop}>
      <aside className={styles.leftRail}><nav aria-label="工作区导航">{LEFT_ITEMS.map(({ id, label, icon: Icon }, index) => <button type="button" key={id} className={view === id ? styles.railActive : ""} onClick={() => changeView(id)}><span className={styles.railIcon} data-tone={index}><Icon size={25} strokeWidth={1.6} /></span><span>{label}</span></button>)}<Link to={user ? "/admin/tokens" : "/login"}><span className={styles.railIcon} data-tone="2"><KeyRound size={25} strokeWidth={1.6} /></span><span>API 密钥</span></Link><Link to={user ? "/admin" : "/login"}><span className={styles.railIcon} data-tone="3"><LayoutDashboard size={25} strokeWidth={1.6} /></span><span>控制台</span></Link></nav></aside>

      <main className={styles.window} aria-label="首页内容窗口">
        <div className={styles.titlebar}><span className={styles.windowDots} aria-hidden="true"><i /><i /><i /></span><span><PanelTop size={13} />{view === "overview" ? "home.mdx" : view === "models" ? "models.json" : view === "analytics" ? "analytics.view" : "quickstart.md"}</span><span className={styles.titleMeta}>{name}</span></div>
        <div className={styles.tabs} role="tablist" aria-label="首页内容">{(Object.keys(VIEW_LABELS) as View[]).map((item) => <button type="button" role="tab" id={"tab-" + item} key={item} aria-selected={view === item} aria-controls={"panel-" + item} tabIndex={view === item ? 0 : -1} onClick={() => changeView(item)} onKeyDown={(event) => tabKeys(event, item)}>{VIEW_LABELS[item]}</button>)}<span><Code2 size={13} />API v1</span></div>
        <div className={styles.windowScroll} ref={scrollRef}>
          <div className={styles.content} role="tabpanel" id={"panel-" + view} aria-labelledby={"tab-" + view}>
            {view === "overview" && <>
              <section className={styles.hero}><div><div className={styles.heroBrand}><img src={logo} alt="" /><span>大模型 API 网关</span></div><h1>{name}</h1><p>支持 OpenAI 兼容接口。</p><p>提供令牌分发、额度计费和调用日志。</p><div className={styles.heroActions}><Button onClick={() => navigate(startPath)}>获取 API Key <ArrowUpRight size={14} /></Button><Button variant="secondary" onClick={() => changeView("guide")}>接入文档 <ArrowRight size={14} /></Button></div></div><div className={styles.quickInfo}><h2>接入配置</h2><div><span>接口地址</span><code>{endpoint}</code></div><div><span>认证方式</span><code>Bearer API Key</code></div><div><span>计费方式</span><strong>按 Token 用量</strong></div><CopyButton value={endpoint} label="复制接口地址" /></div></section>
              <p className={styles.demoNote}><strong>示例</strong><span>调用量、耗时与下方图表是演示数据，不是 /api/status 的实时状态。</span></p><div className={styles.metrics}><div><span>调用量</span><strong>{count.toLocaleString("en-US")}</strong></div><div><span>Token 用量</span><strong>{(count * 1720 / 1000000).toFixed(1)}<small>M</small></strong></div><div><span>平均响应</span><strong>842<small>ms</small></strong></div><div><span>请求成功率</span><strong>99.69<small>%</small></strong></div></div>
              <div className={styles.charts}><article className={styles.chartPanel}><div className={styles.chartHeader}><h2>调用趋势<span className={styles.demoBadge}>示例</span></h2><SegmentedControl options={[{ value: "7", label: "7 天" }, { value: "30", label: "30 天" }]} value={period} onValueChange={setPeriod} label="调用统计周期" /></div><LineChart label="API 调用趋势（示例）" data={chartPoints.map((point) => ({ key: String(point.date), label: new Date(point.date).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" }), values: { calls: point.value } }))} series={[{ key: "calls", label: "调用量", area: true, color: "var(--series-1)" }]} height={175} legend={false} formatTick={(value) => Math.round(value / 1000) + "k"} /></article><article className={styles.chartPanel}><div className={styles.chartHeader}><h2>厂商请求占比<span className={styles.demoBadge}>示例</span></h2></div><WaffleChart label="厂商请求占比（示例）" data={SHARES} formatValue={(value) => value + "%"} className={styles.waffle} /></article></div>
              <div className={styles.sectionHeader}><h2>最新模型</h2><Button variant="ghost" size="sm" onClick={() => { setVendor("全部"); changeView("models"); }}>模型目录 <ArrowUpRight size={13} /></Button></div>{modelRows(true)}
              <div className={styles.sectionHeader}><h2>账号调度与检索<span className={styles.demoBadge}>示例</span></h2></div><div className={styles.sceneGrid}><ChannelRouting /><VectorRetrieval /></div>
            </>}

            {view === "models" && <section><div className={styles.sectionHeader}><h1>模型目录</h1><span>{visibleModels.length} 个模型</span></div><ProviderWell key={selectedProvider} defaultProvider={selectedProvider} onSelect={(id) => { setSelectedProvider(id); const mapping: Record<string, string> = { openai: "OpenAI", claude: "Anthropic", deepseek: "DeepSeek", grok: "xAI", kimi: "Moonshot" }; setVendor(mapping[id] || "全部"); }} className={styles.providerWell} /><div className={styles.filters}><label className={styles.search}><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索模型" placeholder="搜索模型…" />{query && <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={13} /></button>}</label><label className={styles.select}><select aria-label="按厂商筛选" value={vendor} onChange={(event) => setVendor(event.target.value)}>{["全部", "OpenAI", "Anthropic", "DeepSeek", "xAI", "Moonshot"].map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={13} /></label></div>{modelRows()}{models && models.length > 0 && <div className={styles.configured}><Accordion size="sm" defaultOpen={-1} items={[{ title: `本站可用模型 · ${models.length}`, content: <div className={styles.configuredList}>{models.map((id) => <code key={id}>{id}</code>)}</div> }]} /></div>}</section>}

            {view === "analytics" && <section><div className={styles.sectionHeader}><h1>调用分析<span className={styles.demoBadge}>示例</span></h1></div><article className={styles.chartPanel}><div className={styles.chartHeader}><h2>请求历史<span className={styles.demoBadge}>示例</span></h2><span>近 30 天</span></div><BrushChart className={styles.brush} label="API 请求历史（示例）" data={HISTORY} range={range} onRangeChange={setRange} minSpan={DAY * 3} height={224} overviewHeight={45} formatTick={(value) => Math.round(value / 1000) + "k"} formatDate={(date) => date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })} /></article><div className={styles.charts}><article className={styles.chartPanel}><div className={styles.chartHeader}><h2>厂商请求占比<span className={styles.demoBadge}>示例</span></h2></div><WaffleChart data={SHARES} label="厂商请求占比（示例）" formatValue={(value) => value + "%"} /></article><article className={styles.chartPanel}><div className={styles.chartHeader}><h2>模型与工具</h2></div><ProviderWell defaultProvider={selectedProvider} className={styles.analyticsProviders} /></article></div></section>}

            {view === "guide" && <section><div className={styles.sectionHeader}><h1>接入文档</h1></div><p className={styles.guideIntro}>使用 OpenAI SDK 配置本站接口。</p><ol className={styles.steps}><li><span>1</span><div><h3>获取令牌</h3><p>在控制台创建 API Key。</p></div><Button variant="ghost" size="sm" onClick={() => navigate(user ? "/admin" : "/login")}>控制台 <ArrowUpRight size={13} /></Button></li><li><span>2</span><div><h3>配置 baseURL</h3><code>{endpoint}</code></div><CopyButton value={endpoint} /></li><li><span>3</span><div><h3>填写模型名称</h3><p>选择本站可用的模型。</p></div></li></ol><div className={styles.codePanel}><div className={styles.codeToolbar}><SegmentedControl options={[{ value: "python", label: "Python" }, { value: "node", label: "Node.js" }, { value: "curl", label: "cURL" }]} value={language} onValueChange={setLanguage} label="代码语言" /><CopyButton value={code} label="复制代码" /></div><pre><code>{code}</code></pre></div><div className={styles.billing}><ShieldCheck size={15} /><span>{status?.currency_name || "OD 币"} · 1 OD = 1 美元 · 1 OD = {(status?.units_per_od || 10000).toLocaleString("en-US")} 单位</span></div></section>}
          </div>
          <footer className={styles.documentFooter}><span>© {new Date().getFullYear()} {name} · 作者 ODI</span><a href="/api/health" target="_blank" rel="noreferrer">{health && <i data-state={health} />}服务状态 <ArrowUpRight size={11} /></a></footer>
        </div>
        <div className={styles.windowFooter}><span><Terminal size={12} />OpenAI compatible</span><span>{name}</span><span>API v1</span></div>
      </main>

      <aside className={styles.rightRail}><nav aria-label="厂商快捷入口">{PROVIDERS.slice(0, 7).map((provider) => <button type="button" key={provider.id} aria-label={provider.name + " 模型与工具"} onClick={() => selectProvider(provider.id)}><span className={styles.vendorRailIcon} data-surface={provider.iconSurface}><img src={provider.icon} alt="" data-monochrome={provider.monochrome || undefined} /></span><span>{provider.name}</span></button>)}</nav></aside>
    </div>
  </div>;
}

