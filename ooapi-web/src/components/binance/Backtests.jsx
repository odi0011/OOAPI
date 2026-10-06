import React, { useEffect, useRef, useState } from "react";
import {  Alert, Button, Col, Form, InputNumber, Row, Select, Table  } from "../arc/index";
import { LineChart, SERIES_COLORS } from "../Charts";
import { binanceApi, date, money, Panel, Pnl, positive, required, Stats } from "./shared";

export default function Backtests({ strategies, accountId, act, busy }) {
  const [form] = Form.useForm();
  const strategyId = Form.useWatch("strategy_id", form);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const requestVersion = useRef(0);
  const selectedRef = useRef({ accountId, strategyId });
  selectedRef.current = { accountId, strategyId };
  useEffect(() => { form.resetFields(); setResult(null); setHistory([]); }, [accountId, form]);
  useEffect(() => { setResult(null); }, [strategyId]);
  useEffect(() => {
    const current = ++requestVersion.current;
    setError(""); setHistory([]);
    if (strategyId) binanceApi.get(`/backtests?strategy_id=${strategyId}`).then((rows) => { if (current === requestVersion.current) setHistory(rows); }).catch((e) => { if (current === requestVersion.current) setError(e.message); });
    return () => { requestVersion.current++; };
  }, [strategyId, revision]);
  const run = async () => {
    try {
      const values = await form.validateFields();
      const requestedAccount = accountId;
      const result = await act("backtest", () => binanceApi.post("/backtests", { ...values, fee_rate: values.fee_rate / 100, slippage: values.slippage / 100 }));
      if (selectedRef.current.accountId !== requestedAccount || selectedRef.current.strategyId !== values.strategy_id) return;
      setRevision((value) => value + 1);
      setResult(result);
    } catch { /* act/Form 已显示错误 */ }
  };
  return <div className="oo-binance-stack">
    <Panel title="回测" extra={<Button type="primary" loading={busy.backtest} disabled={!strategies.length} onClick={run}>运行回测</Button>}>
      <Form form={form} layout="vertical" initialValues={{ limit: 500, initial_balance: 10000, fee_rate: 0.05, slippage: 0.02 }}>
        <Row gutter={16}>
          <Col xs={24} md={8}><Form.Item name="strategy_id" label="策略" rules={[required]}><Select placeholder="选择策略" options={strategies.map((row) => ({ value: row.id, label: `${row.name} · ${row.symbol}` }))} /></Form.Item></Col>
          <Col xs={12} md={4}><Form.Item name="limit" label="K线数量" rules={[required]}><InputNumber min={100} max={1500} className="oo-binance-full" /></Form.Item></Col>
          <Col xs={12} md={4}><Form.Item name="initial_balance" label="初始资金 · USDT" rules={[required, positive]}><InputNumber min={1} className="oo-binance-full" /></Form.Item></Col>
          <Col xs={12} md={4}><Form.Item name="fee_rate" label="手续费 %" rules={[required]}><InputNumber min={0} max={1} step={0.01} className="oo-binance-full" /></Form.Item></Col>
          <Col xs={12} md={4}><Form.Item name="slippage" label="滑点 %" rules={[required]}><InputNumber min={0} max={1} step={0.01} className="oo-binance-full" /></Form.Item></Col>
        </Row>
      </Form>
    </Panel>
    {result && <>
      <Stats items={[{ label: "最终资金 · USDT", value: money(result.finalBalance) }, { label: "收益率", value: <Pnl value={result.returnPct} suffix="%" /> }, { label: "最大回撤", value: `${money(result.maxDrawdownPct)}%` }, { label: "胜率 / 交易次数", value: `${money(result.winRate)}% / ${result.tradeCount}` }]} />
      <Panel title="回测权益曲线"><LineChart height={280} yFormat={money} series={[{ key: "backtest", label: "权益", color: SERIES_COLORS[0], format: money, values: result.curve.map((point) => ({ x: new Date(point.time).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }), y: point.value })) }]} /></Panel>
    </>}
    <Panel title="回测记录" flush>
      {error && <Alert type="error" message={error} />}
      <Table className="oo-table" rowKey="id" size="small" dataSource={history} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 850 }} columns={[
        { title: "时间", dataIndex: "createdAt", render: date },
        { title: "最终资金", key: "balance", align: "right", render: (_, row) => money(row.result.finalBalance) },
        { title: "收益率", key: "return", align: "right", render: (_, row) => <Pnl value={row.result.returnPct} suffix="%" /> },
        { title: "最大回撤", key: "drawdown", align: "right", render: (_, row) => `${money(row.result.maxDrawdownPct)}%` },
        { title: "交易次数", key: "count", align: "right", render: (_, row) => row.result.tradeCount },
        { title: "操作", key: "action", render: (_, row) => <Button size="small" type="text" onClick={() => setResult(row.result)}>查看</Button> },
      ]} />
    </Panel>
  </div>;
}
