import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AdminLayout from "@/components/admin/AdminLayout";
import { Button } from "@/components/arc/button/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { ApiRequestError } from "@/lib/api";

import LightweightCandleChart from "./LightweightCandleChart";
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
} from "./tradingApi";
import { BalanceHero, CoinSelector, DecisionLogPanel, HistoryPanel, ParamPanel, PositionCard } from "./tradingBoard/BoardPanels";
import { COINS, coinInfoOf } from "./tradingBoard/coins";
import {
  AutomationPanel,
  BotList,
  GridConfig,
  ParamTuner,
  StrategyTemplates,
  templateParamsOf,
  type TemplateParams,
} from "./tradingBoard/TradingSystem";

import styles from "./TradingBoard.module.css";

/**
 * 交易数据看板：总余额首屏、毫秒级 K 线（仓位标记融合）、
 * 参数 / 历史 / 决策记录，以及交易系统（模板、调参、自动化、网格、机器人）。
 * 只读已有接口：/api/trading/engine/{state,market,position,orders,balance,events}、
 * /api/trading/strategies（含 pause-entries 开关）。
 */

const POLL_MS = 5000;

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export default function TradingBoard() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [coinSymbol, setCoinSymbol] = useState<string>(COINS[0].symbol);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [market, setMarket] = useState<EngineMarket | null>(null);
  const [position, setPosition] = useState<EnginePosition | null>(null);
  const [orders, setOrders] = useState<EngineOrders | null>(null);
  const [balance, setBalance] = useState<EngineBalance | null>(null);
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [eventsEnabled, setEventsEnabled] = useState(false);
  const [engines, setEngines] = useState<Map<number, EngineState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | undefined>(undefined);
  const [pauseBusyId, setPauseBusyId] = useState<number | null>(null);
  const [tunerDraft, setTunerDraft] = useState<TemplateParams | null>(null);
  const [tunerTemplate, setTunerTemplate] = useState<string | null>(null);

  const strategiesRef = useRef<Strategy[]>([]);
  const coinRef = useRef(coinSymbol);
  coinRef.current = coinSymbol;
  const genRef = useRef(0);

  const strategyCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const strategy of strategies) {
      const symbol = (strategy.symbol ?? "").toUpperCase();
      counts[symbol] = (counts[symbol] ?? 0) + 1;
    }
    return counts;
  }, [strategies]);

  /** 当前币种命中的策略：优先同 symbol 的第一条。 */
  const strategy = useMemo(
    () => strategies.find((item) => (item.symbol ?? "").toUpperCase() === coinSymbol) ?? null,
    [strategies, coinSymbol],
  );

  const coin = coinInfoOf(coinSymbol);

  const refresh = useCallback(async (strategyId: number | null) => {
    const gen = ++genRef.current;
    if (strategyId == null) {
      setEngine(null);
      setMarket(null);
      setPosition(null);
      setOrders(null);
      setBalance(null);
      setBalanceError(undefined);
      return;
    }
    const [stateRes, marketRes, positionRes, ordersRes, balanceRes, eventsRes] = await Promise.allSettled([
      getEngineState(strategyId),
      getEngineMarket(strategyId, 200),
      getEnginePosition(strategyId),
      getEngineOrders(strategyId),
      getEngineBalance(strategyId),
      getEngineEvents(),
    ]);
    if (gen !== genRef.current) return;
    if (stateRes.status === "fulfilled") {
      setEngine(stateRes.value);
      setEngines((prev) => new Map(prev).set(strategyId, stateRes.value));
    }
    if (marketRes.status === "fulfilled") setMarket(marketRes.value);
    if (positionRes.status === "fulfilled") setPosition(positionRes.value);
    if (ordersRes.status === "fulfilled") setOrders(ordersRes.value);
    if (balanceRes.status === "fulfilled") {
      setBalance(balanceRes.value);
      setBalanceError(undefined);
    } else {
      setBalanceError(errorText(balanceRes.reason, "读取账户余额失败"));
    }
    if (eventsRes.status === "fulfilled") {
      setEvents(eventsRes.value);
      setEventsEnabled(true);
    } else if (eventsRes.reason instanceof ApiRequestError && (eventsRes.reason.status === 401 || eventsRes.reason.status === 403)) {
      setEventsEnabled(false);
      setEvents([]);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const items = await listStrategies();
      strategiesRef.current = items;
      setStrategies(items);
      const firstSymbol = (items[0]?.symbol ?? "").toUpperCase();
      const initial = COINS.some((coin) => coin.symbol === firstSymbol) ? firstSymbol : COINS[0].symbol;
      setCoinSymbol(initial);
      const target = items.find((item) => (item.symbol ?? "").toUpperCase() === initial) ?? null;
      await refresh(target?.id ?? null);
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
      const target = strategiesRef.current.find((item) => (item.symbol ?? "").toUpperCase() === coinRef.current);
      void refresh(target?.id ?? null);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loading, refresh]);

  const handleSelectCoin = (symbol: string) => {
    setCoinSymbol(symbol);
    const target = strategiesRef.current.find((item) => (item.symbol ?? "").toUpperCase() === symbol);
    setTunerDraft(null);
    setTunerTemplate(null);
    void refresh(target?.id ?? null);
  };

  const togglePause = async (strategyId: number, paused: boolean) => {
    setPauseBusyId(strategyId);
    try {
      const saved = await setPauseEntries(strategyId, paused);
      setStrategies((prev) => prev.map((item) => (item.id === strategyId ? { ...item, pauseEntries: saved.pauseEntries } : item)));
      strategiesRef.current = strategiesRef.current.map((item) =>
        item.id === strategyId ? { ...item, pauseEntries: saved.pauseEntries } : item,
      );
      setEngine((current) => (current && current.strategyId === strategyId ? { ...current, pauseEntries: saved.pauseEntries } : current));
    } catch (err) {
      setLoadError(errorText(err, "更新暂停开仓失败"));
    } finally {
      setPauseBusyId(null);
    }
  };

  const applyTemplate = (params: TemplateParams, name: string) => {
    setTunerDraft(params);
    setTunerTemplate(name);
  };

  const historyEntries = useMemo(() => {
    const fromOrders = orders?.entries ?? [];
    const fromState = engine?.entries ?? [];
    const seen = new Set<string>();
    const merged = [...fromOrders, ...fromState].filter((entry) => {
      const key = `${entry.openedAt}-${entry.entryPrice}-${entry.side}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return merged;
  }, [orders, engine]);

  const levels = engine?.state === "InPosition" || position?.open
    ? { entryPrice: position?.entryPrice ?? engine?.entryPrice, stopPrice: engine?.stopPrice, takeProfitPrice: engine?.takeProfitPrice }
    : engine ? { entryPrice: engine.entryPrice, stopPrice: engine.stopPrice, takeProfitPrice: engine.takeProfitPrice } : undefined;

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
              总余额首屏、K 线与仓位标记融合展示，参数、历史与决策记录同屏查看；下方是交易系统（决策模板、调参、自动化、网格、机器人）。
            </p>
          </div>
        </header>

        {loadError ? (
          <p className={styles.errorBar} role="alert">
            {loadError}
            <Button variant="secondary" size="sm" onClick={() => void load()}>重试</Button>
          </p>
        ) : null}

        <CoinSelector value={coinSymbol} onChange={handleSelectCoin} strategyCount={strategyCount} />

        <BalanceHero coin={coin} balance={balance} loading={loading} error={balanceError} />

        <div className={styles.main}>
          <section className={styles.panel} aria-label="行情图表">
            <header className={styles.panelHeadRow}>
              <div>
                <h2 className={styles.panelTitle}>
                  {coin.name} {coin.symbol} · {strategy?.timeframe ?? "--"}
                </h2>
                <p className={styles.panelDesc}>
                  K 线来自引擎行情接口；有持仓时入场 / 止损 / 止盈线直接画在图上，标记价常驻。
                </p>
              </div>
            </header>
            <PositionCard position={position} coin={coin} />
            <div className={styles.chartWrap}>
              {market && market.klines.length > 0 ? (
                <LightweightCandleChart
                  timeframe={strategy?.timeframe ?? market.timeframe}
                  candles={market.klines}
                  markPrice={market.markPrice}
                  levels={levels}
                  positionOpen={position?.open ?? null}
                />
              ) : (
                <p className={styles.emptyText}>{loading ? "正在读取 K 线…" : "暂无 K 线数据。"}</p>
              )}
            </div>
          </section>

          <aside className={styles.rail} aria-label="数据面板">
            <Tabs defaultValue="params" className={styles.railTabs}>
              <TabsList aria-label="数据面板切换">
                <TabsTrigger value="params">参数</TabsTrigger>
                <TabsTrigger value="history">历史记录</TabsTrigger>
                <TabsTrigger value="decisions">决策记录</TabsTrigger>
              </TabsList>
              <TabsContent value="params">
                <ParamPanel strategy={strategy} />
              </TabsContent>
              <TabsContent value="history">
                <HistoryPanel entries={historyEntries} />
              </TabsContent>
              <TabsContent value="decisions">
                <DecisionLogPanel events={events} enabled={eventsEnabled} />
              </TabsContent>
            </Tabs>
          </aside>
        </div>

        <section className={styles.panel} aria-label="交易系统">
          <header className={styles.panelHeadRow}>
            <div>
              <h2 className={styles.panelTitle}>交易系统</h2>
              <p className={styles.panelDesc}>
                决策模板与调参为本地草稿；自动化开关与机器人启停走真实接口，立即生效。
              </p>
            </div>
          </header>
          <Tabs defaultValue="templates">
            <TabsList aria-label="交易系统切换">
              <TabsTrigger value="templates">决策模板</TabsTrigger>
              <TabsTrigger value="tuner">决策调参</TabsTrigger>
              <TabsTrigger value="automation">自动化</TabsTrigger>
              <TabsTrigger value="grid">网格策略</TabsTrigger>
              <TabsTrigger value="bots">交易机器人</TabsTrigger>
            </TabsList>
            <TabsContent value="templates">
              <StrategyTemplates onApply={applyTemplate} activeId={null} />
            </TabsContent>
            <TabsContent value="tuner">
              <ParamTuner
                draft={tunerDraft ?? templateParamsOf(strategy)}
                onChange={(next) => { setTunerDraft(next); setTunerTemplate(null); }}
                templateName={tunerTemplate}
              />
            </TabsContent>
            <TabsContent value="automation">
              <AutomationPanel
                strategy={strategy}
                engine={engine}
                pauseBusy={pauseBusyId === strategy?.id}
                onTogglePause={(paused) => { if (strategy) void togglePause(strategy.id, paused); }}
              />
            </TabsContent>
            <TabsContent value="grid">
              <GridConfig />
            </TabsContent>
            <TabsContent value="bots">
              <BotList
                strategies={strategies}
                engines={engines}
                pauseBusyId={pauseBusyId}
                onTogglePause={(id, paused) => void togglePause(id, paused)}
              />
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </AdminLayout>
  );
}
