import { useEffect, useMemo, useState } from "react";
import { LayoutDashboard, RefreshCw } from "lucide-react";

import { ActivityHeatmap } from "@/components/arc/activity-heatmap/activity-heatmap";
import { Avatar } from "@/components/arc/avatar/avatar";
import Badge from "@/components/arc/badge/badge";
import { DonutChart } from "@/components/arc/donut-chart/donut-chart";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { LineChart } from "@/components/arc/line-chart/line-chart";
import { Ridgeline } from "@/components/arc/ridgeline/ridgeline";
import { SortableDataTable, type DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import AdminLayout from "@/components/admin/AdminLayout";
import CurrencyIcon from "@/components/CurrencyIcon";
import { useCurrency } from "@/contexts/CurrencyContext";
import { delta, formatDelta, useStats } from "@/lib/stats";
import { vendorIconUrl, vendorOfModel } from "@/lib/vendorIcons";

import styles from "./AdminDashboard.module.css";

interface ModelRow extends Record<string, unknown> {
  model: string;
  vendor: string;
  requests: number;
  tokens: number;
  cost: number;
}

interface ChannelRow extends Record<string, unknown> {
  id: number;
  name: string;
  vendor: string;
  statusLabel: string;
  statusTone: "success" | "warning" | "danger";
  requests: number;
  success_rate: number;
  latency_ms: number;
  ttft_ms: number;
  cost: number;
}

interface RecentRow extends Record<string, unknown> {
  id: number;
  created_at: string;
  username: string;
  /** stats 接口可能带上头像；未提供时 Avatar 回退到首字母。 */
  avatar_url?: string;
  model: string;
  type: number;
  tokens: number;
  cost: number;
  first_token_ms: number;
  latency_ms: number;
}

const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat("zh-CN");

/** 一条事件该用什么色调，由它的类型决定。 */
function eventTone(type: number): "danger" | "info" {
  return type === 3 ? "danger" : "info";
}

/** 环比涨跌的色调：涨用成功色，跌用危险色。 */
function trendTone(value: number | null): "up" | "down" | undefined {
  if (value === null || value === 0) return undefined;
  return value > 0 ? "up" : "down";
}

/** 首字耗时的区间色调：5 秒内正常、5–15 秒偏慢、15 秒以上告警；0/未记录不着色。 */
function ttftTone(ms: number): "success" | "warning" | "danger" | undefined {
  if (!(ms > 0)) return undefined;
  if (ms < 5000) return "success";
  if (ms < 15000) return "warning";
  return "danger";
}

/** "2026-10-08 15:55:45" → "15:55:45"；最近的调用按时刻读更顺。 */
function clock(raw: string): string {
  return raw && raw.length >= 19 ? raw.slice(11, 19) : raw || "—";
}

/**
 * 数据看板。
 *
 * 数据全部来自 /api/admin/stats：有 log:view_all 权限的角色看到全站范围，
 * 其他登录用户看到的是「我自己的用量」—— 接口按权限自动收口，
 * 因此这个页面同时是超管看板与个人用量视图，不必维护两套。
 *
 * 版式对齐原项目：紧凑 KPI 条 → 摘要条 → 趋势 + 构成 → 模型/账号表 →
 * 最近调用 → 延迟分布 + 最近事件 → 用户与密钥分析。
 */
export default function AdminDashboard() {
  const currency = useCurrency();
  const { data, loading, error, reload } = useStats(30);
  const [refreshedAt, setRefreshedAt] = useState("");

  // 记录本次数据的时间点，让「这是什么时候的数字」有据可查。
  useEffect(() => {
    if (data) setRefreshedAt(data.generated.slice(11));
  }, [data]);

  const summary = data?.summary;
  const prev = data?.prev;
  const isGlobal = data?.scope === "global";

  /** 走势数据：一次映射供三张折线图复用。 */
  const trendData = useMemo(
    () =>
      (data?.trend ?? []).map((p) => ({
        key: p.date,
        label: p.date,
        axisLabel: p.date.endsWith("-01") || p.date.endsWith("01") || p.date.endsWith("15") ? p.date.slice(5) : undefined,
        values: {
          requests: p.requests,
          cost: p.cost,
          successRate: p.success_rate,
        },
      })),
    [data],
  );

  /** 延迟分布：用各账号的耗时采样喂给山脊图。 */
  const latencySeries = useMemo(
    () =>
      (data?.channels ?? [])
        .filter((c) => c.latency.length >= 4)
        .slice(0, 6)
        .map((c) => ({ id: String(c.id), label: c.name, values: c.latency })),
    [data],
  );

  /**
   * Token 用量构成：输入里已经含缓存命中，直接相加会重复计算，
   * 因此拆成「输入（未缓存）/ 缓存命中 / 输出」三段，合计等于总 token。
   */
  const tokenMix = useMemo(() => {
    const prompt = summary?.prompt_tokens ?? 0;
    const cached = summary?.cached_tokens ?? 0;
    const completion = summary?.completion_tokens ?? 0;
    return [
      { key: "fresh", label: "输入（未缓存）", value: Math.max(0, prompt - cached) },
      { key: "cached", label: "缓存命中", value: cached },
      { key: "output", label: "输出", value: completion },
    ].filter((item) => item.value > 0);
  }, [summary]);

  const requests = summary?.requests ?? 0;
  const failed = summary?.failed ?? 0;
  const okCount = Math.max(0, requests - failed);
  const okShare = requests > 0 ? (okCount / requests) * 100 : 0;

  const hasData = requests > 0;

  const columns: DataColumn<ModelRow>[] = [
    {
      key: "model",
      label: "模型",
      sortable: true,
      render: (_v, row) => {
        const icon = vendorIconUrl(row.vendor);
        return (
          <span className={styles.modelCell}>
            {icon && <img className={styles.vendorMark} src={icon} alt="" loading="lazy" />}
            <span className={styles.modelName}>{row.model}</span>
          </span>
        );
      },
    },
    { key: "requests", label: "调用", sortable: true, numeric: true, render: (_v, row) => plain.format(row.requests) },
    { key: "tokens", label: "Tokens", sortable: true, numeric: true, render: (_v, row) => compact.format(row.tokens) },
    {
      key: "cost",
      label: "消费",
      sortable: true,
      numeric: true,
      render: (_v, row) => (
        <span className={styles.costCell}>
          {money.format(row.cost)}
          <CurrencyIcon src={currency.icon} size="0.95em" />
        </span>
      ),
    },
  ];

  const modelRows: ModelRow[] = (data?.models ?? []).map((m) => ({
    model: m.model,
    vendor: vendorOfModel(m.model) ?? "",
    requests: m.requests,
    tokens: m.tokens,
    cost: m.cost,
  }));

  /** 账号表现：与账号健康度同一份数据，换成表格后可以和模型表并排比较。 */
  const channelRows: ChannelRow[] = (data?.channels ?? []).map((ch) => {
    const cooling = ch.cooldown_until !== "";
    const offline = ch.status !== 1;
    return {
      id: ch.id,
      name: ch.name,
      vendor: ch.vendor,
      statusLabel: offline ? "已禁用" : cooling ? "冷却中" : "正常",
      statusTone: offline ? "danger" : cooling ? "warning" : "success",
      requests: ch.requests,
      success_rate: ch.success_rate,
      latency_ms: Math.round(ch.avg_latency_ms),
      ttft_ms: ch.ttft_ms,
      cost: ch.cost,
    };
  });

  const channelColumns: DataColumn<ChannelRow>[] = [
    {
      key: "name",
      label: "账号",
      sortable: true,
      width: 175,
      render: (_v, row) => {
        const icon = vendorIconUrl(row.vendor);
        return (
          <span className={styles.channelCell}>
            {icon && <img className={styles.vendorMark} src={icon} alt="" loading="lazy" />}
            <span className={styles.channelText}>
              <strong title={row.name}>{row.name}</strong>
              <Badge size="sm" tone={row.statusTone}>{row.statusLabel}</Badge>
            </span>
          </span>
        );
      },
    },
    { key: "requests", label: "调用", sortable: true, numeric: true, width: 70, render: (_v, row) => plain.format(row.requests) },
    {
      key: "success_rate",
      label: "成功率",
      sortable: true,
      numeric: true,
      width: 82,
      render: (_v, row) =>
        row.requests > 0 ? (
          <span className={styles.rate} data-low={row.success_rate < 95 || undefined}>{row.success_rate}%</span>
        ) : (
          <span className={styles.muted}>—</span>
        ),
    },
    {
      key: "latency_ms",
      label: "首字·总耗时",
      sortable: true,
      width: 128,
      render: (_v, row) => (
        <span className={styles.latencyCell} title="总耗时为所选区间均值；首字取自该账号最近一次连通测试">
          <span>{row.latency_ms > 0 ? `${row.latency_ms} ms` : "无响应"}</span>
          <small data-tone={ttftTone(row.ttft_ms)}>首字 {row.ttft_ms > 0 ? `${row.ttft_ms} ms` : "—"}</small>
        </span>
      ),
    },
    {
      key: "cost",
      label: "消费",
      sortable: true,
      numeric: true,
      width: 118,
      render: (_v, row) => (
        <span className={styles.costCell}>
          {money.format(row.cost)}
          <CurrencyIcon src={currency.icon} size="0.95em" />
        </span>
      ),
    },
  ];

  const recentRows: RecentRow[] = (data?.recent ?? []).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    username: r.username || "已注销用户",
    avatar_url: (r as typeof r & { avatar_url?: string }).avatar_url ?? "",
    model: r.model || "—",
    type: r.type,
    tokens: r.prompt_tokens + r.completion_tokens,
    cost: r.cost,
    first_token_ms: r.first_token_ms,
    latency_ms: r.latency_ms,
  }));

  const recentColumns: DataColumn<RecentRow>[] = [
    {
      key: "created_at",
      label: "时间",
      sortable: true,
      width: 105,
      render: (_v, row) => (
        <span className={styles.num} title={row.created_at}>{clock(row.created_at)}</span>
      ),
    },
    ...(isGlobal
      ? [{
          key: "username",
          label: "用户",
          sortable: true,
          width: 168,
          render: (_v: unknown, row: RecentRow) => (
            <span className={styles.recentUser} title={row.username}>
              <Avatar name={row.username} src={row.avatar_url || undefined} size="sm" />
              <span className={styles.recentUserText}>{row.username}</span>
            </span>
          ),
        }]
      : []),
    {
      key: "model",
      label: "模型",
      sortable: true,
      width: 185,
      render: (_v, row) => <span className={styles.modelName} title={row.model}>{row.model}</span>,
    },
    {
      key: "type",
      label: "结果",
      sortable: false,
      width: 82,
      render: (_v, row) => (
        <Badge size="sm" tone={row.type === 2 ? "success" : row.type === 3 ? "danger" : "neutral"}>
          {row.type === 2 ? "成功" : row.type === 3 ? "失败" : "其他"}
        </Badge>
      ),
    },
    {
      key: "latency_ms",
      label: "首字·总耗时",
      sortable: true,
      width: 128,
      render: (_v, row) => (
        <span className={styles.latencyCell}>
          <span>{row.latency_ms > 0 ? `${row.latency_ms} ms` : "—"}</span>
          <small data-tone={ttftTone(row.first_token_ms)}>首字 {row.first_token_ms > 0 ? `${row.first_token_ms} ms` : "—"}</small>
        </span>
      ),
    },
    {
      key: "tokens",
      label: "Tokens",
      sortable: true,
      numeric: true,
      width: 95,
      render: (_v, row) => compact.format(row.tokens),
    },
    {
      key: "cost",
      label: "消费",
      sortable: true,
      numeric: true,
      width: 118,
      render: (_v, row) => (
        <span className={styles.costCell}>
          {money.format(row.cost)}
          <CurrencyIcon src={currency.icon} size="0.95em" />
        </span>
      ),
    },
  ];

  const timeRangeLabel = data && data.trend.length > 0
    ? `${data.trend[0].date.slice(5)} – ${data.trend[data.trend.length - 1].date.slice(5)}`
    : "近 30 天";

  const requestDelta = delta(requests, prev?.requests ?? 0);
  const costDelta = delta(summary?.cost ?? 0, prev?.cost ?? 0);
  const tokenTotal = (summary?.prompt_tokens ?? 0) + (summary?.completion_tokens ?? 0);
  const tokenDelta = delta(
    tokenTotal,
    (prev?.prompt_tokens ?? 0) + (prev?.completion_tokens ?? 0),
  );

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "数据看板" }]}>
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <div>
            <h1 className={styles.title}>数据看板</h1>
            <p className={styles.sub}>
              {isGlobal ? "全站范围" : "仅你个人的用量"} · 近 {data?.days ?? 30} 天
              {refreshedAt && ` · 更新于 ${refreshedAt}`}
            </p>
          </div>

          <button className={styles.refresh} type="button" onClick={() => void reload()} disabled={loading}>
            <RefreshCw size={13} strokeWidth={1.9} className={loading ? styles.spinning : undefined} />
            {loading ? "刷新中" : "刷新"}
          </button>
        </header>

        {error && <p className={styles.error}>{error}</p>}

        {loading && !data && <p className={styles.loading}>正在加载统计数据…</p>}

        {data && !hasData && (
          <section className={styles.emptyCard}>
            {/* 用组件库的 EmptyState，与其它页面的空态保持同一套视觉 ——
                自己写一套的结果是「同为没有数据」却长得不一样。 */}
            <EmptyState
              icon={<LayoutDashboard size={22} strokeWidth={1.6} />}
              title="还没有调用数据"
              description="创建一个密钥并把请求发到 /v1/chat/completions，这里就会显示请求量、消费、模型排行与账号表现。"
            />
          </section>
        )}

        {data && hasData && (
          <>
            {/* ========== a) 核心指标：4 个紧凑 chip 一排 ========== */}
            <section className={styles.kpiStrip} aria-label="核心指标">
              <article className={styles.kpi}>
                <span className={styles.kpiLabel}>请求总数</span>
                <span className={styles.kpiValue}>{plain.format(requests)}</span>
                <span className={styles.kpiFoot}>
                  <em className={styles.delta} data-tone={trendTone(requestDelta)}>{formatDelta(requestDelta)}</em>
                  较上一周期 {plain.format(prev?.requests ?? 0)}
                </span>
              </article>
              <article className={styles.kpi}>
                <span className={styles.kpiLabel}>消费总额</span>
                <span className={styles.kpiValue}>
                  {money.format(summary?.cost ?? 0)}
                  <CurrencyIcon src={currency.icon} size="1.05em" />
                </span>
                <span className={styles.kpiFoot}>
                  <em className={styles.delta} data-tone={trendTone(costDelta)}>{formatDelta(costDelta)}</em>
                  较上一周期 {money.format(prev?.cost ?? 0)}
                </span>
              </article>
              <article className={styles.kpi}>
                <span className={styles.kpiLabel}>Token 用量</span>
                <span className={styles.kpiValue}>{compact.format(tokenTotal)}</span>
                <span className={styles.kpiFoot}>
                  <em className={styles.delta} data-tone={trendTone(tokenDelta)}>{formatDelta(tokenDelta)}</em>
                  输入 {compact.format(summary?.prompt_tokens ?? 0)} · 输出 {compact.format(summary?.completion_tokens ?? 0)}
                </span>
              </article>
              <article className={styles.kpi}>
                <span className={styles.kpiLabel}>成功率</span>
                <span className={styles.kpiValue}>{(summary?.success_rate ?? 0).toFixed(1)}%</span>
                <span className={styles.kpiFoot}>
                  成功 {plain.format(okCount)} · 失败 {plain.format(failed)} 次
                </span>
              </article>
            </section>

            {/* ========== b) 摘要条：活跃用户 / 模型数 / 首字 / 总耗时 / 缓存命中 ========== */}
            <section className={styles.summaryStrip} aria-label="区间摘要">
              {isGlobal && (
                <span className={styles.summaryItem}>
                  活跃用户 <b>{plain.format(data.active_users ?? 0)}</b>
                  <small>人</small>
                </span>
              )}
              <span className={styles.summaryItem}>
                使用模型数 <b>{plain.format(data.models.length)}</b>
                <small>个</small>
              </span>
              <span className={styles.summaryItem}>
                平均首字 <b>{Math.round(summary?.avg_first_token_ms ?? 0)}</b>
                <small>ms</small>
              </span>
              <span className={styles.summaryItem}>
                平均总耗时 <b>{Math.round(summary?.avg_latency_ms ?? 0)}</b>
                <small>ms</small>
              </span>
              <span className={styles.summaryItem}>
                缓存命中率 <b>{(data.cache_rate ?? 0).toFixed(1)}</b>
                <small>%（{compact.format(summary?.cached_tokens ?? 0)} 缓存 token）</small>
              </span>
            </section>

            {/* 年度活跃热力图：天然很宽，单独占一整行 */}
            <section className={styles.card}>
              <ActivityHeatmap
                days={data.activity}
                label="每日调用次数"
                period="近一年"
                unit={{ one: "次调用", other: "次调用" }}
                locale="zh-CN"
              />
            </section>

            {/* ========== c) 用量趋势（2fr） + 用量构成（1fr） ========== */}
            <div className={styles.primaryGrid}>
              <section className={styles.card}>
                <Tabs defaultValue="requests">
                  <div className={styles.cardHead}>
                    <div>
                      <h2 className={styles.cardTitle}>用量趋势</h2>
                      <span className={styles.cardNote}>{timeRangeLabel}</span>
                    </div>
                    <TabsList>
                      <TabsTrigger value="requests">请求量</TabsTrigger>
                      <TabsTrigger value="cost">消费额</TabsTrigger>
                      <TabsTrigger value="success">成功率</TabsTrigger>
                    </TabsList>
                  </div>

                  <TabsContent value="requests">
                    <LineChart
                      label="每日请求量"
                      data={trendData}
                      series={[{ key: "requests", label: "请求数", area: true }]}
                      height={200}
                      curve="smooth"
                      unit="次"
                      formatValue={(v) => `${plain.format(v)} 次`}
                      formatTick={(v) => compact.format(v)}
                    />
                  </TabsContent>

                  <TabsContent value="cost">
                    <LineChart
                      label="每日消费额"
                      data={trendData}
                      series={[{ key: "cost", label: "消费额", area: true }]}
                      height={200}
                      curve="smooth"
                      formatValue={(v) => money.format(v)}
                      formatTick={(v) => `${Math.round(v)}`}
                    />
                  </TabsContent>

                  <TabsContent value="success">
                    <LineChart
                      label="每日调用成功率"
                      data={trendData}
                      series={[{ key: "successRate", label: "成功率", area: true }]}
                      height={200}
                      curve="smooth"
                      unit="%"
                      formatValue={(v) => `${v.toFixed(2)}%`}
                      formatTick={(v) => `${v.toFixed(0)}%`}
                    />
                  </TabsContent>
                </Tabs>
              </section>

              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>用量构成</h2>
                    <span className={styles.cardNote}>Token 拆分与请求结果</span>
                  </div>
                </div>

                {tokenMix.length > 0 ? (
                  <DonutChart
                    label="Token 用量构成"
                    data={tokenMix}
                    unit="Token"
                    totalLabel="合计"
                    size={170}
                    thickness={20}
                    legendAction="select"
                    formatValue={(v) => compact.format(v)}
                  />
                ) : (
                  <p className={styles.cardEmpty}>窗口内没有 Token 用量</p>
                )}

                <div className={styles.breakdown}>
                  <div className={styles.breakdownHead}>
                    <span>请求结果</span>
                    <span>{plain.format(requests)} 次</span>
                  </div>
                  <div className={styles.track} aria-hidden="true">
                    <span data-tone="ok" style={{ width: `${okShare}%` }} />
                    <span data-tone="fail" style={{ width: `${100 - okShare}%` }} />
                  </div>
                  <dl className={styles.breakdownList}>
                    <div>
                      <dt><i data-tone="ok" />成功</dt>
                      <dd>{plain.format(okCount)}<small>{okShare.toFixed(1)}%</small></dd>
                    </div>
                    <div>
                      <dt><i data-tone="fail" />失败</dt>
                      <dd>{plain.format(failed)}<small>{(100 - okShare).toFixed(1)}%</small></dd>
                    </div>
                  </dl>
                </div>
              </section>
            </div>

            {/* ========== d) 模型用量 | 账号表现 ========== */}
            <div className={styles.tableGrid}>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>模型用量</h2>
                    <span className={styles.cardNote}>按消费额排序</span>
                  </div>
                </div>
                <SortableDataTable<ModelRow>
                  caption="模型调用排行"
                  columns={columns}
                  rows={modelRows}
                  rowKey="model"
                  defaultSort={{ key: "cost", direction: "desc" }}
                  emptyMessage="窗口内没有模型调用"
                  itemName={{ one: "个模型", other: "个模型" }}
                />
              </section>

              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>账号表现</h2>
                    <span className={styles.cardNote}>成功率含全部调用；总耗时为区间均值</span>
                  </div>
                </div>
                <SortableDataTable<ChannelRow>
                  caption="账号表现明细"
                  columns={channelColumns}
                  rows={channelRows}
                  rowKey="id"
                  defaultSort={{ key: "cost", direction: "desc" }}
                  emptyMessage="还没有配置账号"
                  itemName={{ one: "个账号", other: "个账号" }}
                />
              </section>
            </div>

            {/* ========== e) 最近调用：全宽 ========== */}
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  <h2 className={styles.cardTitle}>最近调用</h2>
                  <span className={styles.cardNote}>最新 {recentRows.length} 条（成功与失败都算）</span>
                </div>
              </div>
              <SortableDataTable<RecentRow>
                caption="最近调用记录"
                columns={recentColumns}
                rows={recentRows}
                rowKey="id"
                emptyMessage="窗口内还没有调用记录"
                itemName={{ one: "条调用", other: "条调用" }}
              />
            </section>

            {/* ========== f) 响应延迟分布 | 最近事件 ========== */}
            <div className={styles.rowHalf}>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>响应延迟分布</h2>
                    <span className={styles.cardNote}>各账号最近调用的耗时采样</span>
                  </div>
                </div>
                {latencySeries.length > 0 ? (
                  <Ridgeline series={latencySeries} label="各账号响应延迟分布" unit="ms" tint />
                ) : (
                  <p className={styles.cardEmpty}>样本不足，多调用几次后可见分布</p>
                )}
              </section>

              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>最近事件</h2>
                    <span className={styles.cardNote}>失败的调用与系统提示</span>
                  </div>
                </div>

                {data.events.length > 0 ? (
                  <ol className={styles.timeline}>
                    {data.events.map((e, index) => (
                      <li key={index} className={styles.event}>
                        <span className={styles.eventDot} data-tone={eventTone(e.type)} aria-hidden="true" />
                        <div className={styles.eventBody}>
                          <div className={styles.eventHead}>
                            <strong>{e.title}</strong>
                            <time>{e.time}</time>
                          </div>
                          <p>{e.detail || "无附加信息"}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className={styles.cardEmpty}>最近的调用都成功了，没有需要关注的事件</p>
                )}
              </section>
            </div>

            {/* ========== g) 用户与密钥分析：两个排行标签页 ========== */}
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  <h2 className={styles.cardTitle}>用户与密钥分析</h2>
                  <span className={styles.cardNote}>按所选区间消费排序，最多各 10 条</span>
                </div>
              </div>

              <Tabs defaultValue="users">
                <TabsList>
                  <TabsTrigger value="users">用户 TOP</TabsTrigger>
                  <TabsTrigger value="tokens">密钥 TOP</TabsTrigger>
                </TabsList>

                <TabsContent value="users">
                  {data.top_users.length > 0 ? (
                    <ol className={styles.rankList}>
                      {data.top_users.map((u, index) => {
                        const max = data.top_users[0]?.cost || 1;
                        return (
                          <li key={u.user_id} className={styles.rankItem}>
                            <span className={styles.rankIndex}>{index + 1}</span>
                            <span className={styles.rankUser}>
                              <Avatar
                                name={u.display_name || u.username}
                                src={(u as typeof u & { avatar_url?: string }).avatar_url || undefined}
                                size="sm"
                              />
                              <span className={styles.rankName}>
                                {u.display_name || u.username}
                                {u.display_name && <small>@{u.username}</small>}
                              </span>
                            </span>
                            <span className={styles.rankBar} aria-hidden="true">
                              <span style={{ width: `${Math.max(2, (u.cost / max) * 100)}%` }} />
                            </span>
                            <span className={styles.rankMetrics}>{plain.format(u.requests)} 次</span>
                            <span className={styles.rankCost}>
                              {money.format(u.cost)}
                              <CurrencyIcon src={currency.icon} size="0.9em" />
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className={styles.cardEmpty}>该区间内没有用户调用记录</p>
                  )}
                </TabsContent>

                <TabsContent value="tokens">
                  {(data.top_tokens ?? []).length > 0 ? (
                    <ol className={styles.rankList}>
                      {(data.top_tokens ?? []).map((t, index) => {
                        const max = data.top_tokens[0]?.cost || 1;
                        return (
                          <li key={t.token_id} className={styles.rankItem}>
                            <span className={styles.rankIndex}>{index + 1}</span>
                            <span className={styles.rankName}>
                              {t.name || `密钥 #${t.token_id}`}
                              {t.owner && <small>@{t.owner}</small>}
                            </span>
                            <span className={styles.rankBar} aria-hidden="true">
                              <span style={{ width: `${Math.max(2, (t.cost / max) * 100)}%` }} />
                            </span>
                            <span className={styles.rankMetrics}>{plain.format(t.requests)} 次</span>
                            <span className={styles.rankCost}>
                              {money.format(t.cost)}
                              <CurrencyIcon src={currency.icon} size="0.9em" />
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className={styles.cardEmpty}>
                      {isGlobal ? "该区间内没有密钥调用记录" : "密钥排行仅在全站视角下展示"}
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </section>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
