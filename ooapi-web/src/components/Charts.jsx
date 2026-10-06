import React, { useEffect, useRef, useState } from "react";
import { LineChart as ArcLineChart } from "./arc/line-chart/line-chart";
import { BarChart as ArcBarChart } from "./arc/bar-chart/bar-chart";
import { DonutChart } from "./arc/donut-chart/donut-chart";
import { Sparkline as ArcSparkline } from "./arc/sparkline/sparkline";
import { Card } from "./arc/index";
import { Empty, Table } from "./arc/index";
import StatCard from "./StatCard";
export const SERIES_COLORS = ["var(--accent)", "#14b8a6", "#f59e0b", "#8b5cf6", "#ef4444", "#0ea5e9", "#ec4899", "#64748b"];
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


// 不同单位拆成上下两个 Arc 图，保留真实数值，避免把 Token/s 与请求数混用同一轴。
export function LineChart({ series = [], height = 200, yFormat = fmtCompact, yFormatRight, maxXTicks = 7 }) {
 const groups = series.some(s => s.axis === "right") ? [series.filter(s => s.axis !== "right"), series.filter(s => s.axis === "right")] : [series];
 return <div className="arc-chart-stack">{groups.map((list, group) => {
 const data = (list[0]?.values || []).map((v, i) => ({ key: String(v.x ?? i), label: String(v.x ?? i), axisLabel: i % Math.max(1, Math.ceil((list[0]?.values.length || 1) / maxXTicks)) === 0 ? String(v.x ?? i).slice(-5) : undefined, values: Object.fromEntries(list.map((s, n) => [String(n), Number(s.values?.[i]?.y) || 0])) }));
 return <ArcLineChart key={group} label={list.map(s => s.name).join(" · ") || "用量趋势"} data={data} series={list.map((s, i) => ({ key: String(i), label: s.name, color: s.color || SERIES_COLORS[i], dashed: s.dashed, area: s.fill !== false }))} height={groups.length > 1 ? Math.max(120, height / 2) : height} legend={false} formatTick={group && yFormatRight ? yFormatRight : yFormat} formatValue={(v, s) => list[Number(s.key)]?.format?.(v) ?? (group && yFormatRight ? yFormatRight(v) : yFormat(v))} emptyLabel="暂无数据" categoryLabel="日期"/>;
 })}</div>;
}
export function Legend({ series = [] }) { return <div className="arc-chart-legend">{series.map((s,i) => <span key={s.name || i}><i style={{ background:s.color || SERIES_COLORS[i] }}/>{s.name}</span>)}</div>; }
export function BarChart({ bars = [], height = 170, valueFormat = fmtCompact }) { return <ArcBarChart data={bars.map((b,i) => ({ key:String(i), label:String(b.label), axisLabel:String(b.label), value:Number(b.value)||0 }))} label="分布" period="" height={height} formatValue={valueFormat} showAverage={false} categoryLabel="类别" valueLabel="数值"/>; }
export function RankBar({ items = [], nameKey = "name", valueKey = "value", suffix = "", total: allTotal, empty = "暂无数据", format, limit = 8 }) {
 const total=allTotal??items.reduce((n,m)=>n+(Number(m[valueKey])||0),0), fmt=format|| (v=>fmtCompact(v)+suffix);
 return <Table size="small" pagination={false} dataSource={items.slice(0,limit).map((m,i)=>({...m,__key:i}))} rowKey="__key" locale={{emptyText:empty}} columns={[{ title:"名称",key:"name",render:(_,m)=><span onClick={m.onClick}>{m[nameKey]}{m.sub?<small>{m.sub}</small>:null}</span> },{title:"数值",key:"value",align:"right",width:110,render:(_,m)=>fmt(Number(m[valueKey])||0)},{title:"占比",key:"share",align:"right",width:70,render:(_,m)=>total?((Number(m[valueKey])||0)/total*100).toFixed(1)+"%":"—"}]}/>;
}
export function Donut({ items = [], size = 132, thickness = 16, centerLabel, format = fmtCompact, empty = "暂无数据", maxItems = 6 }) { return <DonutChart data={items.map((m,i)=>({key:String(m.key??m.name??i),label:m.name||m.label,value:Number(m.value)||0,color:m.color}))} label={centerLabel||"用量构成"} size={size} thickness={thickness} totalLabel={centerLabel||"合计"} formatValue={format} emptyLabel={empty} otherLabel="其他" maxSegments={maxItems} legend={false}/>; }
export function Sparkline({ values = [], width = 120, height = 28 }) { return <ArcSparkline data={values.map(Number)} label="趋势" width={width} height={height} interactive={false}/>; }
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
  return <StatCard label={label} value={value} suffix={unit} tone={tone} hint={hint}
    foot={<>{delta ? <span className={`oo-kpi-delta ${delta.cls}`}>{delta.text} 较上期</span> : null}{spark?.length > 1 ? <Sparkline values={spark} width={84} height={24} color={tone === "danger" ? "var(--red)" : "var(--accent)"} /> : null}</>} />;
}


export function ChartCard({ title, note, extra, children, full, className = "" }) { return <Card className={`oo-chart-card${full ? " is-full" : ""} ${className}`} title={title} description={note} headerAction={extra}>{children}</Card>; }
