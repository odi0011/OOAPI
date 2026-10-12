import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/arc/button/button";
import AdminLayout from "@/components/admin/AdminLayout";
import { ApiRequestError } from "@/lib/api";

import styles from "./TradingDesk.module.css";
import TradingDesk, { type DeskReadErrors } from "./TradingDesk";
import { ACCOUNT_PATH, STRATEGY_PATH } from "./settingsNav";
import {
  getEngineMarket,
  getEngineOrders,
  getEnginePosition,
  getEngineState,
  listStrategies,
  type EngineMarket,
  type EngineOrders,
  type EnginePosition,
  type EngineState,
  type Strategy,
} from "./tradingApi";

/**
 * 交易数据看板。只读：状态、K 线、持仓、委托、本会话盈亏。
 * 不改策略，不绑定账户，不调用测网全绿接口。
 */

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export default function AdminTradingDashboard() {
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [market, setMarket] = useState<EngineMarket | null>(null);
  const [position, setPosition] = useState<EnginePosition | null>(null);
  const [orders, setOrders] = useState<EngineOrders | null>(null);
  const [readErrors, setReadErrors] = useState<DeskReadErrors>({});
  const [dismissedError, setDismissedError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshDesk = useCallback(async (id: number | null) => {
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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const items = await listStrategies();
      const current = items[0] ?? null;
      setStrategy(current);
      await refreshDesk(current?.id ?? null);
    } catch (err) {
      setLoadError(errorText(err, "加载数据看板失败"));
    } finally {
      setLoading(false);
    }
  }, [refreshDesk]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = strategy?.id;
    if (id == null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshDesk(id);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshDesk, strategy?.id]);

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

        <TradingDesk
          engine={engine}
          market={market}
          position={position}
          orders={orders}
          loading={loading}
          readErrors={readErrors}
          symbol={strategy?.symbol}
          leverage={strategy?.leverage}
          marginMode={strategy?.marginMode}
          timeframe={strategy?.timeframe}
          mode={strategy?.mode}
          dismissedError={dismissedError}
          onDismissError={() => setDismissedError(engine?.lastError?.trim() ?? "")}
        />
      </div>
    </AdminLayout>
  );
}
