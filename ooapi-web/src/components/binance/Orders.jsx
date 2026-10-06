import React, { useEffect, useRef, useState } from "react";
import {  Alert, Button, Input, Popconfirm, Space, Table, Tabs, Tag  } from "../arc/index";
import { binanceApi, date, EnvTag, price, Panel, Pnl, StatusTag } from "./shared";

export default function Orders({ orders, accountId, act, busy }) {
  const [filter, setFilter] = useState("");
  const [protection, setProtection] = useState([]);
  const [error, setError] = useState("");
  const version = useRef(0);
  useEffect(() => {
    const current = ++version.current;
    setProtection([]); setError("");
    if (accountId) binanceApi.get(`/protection-orders?account_id=${accountId}`).then((rows) => { if (current === version.current) setProtection(rows); }).catch((e) => { if (current === version.current) setError(e.message); });
    return () => { version.current++; };
  }, [accountId, orders]);
  const columns = [
    { title: "时间", dataIndex: "createdAt", render: date, width: 170 },
    { title: "交易对", dataIndex: "symbol" },
    { title: "方向", dataIndex: "side", render: (value) => <Tag color={value === "BUY" ? "success" : "error"}>{value === "BUY" ? "买入" : "卖出"}</Tag> },
    { title: "成交 / 委托", key: "qty", align: "right", render: (_, row) => `${row.filledQuantity} / ${row.quantity}` },
    { title: "均价", dataIndex: "price", align: "right", render: price },
    { title: "已实现盈亏", dataIndex: "realizedPnl", align: "right", render: (value) => <Pnl value={value} /> },
    { title: "手续费", key: "fee", align: "right", render: (_, row) => row.commissionAssets.map((fee) => `${fee.amount} ${fee.asset}`).join(" / ") || "—" },
    { title: "环境", dataIndex: "mode", render: (value) => <EnvTag value={value} /> },
    { title: "状态", dataIndex: "status", render: (value) => <StatusTag value={value} /> },
    { title: "操作", key: "action", fixed: "right", width: 140, render: (_, row) => <Space size={0}>
      <Button size="small" type="text" loading={busy[`order-${row.id}`]} onClick={() => { act(`order-${row.id}`, () => binanceApi.post(`/orders/${row.id}/refresh`), "状态已查询").catch(() => {}); }}>查询</Button>
      {["new", "partially_filled"].includes(row.status) && <Popconfirm title="撤销此订单？" onConfirm={() => act(`cancel-${row.id}`, () => binanceApi.post(`/orders/${row.id}/cancel`))}><Button size="small" type="text" danger loading={busy[`cancel-${row.id}`]}>撤销</Button></Popconfirm>}
    </Space> },
  ];
  return <Panel title="订单" extra={<Input.Search aria-label="筛选订单" placeholder="交易对" allowClear className="oo-binance-filter" value={filter} onChange={(e) => setFilter(e.target.value.toUpperCase())} />} flush>
    <Tabs items={[
      { key: "orders", label: "交易订单", children: <Table className="oo-table" rowKey="id" size="small" columns={columns} dataSource={orders.filter((row) => row.symbol.includes(filter))} scroll={{ x: 1400 }} pagination={{ pageSize: 15, hideOnSinglePage: true }} expandable={{ expandedRowRender: (row) => <Space direction="vertical"><span className="oo-muted">请求编号：{row.clientOrderId || row.id}</span>{row.error && <Alert type="error" message={row.error} />}{!row.ledgerComplete && <Alert type="warning" message="成交账本待确认" />}</Space>, rowExpandable: (row) => !!row.error || !row.ledgerComplete }} /> },
      { key: "protection", label: "保护订单", children: <>{error && <Alert type="error" message={error} />}<Table className="oo-table" rowKey="id" size="small" dataSource={protection.filter((row) => row.symbol.includes(filter))} scroll={{ x: 700 }} pagination={{ pageSize: 15, hideOnSinglePage: true }} columns={[{ title: "时间", dataIndex: "createdAt", render: date }, { title: "交易对", dataIndex: "symbol" }, { title: "仓位", dataIndex: "positionSide" }, { title: "类型", dataIndex: "kind" }, { title: "状态", dataIndex: "status", render: (value) => <StatusTag value={value} /> }, { title: "错误", dataIndex: "error", render: (value) => value || "—" }]} /></> },
    ]} />
  </Panel>;
}
