/**
 * 交易统计（AnalyticsBlocks）。
 *
 * **只保留能从后端真实数据算出来的统计。** 这个文件此前有四大块
 * 「可视化分析」：小多图矩阵、净值归因瀑布、风险预算偏差、活跃度热力与
 * 信号漏斗 —— 拆开看全是编的：
 *
 *   · 净值瀑布把「今日盈亏」乘以 1.48 当成毛利、乘 0.36 当成止损回撤，
 *     再凑出几条柱 —— 交易所根本没提供这种分解；
 *   · 风险预算四项里除保证金占用外都是常量或按常数比例编出来的；
 *   · 活跃度热力矩阵是硬编码的二维数组；
 *   · 信号漏斗拿「成交笔数 × 42」倒推扫描次数。
 *
 * 这些图看起来很像专业终端，但没有一个数字来自系统 —— 放在交易页上
 * 会让用户以为系统真的做了这些归因。现在只统计真实存在的成交记录。
 */
import { useMemo } from "react";

import type { CoinInfo } from "./coins";
import type { TradeEntry } from "../tradingApi";

import styles from "../TradingBoard.module.css";

interface AnalyticsBlocksProps {
  coin: CoinInfo;
  entries: TradeEntry[];
}

/** 从真实成交记录算出的统计量。样本为 0 时返回 null（不显示）。 */
interface EntryStats {
  count: number;
  boosted: number;
  forced: number;
  avgScore: number;
  avgWinRate: number;
  avgExpectancyR: number;
  netR: number;
}

function computeEntryStats(entries: TradeEntry[]): EntryStats | null {
  const valid = entries.filter((e) => e && Number.isFinite(e.score));
  if (valid.length === 0) return null;

  let scoreSum = 0;
  let winSum = 0;
  let winCount = 0;
  let expectancySum = 0;
  let expectancyCount = 0;
  let netR = 0;
  let boosted = 0;
  let forced = 0;

  for (const e of valid) {
    scoreSum += e.score ?? 0;
    if (Number.isFinite(e.winRate)) {
      // 后端可能给 0–1 的比例，也可能给百分数 —— 统一成百分数展示。
      winSum += e.winRate <= 1 ? e.winRate * 100 : e.winRate;
      winCount += 1;
    }
    if (Number.isFinite(e.expectancyR)) {
      expectancySum += e.expectancyR;
      expectancyCount += 1;
    }
    if (Number.isFinite(e.netR)) netR += e.netR;
    if (e.boost) boosted += 1;
    if (e.forced) forced += 1;
  }

  return {
    count: valid.length,
    boosted,
    forced,
    avgScore: scoreSum / valid.length,
    avgWinRate: winCount > 0 ? winSum / winCount : 0,
    avgExpectancyR: expectancyCount > 0 ? expectancySum / expectancyCount : 0,
    netR,
  };
}

export default function AnalyticsBlocks({ coin, entries }: AnalyticsBlocksProps) {
  const stats = useMemo(() => computeEntryStats(entries), [entries]);

  // 按标的统计真实成交分布（只列出现过的）
  const bySymbol = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries) {
      const sym = (e.symbol ?? "").toUpperCase();
      if (!sym) continue;
      map.set(sym, (map.get(sym) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  if (!stats) {
    return (
      <section className={styles.analyticsSection} aria-label="交易统计">
        <div className={styles.analyticsSectionHeader}>
          <h2 className={styles.panelTitle}>交易统计</h2>
        </div>
        <p className={styles.analyticsEmpty}>还没有成交记录 —— 引擎开仓后这里会显示真实统计。</p>
      </section>
    );
  }

  return (
    <section className={styles.analyticsSection} aria-label="交易统计">
      <div className={styles.analyticsSectionHeader}>
        <h2 className={styles.panelTitle}>交易统计</h2>
        <span className={styles.analyticsMetaBadge}>
          {coin.displaySymbol} · {stats.count} 笔
        </span>
      </div>

      <dl className={styles.statGrid}>
        <div className={styles.statCell}>
          <dt>成交笔数</dt>
          <dd>{stats.count}</dd>
        </div>
        <div className={styles.statCell}>
          <dt>累计净 R</dt>
          <dd className={stats.netR >= 0 ? styles.toneUp : styles.toneDown}>
            {stats.netR >= 0 ? "+" : ""}
            {stats.netR.toFixed(2)}
          </dd>
        </div>
        <div className={styles.statCell}>
          <dt>平均期望</dt>
          <dd>{stats.avgExpectancyR.toFixed(2)} R</dd>
        </div>
        <div className={styles.statCell}>
          <dt>平均胜率</dt>
          <dd>{stats.avgWinRate.toFixed(1)}%</dd>
        </div>
        <div className={styles.statCell}>
          <dt>平均评分</dt>
          <dd>{stats.avgScore.toFixed(2)}</dd>
        </div>
        <div className={styles.statCell}>
          <dt>Boost / 强开</dt>
          <dd>
            {stats.boosted} / {stats.forced}
          </dd>
        </div>
      </dl>

      {bySymbol.length > 1 ? (
        <div className={styles.symbolBreakdown}>
          {bySymbol.map(([symbol, count]) => (
            <span key={symbol} className={styles.symbolChip}>
              {symbol}
              <span className={styles.symbolChipCount}>{count}</span>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
