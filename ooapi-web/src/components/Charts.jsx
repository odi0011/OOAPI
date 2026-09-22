// 全站通用图表组件（统一规范唯一入口）
// ---------------------------------------------------------------------------
// 规范来源：`styles.css` 里的 oo-trend-* / oo-stats-card-* / oo-stat-card-* 一族。
// 使用记录页的「使用分析」与渠道用量统计弹窗都基于同一套视觉语义，
// 新页面要画图一律复用本文件的组件，**不要自己写 SVG 与配色**。
//
// 约定：
//   · 折线 = 平滑曲线（Catmull-Rom → 三次贝塞尔），带区域填充与悬浮十字线；
//   · 多序列配色固定为 SERIES_COLORS 顺序，颜色语义跨页面一致；
//   · Y 轴最多 4 档刻度，X 轴最多 7 个标签（避免拥挤）；
//   · 纵向条 = 时间桶直方图（用于延迟分布、状态码分布）。
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Empty } from "antd";

/**
 * 容器实测宽度（带 ResizeObserver + 防抖）。
 *
 * 为什么必须有：图表原来用固定 viewBox（780）配 `width:100%`，SVG 会**整体缩放** ——
 * 宽屏上文字被放大变形、窄屏缩到看不清，而且侧栏折叠/窗口缩放时压根不重绘。
 * 改成「按容器实际像素宽度重算坐标系」后，1 单位 = 1 像素，字号恒定不变形。
 *
 * 防抖（120ms）是必要的：拖拽窗口会连续触发 ResizeObserver，
 * 每帧重算 path 会让长折线明显卡顿。
 */
export function useResizeWidth(fallback = 780) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let timer = null;
    const apply = () => {
      const w = Math.max(240, Math.round(el.getBoundingClientRect().width || 0));
      setWidth((prev) => (Math.abs(prev - w) >= 8 ? w : prev)); // <8px 的抖动忽略，避免无谓重绘
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

export const SERIES_COLORS = [
  "#3b82f6", "#22c55e", "#f59e0b", "#ef4444",
  "#a855f7", "#06b6d4", "#ec4899", "#64748b",
];

export function fmtCompact(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Catmull-Rom → 三次贝塞尔（全站折线统一实现） */
export function smoothPath(rawPts) {
  if (!rawPts.length) return "";
  const pts = rawPts.map((it) => [Number(it[0]), Number(it[1])]);
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/**
 * 折线趋势图（单/多序列）
 * @param {Array} series  [{ key, label, color?, values:[{x,label,y}] }]
 * @param {object} opts   { height, yFormat, tipRender, maxXTicks }
 */
export function LineChart({ series = [], height = 200, yFormat = fmtCompact, tipRender, maxXTicks = 7 }) {
  const [hover, setHover] = useState(null);
  // 宽度跟随容器实测值（侧栏折叠/窗口缩放/抽屉开合都会触发重算）
  const [wrapRef, W] = useResizeWidth(780);
  const H = height;
  // 右侧留 34px：末尾 X 轴标签（如 "2026-09-20"）文字锚点在中间，
  // 只留 14px 会让它的一半探出绘图区、贴着或溢出卡片边缘。
  const PAD = { l: 52, r: 34, t: 14, b: 26 };

  const first = series[0];
  const n = first?.values?.length || 0;

  const { max, plots } = useMemo(() => {
    let mx = 0;
    for (const s of series) for (const v of s.values) mx = Math.max(mx, Number(v.y) || 0);
    mx = Math.max(1, mx);
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const plots = series.map((s, si) => {
      const pts = s.values.map((v, i) => [
        PAD.l + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1)),
        PAD.t + innerH - ((Number(v.y) || 0) / mx) * innerH,
      ]);
      const path = smoothPath(pts);
      const area = path
        ? `${path} L ${pts[pts.length - 1]?.[0] ?? PAD.l} ${PAD.t + innerH} L ${pts[0]?.[0] ?? PAD.l} ${PAD.t + innerH} Z`
        : "";
      const label = s.label ?? s.name;
      return { ...s, label, pts, path, area, color: s.color || SERIES_COLORS[si % SERIES_COLORS.length] };
    });
    return { max: mx, plots };
  }, [series, n, H, W, PAD.l, PAD.r, PAD.t, PAD.b]);

  if (!n) return <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => ({ y: PAD.t + (H - PAD.t - PAD.b) * (1 - r), v: max * r }));
  // X 轴标签：数量与**格式**都按实测宽度自适应。
  // 只看数量不够 —— 日期标签 "2026-08-21" 有 10 个字符，
  // 在 380px 宽的图里放 7 个必然相互重叠（实测截图里糊成一团）。
  // 这里按「每个标签至少 62px」算能放几个，再据此决定是否缩写为 MM-DD。
  const labelBudget = Math.max(2, Math.floor((W - PAD.l - PAD.r) / 62));
  const tickCount = Math.min(maxXTicks, labelBudget);
  const step = Math.max(1, Math.ceil(n / tickCount));
  // 空间紧张时把 "2026-08-21" 缩成 "08-21"：保留判读所需的最小信息。
  // 阈值 78px 是「10 字符 × 10px 字号 + 间距」的经验值，低于它就该缩写。
  const shortLabel = (W - PAD.l - PAD.r) / Math.max(1, Math.ceil(n / step)) < 78;
  const fmtX = (v) => {
    const s = String(v);
    return shortLabel && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : s;
  };

  return (
    <div ref={wrapRef} className="oo-trend-wrap" style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        // 宽高都按实测像素给（不再 width:100%）：viewBox 与元素同尺寸 = 1:1 映射，
        // 文字与线宽不会被拉伸变形
        width={W}
        height={H}
        style={{ display: "block", maxWidth: "100%" }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) * W) / rect.width;
          let best = 0;
          let bestD = Infinity;
          (plots[0]?.pts || []).forEach((p, i) => {
            const d = Math.abs(p[0] - x);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          });
          setHover(best);
        }}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={t.y} x2={W - PAD.r} y2={t.y} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={PAD.l - 6} y={t.y + 4} textAnchor="end" fontSize={10} fill="var(--ink-3)">
              {yFormat(t.v)}
            </text>
          </g>
        ))}
        {plots.map((s, i) => (
          <g key={s.key || i}>
            {i === 0 && s.area ? (
              <path d={s.area} fill="color-mix(in srgb, var(--accent) 12%, transparent)" />
            ) : null}
            <path d={s.path} fill="none" stroke={s.color} strokeWidth={2} strokeLinecap="round" />
          </g>
        ))}
        {hover !== null && plots[0]?.pts[hover] ? (
          <>
            <line
              x1={plots[0].pts[hover][0]}
              y1={PAD.t}
              x2={plots[0].pts[hover][0]}
              y2={H - PAD.b}
              stroke="var(--line-strong)"
              strokeDasharray="3 3"
            />
            {plots.map((s, i) => (
              <circle
                key={i}
                cx={s.pts[hover]?.[0]}
                cy={s.pts[hover]?.[1]}
                r={4}
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth={2}
              />
            ))}
          </>
        ) : null}
        {(plots[0]?.values || []).map((v, i) =>
          i % step === 0 ? (
            <text key={i} x={plots[0].pts[i]?.[0]} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--ink-3)">
              {v.label ?? fmtX(v.x)}
            </text>
          ) : null
        )}
      </svg>
      {hover !== null && plots[0]?.values[hover] ? (
        <div className="oo-trend-tip" style={{ left: `${(plots[0].pts[hover][0] / W) * 100}%`, top: 8 }}>
          {tipRender ? (
            tipRender(hover)
          ) : (
            <>
              <div style={{ fontWeight: 600 }}>{plots[0].values[hover].label}</div>
              {plots.map((s) => (
                <div key={s.key} className="oo-trend-tip-row">
                  <i style={{ background: s.color }} />
                  {s.label ?? s.name} <span>{s.values[hover]?.y ?? 0}</span>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 图例（多序列时必须显示，否则不知道哪条线是什么） */
export function Legend({ series = [] }) {
  if (series.length < 2) return null;
  return (
    <div className="oo-trend-legend">
      {series.map((s, i) => (
        <span className="oo-trend-legend-item" key={s.key || i}>
          <i style={{ background: s.color || SERIES_COLORS[i % SERIES_COLORS.length] }} />
          {s.label ?? s.name}
        </span>
      ))}
    </div>
  );
}

/**
 * 纵向柱状图（延迟分布 / 状态码分布 / 分位对比）
 * @param {Array} bars [{ label, value, color? }]
 */
export function BarChart({ bars = [], height = 170, valueFormat = (v) => v, showValue = true }) {
  const [hover, setHover] = useState(null);
  if (!bars.length) return <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const max = Math.max(1, ...bars.map((b) => Number(b.value) || 0));
  return (
    <div className="oo-bars" style={{ height }}>
      {bars.map((b, i) => {
        const v = Number(b.value) || 0;
        const pct = Math.max(v > 0 ? 2 : 0, (v / max) * 100);
        return (
          <div
            key={b.label ?? i}
            className="oo-bars-col"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            title={`${b.label}：${valueFormat(v)}`}
          >
            {showValue && hover === i ? <span className="oo-bars-val">{valueFormat(v)}</span> : null}
            <span
              className="oo-bars-fill"
              style={{ height: `${pct}%`, background: b.color || SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            <span className="oo-bars-label">{b.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 横向排行条（模型/渠道/用户排行，与渠道统计弹窗同款） */
export function RankBar({ items = [], nameKey = "name", valueKey = "value", suffix = "", max: maxProp, empty = "暂无数据" }) {
  if (!items.length) return <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const max = maxProp || Math.max(1, ...items.map((m) => Number(m[valueKey]) || 0));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((m, i) => (
        <div key={m[nameKey] ?? i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <span className="oo-truncate" style={{ width: 150, fontFamily: "var(--font-mono)" }} title={String(m[nameKey])}>
            {m[nameKey]}
          </span>
          <span style={{ flex: 1, height: 8, background: "var(--inset)", borderRadius: 4, overflow: "hidden" }}>
            <span
              style={{
                display: "block",
                width: `${Math.max(2, ((Number(m[valueKey]) || 0) / max) * 100)}%`,
                height: "100%",
                background: SERIES_COLORS[i % SERIES_COLORS.length],
              }}
            />
          </span>
          <span className="oo-num" style={{ width: 92, textAlign: "right", color: "var(--ink-3)" }}>
            {fmtCompact(m[valueKey])}
            {suffix}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 迷你趋势线（用于小卡片内的 sparkline）
 * 规范：宽高由父容器决定，无坐标轴，只有一条线。
 */
export function Sparkline({ values = [], color = "var(--accent)", width = 120, height = 28 }) {
  const path = useMemo(() => {
    if (!values.length) return "";
    const max = Math.max(1, ...values);
    const n = values.length;
    const pts = values.map((v, i) => [(i * width) / Math.max(1, n - 1), height - ((Number(v) || 0) / max) * height]);
    return smoothPath(pts);
  }, [values, width, height]);
  if (!values.length) return null;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ display: "block" }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
