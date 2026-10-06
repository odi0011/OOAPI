import { Button as ActionButton } from "./arc/index";
import React from "react";
import {   Tooltip  } from "./arc/index";
import { ArrowDownOutlined, ArrowUpOutlined, InboxOutlined, InfoCircleOutlined  } from "./arc/icons";

const count = (v) => Math.max(0, Math.round(Number(v) || 0));
const full = (v) => count(v).toLocaleString("en-US");

export function formatDuration(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value)) || Number(value) < 0) return "—";
  const n = count(value);
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`;
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
export function DurationCell({ firstTokenMs = null, elapsedMs = null }) {
  return (
    <span className="oo-duration-cell" aria-label={`首字 ${formatDuration(firstTokenMs)}，总耗时 ${formatDuration(elapsedMs)}`}>
      <span className="oo-duration-row"><span>首字</span><span className="oo-duration-value" style={{ color: durationColor(firstTokenMs) }}>{formatDuration(firstTokenMs)}</span></span>
      <span className="oo-duration-row"><span>总耗时</span><span className="oo-duration-value" style={{ color: durationColor(elapsedMs) }}>{formatDuration(elapsedMs)}</span></span>
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
        <span className="oo-token-row"><ArrowDownOutlined className="oo-token-input" aria-label="输入" /><span>输入</span><b>{full(input)}</b></span>
        <span className="oo-token-row"><ArrowUpOutlined className="oo-token-output" aria-label="输出" /><span>输出</span><b>{full(output)}</b></span>
        <span className="oo-token-row"><InboxOutlined className="oo-token-cache-icon" aria-label="缓存" /><span>缓存</span><b>{full(cache)}</b></span>
      </span>
      <Tooltip title={detail} trigger={["hover", "focus", "click"]}>
        <ActionButton type="text" htmlType="button" className="oo-token-info" aria-label="查看 Token 明细" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}><InfoCircleOutlined /></ActionButton>
      </Tooltip>
    </span>
  );
}
