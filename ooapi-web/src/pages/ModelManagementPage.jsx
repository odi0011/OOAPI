import React, { useEffect, useState } from "react";
import { App, Alert, Button, Checkbox, Collapse, Drawer, Form, Input, InputNumber, Select, Space, Table, Tabs, Tag } from "antd";
import { LinkOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import { ModelLabel } from "../components/VendorIcon";
import { OdCoin } from "../components/OdCoin";
import OdAmount from "../components/OdAmount";
import AdminPricingPage from "./AdminPricingPage";

const types = { text: "文本", image: "图片", video: "视频", audio: "音频", pdf: "PDF", embedding: "向量" };
const categories = { chat: "对话", image: "生图", video: "生视频", audio: "音频", embedding: "嵌入", rerank: "重排", decision: "决策" };
const flags = { structuredOutput: "结构化输出", nativeSearch: "原生联网", systemMessages: "对话中系统消息", toolCalling: "工具调用" };
const tri = [{ value: "unknown", label: "未核实" }, { value: "yes", label: "支持" }, { value: "no", label: "不支持" }];
const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const count = n => n == null ? "待核实" : n.toLocaleString();
const priceFields = [["input", "输入价格"], ["output", "输出价格"], ["cache", "缓存命中价格"]];
const hasPriceRules = price => Boolean(price?.tiers?.length || price?.offpeakRule);
function PriceRules({ price }) {
  const amounts = p => <span>输入 <OdAmount>{p.input ?? "沿用基准"}</OdAmount> · 输出 <OdAmount>{p.output ?? "沿用基准"}</OdAmount> · 缓存 <OdAmount>{p.cache ?? "沿用基准"}</OdAmount></span>;
  let rule = price.offpeakRule;
  if (typeof rule === "string") { try { rule = JSON.parse(rule); } catch { rule = null; } }
  return <div style={{fontSize:12,color:"var(--ink-2)"}}>
    {(price.tiers || []).map(t => <p key={t.from || t.minInputTokens}>{t.from ? `${t.from.slice(0,10)} 起（UTC）` : `输入 ≥ ${Number(t.minInputTokens).toLocaleString()} Token`}<br/>{amounts(t)}</p>)}
    {rule && <><p>高峰：UTC{Number(rule.offset)>=0?"+":""}{rule.offset || 0} · 周{(rule.days || [1,2,3,4,5]).join("/")} · {(rule.peak || []).map(w=>w.join("–")).join("、")}；其余时段按闲时价{rule.offpeakDates?.length?"（含已配置假期）":""}。</p><p>闲时：{amounts({input:price.offpeakInput,output:price.offpeakOutput,cache:price.offpeakCache})}</p></>}
  </div>;
}
function Capabilities({ onSaved }) {
  const { message } = App.useApp(), [form] = Form.useForm();
  const [data, setData] = useState([]), [parameters, setParameters] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [editing, setEditing] = useState(null), [saving, setSaving] = useState(false);
  const [presets, setPresets] = useState([]), [selectedPreset, setSelectedPreset] = useState("");
  const [opening, setOpening] = useState(""), [pricePreset, setPricePreset] = useState(""), [pricingRules, setPricingRules] = useState(null);
  const levels = Form.useWatch("levels", form) || [];
  const keepRules = Form.useWatch("keepRules", form);
  useEffect(() => {
    let live = true;
    API.get("/pricing/capabilities").then(r => { if (live) { setData(r.items); setParameters(r.reasoningParameters); setPresets(r.presets || []); } }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const fillForm = (row, pricing) => {
    // 清掉上一预设的推理映射和空值，仅回填可编辑参数，保持当前模型身份与文档来源。
    form.resetFields();
    const reasoning = row.reasoning || {};
    form.setFieldsValue({ category: row.category, contextWindow: row.contextWindow ?? null, maxOutputTokens: row.maxOutputTokens ?? null, inputTypes: [...(row.inputTypes || [])], outputTypes: [...(row.outputTypes || [])], notes: row.notes || "", ...Object.fromEntries(Object.keys(flags).map(k => [k, row[k] == null ? "unknown" : row[k] ? "yes" : "no"])), levels: [...(reasoning.levels || [])], defaultLevel: reasoning.defaultLevel || undefined, parameter: reasoning.parameter || "", values: JSON.stringify(reasoning.values || {}, null, 2) });
    form.setFieldsValue({ ...Object.fromEntries(priceFields.map(([key])=>[`price_${key}`,pricing?.[key] ?? null])), keepRules: true });
    setPricingRules(pricing || null);
  };
  const edit = async row => {
    setOpening(row.model);
    try {
      // 价格页可能刚刚同步过，打开抽屉时重新读取，避免用旧价格覆盖新配置。
      const result = await API.get("/pricing/capabilities", { params: { model: row.model } });
      const fresh = result.items.find(item=>item.model===row.model);
      if (!fresh) throw new Error("模型已移除，请刷新列表");
      fillForm(fresh, fresh.pricing); setPresets(result.presets || []);
      setSelectedPreset(""); setPricePreset(""); setEditing(fresh);
    } catch (e) { message.error(e.message); } finally { setOpening(""); }
  };
  const save = async () => {
    let v; try { v = await form.validateFields(); } catch { return; }
    let values; try { values = JSON.parse(v.values || "{}"); } catch { message.error("推理映射不是合法 JSON"); return; }
    setSaving(true);
    try {
      const capabilities = { ...v, ...Object.fromEntries(Object.keys(flags).map(k => [k, v[k] === "unknown" ? null : v[k] === "yes"])), reasoning: { levels: v.levels || [], defaultLevel: v.defaultLevel || "", parameter: v.parameter || "", values } };
      const pricing = priceFields.some(([key])=>v[`price_${key}`]!=null) ? { ...Object.fromEntries(priceFields.map(([key])=>[key,v[`price_${key}`]])), presetModel: pricePreset, keepRules: v.keepRules !== false } : undefined;
      const saved = await API.put("/pricing/capabilities", { model: editing.model, capabilities, pricing });
      setData(rows => rows.map(r => r.model === editing.model ? { ...r, ...saved } : r)); setEditing(null); onSaved(); message.success(pricing ? "模型能力与价格已保存" : "模型能力已保存");
    } catch (e) { message.error(e.message); } finally { setSaving(false); }
  };
  return <div className="oo-panel">
    <div className="oo-toolbar"><Input.Search aria-label="搜索模型能力" placeholder="搜索模型或厂商" value={query} onChange={e => setQuery(e.target.value)} style={{ maxWidth: 340 }}/><span style={{color:"var(--ink-3)",fontSize:12}}>来源核对：2026-10-03 · 手动配置优先</span></div>
    {error && <Alert type="error" message={error}/>}
    <Table className="oo-table" rowKey="model" size="small" loading={loading} dataSource={data.filter(r => `${r.model} ${r.vendor}`.toLowerCase().includes(query.toLowerCase()))} scroll={{x:1060}} pagination={{pageSize:20,showTotal:n=>`${n} 个模型`}} columns={[
      { title:"模型",dataIndex:"model",width:250,render:(v,r)=><ModelLabel model={v} channelType={r.vendor}/> },
      { title:"类型",dataIndex:"category",width:85,render:v=>categories[v] || v },
      { title:"上下文 / 最大输出",width:200,render:(_,r)=><span>{count(r.contextWindow)} / {count(r.maxOutputTokens)}</span> },
      { title:"输入",width:145,render:(_,r)=>r.inputTypes.map(t=>types[t] || t).join("、") },
      { title:"思考等级",width:185,render:(_,r)=>r.reasoning.levels.join(" · ") || "模型默认" },
      { title:"参数依据",width:135,render:(_,r)=><Tag>{r.customized?"自定义":r.verification==="official"?"原厂已核实":r.verification==="provider"?"服务商目录":"待核实"}</Tag> },
      { title:"",width:75,render:(_,r)=><Button size="small" type="link" loading={opening===r.model} disabled={Boolean(opening)&&opening!==r.model} onClick={()=>edit(r)}>配置</Button> },
    ]}/>
    <Drawer title={editing ? `配置 ${editing.model}` : "模型能力"} open={Boolean(editing)} onClose={()=>!saving&&setEditing(null)} width="min(600px,100vw)" forceRender footer={<Space><Button disabled={saving} onClick={()=>setEditing(null)}>取消</Button><Button type="primary" loading={saving} onClick={save}>保存</Button></Space>}>
      <div style={{marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:10,fontSize:12}}>
          <span style={{color:"var(--ink-2)"}}>快速预设</span>
          {editing?.documentationUrl && <a href={editing.documentationUrl} target="_blank" rel="noopener noreferrer"><LinkOutlined/> 厂商文档</a>}
        </div>
        <Space size={[6,8]} wrap>{presets.map(preset=><Button key={preset.model} size="small" disabled={saving} type={selectedPreset===preset.model?"primary":"default"} aria-pressed={selectedPreset===preset.model} onClick={()=>{fillForm(preset.capabilities,preset.pricing);setSelectedPreset(preset.model);setPricePreset(preset.pricing?preset.model:"");}}>{preset.label}</Button>)}</Space>
        <div role="status" style={{marginTop:8,fontSize:12,color:"var(--ink-3)"}}>{selectedPreset?`已回填 ${presets.find(p=>p.model===selectedPreset)?.label || selectedPreset} 的参数与价格，保存后生效。`:"选择预设回填参数与价格，可继续调整后保存。"}</div>
      </div>
      <Form form={form} layout="vertical" disabled={saving} onValuesChange={()=>setSelectedPreset("")}>
        <div style={{padding:"14px 14px 0",marginBottom:20,border:"1px solid var(--line)",borderRadius:10}}>
          <div style={{fontSize:12,marginBottom:12}}>模型价格 <span style={{color:"var(--ink-3)"}}>· 每百万 Token <OdCoin/></span></div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12}}>{priceFields.map(([key,label])=><Form.Item key={key} name={`price_${key}`} label={label} rules={[({getFieldValue})=>({validator(_,value){
            const required = Boolean(editing?.pricing || pricePreset) || priceFields.some(([k])=>getFieldValue(`price_${k}`)!=null);
            return !required || (typeof value==="number" && Number.isFinite(value) && value>=0 && value<=100000) ? Promise.resolve() : Promise.reject(new Error("请填写 0–100000 的价格"));
          }})]}><InputNumber min={0} max={100000} precision={6} placeholder="未配置" style={{width:"100%"}}/></Form.Item>)}</div>
          <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:14}}>缓存价为 0 时沿用输入价。{pricePreset?`已采用 ${presets.find(p=>p.model===pricePreset)?.label || pricePreset} 的内置价格预设。`:""}</div>
          <Form.Item name="keepRules" valuePropName="checked" hidden={!hasPriceRules(pricingRules)} style={{marginBottom:12}}><Checkbox>启用分档与分时价格</Checkbox></Form.Item>
          {hasPriceRules(pricingRules) && <Collapse size="small" style={{marginBottom:14}} items={[{key:"rules",label:keepRules===false?"附加价格规则（保存后关闭）":"查看分档与分时价格",children:<PriceRules price={pricingRules}/>}]} />}
        </div>
        <Form.Item name="category" label="模型类型"><Select options={options(categories)}/></Form.Item>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>{[["contextWindow","上下文窗口"],["maxOutputTokens","最大输出 tokens"]].map(([name,label])=><Form.Item key={name} name={name} label={label}><InputNumber min={1} max={10000000} precision={0} placeholder="未核实" style={{width:"100%"}}/></Form.Item>)}</div>
        <Form.Item name="inputTypes" label="原生输入类型"><Select mode="multiple" options={options(types)}/></Form.Item>
        <Form.Item name="outputTypes" label="输出类型"><Select mode="multiple" options={options(types)}/></Form.Item>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>{Object.entries(flags).map(([name,label])=><Form.Item key={name} name={name} label={label}><Select options={tri}/></Form.Item>)}</div>
        <Form.Item name="levels" label="自定义推理等级"><Select mode="tags" placeholder="如 low、medium、high" tokenSeparators={[","," "]}/></Form.Item>
        <Form.Item name="defaultLevel" label="默认思考强度"><Select allowClear options={levels.map(value=>({value,label:value}))}/></Form.Item>
        <Form.Item name="parameter" label="推理参数映射"><Select options={parameters.map(value=>({value,label:value||"跟随上游默认"}))}/></Form.Item>
        <Form.Item name="values" label="等级与参数值（JSON）"><Input.TextArea autoSize={{minRows:3,maxRows:9}} spellCheck={false}/></Form.Item>
        <Form.Item name="notes" label="能力说明"><Input.TextArea maxLength={1200} autoSize={{minRows:2,maxRows:6}}/></Form.Item>
      </Form>
      <div style={{fontSize:12,color:"var(--ink-3)"}}>{editing?.sources?.map((s,i)=><p key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.scope || "官方来源"}</a> · {s.checkedAt}{s.model?` · ${s.model}`:""}</p>)}</div>
    </Drawer>
  </div>;
}
export default function ModelManagementPage() {
  const [priceRevision,setPriceRevision] = useState(0);
  const refreshPrices = ()=>setPriceRevision(v=>v+1);
  return <div className="oo-page"><PageHeader title="模型管理"/><Tabs onChange={refreshPrices} items={[{key:"capabilities",label:"参数与能力",children:<Capabilities onSaved={refreshPrices}/>},{key:"pricing",label:"价格与计费",children:<AdminPricingPage refreshKey={priceRevision}/>} ]}/></div>;
}
