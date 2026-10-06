import { Button as ActionButton } from "./arc/index";
import React, { useMemo, useState } from "react";
import {   Button, Empty, Grid, Segmented, Table, Tag, Tooltip  } from "./arc/index";
import { ArrowRightOutlined, InfoCircleOutlined  } from "./arc/icons";
import { ChartCard, Legend, LineChart, SERIES_COLORS, fmtCompact } from "./Charts";
import OdAmount from "./OdAmount";
import UserAvatar from "./UserAvatar";
import StatCard from "./StatCard";
import { ModelLabel } from "./VendorIcon";
import { DurationCell, TokenCell, formatDuration } from "./UsageCells";
import { fmtOd } from "../services/format";

const number = (value) => Math.max(0, Number(value) || 0);
const full = (value) => number(value).toLocaleString("en-US");
const percentage = (value, total) => total > 0 ? `${(number(value) / total * 100).toFixed(1)}%` : "—";
const RESULT = { success: ["成功", "success"], stopped: ["已停止", "default"], partial: ["部分完成", "warning"], error: ["失败", "error"] };
const beijingDay = (value) => Number(value) > 0 ? new Date((Number(value) + 28800) * 1000).toISOString().slice(0, 10) : "";

export function DashboardPeriod({ data, loading, error, updatedAt, fallbackDays, scopeLabel }) {
  const first = data?.trend?.[0]?.day || beijingDay(data?.range?.from);
  const last = data?.trend?.at(-1)?.day || beijingDay(data?.range?.to);
  return <div className="oo-dashboard-context">
    <span>{first && last ? `${first} — ${last}` : `近 ${data?.range?.days || fallbackDays} 天`}<span className="oo-dashboard-period-note">北京时间 · 含今日{scopeLabel ? ` · ${scopeLabel}` : ""}</span></span>
    <span role="status">{loading ? "正在更新数据…" : error ? "更新失败" : updatedAt ? `${updatedAt.toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })} 更新` : ""}</span>
  </div>;
}

function Comparison({ current, previous }) {
  if (previous == null || current == null) return <span>当前所选区间</span>;
  if (Number(previous) <= 0) return <span>上期无可比数据</span>;
  const change = (Number(current) - Number(previous)) / Number(previous) * 100;
  return <span>较上期 <span className="oo-num">{change > 0 ? "+" : ""}{change.toFixed(1)}%</span></span>;
}

function Metric({ label, value, current, previous, hint, note, tone }) {
  return <StatCard className="oo-dashboard-metric" label={<>{label}<ActionButton type="text" htmlType="button" className="oo-dashboard-info" aria-label={`${label}统计口径`}><InfoCircleOutlined /></ActionButton></>} value={value} tone={tone}
    hint={hint} foot={note || <Comparison current={current} previous={previous} />} />;
}

export function DashboardOverview({ data, perUnit, admin = false }) {
  const [metric, setMetric] = useState("calls");
  const screens = Grid.useBreakpoint();
  const totals = data?.totals || {}, previous = data?.previous || {}, trend = data?.trend || [];
  const calls = number(totals.calls), prompt = number(totals.prompt_tokens), output = number(totals.completion_tokens);
  const cache = Math.min(prompt, number(totals.cache_tokens));
  // 缓存已包含在输入中，这三个分项互不重叠，才能与总 Token 相加对齐。
  const tokens = [{ name: "未缓存输入", value: Math.max(0, prompt - cache), color: SERIES_COLORS[0] }, { name: "缓存读取", value: cache, color: SERIES_COLORS[5] }, { name: "输出", value: output, color: SERIES_COLORS[1] }];
  const partial = number(totals.partial), stopped = number(totals.stopped), successes = number(totals.successes);
  const failed = Math.max(0, number(totals.errors) - partial);
  const results = [{ name: "成功", value: successes, color: "var(--green)" }, { name: "失败", value: failed, color: "var(--red)" }, { name: "已停止", value: stopped, color: "var(--ink-3)" }, { name: "部分完成", value: partial, color: "var(--orange)" }];
  const remainder = Math.max(0, calls - successes - failed - stopped - partial);
  if (remainder > 0) results.push({ name: "其他状态", value: remainder, color: "var(--ink-3)" });
  const activeDays = trend.filter((day) => number(day.calls) > 0).length;
  const peak = trend.reduce((best, day) => number(day.calls) > number(best?.calls) ? day : best, null);
  const series = useMemo(() => {
    const values = (key, transform = number) => trend.map((day) => ({ x: day.day, label: day.day.slice(5), y: transform(day[key]) }));
    if (metric === "tokens") return [
      { name: "未缓存输入", color: SERIES_COLORS[0], values: trend.map((day) => ({ x: day.day, label: day.day.slice(5), y: Math.max(0, number(day.prompt_tokens) - number(day.cache_tokens)) })) },
      { name: "缓存读取", color: SERIES_COLORS[5], values: values("cache_tokens") },
      { name: "输出", color: SERIES_COLORS[1], values: values("completion_tokens") },
    ];
    if (metric === "units") return [{ name: "消费金额", color: SERIES_COLORS[0], values: values("units"), format: (value) => <OdAmount quota={value} perUnit={perUnit} digits={4} /> }];
    return [{ name: "全部调用", color: SERIES_COLORS[0], values: values("calls"), format: (value) => `${full(value)} 次` }, { name: "失败调用（含部分完成）", color: SERIES_COLORS[4], values: values("errors"), area: false, format: (value) => `${full(value)} 次` }];
  }, [trend, metric, perUnit]);
  const successRate = totals.success_rate;
  const totalTokens = prompt + output;
  return <>
    <div className="oo-stats-cards oo-dashboard-metrics" aria-label="区间用量总览">
      <Metric label="调用次数" value={<>{fmtCompact(calls)}<small>次</small></>} current={calls} previous={previous.calls} hint="所选区间的全部使用记录，成功、失败、主动停止及部分完成均只计一次。上期为相邻的等长日期区间，本期包含未结束的今日。" />
      <Metric label="消费金额" value={<OdAmount quota={totals.units} perUnit={perUnit} digits={4} size={12} />} current={totals.units} previous={previous.units} hint="所选区间使用记录的实际扣费总额，包含已产生用量的部分完成或停止请求；与使用记录的计费金额一致。" />
      <Metric label="Token 用量" value={fmtCompact(totalTokens)} current={totalTokens} previous={previous.tokens} hint={`总量 = 输入 + 输出，缓存读取已含在输入中。精确总量 ${full(totalTokens)}；输入 ${full(prompt)}，输出 ${full(output)}，缓存读取 ${full(cache)}。`} />
      <Metric label="请求成功率" value={successRate == null ? "—" : <>{successRate}<small>%</small></>} note={calls > 0 ? `${full(successes)} 次成功 / ${full(calls)} 次调用` : "所选区间暂无请求样本"} tone={successRate != null && successRate < 95 ? "warning" : undefined} hint="成功使用记录 / 全部调用；主动停止、失败及部分完成单列展示。这是所选区间的调用结果，不是实时 SLA。无样本时不显示 0% 或 100%。" />
    </div>
    <div className="oo-dashboard-summary" aria-label="区间辅助指标">
      {admin ? <span>活跃用户 <b>{full(totals.active_users)}</b></span> : null}
      <span>使用模型 <b>{full(totals.models)}</b></span>
      <span>平均首字 <b>{formatDuration(totals.avg_first_token)}</b></span>
      <span>平均总耗时 <b>{totals.avg_elapsed > 0 ? formatDuration(totals.avg_elapsed) : "—"}</b></span>
      <span>输入缓存命中率 <b>{prompt > 0 && totals.cache_rate != null ? `${totals.cache_rate}%` : "—"}</b></span>
    </div>
    <div className="oo-dashboard-primary">
      <ChartCard className="oo-dashboard-main-chart" title="用量趋势" note={activeDays ? `${activeDays} 个活跃日 · 峰值 ${peak?.day?.slice(5)}，${full(peak?.calls)} 次调用` : "所选日期范围 · 每日汇总"} extra={<Segmented size="small" aria-label="趋势指标" value={metric} onChange={setMetric} options={[{ value: "calls", label: "调用" }, { value: "tokens", label: "Token" }, { value: "units", label: "消费" }]} />}>
        <Legend series={series} />
        <LineChart series={calls > 0 ? series : []} height={206} maxXTicks={screens.md ? 7 : 3} yFormat={metric === "units" ? (value) => fmtOd(value, perUnit, 4, false) : fmtCompact} tipRender={(index) => <><div className="oo-trend-tip-date">{trend[index]?.day} · 北京时间</div>{series.map((item) => <div className="oo-trend-tip-row" key={item.name}><i style={{ background: item.color }} /><span>{item.name}</span><span>{item.format ? item.format(item.values[index]?.y) : full(item.values[index]?.y)}</span></div>)}</>} />
        <div className="oo-dashboard-chart-foot">今日数据截至本次更新；上期对比包含完整日期。</div>
      </ChartCard>
      <ChartCard title="用量构成" className="oo-dashboard-composition">
        <Composition title="请求结果" entries={results} total={calls} empty="暂无请求样本" />
        <Composition title="Token 构成" entries={tokens} total={totalTokens} empty="暂无 Token 用量" />
      </ChartCard>
    </div>
  </>;
}

function Composition({ title, entries, total, empty }) {
  return <section className="oo-dashboard-breakdown" aria-label={title}>
    <div className="oo-dashboard-breakdown-head"><span>{title}</span><span>{total > 0 ? full(total) : empty}</span></div>
    <div className="oo-dashboard-composition-track" aria-hidden="true">{entries.filter((entry) => entry.value > 0).map((entry) => <span key={entry.name} style={{ width: `${entry.value / total * 100}%`, background: entry.color }} />)}</div>
    <dl className="oo-dashboard-breakdown-list">{entries.map((entry) => <div key={entry.name}><dt><i style={{ background: entry.color }} />{entry.name}</dt><dd><span>{full(entry.value)}</span><small>{percentage(entry.value, total)}</small></dd></div>)}</dl>
  </section>;
}

export function DashboardModel({ record }) {
  const sources = Array.isArray(record.source_vendors) ? record.source_vendors : record.channel_type ? [record.channel_type] : [];
  const original = record.original_model || record.upstream_model || (record.billing_model !== record.model ? record.billing_model : "");
  return <div className="oo-dashboard-model"><Tooltip title={record.model}><span><ModelLabel model={record.model} modelVendor={record.model_vendor} channelTypes={sources} size={15} /></span></Tooltip>{original && original !== record.model ? <span className="oo-model-origin">↳ <ModelLabel model={original} channelTypes={sources} size={11} /></span> : null}</div>;
}

export function ModelUsageTable({ rows = [], totals = {}, perUnit }) {
  const [sort, setSort] = useState("calls");
  const sorted = useMemo(() => [...rows].sort((a, b) => number(b[sort]) - number(a[sort]) || number(b.calls) - number(a.calls) || String(a.model).localeCompare(String(b.model))), [rows, sort]);
  const total = number(totals[sort]);
  return <ChartCard title="模型用量" className="oo-dashboard-model-table" note={`${rows.length} 个模型 · 按当前范围汇总`} extra={<Segmented size="small" aria-label="模型排序" value={sort} onChange={setSort} options={[{ value: "calls", label: "按调用" }, { value: "units", label: "按消费" }]} />}>
    <Table className="oo-table" aria-label="模型用量明细" rowKey="model" size="small" dataSource={sorted} scroll={{ x: 540 }} pagination={rows.length > 6 ? { pageSize: 6, size: "small", showSizeChanger: false, showTotal: (count) => `共 ${count} 个模型` } : false} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选区间暂无模型调用" /> }} columns={[
      { title: "模型", dataIndex: "model", width: 190, render: (_, record) => <DashboardModel record={record} /> },
      { title: "调用", dataIndex: "calls", width: 65, align: "right", render: full },
      { title: "Tokens", width: 80, align: "right", render: (_, record) => <Tooltip title={full(number(record.prompt_tokens) + number(record.completion_tokens))}>{fmtCompact(number(record.prompt_tokens) + number(record.completion_tokens))}</Tooltip> },
      { title: "消费", dataIndex: "units", width: 110, align: "right", render: (value) => <OdAmount quota={value} perUnit={perUnit} digits={4} /> },
      { title: sort === "calls" ? "调用占比" : "消费占比", width: 95, render: (_, record) => <span className="oo-dashboard-share"><span>{percentage(record[sort], total)}</span><i><i style={{ width: `${total > 0 ? Math.min(100, number(record[sort]) / total * 100) : 0}%` }} /></i></span> },
    ]} />
  </ChartCard>;
}

export function RecentUsageTable({ rows = [], perUnit, admin = false, onMore }) {
  return <ChartCard title="最近调用" className="oo-dashboard-recent" note="所选范围内的最新 8 条 · 北京时间" extra={<Button type="text" size="small" onClick={onMore}>全部使用记录 <ArrowRightOutlined /></Button>}>
    <Table className="oo-table" aria-label="最近调用明细" rowKey="id" size="small" pagination={false} dataSource={rows} scroll={{ x: admin ? 1030 : 870 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选区间暂无调用记录" /> }} columns={[
      { title: "时间", dataIndex: "created_at", width: 130, render: (value) => Number(value) > 0 ? new Date((Number(value) + 28800) * 1000).toISOString().slice(5, 19).replace("T", " ") : "—" },
      ...(admin ? [{ title: "用户", width: 160, render: (_, record) => <UserAvatar user={{ ...record, id: record.user_id }} size={24} showName /> }] : []),
      { title: "模型", width: 220, render: (_, record) => <DashboardModel record={record} /> },
      { title: "结果", dataIndex: "status", width: 90, render: (value, record) => { const [label, color] = RESULT[value] || (value ? ["其他状态", "default"] : Number(record.type) === 2 ? RESULT.success : RESULT.error); return <Tag color={color}>{label}</Tag>; } },
      { title: "首字 / 总耗时", width: 130, render: (_, record) => <DurationCell firstTokenMs={record.first_token_ms} elapsedMs={record.elapsed_ms} /> },
      { title: "Tokens", width: 180, render: (_, record) => <TokenCell promptTokens={record.prompt_tokens} completionTokens={record.completion_tokens} cacheTokens={record.cache_tokens} /> },
      { title: "消费", dataIndex: "units", width: 120, align: "right", render: (value) => <OdAmount quota={value} perUnit={perUnit} digits={4} /> },
    ]} />
  </ChartCard>;
}
