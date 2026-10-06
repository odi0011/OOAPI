import { Table, Collapse } from "./arc/index";
import React from "react";
import { LineChart, BarChart, RankBar, Legend, SERIES_COLORS } from "./Charts";
import CodeBlock from "./CodeBlock";

// 图表仅接受有界 JSON 数据，不执行脚本、表达式、事件处理器或外部资源。
export function parseChart(source) {
  if (source.length > 40000) return null;
  try {
    const v = JSON.parse(source);
    if (!["bar", "line", "rank"].includes(v.type) || !Array.isArray(v.labels) || !v.labels.length || v.labels.length > 60 || !Array.isArray(v.series) || !v.series.length || v.series.length > 6) return null;
    if (!v.labels.every((s) => typeof s === "string" && s.length <= 80)) return null;
    if (!v.series.every((s) => s && typeof s.name === "string" && s.name.length <= 80 && Array.isArray(s.values) && s.values.length === v.labels.length && s.values.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e15))) return null;
    return { ...v, title: String(v.title || "数据图表").slice(0, 120) };
  } catch { return null; }
}

export default function MessageChart({ source }) {
  const data = parseChart(source);
  if (!data) return <CodeBlock lang="oo-chart" code={source}/>;
  const series = data.series.map((s, i) => ({ name: s.name, color: SERIES_COLORS[i], values: s.values.map((y, j) => ({ x: data.labels[j], y })) }));
  return <figure className="message-chart">
    <figcaption>{data.title}</figcaption>
    {data.type === "line" ? <><LineChart series={series}/><Legend series={series}/></> : data.series.map((s) => <div key={s.name}><span className="message-chart-series">{s.name}</span>{data.type === "rank" ? <RankBar items={s.values.map((value, i) => ({ name: data.labels[i], value }))} limit={60}/> : <BarChart bars={s.values.map((value, i) => ({ label: data.labels[i], value }))}/>}</div>)}
    <Collapse items={[{key:"data",label:"查看数据",children:<Table pagination={false} rowKey="index" columns={[{title:"项目",dataIndex:"label"},...data.series.map((s,i)=>({title:s.name,dataIndex:String(i),align:"right"}))]} dataSource={data.labels.map((label,index)=>({index,label,...Object.fromEntries(data.series.map((s,i)=>[String(i),s.values[index]]))}))}/>}]} />
  </figure>;
}
