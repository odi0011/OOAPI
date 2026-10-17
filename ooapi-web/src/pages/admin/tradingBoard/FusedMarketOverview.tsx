import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiRequestError } from "@/lib/api";

import { sideText } from "../tradingDeskView";
import styles from "../TradingBoard.module.css";
import CoinIcon from "./CoinIcon";
import FusedMarketChart from "./FusedMarketChart";
import { coinInfoOf } from "./coins";
import {
  chartMarks,
  formatPct,
  formatPrice,
  fuseMarkets,
} from "./fusedSeries";
import {
  getEngineBalance,
  getEngineEvents,
  getEngineMarket,
  getEngineOrders,
  getEnginePosition,
  getEngineState,
  listStrategies,
  type DetectionEvent,
  type EngineBalance,
  type EngineMarket,
  type EngineOrders,
  type EnginePosition,
  type EngineState,
  type Strategy,
  type TradeEntry,
} from "../tradingApi";

/**
 * 全品种一张图。单品种毫秒图仍留在看板里；这里把每个策略的涨跌幅叠在同一根轴上。
 */

const POLL_MS = 5000;

interface Lane {
  strategy: Strategy;
  engine: EngineState | null;
  market: EngineMarket | null;
  position: EnginePosition | null;
  orders: EngineOrders | null;
  balance: EngineBalance | null;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

function toneClass(value: number | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "";
  return value > 0 ? styles.toneUp : styles.toneDown;
}

async function loadLane(strategy: Strategy): Promise<Lane> {
  const [stateRes, marketRes, positionRes, ordersRes, balanceRes] = await Promise.allSettled([
    getEngineState(strategy.id),
    getEngineMarket(strategy.id, 200),
    getEnginePosition(strategy.id),
    getEngineOrders(strategy.id),
    getEngineBalance(strategy.id),
  ]);
  return {
    strategy,
    engine: stateRes.status === "fulfilled" ? stateRes.value : null,
    market: marketRes.status === "fulfilled" ? marketRes.value : null,
    position: positionRes.status === "fulfilled" ? positionRes.value : null,
    orders: ordersRes.status === "fulfilled" ? ordersRes.value : null,
    balance: balanceRes.status === "fulfilled" ? balanceRes.value : null,
  };
}

export default function FusedMarketOverview() {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    const items = await listStrategies();
    if (gen !== genRef.current) return;
    const [nextLanes, eventsRes] = await Promise.all([
      Promise.all(items.map((strategy) => loadLane(strategy))),
      getEngineEvents().then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason }),
      ),
    ]);
    if (gen !== genRef.current) return;
    setLanes(nextLanes);
    if (eventsRes.ok) setEvents(eventsRes.value);
    else if (eventsRes.reason instanceof ApiRequestError && (eventsRes.reason.status === 401 || eventsRes.reason.status === 403)) {
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refresh()
      .catch((err) => {
        if (!cancelled) setLoadError(errorText(err, "读取全品种行情失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (loading) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh().catch((err) => setLoadError(errorText(err, "刷新全品种行情失败")));
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loading, refresh]);

  const series = useMemo(
    () => fuseMarkets(lanes.flatMap((lane) => (lane.market ? [lane.market] : []))),
    [lanes],
  );
  const seriesBySymbol = useMemo(() => new Map(series.map((item) => [item.symbol, item])), [series]);
  const entries = useMemo(() => {
    const list: TradeEntry[] = [];
    for (const lane of lanes) {
      const symbol = (lane.strategy.symbol ?? "").toUpperCase();
      for (const entry of [...(lane.orders?.entries ?? []), ...(lane.engine?.entries ?? [])]) {
        list.push({ ...entry, symbol: entry.symbol || symbol });
      }
    }
    return list;
  }, [lanes]);
  const marks = useMemo(() => chartMarks(series, entries, events), [series, entries, events]);
  const openPositions = useMemo(() => lanes.flatMap((lane) => {
    const position = lane.position;
    if (!position?.open) return [];
    const coin = coinInfoOf(position.symbol || lane.strategy.symbol);
    return [{ coin, position }];
  }), [lanes]);

  const toggleSeries = (symbol: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  return (
    <section className={styles.panel} aria-label="全品种融合行情">
      <header className={styles.panelHeadRow}>
        <div>
          <h2 className={styles.panelTitle}>全品种一张图</h2>
          <p className={styles.panelDesc}>
            {series.length > 0
              ? `${series.length} 条曲线共用一段重叠时间，各自从这段的第一根收盘起算 0%。点图例只显隐曲线。`
              : "创建策略并有 K 线之后，品种会一起出现在这张图上。"}
          </p>
        </div>
        <span className={styles.chartMeta}>{lanes.length} 个策略</span>
      </header>

      {loadError ? <p className={styles.errorBar} role="alert">{loadError}</p> : null}

      <div className={styles.fusedLegend} role="list">
        {lanes.length === 0 ? (
          <p className={styles.emptyText}>{loading ? "正在读取全部品种…" : "还没有策略。"}</p>
        ) : lanes.map((lane) => {
          const coin = coinInfoOf(lane.strategy.symbol);
          const line = seriesBySymbol.get(coin.symbol);
          const off = hidden.has(coin.symbol);
          return (
            <button
              key={lane.strategy.id}
              type="button"
              role="listitem"
              className={styles.fusedLegendItem}
              data-off={off}
              aria-pressed={!off}
              onClick={() => toggleSeries(coin.symbol)}
            >
              <CoinIcon icon={coin.icon} color={coin.color} label={coin.name} size={18} />
              <span className={styles.legendName}>{coin.name}</span>
              <span className={styles.legendPrice}>
                {line ? formatPrice(line.lastPrice, coin.precision) : "--"}
              </span>
              <span className={`${styles.legendChange} ${toneClass(line?.changePct)}`}>
                {line ? formatPct(line.changePct) : "无曲线"}
              </span>
            </button>
          );
        })}
      </div>

      {openPositions.length > 0 ? (
        <div className={styles.positionRow} aria-label="当前持仓">
          {openPositions.map(({ coin, position }) => (
            <span key={`${position.strategyId}-${coin.symbol}`} className={styles.positionPill}>
              <i className={styles.fusedSwatch} style={{ background: coin.color }} />
              {coin.name}
              <strong data-side={(position.side ?? "").toLowerCase() === "short" ? "SHORT" : "LONG"}>
                {sideText((position.side ?? "").toLowerCase())} {Math.abs(position.qty ?? 0)}
              </strong>
            </span>
          ))}
        </div>
      ) : (
        <p className={styles.flatNote}>{loading ? "正在读取持仓…" : "当前全部空仓"}</p>
      )}

      <div className={styles.chartStage}>
        {series.length > 0 ? (
          <FusedMarketChart series={series} marks={marks} hidden={hidden} />
        ) : (
          <p className={styles.emptyText}>{loading ? "正在读取 K 线…" : "暂无可以叠在一起的 K 线。"}</p>
        )}
      </div>
      <p className={styles.axisNote}>纵轴是涨跌幅（各自从首根收盘起算 0%），不是价格。</p>

    </section>
  );
}
