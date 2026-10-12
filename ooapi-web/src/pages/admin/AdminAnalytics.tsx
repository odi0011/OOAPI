import { useMemo, useState } from "react";
import { BarChart3, Coins, Hash, Timer, TrendingDown, TrendingUp } from "lucide-react";

import { BarChart } from "@/components/arc/bar-chart/bar-chart";
import { DonutChart } from "@/components/arc/donut-chart/donut-chart";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { LineChart } from "@/components/arc/line-chart/line-chart";
import { MetricCard } from "@/components/arc/metric-card/metric-card";
import { Ridgeline } from "@/components/arc/ridgeline/ridgeline";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { SortableDataTable, type DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";
import { Treemap } from "@/components/arc/treemap/treemap";
import AdminLayout from "@/components/admin/AdminLayout";
import CurrencyIcon from "@/components/CurrencyIcon";
import { useCurrency } from "@/contexts/CurrencyContext";
import { delta, formatDelta, useStats } from "@/lib/stats";
import { vendorIconUrl, vendorOfModel } from "@/lib/vendorIcons";

import styles from "./AdminAnalytics.module.css";

const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat("zh-CN");

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 模型排行表格的行。 */
interface ModelRow extends Record<string, unknown> {
  model: string;
  vendor: string;
  requests: number;
  tokens: number;
  cost: number;
}

/**
 * 消费分析。
 *
 * 与数据看板的区别：看板回答「现在怎么样」，
 * 这里回答「钱花在哪了、趋势往哪走」—— 因此以拆解与对比为主，
 * 不做健康度仪表盘。
 */
export default function AdminAnalytics() {
  const currency = useCurrency();
  const [days, setDays] = useState("30");
  const { data, loading, error } = useStats(Number(days));

  /** 走势图的数据形状与组件要求对齐。 */
  const trendData = useMemo(
    () =>
      (data?.trend ?? []).map((p) => ({
        key: p.date,
        label: p.date.slice(5),
        values: {
          requests: p.requests,
          cost: p.cost,
          successRate: p.success_rate,
          tokens: p.tokens,
          latency: p.avg_latency_ms,
        },
      })),
    [data],
  );

  /**
   * 消费树图：按模型拆。
   * Treemap 的 color 表达环比，这里用「该模型消费占总额的比例」
   * 会让所有块都是正数、看不出差异，因此改用「与平均线的偏离度」。
   */
  const costTreemap = useMemo(() => {
    const models = data?.models ?? [];
    if (!models.length) return { id: "all", label: "全部消费", children: [] };
    const total = models.reduce((sum, m) => sum + m.cost, 0);
    const avg = total / models.length;
    return {
      id: "all",
      label: "全部消费",
      children: models.map((m) => ({
        id: m.model,
        label: m.model,
        value: m.cost,
        // 高于平均为正、低于为负，一眼看出谁是大头。
        color: avg > 0 ? ((m.cost - avg) / avg) * 100 : 0,
      })),
    };
  }, [data]);

  /** 延迟分布：用各账号的耗时采样喂给山脊图。 */
  const latencySeries = useMemo(
    () =>
      (data?.channels ?? [])
        .filter((c) => c.latency.length >= 4)
        .slice(0, 6)
        .map((c) => ({ id: String(c.id), label: c.name, values: c.latency })),
    [data],
  );

  const summary = data?.summary;
  const prev = data?.prev;

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
    {
      key: "requests",
      label: "调用",
      sortable: true,
      numeric: true,
      render: (_v, row) => plain.format(row.requests),
    },
    {
      key: "tokens",
      label: "Tokens",
      sortable: true,
      numeric: true,
      render: (_v, row) => compact.format(row.tokens),
    },
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

  const rows: ModelRow[] = (data?.models ?? []).map((m) => ({
    model: m.model,
    vendor: vendorOfModel(m.model) ?? "",
    requests: m.requests,
    tokens: m.tokens,
    cost: m.cost,
  }));

  const hasData = (summary?.requests ?? 0) > 0;

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "消费分析" }]}>
      <div className={styles.page}>
        <header className={styles.head}>
          <div className={styles.headMain}>
            <h1 className={styles.title}>消费分析</h1>
            <p className={styles.sub}>
              {data?.scope === "global" ? "全站范围" : "仅统计你自己的调用"}
              {data?.generated ? ` · 更新于 ${data.generated.slice(11)}` : ""}
            </p>
          </div>

          <SegmentedControl
            label="统计窗口"
            value={days}
            onValueChange={setDays}
            options={[
              { value: "7", label: "近 7 天" },
              { value: "30", label: "近 30 天" },
              { value: "90", label: "近 90 天" },
            ]}
          />
        </header>

        {error && <p className={styles.error}>{error}</p>}

        {loading && !data && <p className={styles.loading}>正在加载统计数据…</p>}

        {data && !hasData && (
          <section className={styles.emptyCard}>
            <EmptyState
              icon={<BarChart3 size={22} strokeWidth={1.6} />}
              title="该窗口内还没有调用记录"
              description="接入密钥并发出请求后，这里会显示消费拆解、时段分布与模型排行。"
            />
          </section>
        )}

        {data && hasData && (
          <>
            {/* 核心四项：请求、消费、Token、平均延迟 */}
            <section className={styles.metricGrid} aria-label="核心指标">
              <MetricCard
                label="请求总数"
                value={summary?.requests ?? 0}
                context={`上一窗口 ${plain.format(prev?.requests ?? 0)}`}
                change={formatDelta(delta(summary?.requests ?? 0, prev?.requests ?? 0))}
              />
              <article className={styles.moneyCard}>
                <div className={styles.moneyTop}>
                  <Coins size={15} strokeWidth={1.7} className={styles.moneyIcon} />
                  <span className={styles.moneyLabel}>消费总额</span>
                  <span className={styles.moneyChange}>
                    {formatDelta(delta(summary?.cost ?? 0, prev?.cost ?? 0))}
                  </span>
                </div>
                <div className={styles.moneyValue}>
                  <span className={styles.moneyNumber}>{money.format(summary?.cost ?? 0)}</span>
                  <CurrencyIcon src={currency.icon} size="1.3rem" />
                </div>
                <span className={styles.moneyContext}>
                  上一窗口 {money.format(prev?.cost ?? 0)}
                  {summary && (summary.cost > 0 && summary.requests > 0) && (
                    <> · 单次均价 {money.format(summary.cost / summary.requests)}</>
                  )}
                </span>
              </article>
              <MetricCard
                label="Token 用量"
                decimals={1}
                value={((summary?.prompt_tokens ?? 0) + (summary?.completion_tokens ?? 0)) / 1_000_000}
                context={`输入 ${compact.format(summary?.prompt_tokens ?? 0)} · 输出 ${compact.format(summary?.completion_tokens ?? 0)}`}
                change={formatDelta(
                  delta(
                    (summary?.prompt_tokens ?? 0) + (summary?.completion_tokens ?? 0),
                    (prev?.prompt_tokens ?? 0) + (prev?.completion_tokens ?? 0),
                  ),
                )}
                suffix="M"
              />
              <MetricCard
                label="平均延迟"
                value={Math.round(summary?.avg_latency_ms ?? 0)}
                context={`成功 ${plain.format(summary?.requests ?? 0)} · 失败 ${plain.format(summary?.failed ?? 0)}`}
                change={formatDelta(delta(summary?.avg_latency_ms ?? 0, prev?.avg_latency_ms ?? 0))}
                suffix="ms"
              />
            </section>

            {/* 缓存命中：给出「省了多少钱」而不只是比例 */}
            {(summary?.cached_tokens ?? 0) > 0 && (
              <p className={styles.cacheNote}>
                <Hash size={13} strokeWidth={1.8} />
                命中缓存的输入 token {compact.format(summary?.cached_tokens ?? 0)}（占输入{" "}
                {(((summary?.cached_tokens ?? 0) / Math.max(1, summary?.prompt_tokens ?? 1)) * 100).toFixed(1)}%），
                这部分按缓存价计费，比标准输入价便宜。
              </p>
            )}

            {/* 趋势：三个口径共用同一份按天数据 */}
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle}>按天走势</h2>
                <span className={styles.cardNote}>共 {data.days} 天</span>
              </div>
              <div className={styles.chartGrid}>
                <figure className={styles.chartBox}>
                  <figcaption className={styles.chartCaption}>
                    <span>请求量</span>
                    <span className={styles.chartValue}>{plain.format(summary?.requests ?? 0)} 次</span>
                  </figcaption>
                  <LineChart
                    label="每日请求量"
                    data={trendData}
                    series={[{ key: "requests", label: "请求数", area: true }]}
                    height={168}
                    curve="smooth"
                    unit="次"
                    formatValue={(v) => `${plain.format(v)} 次`}
                    formatTick={(v) => compact.format(v)}
                  />
                </figure>

                <figure className={styles.chartBox}>
                  <figcaption className={styles.chartCaption}>
                    <span>消费额</span>
                    <span className={styles.chartValue}>{money.format(summary?.cost ?? 0)}</span>
                  </figcaption>
                  <LineChart
                    label="每日消费额"
                    data={trendData}
                    series={[{ key: "cost", label: "消费额", area: true }]}
                    height={168}
                    curve="smooth"
                    formatValue={(v) => money.format(v)}
                    formatTick={(v) => `${Math.round(v)}`}
                  />
                </figure>

                <figure className={styles.chartBox}>
                  <figcaption className={styles.chartCaption}>
                    <span>Token 用量</span>
                    <span className={styles.chartValue}>
                      {compact.format((summary?.prompt_tokens ?? 0) + (summary?.completion_tokens ?? 0))}
                    </span>
                  </figcaption>
                  <LineChart
                    label="每日 Token 用量"
                    data={trendData}
                    series={[{ key: "tokens", label: "Token", area: true }]}
                    height={168}
                    curve="smooth"
                    formatValue={(v) => compact.format(v)}
                    formatTick={(v) => compact.format(v)}
                  />
                </figure>

                <figure className={styles.chartBox}>
                  <figcaption className={styles.chartCaption}>
                    <span>平均延迟</span>
                    <span className={styles.chartValue}>{Math.round(summary?.avg_latency_ms ?? 0)} ms</span>
                  </figcaption>
                  <LineChart
                    label="每日平均延迟"
                    data={trendData}
                    series={[{ key: "latency", label: "延迟", area: true }]}
                    height={168}
                    curve="smooth"
                    unit="ms"
                    formatValue={(v) => `${Math.round(v)} ms`}
                    formatTick={(v) => `${Math.round(v)}`}
                  />
                </figure>
              </div>
            </section>

            {/* 时段 + 星期 */}
            <div className={styles.rowHalf}>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle}>时段分布</h2>
                  <span className={styles.cardNote}>按一天中的小时（整个窗口累计）</span>
                </div>
                <BarChart
                  label="每小时请求量"
                  period={`近 ${data.days} 天累计`}
                  data={data.hourly.map((value, hour) => ({
                    key: `h${hour}`,
                    label: `${hour}:00`,
                    axisLabel: hour % 3 === 0 ? String(hour).padStart(2, "0") : undefined,
                    value,
                  }))}
                  unit="次"
                  averageLabel="时段均值"
                  valueLabel="该时段"
                  height={190}
                  formatValue={(v) => plain.format(v)}
                />
              </section>

              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle}>星期分布</h2>
                  <span className={styles.cardNote}>按周内节律</span>
                </div>
                <BarChart
                  label="按星期的请求量"
                  period={`近 ${data.days} 天累计`}
                  data={data.weekday.map((value, index) => ({
                    key: WEEKDAYS[index],
                    label: WEEKDAYS[index],
                    value,
                  }))}
                  unit="次"
                  averageLabel="周均值"
                  valueLabel="该天"
                  height={190}
                  formatValue={(v) => plain.format(v)}
                />
              </section>
            </div>

            {/* 消费结构 + 模型排行 */}
            <div className={styles.rowSplit}>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle}>消费结构</h2>
                  <span className={styles.cardNote}>按模型拆分，颜色表示高于/低于平均</span>
                </div>
                <Treemap
                  data={costTreemap}
                  label="消费结构"
                  height={248}
                  formatValue={(v) => money.format(v)}
                  colorLabel="相对均值"
                  formatColor={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`}
                />
              </section>

              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle}>模型排行</h2>
                  <span className={styles.cardNote}>按消费额排序</span>
                </div>
                <SortableDataTable<ModelRow>
                  caption="模型消费排行"
                  columns={columns}
                  rows={rows}
                  rowKey="model"
                  defaultSort={{ key: "cost", direction: "desc" }}
                />
              </section>
            </div>

            {/* 请求构成 + 用户排行 */}
            <div className={styles.rowHalf}>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle}>请求构成</h2>
                  <span className={styles.cardNote}>成功与失败的占比</span>
                </div>
                <DonutChart
                  label="请求构成"
                  data={[
                    { key: "ok", label: "成功", value: Math.max(0, (summary?.requests ?? 0) - (summary?.failed ?? 0)) },
                    { key: "fail", label: "失败", value: summary?.failed ?? 0 },
                  ]}
                  size={172}
                  formatValue={(v) => `${plain.format(v)} 次`}
                />
              </section>

              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle}>延迟分布</h2>
                  <span className={styles.cardNote}>各账号最近调用的耗时采样</span>
                </div>
                {latencySeries.length > 0 ? (
                  <Ridgeline series={latencySeries} label="各账号响应延迟分布" unit="ms" tint />
                ) : (
                  <EmptyState
                    icon={<Timer size={20} strokeWidth={1.6} />}
                    title="样本不足"
                    description="账号的调用样本还不够画出分布，多调用几次后就有了。"
                  />
                )}
              </section>
            </div>

            {/* 用户排行：只有全站视角才有意义 */}
            {data.scope === "global" && data.top_users.length > 0 && (
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle}>消费用户排行</h2>
                  <span className={styles.cardNote}>共 {data.top_users.length} 位有调用记录</span>
                </div>
                <ul className={styles.rankList}>
                  {data.top_users.map((u, index) => {
                    const max = data.top_users[0]?.cost || 1;
                    return (
                      <li key={u.user_id} className={styles.rankItem}>
                        <span className={styles.rankIndex}>{index + 1}</span>
                        <span className={styles.rankName}>{u.username}</span>
                        <span className={styles.rankBar} aria-hidden="true">
                          <span
                            className={styles.rankBarFill}
                            style={{ width: `${Math.max(2, (u.cost / max) * 100)}%` }}
                          />
                        </span>
                        <span className={styles.rankRequests}>{plain.format(u.requests)} 次</span>
                        <span className={styles.rankCost}>
                          {money.format(u.cost)}
                          <CurrencyIcon src={currency.icon} size="0.9em" />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* 额度占用 */}
            {(data.quota.total > 0 || data.quota.used > 0) && (
              <p className={styles.footNote}>
                {data.scope === "global" ? "全站额度" : "我的额度"}：已用 {compact.format(data.quota.used)} /{" "}
                {data.quota.total > 0 ? compact.format(data.quota.total) : "不限"}（
                {data.quota.total > 0 ? ((data.quota.used / data.quota.total) * 100).toFixed(1) : "0.0"}%）
                {summary && (
                  <span className={styles.footTrend}>
                    {summary.failed > 0 ? (
                      <>
                        <TrendingDown size={13} strokeWidth={1.8} /> 窗口内有 {plain.format(summary.failed)} 次失败调用
                      </>
                    ) : (
                      <>
                        <TrendingUp size={13} strokeWidth={1.8} /> 窗口内没有失败调用
                      </>
                    )}
                  </span>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
