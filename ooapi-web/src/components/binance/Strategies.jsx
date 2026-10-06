import React, { useEffect, useRef, useState } from "react";
import {   Alert, App as ArcApp, Button, Checkbox, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table  } from "../arc/index";
import { PlusOutlined  } from "../arc/icons";
import { binanceApi, date, Panel, Pnl, positionsOptions, positive, required, StatusTag, symbolRule } from "./shared";

export default function Strategies({ strategies, account, accountId, act, busy }) {
  const { modal } = ArcApp.useApp();
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [logStrategy, setLogStrategy] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logError, setLogError] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const version = useRef(0);
  const [form] = Form.useForm();
  const strategyType = Form.useWatch("strategy_type", form);
  const openForm = (row) => {
    form.resetFields();
    form.setFieldsValue(row ? { ...row.config, name: row.name, symbol: row.symbol, timeframe: row.timeframe, strategy_type: row.strategyType } : { name: "", symbol: "BTCUSDT", timeframe: "15m", strategy_type: "moving_average", fast_period: 10, slow_period: 30, quantity: 0.001, auto_execute: false, position_side: "BOTH" });
    setEditing(row || null);
    setOpen(true);
  };
  useEffect(() => { setOpen(false); setLogStrategy(null); }, [accountId]);
  useEffect(() => {
    const current = ++version.current;
    if (!logStrategy) return undefined;
    setLogs([]); setLogError(""); setLogLoading(true);
    binanceApi.get(`/strategies/${logStrategy.id}/events`).then((rows) => { if (current === version.current) setLogs(rows); }).catch((e) => { if (current === version.current) setLogError(e.message); }).finally(() => { if (current === version.current) setLogLoading(false); });
    return () => { version.current++; };
  }, [logStrategy]);
  const submit = async () => {
    try {
      const values = await form.validateFields();
      const parameters = { ...values, account_id: accountId, quantity: String(values.quantity) };
      await act("strategy-form", () => editing ? binanceApi.patch(`/strategies/${editing.id}`, { parameters }) : binanceApi.post("/strategies", parameters), "策略已保存");
      setOpen(false);
    } catch { /* act/Form 已显示错误 */ }
  };
  const execute = async (row, evaluate = false) => {
    const starting = row.status !== "running";
    if (row.config.auto_execute && (evaluate || starting)) {
      const confirmed = await modal.confirm({
        title: evaluate ? "评估并允许策略下单？" : "启动自动下单策略？",
        content: account?.environment === "live" ? "此策略已开启自动下单，满足信号时会提交真实订单。" : "此策略已开启自动下单，满足信号时会提交当前账户环境的订单。",
        okText: evaluate ? "确认评估" : "确认启动", cancelText: "取消", okButtonProps: { danger: account?.environment === "live" },
      });
      if (!confirmed) return;
    }
    try {
      await act(`${evaluate ? "run" : "strategy"}-${row.id}`, () => evaluate ? binanceApi.post(`/strategies/${row.id}/run`) : binanceApi.patch(`/strategies/${row.id}`, { status: starting ? "running" : "paused" }), evaluate ? "信号已评估" : undefined);
    } catch { /* act 已显示错误 */ }
  };
  const columns = [
    { title: "策略", dataIndex: "name", width: 180, ellipsis: true },
    { title: "交易对", dataIndex: "symbol" },
    { title: "周期", dataIndex: "timeframe" },
    { title: "类型", dataIndex: "strategyType", render: (value) => value === "rsi" ? "RSI" : "均线交叉" },
    { title: "状态", dataIndex: "status", render: (value) => <StatusTag value={value} /> },
    { title: "自动下单", key: "auto", render: (_, row) => row.config.auto_execute ? "开启" : "仅信号" },
    { title: "最新信号", dataIndex: "lastSignal", render: (value) => value || "—" },
    { title: "已实现盈亏", dataIndex: "realizedPnl", align: "right", render: (value) => <Pnl value={value} /> },
    { title: "操作", key: "action", width: 270, fixed: "right", render: (_, row) => <Space size={0}>
      <Button type="text" size="small" loading={busy[`strategy-${row.id}`]} onClick={() => { execute(row).catch(() => {}); }}>{row.status === "running" ? "暂停" : "启动"}</Button>
      <Button type="text" size="small" loading={busy[`run-${row.id}`]} onClick={() => { execute(row, true).catch(() => {}); }}>评估</Button>
      <Button type="text" size="small" disabled={row.status === "running"} onClick={() => openForm(row)}>配置</Button>
      <Button type="text" size="small" onClick={() => setLogStrategy(row)}>日志</Button>
    </Space> },
  ];
  return <>
    <Panel title="策略" extra={<Button aria-label="新建策略" type="primary" icon={<PlusOutlined />} disabled={!accountId} onClick={() => openForm()}>新建策略</Button>} flush>
      <Table className="oo-table" rowKey="id" size="small" columns={columns} dataSource={strategies} scroll={{ x: 1250 }} pagination={{ pageSize: 10, hideOnSinglePage: true }} />
    </Panel>
    <Modal title={editing ? "配置策略" : "新建策略"} open={open} onCancel={() => { if (!busy["strategy-form"]) setOpen(false); }} onOk={submit} confirmLoading={busy["strategy-form"]} okText="保存" destroyOnClose>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="名称" rules={[required]}><Input maxLength={80} /></Form.Item>
        <Row gutter={16}><Col span={12}><Form.Item name="symbol" label="交易对" rules={[required, symbolRule]} normalize={(value) => value.toUpperCase()}><Input /></Form.Item></Col><Col span={12}><Form.Item name="timeframe" label="K线周期" rules={[required]}><Select options={["1m", "5m", "15m", "1h", "4h", "1d"].map((value) => ({ value, label: value }))} /></Form.Item></Col></Row>
        <Form.Item name="strategy_type" label="策略类型" rules={[required]}><Select options={[{ value: "moving_average", label: "均线交叉" }, { value: "rsi", label: "RSI" }]} /></Form.Item>
        <Row gutter={16}><Col span={12}><Form.Item name="fast_period" label={strategyType === "rsi" ? "RSI 周期" : "快周期"} rules={[required]}><InputNumber min={2} max={100} className="oo-binance-full" /></Form.Item></Col><Col span={12}><Form.Item name="slow_period" label="慢周期" dependencies={["fast_period", "strategy_type"]} rules={[required, { validator: (_, value) => strategyType !== "moving_average" || Number(value) > Number(form.getFieldValue("fast_period")) ? Promise.resolve() : Promise.reject(new Error("慢周期必须大于快周期")) }]}><InputNumber min={3} max={200} disabled={strategyType === "rsi"} className="oo-binance-full" /></Form.Item></Col></Row>
        <Form.Item name="quantity" label="目标仓位数量" rules={[required, positive]}><InputNumber min={0.00000001} step={0.001} className="oo-binance-full" /></Form.Item>
        <Form.Item name="position_side" label="持仓模式" rules={[required]}><Select options={positionsOptions} /></Form.Item>
        <Form.Item name="auto_execute" valuePropName="checked"><Checkbox>按信号自动下单</Checkbox></Form.Item>
      </Form>
    </Modal>
    <Modal title={`${logStrategy?.name || ""} · 策略日志`} open={!!logStrategy} onCancel={() => setLogStrategy(null)} footer={null} width={760}>
      {logError && <Alert type="error" message={logError} />}
      <Table className="oo-table" rowKey="id" size="small" loading={logLoading} dataSource={logs} pagination={{ pageSize: 8 }} scroll={{ x: 550 }} columns={[{ title: "时间", dataIndex: "createdAt", render: date }, { title: "信号", dataIndex: "signal" }, { title: "价格", dataIndex: "price" }, { title: "记录", dataIndex: "message" }]} />
    </Modal>
  </>;
}
