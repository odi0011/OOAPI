import React from "react";
import { Tooltip } from "antd";

const TONE = { success: "var(--green)", warning: "var(--orange)", danger: "var(--red)" };

// 全站汇总采用使用记录的小标签形态；数值完整显示，补充说明放在悬浮中。
// 保留旧组件签名，使资料、媒体、管理台与交易页面使用同一套密度。
export default function StatCard({ label, value, suffix, hint, hintInline, tone, foot, className = "" }) {
  const tips = [hint, hintInline, foot].filter(Boolean);
  const card = <span className={`bui-chip oo-stat-card ${className}`} tabIndex={tips.length ? 0 : undefined}>
    <span className="oo-stat-card-label">{label}</span>
    <b className="oo-stat-card-num" style={tone ? { color: TONE[tone] } : undefined}>
      <span className="oo-stat-card-value">{value}</span>
      {suffix ? <span className="oo-stat-card-suffix">{suffix}</span> : null}
    </b>
  </span>;
  return tips.length ? <Tooltip trigger={["hover", "focus"]} title={<div>{tips.map((tip, index) => <div key={index}>{tip}</div>)}</div>}>{card}</Tooltip> : card;
}
