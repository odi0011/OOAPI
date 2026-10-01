import React from "react";
import { Badge, Button, Progress, Table } from "antd";
import { LineChart, SERIES_COLORS } from "../Charts";
import { Blank, money, price, Panel, Pnl, Stats, StatusTag } from "./shared";

export default function Overview({ summary, curve, positions, strategies, account, status, onView }) {
  if (!account) return <Panel><Blank text="请添加币安账户" action={<Button onClick={() => onView("settings")}>添加账户</Button>} /></Panel>;
  const ratio = summary?.marginTotal ? summary.marginUsed / summary.marginTotal * 100 : 0;
  const watched = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", ...positions.map((row) => row.symbol), ...strategies.map((row) => row.symbol)]);
  const quotes = Object.entries(summary?.quotes || {}).filter(([symbol]) => watched.has(symbol)).map(([symbol, quote]) => ({ symbol, ...quote }));
  return <div className="oo-binance-stack">
    <Stats items={[
      { label: "账户权益 · USDT", value: money(summary?.totalEquity) },
      { label: "今日盈亏 · USDT", value: summary ? <Pnl value={summary.dayPnl} /> : "—" },
      { label: "保证金使用率", value: `${money(ratio)}%` },
      { label: "运行策略", value: `${strategies.filter((item) => item.status === "running").length} / ${strategies.length}` },
    ]} />
    <div className="oo-chart-grid">
      <Panel title="权益曲线" extra={<span className="oo-muted">USDT</span>}>
        <LineChart height={260} yFormat={money} maxXTicks={6} series={[{ key: "equity", label: "权益", color: SERIES_COLORS[0], format: money, values: curve.map((point) => ({ x: new Date(point.time).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }), y: point.value })) }]} />
      </Panel>
      <Panel title="行情" extra={<Badge status={summary?.market?.connected ? "success" : "warning"} text={summary?.market?.connected ? "已连接" : "未连接"} />} flush>
        <Table className="oo-table" rowKey="symbol" size="small" dataSource={quotes} pagination={{ pageSize: 6, hideOnSinglePage: true }} columns={[
          { title: "交易对", dataIndex: "symbol" },
          { title: "标记价", dataIndex: "markPrice", align: "right", render: price },
          { title: "资金费率", dataIndex: "fundingRate", align: "right", render: (value) => `${(Number(value) * 100).toFixed(4)}%` },
        ]} />
      </Panel>
    </div>
    <Panel title="仓位" extra={<Button size="small" onClick={() => onView("positions")}>查看仓位</Button>} flush>
      <Table className="oo-table" rowKey="id" size="small" dataSource={positions} pagination={false} scroll={{ x: 600 }} columns={[
        { title: "交易对", dataIndex: "symbol" },
        { title: "方向", dataIndex: "side", render: (value) => value === "LONG" ? "多仓" : "空仓" },
        { title: "数量", dataIndex: "quantity", align: "right" },
        { title: "开仓价", dataIndex: "entryPrice", align: "right", render: price },
        { title: "浮动盈亏 · USDT", dataIndex: "pnl", align: "right", render: (value) => <Pnl value={value} /> },
      ]} />
    </Panel>
    <Panel title="自动化" extra={<Badge status={status?.automation?.enabled ? "success" : "default"} text={status?.automation?.enabled ? "已启用" : "已停用"} />}>
      <div className="oo-binance-health">
        <span>保证金 <b className="oo-num">{money(summary?.marginUsed)} / {money(summary?.marginTotal)}</b></span>
        <Progress percent={Math.min(100, ratio)} showInfo={false} strokeColor={ratio < 70 ? "var(--green)" : ratio < 90 ? "var(--orange)" : "var(--red)"} />
        <span>策略 <StatusTag value={strategies.some((item) => item.status === "running") ? "running" : "paused"} /></span>
      </div>
    </Panel>
  </div>;
}
