import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Select, Space, Tabs } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { binanceApi, EnvTag } from "../components/binance/shared";
import Overview from "../components/binance/Overview";
import Positions from "../components/binance/Positions";
import Strategies from "../components/binance/Strategies";
import Orders from "../components/binance/Orders";
import Backtests from "../components/binance/Backtests";
import Settings from "../components/binance/Settings";

const views = ["overview", "positions", "strategies", "backtests", "orders", "settings"];
const empty = { accounts: [], positions: [], strategies: [], orders: [], curve: [], summary: null, status: null };

export default function OdBinancePage() {
  const { message } = AntApp.useApp();
  const [params, setParams] = useSearchParams();
  const tab = views.includes(params.get("view")) ? params.get("view") : "overview";
  const requestedAccount = Number(params.get("account")) || 0;
  const [data, setData] = useState(empty);
  const [accountId, setAccountId] = useState(requestedAccount);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState({});
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const actionLocks = useRef(new Set());
  const alive = useRef(true);
  const loadRef = useRef(null);
  const account = data.accounts.find((item) => item.id === accountId);

  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    loadingRef.current = true;
    try {
      const accounts = await binanceApi.get("/accounts");
      const active = accounts.filter((item) => item.active);
      const intended = requestedAccount || accountId;
      const chosen = active.some((item) => item.id === intended) ? intended : active[0]?.id || 0;
      const query = chosen ? `?account_id=${chosen}` : "";
      // 没有账户时不请求跨账户聚合，避免显示已停用账户的仓位。
      const [summary, positions, strategies, orders, curve, status] = await Promise.all([
        binanceApi.get(`/dashboard${query}`), chosen ? binanceApi.get(`/positions${query}`) : [],
        binanceApi.get("/strategies"), chosen ? binanceApi.get(`/orders${query}`) : [],
        chosen ? binanceApi.get(`/equity${query}`) : [], binanceApi.get("/status"),
      ]);
      if (!alive.current || version !== generation.current) return;
      setData({ accounts, summary, positions, strategies: strategies.filter((item) => item.accountId === chosen), orders, curve, status });
      if (chosen !== accountId) setAccountId(chosen);
      // 默认账户也写入 URL，刷新/切主题/浏览器前进后退都保持同一账户。
      if (chosen !== requestedAccount) {
        setParams((current) => {
          const next = new URLSearchParams(current);
          if (chosen) next.set("account", String(chosen)); else next.delete("account");
          return next;
        }, { replace: true });
      }
      setLoadError("");
    } catch (e) {
      if (alive.current && version === generation.current) setLoadError(e.message);
    } finally {
      if (alive.current && version === generation.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [accountId, requestedAccount, setParams]);
  loadRef.current = load;
  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(() => { if (!document.hidden && !loadingRef.current) load(); }, 10000);
    return () => { alive.current = false; generation.current++; clearInterval(timer); };
  }, [load]);
  useEffect(() => { if (requestedAccount) setAccountId(requestedAccount); }, [requestedAccount]);
  useEffect(() => { setData((prev) => ({ ...prev, summary: null, positions: [], strategies: [], orders: [], curve: [] })); }, [accountId]);

  const act = async (key, action, success) => {
    if (actionLocks.current.has(key)) throw new Error("操作正在处理中");
    actionLocks.current.add(key);
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const result = await action();
      if (success) message.success(success);
      // 交易完成期间可能已经换了账户；刷新此刻选中的账户，不能用旧闭包切回去。
      await loadRef.current();
      return result;
    } catch (e) {
      message.error(e.message);
      throw e;
    } finally {
      actionLocks.current.delete(key);
      if (alive.current) setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };
  const change = (key, value) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next);
  };
  const common = { ...data, account, accountId, act, busy, loading };
  const items = [
    { key: "overview", label: "总览", children: <Overview {...common} onView={(value) => change("view", value)} /> },
    { key: "positions", label: "仓位", children: <Positions {...common} /> },
    { key: "strategies", label: "策略", children: <Strategies {...common} /> },
    { key: "backtests", label: "回测", children: <Backtests {...common} /> },
    { key: "orders", label: "订单", children: <Orders {...common} /> },
    { key: "settings", label: "配置", children: <Settings {...common} /> },
  ];
  return <div className="oo-binance">
    <PageHeader title="OD Binance" tags={account && <EnvTag value={account.environment} />} extra={<Space wrap>
      <Select aria-label="币安账户" className="oo-binance-account-select" value={accountId || undefined} placeholder="选择账户"
        options={data.accounts.filter((item) => item.active).map((item) => ({ value: item.id, label: item.name }))}
        onChange={(value) => { setAccountId(value); change("account", String(value)); }} />
      <Button icon={<ReloadOutlined />} loading={loading || busy.sync} disabled={!accountId} onClick={() => { act("sync", () => binanceApi.post(`/accounts/${accountId}/sync`), "账户已同步").catch(() => {}); }}>同步</Button>
    </Space>} />
    {loadError && <Alert showIcon type="error" message={loadError} action={<Button size="small" loading={loading} onClick={load}>重试</Button>} />}
    <Tabs activeKey={tab} onChange={(value) => change("view", value)} destroyInactiveTabPane items={items} />
  </div>;
}
