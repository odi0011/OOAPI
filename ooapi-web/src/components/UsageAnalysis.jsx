// 使用记录页的图表分析区
// ---------------------------------------------------------------------------
// 视觉规范与「渠道用量统计弹窗」保持一致（同一套 oo-* 类、同一套配色语义），
// 这是本项目图表展示的**统一标准**：新页面要画图，复用这里的组件与类。
//
// 这一版的两个重要改变（用户反馈「图表太丑而且巨大、要看多个图一起」）：
//   ① **多图并列**：以前一次只显示一张图 + 一个 Segmented 切换，
//      要看「调用 vs 消费 vs Token」得来回点，且单张图被拉满整屏宽度。
//      现在改成 2×2 网格并列（调用/消费/Token/耗时各一张），
//      每张高度收敛到 132px —— 一屏看全四个口径。
//   ② **宽度跟随容器**：旧实现 viewBox 固定 780 配 width:100%，
//      被拉伸到宽屏时文字与线宽一起放大（丑的根源）。
//      现在用 ResizeObserver 实测宽度做 1:1 映射，字号恒定。
//
// 新增两类图（回答「单看一条线看不出结构」的问题）：
//   · 模型多折线：Top 5 模型的消费趋势叠在一张图上，看份额此消彼长；
//   · 时段热点图：7 天 × 24 小时的调用密度，看作息与峰谷。
import React, { useMemo, useState } from "react";
import { Spin, Empty, Tooltip } from "antd";
import { LineChart, BarChart, RankBar, Legend, Sparkline, SERIES_COLORS, fmtCompact, useResizeWidth } from "./Charts";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

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

/**
 * 图卡片：统一高度与内边距，标题在左上、口径说明在右上。
 *
 * 跨列策略（不要写死像素宽度 —— 网格列数是自适应的）：
 *   · 默认 1 列（单序列小图）；
 *   · `wide` 跨 2 列：内容需要横向空间但不需要整行（多折线、热力图）；
 *   · `full` 跨满整行：只给「一行只有它」的主趋势图用。
 * 实测教训：给「模型消费趋势」用 full 时它独占 1600px 而高仅 150px，
 * 折线被拉成一条斜直线 —— 宽高比失衡就是「丑」的直接来源。
 */
function ChartCard({ title, note, children, full, wide }) {
  const col = full ? "1 / -1" : wide ? "span 2" : undefined;
  return (
    <div className="oo-chart-card" style={col ? { gridColumn: col } : undefined}>
      <div className="oo-chart-card-head">
        <span className="oo-chart-card-title">{title}</span>
        {note ? <span className="oo-chart-card-note">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * 紧凑折线（多序列 + 悬浮十字线）。
 * 与 Charts.jsx 的 LineChart 的区别：这里是**小卡片内**使用，
 * 高度更矮、Y 轴只留 3 档、X 轴最多 4 个标签，避免小图里全是刻度文字。
 */
function MiniTrend({ series, height = 132, yFormat = fmtCompact, unitHint = "" }) {
  const [hover, setHover] = useState(null);
  const [wrapRef, W] = useResizeWidth(420); // 容器实测宽度：1:1 映射，文字不随宽屏放大
  const H = height;
  const PAD = { l: 44, r: 10, t: 10, b: 20 };

  const n = series[0]?.values?.length || 0;
  const { max, plots } = useMemo(() => {
    let mx = 0;
    for (const s of series) for (const v of s.values) mx = Math.max(mx, Number(v.y) || 0);
    mx = Math.max(1, mx);
    const innerW = Math.max(10, W - PAD.l - PAD.r);
    const innerH = H - PAD.t - PAD.b;
    const plots = series.map((s, si) => {
      const pts = s.values.map((v, i) => [
        PAD.l + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1)),
        PAD.t + innerH - ((Number(v.y) || 0) / mx) * innerH,
      ]);
      return { ...s, pts, path: smoothPath(pts), color: s.color || SERIES_COLORS[si % SERIES_COLORS.length] };
    });
    return { max: mx, plots };
  }, [series, n, H, W, PAD.l, PAD.r, PAD.t, PAD.b]);

  if (!n) return <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

  const ticks = [0, 0.5, 1].map((r) => ({ y: PAD.t + (H - PAD.t - PAD.b) * (1 - r), v: max * r }));
  const labels = series[0]?.values || [];
  // X 轴标签自适应：小图空间有限，标签太长（"2026-08-21"）会相互重叠。
  // 按「每个标签至少 58px」算能放几个，再决定是否缩写为 MM-DD。
  const labelBudget = Math.max(2, Math.floor((W - PAD.l - PAD.r) / 58));
  const step = Math.max(1, Math.ceil(n / labelBudget));
  const shortDate = (v) => {
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : s;
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
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
            <text x={PAD.l - 5} y={t.y + 3.5} textAnchor="end" fontSize={9.5} fill="var(--ink-3)">
              {yFormat(t.v)}
            </text>
          </g>
        ))}
        {plots.map((p) => (
          <path key={p.name} d={p.path} fill="none" stroke={p.color} strokeWidth={1.8} strokeLinecap="round" />
        ))}
        {hover !== null ? (
          <line
            x1={plots[0]?.pts[hover]?.[0]}
            y1={PAD.t}
            x2={plots[0]?.pts[hover]?.[0]}
            y2={H - PAD.b}
            stroke="var(--line-strong)"
            strokeDasharray="3 3"
          />
        ) : null}
        {plots.map((p) =>
          hover !== null && p.pts[hover] ? (
            <circle key={`d-${p.name}`} cx={p.pts[hover][0]} cy={p.pts[hover][1]} r={3} fill={p.color} stroke="var(--surface)" strokeWidth={1.5} />
          ) : null
        )}
        {labels.map((v, i) =>
          i % step === 0 ? (
            <text key={i} x={plots[0]?.pts[i]?.[0]} y={H - 6} textAnchor="middle" fontSize={9.5} fill="var(--ink-3)">
              {shortDate(v.x)}
            </text>
          ) : null
        )}
      </svg>
      {hover !== null ? (
        <div className="oo-trend-tip" style={{ left: `${((plots[0]?.pts[hover]?.[0] || 0) / W) * 100}%`, top: 4 }}>
          <div style={{ fontWeight: 600 }}>{labels[hover]?.x}</div>
          {plots.map((p) => (
            <div key={p.name} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: p.color, display: "inline-block" }} />
              <span>{p.name}</span>
              <b style={{ marginLeft: "auto" }}>{fmtCompact(p.values[hover]?.y || 0)}</b>
            </div>
          ))}
          {unitHint ? <div style={{ color: "#aaa" }}>{unitHint}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 时段热点图：7 天 × 24 小时（像 GitHub 贡献图，但两维都是时间） */
function HourHeatmap({ hourly }) {
  const [tip, setTip] = useState(null);
  if (!hourly?.length) return <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const max = Math.max(1, ...hourly.flat().map((c) => c.calls));
  // 五档离散色阶（离散比连续更好判读：一眼看出「哪个格子最深」）
  const level = (v) => {
    if (!v) return 0;
    const r = v / max;
    if (r > 0.75) return 4;
    if (r > 0.5) return 3;
    if (r > 0.25) return 2;
    return 1;
  };
  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "grid", gridTemplateColumns: "34px repeat(24, 1fr)", gap: 2, fontSize: 9.5 }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} style={{ textAlign: "center", color: "var(--ink-3)" }}>
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {hourly.map((row, wd) => (
          <React.Fragment key={wd}>
            <span style={{ color: "var(--ink-3)", lineHeight: "14px" }}>{WEEKDAYS[wd].slice(1)}</span>
            {row.map((c) => (
              <Tooltip
                key={c.hour}
                title={`${WEEKDAYS[wd]} ${String(c.hour).padStart(2, "0")}:00 · ${c.calls} 次 · ${c.units} 单位`}
              >
                <span
                  onMouseEnter={() => setTip(c)}
                  onMouseLeave={() => setTip(null)}
                  style={{
                    height: 14,
                    borderRadius: 2,
                    background:
                      level(c.calls) === 0
                        ? "var(--inset)"
                        : `color-mix(in srgb, var(--accent) ${level(c.calls) * 22}%, var(--inset))`,
                  }}
                />
              </Tooltip>
            ))}
          </React.Fragment>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, fontSize: 10.5, color: "var(--ink-3)" }}>
        <span>少</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span
            key={l}
            style={{
              width: 11,
              height: 11,
              borderRadius: 2,
              background: l === 0 ? "var(--inset)" : `color-mix(in srgb, var(--accent) ${l * 22}%, var(--inset))`,
            }}
          />
        ))}
        <span>多（峰值 {max} 次）</span>
        {tip ? <span style={{ marginLeft: "auto" }}>{WEEKDAYS[tip.weekday]} {tip.hour}:00 · {tip.calls} 次</span> : null}
      </div>
    </div>
  );
}

/** 单机游戏化的分布条：状态/耗时/模型份额都能用（横向堆叠） */
function ShareBar({ items }) {
  const total = items.reduce((a, b) => a + (Number(b.value) || 0), 0);
  if (!total) return <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div>
      <div style={{ display: "flex", height: 10, borderRadius: 4, overflow: "hidden", background: "var(--inset)" }}>
        {items.map((it, i) => (
          <Tooltip key={it.name} title={`${it.name}：${fmtCompact(it.value)}（${((it.value / total) * 100).toFixed(1)}%）`}>
            <span style={{ width: `${(it.value / total) * 100}%`, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          </Tooltip>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 7, fontSize: 11.5 }}>
        {items.map((it, i) => (
          <span key={it.name} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ink-3)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            <span className="oo-truncate" style={{ maxWidth: 120 }}>{it.name}</span>
            <b style={{ color: "var(--ink)" }}>{(it.value).toLocaleString()}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function UsageAnalysis({ byDay = [], byModel = [], modelSeries = [], hourly = [], loading, error, onRefresh, perUnit }) {
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
  if (!byDay.length && !byModel.length) {
    return (
      <div className="oo-panel" style={{ padding: "40px 0" }}>
        <Empty description="该时间范围内没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  const sum = byDay.reduce(
    (a, d) => ({
      calls: a.calls + (d.calls || 0),
      units: a.units + (d.units || 0),
      tokens: a.tokens + (d.tokens || 0),
      cache: a.cache + (d.cacheTokens || 0),
      elapsed: a.elapsed + (d.avgElapsed || 0),
      n: a.n + (d.avgElapsed ? 1 : 0),
    }),
    { calls: 0, units: 0, tokens: 0, cache: 0, elapsed: 0, n: 0 }
  );
  // 缓存命中率分母是 **输入 token**（不是总量）：prompt 已含缓存部分，不能再加一次
  const cacheRate = sum.tokens > 0 ? ((sum.cache / sum.tokens) * 100).toFixed(1) : "0.0";
  const avgElapsed = sum.n ? Math.round(sum.elapsed / sum.n) : 0;

  const xOf = (arr) => arr.map((d) => ({ x: d.day, y: 0 }));
  const trend = (key) => [
    { name: key.label, values: byDay.map((d) => ({ x: d.day, y: Number(d[key.field]) || 0 })), color: key.color },
  ];

  // 模型多折线：把 modelSeries 补齐到与 byDay 相同的日期轴（缺的日期填 0），
  // 否则各条线的 X 轴长度不同，画出来会错位。
  const days = byDay.map((d) => d.day);
  const modelLines = (modelSeries || []).map((ms, i) => ({
    name: ms.model,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    values: days.map((day) => {
      const hit = ms.points.find((p) => p.day === day);
      return { x: day, y: Number(hit?.units) || 0 };
    }),
  }));

  return (
    <div className="oo-panel" style={{ marginBottom: 14 }}>
      <div className="oo-stats-card-head" style={{ marginBottom: 10 }}>
        <div className="oo-stats-card-title">使用分析</div>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          缓存命中 {cacheRate}% · 平均耗时 {(avgElapsed / 1000).toFixed(2)}s · 时区 UTC+8（按天重置）
        </span>
      </div>

      {/* 多图并列：一屏看全四个口径，不用来回切换 */}
      <div className="oo-chart-grid">
        <ChartCard title="调用次数" note={`合计 ${fmtCompact(sum.calls)}`}>
          <MiniTrend series={trend({ label: "调用", field: "calls", color: SERIES_COLORS[0] })} />
        </ChartCard>
        <ChartCard title="消费" note={`合计 ${fmtCompact(sum.units)} 单位`}>
          <MiniTrend series={trend({ label: "消费", field: "units", color: SERIES_COLORS[2] })} />
        </ChartCard>
        <ChartCard title="Token 用量" note={`命中 ${fmtCompact(sum.cache)}`}>
          <MiniTrend series={trend({ label: "Token", field: "tokens", color: SERIES_COLORS[1] })} />
        </ChartCard>
        <ChartCard title="平均耗时" note={`${(avgElapsed / 1000).toFixed(2)}s`}>
          <MiniTrend
            series={trend({ label: "耗时(ms)", field: "avgElapsed", color: SERIES_COLORS[4] })}
            yFormat={(v) => `${Math.round(v)}`}
            unitHint="单位：毫秒"
          />
        </ChartCard>
      </div>

      {/* 模型多折线：看份额此消彼长 */}
      <div className="oo-chart-grid" style={{ marginTop: 12 }}>
        <ChartCard
          title="模型消费趋势"
          note={modelLines.length ? `Top ${modelLines.length}` : "暂无数据"}
          wide={modelLines.length > 0}
        >
          {modelLines.length ? (
            <>
              <MiniTrend series={modelLines} height={150} />
              <Legend series={modelLines.map((s) => ({ name: s.name, color: s.color }))} />
            </>
          ) : (
            <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </ChartCard>

        <ChartCard title="时段热点" note="7 天 × 24 小时（调用密度）">
          <HourHeatmap hourly={hourly} />
        </ChartCard>
      </div>

      <div className="oo-chart-grid" style={{ marginTop: 12 }}>
        <ChartCard title="模型消费排行" note="Top 10">
          <RankBar
            items={byModel.slice(0, 10).map((m) => ({ name: m.model, value: m.units }))}
            suffix=" 单位"
          />
        </ChartCard>
        <ChartCard title="模型调用占比" note="按次数">
          <ShareBar items={byModel.slice(0, 8).map((m) => ({ name: m.model, value: m.calls }))} />
        </ChartCard>
      </div>
    </div>
  );
}
