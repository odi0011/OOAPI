import { Card as ArcPanel } from "../components/arc/card/card";
import React, { useCallback, useEffect, useState } from "react";
import {   Link, useNavigate } from "react-router-dom";
import { Alert, App as ArcApp, Button, Segmented, Skeleton, Tag  } from "../components/arc/index";
import { ArrowRightOutlined, CopyOutlined, KeyOutlined, ReloadOutlined  } from "../components/arc/icons";
import AdminDashboardPage from "./AdminDashboardPage";
import OdAmount from "../components/OdAmount";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import { DashboardOverview, DashboardPeriod, ModelUsageTable, RecentUsageTable } from "../components/DashboardUsage";
import { apiEndpoint, copyText, unitsPerOd } from "../services/format";
import { userDataVisibility } from "../services/visibility";
import "../dashboard.css";

const RANGES = [{ value: "7d", label: "7 天" }, { value: "30d", label: "30 天" }, { value: "90d", label: "90 天" }];

export default function ConsolePage() {
  const { user } = useApp();
  return Number(user?.role) >= 100 ? <AdminDashboardPage /> : <PersonalDashboard />;
}

function PersonalDashboard() {
  const navigate = useNavigate();
  const { message } = ArcApp.useApp();
  const { status, user } = useApp();
  const visibility = userDataVisibility(status, user);
  const { begin, isLatest } = useLatest();
  const [range, setRange] = useState("30d"), [data, setData] = useState(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [updatedAt, setUpdatedAt] = useState(null);
  const perUnit = unitsPerOd(status), endpoint = apiEndpoint(status?.api_endpoint);
  const load = useCallback(async () => {
    const request = begin(); setLoading(true); setError("");
    try { const next = await API.get("/dashboard/self", { params: { range } }); if (isLatest(request)) { setData(next); setUpdatedAt(new Date()); } }
    catch (e) { if (isLatest(request)) { setError(e.message); message.error(e.message); } }
    finally { if (isLatest(request)) setLoading(false); }
  }, [range, begin, isLatest, message]);
  useEffect(() => { load(); }, [load]);
  const copy = async () => { try { await copyText(endpoint); message.success("已复制 API 地址"); } catch { message.error("复制失败，请手动选择复制"); } };
  const account = data?.account || {};
  return <div className="oo-page oo-dashboard oo-usage-dashboard">
    <PageHeader title="数据看板" tags={visibility.usage_summary ? <Tag>个人用量</Tag> : undefined} extra={<>{visibility.usage_summary || visibility.usage_records ? <Segmented aria-label="看板时间范围" value={range} options={RANGES} onChange={setRange} /> : null}<Button icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="刷新个人看板" /></>} />
    {visibility.usage_summary || visibility.usage_records ? <DashboardPeriod data={data} loading={loading} error={error} updatedAt={updatedAt} fallbackDays={parseInt(range, 10)} /> : null}
    {error ? <Alert showIcon type="error" message={data ? "更新失败，当前保留上次成功的数据" : "看板加载失败"} description={error} action={<Button size="small" loading={loading} onClick={load}>重试</Button>} /> : null}
    {!data ? loading && <ArcPanel className="oo-panel oo-dashboard-loading"><Skeleton active paragraph={{ rows: 8 }} /></ArcPanel> : <>
      <ArcPanel className="oo-panel oo-account-overview" aria-label="账户概览">
        {visibility.balance ? <div className="oo-account-balance"><span>{account.quota < 0 ? "账户欠费" : "可用余额"}</span><strong className={account.quota < 0 ? "is-danger" : ""}><OdAmount quota={account.quota == null ? null : Math.abs(account.quota)} perUnit={perUnit} digits={4} size={17} /></strong></div> : null}
        {visibility.usage_summary ? <div><span>累计消费</span><b><OdAmount quota={account.used_quota} perUnit={perUnit} digits={4} /></b><span>账户历史累计</span></div> : null}
        <div><span>有效 API 令牌</span><b>{account.active_tokens ?? "—"}<small> / {account.total_tokens ?? "—"}</small></b></div>
        <div><span>账户默认分组</span><b>{account.group_name || "未绑定"}</b></div>
        <Button icon={<KeyOutlined />} onClick={() => navigate("/token")}>管理令牌</Button>
      </ArcPanel>
      {account.quota < 0 && visibility.balance ? <Alert showIcon type="warning" message="账户余额不足，补足欠费后恢复调用" /> : null}
      {visibility.usage_summary && data.totals ? <><DashboardOverview data={data} perUnit={perUnit} /><ModelUsageTable rows={data.by_model || []} totals={data.totals} perUnit={perUnit} /></> : <Alert type="info" showIcon message="管理员未开放用量汇总" />}
      {visibility.usage_records && Array.isArray(data.recent_logs) ? <RecentUsageTable rows={data.recent_logs} perUnit={perUnit} onMore={() => navigate("/log")} /> : null}
      <ArcPanel className="oo-panel oo-dashboard-connect"><div><b>连接你的应用</b><p>使用平台令牌和可用模型 ID 发起请求。</p></div><code>{endpoint}</code><Button icon={<CopyOutlined />} onClick={copy}>复制地址</Button><Link to="/#quickstart">接入指南 <ArrowRightOutlined /></Link></ArcPanel>
    </>}
  </div>;
}
