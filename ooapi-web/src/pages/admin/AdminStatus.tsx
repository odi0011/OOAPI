import { useCallback, useEffect, useState } from "react";

import { Gauge } from "@/components/arc/gauge/gauge";
import AdminLayout from "@/components/admin/AdminLayout";
import CurrencyIcon from "@/components/CurrencyIcon";
import { useCurrency } from "@/contexts/CurrencyContext";
import { ApiRequestError, apiRequest } from "@/lib/api";

import styles from "./AdminStatus.module.css";

interface StatusReport {
  database: { ok: boolean; error: string };
  channels: { total: number; active: number; cooling: number; auto_disabled: number };
  calls_24h: { calls: number; errors: number; quota: number; avg_latency: number };
  tables: { name: string; count: number }[];
  groups: number;
  active_tokens: number;
}

/** 表名的中文说明，避免管理员对着英文表名猜。 */
const TABLE_LABELS: Record<string, string> = {
  users: "用户",
  tokens: "密钥",
  channels: "账号",
  channel_groups: "分组",
  logs: "日志",
  model_prices: "定价",
};

/**
 * 运行状态。
 *
 * 目的是「出问题一眼看出是哪一层」：
 * 数据库连通性、账号健康、近 24 小时调用质量、各表规模。
 * 不追求监控大屏的丰富度，而是排障时最需要看的几项。
 */
export default function AdminStatus() {
  const currency = useCurrency();

  const [report, setReport] = useState<StatusReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<StatusReport>("/api/admin/status");
      setReport(data);
      setRefreshedAt(new Date().toLocaleTimeString("zh-CN"));
      setMessage(null);
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !report) {
    return (
      <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "运行状态" }]}>
        <p className={styles.loading}>正在体检…</p>
      </AdminLayout>
    );
  }

  const dbOK = report?.database.ok ?? false;
  const calls = report?.calls_24h;
  const channels = report?.channels;

  // 成功率：用「调用数 - 错误数」估算。错误数由日志详情里的「错误=」标记统计。
  //
  // 没有调用时是 null 而不是 100 —— 「0 次调用」配一个满格绿环会被读成
  // 「一切健康」，而事实是「还没有数据」。两种情况必须能区分。
  const successRate = calls && calls.calls > 0
    ? Math.max(0, Math.round(((calls.calls - calls.errors) / calls.calls) * 1000) / 10)
    : null;

  return (
    <AdminLayout
      crumbs={[{ label: "后台", href: "/admin" }, { label: "运行状态" }]}
      actions={
        <button type="button" className={styles.refresh} onClick={() => void load()}>
          {loading ? "刷新中…" : "刷新"}
        </button>
      }
    >
      <div className={styles.page}>
        <header className={styles.head}>
          <h1 className={styles.title}>运行状态</h1>
          {refreshedAt && <span className={styles.stamp}>更新于 {refreshedAt}</span>}
        </header>

        {message && <p className={styles.err}>{message}</p>}

        {/* ---------- 总体健康 ---------- */}
        <section className={styles.healthRow}>
          <div className={styles.healthCard} data-ok={dbOK || undefined}>
            <span className={styles.healthLabel}>数据库</span>
            <span className={styles.healthValue}>{dbOK ? "正常" : "异常"}</span>
            {!dbOK && report?.database.error && (
              <span className={styles.healthError}>{report.database.error}</span>
            )}
          </div>

          <div
            className={styles.healthCard}
            data-ok={channels && channels.active > 0 ? true : undefined}
            data-warn={channels && channels.active === 0 ? true : undefined}
          >
            <span className={styles.healthLabel}>可用账号</span>
            <span className={styles.healthValue}>
              {channels?.active ?? 0}
              <small> / {channels?.total ?? 0}</small>
            </span>
            {channels && channels.cooling > 0 && (
              <span className={styles.healthNote}>{channels.cooling} 个冷却中</span>
            )}
            {channels && channels.auto_disabled > 0 && (
              <span className={styles.healthNote}>{channels.auto_disabled} 个自动禁用</span>
            )}
          </div>

          <div className={styles.healthCard}>
            <span className={styles.healthLabel}>启用密钥</span>
            <span className={styles.healthValue}>{report?.active_tokens ?? 0}</span>
          </div>

          <div className={styles.healthCard}>
            <span className={styles.healthLabel}>分组</span>
            <span className={styles.healthValue}>{report?.groups ?? 0}</span>
          </div>
        </section>

        {/* ---------- 近 24 小时 ---------- */}
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>近 24 小时</h2>

          <div className={styles.statGrid}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{calls?.calls.toLocaleString("zh-CN") ?? 0}</span>
              <span className={styles.statLabel}>调用次数</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue} data-warn={calls && calls.errors > 0 ? true : undefined}>
                {calls?.errors ?? 0}
              </span>
              <span className={styles.statLabel}>失败次数</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>
                {calls?.avg_latency ? `${Math.round(calls.avg_latency)} ms` : "—"}
              </span>
              <span className={styles.statLabel}>平均延迟</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>
                {formatAmount(calls?.quota ?? 0, currency.unitsPerUnit)}
                <CurrencyIcon src={currency.icon} size="0.8em" />
              </span>
              <span className={styles.statLabel}>消耗</span>
            </div>
          </div>

          {/* 成功率用仪表盘展示：它天然是百分比，Gauge 正合适。
              没有调用时不画仪表 —— 一个 100% 的绿环会被当成健康信号。 */}
          <div className={styles.gaugeWrap}>
            {successRate === null ? (
              <div className={styles.gaugeEmpty}>
                <span className={styles.gaugeEmptyValue}>—</span>
                <span className={styles.gaugeEmptyLabel}>调用成功率</span>
                <span className={styles.gaugeEmptyNote}>近 24 小时没有调用</span>
              </div>
            ) : (
              <Gauge
                value={successRate}
                label="调用成功率"
                detail={`近 24 小时 · ${calls?.calls ?? 0} 次调用`}
                tone={successRate >= 99 ? "success" : successRate >= 95 ? "warning" : "danger"}
              />
            )}
          </div>
        </section>

        {/* ---------- 表规模 ---------- */}
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>数据规模</h2>
          <ul className={styles.tables}>
            {report?.tables.map((t) => (
              <li key={t.name} className={styles.tableRow}>
                <span className={styles.tableName}>
                  {TABLE_LABELS[t.name] ?? t.name}
                  <code className={styles.tableCode}>{t.name}</code>
                </span>
                <span className={styles.tableCount}>{t.count.toLocaleString("zh-CN")}</span>
              </li>
            ))}
          </ul>
          <p className={styles.note}>
            日志表会随调用量持续增长。它变大后，「用量日志」页的筛选与分页会变慢，
            届时可以直接清空日志表（记录仅用于排查与对账，不影响计费）。
          </p>
        </section>
      </div>
    </AdminLayout>
  );
}

function formatAmount(units: number, unitsPerUnit: number): string {
  if (!unitsPerUnit) return "0";
  const v = units / unitsPerUnit;
  // 0 就直接显示 0：0.000000 与 0.0000 看起来像「很小的非零值」，
  // 而且与其它页面的位数不一致，读起来像精度事故。
  if (v === 0) return "0";
  return v < 1 ? v.toFixed(4) : v.toFixed(2);
}
