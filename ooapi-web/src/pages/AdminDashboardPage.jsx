// 数据看板 · 管理端维度（/admin/dashboard）
// ---------------------------------------------------------------------------
// 与个人看板（/console）是**两个独立物理路由**，原因见 ConsolePage 顶部注释：
// 权限边界靠路由守卫而不是前端 if；关注点也完全不同 ——
// 这里回答的是「渠道是否变慢 / 全站吞吐 / 谁在刷 / 成本花在哪」。
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Segmented, Tag, Empty, Skeleton, App as AntApp, Tooltip, Alert, Table } from "antd";
import {
  ReloadOutlined, ClockCircleOutlined, DashboardOutlined, WarningOutlined, ReloadOutlined as R2,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import UserAvatar from "../components/UserAvatar";
import { LineChart, BarChart, RankBar, Legend, Sparkline, SERIES_COLORS, fmtCompact } from "../components/Charts";
import { fmtOd, unitsPerOd, CURRENCY_NAME } from "../services/format";

const RANGES = [
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "90d", label: "近 90 天" },
];

/** 图表卡：full = 跨满整行（主趋势图用）。
 *  不要写死 span=2 —— 网格列数自适应，写死会留下尴尬空位。 */
function ChartCard({ title, note, children, full }) {
  return (
    <div className="oo-chart-card" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <div className="oo-chart-card-head">
        <span className="oo-chart-card-title">{title}</span>
        {note ? <span className="oo-chart-card-note">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}天 ${h}小时`;
  if (h) return `${h}小时 ${m}分`;
  return `${m}分`;
}

export default function AdminDashboardPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { status } = useApp();
  const { begin, isLatest } = useLatest();
  const perUnit = unitsPerOd(status);

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

  const t = data?.totals;
  const trend = data?.trend || [];
  const rt = data?.realtime || {};

  return (
    <div className="oo-page">
      <PageHeader
        title="平台数据看板"
        tags={
          <>
            <Tag icon={<DashboardOutlined />}>全站维度</Tag>
            <Tooltip title="按天聚合的时区基准（与服务器一致）">
              <Tag icon={<ClockCircleOutlined />}>时区 UTC+8</Tag>
            </Tooltip>
            {rt.uptimeSec ? <Tag>本进程已运行 {fmtDuration(rt.uptimeSec)}</Tag> : null}
          </>
        }
        extra={
          <>
            <Segmented value={range} onChange={setRange} options={RANGES} />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={load} title="刷新" aria-label="刷新看板" />
          </>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="看板数据加载失败"
          description={loadError}
          action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
        />
      ) : null}

      {/* 实时指标与历史指标**分开标注**：进程内指标重启清零，历史指标来自 logs 表。
          混在一起会让用户误以为「今天的数字」包含历史累计。 */}
      <div className="oo-stats-cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))" }}>
        <StatCard
          label="全站调用"
          value={loading ? "—" : fmtCompact(t?.calls || 0)}
          suffix="次"
          hint={`近 ${data?.range?.days || 30} 天（历史，来自日志表）`}
        />
        <StatCard
          label="全站消费"
          value={loading ? "—" : fmtOd(t?.units || 0, perUnit, 2, false)}
          suffix={CURRENCY_NAME}
          hint="近区间累计（历史）"
        />
        <StatCard label="活跃用户" value={loading ? "—" : t?.active_users ?? 0} suffix="人" hint="区间内有调用的用户数" />
        <StatCard
          label="新增用户"
          value={loading ? "—" : t?.users_new ?? 0}
          suffix="人"
          hint={`全站启用用户 ${t?.users_total ?? 0} 人`}
        />
        <StatCard label="在途请求" value={loading ? "—" : rt.inFlight ?? 0} suffix="个" hint="实时（进程内，重启清零）" />
        <StatCard
          label="SLA"
          value={loading ? "—" : rt.sla == null ? "—" : `${rt.sla}%`}
          tone={rt.sla != null && rt.sla < 99 ? "warning" : rt.sla != null ? "success" : undefined}
          hint="实时口径：成功 /（总数 - 业务限制），不含本地限流与余额不足"
        />
        <StatCard
          label="错误率"
          value={loading ? "—" : rt.errorRate == null ? "—" : `${rt.errorRate}%`}
          tone={rt.errorRate >= 5 ? "danger" : rt.errorRate > 0 ? "warning" : "success"}
          hint="实时（仅上游真实错误，不含业务限制与 429/529）"
        />
      </div>

      <div className="oo-chart-grid">
        <ChartCard title="全站趋势" note={`近 ${data?.range?.days || 30} 天`} full>
          {trend.length ? (
            <>
              <LineChart
                height={168}
                series={[
                  { name: "调用次数", values: trend.map((d) => ({ x: d.day, y: d.calls })), color: SERIES_COLORS[0] },
                  { name: `消费 (${CURRENCY_NAME})`, values: trend.map((d) => ({ x: d.day, y: Number((d.units / perUnit).toFixed(2)) })), color: SERIES_COLORS[2] },
                ]}
              />
              <Legend
                series={[
                  { name: "调用次数", color: SERIES_COLORS[0] },
                  { name: `消费 (${CURRENCY_NAME})`, color: SERIES_COLORS[2] },
                ]}
              />
            </>
          ) : (
            <Empty description="该时间范围内没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </ChartCard>

        <ChartCard title="Token 结构" note="输入 / 输出 / 缓存">
          {trend.length ? (
            <>
              <LineChart
                height={132}
                series={[
                  { name: "输入", values: trend.map((d) => ({ x: d.day, y: d.prompt_tokens })), color: SERIES_COLORS[0] },
                  { name: "输出", values: trend.map((d) => ({ x: d.day, y: d.completion_tokens })), color: SERIES_COLORS[1] },
                  { name: "缓存", values: trend.map((d) => ({ x: d.day, y: d.cache_tokens })), color: SERIES_COLORS[5] },
                ]}
              />
              <Legend
                series={[
                  { name: "输入", color: SERIES_COLORS[0] },
                  { name: "输出", color: SERIES_COLORS[1] },
                  { name: "缓存", color: SERIES_COLORS[5] },
                ]}
              />
            </>
          ) : (
            <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </ChartCard>

        <ChartCard title="模型成本排行" note="按消费额度">
          <RankBar items={(data?.top_models || []).map((m) => ({ name: m.model, value: Number((m.units / perUnit).toFixed(2)) }))} suffix={` ${CURRENCY_NAME}`} />
        </ChartCard>

        <ChartCard title="模型调用排行" note="按次数">
          <RankBar items={(data?.top_models || []).map((m) => ({ name: m.model, value: m.calls }))} suffix=" 次" />
        </ChartCard>

        <ChartCard title="用户消费排行" note="Top 10">
          <div>
            {(data?.top_users || []).map((u, i) => (
              <div key={u.user_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12.5 }}>
                <span className="oo-num" style={{ width: 16, color: i < 3 ? "var(--accent-ink)" : "var(--ink-3)" }}>{i + 1}</span>
                <UserAvatar user={{ id: u.user_id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url }} size={20} />
                <a onClick={() => navigate(`/media?user_id=${u.user_id}`)} className="oo-truncate" style={{ flex: 1, cursor: "pointer" }}>
                  {u.display_name || u.username}
                </a>
                <span className="oo-num" style={{ color: "var(--ink-3)" }}>{fmtCompact(u.calls)} 次</span>
                <span className="oo-num" style={{ fontWeight: 600 }}>{fmtOd(u.units, perUnit, 2)}</span>
              </div>
            ))}
            {!(data?.top_users || []).length ? <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
          </div>
        </ChartCard>

        <ChartCard title="渠道表现" note="成功率含业务限制（非 SLA 口径）">
          <Table
            className="oo-table"
            size="small"
            rowKey="channel_id"
            pagination={false}
            dataSource={data?.by_channel || []}
            locale={{ emptyText: <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            columns={[
              { title: "渠道", dataIndex: "name", minWidth: 140, render: (v, r) => <span className="oo-truncate" title={`#${r.channel_id} ${v}`}>{`#${r.channel_id} ${v}`}</span> },
              { title: "调用", dataIndex: "calls", width: 70, render: (v) => <span className="oo-num">{fmtCompact(v)}</span> },
              {
                title: "成功率",
                dataIndex: "success_rate",
                width: 76,
                render: (v) =>
                  v == null ? (
                    <span style={{ color: "var(--ink-3)" }}>—</span>
                  ) : (
                    <span className="oo-num" style={{ color: v >= 99 ? "var(--green)" : v >= 95 ? "var(--orange)" : "var(--red)" }}>
                      {v}%
                    </span>
                  ),
              },
              { title: "错误", dataIndex: "errors", width: 60, render: (v) => (v ? <span className="oo-num" style={{ color: "var(--red)" }}>{v}</span> : <span style={{ color: "var(--ink-3)" }}>0</span>) },
              { title: "平均耗时", dataIndex: "avg_elapsed", width: 84, render: (v) => <span className="oo-num">{v ? `${(v / 1000).toFixed(2)}s` : "—"}</span> },
            ]}
          />
        </ChartCard>

        <ChartCard title="错误分布" note="按模型（错误日志 type=4）">
          <RankBar items={(data?.errors_by_model || []).map((e) => ({ name: e.model, value: e.errors }))} suffix="" empty="区间内没有错误记录" />
        </ChartCard>

        {community?.site ? (
          <ChartCard title="社区与娱乐概况" note="点击进入对应管理页">
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", fontSize: 12.5 }}>
              {[
                { label: "帖子总数", value: community.site.posts, to: "/admin/community" },
                { label: `区间新增帖`, value: community.site.posts_new, to: "/admin/community" },
                { label: "评论总数", value: community.site.comments },
                { label: "会话数", value: community.site.rooms },
                { label: `区间消息`, value: community.site.messages_new },
                { label: "好友关系数", value: community.site.friendships_total },
                { label: "待处理内容", value: community.site.hidden_posts, to: "/admin/community", tone: community.site.hidden_posts ? "warning" : undefined },
              ].map((x) => (
                <span
                  key={x.label}
                  style={{ display: "inline-flex", gap: 5, alignItems: "baseline", cursor: x.to ? "pointer" : "default" }}
                  onClick={() => x.to && navigate(x.to)}
                >
                  <span style={{ color: "var(--ink-3)" }}>{x.label}</span>
                  <b className="oo-num" style={x.tone === "warning" ? { color: "var(--orange)" } : undefined}>{x.value ?? 0}</b>
                </span>
              ))}
            </div>
          </ChartCard>
        ) : null}

        <ChartCard title="令牌用量" note="排查「某个 Key 在刷量」">
          <RankBar items={(data?.top_tokens || []).map((x) => ({ name: `令牌 #${x.token_id}`, value: x.units }))} suffix="" />
        </ChartCard>
      </div>
    </div>
  );
}
