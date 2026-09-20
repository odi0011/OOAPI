import React from "react";
import { Tooltip } from "antd";

/**
 * 全站统一统计卡 —— **紧凑形态**（学渠道管理页/用量弹窗那种）
 *
 * 形态约定（这是个刻意的改动，别改回去）：
 *   · 数值在上、标签在下，无图标、无 foot 行 —— 单卡约 60px 高。
 *     以前的 `.oo-stat` 大卡（图标 + 大数值 + 说明三行）约 110px 高，
 *     一行 4 张就吃掉首屏 1/6，把真正的内容（表格/图表）挤出视野。
 *   · 补充信息（「共 X」「环比」）走 `hint`：默认只在悬浮时显示。
 *     需要常显时传 `hintInline`，但**每个页面最多一两张**该这么做，
 *     否则又变回三行大卡。
 *   · 语义色只用在数值上（`tone`），不做整卡染色 —— 满屏彩色卡片会失去重点。
 *
 * @param {string} label 标签（显示在数值下方）
 * @param {node}   value 数值（大号等宽数字）
 * @param {node}   suffix 数值后缀（小号、弱化）
 * @param {string} hint 悬浮提示（补充说明，不占高度）
 * @param {node}   hintInline 常显的补充行（少用）
 * @param {string} tone 数值语义色：success | warning | danger
 */
const TONE = { success: "var(--green)", warning: "var(--orange)", danger: "var(--red)" };

export default function StatCard({ label, value, suffix, hint, hintInline, tone, icon, foot, glow }) {
  // 兼容旧签名：icon / foot / glow 来自上一版「三行大卡」，现在**降级处理**：
  //   · icon 直接忽略（紧凑形态不放图标，图标会把卡片撑高一行）；
  //   · foot 转成悬浮提示（不占高度）。要常显请显式用 hintInline。
  // 这样旧页面不用逐个改也不会变形，新页面按新签名写即可。
  const tip = hint || (foot && typeof foot === "string" ? foot : undefined);
  const card = (
    <div className="oo-stat-card" style={glow ? { boxShadow: `inset 0 -2px 0 ${glow}` } : undefined}>
      <div className="oo-stat-card-num" style={tone ? { color: TONE[tone] } : undefined}>
        {value}
        {suffix ? <span className="oo-stat-card-suffix">{suffix}</span> : null}
      </div>
      <div className="oo-stat-card-label">{label}</div>
      {hintInline ? <div className="oo-stat-card-hint">{hintInline}</div> : null}
    </div>
  );
  // foot 是 JSX（如 <span>本页统计</span>）时同样收进 Tooltip：
  // 那些说明文字常显会让卡片回到三行，正是这次要消除的问题。
  const footAsTip = foot && typeof foot !== "string" ? foot : null;
  const tooltipTitle = tip || footAsTip;
  return tooltipTitle ? <Tooltip title={tooltipTitle}>{card}</Tooltip> : card;
}
