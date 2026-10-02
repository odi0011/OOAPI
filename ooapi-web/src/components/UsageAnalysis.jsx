import OdAmount from "./OdAmount";
// 使用记录页的图表分析区
// ---------------------------------------------------------------------------
// 第 80 批：私有的 MiniTrend / ShareBar / smoothPath 删掉，统一用 Charts.jsx ——
// 原先这里有一份自己的折线实现（刻度是 max*0.5 的任意小数、提示框标题是原始日期串），
// 与看板页的图长得不一样；消费还按「单位」显示（违反全站只用 OD币 展示的约定）。
//
// 布局：
//   ① 主趋势（整行）：调用次数（左轴）+ 消费 OD币（右轴）—— 双量纲各自缩放；
//   ② Token 用量（输入 / 缓存命中）与平均耗时；
//   ③ 模型消费趋势（Top 5 多折线）与时段热点（7 天 × 24 小时）；
//   ④ 模型消费排行与模型调用占比（环形图）。
import React, { useState } from "react";
import { Spin, Empty } from "antd";
import { LineChart, RankBar, Legend, Donut, ChartCard, SERIES_COLORS, fmtCompact } from "./Charts";
import { odOf } from "../services/format";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 时段热点图：7 天 × 24 小时（像 GitHub 贡献图，但两维都是时间） */
function HourHeatmap({ hourly, perUnit }) {
  const [tip, setTip] = useState(null);
  if (!hourly?.length) return <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const max = Math.max(1, ...hourly.flat().map((c) => c.calls));
  // 五档离散色阶（离散比连续更好判读：一眼看出「哪个格子最深」）
  const level = (v) => (!v ? 0 : v / max > 0.75 ? 4 : v / max > 0.5 ? 3 : v / max > 0.25 ? 2 : 1);
  const bg = (l) => (l === 0 ? "var(--field)" : `color-mix(in srgb, var(--accent) ${18 + l * 20}%, var(--field))`);
  return (
    <div className="oo-heat">
      <div className="oo-heat-grid">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="oo-heat-hour">{h % 3 === 0 ? h : ""}</span>
        ))}
        {hourly.map((row, wd) => (
          <React.Fragment key={wd}>
            <span className="oo-heat-day">{WEEKDAYS[wd]}</span>
            {row.map((c) => (
              <span
                key={c.hour}
                className="oo-heat-cell"
                style={{ background: bg(level(c.calls)) }}
                onMouseEnter={() => setTip({ ...c, wd })}
                onMouseLeave={() => setTip(null)}
                aria-label={`${WEEKDAYS[wd]} ${c.hour} 点 ${c.calls} 次`}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
      <div className="oo-heat-foot">
        {tip ? (
          <span>
            {WEEKDAYS[tip.wd]} {String(tip.hour).padStart(2, "0")}:00 · <b>{tip.calls}</b> 次 · <OdAmount>{fmtCompact(odOf(tip.units, perUnit))}</OdAmount>
          </span>
        ) : (
          <span>悬停格子查看明细</span>
        )}
        <span className="oo-heat-scale">
          少
          {[0, 1, 2, 3, 4].map((l) => <i key={l} style={{ background: bg(l) }} />)}
          多
        </span>
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

  const od = (u) => odOf(u, perUnit);
  const fmtOdVal = (v) => <OdAmount>{fmtCompact(v)}</OdAmount>;
  const sum = byDay.reduce(
    (a, d) => ({
      calls: a.calls + (d.calls || 0),
      units: a.units + (d.units || 0),
      tokens: a.tokens + (d.tokens || 0),
      cache: a.cache + (d.cacheTokens || 0),
      elapsed: a.elapsed + (d.avgElapsed || 0) * (d.calls || 0),
      weighted: a.weighted + (d.avgElapsed ? d.calls || 0 : 0),
    }),
    { calls: 0, units: 0, tokens: 0, cache: 0, elapsed: 0, weighted: 0 }
  );
  // 缓存命中率分母是 **输入 token**（prompt 已含缓存部分，不能再加一次）
  const cacheRate = sum.tokens > 0 ? ((sum.cache / sum.tokens) * 100).toFixed(1) : "0.0";
  // 平均耗时按调用量加权（原先是「各天平均值再平均」，调用少的日子被放大）
  const avgElapsed = sum.weighted ? Math.round(sum.elapsed / sum.weighted) : 0;

  const days = byDay.map((d) => d.day);
  const modelLines = (modelSeries || []).map((ms, i) => ({
    name: ms.model,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    area: false,
    format: fmtOdVal,
    values: days.map((day) => {
      const hit = ms.points.find((p) => p.day === day);
      return { x: day, y: od(hit?.units) };
    }),
  }));

  const main = [
    { name: "调用次数", color: SERIES_COLORS[0], format: (v) => `${fmtCompact(v)} 次`, values: byDay.map((d) => ({ x: d.day, y: d.calls || 0 })) },
    { name: "消费", color: SERIES_COLORS[2], axis: "right", format: fmtOdVal, values: byDay.map((d) => ({ x: d.day, y: od(d.units) })) },
  ];
  const tokenLines = [
    { name: "输入 Token", color: SERIES_COLORS[0], values: byDay.map((d) => ({ x: d.day, y: d.tokens || 0 })) },
    { name: "缓存命中", color: SERIES_COLORS[1], values: byDay.map((d) => ({ x: d.day, y: d.cacheTokens || 0 })) },
  ];

  return (
    <div className="oo-panel oo-analysis">
      <div className="oo-analysis-head">
        <div className="oo-stats-card-title">使用分析</div>
        <div className="oo-analysis-kpis">
          <span>调用 <b>{fmtCompact(sum.calls)}</b> 次</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            消费 <OdAmount>{fmtCompact(od(sum.units))}</OdAmount>
          </span>
          <span>缓存命中 <b>{cacheRate}%</b></span>
          <span>平均耗时 <b>{(avgElapsed / 1000).toFixed(2)}</b> s</span>
          <span className="oo-analysis-tz">按北京时间（UTC+8）分天</span>
        </div>
      </div>

      <div className="oo-chart-grid">
        <ChartCard title="调用与消费" note="左轴调用次数 · 右轴消费" full>
          <Legend series={main} />
          <LineChart series={main} height={220} yFormatRight={(v) => fmtCompact(v)} />
        </ChartCard>
        <ChartCard title="Token 用量" note={`缓存命中 ${fmtCompact(sum.cache)}`}>
          <Legend series={tokenLines} />
          <LineChart series={tokenLines} height={170} />
        </ChartCard>
        <ChartCard title="平均耗时" note={`区间加权 ${(avgElapsed / 1000).toFixed(2)}s`}>
          <LineChart
            series={[{ name: "平均耗时", color: SERIES_COLORS[3], format: (v) => `${(v / 1000).toFixed(2)} s`, values: byDay.map((d) => ({ x: d.day, y: d.avgElapsed || 0 })) }]}
            yFormat={(v) => `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s`}
            height={170}
          />
        </ChartCard>
        <ChartCard title="模型消费趋势" note={modelLines.length ? `Top ${modelLines.length}` : "暂无数据"}>
          {modelLines.length ? (
            <>
              <Legend series={modelLines} />
              <LineChart series={modelLines} height={170} />
            </>
          ) : (
            <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </ChartCard>
        <ChartCard title="时段热点" note="近 7 天 × 24 小时 · 调用密度">
          <HourHeatmap hourly={hourly} perUnit={perUnit} />
        </ChartCard>
        <ChartCard title="模型消费排行" note="按消费排序">
          <RankBar items={byModel.map((m) => ({ name: m.model, value: od(m.units) }))} format={fmtOdVal} />
        </ChartCard>
        <ChartCard title="模型调用占比" note="按次数">
          <Donut items={byModel.map((m) => ({ name: m.model, value: m.calls }))} centerLabel="次调用" />
        </ChartCard>
      </div>
    </div>
  );
}
