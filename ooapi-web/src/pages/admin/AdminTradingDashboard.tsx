import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/arc/button/button";
import AdminLayout from "@/components/admin/AdminLayout";
import { ApiRequestError } from "@/lib/api";

import styles from "./TradingDesk.module.css";
import EngineOverview from "./EngineOverview";
import LiveBalancePanel from "./LiveBalancePanel";
import TradingDesk, { type DeskCoinChartItem, type DeskReadErrors } from "./TradingDesk";
import {
  mapEnginesPayload,
  resolveSelectedStrategyId,
  type TradingEnginesSnapshot,
} from "./engineOverview";
import {
  getEngineBalance,
  getEngineEvents,
  getEngineMarket,
  getEngineMarketForCoin,
  getEngineOrders,
  getEnginePosition,
  getEngineState,
  listStrategies,
  listTradingEngines,
  postEngineBoost,
  setPauseEntries,
  type DetectionEvent,
  type EngineBalance,
  type EngineMarket,
  type EngineOrders,
  type EnginePosition,
  type EngineState,
  type Strategy,
} from "./tradingApi";
import { COINS, coinInfoOf } from "./tradingBoard/coins";

/**
 * 交易数据看板。多品种一览，账户实时余额，以及多币种宫格 K 线、选中引擎的状态、持仓、委托和已实现盈亏。
 * 暂停新开仓会立刻写入策略。其余配置不在这里改，也不调用测网全绿接口。
 * /api/trading/engines 404 或失败时，仍按原来的第一份策略展示，不留白页。
 */

const ENGINE_POLL_MS = 5000;
const GRID_KLINE_LIMIT = 120;

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export default function AdminTradingDashboard() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [overview, setOverview] = useState<TradingEnginesSnapshot | null>(null);
  const [multi, setMulti] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedCoinSymbol, setSelectedCoinSymbol] = useState<string>(COINS[0].symbol);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [market, setMarket] = useState<EngineMarket | null>(null);
  const [marketsBySymbol, setMarketsBySymbol] = useState<Record<string, EngineMarket>>({});
  const [position, setPosition] = useState<EnginePosition | null>(null);
  const [orders, setOrders] = useState<EngineOrders | null>(null);
  const [balance, setBalance] = useState<EngineBalance | null>(null);
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [eventsEnabled, setEventsEnabled] = useState(false);
  const [boostUntil, setBoostUntil] = useState("");
  const [boostBusy, setBoostBusy] = useState(false);
  const [boostError, setBoostError] = useState("");
  const [readErrors, setReadErrors] = useState<DeskReadErrors>({});
  const [dismissedError, setDismissedError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pauseBusyId, setPauseBusyId] = useState<number | null>(null);

  const strategiesRef = useRef<Strategy[]>([]);
  const chosenRef = useRef<number | null>(null);
  const overviewGen = useRef(0);
  const deskGen = useRef(0);

  const refreshCoinGridMarkets = useCallback(async (allStrategies: Strategy[]) => {
    const coinsToFetch = [...COINS];
    const seen = new Set(coinsToFetch.map((c) => c.symbol));
    for (const item of allStrategies) {
      const sym = (item.symbol ?? "").toUpperCase();
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        coinsToFetch.push(coinInfoOf(sym));
      }
    }
    const results = await Promise.all(
      coinsToFetch.map(async (coinItem) => {
        const coinStrategy =
          allStrategies.find((item) => (item.symbol ?? "").toUpperCase() === coinItem.symbol) ?? null;
        const mktRes = await getEngineMarketForCoin(coinItem.symbol, {
          strategyId: coinStrategy?.id ?? null,
          timeframe: coinStrategy?.timeframe ?? "5m",
          limit: GRID_KLINE_LIMIT,
        }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        return { symbol: coinItem.symbol, mktRes };
      }),
    );
    const nextMarkets: Record<string, EngineMarket> = {};
    for (const item of results) {
      if (item.mktRes.status === "fulfilled") {
        const mkt = item.mktRes.value;
        if (!mkt.symbol || mkt.symbol.toUpperCase() === item.symbol) {
          nextMarkets[item.symbol] = mkt;
        }
      }
    }
    setMarketsBySymbol((prev) => ({ ...prev, ...nextMarkets }));
  }, []);

  const refreshDesk = useCallback(async (id: number | null) => {
    const gen = ++deskGen.current;
    void refreshCoinGridMarkets(strategiesRef.current);
    if (id == null) {
      setEngine(null);
      setMarket(null);
      setPosition(null);
      setOrders(null);
      setBalance(null);
      setReadErrors({});
      return;
    }
    const [state, marketRes, positionRes, ordersRes, balanceRes, eventsRes] = await Promise.allSettled([
      getEngineState(id),
      getEngineMarket(id, 100),
      getEnginePosition(id),
      getEngineOrders(id),
      getEngineBalance(id),
      getEngineEvents(),
    ]);
    if (gen !== deskGen.current) return;
    if (state.status === "rejected" && state.reason instanceof ApiRequestError && state.reason.status === 404) {
      setEngine(null);
      setMarket(null);
      setPosition(null);
      setOrders(null);
      setBalance(null);
      setReadErrors({});
      return;
    }
    const nextErrors: DeskReadErrors = {};
    if (state.status === "fulfilled") setEngine(state.value);
    else nextErrors.state = errorText(state.reason, "读取状态失败");
    if (marketRes.status === "fulfilled") {
      setMarket(marketRes.value);
      const activeStrat = strategiesRef.current.find((s) => s.id === id);
      const sym = (marketRes.value.symbol || activeStrat?.symbol || "").toUpperCase();
      if (sym) {
        setMarketsBySymbol((prev) => ({ ...prev, [sym]: marketRes.value }));
      }
    } else nextErrors.market = errorText(marketRes.reason, "读取 K 线失败");
    if (positionRes.status === "fulfilled") setPosition(positionRes.value);
    else nextErrors.position = errorText(positionRes.reason, "读取持仓失败");
    if (ordersRes.status === "fulfilled") setOrders(ordersRes.value);
    else nextErrors.orders = errorText(ordersRes.reason, "读取委托失败");
    if (balanceRes.status === "fulfilled") {
      setBalance(balanceRes.value);
      if (balanceRes.value.boostUntil) setBoostUntil(balanceRes.value.boostUntil);
    } else nextErrors.balance = errorText(balanceRes.reason, "读取账户余额失败");
    if (eventsRes.status === "fulfilled") {
      setEvents(eventsRes.value);
      setEventsEnabled(true);
    } else if (eventsRes.reason instanceof ApiRequestError && (eventsRes.reason.status === 401 || eventsRes.reason.status === 403)) {
      setEventsEnabled(false);
      setEvents([]);
    }
    setReadErrors(nextErrors);
  }, [refreshCoinGridMarkets]);

  const applySnapshot = useCallback((nextMulti: boolean, snapshot: TradingEnginesSnapshot | null) => {
    const fallbackStrategyId = strategiesRef.current[0]?.id ?? null;
    const id = resolveSelectedStrategyId({
      multi: nextMulti,
      engines: snapshot?.engines ?? [],
      current: chosenRef.current,
      fallbackStrategyId,
    });
    if (nextMulti) chosenRef.current = id;
    setSelectedId(id);
    setMulti(nextMulti);
    setOverview(nextMulti ? snapshot : null);
    const matched = strategiesRef.current.find((item) => item.id === id) ?? null;
    setStrategy(matched);
    if (matched?.symbol) {
      setSelectedCoinSymbol(matched.symbol.toUpperCase());
    }
    return id;
  }, []);

  const refreshOverview = useCallback(async () => {
    const gen = ++overviewGen.current;
    let nextMulti = false;
    let snapshot: TradingEnginesSnapshot | null = null;
    try {
      snapshot = mapEnginesPayload(await listTradingEngines());
      nextMulti = true;
    } catch {
      nextMulti = false;
      snapshot = null;
    }
    if (gen !== overviewGen.current) return;
    const id = applySnapshot(nextMulti, snapshot);
    await refreshDesk(id);
  }, [applySnapshot, refreshDesk]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const items = await listStrategies();
      strategiesRef.current = items;
      setStrategies(items);
      await refreshOverview();
      setLoaded(true);
    } catch (err) {
      setLoadError(errorText(err, "加载数据看板失败"));
    } finally {
      setLoading(false);
    }
  }, [refreshOverview]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshOverview();
    }, ENGINE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loaded, refreshOverview]);

  const selectEngine = (strategyId: number) => {
    chosenRef.current = strategyId;
    setSelectedId(strategyId);
    const matched = strategiesRef.current.find((item) => item.id === strategyId) ?? null;
    setStrategy(matched);
    if (matched?.symbol) {
      setSelectedCoinSymbol(matched.symbol.toUpperCase());
    }
    setDismissedError("");
    void refreshDesk(strategyId);
  };

  const selectedSummary = overview?.engines.find((item) => item.strategyId === selectedId);
  const activeSymbol = (strategy?.symbol || selectedSummary?.symbol || selectedCoinSymbol || COINS[0].symbol).toUpperCase();

  const coinCharts = useMemo<DeskCoinChartItem[]>(() => {
    const list = [...COINS];
    const seen = new Set(list.map((c) => c.symbol));
    for (const item of strategies) {
      const sym = (item.symbol ?? "").toUpperCase();
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        list.push(coinInfoOf(sym));
      }
    }
    return list.map((coinItem) => {
      const coinStrat = strategies.find((s) => (s.symbol ?? "").toUpperCase() === coinItem.symbol) ?? null;
      const isSelected = coinItem.symbol === activeSymbol;
      const mkt = marketsBySymbol[coinItem.symbol] ?? (isSelected ? market : null);
      return {
        symbol: coinItem.symbol,
        name: coinItem.name,
        timeframe: coinStrat?.timeframe ?? mkt?.timeframe ?? "5m",
        market: mkt,
        positionOpen: isSelected ? (position == null ? null : position.open === true) : null,
        selected: isSelected,
        strategyId: coinStrat?.id ?? null,
        onSelect: () => {
          setSelectedCoinSymbol(coinItem.symbol);
          if (coinStrat) {
            selectEngine(coinStrat.id);
          }
        },
      };
    });
  }, [strategies, activeSymbol, marketsBySymbol, market, position]);

  const togglePause = async (strategyId: number, paused: boolean) => {
    setPauseBusyId(strategyId);
    try {
      const saved = await setPauseEntries(strategyId, paused);
      setEngine((current) => (current && current.strategyId === strategyId ? { ...current, pauseEntries: saved.pauseEntries } : current));
      setOverview((current) => {
        if (!current) return current;
        return {
          ...current,
          engines: current.engines.map((item) =>
            item.strategyId === strategyId ? { ...item, pauseEntries: saved.pauseEntries } : item,
          ),
        };
      });
      setStrategy((current) => (current && current.id === strategyId ? { ...current, pauseEntries: saved.pauseEntries } : current));
    } catch (err) {
      setLoadError(errorText(err, "更新暂停开仓失败"));
    } finally {
      setPauseBusyId(null);
    }
  };

  const triggerBoost = async () => {
    setBoostBusy(true);
    setBoostError("");
    try {
      const result = await postEngineBoost();
      if (result.until) setBoostUntil(result.until);
      if (!result.ok && result.status !== 429) {
        setBoostError("加速失败");
      }
      const nextEvents = await getEngineEvents().catch(() => null);
      if (nextEvents) {
        setEvents(nextEvents);
        setEventsEnabled(true);
      }
    } catch (err) {
      setBoostError(errorText(err, "加速失败"));
    } finally {
      setBoostBusy(false);
    }
  };

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
            <h1 className={styles.pageTitle}>数据看板</h1>
          </div>
        </header>

        {loadError ? (
          <p className={styles.readError} role="alert">
            {loadError}
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </p>
        ) : null}

        {multi && overview ? (
          <EngineOverview
            snapshot={overview}
            selectedId={selectedId}
            onSelect={selectEngine}
            pauseBusyId={pauseBusyId}
            onTogglePause={(strategyId, paused) => void togglePause(strategyId, paused)}
          />
        ) : null}

        <LiveBalancePanel
          balance={balance}
          loading={loading}
          error={readErrors.balance}
          orders={orders}
          events={events}
          eventsEnabled={eventsEnabled}
          boostUntil={boostUntil}
          boostBusy={boostBusy}
          boostError={boostError}
          onBoost={() => void triggerBoost()}
        />

        <TradingDesk
          engine={engine}
          market={market}
          position={position}
          orders={orders}
          coinCharts={coinCharts}
          loading={loading}
          readErrors={readErrors}
          symbol={strategy?.symbol || selectedSummary?.symbol}
          leverage={strategy?.leverage}
          marginMode={strategy?.marginMode}
          timeframe={strategy?.timeframe}
          mode={strategy?.mode}
          dismissedError={dismissedError}
          onDismissError={() => setDismissedError(engine?.lastError?.trim() ?? "")}
          pauseBusy={selectedId != null && pauseBusyId === selectedId}
          onTogglePauseEntries={
            selectedId == null ? undefined : (paused) => void togglePause(selectedId, paused)
          }
        />
      </div>
    </AdminLayout>
  );
}
