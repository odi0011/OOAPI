import React from "react";

// 统一统计卡片：标签 + 数值 + 图标 + 底部说明
// glow 用于右上角氛围色（跟随语义色，保持克制）
// 语义色走全局 CSS 变量，暗色主题下与全站状态色一致
const TONE = { success: "var(--green)", warning: "var(--orange)", danger: "var(--red)" };

export default function StatCard({ label, value, suffix, icon, foot, glow, tone }) {
  const toneColor = TONE[tone] || null;

  return (
    <div
      className="oo-stat"
      style={{
        "--oo-stat-glow": glow || "transparent",
      }}
    >
      <div className="oo-stat-top">
        <span className="oo-stat-label">{label}</span>
        {icon ? (
          <span
            className="oo-stat-icon"
            style={
              toneColor
                ? {
                    color: toneColor,
                    background: `color-mix(in srgb, ${toneColor} 10%, transparent)`,
                    borderColor: `color-mix(in srgb, ${toneColor} 22%, transparent)`,
                  }
                : {
                    color: "var(--oo-primary)",
                    background: "color-mix(in srgb, var(--oo-primary) 10%, transparent)",
                    borderColor: "color-mix(in srgb, var(--oo-primary) 22%, transparent)",
                  }
            }
          >
            {icon}
          </span>
        ) : null}
      </div>

      <div className="oo-stat-value">
        {value}
        {suffix ? <span className="oo-stat-suffix">{suffix}</span> : null}
      </div>

      {foot ? <div className="oo-stat-foot">{foot}</div> : null}
    </div>
  );
}
