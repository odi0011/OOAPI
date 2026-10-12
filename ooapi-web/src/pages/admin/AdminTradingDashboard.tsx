import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/arc/button/button";
import AdminLayout from "@/components/admin/AdminLayout";
import { ApiRequestError } from "@/lib/api";

import styles from "./TradingDesk.module.css";
import EngineOverview from "./EngineOverview";
import TradingDesk, { type DeskReadErrors } from "./TradingDesk";
import {
  mapEnginesPayload,
  resolveSelectedStrategyId,
  type TradingEnginesSnapshot,
} from "./engineOverview";
import { ACCOUNT_PATH, STRATEGY_PATH } from "./settingsNav";
import {
  getEngineMarket,
  getEngineOrders,
  getEnginePosition,
  getEngineState,
  listStrategies,
  listTradingEngines,
  setPauseEntries,
  type EngineMarket,
  type EngineOrders,
  type EnginePosition,
  type EngineState,
  type Strategy,
} from "./tradingApi";

/**
 * 交易数据看板。多品种一览，以及选中引擎的状态、K 线、持仓、委托和已实现盈亏。
 * 暂停新开仓会立刻写入策略。其余配置不在这里改，也不调用测网全绿接口。
 * /api/trading/engines 404 或失败时，仍按原来的第一份策略展示，不留白页。
 */

const ENGINE_POLL_MS = 5000;

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export default function AdminTradingDashboard() {
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [overview, setOverview] = useState<TradingEnginesSnapshot | null>(null);
  const [multi, setMulti] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [market, setMarket] = useState<EngineMarket | null>(null);
  const [position, setPosition] = useState<EnginePosition | null>(null);
  const [orders, setOrders] = useState<EngineOrders | null>(null);
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

  const refreshDesk = useCallback(async (id: number | null) => {
    const gen = ++deskGen.current;
    if (id == null) {
      setEngine(null);
      setMarket(null);
      setPosition(null);
      setOrders(null);
      setReadErrors({});
      return;
    }
    const [state, marketRes, positionRes, ordersRes] = await Promise.allSettled([
      getEngineState(id),
      getEngineMarket(id, 100),
      getEnginePosition(id),
      getEngineOrders(id),
    ]);
    if (gen !== deskGen.current) return;
    if (state.status === "rejected" && state.reason instanceof ApiRequestError && state.reason.status === 404) {
      setEngine(null);
      setMarket(null);
      setPosition(null);
      setOrders(null);
      setReadErrors({});
      return;
    }
    const nextErrors: DeskReadErrors = {};
    if (state.status === "fulfilled") setEngine(state.value);
    else nextErrors.state = errorText(state.reason, "读取状态失败");
    if (marketRes.status === "fulfilled") setMarket(marketRes.value);
    else nextErrors.market = errorText(marketRes.reason, "读取 K 线失败");
    if (positionRes.status === "fulfilled") setPosition(positionRes.value);
    else nextErrors.position = errorText(positionRes.reason, "读取持仓失败");
    if (ordersRes.status === "fulfilled") setOrders(ordersRes.value);
    else nextErrors.orders = errorText(ordersRes.reason, "读取委托失败");
    setReadErrors(nextErrors);
  }, []);

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
    setStrategy(strategiesRef.current.find((item) => item.id === id) ?? null);
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
    setStrategy(strategiesRef.current.find((item) => item.id === strategyId) ?? null);
    setDismissedError("");
    void refreshDesk(strategyId);
  };

  const selectedSummary = overview?.engines.find((item) => item.strategyId === selectedId);

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
            <p className={styles.pageLead}>
              看状态、K 线、持仓、委托和本会话盈亏。策略配置在
              <Link to={STRATEGY_PATH}>系统设置</Link>
              ，交易所密钥在
              <Link to={ACCOUNT_PATH}>账户</Link>
              。
            </p>
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

        <TradingDesk
          engine={engine}
          market={market}
          position={position}
          orders={orders}
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
