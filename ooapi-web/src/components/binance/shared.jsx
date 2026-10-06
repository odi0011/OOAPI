import React from "react";
import {  Empty, Tag  } from "../arc/index";
import { API } from "../../services/api";
import StatCard from "../StatCard";

export const binanceApi = {
  get: (path) => API.get(`/binance${path}`, { timeoutMs: 65000 }),
  post: (path, body) => API.post(`/binance${path}`, body, { timeoutMs: path === "/backtests" ? 125000 : 65000 }),
  put: (path, body) => API.put(`/binance${path}`, body, { timeoutMs: 65000 }),
  patch: (path, body) => API.patch(`/binance${path}`, body, { timeoutMs: 65000 }),
};
export const envLabels = { demo: "模拟盘", testnet: "测试网", live: "实盘" };
export const money = (value) => value == null ? "—" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const price = (value) => value == null ? "—" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 });
export const date = (value) => {
  if (!value) return "—";
  const time = typeof value === "number" ? value : /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  return new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
};
export function Pnl({ value, suffix = "" }) {
  return <span className="oo-num" style={{ color: value > 0 ? "var(--green)" : value < 0 ? "var(--red)" : "var(--ink-3)" }}>{value > 0 ? "+" : ""}{money(value)}{suffix}</span>;
}
export function EnvTag({ value }) {
  return <Tag color={value === "live" ? "error" : value === "testnet" ? "warning" : "default"}>{envLabels[value] || value}</Tag>;
}
export function StatusTag({ value }) {
  const labels = { running: "运行中", paused: "已暂停", filled: "已成交", new: "待成交", partially_filled: "部分成交", unknown: "待确认", pending: "处理中", rejected: "已拒绝", canceled: "已撤销", expired: "已过期", active: "生效中", triggered: "已触发", failed: "失败", finished: "已完成" };
  const color = ["running", "filled", "active", "finished"].includes(value) ? "success" : ["unknown", "pending", "partially_filled", "new"].includes(value) ? "warning" : ["rejected", "failed"].includes(value) ? "error" : "default";
  return <Tag color={color}>{labels[value] || value}</Tag>;
}
export function Panel({ title, extra, children, flush = false }) {
  return <section className={`oo-panel${flush ? " oo-table-panel" : ""}`}>
    {title && <div className="oo-panel-head"><span className="oo-panel-title">{title}</span>{extra}</div>}
    <div className={`oo-panel-body${flush ? " oo-panel-body--flush" : ""}`}>{children}</div>
  </section>;
}
export function Blank({ text = "暂无数据", action }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text}>{action}</Empty>;
}
export function Stats({ items }) {
  return <div className="oo-stats-strip">{items.map((item) => <StatCard key={item.label} {...item} />)}</div>;
}
export const symbolRule = { pattern: /^[A-Z0-9]{5,20}$/, message: "请输入有效交易对，例如 BTCUSDT" };
export const required = { required: true, message: "请填写此项" };
export const positive = { validator: (_, value) => Number(value) > 0 ? Promise.resolve() : Promise.reject(new Error("请输入大于 0 的数值")) };
export const positionsOptions = [{ value: "BOTH", label: "单向" }, { value: "LONG", label: "双向 · 多仓" }, { value: "SHORT", label: "双向 · 空仓" }];

// 公网 IP 的 HTTP 页面没有 randomUUID；getRandomValues 在此场景仍可用。
// 每次打开表单生成一次，失败重试沿用同一个编号，避免重复提交交易。
export function newOrderRequestId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `od${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
