import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AdminLayout from "@/components/admin/AdminLayout";
import { Button } from "@/components/arc/button/button";
import { ApiRequestError } from "@/lib/api";

import FusedMarketChart from "./tradingBoard/FusedMarketChart";
import {
  bookTotals,
  chartMarks,
  formatPct,
  formatPrice,
  fuseMarkets,
  fuseTimeline,
  type TimelineItem,
} from "./tradingBoard/fusedSeries";
import CoinIcon from "./tradingBoard/CoinIcon";
import { coinInfoOf } from "./tradingBoard/coins";
import {
  getEngineBalance,
  getEngineEvents,
  getEngineMarket,
  getEngineOrders,
  getEnginePosition,
  getEngineState,
  listStrategies,
  setPauseEntries,
  type DetectionEvent,
  type EngineBalance,
  type EngineMarket,
  type EngineOrders,
  type EnginePosition,
  type EngineState,
  type Strategy,
  type TradeEntry,
} from "./tradingApi";
import { formatAmount, sideText } from "./tradingDeskView";
import {
  BotList,
  GridConfig,
  ParamTuner,
  StrategyTemplates,
  templateParamsOf,
  type TemplateParams,
} from "./tradingBoard/TradingSystem";

import styles from "./TradingBoard.module.css";

/**
 * 交易数据看板。
 * 不再按币种切换：全部策略的涨跌幅、开仓和决策画在同一张图上，
 * 账户、持仓和记录在图下方一次排开。
 */

const POLL_MS = 5000;

interface Lane {
  strategy: Strategy;
  engine: EngineState | null;
  market: EngineMarket | null;
  position: EnginePosition | null;
  orders: EngineOrders | null;
  balance: EngineBalance | null;
  marketError?: string;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

function formatTime(value?: string): string {
  if (!value) return "--";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    marketError: marketRes.status === "rejected" ? errorText(marketRes.reason, "读取 K 线失败") : undefined,
  };
}

export default function TradingBoard() {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [eventsEnabled, setEventsEnabled] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pauseBusyId, setPauseBusyId] = useState<number | null>(null);
  const [tunerDraft, setTunerDraft] = useState<TemplateParams | null>(null);
  const [tunerTemplate, setTunerTemplate] = useState<string | null>(null);

  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    const items = await listStrategies();
    if (gen !== genRef.current) return items;
    const [nextLanes, eventsRes] = await Promise.all([
      Promise.all(items.map((strategy) => loadLane(strategy))),
      getEngineEvents().then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason }),
      ),
    ]);
    if (gen !== genRef.current) return items;
    setLanes(nextLanes);
    if (eventsRes.ok) {
      setEvents(eventsRes.value);
      setEventsEnabled(true);
    } else if (eventsRes.reason instanceof ApiRequestError && (eventsRes.reason.status === 401 || eventsRes.reason.status === 403)) {
      setEventsEnabled(false);
      setEvents([]);
    }
    return items;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      await refresh();
    } catch (err) {
      setLoadError(errorText(err, "加载交易数据看板失败"));
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh().catch((err) => setLoadError(errorText(err, "刷新交易数据失败")));
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loading, refresh]);

  const strategies = useMemo(() => lanes.map((lane) => lane.strategy), [lanes]);
  const series = useMemo(
    () => fuseMarkets(lanes.flatMap((lane) => (lane.market ? [lane.market] : []))),
    [lanes],
  );
  const seriesBySymbol = useMemo(() => new Map(series.map((item) => [item.symbol, item])), [series]);

  const entries = useMemo(() => {
    const list: TradeEntry[] = [];
    for (const lane of lanes) {
      const symbol = (lane.strategy.symbol ?? "").toUpperCase();
      const fromOrders = lane.orders?.entries ?? [];
      const fromState = lane.engine?.entries ?? [];
      for (const entry of [...fromOrders, ...fromState]) {
        list.push({ ...entry, symbol: entry.symbol || symbol });
      }
    }
    return list;
  }, [lanes]);

  const marks = useMemo(() => chartMarks(series, entries, events), [series, entries, events]);
  const timeline = useMemo(() => fuseTimeline(entries, eventsEnabled ? events : []), [entries, events, eventsEnabled]);
  const totals = useMemo(
    () => bookTotals(lanes.flatMap((lane) => (lane.balance ? [lane.balance] : []))),
    [lanes],
  );

  const engines = useMemo(() => {
    const map = new Map<number, EngineState>();
    for (const lane of lanes) {
      if (lane.engine) map.set(lane.strategy.id, lane.engine);
    }
    return map;
  }, [lanes]);

  const openPositions = useMemo(() => {
    return lanes.flatMap((lane) => {
      const position = lane.position;
      if (!position?.open) return [];
      const coin = coinInfoOf(position.symbol || lane.strategy.symbol);
      return [{ coin, position }];
    });
  }, [lanes]);

  const togglePause = async (strategyId: number, paused: boolean) => {
    setPauseBusyId(strategyId);
    try {
      const saved = await setPauseEntries(strategyId, paused);
      setLanes((prev) => prev.map((lane) => (
        lane.strategy.id === strategyId
          ? {
              ...lane,
              strategy: { ...lane.strategy, pauseEntries: saved.pauseEntries },
              engine: lane.engine ? { ...lane.engine, pauseEntries: saved.pauseEntries } : lane.engine,
            }
          : lane
      )));
    } catch (err) {
      setLoadError(errorText(err, "更新暂停开仓失败"));
    } finally {
      setPauseBusyId(null);
    }
  };

  const toggleSeries = (symbol: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  const running = strategies.filter((strategy) => strategy.pauseEntries !== true).length;

  return (
    <AdminLayout
      crumbs={[
        { label: "后台", href: "/admin" },
        { label: "交易" },
        { label: "数据看板" },
      ]}
    >
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <div>
            <h1 className={styles.pageTitle}>交易数据看板</h1>
            <p className={styles.pageLead}>
              全部品种画在同一张图上。纵轴是相对共同窗口的涨跌幅，开仓和决策标在对应时间；价格、持仓和账户读数跟在图里，不再按币种切换。
            </p>
          </div>
          <span className={styles.liveDot} aria-label="实时更新中">
            <i />
            实时
          </span>
        </header>

        {loadError ? (
          <p className={styles.errorBar} role="alert">
            {loadError}
            <Button variant="secondary" size="sm" onClick={() => void load()}>重试</Button>
          </p>
        ) : null}

        <section className={styles.panel} aria-label="融合行情">
          <header className={styles.panelHeadRow}>
            <div>
              <h2 className={styles.panelTitle}>融合行情</h2>
              <p className={styles.panelDesc}>
                {series.length > 0
                  ? `${series.length} 条曲线共用一段重叠时间，各自从这段的第一根收盘起算 0%。点图例只显隐曲线。`
                  : "创建策略并有 K 线之后，品种会一起出现在这张图上。"}
              </p>
            </div>
            <span className={styles.chartMeta}>{running}/{strategies.length || 0} 个策略在开仓</span>
          </header>

          <div className={styles.legend} role="list">
            {lanes.length === 0 ? (
              <p className={styles.emptyText}>{loading ? "正在读取全部品种…" : "还没有策略。到系统设置创建后，这里会直接画出曲线。"}</p>
            ) : lanes.map((lane) => {
              const coin = coinInfoOf(lane.strategy.symbol);
              const line = seriesBySymbol.get(coin.symbol);
              const off = hidden.has(coin.symbol);
              return (
                <button
                  key={lane.strategy.id}
                  type="button"
                  role="listitem"
                  className={styles.legendItem}
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
                  <i className={styles.swatch} style={{ background: coin.color }} />
                  {coin.name}
                  <strong data-side={(position.side ?? "").toLowerCase() === "short" ? "SHORT" : "LONG"}>
                    {sideText((position.side ?? "").toLowerCase())} {Math.abs(position.qty ?? 0)}
                  </strong>
                  <span className={toneClass(position.unrealizedPnl)}>
                    {position.unrealizedPnl != null ? `${position.unrealizedPnl >= 0 ? "+" : ""}${formatAmount(position.unrealizedPnl)}` : "--"}
                  </span>
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

          <dl className={styles.bookStrip}>
            <div>
              <dt>账户权益</dt>
              <dd>{totals.accounts > 0 ? `${formatAmount(totals.equity)} USDT` : "--"}</dd>
            </div>
            <div>
              <dt>可用</dt>
              <dd>{totals.accounts > 0 ? `${formatAmount(totals.available)} USDT` : "--"}</dd>
            </div>
            <div>
              <dt>今日盈亏</dt>
              <dd className={toneClass(totals.todayPnl)}>
                {totals.accounts > 0 ? `${totals.todayPnl >= 0 ? "+" : ""}${formatAmount(totals.todayPnl)} USDT` : "--"}
              </dd>
            </div>
            <div>
              <dt>持仓浮盈</dt>
              <dd className={toneClass(totals.unrealized)}>
                {totals.accounts > 0 ? `${totals.unrealized >= 0 ? "+" : ""}${formatAmount(totals.unrealized)} USDT` : "--"}
              </dd>
            </div>
            <div>
              <dt>保证金</dt>
              <dd>{totals.accounts > 0 ? `${formatAmount(totals.marginUsed)} USDT` : "--"}</dd>
            </div>
          </dl>
          <p className={styles.axisNote}>同一交易所账户只计一次，避免多个策略把权益加重复。纵轴单位是涨跌幅，不是价格。</p>
        </section>

        <div className={styles.main}>
          <section className={styles.panel} aria-label="品种明细">
            <header className={styles.panelHeadRow}>
              <div>
                <h2 className={styles.panelTitle}>品种明细</h2>
                <p className={styles.panelDesc}>参数、持仓和开仓开关跟品种走，点表头不会换图。</p>
              </div>
            </header>
            {lanes.length === 0 ? (
              <p className={styles.emptyText}>{loading ? "正在读取策略…" : "暂无策略。"}</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>品种</th>
                      <th>最新价</th>
                      <th>窗口</th>
                      <th>持仓</th>
                      <th>浮盈</th>
                      <th>杠杆</th>
                      <th>EMA</th>
                      <th>止损 / 止盈</th>
                      <th>开仓</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lanes.map((lane) => {
                      const coin = coinInfoOf(lane.strategy.symbol);
                      const line = seriesBySymbol.get(coin.symbol);
                      const position = lane.position?.open ? lane.position : null;
                      const paused = lane.strategy.pauseEntries === true;
                      return (
                        <tr key={lane.strategy.id}>
                          <td>
                            <span className={styles.symbolCell}>
                              <i className={styles.swatch} style={{ background: coin.color }} />
                              {coin.name}
                              <span className={styles.coinSymbol}>{coin.symbol}</span>
                            </span>
                          </td>
                          <td className={styles.num}>{line ? formatPrice(line.lastPrice, coin.precision) : "--"}</td>
                          <td className={`${styles.num} ${toneClass(line?.changePct)}`}>{line ? formatPct(line.changePct) : "--"}</td>
                          <td>
                            {position
                              ? <span data-side={(position.side ?? "").toLowerCase() === "short" ? "SHORT" : "LONG"}>{sideText((position.side ?? "").toLowerCase())} {Math.abs(position.qty ?? 0)}</span>
                              : "空仓"}
                          </td>
                          <td className={`${styles.num} ${toneClass(position?.unrealizedPnl)}`}>
                            {position?.unrealizedPnl != null ? `${position.unrealizedPnl >= 0 ? "+" : ""}${formatAmount(position.unrealizedPnl)}` : "--"}
                          </td>
                          <td className={styles.num}>{lane.strategy.leverage}x</td>
                          <td className={styles.num}>{lane.strategy.emaFast}/{lane.strategy.emaSlow}</td>
                          <td className={styles.num}>{lane.strategy.stopR}R / {lane.strategy.takeProfitR}R</td>
                          <td>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={pauseBusyId === lane.strategy.id}
                              onClick={() => void togglePause(lane.strategy.id, !paused)}
                            >
                              {pauseBusyId === lane.strategy.id ? "更新中…" : paused ? "启动" : "暂停"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={styles.panel} aria-label="开仓与决策">
            <header className={styles.panelHeadRow}>
              <div>
                <h2 className={styles.panelTitle}>开仓与决策</h2>
                <p className={styles.panelDesc}>
                  {eventsEnabled ? "全部品种的开仓和引擎决策按时间排在一起，并标在上方曲线上。" : "决策事件接口不可用，这里只列出开仓。"}
                </p>
              </div>
            </header>
            <Timeline items={timeline} loading={loading} />
          </section>
        </div>

        <section className={styles.panel} aria-label="交易系统">
          <header className={styles.panelHeadRow}>
            <div>
              <h2 className={styles.panelTitle}>交易系统</h2>
              <p className={styles.panelDesc}>模板和调参是本地草稿。机器人启停会立刻写到策略。</p>
            </div>
          </header>
          <h3 className={styles.subTitle}>决策模板</h3>
          <StrategyTemplates onApply={(params, name) => { setTunerDraft(params); setTunerTemplate(name); }} activeId={null} />
          <h3 className={styles.subTitle}>决策调参</h3>
          <ParamTuner
            draft={tunerDraft ?? templateParamsOf(strategies[0] ?? null)}
            onChange={(next) => { setTunerDraft(next); setTunerTemplate(null); }}
            templateName={tunerTemplate}
          />
          <h3 className={styles.subTitle}>网格策略</h3>
          <GridConfig />
          <h3 className={styles.subTitle}>交易机器人</h3>
          <BotList
            strategies={strategies}
            engines={engines}
            pauseBusyId={pauseBusyId}
            onTogglePause={(id, paused) => void togglePause(id, paused)}
          />
        </section>
      </div>
    </AdminLayout>
  );
}

function Timeline({ items, loading }: { items: TimelineItem[]; loading: boolean }) {
  if (items.length === 0) {
    return <p className={styles.emptyText}>{loading ? "正在读取记录…" : "暂无开仓或决策记录。"}</p>;
  }
  return (
    <ol className={styles.logList}>
      {items.map((item, index) => {
        const coin = item.symbol ? coinInfoOf(item.symbol) : null;
        const title = item.kind === "trade"
          ? `${sideText(item.side)} ${item.price != null ? item.price : "--"}`
          : (item.action || "扫描");
        const detail = item.kind === "trade"
          ? (item.score != null ? `评分 ${item.score.toFixed(1)}` : "")
          : (item.message ?? "");
        return (
          <li key={`${item.kind}-${item.time}-${item.symbol}-${index}`} className={styles.logItem}>
            <span className={styles.logTime}>{formatTime(item.time)}</span>
            <span className={styles.logSymbol}>{coin ? coin.name : item.symbol || "--"}</span>
            <span className={styles.logAction}>{title}</span>
            <span className={styles.logMsg}>{detail}</span>
            {item.kind === "trade" && item.expectancyR != null ? (
              <span className={`${styles.logScore} ${toneClass(item.expectancyR)}`}>{item.expectancyR.toFixed(2)}R</span>
            ) : item.score != null && item.kind === "decision" ? (
              <span className={styles.logScore}>评分 {item.score.toFixed(1)}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
