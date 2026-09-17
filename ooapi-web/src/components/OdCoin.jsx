// OD 币图标 —— 全站唯一定义
// ===========================================================================
// 货币符号与币名只在这里维护。以后要换造型、改颜色、改称呼（比如从「OD币」
// 改成别的），**只改这个文件**，所有页面自动跟着变。
//
// 造型：立体金币（亮金面 + 右侧深金厚边 + 深棕金字）。
//   · 厚边是「底层圆往右偏一点」露出来的月牙，不是描边 —— 这样才有实体厚度
//   · 字母是按几何画的，不用 <text>：SVG 文本依赖系统字体，不同机器度量不一致，
//     会导致图标忽大忽小甚至移位
//   · 颜色写死（不再用 currentColor）：金币是品牌资产，明暗主题下都该是金色。
//     顺带一个好处 —— 固定色的 SVG 序列化后能正确渲染，方便截图核对。
//
// 尺寸实测（放大采样对比过）：14px 起字母清晰，13px 开始发糊，18px 以上细节充分。
// 所以不要用小于 14px；表头这类极紧凑位置直接用纯文字「OD币」。
import React from "react";

/* --------------------------------------------------------------------------
   一、全局常量：改这里就等于改了全站
   -------------------------------------------------------------------------- */
export const CURRENCY_NAME = "OD币"; // 币名（文案里到处在用）
export const CURRENCY_CODE = "OD";   // 代码/国际缩写（接口字段用）

/* --------------------------------------------------------------------------
   二、配色：想换金色深浅改这里（默认取 Tailwind yellow-300/500/700）
   -------------------------------------------------------------------------- */
const COLORS = {
  face: "#FDE047",   // 币面（亮金）
  edge: "#D69E06",   // 厚度 / 币缘（深一档，让侧面看得出厚度）
  glyph: "#A16207",  // 字母（深棕金，和币面对比足够）
  sheen: "#FFFFFF",  // 左上高光
};

/* --------------------------------------------------------------------------
   三、几何参数：想微调比例改这里
   -------------------------------------------------------------------------- */
const G = {
  r: 9.2,         // 币身半径
  depth: 0.75,    // 厚度偏移（往右，模拟侧面露出的边）
  rim: 0.85,      // 币缘描边
  // 字母：小尺寸下两个字母的**间距**比笔画粗细更关键。
  // 之前 O 右缘和 D 竖干只留了 0.31 单位，14px 光栅化后直接糊成一团，
  // 所以这里把字母缩小、拉开，间隙提到约 0.9 单位。
  glyph: 1.4,     // 字母笔画粗细
  oCx: 9.8,       // O 圆心 x
  oRx: 1.55,      // O 横半径
  oRy: 2.3,       // O 纵半径
  dX: 13.6,       // D 竖干 x
  dTop: 9.7,      // D 上沿
  dBottom: 14.3,  // D 下沿
};
const D_BOWL = (G.dBottom - G.dTop) / 2;

/**
 * OD 币图标
 * @param {number} size 边长（px）
 * @param {string} [title] 无障碍标题
 */
export function OdCoin({ size = 16, title = CURRENCY_NAME, style, className, muted = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      className={className}
      style={{ display: "block", flexShrink: 0, opacity: muted ? 0.75 : 1, ...style }}
    >
      {/* 厚度：底层圆往右偏，露出的月牙就是「币的侧面」 */}
      <circle cx={12 + G.depth} cy={12} r={G.r} fill={COLORS.edge} />
      {/* 币面 */}
      <circle cx="12" cy="12" r={G.r} fill={COLORS.face} stroke={COLORS.edge} strokeWidth={G.rim} />
      {/* 左上高光：柔和椭圆光斑（比弧线更自然，弧线看着像划痕） */}
      <ellipse
        cx={12 - G.r * 0.36}
        cy={12 - G.r * 0.46}
        rx={G.r * 0.3}
        ry={G.r * 0.17}
        fill={COLORS.sheen}
        opacity="0.4"
        transform={`rotate(-38 ${12 - G.r * 0.36} ${12 - G.r * 0.46})`}
      />
      {/* O */}
      <ellipse
        cx={G.oCx}
        cy="12"
        rx={G.oRx}
        ry={G.oRy}
        fill="none"
        stroke={COLORS.glyph}
        strokeWidth={G.glyph}
      />
      {/* D：竖干 + 右侧半圆碗 */}
      <path
        d={`M${G.dX} ${G.dTop} V${G.dBottom} M${G.dX} ${G.dTop} a${D_BOWL} ${D_BOWL} 0 0 1 0 ${G.dBottom - G.dTop}`}
        fill="none"
        stroke={COLORS.glyph}
        strokeWidth={G.glyph}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 金额展示（图标 + 数字 + 币名）—— 表格、卡片里的推荐用法
 * @param {number} od 已经是 OD 的数值（不是额度单位）
 * @param {number} [digits] 小数位
 * @param {boolean} [icon] 是否显示币图标
 * @param {boolean} [unit] 是否显示「OD币」字样
 */
export function OdValue({ od, digits = 2, icon = true, unit = true, size = 14, strong = false, style }) {
  const n = Number(od) || 0;
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, ...style }}
      title={`${n.toFixed(digits)} ${CURRENCY_NAME}`}
    >
      {icon ? <OdCoin size={size} /> : null}
      <span className="oo-num" style={strong ? { fontWeight: 600 } : undefined}>
        {n.toFixed(digits)}
      </span>
      {unit ? (
        <span style={{ fontSize: "0.88em", color: "var(--ink-3)", fontWeight: 450 }}>{CURRENCY_NAME}</span>
      ) : null}
    </span>
  );
}

/**
 * 大号金额展示（统计卡专用）—— 图标按字号比例缩放，视觉重心与数字对齐
 * @param {number} od 已经是 OD 的数值
 * @param {number} [digits] 小数位
 */
export function OdStatValue({ od, digits = 2, size = 20 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 9, minWidth: 0 }}>
      <OdCoin size={size} />
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5, minWidth: 0 }}>
        <span className="oo-num">{(Number(od) || 0).toFixed(digits)}</span>
        <span style={{ fontSize: "0.58em", fontWeight: 450, color: "var(--ink-3)", letterSpacing: 0 }}>{CURRENCY_NAME}</span>
      </span>
    </span>
  );
}
