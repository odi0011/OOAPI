import React, { useEffect, useState } from "react";
import { App, Alert, Button, Drawer, Form, Input, InputNumber, Select, Space, Table, Tabs, Tag } from "antd";
import { LinkOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import { ModelLabel } from "../components/VendorIcon";
import AdminPricingPage from "./AdminPricingPage";

const types = { text: "文本", image: "图片", video: "视频", audio: "音频", pdf: "PDF", embedding: "向量" };
const categories = { chat: "对话", image: "生图", video: "生视频", audio: "音频", embedding: "嵌入", rerank: "重排", decision: "决策" };
const flags = { structuredOutput: "结构化输出", nativeSearch: "原生联网", systemMessages: "对话中系统消息", toolCalling: "工具调用" };
const tri = [{ value: "unknown", label: "未核实" }, { value: "yes", label: "支持" }, { value: "no", label: "不支持" }];
const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const count = n => n == null ? "待核实" : n.toLocaleString();
function Capabilities() {
  const { message } = App.useApp(), [form] = Form.useForm();
  const [data, setData] = useState([]), [parameters, setParameters] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [editing, setEditing] = useState(null), [saving, setSaving] = useState(false);
  const [presets, setPresets] = useState([]), [selectedPreset, setSelectedPreset] = useState("");
  const levels = Form.useWatch("levels", form) || [];
  useEffect(() => {
    let live = true;
    API.get("/pricing/capabilities").then(r => { if (live) { setData(r.items); setParameters(r.reasoningParameters); setPresets(r.presets || []); } }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const fillForm = row => {
    // 清掉上一预设的推理映射和空值，仅回填可编辑参数，保持当前模型身份与文档来源。
    form.resetFields();
    const reasoning = row.reasoning || {};
    form.setFieldsValue({ category: row.category, contextWindow: row.contextWindow ?? null, maxOutputTokens: row.maxOutputTokens ?? null, inputTypes: [...(row.inputTypes || [])], outputTypes: [...(row.outputTypes || [])], notes: row.notes || "", ...Object.fromEntries(Object.keys(flags).map(k => [k, row[k] == null ? "unknown" : row[k] ? "yes" : "no"])), levels: [...(reasoning.levels || [])], defaultLevel: reasoning.defaultLevel || undefined, parameter: reasoning.parameter || "", values: JSON.stringify(reasoning.values || {}, null, 2) });
  };
  const edit = row => {
    fillForm(row);
    setSelectedPreset("");
    setEditing(row);
  };
  const save = async () => {
    let v; try { v = await form.validateFields(); } catch { return; }
    let values; try { values = JSON.parse(v.values || "{}"); } catch { message.error("推理映射不是合法 JSON"); return; }
    setSaving(true);
    try {
      const capabilities = { ...v, ...Object.fromEntries(Object.keys(flags).map(k => [k, v[k] === "unknown" ? null : v[k] === "yes"])), reasoning: { levels: v.levels || [], defaultLevel: v.defaultLevel || "", parameter: v.parameter || "", values } };
      const saved = await API.put("/pricing/capabilities", { model: editing.model, capabilities });
      setData(rows => rows.map(r => r.model === editing.model ? { ...r, ...saved } : r)); setEditing(null); message.success("模型能力已保存");
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
      { title:"",width:75,render:(_,r)=><Button size="small" type="link" onClick={()=>edit(r)}>配置</Button> },
    ]}/>
    <Drawer title={editing ? `配置 ${editing.model}` : "模型能力"} open={Boolean(editing)} onClose={()=>!saving&&setEditing(null)} width="min(600px,100vw)" forceRender footer={<Space><Button disabled={saving} onClick={()=>setEditing(null)}>取消</Button><Button type="primary" loading={saving} onClick={save}>保存</Button></Space>}>
      <div style={{marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:10,fontSize:12}}>
          <span style={{color:"var(--ink-2)"}}>快速预设</span>
          {editing?.documentationUrl && <a href={editing.documentationUrl} target="_blank" rel="noopener noreferrer"><LinkOutlined/> 厂商文档</a>}
        </div>
        <Space size={[6,8]} wrap>{presets.map(preset=><Button key={preset.model} size="small" disabled={saving} type={selectedPreset===preset.model?"primary":"default"} aria-pressed={selectedPreset===preset.model} onClick={()=>{fillForm(preset.capabilities);setSelectedPreset(preset.model);}}>{preset.label}</Button>)}</Space>
        <div role="status" style={{marginTop:8,fontSize:12,color:"var(--ink-3)"}}>{selectedPreset?`已回填 ${presets.find(p=>p.model===selectedPreset)?.label || selectedPreset}，保存后生效。`:"选择预设回填全部参数，可继续调整后保存。"}</div>
      </div>
      <Form form={form} layout="vertical" disabled={saving} onValuesChange={()=>setSelectedPreset("")}>
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
  return <div className="oo-page"><PageHeader title="模型管理"/><Tabs items={[{key:"capabilities",label:"参数与能力",children:<Capabilities/>},{key:"pricing",label:"价格与计费",children:<AdminPricingPage/>}]}/></div>;
}
