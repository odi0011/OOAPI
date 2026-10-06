import React, { useEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Badge, Button, Checkbox, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tabs } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { binanceApi, date, EnvTag, Panel, positive, required } from "./shared";

function Accounts({ accounts, act, busy }) {
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const environment = Form.useWatch("environment", form);
  const show = (row) => {
    form.resetFields();
    form.setFieldsValue(row ? { name: row.name, environment: row.environment, allow_live_trading: row.allow_live_trading } : { name: "", environment: "demo", allow_live_trading: false });
    setEditing(row || null); setOpen(true);
  };
  const submit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        delete values.environment;
        if (!values.api_key) delete values.api_key;
        if (!values.secret_key) delete values.secret_key;
      }
      await act("account-form", () => editing ? binanceApi.patch(`/accounts/${editing.id}`, values) : binanceApi.post("/accounts", values), "账户已保存");
      setOpen(false);
    } catch { /* act/Form 已显示错误 */ }
  };
  return <>
    <Panel title="账户" extra={<Button aria-label="添加账户" type="primary" icon={<PlusOutlined />} onClick={() => show()}>添加账户</Button>} flush>
      <Table className="oo-table" rowKey="id" size="small" dataSource={accounts} pagination={false} scroll={{ x: 850 }} columns={[
        { title: "账户", dataIndex: "name", width: 180, ellipsis: true },
        { title: "环境", dataIndex: "environment", render: (value) => <EnvTag value={value} /> },
        { title: "状态", dataIndex: "active", render: (value) => <Badge status={value ? "success" : "default"} text={value ? "已启用" : "已停用"} /> },
        { title: "最近同步", dataIndex: "last_sync_at", render: date },
        { title: "操作", key: "action", width: 250, render: (_, row) => <Space size={0}>
          <Button type="text" size="small" onClick={() => show(row)}>配置</Button>
          <Button type="text" size="small" loading={busy[`validate-${row.id}`]} onClick={() => { act(`validate-${row.id}`, () => binanceApi.post(`/accounts/${row.id}/validate`), "账户连接正常").catch(() => {}); }}>检测</Button>
          <Button type="text" size="small" loading={busy[`sync-${row.id}`]} onClick={() => { act(`sync-${row.id}`, () => binanceApi.post(`/accounts/${row.id}/sync`), "已同步").catch(() => {}); }}>同步</Button>
          <Popconfirm title={row.active ? "停用账户并暂停关联策略？" : "启用此账户？"} onConfirm={() => act(`account-${row.id}`, () => binanceApi.patch(`/accounts/${row.id}`, { active: !row.active }))}><Button type="text" size="small" loading={busy[`account-${row.id}`]}>{row.active ? "停用" : "启用"}</Button></Popconfirm>
        </Space> },
      ]} expandable={{ expandedRowRender: (row) => <Alert type="error" showIcon message={row.last_sync_error} />, rowExpandable: (row) => !!row.last_sync_error }} />
    </Panel>
    <Modal title={editing ? "配置账户" : "添加账户"} open={open} onCancel={() => { if (!busy["account-form"]) setOpen(false); }} onOk={submit} confirmLoading={busy["account-form"]} okText="保存" destroyOnClose>
      <Form form={form} layout="vertical" preserve={false} autoComplete="off">
        <Form.Item name="name" label="名称" rules={[required]}><Input maxLength={80} /></Form.Item>
        <Form.Item name="environment" label="环境" rules={[required]}><Select disabled={!!editing} options={[{ value: "demo", label: "模拟盘" }, { value: "testnet", label: "测试网" }, { value: "live", label: "实盘" }]} /></Form.Item>
        {environment !== "demo" && <>
          <Form.Item name="api_key" label="API Key" rules={editing ? [] : [required, { min: 8, message: "密钥至少 8 位" }]}><Input.Password autoComplete="new-password" placeholder={editing ? "留空保留原密钥" : ""} /></Form.Item>
          <Form.Item name="secret_key" label="Secret Key" rules={editing ? [] : [required, { min: 8, message: "密钥至少 8 位" }]}><Input.Password autoComplete="new-password" placeholder={editing ? "留空保留原密钥" : ""} /></Form.Item>
        </>}
        {environment === "live" && <Form.Item name="allow_live_trading" valuePropName="checked"><Checkbox>允许此账户实盘交易</Checkbox></Form.Item>}
      </Form>
    </Modal>
  </>;
}

function Risk({ accountId, act, busy }) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    const current = ++version.current;
    form.resetFields(); setReady(false); setError("");
    if (!accountId) return undefined;
    setLoading(true);
    binanceApi.get(`/risk/${accountId}`).then((risk) => { if (version.current === current) { form.setFieldsValue(risk); setReady(true); } }).catch((e) => { if (version.current === current) setError(e.message); }).finally(() => { if (version.current === current) setLoading(false); });
    return () => { version.current++; };
  }, [accountId, form]);
  const save = async () => {
    try { const values = await form.validateFields(); await act("risk", () => binanceApi.put(`/risk/${accountId}`, values), "风控已保存"); }
    catch { /* act/Form 已显示错误 */ }
  };
  const fields = [
    ["max_order_notional", "单笔金额 · USDT", 0.01, undefined],
    ["max_margin_ratio", "保证金比例（0–1）", 0.001, 1],
    ["max_daily_loss", "每日亏损上限 · USDT", 0.01, undefined],
    ["max_open_positions", "最大仓位数", 1, 100],
    ["max_leverage", "最大杠杆", 1, 125],
    ["liquidation_buffer_pct", "强平缓冲比例（0–0.5）", 0, 0.5],
  ];
  return <Panel title="风控" extra={<Button type="primary" disabled={!ready} loading={busy.risk || loading} onClick={save}>保存</Button>}>
    {error && <Alert type="error" message={error} />}
    <Form form={form} layout="vertical" disabled={!accountId || loading}>
      <Row gutter={24}>{fields.map(([key, label, min, max]) => <Col xs={24} sm={12} lg={8} key={key}><Form.Item name={key} label={label} rules={[required, ...(min > 0 ? [positive] : [])]}><InputNumber min={min} max={max} precision={key === "max_open_positions" || key === "max_leverage" ? 0 : undefined} className="oo-binance-full" /></Form.Item></Col>)}</Row>
      <Form.Item name="trading_halted" valuePropName="checked"><Checkbox>停止开仓（仍允许平仓）</Checkbox></Form.Item>
    </Form>
  </Panel>;
}

function Connection({ act, busy }) {
  const { modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [network, setNetwork] = useState(null);
  useEffect(() => {
    let alive = true;
    binanceApi.get("/platform").then((data) => { if (alive) { form.setFieldsValue(data); setReady(true); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [form]);
  const save = async () => {
    try {
      const values = await form.validateFields();
      if (values.allow_live_trading) {
        const confirmed = await modal.confirm({ title: "启用本用户的实盘交易？", content: "启用后，允许实盘的账户可以提交真实订单。", okText: "启用", cancelText: "取消" });
        if (!confirmed) return;
      }
      await act("platform", () => binanceApi.put("/platform", values), "连接配置已保存");
    } catch { /* act/Form 已显示错误 */ }
  };
  return <Panel title="连接与交易" extra={<Space><Button disabled={!ready} loading={busy.network} onClick={() => { act("network", () => binanceApi.post("/platform/network")).then((result) => { if (result) setNetwork(result); }).catch(() => {}); }}>检测连接</Button><Button type="primary" disabled={!ready} loading={busy.platform} onClick={save}>保存</Button></Space>}>
    {error && <Alert type="error" message={error} />}
    <Form form={form} layout="vertical" initialValues={{ proxy_url: "", allow_live_trading: false }} disabled={!ready}>
      <Form.Item name="proxy_url" label="HTTP 代理" rules={[{ pattern: /^(|https?:\/\/[^\s]+)$/, message: "请输入 HTTP 代理地址" }]}><Input placeholder="http://127.0.0.1:7892" /></Form.Item>
      <Form.Item name="allow_live_trading" label="实盘交易" valuePropName="checked"><Switch checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item>
    </Form>
    {network && <Space direction="vertical">{["live", "testnet"].map((key) => <Space key={key} wrap><Badge status={network[key]?.connected ? "success" : "error"} text={`${key === "live" ? "实盘" : "测试网"} ${network[key]?.connected ? "已连接" : "未连接"}`} />{network[key]?.error && <span className="oo-muted">{network[key].error}</span>}</Space>)}</Space>}
  </Panel>;
}

export default function Settings(props) {
  return <Tabs type="card" items={[
    { key: "accounts", label: "账户", children: <Accounts {...props} /> },
    { key: "risk", label: "风控", children: <Risk {...props} /> },
    { key: "connection", label: "连接", children: <Connection {...props} /> },
  ]} destroyInactiveTabPane />;
}
