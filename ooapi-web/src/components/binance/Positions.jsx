import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { binanceApi, money, price, Panel, Pnl, positionsOptions, positive, required, symbolRule, envLabels, newOrderRequestId } from "./shared";

export default function Positions({ positions, account, act, busy }) {
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState(null);
  const [form] = Form.useForm();
  const positionSide = Form.useWatch("position_side", form);
  const requestId = useRef("");
  const open = (type, row) => {
    form.resetFields();
    requestId.current = newOrderRequestId();
    form.setFieldsValue(type === "order" ? { symbol: "BTCUSDT", side: "BUY", position_side: "BOTH", quantity: 0.001, reduce_only: false } : type === "close" ? { percentage: 100 } : { stop_loss: row.stopLoss, take_profit: row.takeProfit, trailing_pct: row.trailingPct == null ? null : row.trailingPct * 100 });
    setDialog({ type, row });
  };
  // 切换账户时关闭旧账户交易表单，不能把上一账户的输入发给新账户。
  useEffect(() => { setDialog(null); }, [account?.id]);
  const submit = async () => {
    try {
      const values = await form.validateFields();
      const { type, row } = dialog;
      const result = await act("position-form", () => type === "order" ? binanceApi.post("/orders", { ...values, symbol: values.symbol.toUpperCase().trim(), quantity: String(values.quantity), account_id: account.id, mode: account.environment, client_order_id: requestId.current }) : type === "close" ? binanceApi.post(`/positions/${row.id}/close`, { percentage: values.percentage / 100, client_order_id: requestId.current }) : binanceApi.put(`/positions/${row.id}/protection`, { stop_loss: values.stop_loss || null, take_profit: values.take_profit || null, trailing_pct: values.trailing_pct ? values.trailing_pct / 100 : null }));
      if (result?.status === "unknown" || result?.status === "pending") {
        setDialog((prev) => ({ ...prev, uncertain: true }));
        return;
      }
      setDialog(null);
    } catch { /* act 已显示业务错误；校验错误由 Form 显示，保留原请求编号。 */ }
  };
  const columns = [
    { title: "交易对", dataIndex: "symbol", fixed: "left", width: 130 },
    { title: "方向", key: "side", width: 100, render: (_, row) => <Space size={4}><Tag color={row.side === "LONG" ? "success" : "error"}>{row.side === "LONG" ? "多" : "空"}</Tag><span className="oo-muted">{row.leverage}×</span></Space> },
    { title: "数量", dataIndex: "quantity", align: "right" },
    { title: "开仓价", dataIndex: "entryPrice", align: "right", render: price },
    { title: "标记价", dataIndex: "markPrice", align: "right", render: price },
    { title: "盈亏 · USDT", dataIndex: "pnl", align: "right", render: (value) => <Pnl value={value} /> },
    { title: "保证金", dataIndex: "margin", align: "right", render: money },
    { title: "强平价", dataIndex: "liquidationPrice", align: "right", render: (value) => value ? price(value) : "—" },
    { title: "止损 / 止盈", key: "protection", render: (_, row) => <span className="oo-num">{price(row.stopLoss)} / {price(row.takeProfit)}</span> },
    { title: "操作", key: "action", fixed: "right", width: 155, render: (_, row) => <Space size={0}><Button size="small" type="text" onClick={() => open("protection", row)}>保护</Button><Button size="small" type="text" danger onClick={() => open("close", row)}>平仓</Button></Space> },
  ];
  return <>
    <Panel title={`仓位 · ${positions.length}`} extra={<Space wrap><Input.Search aria-label="筛选仓位" placeholder="交易对" allowClear value={filter} onChange={(e) => setFilter(e.target.value.toUpperCase())} className="oo-binance-filter" /><Button aria-label="市价下单" type="primary" icon={<PlusOutlined />} disabled={!account} onClick={() => open("order")}>市价下单</Button></Space>} flush>
      <Table className="oo-table" rowKey="id" size="small" columns={columns} dataSource={positions.filter((row) => row.symbol.includes(filter))} scroll={{ x: 1250 }} pagination={{ pageSize: 10, hideOnSinglePage: true }} />
    </Panel>
    <Modal title={dialog?.type === "order" ? `市价下单 · ${envLabels[account?.environment] || ""}` : `${dialog?.row?.symbol || ""} · ${dialog?.type === "close" ? "平仓" : "止盈止损"}`} open={!!dialog} onCancel={() => { if (!busy["position-form"]) setDialog(null); }} onOk={submit} confirmLoading={busy["position-form"]} okText={dialog?.type === "close" ? "确认平仓" : "确认"} okButtonProps={{ danger: dialog?.type === "close", disabled: dialog?.uncertain }} destroyOnClose>
      <Form form={form} layout="vertical" preserve={false}>
        {dialog?.uncertain && <Alert showIcon type="warning" message="订单待确认，请到订单页查询状态" />}
        {dialog?.type === "order" && <>
          {account?.environment === "live" && <Alert showIcon type="warning" message="此操作会向实盘账户提交订单" />}
          <Form.Item name="symbol" label="交易对" rules={[required, symbolRule]} normalize={(value) => value.toUpperCase()}><Input /></Form.Item>
          <Row gutter={16}><Col span={12}><Form.Item name="side" label="方向" rules={[required]}><Select options={[{ value: "BUY", label: "买入" }, { value: "SELL", label: "卖出" }]} /></Form.Item></Col><Col span={12}><Form.Item name="position_side" label="持仓模式" rules={[required]}><Select options={positionsOptions} /></Form.Item></Col></Row>
          <Form.Item name="quantity" label="数量" rules={[required, positive]}><InputNumber min={0.00000001} step={0.001} className="oo-binance-full" /></Form.Item>
          {positionSide === "BOTH" && <Form.Item name="reduce_only" valuePropName="checked"><Checkbox>只减仓</Checkbox></Form.Item>}
        </>}
        {dialog?.type === "close" && <><Alert type="warning" showIcon message={`${dialog.row.side === "LONG" ? "多仓" : "空仓"} ${dialog.row.quantity}，按市价平仓`} /><Form.Item name="percentage" label="平仓比例 %" rules={[required]}><InputNumber min={1} max={100} className="oo-binance-full" /></Form.Item></>}
        {dialog?.type === "protection" && <>
          <Form.Item name="stop_loss" label="止损价"><InputNumber min={0.00000001} className="oo-binance-full" /></Form.Item>
          <Form.Item name="take_profit" label="止盈价"><InputNumber min={0.00000001} className="oo-binance-full" /></Form.Item>
          <Form.Item name="trailing_pct" label="跟踪止损 %（本机执行）"><InputNumber min={0.01} max={50} className="oo-binance-full" /></Form.Item>
        </>}
      </Form>
    </Modal>
  </>;
}
