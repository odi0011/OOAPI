import React from "react";
import { Tooltip } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, InboxOutlined, InfoCircleOutlined } from "@ant-design/icons";

const count = (v) => Math.max(0, Math.round(Number(v) || 0));
const full = (v) => count(v).toLocaleString("en-US");
const compact = (v) => {
  const n = count(v);
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return full(n);
};

export function formatDuration(value) {
  const n = count(value);
  return n ? (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`) : "—";
}

// 沿用使用记录原有的 5s / 15s 档位；两项独立判断，不能把颜色固定给某一行。
function durationColor(value) {
  const n = Number(value) || 0;
  if (n <= 0 || !Number.isFinite(n)) return "var(--ink-3)";
  if (n >= 15000) return "var(--red)";
  if (n >= 5000) return "var(--orange)";
  return "var(--green)";
}

// 首字和生成结束是两种体验，用同一格的两行表示，避免为同一请求多占一列。
export function DurationCell({ firstTokenMs = 0, elapsedMs = 0 }) {
  return (
    <span className="oo-duration-cell" aria-label={`首字 ${formatDuration(firstTokenMs)}，总耗时 ${formatDuration(elapsedMs)}`}>
      <span className="oo-duration-row"><span>首字</span><b style={{ color: durationColor(firstTokenMs) }}>{formatDuration(firstTokenMs)}</b></span>
      <span className="oo-duration-row"><span>总耗时</span><b style={{ color: durationColor(elapsedMs) }}>{formatDuration(elapsedMs)}</b></span>
    </span>
  );
}

// 缓存读取已包含在输入 token 内，总数只能是输入 + 输出，不能再把缓存加一次。
export function TokenCell({ promptTokens = 0, completionTokens = 0, cacheTokens = 0 }) {
  const input = count(promptTokens);
  const output = count(completionTokens);
  const cache = count(cacheTokens);
  const detail = (
    <div className="oo-token-detail">
      <strong>Token 明细</strong>
      <div><span>输入 Token</span><b>{full(input)}</b></div>
      <div><span>输出 Token</span><b>{full(output)}</b></div>
      <div><span>缓存读取 Token</span><b>{full(cache)}</b></div>
      <div className="oo-token-detail-total"><span>总 Token</span><b>{full(input + output)}</b></div>
    </div>
  );
  return (
    <span className="oo-token-cell">
      <span className="oo-token-main">
        <span><ArrowDownOutlined className="oo-token-input" aria-label="输入" /><b>{full(input)}</b></span>
        <span><ArrowUpOutlined className="oo-token-output" aria-label="输出" /><b>{full(output)}</b></span>
      </span>
      {cache > 0 ? <span className="oo-token-cache" title={`缓存读取 ${full(cache)} Token（已包含在输入中）`}><InboxOutlined />{compact(cache)}</span> : null}
      <Tooltip title={detail} trigger={["hover", "focus", "click"]}>
        <button type="button" className="oo-token-info" aria-label="查看 Token 明细" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}><InfoCircleOutlined /></button>
      </Tooltip>
    </span>
  );
}
