import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Checkbox, Collapse, Drawer, Form, Grid, Input, InputNumber, Modal, Popconfirm, Popover, Select, Space, Table, Tag, Tooltip } from "antd";
import { ClearOutlined, CloudDownloadOutlined, DollarOutlined, LinkOutlined, ReloadOutlined, SearchOutlined, SettingOutlined, UploadOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import { ModelLabel } from "../components/VendorIcon";
import ModelAttributions from "../components/ModelAttributions";
import OdAmount from "../components/OdAmount";
import { OdCoin } from "../components/OdCoin";
import StatCard from "../components/StatCard";
import "../model-management.css";

const categories = { chat: "对话", image: "生图", video: "生视频", audio: "音频", embedding: "嵌入", rerank: "重排", decision: "决策" };
const types = { text: "文本", image: "图片", video: "视频", audio: "音频", pdf: "PDF", embedding: "向量" };
const flags = { structuredOutput: "结构化输出", nativeSearch: "原生联网", systemMessages: "系统消息", toolCalling: "工具调用" };
const tri = [{ value: "unknown", label: "未核实" }, { value: "yes", label: "支持" }, { value: "no", label: "不支持" }];
const priceFields = [["input", "输入"], ["output", "输出"], ["cache", "缓存命中"]];
const TYPE_LABEL = { deepseek: "DeepSeek", glm: "智谱 GLM", kimi: "Kimi", doubao: "豆包", qwen: "通义千问", openai: "OpenAI", anthropic: "Anthropic", claude: "Anthropic", gemini: "Google Gemini", grok: "xAI Grok", custom: "其他", kiro: "Kiro", workbuddy: "WorkBuddy" };
const importTemplate = { prices: [{ model: "deepseek-flash", input: 0.3, output: 1.2, cache: 0.006, offpeak_input: 0.15, offpeak_output: 0.6, offpeak_cache: 0.003, offpeak_rule: "{\"offset\":8,\"days\":[1,2,3,4,5],\"peak\":[[\"09:00\",\"12:00\"],[\"14:00\",\"18:00\"]]}", remark: "官方定价页 URL" }] };
const optionMap = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const count = value => value == null ? "待核实" : Number(value).toLocaleString("en-US");
const hasPriceRules = price => Boolean(price?.tiers?.length || price?.offpeakRule);
const normalizePricing = price => price ? {
  ...price,
  input: price.input ?? price.input_price,
  output: price.output ?? price.output_price,
  cache: price.cache ?? price.cache_price,
  offpeakInput: price.offpeakInput ?? price.offpeak_input_price,
  offpeakOutput: price.offpeakOutput ?? price.offpeak_output_price,
  offpeakCache: price.offpeakCache ?? price.offpeak_cache_price,
  offpeakRule: price.offpeakRule ?? price.offpeak_rule,
} : null;
const cleanRemark = value => String(value || "")
  .replace(/[¥￥][0-9.]+(?:\/[¥￥]?[0-9.]+|(?:\/缓存\s*[¥￥]?[0-9.]+))*/g, "")
  .replace(/÷\s*[0-9.]+/g, "")
  .replace(/；\s*；/g, "；")
  .replace(/；\s*来源\s*/g, " · ")
  .replace(/^来源\s*/g, "")
  .replace(/；\s*$/, "")
  .trim();

function PriceRules({ price }) {
  if (!price) return null;
  let rule = price.offpeakRule;
  if (typeof rule === "string") { try { rule = JSON.parse(rule); } catch { rule = null; } }
  const amount = value => value == null ? "沿用基准" : <OdAmount size={11}>{value}</OdAmount>;
  return <div className="oo-model-price-rules">
    {(price.tiers || []).map((tier, index) => <div key={`${tier.from || tier.minInputTokens}-${index}`}><b>{tier.from ? `${String(tier.from).slice(0, 10)} 起` : `输入 ≥ ${count(tier.minInputTokens)} Token`}</b><span>输入 {amount(tier.input)} · 输出 {amount(tier.output)} · 缓存 {amount(tier.cache)}</span></div>)}
    {rule ? <><div><b>峰时</b><span>UTC{Number(rule.offset) >= 0 ? "+" : ""}{rule.offset || 0} · 周{(rule.days || [1, 2, 3, 4, 5]).join("/")} · {(rule.peak || []).map(window => window.join("–")).join("、")}</span></div><div><b>闲时</b><span>输入 {amount(price.offpeakInput)} · 输出 {amount(price.offpeakOutput)} · 缓存 {amount(price.offpeakCache)}</span></div></> : null}
  </div>;
}

function PriceMatrix({ bands }) {
  return <div className="oo-model-price-matrix" role="table" aria-label="模型单价" style={{ gridTemplateColumns: `34px repeat(${bands.length}, minmax(70px, max-content))` }}>
    {bands.length > 1 ? <div role="row" className="oo-model-price-line"><span role="columnheader" />{bands.map((band, index) => <Tooltip key={index} title={band.description} trigger={["hover", "focus"]}><span className="oo-model-price-heading" role="columnheader" tabIndex={0}>{band.label}</span></Tooltip>)}</div> : null}
    {priceFields.map(([key, label]) => <div key={key} role="row" className="oo-model-price-line"><span className="oo-model-price-label" role="rowheader">{key === "cache" ? "缓存" : label}</span>{bands.map((band, index) => <span className="oo-model-price-value" role="cell" key={index}><OdAmount size={11}>{band.price[key] == null ? "—" : String(Number(band.price[key]))}</OdAmount></span>)}</div>)}
  </div>;
}

function PriceSummary({ price }) {
  let rule = price.offpeakRule;
  if (typeof rule === "string") { try { rule = JSON.parse(rule); } catch { rule = null; } }
  const bands = [{ label: rule ? "峰时" : "基础", description: rule ? <PriceRules price={{ ...price, tiers: [] }} /> : "基准价格；附加档位满足条件时覆盖", price }];
  if (rule) bands.push({ label: "闲时", description: "峰时以外的时段", price: { input: price.offpeakInput ?? price.input, output: price.offpeakOutput ?? price.output, cache: price.offpeakCache ?? price.cache } });
  for (const tier of price.tiers || []) {
    const tokens = Number(tier.minInputTokens);
    bands.push({ label: tier.from ? String(tier.from).slice(5, 10) + " 起" : `≥ ${tokens && tokens % 1000 === 0 ? tokens / 1000 + "K" : count(tier.minInputTokens)}`, description: tier.from ? `${tier.from} 起生效` : `输入 ≥ ${count(tier.minInputTokens)} Token`, price: Object.fromEntries(priceFields.map(([key]) => [key, tier[key] ?? price[key]])) });
  }
  return <div className="oo-model-price-cell"><PriceMatrix bands={bands.slice(0, 2)} />{bands.length > 2 ? <Popover trigger={["hover", "click"]} content={<div className="oo-model-price-all">{bands.map((band, index) => <div key={index}><b>{band.description}</b><PriceMatrix bands={[band]} /></div>)}</div>}><Button type="link" size="small" className="oo-model-price-more">查看全部 {bands.length} 档</Button></Popover> : null}</div>;
}

function PriceSource({ row, price }) {
  const remark = price?.remark || "";
  const displayRemark = cleanRemark(remark);
  const source = row.verification === "official" ? "原厂已核实" : row.verification === "provider" ? "服务商目录" : row.customized ? "管理员配置" : remark ? "已配置价格" : "待配置";
  return <div className="oo-model-source"><Tag color={source === "待配置" ? "warning" : source === "管理员配置" ? "blue" : "default"}>{source}</Tag>{remark ? <Tooltip title={remark}><span className="oo-model-source-text">{displayRemark || remark}</span></Tooltip> : <span className="oo-model-source-text">尚未设置价格</span>}</div>;
}

export default function ModelManagementPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [capabilities, setCapabilities] = useState([]), [pricingRows, setPricingRows] = useState([]), [catalogPending, setCatalogPending] = useState([]);
  const [reasoningParameters, setReasoningParameters] = useState([]), [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const [query, setQuery] = useState(""), [category, setCategory] = useState(""), [vendor, setVendor] = useState(""), [priceStatus, setPriceStatus] = useState("");
  const [editing, setEditing] = useState(null), [saving, setSaving] = useState(false), [opening, setOpening] = useState("");
  const [selectedPreset, setSelectedPreset] = useState(""), [pricingRules, setPricingRules] = useState(null), [pricePreset, setPricePreset] = useState("");
  const [importOpen, setImportOpen] = useState(false), [importText, setImportText] = useState(""), [importResult, setImportResult] = useState(null), [importing, setImporting] = useState(false);
  const [overwrite, setOverwrite] = useState(false), [syncing, setSyncing] = useState(false), [cleaning, setCleaning] = useState(false);
  const levels = Form.useWatch("levels", form) || [];
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [caps, prices, pending] = await Promise.all([API.get("/pricing/capabilities"), API.get("/pricing/"), API.get("/pricing/catalog-pending")]);
      setCapabilities(caps.items || []); setReasoningParameters(caps.reasoningParameters || []); setPresets(caps.presets || []); setPricingRows(prices || []); setCatalogPending(Array.isArray(pending) ? pending : []);
    } catch (e) { setError(e.message || "模型配置加载失败"); message.error(e.message || "模型配置加载失败"); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { load(); }, [load, revision]);

  const rows = useMemo(() => {
    const byPrice = new Map(pricingRows.map(row => [String(row.model).toLowerCase(), row]));
    const output = capabilities.map(row => ({ ...row, pricing: normalizePricing(row.pricing || byPrice.get(String(row.model).toLowerCase()) || null) }));
    for (const price of pricingRows) if (!output.some(row => row.model.toLowerCase() === String(price.model).toLowerCase())) output.push({ model: price.model, vendor: price.channel_type, category: "chat", inputTypes: [], outputTypes: [], reasoning: { levels: [] }, pricing: normalizePricing(price), documentationUrl: "" });
    return output;
  }, [capabilities, pricingRows]);
  const vendors = useMemo(() => [...new Set(rows.map(row => row.vendor).filter(Boolean))].sort(), [rows]);
  const filtered = useMemo(() => rows.filter(row => {
    const text = `${row.model} ${row.vendor} ${row.pricing?.remark || ""}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (!category || row.category === category) && (!vendor || row.vendor === vendor) && (!priceStatus || (priceStatus === "priced" ? row.pricing : !row.pricing));
  }), [rows, query, category, vendor, priceStatus]);
  const configured = rows.filter(row => row.pricing).length;
  const pendingModels = new Set([...rows.filter(row => !row.pricing).map(row => String(row.model).toLowerCase()), ...catalogPending.map(item => String(item.model).toLowerCase())]);
  const pendingCount = pendingModels.size;
  const cheapest = rows.filter(row => row.pricing && Number.isFinite(Number(row.pricing.input))).sort((a, b) => Number(a.pricing.input) - Number(b.pricing.input))[0];
  const visibleCatalogPending = catalogPending.filter(item => (!query || String(item.model).toLowerCase().includes(query.toLowerCase())) && (!vendor || item.type === vendor));

  const fillForm = (row, pricing) => {
    form.resetFields();
    const reasoning = row.reasoning || {};
    form.setFieldsValue({ category: row.category, contextWindow: row.contextWindow ?? null, maxOutputTokens: row.maxOutputTokens ?? null, inputTypes: [...(row.inputTypes || [])], outputTypes: [...(row.outputTypes || [])], notes: row.notes || "", ...Object.fromEntries(Object.keys(flags).map(key => [key, row[key] == null ? "unknown" : row[key] ? "yes" : "no"])), levels: [...(reasoning.levels || [])], defaultLevel: reasoning.defaultLevel || undefined, parameter: reasoning.parameter || "", values: JSON.stringify(reasoning.values || {}, null, 2), ...Object.fromEntries(priceFields.map(([key]) => [`price_${key}`, pricing?.[key] ?? pricing?.[`${key}_price`] ?? null])), keepRules: true });
    setPricingRules(pricing || null); setSelectedPreset(""); setPricePreset("");
  };
  const edit = async row => {
    setOpening(row.model);
    try {
      const result = await API.get("/pricing/capabilities", { params: { model: row.model } });
      const fresh = result.items?.find(item => item.model === row.model) || row;
      fillForm(fresh, normalizePricing(fresh.pricing || row.pricing)); setPresets(result.presets || presets); setEditing(fresh);
    } catch (e) { message.error(e.message); }
    finally { setOpening(""); }
  };
  const save = async () => {
    let values;
    try { values = await form.validateFields(); } catch { return; }
    let mapped;
    try { mapped = JSON.parse(values.values || "{}"); } catch { message.error("推理映射不是合法 JSON"); return; }
    setSaving(true);
    try {
      const modelCapabilities = { ...values, ...Object.fromEntries(Object.keys(flags).map(key => [key, values[key] === "unknown" ? null : values[key] === "yes"])), reasoning: { levels: values.levels || [], defaultLevel: values.defaultLevel || "", parameter: values.parameter || "", values: mapped } };
      const hasPrice = priceFields.some(([key]) => values[`price_${key}`] != null);
      const pricing = hasPrice ? { input: values.price_input, output: values.price_output, cache: values.price_cache, presetModel: pricePreset, keepRules: values.keepRules !== false } : undefined;
      const saved = await API.put("/pricing/capabilities", { model: editing.model, capabilities: modelCapabilities, pricing });
      setCapabilities(current => current.map(row => row.model === editing.model ? { ...row, ...saved } : row));
      setEditing(null); setRevision(value => value + 1); message.success(pricing ? "模型参数与价格已保存" : "模型参数已保存");
    } catch (e) { message.error(e.message); }
    finally { setSaving(false); }
  };
  const selectPreset = preset => { fillForm(preset.capabilities, preset.pricing); setSelectedPreset(preset.model); setPricePreset(preset.pricing ? preset.model : ""); };

  const openImport = () => { setImportText(""); setImportResult(null); setImportOpen(true); };
  const readFile = file => { if (!/\.(json|csv|txt)$/i.test(file.name) || file.size > 1024 * 1024) { message.error("只支持不超过 1 MB 的 JSON / CSV 文件"); return false; } const reader = new FileReader(); reader.onload = () => { setImportText(String(reader.result || "")); setImportResult(null); }; reader.onerror = () => message.error("文件读取失败"); reader.readAsText(file); return false; };
  const downloadTemplate = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(importTemplate, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "ooapi-model-pricing-template.json"; link.click(); URL.revokeObjectURL(url); };
  const submitImport = async () => { if (!importText.trim()) return message.warning("请先选择文件"); setImporting(true); try { const result = await API.post("/pricing/import", { text: importText }); setImportResult(result); message.success(`导入完成：新增 ${result.inserted}，更新 ${result.updated}，拒绝 ${result.rejected?.length || 0}`); setRevision(value => value + 1); } catch (e) { message.error(e.message); } finally { setImporting(false); } };
  const prune = async () => { setCleaning(true); try { const result = await API.post("/pricing/prune"); message.success(result.removed?.length ? `已删除 ${result.removed.length} 条无效定价` : "没有发现无效定价"); setRevision(value => value + 1); } catch (e) { message.error(e.message); } finally { setCleaning(false); } };
  const syncUpstream = async () => { setSyncing(true); try { const result = await API.post("/pricing/sync-upstream", { overwrite }); message.success(`已同步 ${result.fetched || 0} 条价目`); setRevision(value => value + 1); } catch (e) { message.error(e.message || "同步失败"); } finally { setSyncing(false); } };

  const columns = [
    { title: "模型", dataIndex: "model", width: compact ? 132 : 235, render: (value, row) => <div className="oo-model-main"><ModelLabel model={value} channelType={row.vendor || row.pricing?.channel_type} /><small title={TYPE_LABEL[row.vendor] || row.vendor}>{TYPE_LABEL[row.vendor] || row.vendor || "未知厂商"}</small></div> },
    { title: "类型", dataIndex: "category", width: 80, responsive: ["md"], render: value => <Tag>{categories[value] || value || "待核实"}</Tag> },
    { title: "上下文", dataIndex: "contextWindow", width: 115, responsive: ["md"], render: value => <span className="oo-num">{count(value)}</span> },
    { title: "最大输出", dataIndex: "maxOutputTokens", width: 115, responsive: ["md"], render: value => <span className="oo-num">{count(value)}</span> },
    { title: "推理", width: 125, responsive: ["md"], render: (_, row) => <span className="oo-model-reasoning">{row.reasoning?.levels?.length ? row.reasoning.levels.join(" / ") : "—"}</span> },
    { title: "输入 / 输出", width: 140, responsive: ["md"], render: (_, row) => <div className="oo-model-modalities"><span>入 <b>{(row.inputTypes || []).map(value => types[value] || value).join(" · ") || "待核实"}</b></span><span>出 <b>{(row.outputTypes || []).map(value => types[value] || value).join(" · ") || "待核实"}</b></span></div> },
    { title: "价格 / 百万 Token", width: 240, render: (_, row) => row.pricing ? <PriceSummary price={row.pricing} /> : <span className="oo-model-unset">尚未配置价格</span> },
    { title: "来源与状态", width: 185, responsive: ["md"], render: (_, row) => <PriceSource row={row} price={row.pricing} /> },
    { title: "", width: compact ? 72 : 88, fixed: "right", render: (_, row) => <Button type="primary" ghost size="small" icon={<SettingOutlined />} loading={opening === row.model} disabled={Boolean(opening) && opening !== row.model} onClick={() => edit(row)}>配置</Button> },
  ];

  const compactColumns = [{ key: "model", render: (_, row) => <div className="oo-model-mobile-row">
    <div className="oo-model-mobile-head"><div className="oo-model-main"><ModelLabel model={row.model} channelType={row.vendor || row.pricing?.channel_type} /><small>{TYPE_LABEL[row.vendor] || row.vendor || "未知厂商"} · {categories[row.category] || "待核实"}</small></div><Button size="small" icon={<SettingOutlined />} loading={opening === row.model} disabled={Boolean(opening) && opening !== row.model} onClick={() => edit(row)}>配置</Button></div>
    <dl className="oo-model-mobile-specs"><div><dt>上下文</dt><dd>{count(row.contextWindow)}</dd></div><div><dt>最大输出</dt><dd>{count(row.maxOutputTokens)}</dd></div><div><dt>推理</dt><dd>{row.reasoning?.levels?.join(" / ") || "—"}</dd></div><div><dt>输入 / 输出</dt><dd>{(row.inputTypes || []).map(value => types[value] || value).join(" · ") || "—"} / {(row.outputTypes || []).map(value => types[value] || value).join(" · ") || "—"}</dd></div></dl>
    <div className="oo-model-mobile-price"><span>价格 / 百万 Token</span>{row.pricing ? <PriceSummary price={row.pricing} /> : <span className="oo-model-unset">尚未配置价格</span>}</div>
    <PriceSource row={row} price={row.pricing} />
  </div> }];

  return <div className="oo-page oo-model-management">
    <PageHeader title="模型管理" tags={<Tag>{rows.length} 个模型</Tag>} extra={<Space wrap size={6}><Button icon={<UploadOutlined />} onClick={openImport}>导入价格</Button><Popconfirm title="从上游同步价目表？" description={overwrite ? "将覆盖已有管理员价格。" : "仅补齐尚未配置的价格。"} onConfirm={syncUpstream} okText="开始同步" cancelText="取消"><Button icon={<CloudDownloadOutlined />} loading={syncing}>同步价目</Button></Popconfirm><Tooltip title="开启后同步会覆盖手动价格"><Checkbox checked={overwrite} onChange={event => setOverwrite(event.target.checked)}>覆盖已有价</Checkbox></Tooltip><Popconfirm title="清理无效定价？" description="删除模型登记表中不存在的价格记录。" onConfirm={prune} okText="清理" cancelText="取消"><Button danger icon={<ClearOutlined />} loading={cleaning}>清理无效数据</Button></Popconfirm><Button icon={<ReloadOutlined />} loading={loading} onClick={() => setRevision(value => value + 1)} aria-label="刷新模型管理" /></Space>} />
    <div className="oo-stats-cards oo-model-management-stats"><StatCard label="平台模型" value={loading ? "—" : rows.length} suffix="个" hint="渠道登记并可配置的模型" /><StatCard label="已配置价格" value={loading ? "—" : configured} suffix="个" hint="已有输入、输出和缓存价格的模型" /><StatCard label="待处理" value={loading ? "—" : pendingCount} suffix="个" hint="尚未设置价格或等待归属确认的模型" /><StatCard label="厂商类型" value={loading ? "—" : vendors.length} suffix="类" hint="当前模型覆盖的渠道厂商类型" /><StatCard label="最低输入价" value={loading ? "—" : cheapest ? Number(cheapest.pricing.input).toFixed(4) : "—"} suffix={<OdCoin size={12} muted />} hint={cheapest ? `对应模型：${cheapest.model}` : "暂无已配置价格"} /></div>
    {error ? <Alert type="error" showIcon message="模型配置加载失败" description={error} action={<Button size="small" onClick={() => setRevision(value => value + 1)}>重试</Button>} /> : null}
    {visibleCatalogPending.length ? <Alert type="info" showIcon message={`有 ${visibleCatalogPending.length} 个官方型号等待定价`} description={<Space wrap size={[4, 4]}>{visibleCatalogPending.map(item => <Tooltip key={item.model} title={item.source}><Tag>{item.model}</Tag></Tooltip>)}</Space>} /> : null}
    <section className="oo-panel oo-model-management-panel">
      <div className="oo-model-management-panel-head"><h2>全部模型</h2><span>{filtered.length} / {rows.length}</span></div>
      <div className="oo-model-management-filters"><Input allowClear prefix={<SearchOutlined />} placeholder="搜索模型、厂商或价格来源" aria-label="搜索模型配置" value={query} onChange={event => setQuery(event.target.value)} /><Select allowClear placeholder="全部类型" aria-label="筛选模型类型" value={category || undefined} onChange={value => setCategory(value || "")} options={optionMap(categories)} /><Select allowClear placeholder="全部厂商" aria-label="筛选模型厂商" value={vendor || undefined} onChange={value => setVendor(value || "")} options={vendors.map(value => ({ value, label: TYPE_LABEL[value] || value }))} /><Select allowClear placeholder="价格状态" aria-label="筛选价格状态" value={priceStatus || undefined} onChange={value => setPriceStatus(value || "")} options={[{ value: "priced", label: "已配置价格" }, { value: "unpriced", label: "待配置价格" }]} /></div>
      <Table className="oo-table" rowKey="model" tableLayout="fixed" loading={loading} dataSource={filtered} showHeader={!compact} columns={compact ? compactColumns : columns} scroll={compact ? undefined : { x: columns.reduce((total, column) => total + column.width, 0) }} pagination={{ pageSize: 20, showSizeChanger: true, showTotal: total => `共 ${total} 个模型` }} locale={{ emptyText: query || category || vendor || priceStatus ? "没有匹配的模型" : "暂无模型" }} />
    </section>
    <ModelAttributions revision={revision} onChange={() => setRevision(value => value + 1)} />
    <section className="oo-panel oo-model-management-help"><div className="oo-panel-head"><span className="oo-panel-title">价格与计费说明</span></div><div className="oo-model-help-grid"><div><b>计算方式</b><span>(输入 Token × 输入价 + 输出 Token × 输出价 + 缓存命中 × 缓存价) ÷ 1,000,000</span></div><div><b>分时价格</b><span>已有峰谷或分档规则的模型会在配置抽屉中保留并显示，切换预设时可选择替换。</span></div><div><b>价格来源</b><span>每条价格保留官方来源或管理员配置依据，模型能力来源可从配置抽屉打开厂商文档。</span></div></div></section>
    <Drawer className="oo-model-config-drawer" title={editing ? <span className="oo-model-drawer-title"><ModelLabel model={editing.model} channelType={editing.vendor} /><span>配置 {editing.model}</span></span> : "模型配置"} open={Boolean(editing)} onClose={() => !saving && setEditing(null)} width="min(720px,100vw)" forceRender footer={<Space><Button disabled={saving} onClick={() => setEditing(null)}>取消</Button><Button type="primary" loading={saving} onClick={save}>保存配置</Button></Space>}>
      {editing ? <>
        <div className="oo-model-drawer-meta"><div><span>模型类型</span><b>{categories[editing.category] || editing.category || "待核实"}</b></div><div><span>开发厂商</span><b>{TYPE_LABEL[editing.vendor] || editing.vendor || "待核实"}</b></div>{editing.documentationUrl ? <a href={editing.documentationUrl} target="_blank" rel="noopener noreferrer"><LinkOutlined /> 厂商文档</a> : null}</div>
        <div className="oo-model-presets"><div><b>常用预设</b><span>会同时回填参数能力和价格，保存后生效。</span></div><Space wrap size={[6, 8]}>{presets.map(preset => <Button key={preset.model} size="small" disabled={saving} type={selectedPreset === preset.model ? "primary" : "default"} aria-pressed={selectedPreset === preset.model} onClick={() => selectPreset(preset)}>{preset.label}</Button>)}</Space>{selectedPreset ? <div className="oo-model-preset-status" role="status">已回填 {presets.find(preset => preset.model === selectedPreset)?.label || selectedPreset}</div> : null}</div>
        <Form form={form} layout="vertical" disabled={saving} onValuesChange={() => setSelectedPreset("")}>
          <div className="oo-model-form-section"><div className="oo-model-form-section-title"><span><DollarOutlined /> 价格与计费</span><small>每百万 Token · OD币</small></div><div className="oo-model-price-fields">{priceFields.map(([key, label]) => <Form.Item key={key} name={`price_${key}`} label={label} rules={[({ getFieldValue }) => ({ validator(_, value) { const required = Boolean(editing?.pricing || pricePreset) || priceFields.some(([field]) => getFieldValue(`price_${field}`) != null); return !required || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100000) ? Promise.resolve() : Promise.reject(new Error("请填写 0–100000 的价格")); } })]}><InputNumber id={`price_${key}`} min={0} max={100000} precision={6} placeholder="未配置" style={{ width: "100%" }} /></Form.Item>)}</div>{pricingRules && hasPriceRules(pricingRules) ? <><Form.Item name="keepRules" valuePropName="checked"><Checkbox>保留已有分档与分时价格</Checkbox></Form.Item><Collapse size="small" items={[{ key: "rules", label: "查看当前分档与分时规则", children: <PriceRules price={pricingRules} /> }]} /></> : <span className="oo-model-form-hint">缓存价为 0 时沿用输入价；切换价格预设会按预设更新附加规则。</span>}</div>
          <div className="oo-model-form-section"><div className="oo-model-form-section-title"><span><SettingOutlined /> 参数与能力</span><small>对话界面和网关按这里的能力显示</small></div><Form.Item name="category" label="模型类型"><Select options={optionMap(categories)} /></Form.Item><div className="oo-model-form-grid">{[["contextWindow", "上下文窗口"], ["maxOutputTokens", "最大输出 tokens"]].map(([name, label]) => <Form.Item key={name} name={name} label={label}><InputNumber min={1} max={10000000} precision={0} placeholder="未核实" style={{ width: "100%" }} /></Form.Item>)}</div><Form.Item name="inputTypes" label="原生输入类型"><Select mode="multiple" options={optionMap(types)} /></Form.Item><Form.Item name="outputTypes" label="输出类型"><Select mode="multiple" options={optionMap(types)} /></Form.Item><div className="oo-model-form-grid">{Object.entries(flags).map(([name, label]) => <Form.Item key={name} name={name} label={label}><Select options={tri} /></Form.Item>)}</div></div>
          <div className="oo-model-form-section"><div className="oo-model-form-section-title"><span>推理参数</span></div><Form.Item name="levels" label="自定义推理等级"><Select mode="tags" placeholder="如 low、medium、high" tokenSeparators={[",", " "]} /></Form.Item><div className="oo-model-form-grid"><Form.Item name="defaultLevel" label="默认思考强度"><Select allowClear options={levels.map(value => ({ value, label: value }))} /></Form.Item><Form.Item name="parameter" label="推理参数映射"><Select options={reasoningParameters.map(value => ({ value, label: value || "跟随上游默认" }))} /></Form.Item></div><Form.Item name="values" label="等级与参数值（JSON）"><Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} spellCheck={false} /></Form.Item><Form.Item name="notes" label="能力说明"><Input.TextArea maxLength={1200} autoSize={{ minRows: 2, maxRows: 5 }} /></Form.Item></div>
        </Form>
        <div className="oo-model-drawer-sources">{(editing.sources || []).map((source, index) => <p key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.scope || "官方来源"}</a> · {source.checkedAt}{source.model ? ` · ${source.model}` : ""}</p>)}</div>
      </> : null}
    </Drawer>
    <Modal title="导入模型价格" open={importOpen} onCancel={() => setImportOpen(false)} onOk={submitImport} okText={importResult ? "继续导入" : "开始导入"} confirmLoading={importing} width={680}><Alert type="info" showIcon message="支持 JSON / CSV，导入后仍会按平台模型登记表校验" description={<div>必填字段：model、input、output；可选 cache、分时价格和 remark。<Button type="link" size="small" onClick={downloadTemplate}>下载模板</Button></div>} /><Input.TextArea value={importText} onChange={event => setImportText(event.target.value)} placeholder="粘贴 JSON 或 CSV 内容，也可以选择文件" autoSize={{ minRows: 8, maxRows: 16 }} style={{ marginTop: 14 }} /><Space style={{ marginTop: 10 }}><label className="oo-model-file-button"><input type="file" accept=".json,.csv,.txt" onChange={event => event.target.files?.[0] && readFile(event.target.files[0])} />选择文件</label>{importText ? <Tag color="blue">已读取 {importText.length} 字符</Tag> : null}</Space>{importResult ? <div className="oo-model-import-result"><Space size={8} wrap><Tag color="green">新增 {importResult.inserted}</Tag><Tag color="blue">更新 {importResult.updated}</Tag><Tag color={importResult.rejected?.length ? "red" : "default"}>拒绝 {importResult.rejected?.length || 0}</Tag><Tag>共 {importResult.total}</Tag></Space>{importResult.rejected?.length ? <div className="oo-scroll" style={{ maxHeight: 220, marginTop: 8 }}><Table size="small" rowKey={row => `${row.line}-${row.model}`} pagination={false} dataSource={importResult.rejected} columns={[{ title: "行", dataIndex: "line", width: 56 }, { title: "模型", dataIndex: "model", width: 160, ellipsis: true }, { title: "拒绝原因", dataIndex: "reason" }]} /></div> : <span className="oo-model-form-hint">全部行已通过校验</span>}</div> : null}</Modal>
  </div>;
}
