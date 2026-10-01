// 数据看板 · 管理端维度（/admin/dashboard）—— 第 80 批重构
// ---------------------------------------------------------------------------
// 与个人看板（/console）是**两个独立物理路由**：权限边界靠路由守卫而不是前端 if。
// 这里回答四个问题，页面也按这个顺序排：
//   ① 整体怎么样（KPI：调用 / 消费 / 活跃用户 / 错误率，均带环比）；
//   ② 趋势（调用左轴 + 消费右轴，双量纲不再互相压扁）；
//   ③ 钱花在哪、谁在用（模型成本、模型调用占比、用户与令牌排行）；
//   ④ 渠道是否健康（渠道表现表 + 按模型的错误分布）。
// 实时指标（进程内、重启清零）单独一行并明确标注，不和历史指标混排。
//
// 旧版不合理的地方（用户反馈「数据显示不合理、不符合常规」）：
//   · 调用次数与消费画在同一根 Y 轴 → 消费线贴底；
//   · 按 UTC 切天却标「UTC+8」→ 每天 0~8 点算进前一天（后端已修）；
//   · 没有环比，数字无法判断涨跌；
//   · 「令牌用量」显示原始额度单位 + 「令牌 #184」，看不出是谁的 Key；
//   · 「社区与娱乐概况」—— 娱乐（小游戏）早已下线。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Segmented, Tag, Empty, App as AntApp, Tooltip, Alert, Table, Skeleton } from "antd";
import { ReloadOutlined, ClockCircleOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import UserAvatar from "../components/UserAvatar";
import { LineChart, RankBar, Legend, Donut, KpiCard, ChartCard, SERIES_COLORS, fmtCompact } from "../components/Charts";
import { DurationCell } from "../components/UsageCells";
import { OdCoin } from "../components/OdCoin";
import { odOf, unitsPerOd, CURRENCY_NAME } from "../services/format";

const RANGES = [
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "90d", label: "90 天" },
];

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

const rateColor = (v) => (v == null ? "var(--ink-3)" : v >= 99 ? "var(--green)" : v >= 95 ? "var(--orange)" : "var(--red)");

export default function AdminDashboardPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { status } = useApp();
  const { begin, isLatest } = useLatest();
  const perUnit = unitsPerOd(status);
  const od = useCallback((u) => odOf(u, perUnit), [perUnit]);
  const fmtOdVal = (v) => `${fmtCompact(v)} ${CURRENCY_NAME}`;

  const [range, setRange] = useState("30d");
  const [data, setData] = useState(null);
  const [community, setCommunity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const [d, c] = await Promise.all([
        API.get("/dashboard/admin", { params: { range } }),
        API.get("/dashboard/community", { params: { range } }).catch(() => null),
      ]);
      if (!isLatest(token)) return;
      setData(d);
      setCommunity(c);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "看板加载失败");
        message.error(e.message);
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [begin, isLatest, message, range]);

  useEffect(() => {
    load();
  }, [load]);

  const t = data?.totals || {};
  const p = data?.previous || {};
  const trend = data?.trend || [];
  const rt = data?.realtime || {};
  const days = data?.range?.days || 30;
  const errRate = (calls, errors) => (calls + errors > 0 ? (errors / (calls + errors)) * 100 : 0);

  const series = useMemo(
    () => [
      { name: "调用次数", color: SERIES_COLORS[0], format: (v) => `${fmtCompact(v)} 次`, values: trend.map((d) => ({ x: d.day, y: d.calls })) },
      { name: `消费（${CURRENCY_NAME}）`, color: SERIES_COLORS[2], axis: "right", format: (v) => `${fmtCompact(v)} ${CURRENCY_NAME}`, values: trend.map((d) => ({ x: d.day, y: od(d.units) })) },
    ],
    [trend, od]
  );
  const tokenSeries = useMemo(
    () => [
      { name: "输入", color: SERIES_COLORS[0], values: trend.map((d) => ({ x: d.day, y: d.prompt_tokens })) },
      { name: "输出", color: SERIES_COLORS[1], values: trend.map((d) => ({ x: d.day, y: d.completion_tokens })) },
      { name: "缓存命中", color: SERIES_COLORS[3], area: false, values: trend.map((d) => ({ x: d.day, y: d.cache_tokens })) },
    ],
    [trend]
  );
  const sparkCalls = trend.map((d) => d.calls);
  const sparkUnits = trend.map((d) => d.units);

  const showSkeleton = loading && !data;

  return (
    <div className="oo-page">
      <PageHeader
        title="平台数据看板"
        tags={
          <>
            <Tooltip title="按天聚合、时段统计都以北京时间为准">
              <Tag icon={<ClockCircleOutlined />}>北京时间</Tag>
            </Tooltip>
            <Tag>近 {days} 天 · 对比前 {days} 天</Tag>
          </>
        }
        extra={
          <>
            <Segmented value={range} onChange={setRange} options={RANGES} />
            <Tooltip title="刷新"><Button icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="刷新看板" /></Tooltip>
          </>
        }
      />

      {loadError ? (
        <Alert type="error" showIcon message="看板数据加载失败" description={loadError} action={<Button size="small" onClick={load} loading={loading}>重试</Button>} />
      ) : null}

      {showSkeleton ? (
        <div className="oo-kpi-grid">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="oo-kpi"><Skeleton active paragraph={{ rows: 1 }} /></div>)}</div>
      ) : (
        <div className="oo-kpi-grid">
          <KpiCard label="调用次数" value={fmtCompact(t.calls || 0)} unit="次" current={t.calls} previous={p.calls} spark={sparkCalls} />
          <KpiCard label="消费总额" value={fmtCompact(od(t.units))} unit={<OdCoin size={13} />} current={t.units} previous={p.units} spark={sparkUnits} />
          <KpiCard
            label="Token 吞吐"
            value={fmtCompact(t.total_tokens || ((t.prompt_tokens || 0) + (t.completion_tokens || 0)))}
            unit="Tokens"
            current={t.total_tokens}
            previous={p.tokens}
            hint={`输入 ${fmtCompact(t.prompt_tokens || 0)} · 输出 ${fmtCompact(t.completion_tokens || 0)} · 缓存命中率 ${t.cache_rate ?? 0}%`}
          />
          <KpiCard label="活跃用户" value={t.active_users ?? 0} unit="人" current={t.active_users} previous={p.active_users} hint={`新增 ${t.users_new ?? 0} 人 · 启用 ${t.users_total ?? 0} 人`} />
          <KpiCard
            label="请求错误率"
            value={errRate(t.calls || 0, t.errors || 0).toFixed(2)}
            unit="%"
            current={errRate(t.calls || 0, t.errors || 0)}
            previous={p.calls || p.errors ? errRate(p.calls || 0, p.errors || 0) : null}
            inverse
            tone={errRate(t.calls || 0, t.errors || 0) >= 5 ? "danger" : undefined}
            hint={`区间错误 ${fmtCompact(t.errors || 0)} 次（含余额不足等业务限制）`}
          />
          <KpiCard
            label="平均响应耗时"
            value={t.avg_elapsed > 0 ? (t.avg_elapsed >= 1000 ? (t.avg_elapsed / 1000).toFixed(2) : t.avg_elapsed) : "—"}
            unit={t.avg_elapsed >= 1000 ? "s" : "ms"}
            hint="全站历史请求平均耗时"
          />
        </div>
      )}

      {/* 实时指标：平台实时运维监控大屏条 */}
      <div className="oo-panel" style={{ margin: "12px 0 16px", padding: "10px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)", display: "flex", alignItems: "center", gap: 4 }}>
              <ThunderboltOutlined /> 实时流量大屏
            </span>
            <span className="bui-chip">在途并发 <b>{rt.inFlight ?? 0}</b></span>
            <span className="bui-chip">
              可用性 SLA <b style={{ color: rateColor(rt.sla) }}>{rt.sla == null ? "—" : `${rt.sla}%`}</b>
            </span>
            <span className="bui-chip">
              上游错误率 <b style={{ color: rt.errorRate >= 5 ? "var(--red)" : undefined }}>{rt.errorRate == null ? "—" : `${rt.errorRate}%`}</b>
            </span>
            <span className="bui-chip">P95 延迟 <b>{rt.p95Ms == null ? "—" : `${(rt.p95Ms / 1000).toFixed(2)}s`}</b></span>
            {rt.uptimeSec ? (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                进程已运行 {fmtDuration(rt.uptimeSec)}
              </span>
            ) : null}
          </div>
          <Button size="small" type="primary" ghost onClick={() => navigate("/admin/monitor")}>
            运维监控大屏 →
          </Button>
        </div>
      </div>

      <div className="oo-chart-grid">
        <ChartCard title="调用与消费趋势" note="左轴：调用次数 · 右轴：消费" full extra={<Legend series={series} />}>
          {trend.length ? <LineChart series={series} height={240} /> : <Empty description="该时间范围内没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        </ChartCard>

        <ChartCard title="模型成本排行" note={`按消费 · Top 8 / 共 ${t.models ?? 0} 个模型`}>
          <RankBar items={(data?.top_models || []).map((m) => ({ name: m.model, value: od(m.units), sub: `${fmtCompact(m.calls)} 次` }))} format={fmtOdVal} />
        </ChartCard>

        <ChartCard title="模型调用占比" note="按调用次数">
          <Donut items={(data?.top_models || []).map((m) => ({ name: m.model, value: m.calls }))} centerLabel="次调用" />
        </ChartCard>

        <ChartCard title="Token 结构" note={`缓存命中率 ${t.cache_rate ?? 0}%`} extra={<Legend series={tokenSeries} />}>
          {trend.length ? <LineChart series={tokenSeries} height={190} /> : <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        </ChartCard>

        <ChartCard title="用户消费排行" note="Top 10 · 点击查看该用户的使用记录">
          <RankBar
            limit={10}
            items={(data?.top_users || []).map((u) => ({
              name: (
                <span className="oo-rank-user">
                  <UserAvatar user={{ id: u.user_id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url }} size={18} />
                  {u.display_name || u.username}
                </span>
              ),
              key: u.user_id,
              value: od(u.units),
              sub: `${fmtCompact(u.calls)} 次`,
              onClick: () => navigate(`/log?keyword=${encodeURIComponent(u.username)}`),
            }))}
            nameKey="name"
            format={fmtOdVal}
          />
        </ChartCard>

        <ChartCard title="令牌消费排行" note="排查「某个 Key 在刷量」">
          <RankBar
            items={(data?.top_tokens || []).map((x) => ({ name: x.name, value: od(x.units), sub: `${x.owner ? `${x.owner} · ` : ""}${fmtCompact(x.calls)} 次` }))}
            format={fmtOdVal}
          />
        </ChartCard>

        <ChartCard title="渠道表现" note="成功率 = 成功 /（成功 + 错误日志），含业务限制，偏保守" full>
          <Table
            className="oo-table"
            size="small"
            rowKey="channel_id"
            pagination={false}
            scroll={{ x: 720 }}
            dataSource={data?.by_channel || []}
            locale={{ emptyText: <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            columns={[
              { title: "渠道", dataIndex: "name", render: (v, r) => <span className="oo-truncate" title={`#${r.channel_id} ${v}`}><span style={{ color: "var(--ink-3)" }}>#{r.channel_id}</span> {v}</span> },
              { title: "调用", dataIndex: "calls", width: 90, align: "right", sorter: (a, b) => a.calls - b.calls, render: (v) => <span className="oo-num">{fmtCompact(v)}</span> },
              { title: "消费", dataIndex: "units", width: 120, align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.units - b.units, render: (v) => <span className="oo-num">{fmtOdVal(od(v))}</span> },
              {
                title: "成功率",
                dataIndex: "success_rate",
                width: 170,
                sorter: (a, b) => (a.success_rate ?? 0) - (b.success_rate ?? 0),
                render: (v) =>
                  v == null ? (
                    <span style={{ color: "var(--ink-3)" }}>—</span>
                  ) : (
                    <span className="oo-rate-cell">
                      <span className="oo-rate-bar"><span style={{ width: `${v}%`, background: rateColor(v) }} /></span>
                      <span className="oo-num" style={{ color: rateColor(v) }}>{v}%</span>
                    </span>
                  ),
              },
              { title: "错误", dataIndex: "errors", width: 80, align: "right", sorter: (a, b) => a.errors - b.errors, render: (v) => <span className="oo-num" style={{ color: v ? "var(--red)" : "var(--ink-3)" }}>{v || 0}</span> },
              { title: "平均耗时", dataIndex: "avg_elapsed", width: 112, sorter: (a, b) => a.avg_elapsed - b.avg_elapsed, render: (v, r) => <DurationCell firstTokenMs={r.avg_first_token} elapsedMs={v} /> },
            ]}
          />
        </ChartCard>

        <ChartCard title="错误分布" note="按模型（错误日志）">
          <RankBar items={(data?.errors_by_model || []).map((e) => ({ name: e.model, value: e.errors }))} suffix=" 次" empty="区间内没有错误记录" />
        </ChartCard>

        {community?.site ? (
          <ChartCard title="社区概况" note={`近 ${days} 天新增 · 点击进入管理`}>
            <div className="oo-mini-stats">
              {[
                { label: "帖子", value: community.site.posts, sub: `+${community.site.posts_new ?? 0}`, to: "/admin/community" },
                { label: "评论", value: community.site.comments },
                { label: "会话", value: community.site.rooms, sub: `${fmtCompact(community.site.messages_new ?? 0)} 条新消息` },
                { label: "好友关系", value: community.site.friendships_total },
                { label: "待处理内容", value: community.site.hidden_posts, to: "/admin/community", warn: Boolean(community.site.hidden_posts) },
              ].map((x) => (
                <button key={x.label} type="button" className="oo-mini-stat" disabled={!x.to} onClick={() => x.to && navigate(x.to)}>
                  <b className={x.warn ? "is-warn" : ""}>{fmtCompact(x.value ?? 0)}</b>
                  <span>{x.label}</span>
                  {x.sub ? <em>{x.sub}</em> : null}
                </button>
              ))}
            </div>
          </ChartCard>
        ) : null}
      </div>
    </div>
  );
}
