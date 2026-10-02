import React, { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag } from "antd";
import { API } from "../services/api";
import { ModelLabel } from "./VendorIcon";
import OdAmount from "./OdAmount";
import { OdCoin } from "./OdCoin";

export default function ModelAttributions({ revision, onChange }) {
  const { message } = App.useApp();
  const [data, setData] = useState({ models: [], aliases: [] }), [prices, setPrices] = useState([]);
  const [targets, setTargets] = useState({}), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [editing, setEditing] = useState(null), [form] = Form.useForm();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, all] = await Promise.all([API.get("/pricing/attribution"), API.get("/pricing/")]);
      setData(next); setPrices(all); setError("");
    } catch(e) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load, revision]);
  const refresh = async () => { await load(); onChange?.(); window.dispatchEvent(new Event("ooapi:badges")); };
  const confirm = async (row) => {
    try { await API.post("/pricing/attribution", { alias: row.model, model: targets[row.model] }); message.success("归属已确认"); await refresh(); }
    catch(e) { message.error(e.message); }
  };
  const savePrice = async () => {
    let values; try { values = await form.validateFields(); } catch { return; }
    try {
      const result = await API.post("/pricing/import", { text: JSON.stringify({ prices: [{ model: editing.model, ...values }] }) });
      if (result.rejected?.length) throw new Error(result.rejected[0].reason || "价格未保存");
      setEditing(null); message.success("价格已保存"); await refresh();
    } catch(e) { message.error(e.message); }
  };
  return <section className="oo-panel">
    <div className="oo-panel-head"><span className="oo-panel-title">模型归属 <Tag color={data.count ? "warning" : "success"}>{data.count || 0} 个待定价</Tag></span><Button size="small" onClick={load} loading={loading}>刷新</Button></div>
    {error ? <Alert type="error" showIcon message={error} /> : null}
    <Table className="oo-table" rowKey="model" size="small" loading={loading} dataSource={data.models} scroll={{ x: 850 }} pagination={{ pageSize: 8 }} locale={{ emptyText: "渠道型号均已定价" }} columns={[
      { title: "渠道型号", width: 250, render: (_, row) => <ModelLabel model={row.model} channelType={row.type} /> },
      { title: "渠道", width: 150, render: (_, row) => row.channels.map(c => c.name).join("、") },
      { title: "比对归属", render: (_, row) => <Select style={{ width: "100%" }} allowClear showSearch optionFilterProp="label" placeholder={row.candidates.length ? `建议比对 ${row.candidates[0].model}` : "选择已定价模型"} value={targets[row.model]} onChange={v => setTargets(prev => ({ ...prev, [row.model]: v }))} disabled={/^(auto|default|latest)$/.test(row.model.split("/").pop())} options={[...row.candidates.map(p => p.model), ...prices.map(p => p.model)].filter((m,i,a) => a.indexOf(m) === i && m !== row.model).map(model => ({ value: model, label: model }))} /> },
      { title: "操作", width: 175, render: (_, row) => <Space size={4}>
        <Popconfirm title="确认同一模型？" description={<div>同名渠道型号将统一使用目标模型的名称、图标和单价。<div>{row.model} → {targets[row.model]}</div>{(() => { const p = prices.find(p => p.model === targets[row.model]); return p ? <span>输入 <OdAmount>{p.input_price}</OdAmount> / 输出 <OdAmount>{p.output_price}</OdAmount></span> : null; })()}</div>} onConfirm={() => confirm(row)} disabled={!targets[row.model]}><Button size="small" type="link" disabled={!targets[row.model]}>确认归属</Button></Popconfirm>
        <Button size="small" type="link" onClick={() => { form.resetFields(); setEditing(row); }}>单独定价</Button>
      </Space> },
    ]} />
    {data.aliases.length ? <Table className="oo-table" rowKey="alias" size="small" dataSource={data.aliases} pagination={{ pageSize: 5 }} columns={[
      { title: "已确认的渠道型号", dataIndex: "alias" }, { title: "计费模型", dataIndex: "model" },
      { title: "操作", width: 85, render: (_, row) => <Popconfirm title="撤销此归属？" description="没有独立价格的型号将立即停止对用户开放。" onConfirm={async () => { try { await API.del("/pricing/attribution", { body: { alias: row.alias } }); await refresh(); } catch(e) { message.error(e.message); } }}><Button type="link" size="small">撤销</Button></Popconfirm> },
    ]} /> : null}
    <Modal title={`模型定价：${editing?.model || ""}`} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={savePrice} okText="保存价格" destroyOnClose>
      <Form form={form} layout="vertical" requiredMark={false}>
        {[['input','输入 / 百万 Token'],['output','输出 / 百万 Token'],['cache','缓存读取 / 百万 Token']].map(([name,label]) => <Form.Item key={name} name={name} label={label} rules={[{ required: true, message: "请输入已核实的单价" }]}><InputNumber min={0} max={100000} precision={6} suffix={<OdCoin size={14} />} style={{ width: "100%" }} /></Form.Item>)}
        <Form.Item name="remark" label="价格来源" rules={[{ required: true, whitespace: true, message: "填写官方来源或管理员定价依据" }]}><Input maxLength={255} /></Form.Item>
      </Form>
    </Modal>
  </section>;
}
