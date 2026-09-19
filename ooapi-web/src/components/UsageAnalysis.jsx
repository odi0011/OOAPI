// 使用记录页的图表分析区
// ---------------------------------------------------------------------------
// 视觉规范与「渠道用量统计弹窗」保持一致（同一套 oo-* 类、同一套配色语义），
// 这是本项目图表展示的**统一标准**：新页面要画图，复用这里的组件与类，
// 不要自己写一套 SVG 与颜色。
//
// 内容：
//   · 每日趋势（调用/消费/Token 三口径切换）—— 平滑折线 + 悬浮十字线
//   · 模型消费排行（横向条）—— 和渠道统计弹窗的模型榜同款
//   · 缓存命中与延迟小结 —— 用于快速判断「是不是该优化提示词/渠道」
import React, { useMemo, useState } from "react";
import { Spin, Segmented, Empty } from "antd";

const SERIES_COLORS = [
  "#3b82f6", "#22c55e", "#f59e0b", "#ef4444",
  "#a855f7", "#06b6d4", "#ec4899", "#64748b",
];

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return v.toLocaleString();
}

/** Catmull-Rom → 三次贝塞尔（与渠道统计弹窗同一实现） */
function smoothPath(rawPts) {
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

const METRICS = [
  { key: "calls", label: "调用次数" },
  { key: "units", label: "消费" },
  { key: "tokens", label: "Token" },
  { key: "avgElapsed", label: "平均耗时" },
];

/** 每日趋势折线（单序列 + 悬浮十字线） */
function DayTrend({ byDay, metric }) {
  const [hover, setHover] = useState(null);
  const W = 780;
  const H = 200;
  const PAD = { l: 52, r: 14, t: 14, b: 26 };

  const { path, area, max, points } = useMemo(() => {
    const vals = byDay.map((d) => Number(d[metric]) || 0);
    const mx = Math.max(1, ...vals);
    const n = byDay.length || 1;
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const pts = vals.map((v, i) => [
      PAD.l + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1)),
      PAD.t + innerH - (v / mx) * innerH,
    ]);
    const p = smoothPath(pts);
    const a = p ? `${p} L ${pts[pts.length - 1][0]} ${PAD.t + innerH} L ${pts[0][0]} ${PAD.t + innerH} Z` : "";
    return { path: p, area: a, max: mx, points: pts };
  }, [byDay, metric]);

  if (!byDay.length) return <Empty description="该时间范围内没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

  // Y 轴 4 档刻度
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => ({
    y: PAD.t + (H - PAD.t - PAD.b) * (1 - r),
    v: max * r,
  }));

  return (
    <div className="oo-trend-wrap" style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) * W) / rect.width;
          let best = 0;
          let bestD = Infinity;
          points.forEach((p, i) => {
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
              {fmtCompact(t.v)}
            </text>
          </g>
        ))}
        {area ? <path d={area} fill="color-mix(in srgb, var(--accent) 12%, transparent)" /> : null}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" />
        {hover !== null && points[hover] ? (
          <>
            <line x1={points[hover][0]} y1={PAD.t} x2={points[hover][0]} y2={H - PAD.b} stroke="var(--line-strong)" strokeDasharray="3 3" />
            <circle cx={points[hover][0]} cy={points[hover][1]} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
          </>
        ) : null}
        {/* X 轴标签：最多 7 个，避免拥挤 */}
        {byDay.map((d, i) =>
          i % Math.max(1, Math.ceil(byDay.length / 7)) === 0 ? (
            <text key={d.day} x={points[i]?.[0]} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--ink-3)">
              {String(d.day).slice(5)}
            </text>
          ) : null
        )}
      </svg>
      {hover !== null && byDay[hover] ? (
        <div className="oo-trend-tip" style={{ left: `${(points[hover][0] / W) * 100}%`, top: 8 }}>
          <div style={{ fontWeight: 600 }}>{byDay[hover].day}</div>
          <div>调用 {byDay[hover].calls}</div>
          <div>消费 {byDay[hover].units} 单位</div>
          <div>Token {byDay[hover].tokens}</div>
          <div>缓存 {byDay[hover].cacheTokens}</div>
          <div>平均耗时 {(byDay[hover].avgElapsed / 1000).toFixed(2)}s</div>
        </div>
      ) : null}
    </div>
  );
}

/** 模型消费排行（横向条，与渠道统计弹窗同款） */
function ModelRank({ byModel }) {
  const list = byModel.slice(0, 10);
  if (!list.length) return <Empty description="该时间范围内没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const max = Math.max(1, ...list.map((m) => m.units || m.tokens));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {list.map((m, i) => (
        <div key={m.model} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <span className="oo-truncate" style={{ width: 170, fontFamily: "var(--font-mono)" }} title={m.model}>
            {m.model}
          </span>
          <span style={{ flex: 1, height: 8, background: "var(--inset)", borderRadius: 4, overflow: "hidden" }}>
            <span
              style={{
                display: "block",
                width: `${Math.max(2, ((m.units || m.tokens) / max) * 100)}%`,
                height: "100%",
                background: SERIES_COLORS[i % SERIES_COLORS.length],
              }}
            />
          </span>
          <span className="oo-num" style={{ width: 90, textAlign: "right", color: "var(--ink-3)" }}>
            {m.units} 单位
          </span>
          <span className="oo-num" style={{ width: 70, textAlign: "right", color: "var(--ink-3)" }}>
            {m.calls} 次
          </span>
        </div>
      ))}
    </div>
  );
}

export default function UsageAnalysis({ byDay = [], byModel = [], loading, error, onRefresh }) {
  const [metric, setMetric] = useState("calls");

  if (loading) {
    return (
      <div className="oo-panel" style={{ padding: 28, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <div className="oo-panel" style={{ padding: 16 }}>
        <div style={{ color: "var(--red)", fontSize: 13 }}>{error}</div>
        {onRefresh ? (
          <button type="button" className="bui-btn" style={{ marginTop: 8 }} onClick={onRefresh}>
            重试
          </button>
        ) : null}
      </div>
    );
  }

  // 小结：缓存命中率与平均延迟（按区间汇总）
  const sum = byDay.reduce(
    (a, d) => ({
      tokens: a.tokens + (d.tokens || 0),
      cache: a.cache + (d.cacheTokens || 0),
      elapsed: a.elapsed + (d.avgElapsed || 0),
      n: a.n + (d.avgElapsed ? 1 : 0),
    }),
    { tokens: 0, cache: 0, elapsed: 0, n: 0 }
  );
  const cacheRate = sum.tokens > 0 ? ((sum.cache / sum.tokens) * 100).toFixed(1) : "0.0";
  const avgElapsed = sum.n ? Math.round(sum.elapsed / sum.n) : 0;

  return (
    <div className="oo-panel" style={{ marginBottom: 14 }}>
      <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
        <div className="oo-stats-card-title">使用分析</div>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          缓存命中 {cacheRate}% · 平均耗时 {(avgElapsed / 1000).toFixed(2)}s
        </span>
      </div>

      <Segmented
        size="small"
        value={metric}
        onChange={setMetric}
        options={METRICS.map((m) => ({ value: m.key, label: m.label }))}
        style={{ marginBottom: 8 }}
      />
      <DayTrend byDay={byDay} metric={metric} />

      <div className="oo-stats-card-head" style={{ marginTop: 16, marginBottom: 8 }}>
        <div className="oo-stats-card-title">模型消费排行</div>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Top 10</span>
      </div>
      <ModelRank byModel={byModel} />
    </div>
  );
}
