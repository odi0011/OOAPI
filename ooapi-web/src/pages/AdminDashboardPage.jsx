import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, App as AntApp, Button, Collapse, Empty, Segmented, Select, Skeleton, Table, Tabs, Tag } from "antd";
import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import UserAvatar from "../components/UserAvatar";
import OdAmount from "../components/OdAmount";
import { VendorIcon } from "../components/VendorIcon";
import { ChartCard, RankBar, fmtCompact } from "../components/Charts";
import { DurationCell } from "../components/UsageCells";
import { DashboardOverview, DashboardPeriod, ModelUsageTable, RecentUsageTable } from "../components/DashboardUsage";
import { unitsPerOd } from "../services/format";
import "../dashboard.css";

const RANGES = [{ value: "7d", label: "7 天" }, { value: "30d", label: "30 天" }, { value: "90d", label: "90 天" }];

export default function AdminDashboardPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { status } = useApp();
  const { begin, isLatest } = useLatest();
  const [userId, setUserId] = useState(null), [tokenId, setTokenId] = useState(null);
  const [filters, setFilters] = useState({ users: [], tokens: [] }), [filterLoading, setFilterLoading] = useState(true), [filterError, setFilterError] = useState("");
  const [range, setRange] = useState("30d"), [data, setData] = useState(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [updatedAt, setUpdatedAt] = useState(null);
  const [filterRevision, setFilterRevision] = useState(0);
  const perUnit = unitsPerOd(status);

  useEffect(() => {
    let active = true;
    setFilterLoading(true); setFilterError("");
    // 用户切换后旧密钥不能仍可选，否则下一次请求会发出不属于该用户的密钥。
    setFilters((previous) => ({ ...previous, tokens: [] }));
    API.get("/dashboard/filters", { params: { user_id: userId } }).then((next) => { if (active) setFilters(next); }).catch((e) => { if (active) { setFilterError(e.message); message.error(e.message); } }).finally(() => { if (active) setFilterLoading(false); });
    return () => { active = false; };
  }, [userId, filterRevision, message]);
  const load = useCallback(async () => {
    const request = begin(); setLoading(true); setError("");
    try {
      const next = await API.get("/dashboard/admin", { params: { range, user_id: userId, token_id: tokenId } });
      if (isLatest(request)) { setData(next); setUpdatedAt(new Date()); }
    } catch (e) { if (isLatest(request)) { setError(e.message); message.error(e.message); } }
    finally { if (isLatest(request)) setLoading(false); }
  }, [range, userId, tokenId, begin, isLatest, message]);
  useEffect(() => { load(); }, [load]);
  const totals = data?.totals || {};
  const money = (value) => <OdAmount quota={value} perUnit={perUnit} digits={4} />;
  // 保留旧数据时，范围标签也必须保留该响应的身份，不能冒充当前尚未成功的筛选。
  const scope = data?.scope;
  const shownUser = filters.users.find((item) => Number(item.id) === Number(scope?.user_id));
  const shownToken = filters.tokens.find((item) => Number(item.id) === Number(scope?.token_id));
  const scopeLabel = scope?.kind === "filtered" ? [scope.user_id ? shownUser?.display_name || shownUser?.username || `用户 #${scope.user_id}` : "", scope.token_id ? shownToken?.name || `密钥 #${scope.token_id}` : ""].filter(Boolean).join(" · ") : "全站用量";

  return <div className="oo-page oo-dashboard oo-usage-dashboard">
    <PageHeader title="数据看板" tags={<Tag>{scope ? scope.kind === "filtered" ? "筛选用量" : "全站用量" : userId || tokenId ? "筛选用量" : "全站用量"}</Tag>} extra={<><Link className="oo-dashboard-monitor-link" to="/admin/monitor">运维监控 <ArrowRightOutlined /></Link><Button icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="刷新数据看板" /></>} />
    <section className="oo-panel oo-dashboard-toolbar" aria-label="看板筛选">
      <label><span>用户</span><Select allowClear showSearch optionFilterProp="label" placeholder="全部用户" aria-label="筛选用户" value={userId} onChange={(value) => { setUserId(value); setTokenId(null); }} options={(filters.users || []).map((item) => ({ value: item.id, label: item.display_name || item.username }))} /></label>
      <label><span>密钥</span><Select allowClear showSearch loading={filterLoading} disabled={filterLoading || !!filterError} optionFilterProp="label" placeholder="全部密钥" aria-label="筛选密钥" value={tokenId} onChange={setTokenId} options={(filters.tokens || []).map((item) => ({ value: item.id, label: `${item.name} · ${item.owner}` }))} /></label>
      <div className="oo-dashboard-range"><span>时间范围</span><Segmented aria-label="看板时间范围" value={range} options={RANGES} onChange={setRange} /></div>
    </section>
    {filterError ? <Alert showIcon type="warning" message="筛选选项加载失败" description={filterError} action={<Button size="small" onClick={() => setFilterRevision((revision) => revision + 1)}>重试</Button>} /> : null}
    <DashboardPeriod data={data} loading={loading} error={error} updatedAt={updatedAt} fallbackDays={parseInt(range, 10)} scopeLabel={data ? scopeLabel : undefined} />
    {error ? <Alert showIcon type="error" message={data ? "更新失败，当前保留上次成功的数据" : "数据看板加载失败"} description={error} action={<Button size="small" onClick={load} loading={loading}>重试</Button>} /> : null}
    {!data ? loading && <div className="oo-panel oo-dashboard-loading"><Skeleton active paragraph={{ rows: 8 }} /></div> : <>
      <DashboardOverview data={data} perUnit={perUnit} admin />
      <div className="oo-dashboard-detail-grid">
        <ModelUsageTable rows={data.top_models || []} totals={totals} perUnit={perUnit} />
        <ChartCard title="渠道表现" className="oo-dashboard-channels" note="所选区间 · 成功率包含全部调用" extra={<Link to="/admin/channel">管理渠道 <ArrowRightOutlined /></Link>}>
          <Table className="oo-table" aria-label="渠道表现明细" rowKey="channel_id" size="small" pagination={(data.by_channel || []).length > 6 ? { pageSize: 6, size: "small", showSizeChanger: false } : false} scroll={{ x: 520 }} dataSource={data.by_channel || []} locale={{ emptyText: <Empty description="所选区间暂无渠道调用" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[
            { title: "渠道", dataIndex: "name", width: 145, render: (value, record) => <span className="oo-dashboard-channel"><VendorIcon type={record.type} size={19} /><span><b>{value}</b><small>#{record.channel_id}</small></span></span> },
            { title: "调用", dataIndex: "calls", width: 55, align: "right", sorter: (a, b) => a.calls - b.calls, render: fmtCompact },
            { title: "成功率", dataIndex: "success_rate", width: 80, align: "right", render: (value) => <span style={{ color: value != null && value < 95 ? "var(--orange)" : undefined }}>{value == null ? "—" : `${value}%`}</span> },
            { title: "首字 / 总耗时", width: 125, render: (_, record) => <DurationCell elapsedMs={record.avg_elapsed} firstTokenMs={record.avg_first_token} /> },
            { title: "消费", dataIndex: "units", width: 115, align: "right", sorter: (a, b) => a.units - b.units, defaultSortOrder: "descend", render: money },
          ]} />
        </ChartCard>
      </div>
      <RecentUsageTable rows={data.recent_logs || []} perUnit={perUnit} admin onMore={() => navigate("/log")} />
      <Collapse className="oo-dashboard-audience" items={[{ key: "audience", label: "用户与密钥分析", extra: <span className="oo-dashboard-caption">按区间消费排序</span>, children: <Tabs items={[
        { key: "users", label: "用户", children: <RankBar limit={10} total={totals.units} items={(data.top_users || []).map((item) => ({ key: item.user_id, name: <span className="oo-rank-user"><UserAvatar user={item} size={23} />{item.display_name || item.username}</span>, value: item.units, sub: `${fmtCompact(item.calls)} 次调用`, onClick: () => navigate(`/log?keyword=${encodeURIComponent(item.username)}`) }))} format={money} /> },
        { key: "tokens", label: "密钥", children: <RankBar limit={10} total={totals.units} items={(data.top_tokens || []).map((item) => ({ key: item.token_id, name: item.name, value: item.units, sub: `${item.owner ? `${item.owner} · ` : ""}${fmtCompact(item.calls)} 次调用` }))} format={money} /> },
      ]} /> }]} />
    </>}
  </div>;
}
