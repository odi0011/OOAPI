import OdAmount from "../components/OdAmount";
import { OdCoin } from "../components/OdCoin";
import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, App as AntApp, Button, Empty, Segmented, Select, Skeleton, Table, Tag } from "antd";
import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import UserAvatar from "../components/UserAvatar";
import { VendorIcon } from "../components/VendorIcon";
import { ChartCard, Donut, KpiCard, Legend, LineChart, RankBar, SERIES_COLORS, fmtCompact } from "../components/Charts";
import { DurationCell } from "../components/UsageCells";
import { fmtOd, odOf, unitsPerOd } from "../services/format";
import "../dashboard.css";

const RANGES = [{ value: "7d", label: "7 天" }, { value: "30d", label: "30 天" }, { value: "90d", label: "90 天" }];
const rate = (v) => v == null ? '—' : `${v}%`;
const errorRate = (t) => Number(t?.calls) > 0 ? Number(t.errors || 0) / Number(t.calls) * 100 : null;

export default function AdminDashboardPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { status } = useApp();
  const { begin, isLatest } = useLatest();
  const [userId, setUserId] = useState(null);
  const [tokenId, setTokenId] = useState(null);
  const [filters, setFilters] = useState({ users: [], tokens: [] });
  useEffect(() => { let active = true; API.get("/dashboard/filters", { params: { user_id: userId } }).then(v => { if (active) setFilters(v); }).catch(e => message.error(e.message)); return () => { active = false; }; }, [userId, message]);
  const [range, setRange] = useState("30d");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState("calls");
  const [updatedAt, setUpdatedAt] = useState(null);
  const perUnit = unitsPerOd(status);
  const load = useCallback(async () => {
    const request = begin(); setLoading(true); setError("");
    try { const next = await API.get("/dashboard/admin", { params: { range, user_id: userId, token_id: tokenId } }); if (isLatest(request)) { setData(next); setUpdatedAt(new Date()); } }
    catch (e) { if (isLatest(request)) { setError(e.message); message.error(e.message); } }
    finally { if (isLatest(request)) setLoading(false); }
  }, [range, userId, tokenId, begin, isLatest, message]);
  useEffect(() => { load(); }, [load]);
  const t = data?.totals || {};
  const p = data?.previous || {};
  const rt = data?.realtime || {};
  const trend = data?.trend || [];
  const days = data?.range?.days || parseInt(range, 10);
  const err = errorRate(t);
  const series = [{ name: metric === 'calls' ? '调用次数' : '消费', values: trend.map((d) => ({ x: d.day, y: metric === 'calls' ? d.calls : odOf(d.units, perUnit) })), format: (v) => metric === 'calls' ? `${fmtCompact(v)} 次` : <OdAmount>{fmtCompact(v)}</OdAmount> }];
  const tokenSeries = [
    { name: "输入（含缓存）", values: trend.map((d) => ({ x: d.day, y: d.prompt_tokens })) },
    { name: "输出", color: SERIES_COLORS[1], values: trend.map((d) => ({ x: d.day, y: d.completion_tokens })) },
  ];
  const rankItems = (rows, name) => (rows || []).map((r) => ({ name: r[name], value: odOf(r.units, perUnit), sub: `${fmtCompact(r.calls)} 次调用` }));
  const money = (v) => <OdAmount>{fmtCompact(v)}</OdAmount>;

  return <div className="oo-page oo-dashboard">
    <PageHeader title="数据看板" tags={<Tag>{userId || tokenId ? "筛选用量" : "全站用量"}</Tag>} extra={<><Select allowClear showSearch optionFilterProp="label" placeholder="全部用户" aria-label="筛选用户" style={{ width: 180 }} value={userId} onChange={v => { setUserId(v); setTokenId(null); }} options={filters.users.map(u => ({ value: u.id, label: u.display_name || u.username }))} /><Select allowClear showSearch optionFilterProp="label" placeholder="全部密钥" aria-label="筛选密钥" style={{ width: 200 }} value={tokenId} onChange={setTokenId} options={filters.tokens.map(t => ({ value: t.id, label: `${t.name} · ${t.owner}` }))} /><Segmented value={range} options={RANGES} onChange={setRange} /><Button icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="刷新数据看板" /></>} />
    <div className="oo-dashboard-context"><span>近 {days} 天 · 北京时间 · 含今日，今日数据尚未完整</span><span>{loading ? '正在更新数据…' : error ? '更新失败' : updatedAt ? `${updatedAt.toLocaleTimeString('zh-CN', { hour12: false })} 更新` : ''}</span></div>
    {error && <Alert showIcon type="error" message={data ? "更新失败，当前保留上次成功的数据" : "数据看板加载失败"} description={error} action={<Button size="small" onClick={load} loading={loading}>重试</Button>} />}
    {!data ? loading && <div className="oo-panel oo-dashboard-loading"><Skeleton active paragraph={{ rows: 8 }} /></div> : <>
      <div className="oo-kpi-grid">
        <KpiCard label="调用次数" value={fmtCompact(t.calls)} unit="次" current={t.calls} previous={p.calls} spark={trend.map((d) => d.calls)} hint="全部使用记录；失败与停止请求已包含在内" />
        <KpiCard label="消费金额" value={fmtOd(t.units, perUnit, 4, false)} unit={<OdCoin size={16} />} current={t.units} previous={p.units} spark={trend.map((d) => d.units)} />
        <KpiCard label="活跃用户" value={fmtCompact(t.active_users)} unit="人" current={t.active_users} previous={p.active_users} hint={`全站区间新增 ${t.users_new ?? 0} 人 · 全站当前启用 ${t.users_total ?? 0} 人`} />
        <KpiCard label="请求失败率" value={err == null ? '—' : `${err.toFixed(2)}%`} hint={err == null ? '所选区间暂无请求样本' : `失败 ${fmtCompact(t.errors)} / 全部 ${fmtCompact(t.calls)} 次；含业务限制，不含主动停止`} tone={err != null && err >= 5 ? 'warning' : undefined} />
      </div>
      <section className="oo-panel oo-service-overview" aria-label="进程指标快照">
        <div><strong>服务状态快照</strong><small>进程启动后累计 · 点击刷新更新</small></div>
        <dl><div><dt>在途请求</dt><dd>{rt.inFlight ?? '—'}</dd></div><div><dt>SLA 可用性</dt><dd>{rate(rt.sla)}</dd></div><div><dt>上游错误率</dt><dd>{rate(rt.errorRate)}</dd></div><div><dt>P95 耗时</dt><dd>{rt.p95Ms == null ? '—' : `${(rt.p95Ms / 1000).toFixed(2)} s`}</dd></div></dl>
        <Link to="/admin/monitor">运维监控 <ArrowRightOutlined /></Link>
      </section>
      <div className="oo-chart-grid oo-dashboard-grid">
        <ChartCard className="oo-dashboard-main-chart" title="用量趋势" note={`近 ${days} 天 · 每日汇总`} extra={<Segmented size="small" value={metric} onChange={setMetric} options={[{ value: 'calls', label: '调用' }, { value: 'units', label: '消费' }]} />}><LineChart series={t.calls ? series : []} height={260} /></ChartCard>
        <ChartCard title="模型消费排行" note={`区间 ${t.models ?? 0} 个模型 · 展示前 8 项`}><RankBar items={rankItems(data.top_models, 'model')} format={money} /></ChartCard>
        <ChartCard title="Token 趋势" note={`总量 ${fmtCompact(t.total_tokens)} · 缓存命中率 ${t.cache_rate ?? 0}%`} extra={<Legend series={tokenSeries} />}><LineChart series={t.total_tokens ? tokenSeries : []} height={210} /></ChartCard>
        <ChartCard title="模型调用分布" note="按调用次数 · 包含归集的其他模型"><Donut items={(data.top_models || []).map((m) => ({ name: m.model, value: m.calls }))} centerLabel="次调用" /></ChartCard>
        <ChartCard title="模型失败分布" note="仅统计失败的使用记录"><RankBar items={(data.errors_by_model || []).map((m) => ({ name: m.model, value: m.errors }))} suffix=" 次" empty="所选区间没有失败记录" /></ChartCard>
        <ChartCard title="用户消费排行" note="前 10 名 · 点击查看使用记录"><RankBar limit={10} items={(data.top_users || []).map((u) => ({ key: u.user_id, name: <span className="oo-rank-user"><UserAvatar user={u} size={20} />{u.display_name || u.username}</span>, value: odOf(u.units, perUnit), sub: `${fmtCompact(u.calls)} 次`, onClick: () => navigate(`/log?keyword=${encodeURIComponent(u.username)}`) }))} format={money} /></ChartCard>
        <ChartCard title="令牌消费排行" note="按应用令牌汇总"><RankBar items={(data.top_tokens || []).map((r) => ({ name: r.name, value: odOf(r.units, perUnit), sub: `${r.owner ? `${r.owner} · ` : ''}${fmtCompact(r.calls)} 次` }))} format={money} /></ChartCard>
        <ChartCard title="区间概况" note="历史用量 · 跨进程重启保留"><dl className="oo-dashboard-facts"><div><dt>输入 Token</dt><dd>{fmtCompact(t.prompt_tokens)}</dd></div><div><dt>输出 Token</dt><dd>{fmtCompact(t.completion_tokens)}</dd></div><div><dt>缓存命中 Token</dt><dd>{fmtCompact(t.cache_tokens)}</dd></div><div><dt>平均请求耗时</dt><dd>{t.avg_elapsed > 0 ? `${(t.avg_elapsed / 1000).toFixed(2)} s` : '—'}</dd></div><div><dt>全站新增用户</dt><dd>{t.users_new ?? 0} 人</dd></div></dl></ChartCard>
      </div>
      <section className="oo-panel oo-dashboard-table"><div className="oo-panel-head"><div><span className="oo-panel-title">渠道表现</span><span className="oo-dashboard-caption">按消费列出前 12 个渠道 · 成功率 = 成功 / 全部调用</span></div><Link to="/admin/channel">管理渠道 <ArrowRightOutlined /></Link></div>
        <Table className="oo-table" rowKey="channel_id" size="small" pagination={false} scroll={{ x: 790 }} dataSource={data.by_channel || []} locale={{ emptyText: <Empty description="所选区间暂无渠道调用" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[
          { title: '渠道', dataIndex: 'name', render: (v, r) => <span className="oo-dashboard-channel"><VendorIcon type={r.type} size={24} /><span><b>{v}</b><small>#{r.channel_id}</small></span></span> },
          { title: '调用', dataIndex: 'calls', width: 95, align: 'right', sorter: (a, b) => a.calls - b.calls, render: fmtCompact },
          { title: '消费', dataIndex: 'units', width: 140, align: 'right', sorter: (a, b) => a.units - b.units, defaultSortOrder: 'descend', render: (v) => <OdAmount quota={v} perUnit={perUnit} digits={4} /> },
          { title: '成功率', dataIndex: 'success_rate', width: 110, align: 'right', render: (v) => <span style={{ color: v != null && v < 95 ? 'var(--orange)' : undefined }}>{rate(v)}</span> },
          { title: '失败', dataIndex: 'errors', width: 90, align: 'right', render: fmtCompact },
          { title: '平均耗时', dataIndex: 'avg_elapsed', width: 120, render: (v, r) => <DurationCell elapsedMs={v} firstTokenMs={r.avg_first_token} /> },
        ]} />
      </section>
    </>}
  </div>;
}
