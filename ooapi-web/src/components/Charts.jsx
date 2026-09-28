// 全站通用图表组件（统一规范唯一入口）—— 第 80 批重做
// ---------------------------------------------------------------------------
// 新页面画图一律复用本文件，**不要自己写 SVG 与配色**。旧签名全部兼容。
//
// 这次改掉的「丑」与「不合理」（逐条对应用户反馈）：
//   · Y 轴刻度是 max*0.25 这种任意小数（出现 3.1875 / 12.75）→ 改为「整齐刻度」
//     （1/2/2.5/5 × 10^n），并且顶部留余量，折线不再顶着卡片上沿；
//   · 调用次数（几百）与消费金额（零点几）画在同一根 Y 轴上，消费线被压成贴底直线
//     → 支持右侧第二坐标轴（series.axis = "right"），双量纲各自缩放；
//   · 提示框只显示原始数字（12.3456789）→ 每个序列可带 format，日期标题统一格式；
//   · 排行条 8 种彩虹色（颜色没有语义却在抢注意力）→ 单一主题色 + 序号，强弱用透明度；
//   · 柱状图无坐标轴、无网格，悬停才看得到数值 → 带网格与数值；
//   · 调色板改为与主题协调的一组（首色跟随主题色），明暗主题下都有足够对比。
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Empty } from "antd";

/**
 * 容器实测宽度（带 ResizeObserver + 防抖）。
 * 图表按容器实际像素宽度重算坐标系（1 单位 = 1 像素），字号恒定不变形。
 * 防抖 120ms：拖拽窗口会连续触发，每帧重算 path 会让长折线卡顿。
 */
export function useResizeWidth(fallback = 780) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let timer = null;
    const apply = () => {
      const w = Math.max(200, Math.round(el.getBoundingClientRect().width || 0));
      setWidth((prev) => (Math.abs(prev - w) >= 4 ? w : prev));
    };
    apply();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(apply, 120);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  return [ref, width || fallback];
}

// 首色跟随主题色（CSS 变量），其余是与之协调的中等饱和色；明暗主题下都够对比。
// 注意：个别调用方把颜色当 CSS 背景用，所以必须是合法 CSS 颜色值（变量也可以）。
export const SERIES_COLORS = [
  "var(--accent)", "#14b8a6", "#f59e0b", "#8b5cf6",
  "#ef4444", "#0ea5e9", "#ec4899", "#64748b",
];

export function fmtCompact(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(abs >= 1e9 ? 0 : 1)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(abs >= 1e5 ? 0 : 1)}万`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (Number.isInteger(v)) return String(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2).replace(/\.?0+$/, "");
  return v.toFixed(4).replace(/\.?0+$/, "") || "0";
}

/** 「整齐」的刻度：步长取 1/2/2.5/5 × 10^n，返回 { max, step, ticks } */
export function niceTicks(rawMax, count = 4) {
  const max = Math.max(Number(rawMax) || 0, 0);
  if (max <= 0) return { max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) || 10 * pow;
  const top = Math.ceil((max * 1.04) / step) * step; // 4% 顶部余量，线不贴着上沿
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { max: top, step, ticks };
}

/** Catmull-Rom → 三次贝塞尔（全站折线统一实现）；y 做上下界夹紧，平滑时不会冲出坐标轴 */
export function smoothPath(rawPts, yMin = -Infinity, yMax = Infinity) {
  if (!rawPts.length) return "";
  const pts = rawPts.map((it) => [Number(it[0]), Number(it[1])]);
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  const cy = (y) => Math.min(yMax, Math.max(yMin, y));
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = cy(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = cy(p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
/** X 值 → 轴标签 / 提示框标题。日期 "2026-09-20" 轴上显示 9/20，提示框显示 9月20日 周六 */
function fmtXAxis(v) {
  const s = String(v ?? "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[2])}/${Number(m[3])}` : s;
}
function fmtXTip(v) {
  const s = String(v ?? "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const d = new Date(`${s}T00:00:00`);
  return `${Number(m[2])}月${Number(m[3])}日 周${WEEK[d.getDay()] ?? ""}`;
}

function Blank({ height, text = "暂无数据" }) {
  return (
    <div className="oo-chart-empty" style={{ height }}>
      <Empty description={text} image={Empty.PRESENTED_IMAGE_SIMPLE} />
    </div>
  );
}
/**
 * 折线趋势图（单/多序列，支持左右双轴）
 * @param {Array} series  [{ key, label|name, color?, values:[{x,label?,y}], axis?:"left"|"right", format?:(v)=>string, area?:boolean }]
 * @param {object} opts   { height, yFormat, yFormatRight, tipRender, maxXTicks }
 *
 * 颜色一律通过 style 设置（而不是 SVG 属性）：属性里写 var(--accent) 部分浏览器不解析。
 */
export function LineChart({ series = [], height = 200, yFormat = fmtCompact, yFormatRight, tipRender, maxXTicks = 8 }) {
  const gid = useId().replace(/:/g, "");
  const [hover, setHover] = useState(null);
  const [wrapRef, W] = useResizeWidth(780);
  const H = height;
  const hasRight = series.some((s) => s.axis === "right");
  const PAD = { l: 46, r: hasRight ? 50 : 18, t: 12, b: 26 };
  const n = series[0]?.values?.length || 0;
  const innerW = Math.max(10, W - PAD.l - PAD.r);
  const innerH = Math.max(10, H - PAD.t - PAD.b);

  const { left, right, plots } = useMemo(() => {
    const maxOf = (side) => {
      let mx = 0;
      for (const s of series) if ((s.axis === "right") === (side === "right")) for (const v of s.values) mx = Math.max(mx, Number(v.y) || 0);
      return mx;
    };
    const left = niceTicks(maxOf("left"));
    // 右轴与左轴共用同一组网格线：右轴刻度数强制等于左轴，步长取能覆盖右轴最大值的最小「整齐」值
    let right = null;
    if (hasRight) {
      const segs = left.ticks.length - 1;
      const need = (maxOf("right") || 1) * 1.04 / segs;
      const pow = 10 ** Math.floor(Math.log10(need));
      const st = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= need) || 10 * pow;
      right = { max: st * segs, step: st, ticks: left.ticks.map((_, i) => Number((st * i).toPrecision(12))) };
    }
    const xAt = (i) => PAD.l + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));
    const plots = series.map((s, si) => {
      const scale = s.axis === "right" && right ? right : left;
      const pts = s.values.map((v, i) => [xAt(i), PAD.t + innerH - ((Number(v.y) || 0) / scale.max) * innerH]);
      const path = smoothPath(pts, PAD.t, PAD.t + innerH);
      const base = PAD.t + innerH;
      const area = path && pts.length > 1 ? `${path} L ${pts[pts.length - 1][0]} ${base} L ${pts[0][0]} ${base} Z` : "";
      const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];
      return { ...s, label: s.label ?? s.name, pts, path, area, color, showArea: s.area ?? (series.length <= 2 || si === 0) };
    });
    return { left, right, plots };
  }, [series, n, innerW, innerH, hasRight, PAD.l, PAD.t]);

  if (!n) return <Blank height={H} />;

  // X 轴标签：按实测宽度决定能放几个（每个至少 56px），首尾优先保留
  const budget = Math.max(2, Math.min(maxXTicks, Math.floor(innerW / 56)));
  const step = Math.max(1, Math.ceil((n - 1) / (budget - 1)));
  const xTickIdx = new Set();
  for (let i = 0; i < n; i += step) xTickIdx.add(i);
  if (n > 1 && !xTickIdx.has(n - 1)) {
    const lastKept = Math.max(...xTickIdx);
    if (n - 1 - lastKept < step / 2) xTickIdx.delete(lastKept);
    xTickIdx.add(n - 1);
  }
  const yL = (v) => PAD.t + innerH - (v / left.max) * innerH;
  const fmtRight = yFormatRight || yFormat;
  const hx = hover !== null ? plots[0]?.pts[hover]?.[0] : null;
  const tipLeftSide = hx !== null && hx > W * 0.62;

  return (
    <div ref={wrapRef} className="oo-trend-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        style={{ display: "block", maxWidth: "100%", overflow: "visible" }}
        role="img"
        aria-label={`趋势图：${plots.map((p) => p.label).join("、")}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) * W) / rect.width;
          const i = n === 1 ? 0 : Math.round(((x - PAD.l) / innerW) * (n - 1));
          setHover(Math.min(n - 1, Math.max(0, i)));
        }}
      >
        <defs>
          {plots.map((s, i) => (
            <linearGradient key={i} id={`${gid}-g${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: s.color, stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: s.color, stopOpacity: 0 }} />
            </linearGradient>
          ))}
        </defs>
        {left.ticks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={yL(v)} x2={W - PAD.r} y2={yL(v)} style={{ stroke: i === 0 ? "var(--line-strong)" : "var(--line)" }} strokeWidth={1} strokeDasharray={i === 0 ? undefined : "2 4"} />
            <text x={PAD.l - 8} y={yL(v) + 3.5} textAnchor="end" className="oo-chart-tick">{yFormat(v)}</text>
            {right ? (
              <text x={W - PAD.r + 8} y={yL(v) + 3.5} textAnchor="start" className="oo-chart-tick">
                {fmtRight(right.ticks[i] ?? (right.max * v) / left.max)}
              </text>
            ) : null}
          </g>
        ))}
        {plots.map((s, i) => (s.showArea && s.area ? <path key={`a${i}`} d={s.area} style={{ fill: `url(#${gid}-g${i})` }} /> : null))}
        {plots.map((s, i) => (
          <path key={`l${i}`} d={s.path} fill="none" style={{ stroke: s.color }} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {n <= 16
          ? plots.map((s, si) => s.pts.map((p, i) => <circle key={`d${si}-${i}`} cx={p[0]} cy={p[1]} r={2.2} style={{ fill: s.color }} />))
          : null}
        {hx !== null ? (
          <>
            <line x1={hx} y1={PAD.t} x2={hx} y2={PAD.t + innerH} style={{ stroke: "var(--ink-3)" }} strokeOpacity={0.45} strokeDasharray="3 3" />
            {plots.map((s, i) => (
              <circle key={i} cx={s.pts[hover]?.[0]} cy={s.pts[hover]?.[1]} r={4.5} style={{ fill: s.color, stroke: "var(--surface)" }} strokeWidth={2} />
            ))}
          </>
        ) : null}
        {(plots[0]?.values || []).map((v, i) =>
          xTickIdx.has(i) ? (
            <text
              key={i}
              x={plots[0].pts[i]?.[0]}
              y={H - 7}
              textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"}
              className="oo-chart-tick"
            >
              {v.label ?? fmtXAxis(v.x)}
            </text>
          ) : null
        )}
      </svg>
      {hover !== null && plots[0]?.values[hover] ? (
        <div
          className="oo-trend-tip"
          style={{ left: hx, top: PAD.t, transform: tipLeftSide ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
        >
          {tipRender ? (
            tipRender(hover)
          ) : (
            <>
              <div className="oo-trend-tip-date">{plots[0].values[hover].label ?? fmtXTip(plots[0].values[hover].x)}</div>
              {plots.map((s, i) => {
                const y = Number(s.values[hover]?.y) || 0;
                const f = s.format || (s.axis === "right" ? fmtRight : yFormat);
                return (
                  <div key={s.key || i} className="oo-trend-tip-row">
                    <i style={{ background: s.color }} />
                    <span>{s.label}</span>
                    <span>{f(y)}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 图例（多序列时显示）。series.axis="right" 的会标注「右轴」 */
export function Legend({ series = [] }) {
  if (series.length < 2) return null;
  return (
    <div className="oo-trend-legend">
      {series.map((s, i) => (
        <span className="oo-trend-legend-item" key={s.key || i}>
          <i style={{ background: s.color || SERIES_COLORS[i % SERIES_COLORS.length] }} />
          {s.label ?? s.name}
          {s.axis === "right" ? <em>右轴</em> : null}
        </span>
      ))}
    </div>
  );
}
/**
 * 纵向柱状图（时段分布 / 延迟分布 / 状态码分布）
 * @param {Array} bars [{ label, value, color? }]
 * 默认单一主题色（柱子之间是同一个量，不需要彩虹色）；最高柱加深以突出峰值。
 */
export function BarChart({ bars = [], height = 170, valueFormat = fmtCompact, showValue = true, color }) {
  const [hover, setHover] = useState(null);
  const [wrapRef, W] = useResizeWidth(520);
  if (!bars.length) return <Blank height={height} />;
  const H = height;
  const PAD = { l: 40, r: 8, t: 14, b: 22 };
  const innerW = Math.max(10, W - PAD.l - PAD.r);
  const innerH = Math.max(10, H - PAD.t - PAD.b);
  const vals = bars.map((b) => Number(b.value) || 0);
  const { max, ticks } = niceTicks(Math.max(...vals));
  const peak = vals.indexOf(Math.max(...vals));
  const slot = innerW / bars.length;
  const bw = Math.max(3, Math.min(36, slot * 0.64));
  const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(innerW / 34))));
  const y = (v) => PAD.t + innerH - (v / max) * innerH;
  const fill = color || "var(--accent)";

  return (
    <div ref={wrapRef} className="oo-trend-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: "block", maxWidth: "100%" }} onMouseLeave={() => setHover(null)} role="img" aria-label="柱状图">
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={y(v)} x2={W - PAD.r} y2={y(v)} style={{ stroke: i === 0 ? "var(--line-strong)" : "var(--line)" }} strokeDasharray={i === 0 ? undefined : "2 4"} />
            <text x={PAD.l - 8} y={y(v) + 3.5} textAnchor="end" className="oo-chart-tick">{valueFormat(v)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const v = vals[i];
          const x = PAD.l + slot * i + (slot - bw) / 2;
          const h = v > 0 ? Math.max(2, (v / max) * innerH) : 0;
          const c = b.color || fill;
          return (
            <g key={b.label ?? i} onMouseEnter={() => setHover(i)}>
              <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={innerH} fill="transparent" />
              <rect
                x={x}
                y={PAD.t + innerH - h}
                width={bw}
                height={h}
                rx={Math.min(4, bw / 3)}
                style={{ fill: c, opacity: hover === null ? (i === peak ? 1 : 0.72) : hover === i ? 1 : 0.4 }}
              />
              {i % labelEvery === 0 ? (
                <text x={x + bw / 2} y={H - 7} textAnchor="middle" className="oo-chart-tick">{b.label}</text>
              ) : null}
              {showValue && hover === i ? (
                <text x={x + bw / 2} y={PAD.t + innerH - h - 5} textAnchor="middle" className="oo-chart-val">{valueFormat(v)}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * 横向排行（模型/渠道/用户/令牌）：序号 + 名称 + 数值，下方一条细进度条。
 * 单一主题色，前三名实色、其余淡色 —— 排行的重点是「谁在前面」，不是颜色。
 * @param {Array} items [{ name, value, sub?, onClick? }]
 * @param {function} format 数值格式（默认 fmtCompact + suffix）
 */
export function RankBar({ items = [], nameKey = "name", valueKey = "value", suffix = "", max: maxProp, empty = "暂无数据", format, limit = 8 }) {
  if (!items.length) return <Blank height={120} text={empty} />;
  const list = items.slice(0, limit);
  const max = maxProp || Math.max(1, ...list.map((m) => Number(m[valueKey]) || 0));
  const total = items.reduce((n, m) => n + (Number(m[valueKey]) || 0), 0) || 1;
  const fmt = format || ((v) => `${fmtCompact(v)}${suffix}`);
  return (
    <ol className="oo-rank">
      {list.map((m, i) => {
        const v = Number(m[valueKey]) || 0;
        const Row = m.onClick ? "button" : "div";
        const nm = m[nameKey];
        return (
          <li key={m.key ?? (typeof nm === "string" || typeof nm === "number" ? nm : i)}>
            <Row type={m.onClick ? "button" : undefined} className="oo-rank-row" onClick={m.onClick}>
              <span className={`oo-rank-no${i < 3 ? " is-top" : ""}`}>{i + 1}</span>
              <span className="oo-rank-name" title={typeof nm === "string" ? nm : undefined}>
                {m[nameKey]}
                {m.sub ? <em>{m.sub}</em> : null}
              </span>
              <span className="oo-rank-val">{fmt(v)}</span>
              <span className="oo-rank-pct">{((v / total) * 100).toFixed(v / total < 0.1 ? 1 : 0)}%</span>
              <span className="oo-rank-track" aria-hidden="true">
                <span style={{ width: `${Math.max(1.5, (v / max) * 100)}%`, opacity: i < 3 ? 1 : 0.45 }} />
              </span>
            </Row>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 环形占比图 + 图例（模型占比 / Token 结构 / 错误类型）
 * @param {Array} items [{ name, value, color? }]
 */
export function Donut({ items = [], size = 132, thickness = 16, center, centerLabel, format = fmtCompact, empty = "暂无数据", maxItems = 6 }) {
  const [hover, setHover] = useState(null);
  const data = useMemo(() => {
    const sorted = [...items].filter((x) => Number(x.value) > 0).sort((a, b) => b.value - a.value);
    if (sorted.length <= maxItems) return sorted;
    const head = sorted.slice(0, maxItems - 1);
    const rest = sorted.slice(maxItems - 1).reduce((n, x) => n + Number(x.value), 0);
    return [...head, { name: "其他", value: rest, color: "var(--ink-3)" }];
  }, [items, maxItems]);
  const total = data.reduce((n, x) => n + Number(x.value), 0);
  if (!total) return <Blank height={size} text={empty} />;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  const cur = hover !== null ? data[hover] : null;
  return (
    <div className="oo-donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="占比图" onMouseLeave={() => setHover(null)}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: "var(--field)" }} strokeWidth={thickness} />
        {data.map((x, i) => {
          const frac = Number(x.value) / total;
          const gap = data.length > 1 ? Math.min(2, c * frac * 0.3) : 0;
          const seg = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={hover === i ? thickness + 3 : thickness}
              strokeDasharray={`${Math.max(0, c * frac - gap)} ${c}`}
              strokeDashoffset={-c * acc}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ stroke: x.color || SERIES_COLORS[i % SERIES_COLORS.length], transition: "stroke-width 120ms", opacity: hover === null || hover === i ? 1 : 0.45 }}
              onMouseEnter={() => setHover(i)}
            />
          );
          acc += frac;
          return seg;
        })}
        <text x="50%" y="47%" textAnchor="middle" className="oo-donut-num">{cur ? `${((cur.value / total) * 100).toFixed(1)}%` : center ?? format(total)}</text>
        <text x="50%" y="62%" textAnchor="middle" className="oo-donut-cap">{cur ? cur.name : centerLabel ?? "合计"}</text>
      </svg>
      <ul className="oo-donut-legend">
        {data.map((x, i) => (
          <li key={x.name} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} className={hover === i ? "is-on" : ""}>
            <i style={{ background: x.color || SERIES_COLORS[i % SERIES_COLORS.length] }} />
            <span className="oo-truncate" title={x.name}>{x.name}</span>
            <b>{((x.value / total) * 100).toFixed(1)}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 迷你趋势线（卡片内 sparkline）：线 + 淡面积，无坐标轴 */
export function Sparkline({ values = [], color = "var(--accent)", width = 120, height = 28 }) {
  const gid = useId().replace(/:/g, "");
  const { path, area } = useMemo(() => {
    if (!values.length) return { path: "", area: "" };
    const max = Math.max(1e-9, ...values.map((v) => Number(v) || 0));
    const n = values.length;
    const pts = values.map((v, i) => [(i * width) / Math.max(1, n - 1), 2 + (height - 4) - ((Number(v) || 0) / max) * (height - 4)]);
    const p = smoothPath(pts, 1, height - 1);
    return { path: p, area: `${p} L ${width} ${height} L 0 ${height} Z` };
  }, [values, width, height]);
  if (!values.length) return null;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      <defs>
        <linearGradient id={`${gid}-s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.25 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={area} style={{ fill: `url(#${gid}-s)` }} />
      <path d={path} fill="none" style={{ stroke: color }} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

/**
 * 看板 KPI 卡：标签 / 大数值 / 环比变化 / 迷你趋势。
 * 环比规则：上期为 0 时不给百分比（「+∞%」没有意义），只写「上期无数据」；
 * inverse=true 表示「越低越好」（错误数、耗时），涨是红色。
 */
export function KpiCard({ label, value, unit, current, previous, inverse = false, spark, hint, tone }) {
  let delta = null;
  if (previous !== undefined && previous !== null && current !== undefined) {
    if (Number(previous) > 0) {
      const pct = ((Number(current) - Number(previous)) / Number(previous)) * 100;
      const good = inverse ? pct <= 0 : pct >= 0;
      delta = {
        text: `${pct >= 0 ? "+" : ""}${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`,
        cls: Math.abs(pct) < 0.05 ? "is-flat" : good ? "is-up" : "is-down",
      };
    } else {
      delta = { text: Number(current) > 0 ? "上期无数据" : "—", cls: "is-flat" };
    }
  }
  return (
    <div className="oo-kpi" title={hint}>
      <div className="oo-kpi-label">{label}</div>
      <div className="oo-kpi-main">
        <span className={`oo-kpi-value${tone ? ` is-${tone}` : ""}`}>{value}</span>
        {unit ? <span className="oo-kpi-unit">{unit}</span> : null}
      </div>
      <div className="oo-kpi-foot">
        {delta ? (
          <span className={`oo-kpi-delta ${delta.cls}`}>
            {delta.text}
            {delta.cls !== "is-flat" || delta.text.endsWith("%") ? <em>较上期</em> : null}
          </span>
        ) : hint ? (
          <span className="oo-kpi-hint">{hint}</span>
        ) : null}
        {spark?.length > 1 ? <Sparkline values={spark} width={84} height={24} color={tone === "danger" ? "var(--red)" : "var(--accent)"} /> : null}
      </div>
    </div>
  );
}

/** 图表卡片（标题 + 说明 + 右侧操作）。full = 跨满整行 */
export function ChartCard({ title, note, extra, children, full, className = "" }) {
  return (
    <section className={`oo-chart-card${full ? " is-full" : ""}${className ? ` ${className}` : ""}`}>
      <header className="oo-chart-card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="oo-chart-card-title">{title}</h3>
          {note ? <div className="oo-chart-card-note">{note}</div> : null}
        </div>
        {extra ? <div className="oo-chart-card-extra">{extra}</div> : null}
      </header>
      <div className="oo-chart-card-body">{children}</div>
    </section>
  );
}
