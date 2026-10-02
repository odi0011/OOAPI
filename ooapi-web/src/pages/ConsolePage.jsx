import OdAmount from "../components/OdAmount";
import { OdCoin } from "../components/OdCoin";
import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, App as AntApp, Button, Empty, Segmented, Skeleton, Table, Tag } from "antd";
import { ArrowRightOutlined, CopyOutlined, KeyOutlined, ReloadOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import { BarChart, ChartCard, Donut, KpiCard, Legend, LineChart, RankBar, SERIES_COLORS, fmtCompact } from "../components/Charts";
import { DurationCell, TokenCell } from "../components/UsageCells";
import { ModelLabel } from "../components/VendorIcon";
import { apiEndpoint, copyText, fmtDate, fmtOd, odOf, unitsPerOd } from "../services/format";
import { userDataVisibility } from "../services/visibility";
import "../dashboard.css";

const RANGES = [{ value: "7d", label: "7 天" }, { value: "30d", label: "30 天" }, { value: "90d", label: "90 天" }];
const RESULT = { success: ['成功', 'success'], stopped: ['已停止', 'default'], partial: ['部分完成', 'warning'], error: ['失败', 'error'] };

export default function ConsolePage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { status, user } = useApp();
  const visibility = userDataVisibility(status, user);
  const { begin, isLatest } = useLatest();
  const [range, setRange] = useState("30d");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState("calls");
  const [updatedAt, setUpdatedAt] = useState(null);
  const perUnit = unitsPerOd(status);
  const load = useCallback(async () => {
    const request = begin();
    setLoading(true); setError("");
    try {
      const next = await API.get("/dashboard/self", { params: { range } });
      if (isLatest(request)) { setData(next); setUpdatedAt(new Date()); }
    } catch (e) { if (isLatest(request)) { setError(e.message); message.error(e.message); } }
    finally { if (isLatest(request)) setLoading(false); }
  }, [range, begin, isLatest, message]);
  useEffect(() => { load(); }, [load]);
  const copy = async (value) => { try { await copyText(value); message.success("已复制 API 地址"); } catch { message.error("复制失败，请手动选择复制"); } };
  const a = data?.account || {};
  const t = data?.totals || {};
  const p = data?.previous || {};
  const trend = data?.trend || [];
  const days = data?.range?.days || parseInt(range, 10);
  const money = (v) => v === null || v === undefined ? "—" : fmtOd(v, perUnit, 4, false);
  const endpoint = apiEndpoint(status?.api_endpoint);
  const series = [{ name: metric === 'calls' ? '调用次数' : '消费', values: trend.map((d) => ({ x: d.day, y: metric === 'calls' ? d.calls : odOf(d.units, perUnit) })), format: (v) => metric === 'calls' ? `${fmtCompact(v)} 次` : <OdAmount>{fmtCompact(v)}</OdAmount> }];
  const tokenSeries = [
    { name: "输入（含缓存）", values: trend.map((d) => ({ x: d.day, y: d.prompt_tokens })) },
    { name: "输出", color: SERIES_COLORS[1], values: trend.map((d) => ({ x: d.day, y: d.completion_tokens })) },
  ];

  return <div className="oo-page oo-dashboard">
    <PageHeader title="数据看板" tags={visibility.usage_summary ? <Tag>个人用量</Tag> : undefined} extra={<>{visibility.usage_summary ? <Segmented value={range} options={RANGES} onChange={setRange} /> : null}<Button icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="刷新个人看板" /></>} />
    <div className="oo-dashboard-context"><span>{visibility.usage_summary ? `近 ${days} 天 · 北京时间` : "账户概览"}</span><span>{loading ? "正在更新数据…" : error ? "更新失败" : updatedAt ? `${updatedAt.toLocaleTimeString('zh-CN', { hour12: false })} 更新` : ""}</span></div>
    {error && <Alert showIcon type="error" message={data ? "更新失败，当前保留上次成功的数据" : "看板加载失败"} description={error} action={<Button size="small" loading={loading} onClick={load}>重试</Button>} />}
    {!data ? loading && <div className="oo-panel oo-dashboard-loading"><Skeleton active paragraph={{ rows: 8 }} /></div> : <>
      <section className="oo-panel oo-account-overview" aria-label="账户概览">
        {visibility.balance ? <div className="oo-account-balance"><span>{a.quota < 0 ? '账户欠费' : '可用余额'}</span><strong className={a.quota < 0 ? 'is-danger' : ''}><OdAmount quota={a.quota == null ? null : Math.abs(a.quota)} perUnit={perUnit} size={20} /></strong>{a.quota < 0 ? <span>补足欠费后恢复调用</span> : null}</div> : null}
        {visibility.usage_summary ? <div><span>累计消费</span><b><OdAmount quota={a.used_quota} perUnit={perUnit} digits={4} /></b><span>账户历史累计</span></div> : null}
        <div><span>有效 API 令牌</span><b>{a.active_tokens ?? '—'}<small> / {a.total_tokens ?? '—'}</small></b><span>当前可用令牌</span></div>
        <div><span>账户默认分组</span><b>{a.group_name || '—'}</b><span>实际调用以令牌绑定分组为准</span></div>
        <Button icon={<KeyOutlined />} onClick={() => navigate('/token')}>管理令牌</Button>
      </section>
      {visibility.usage_summary && data.totals ? <><div className="oo-kpi-grid">
        <KpiCard label="调用次数" value={fmtCompact(t.calls)} unit="次" current={t.calls} previous={p.calls} spark={trend.map((d) => d.calls)} hint="包含成功、失败及主动停止的使用记录" />
        <KpiCard label="消费金额" value={money(t.units)} unit={<OdCoin size={16} />} current={t.units} previous={p.units} spark={trend.map((d) => d.units)} />
        <KpiCard label="Token 用量" value={fmtCompact(t.total_tokens)} current={t.total_tokens} previous={p.tokens} hint={`输入 ${fmtCompact(t.prompt_tokens)} · 输出 ${fmtCompact(t.completion_tokens)}`} />
        <KpiCard label="请求成功率" value={t.success_rate == null ? '—' : `${t.success_rate}%`} hint={t.calls ? `成功 ${fmtCompact(t.successes)} · 失败 ${fmtCompact(t.errors)} · 其余为停止等状态` : '所选区间暂无请求样本'} tone={t.success_rate != null && t.success_rate < 95 ? 'warning' : undefined} />
      </div>
      <div className="oo-chart-grid oo-dashboard-grid">
        <ChartCard className="oo-dashboard-main-chart" title="用量趋势" note={`近 ${days} 天 · 每日汇总`} extra={<Segmented size="small" value={metric} onChange={setMetric} options={[{ value: 'calls', label: '调用' }, { value: 'units', label: '消费' }]} />}><LineChart series={t.calls ? series : []} height={260} /></ChartCard>
        <ChartCard title="模型消费排行" note="按消费排序 · 展示前 8 项"><RankBar items={(data.by_model || []).map((m) => ({ name: m.model, value: odOf(m.units, perUnit), sub: `${fmtCompact(m.calls)} 次调用` }))} format={(v) => <OdAmount>{fmtCompact(v)}</OdAmount>} /></ChartCard>
        <ChartCard title="Token 趋势" note={`缓存命中 ${fmtCompact(t.cache_tokens)} · 输入的 ${t.cache_rate ?? 0}%`} extra={<Legend series={tokenSeries} />}><LineChart series={t.total_tokens ? tokenSeries : []} height={210} /></ChartCard>
        <ChartCard title="调用时段" note="所选区间 · 北京时间 0–23 时"><BarChart bars={(data.by_hour || []).map((h) => ({ label: `${h.hour}时`, value: h.calls }))} height={210} valueFormat={(v) => `${fmtCompact(v)} 次`} /></ChartCard>
        <ChartCard title="模型调用分布" note="按调用次数 · 包含归集的其他模型"><Donut items={(data.by_model || []).map((m) => ({ name: m.model, value: m.calls }))} centerLabel="次调用" /></ChartCard>
      </div></> : <Alert type="info" showIcon message="管理员未开放用量汇总" />}
      {visibility.usage_records && Array.isArray(data.recent_logs) ? <section className="oo-panel oo-dashboard-table"><div className="oo-panel-head"><div><span className="oo-panel-title">最近调用</span><span className="oo-dashboard-caption">最新 8 条</span></div><Button type="text" size="small" onClick={() => navigate('/log')}>全部使用记录 <ArrowRightOutlined /></Button></div>
        <Table className="oo-table" rowKey="id" size="small" pagination={false} scroll={{ x: 780 }} dataSource={data.recent_logs || []} locale={{ emptyText: <Empty description="尚未发起调用，创建令牌后即可开始" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[
          { title: '时间', dataIndex: 'created_at', width: 142, render: (v) => fmtDate(v, 'MM-DD HH:mm:ss') },
          { title: '模型', dataIndex: 'model', render: (v, r) => <ModelLabel model={v} channelTypes={Array.isArray(r.source_vendors) ? r.source_vendors : r.channel_type ? [r.channel_type] : []} title={v} /> },
          { title: '结果', dataIndex: 'status', width: 96, render: (v, r) => { const [label, color] = RESULT[v] || (r.type === 2 ? RESULT.success : RESULT.error); return <Tag color={color}>{label}</Tag>; } },
          { title: '耗时', dataIndex: 'elapsed_ms', width: 112, render: (v, r) => <DurationCell elapsedMs={v} firstTokenMs={r.first_token_ms} /> },
          { title: 'Tokens', width: 180, render: (_, r) => <TokenCell promptTokens={r.prompt_tokens} completionTokens={r.completion_tokens} cacheTokens={r.cache_tokens} /> },
          { title: '消费', dataIndex: 'units', align: 'right', width: 130, render: (v) => <OdAmount quota={v} perUnit={perUnit} digits={4} /> },
        ]} />
      </section> : null}
      <section className="oo-panel oo-dashboard-connect"><div><b>连接你的应用</b><p>使用平台令牌与当前令牌可用的模型 ID 发起请求。</p></div><code>{endpoint}</code><Button icon={<CopyOutlined />} onClick={() => copy(endpoint)}>复制地址</Button><Link to="/#quickstart">接入指南 <ArrowRightOutlined /></Link></section>
    </>}
  </div>;
}
