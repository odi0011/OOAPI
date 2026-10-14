import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AdminLayout from "@/components/admin/AdminLayout";
import { Button } from "@/components/arc/button/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { ApiRequestError } from "@/lib/api";

import {
  DEFAULT_EXCHANGE_KEY_ID,
  DEFAULT_STRATEGY_MODE,
  createStrategy,
  getEngineBalance,
  getEngineEvents,
  getEngineMarket,
  getEngineMarketForCoin,
  getEngineOrders,
  getEnginePosition,
  getEngineState,
  listExchangeKeys,
  listStrategies,
  listTradingEngines,
  postEngineBoost,
  resumeEngine,
  setPauseEntries,
  startEngine,
  stepEngine,
  stopEngine,
  updateStrategy,
  type DetectionEvent,
  type EngineBalance,
  type EngineKline,
  type EngineMarket,
  type EngineOrders,
  type EnginePosition,
  type EngineState,
  type ExchangeKey,
  type Strategy,
  type StrategyWrite,
} from "./tradingApi";
import LightweightCandleChart from "./LightweightCandleChart";
import AnalyticsBlocks from "./tradingBoard/AnalyticsBlocks";
import {
  BalanceHero,
  CoinSelector,
  DecisionLogPanel,
  HistoryPanel,
  ParamPanel,
  PositionCard,
  QuickTradePanel,
  type SimulatedOrderDraft,
} from "./tradingBoard/BoardPanels";
import CoinIcon from "./tradingBoard/CoinIcon";
import {
  COINS,
  buildActiveOrPreviewPosition,
  buildEffectiveBalance,
  buildEffectiveHistoryAndOrders,
  buildRichDecisionRecords,
  buildSyntheticKlines,
  coinInfoOf,
  roundToPrecision,
} from "./tradingBoard/coins";
import FusedMarketOverview from "./tradingBoard/FusedMarketOverview";
import MillisecondMarketChart, {
  type GridOverlaySpec,
  type TickSpeedMs,
} from "./tradingBoard/MillisecondMarketChart";
import {
  AutomationPanel,
  BotList,
  GridConfig,
  ParamTuner,
  StrategyTemplates,
  normalizeMinScore,
  templateParamsOf,
  type TemplateParams,
} from "./tradingBoard/TradingSystem";

import styles from "./TradingBoard.module.css";

/**
 * 交易数据看板（/admin/trading/board）：
 * - 首屏：多币种结构化详情选择器 + 总余额/净值曲线首屏 + 多币种宫格 K 线 + 毫秒级行情终端主图（含仓位融合图层） + 右侧快速执行/参数/历史/决策面板
 * - 交易系统：决策模板、决策调参（含期望收益扇形推演与真实后端保存）、自动化与引擎生命周期控制、网格工作台、多币种交易机器人矩阵
 * - 多维分析块：UIArc Small Multiples、净值归因瀑布图、风控预算偏差、信号热力与门控漏斗
 */

const POLL_MS = 5000;
const GRID_KLINE_LIMIT = 120;

interface BoardCoinFetch {
  symbol: string;
  strategyId: number | null;
  mktRes: PromiseSettledResult<EngineMarket>;
  stateRes: PromiseSettledResult<EngineState>;
  posRes: PromiseSettledResult<EnginePosition>;
}

/** 宫格币种：预设币种，再加上策略里出现的自定义交易对。 */
function boardCoinsFrom(strategies: Strategy[]) {
  const list = [...COINS];
  const seen = new Set(list.map((item) => item.symbol));
  for (const item of strategies) {
    const symbol = (item.symbol ?? "").toUpperCase();
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      list.push(coinInfoOf(symbol));
    }
  }
  return list;
}

async function fetchBoardCoinGrid(allStrategies: Strategy[]): Promise<BoardCoinFetch[]> {
  return Promise.all(
    boardCoinsFrom(allStrategies).map(async (coinItem) => {
      const coinStrategy =
        allStrategies.find((item) => (item.symbol ?? "").toUpperCase() === coinItem.symbol) ?? null;
      const [mktRes, stateRes, posRes] = await Promise.allSettled([
        getEngineMarketForCoin(coinItem.symbol, {
          strategyId: coinStrategy?.id ?? null,
          timeframe: coinStrategy?.timeframe ?? "5m",
          limit: GRID_KLINE_LIMIT,
        }),
        coinStrategy ? getEngineState(coinStrategy.id) : Promise.reject(new Error("no_strategy")),
        coinStrategy ? getEnginePosition(coinStrategy.id) : Promise.reject(new Error("no_strategy")),
      ]);
      return {
        symbol: coinItem.symbol,
        strategyId: coinStrategy?.id ?? null,
        mktRes,
        stateRes,
        posRes,
      };
    }),
  );
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export default function TradingBoard() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [exchangeKeys, setExchangeKeys] = useState<ExchangeKey[]>([]);
  const [coinSymbol, setCoinSymbol] = useState<string>(COINS[0]!.symbol);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [market, setMarket] = useState<EngineMarket | null>(null);
  const [marketsBySymbol, setMarketsBySymbol] = useState<Record<string, EngineMarket>>({});
  const [position, setPosition] = useState<EnginePosition | null>(null);
  const [positionsBySymbol, setPositionsBySymbol] = useState<Record<string, EnginePosition>>({});
  const [orders, setOrders] = useState<EngineOrders | null>(null);
  const [balance, setBalance] = useState<EngineBalance | null>(null);
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [eventsEnabled, setEventsEnabled] = useState(true);
  const [engines, setEngines] = useState<Map<number, EngineState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | undefined>(undefined);

  // 引擎与策略交互状态
  const [pauseBusyId, setPauseBusyId] = useState<number | null>(null);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);
  const [engineActionBusy, setEngineActionBusy] = useState<string | null>(null);
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [creatingSymbol, setCreatingSymbol] = useState<string | null>(null);
  const [boostBusy, setBoostBusy] = useState(false);

  // 模板与调参状态
  const [tunerDraft, setTunerDraft] = useState<TemplateParams | null>(null);
  const [tunerTemplate, setTunerTemplate] = useState<string | null>(null);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [systemTab, setSystemTab] = useState<string>("templates");

  // 毫秒级图表与仓位融合交互状态
  const [timeframe, setTimeframe] = useState<string>("1s");
  const [streamPlaying, setStreamPlaying] = useState<boolean>(true);
  const [tickIntervalMs, setTickIntervalMs] = useState<TickSpeedMs>(250);
  const [tickCount, setTickCount] = useState<number>(0);
  const [tickDelta, setTickDelta] = useState<number>(0);
  const [showPositionOverlay, setShowPositionOverlay] = useState<boolean>(true);
  const [previewPositionEnabled, setPreviewPositionEnabled] = useState<boolean>(true);
  const [customOrder, setCustomOrder] = useState<SimulatedOrderDraft | null>(null);
  const [gridOverlay, setGridOverlay] = useState<GridOverlaySpec>({
    enabled: false,
    upper: roundToPrecision(COINS[0]!.basePrice * 1.045, COINS[0]!.precision),
    lower: roundToPrecision(COINS[0]!.basePrice * 0.955, COINS[0]!.precision),
    count: 10,
    mode: "arithmetic",
  });
  const [activeDecisionId, setActiveDecisionId] = useState<string | null>(null);

  // 多币种实时毫秒级微跳价格池
  const [livePrices, setLivePrices] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const c of COINS) init[c.symbol] = c.basePrice;
    return init;
  });
  const [syntheticKlines, setSyntheticKlines] = useState<EngineKline[]>(() =>
    buildSyntheticKlines(COINS[0]!, "1s", 96),
  );

  const strategiesRef = useRef<Strategy[]>([]);
  const coinRef = useRef(coinSymbol);
  coinRef.current = coinSymbol;
  const genRef = useRef(0);

  const strategyCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of strategies) {
      const symbol = (item.symbol ?? "").toUpperCase();
      counts[symbol] = (counts[symbol] ?? 0) + 1;
    }
    return counts;
  }, [strategies]);

  /** 宫格展示的全部币种：预设币种 + 策略中出现的自定义币种。 */
  const boardCoins = useMemo(() => boardCoinsFrom(strategies), [strategies]);

  /** 当前币种命中的策略：优先同 symbol 的第一条。 */
  const strategy = useMemo(
    () => strategies.find((item) => (item.symbol ?? "").toUpperCase() === coinSymbol) ?? null,
    [strategies, coinSymbol],
  );

  const coin = useMemo(() => coinInfoOf(coinSymbol), [coinSymbol]);

  // 切换币种或周期时重建基准合成 K 线序列
  useEffect(() => {
    const c = coinInfoOf(coinSymbol);
    setSyntheticKlines(buildSyntheticKlines(c, timeframe, 96, livePrices[c.symbol] ?? c.basePrice));
  }, [coinSymbol, timeframe]);

  // 毫秒级行情流定时器（更新当前 K 线收最高低与全币种微跳价格）
  useEffect(() => {
    if (!streamPlaying) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      setTickCount((c) => c + 1);

      setLivePrices((prev) => {
        const next = { ...prev };
        for (const item of COINS) {
          const cur = prev[item.symbol] ?? item.basePrice;
          const drift = (Math.random() - 0.492) * item.basePrice * 0.00055;
          const updatedPrice = Math.max(
            item.tickSize * 10,
            roundToPrecision(cur + drift, item.precision),
          );
          if (item.symbol === coinRef.current) {
            setTickDelta(roundToPrecision(updatedPrice - cur, item.precision));
          }
          next[item.symbol] = updatedPrice;
        }
        return next;
      });

      setSyntheticKlines((prev) => {
        if (prev.length === 0) return prev;
        const c = coinInfoOf(coinRef.current);
        const last = prev[prev.length - 1]!;
        const delta = (Math.random() - 0.49) * c.basePrice * 0.0006;
        const nextClose = Math.max(
          c.tickSize * 10,
          roundToPrecision(last.close + delta, c.precision),
        );
        const nextHigh = Math.max(last.high, nextClose);
        const nextLow = Math.min(last.low, nextClose);
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...last,
          close: nextClose,
          high: nextHigh,
          low: nextLow,
        };
        return updated;
      });
    }, tickIntervalMs);
    return () => window.clearInterval(timer);
  }, [streamPlaying, tickIntervalMs]);

  const refresh = useCallback(async (strategyId: number | null) => {
    const gen = ++genRef.current;
    const gridPromise = fetchBoardCoinGrid(strategiesRef.current);
    if (strategyId == null) {
      setEngine(null);
      setMarket(null);
      setPosition(null);
      setOrders(null);
      setBalance(null);
      setBalanceError(undefined);
    }
    const focusedPromise =
      strategyId == null
        ? Promise.resolve(null)
        : Promise.allSettled([
            getEngineState(strategyId),
            getEngineMarket(strategyId, 200),
            getEnginePosition(strategyId),
            getEngineOrders(strategyId),
            getEngineBalance(strategyId),
            getEngineEvents(),
          ]);
    const [coinResults, focused] = await Promise.all([gridPromise, focusedPromise]);
    if (gen !== genRef.current) return;

    if (focused) {
      const [stateRes, marketRes, positionRes, ordersRes, balanceRes, eventsRes] = focused;
      if (stateRes.status === "fulfilled") {
        setEngine(stateRes.value);
        setEngines((prev) => new Map(prev).set(strategyId!, stateRes.value));
      }
      if (marketRes.status === "fulfilled") {
        setMarket(marketRes.value);
        if (marketRes.value.markPrice && marketRes.value.markPrice > 0) {
          const sym = marketRes.value.symbol || coinRef.current;
          setLivePrices((prev) => ({ ...prev, [sym]: marketRes.value.markPrice! }));
        }
      }
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
      } else if (
        eventsRes.reason instanceof ApiRequestError &&
        (eventsRes.reason.status === 401 || eventsRes.reason.status === 403)
      ) {
        setEventsEnabled(false);
        setEvents([]);
      }
    }

    const nextMarkets: Record<string, EngineMarket> = {};
    const nextPositions: Record<string, EnginePosition> = {};
    const nextEngineStates = new Map<number, EngineState>();
    const nextPrices: Record<string, number> = {};
    for (const item of coinResults) {
      if (item.mktRes.status === "fulfilled") {
        const mkt = item.mktRes.value;
        // 按 symbol 查询若回退成了其它币种的策略行情，不覆盖这张卡片。
        if (!mkt.symbol || mkt.symbol.toUpperCase() === item.symbol) {
          nextMarkets[item.symbol] = mkt;
          if (mkt.markPrice > 0) nextPrices[item.symbol] = mkt.markPrice;
        }
      }
      if (item.stateRes.status === "fulfilled" && item.strategyId != null) {
        nextEngineStates.set(item.strategyId, item.stateRes.value);
      }
      if (item.posRes.status === "fulfilled") {
        nextPositions[item.symbol] = item.posRes.value;
      }
    }
    if (Object.keys(nextMarkets).length > 0) {
      setMarketsBySymbol((prev) => ({ ...prev, ...nextMarkets }));
    }
    if (Object.keys(nextPositions).length > 0) {
      setPositionsBySymbol((prev) => ({ ...prev, ...nextPositions }));
    }
    if (Object.keys(nextPrices).length > 0) {
      setLivePrices((prev) => ({ ...prev, ...nextPrices }));
    }
    if (nextEngineStates.size > 0) {
      setEngines((prev) => {
        const merged = new Map(prev);
        for (const [id, st] of nextEngineStates) merged.set(id, st);
        if (strategyId != null && focused) {
          const active = focused[0];
          if (active.status === "fulfilled") merged.set(strategyId, active.value);
        }
        return merged;
      });
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [itemsRes, enginesRes, keysRes] = await Promise.allSettled([
        listStrategies(),
        listTradingEngines(),
        listExchangeKeys(),
      ]);
      if (itemsRes.status === "rejected") {
        throw itemsRes.reason;
      }
      const items = itemsRes.value;
      strategiesRef.current = items;
      setStrategies(items);

      if (enginesRes.status === "fulfilled" && enginesRes.value.engines) {
        const map = new Map<number, EngineState>();
        for (const item of enginesRes.value.engines) {
          if ("engine" in item && item.engine) {
            map.set(item.strategy.id, item.engine);
          } else if ("strategyId" in item && typeof item.strategyId === "number") {
            map.set(item.strategyId, item);
          }
        }
        setEngines(map);
      }

      if (keysRes.status === "fulfilled") {
        setExchangeKeys(keysRes.value);
      }

      const firstSymbol = (items[0]?.symbol ?? "").toUpperCase();
      const initial = COINS.some((c) => c.symbol === firstSymbol) ? firstSymbol : COINS[0]!.symbol;
      setCoinSymbol(initial);
      const target = items.find((item) => (item.symbol ?? "").toUpperCase() === initial) ?? null;
      if (target?.timeframe) setTimeframe(target.timeframe);
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
      const target = strategiesRef.current.find(
        (item) => (item.symbol ?? "").toUpperCase() === coinRef.current,
      );
      void refresh(target?.id ?? null);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loading, refresh]);

  const handleSelectCoin = (symbol: string) => {
    setCoinSymbol(symbol);
    setCustomOrder(null);
    setActiveDecisionId(null);
    const target = strategiesRef.current.find((item) => (item.symbol ?? "").toUpperCase() === symbol);
    setTunerDraft(null);
    setTunerTemplate(null);
    if (target?.timeframe) setTimeframe(target.timeframe);
    void refresh(target?.id ?? null);
  };

  /** 构建符合后端校验规则的 StrategyWrite 载荷 */
  const buildStrategyWritePayload = useCallback(
    (targetSymbol: string, params: TemplateParams, baseStrategy: Strategy | null): StrategyWrite => {
      const validKey =
        baseStrategy?.exchangeKeyId ??
        exchangeKeys.find((k) => !k.revoked)?.id ??
        strategiesRef.current[0]?.exchangeKeyId ??
        DEFAULT_EXCHANGE_KEY_ID;
      const emaFast = Math.max(2, Math.min(49, Math.round(params.emaFast)));
      const emaSlow = Math.max(emaFast + 1, Math.min(200, Math.round(params.emaSlow)));
      const minScore = normalizeMinScore(params.minScore);
      const minWinRate = Math.max(0.38, Math.min(0.85, Number(params.minWinRate.toFixed(4))));

      return {
        symbol: targetSymbol,
        leverage: Math.max(1, Math.min(125, Math.round(params.leverage))),
        marginMode: "isolated",
        emaFast,
        emaSlow,
        timeframe: (baseStrategy?.timeframe ?? "5m") as StrategyWrite["timeframe"],
        stopR: Number(Math.max(0.1, params.stopR).toFixed(4)),
        takeProfitR: Number(Math.max(0.2, params.takeProfitR).toFixed(4)),
        rFraction: Number(((params.oneRPct ?? 0.8) / 100).toFixed(6)),
        expectancyTpCapR: Number((params.expectancyTpCapR ?? baseStrategy?.expectancyTpCapR ?? 4).toFixed(4)),
        takerFeeRate: baseStrategy?.takerFeeRate ?? 0.0005,
        makerFeeRate: baseStrategy?.makerFeeRate ?? 0.0002,
        expectancyGate: params.expectancyGate,
        dailyLossPct: Number(Math.max(0.5, params.dailyLossPct).toFixed(4)),
        pauseBalanceUsdt: baseStrategy?.pauseBalanceUsdt ?? 0.5,
        maxMarginUsdt: Number((params.maxMarginUsdt ?? baseStrategy?.maxMarginUsdt ?? 20).toFixed(4)),
        exchangeKeyId: validKey,
        mode: baseStrategy?.mode === "live" ? "live" : DEFAULT_STRATEGY_MODE,
        minScore,
        minWinRate,
        minTrades: baseStrategy?.minTrades && baseStrategy.minTrades >= 12 ? baseStrategy.minTrades : 12,
        gambleMode: baseStrategy?.gambleMode ?? false,
        scalpTpPct: baseStrategy?.scalpTpPct && baseStrategy.scalpTpPct > 0 ? baseStrategy.scalpTpPct : 0.003,
        scalpSlPct: baseStrategy?.scalpSlPct && baseStrategy.scalpSlPct > 0 ? baseStrategy.scalpSlPct : 0.003,
      };
    },
    [exchangeKeys],
  );

  /** 保存调参或模板到当前币种后端策略（已有则 updateStrategy，无则 createStrategy） */
  const handleSaveStrategyParams = async (params: TemplateParams, label?: string) => {
    setSavingStrategy(true);
    setLoadError(null);
    setStatusNotice(null);
    try {
      const payload = buildStrategyWritePayload(coinSymbol, params, strategy);
      const saved =
        strategy != null
          ? await updateStrategy(strategy.id, payload)
          : await createStrategy(payload);

      setStrategies((prev) => {
        const exists = prev.some((item) => item.id === saved.id);
        const next = exists ? prev.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...prev];
        strategiesRef.current = next;
        return next;
      });
      setTunerDraft(templateParamsOf(saved));
      setStatusNotice(
        label
          ? `已将模板「${label}」保存并应用到 ${coinSymbol} 策略（最低评分 ${saved.minScore}/4）`
          : `已保存 ${coinSymbol} 策略参数（杠杆 ${saved.leverage}x · EMA ${saved.emaFast}/${saved.emaSlow} · 最低评分 ${saved.minScore}/4）`,
      );
      await refresh(saved.id);
    } catch (err) {
      setLoadError(errorText(err, `保存 ${coinSymbol} 策略失败`));
    } finally {
      setSavingStrategy(false);
    }
  };

  /** 为任意未配置币种一键初始化策略机器人 */
  const handleQuickCreateStrategyForCoin = async (targetSymbol: string) => {
    setCreatingSymbol(targetSymbol);
    setLoadError(null);
    setStatusNotice(null);
    try {
      const existing = strategiesRef.current.find(
        (item) => (item.symbol ?? "").toUpperCase() === targetSymbol,
      );
      const defaultParams = templateParamsOf(existing ?? strategy);
      const payload = buildStrategyWritePayload(targetSymbol, defaultParams, existing ?? null);
      const saved =
        existing != null
          ? await updateStrategy(existing.id, payload)
          : await createStrategy(payload);

      setStrategies((prev) => {
        const exists = prev.some((item) => item.id === saved.id);
        const next = exists ? prev.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...prev];
        strategiesRef.current = next;
        return next;
      });
      setCoinSymbol(targetSymbol);
      setStatusNotice(`已为 ${targetSymbol} 初始化交易策略机器人`);
      await refresh(saved.id);
    } catch (err) {
      setLoadError(errorText(err, `初始化 ${targetSymbol} 策略失败`));
    } finally {
      setCreatingSymbol(null);
    }
  };

  /** 暂停/开启新开仓门控（setPauseEntries） */
  const togglePause = async (strategyId: number, paused: boolean) => {
    setPauseBusyId(strategyId);
    setLoadError(null);
    try {
      const saved = await setPauseEntries(strategyId, paused);
      setStrategies((prev) =>
        prev.map((item) =>
          item.id === strategyId ? { ...item, pauseEntries: saved.pauseEntries } : item,
        ),
      );
      strategiesRef.current = strategiesRef.current.map((item) =>
        item.id === strategyId ? { ...item, pauseEntries: saved.pauseEntries } : item,
      );
      setEngine((current) =>
        current && current.strategyId === strategyId
          ? { ...current, pauseEntries: saved.pauseEntries }
          : current,
      );
      setEngines((prev) => {
        const cur = prev.get(strategyId);
        if (!cur) return prev;
        return new Map(prev).set(strategyId, { ...cur, pauseEntries: saved.pauseEntries });
      });
    } catch (err) {
      setLoadError(errorText(err, "更新暂停开仓失败"));
    } finally {
      setPauseBusyId(null);
    }
  };

  /** 引擎真实生命周期控制：启动 / 恢复 / 单步推进 / 停止 */
  const handleEngineLifecycle = async (
    targetStrategyId: number,
    action: "start" | "resume" | "step" | "stop",
  ) => {
    setActionBusyId(targetStrategyId);
    setEngineActionBusy(action);
    setLoadError(null);
    setStatusNotice(null);
    try {
      let nextState: EngineState;
      const eq = balance?.equity ?? 100;
      if (action === "start") {
        nextState = await startEngine({ strategyId: targetStrategyId, equityUsdt: eq });
      } else if (action === "resume") {
        nextState = await resumeEngine({ strategyId: targetStrategyId, equityUsdt: eq });
      } else if (action === "step") {
        nextState = await stepEngine(targetStrategyId);
      } else {
        nextState = await stopEngine(targetStrategyId);
      }

      const isNowRunning = action !== "stop" && nextState.state !== "Idle";
      setEngines((prev) => new Map(prev).set(targetStrategyId, nextState));
      if (strategy?.id === targetStrategyId) {
        setEngine(nextState);
      }
      setStrategies((prev) => {
        const next = prev.map((item) =>
          item.id === targetStrategyId
            ? {
                ...item,
                running: isNowRunning,
                pauseReason: action === "resume" || action === "start" ? "" : item.pauseReason,
              }
            : item,
        );
        strategiesRef.current = next;
        return next;
      });
      setStatusNotice(
        action === "start"
          ? `引擎 #${targetStrategyId} 已启动（状态：${nextState.state}）`
          : action === "resume"
            ? `引擎 #${targetStrategyId} 已解除熔断并恢复运行`
            : action === "step"
              ? `引擎 #${targetStrategyId} 已完成单步扫描推进（动作：${nextState.lastAction || "扫描"}）`
              : `引擎 #${targetStrategyId} 已停止运行`,
      );
    } catch (err) {
      setLoadError(errorText(err, "执行引擎控制操作失败"));
    } finally {
      setActionBusyId(null);
      setEngineActionBusy(null);
    }
  };

  /** 触发 Boost 毫秒级强扫 */
  const handleTriggerBoost = async () => {
    setBoostBusy(true);
    setLoadError(null);
    try {
      if (strategy != null) {
        const res = await postEngineBoost();
        await refresh(strategy.id);
        setStatusNotice(
          res.until
            ? `Boost 毫秒级强扫已激活（持续至 ${res.until}）`
            : `Boost 毫秒级强扫已完成（状态码：${res.status}）`,
        );
      } else {
        setTickCount((c) => c + 12);
        setStatusNotice(`已完成 ${coin.displaySymbol} 毫秒级盘口深度强扫演练`);
      }
    } catch (err) {
      setLoadError(errorText(err, "触发 Boost 强扫失败"));
    } finally {
      setBoostBusy(false);
    }
  };

  const applyTemplate = (params: TemplateParams, name: string, id?: string) => {
    setTunerDraft(params);
    setTunerTemplate(name);
    if (id) setActiveTemplateId(id);
    setSystemTab("tuner");
  };

  // K 线序列：优先使用后端真实 K 线（并在最后一根叠加微跳价格），无真实 K 线时使用毫秒级流式合成 K 线
  const effectiveCandles = useMemo(() => {
    if (market && market.klines && market.klines.length > 0) {
      return market.klines;
    }
    return syntheticKlines;
  }, [market, syntheticKlines]);

  const effectiveMarkPrice = useMemo(() => {
    if (market?.markPrice && market.markPrice > 0) {
      return market.markPrice;
    }
    return livePrices[coin.symbol] ?? effectiveCandles[effectiveCandles.length - 1]?.close ?? coin.basePrice;
  }, [coin.basePrice, coin.symbol, effectiveCandles, livePrices, market?.markPrice]);

  // 仓位融合计算（优先用户演练单 -> 真实持仓 -> 预览融合持仓）
  const activeOrPreviewPosition = useMemo(
    () =>
      buildActiveOrPreviewPosition({
        coin,
        realPosition: position,
        markPrice: effectiveMarkPrice,
        stopPrice: engine?.stopPrice,
        takeProfitPrice: engine?.takeProfitPrice,
        leverage: (tunerDraft ?? templateParamsOf(strategy)).leverage,
        previewEnabled: previewPositionEnabled,
        customOrder,
      }),
    [
      coin,
      customOrder,
      effectiveMarkPrice,
      engine?.stopPrice,
      engine?.takeProfitPrice,
      position,
      previewPositionEnabled,
      strategy,
      tunerDraft,
    ],
  );

  // 首屏有效余额（真实余额优先；若当前币种尚未创建策略且无报错，则提供终端组合快照保障首屏完整展示）
  const effectiveBalanceInfo = useMemo(
    () => buildEffectiveBalance(coin, balance, activeOrPreviewPosition),
    [activeOrPreviewPosition, balance, coin],
  );

  // 合并历史成交与活跃委托
  const mergedRealEntries = useMemo(() => {
    const fromOrders = orders?.entries ?? [];
    const fromState = engine?.entries ?? [];
    const seen = new Set<string>();
    return [...fromOrders, ...fromState].filter((entry) => {
      const key = `${entry.openedAt}-${entry.entryPrice}-${entry.side}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [orders, engine]);

  const effectiveHistory = useMemo(
    () =>
      buildEffectiveHistoryAndOrders(
        coin,
        mergedRealEntries,
        orders?.items ?? [],
        activeOrPreviewPosition,
      ),
    [activeOrPreviewPosition, coin, mergedRealEntries, orders?.items],
  );

  const richDecisions = useMemo(
    () => buildRichDecisionRecords(coin, events, effectiveCandles),
    [coin, effectiveCandles, events],
  );

  const activeParams = tunerDraft ?? templateParamsOf(strategy);

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
            <span className={styles.sectionEyebrow}>OOAPI QUANTITATIVE TRADING TERMINAL · UIARC ARCHITECTURE</span>
            <h1 className={styles.pageTitle}>交易数据看板</h1>
            <p className={styles.pageLead}>
              总余额首屏、多币种宫格 K 线、全品种涨跌幅一张图、毫秒级流式 K 线与仓位标记，多币种资产档案、参数调优、历史与 AI 决策记录同屏联动；下方集成完整交易系统与多维量化归因矩阵。
            </p>
          </div>
          <div className={styles.pageHeadBadges}>
            <span className={styles.terminalChip}>
              当前标的：<strong>{coin.displaySymbol}</strong>
            </span>
            <span className={styles.terminalChip}>
              刷流频率：<strong>{tickIntervalMs}ms</strong>
            </span>
            <span className={styles.terminalChip}>
              策略总数：<strong>{strategies.length}</strong>
            </span>
          </div>
        </header>

        {loadError ? (
          <p className={styles.errorBar} role="alert">
            <span>{loadError}</span>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </p>
        ) : null}

        {statusNotice ? (
          <p className={styles.noticeBar} role="status">
            <span>{statusNotice}</span>
            <button
              type="button"
              className={styles.noticeCloseBtn}
              onClick={() => setStatusNotice(null)}
            >
              关闭
            </button>
          </p>
        ) : null}

        {/* 1. 多币种结构化详情选择器 + 标的深度档案 */}
        <CoinSelector
          value={coinSymbol}
          onChange={handleSelectCoin}
          strategyCount={strategyCount}
          livePrices={livePrices}
          onQuickCreateStrategy={(sym) => void handleQuickCreateStrategyForCoin(sym)}
          creatingSymbol={creatingSymbol}
        />

        {/* 2. 全品种涨跌幅叠在同一张图上，单品种毫秒图仍在下方 */}
        <FusedMarketOverview />

        {/* 3. 首屏总余额（修复 todayPct 100x 放大 bug，内联净值曲线与 Boost 扫描） */}
        <BalanceHero
          coin={coin}
          balance={balance ?? (balanceError ? null : effectiveBalanceInfo.balance)}
          loading={loading}
          error={balanceError}
          isSimulated={balance == null}
          engine={engine}
          strategy={strategy}
          onTriggerBoost={() => void handleTriggerBoost()}
          boostBusy={boostBusy}
        />

        <section className={styles.panel} aria-label="多币种行情图表">
          <header className={styles.panelHeadRow}>
            <div>
              <h2 className={styles.panelTitle}>多币种行情图表</h2>
              <p className={styles.panelDesc}>
                预设币种与自定义策略币种同屏展示 K 线、标记价和持仓参考线。点击卡片切换当前标的，下方行情终端、交易系统与数据面板一起跟着变。
              </p>
            </div>
          </header>
          <div className={styles.chartGrid}>
            {boardCoins.map((item) => {
              const itemStrategy =
                strategies.find((s) => (s.symbol ?? "").toUpperCase() === item.symbol) ?? null;
              const itemEngine = itemStrategy ? (engines.get(itemStrategy.id) ?? null) : null;
              const itemMarket = marketsBySymbol[item.symbol] ?? null;
              const itemPosition = positionsBySymbol[item.symbol] ?? null;
              const itemLevels =
                itemEngine?.state === "InPosition" || itemPosition?.open
                  ? {
                      entryPrice: itemPosition?.entryPrice ?? itemEngine?.entryPrice,
                      stopPrice: itemEngine?.stopPrice,
                      takeProfitPrice: itemEngine?.takeProfitPrice,
                    }
                  : itemMarket?.levels ??
                    (itemEngine
                      ? {
                          entryPrice: itemEngine.entryPrice,
                          stopPrice: itemEngine.stopPrice,
                          takeProfitPrice: itemEngine.takeProfitPrice,
                        }
                      : undefined);
              const isSelected = item.symbol === coinSymbol;
              const timeframeLabel = itemStrategy?.timeframe ?? itemMarket?.timeframe ?? "5m";
              const markPrice = itemMarket?.markPrice ?? itemPosition?.markPrice;

              return (
                <article
                  key={item.symbol}
                  className={`${styles.chartCard} ${isSelected ? styles.chartCardActive : ""}`}
                  onClick={() => handleSelectCoin(item.symbol)}
                >
                  <header className={styles.chartCardHead}>
                    <div className={styles.chartCardTitleGroup}>
                      <CoinIcon icon={item.icon} color={item.color} label={item.name} size={22} />
                      <strong className={styles.chartCardName}>{item.name}</strong>
                      <span className={styles.coinSymbol}>{item.symbol}</span>
                      <span className={styles.chartTimeframeBadge}>{timeframeLabel}</span>
                    </div>
                    <div className={styles.chartCardPriceGroup}>
                      {markPrice != null && markPrice > 0 ? (
                        <strong className={styles.chartMarkPrice}>
                          {markPrice.toFixed(item.precision)}
                        </strong>
                      ) : (
                        <span className={styles.coinSymbol}>--</span>
                      )}
                    </div>
                  </header>
                  <PositionCard position={itemPosition} coin={item} />
                  <div className={styles.gridChartWrap}>
                    {itemMarket && itemMarket.klines.length > 0 ? (
                      <LightweightCandleChart
                        timeframe={timeframeLabel}
                        candles={itemMarket.klines}
                        markPrice={itemMarket.markPrice}
                        levels={itemLevels}
                        positionOpen={itemPosition?.open ?? null}
                      />
                    ) : (
                      <p className={styles.emptyText}>
                        {loading ? "正在读取 K 线…" : "暂无 K 线数据。"}
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* 3. 首屏主工作区：左侧毫秒级行情终端（融合仓位线、止盈止损带、网格线、信号点） + 右侧四维高频控制栏 */}
        <div className={styles.main}>
          <section className={styles.panel} aria-label="行情图表">
            <header className={styles.panelHeadRow}>
              <div>
                <h2 className={styles.panelTitle}>
                  {coin.name} {coin.symbol} · {strategy?.timeframe ?? timeframe}
                </h2>
                <p className={styles.panelDesc}>
                  毫秒级 K 线流与持仓图层深度融合：实盘或演练持仓的入场价、实时浮盈胶囊、止盈目标带（TP）、止损保护带（SL）与决策信号均直接绘制于主图画布。
                </p>
              </div>
              <div className={styles.chartHeaderToggles}>
                <button
                  type="button"
                  className={`${styles.miniTab} ${previewPositionEnabled ? styles.miniTabActive : ""}`}
                  onClick={() => setPreviewPositionEnabled((v) => !v)}
                >
                  {previewPositionEnabled ? "● 仓位融合图层已开启" : "○ 开启仓位融合图层"}
                </button>
              </div>
            </header>

            <PositionCard
              position={activeOrPreviewPosition}
              coin={coin}
              previewEnabled={previewPositionEnabled}
              onTogglePreview={() => setPreviewPositionEnabled((v) => !v)}
              hasCustomOrder={customOrder != null}
              onClearCustomOrder={() => setCustomOrder(null)}
            />

            <div className={styles.chartWrap}>
              {effectiveCandles.length > 0 ? (
                <MillisecondMarketChart
                  coin={coin}
                  timeframe={timeframe}
                  onTimeframeChange={setTimeframe}
                  klines={effectiveCandles}
                  livePrice={effectiveMarkPrice}
                  tickDelta={tickDelta}
                  tickCount={tickCount}
                  isLiveRunning={streamPlaying}
                  onToggleLive={() => setStreamPlaying((v) => !v)}
                  tickSpeed={tickIntervalMs}
                  onTickSpeedChange={setTickIntervalMs}
                  position={activeOrPreviewPosition}
                  showPositionOverlay={showPositionOverlay}
                  onTogglePositionOverlay={() => setShowPositionOverlay((v) => !v)}
                  positionPreviewEnabled={previewPositionEnabled}
                  onTogglePositionPreview={() => setPreviewPositionEnabled((v) => !v)}
                  gridOverlay={gridOverlay}
                  onToggleGridOverlay={() =>
                    setGridOverlay((prev) => ({
                      ...prev,
                      enabled: !prev.enabled,
                      upper: roundToPrecision(effectiveMarkPrice * 1.045, coin.precision),
                      lower: roundToPrecision(effectiveMarkPrice * 0.955, coin.precision),
                    }))
                  }
                  decisions={richDecisions}
                  highlightedDecisionId={activeDecisionId}
                  onSelectDecision={(id) => setActiveDecisionId(id)}
                  emaFastPeriod={activeParams.emaFast}
                  emaSlowPeriod={activeParams.emaSlow}
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
                <TabsTrigger value="trade">仓位演练</TabsTrigger>
                <TabsTrigger value="history">历史记录</TabsTrigger>
                <TabsTrigger value="decisions">决策记录</TabsTrigger>
              </TabsList>
              <TabsContent value="params">
                <ParamPanel strategy={strategy} />
              </TabsContent>
              <TabsContent value="trade">
                <QuickTradePanel
                  coin={coin}
                  livePrice={effectiveMarkPrice}
                  defaultLeverage={activeParams.leverage}
                  onApplyPosition={(order) => {
                    setCustomOrder(order);
                    setPreviewPositionEnabled(true);
                  }}
                  onClearPosition={() => setCustomOrder(null)}
                  hasCustomOrder={customOrder != null}
                />
              </TabsContent>
              <TabsContent value="history">
                <HistoryPanel
                  entries={effectiveHistory.entries}
                  orders={effectiveHistory.orders}
                  precision={coin.precision}
                />
              </TabsContent>
              <TabsContent value="decisions">
                <DecisionLogPanel
                  events={eventsEnabled ? richDecisions : []}
                  enabled={eventsEnabled}
                  activeDecisionId={activeDecisionId}
                  onSelectDecision={(id) => setActiveDecisionId(id || null)}
                />
              </TabsContent>
            </Tabs>
          </aside>
        </div>

        {/* 4. 交易系统：决策模板、决策调参、自动化、网格策略、交易机器人 */}
        <section className={styles.panel} aria-label="交易系统">
          <header className={styles.panelHeadRow}>
            <div>
              <h2 className={styles.panelTitle}>交易系统</h2>
              <p className={styles.panelDesc}>
                决策模板与调参已打通后端持久化（最低评分严格遵循 1–4 分标准，支持任意币种一键创建或更新策略）；自动化与交易机器人完整绑定引擎启动、恢复、暂停开仓与停止接口。
              </p>
            </div>
          </header>
          <Tabs value={systemTab} onValueChange={setSystemTab}>
            <TabsList aria-label="交易系统切换">
              <TabsTrigger value="templates">决策模板</TabsTrigger>
              <TabsTrigger value="tuner">决策调参</TabsTrigger>
              <TabsTrigger value="automation">自动化</TabsTrigger>
              <TabsTrigger value="grid">网格策略</TabsTrigger>
              <TabsTrigger value="bots">交易机器人</TabsTrigger>
            </TabsList>
            <TabsContent value="templates">
              <StrategyTemplates
                onApply={(params, name) => applyTemplate(params, name)}
                activeId={activeTemplateId}
                onSaveTemplate={(params, name) => void handleSaveStrategyParams(params, name)}
                saving={savingStrategy}
                coinSymbol={coinSymbol}
              />
            </TabsContent>
            <TabsContent value="tuner">
              <ParamTuner
                draft={activeParams}
                onChange={(next) => {
                  setTunerDraft(next);
                  setTunerTemplate(null);
                }}
                templateName={tunerTemplate}
                onSave={(draft) => void handleSaveStrategyParams(draft)}
                onReset={() => {
                  setTunerDraft(templateParamsOf(strategy));
                  setTunerTemplate(null);
                }}
                saving={savingStrategy}
                hasStrategy={strategy != null}
                coinSymbol={coinSymbol}
              />
            </TabsContent>
            <TabsContent value="automation">
              <AutomationPanel
                strategy={strategy}
                engine={engine}
                pauseBusy={pauseBusyId === strategy?.id}
                onTogglePause={(paused) => {
                  if (strategy) void togglePause(strategy.id, paused);
                }}
                engineActionBusy={engineActionBusy}
                onStartEngine={
                  strategy ? () => void handleEngineLifecycle(strategy.id, "start") : undefined
                }
                onResumeEngine={
                  strategy ? () => void handleEngineLifecycle(strategy.id, "resume") : undefined
                }
                onStepEngine={
                  strategy ? () => void handleEngineLifecycle(strategy.id, "step") : undefined
                }
                onStopEngine={
                  strategy ? () => void handleEngineLifecycle(strategy.id, "stop") : undefined
                }
              />
            </TabsContent>
            <TabsContent value="grid">
              <GridConfig
                coin={coin}
                livePrice={effectiveMarkPrice}
                activeGridOverlay={gridOverlay}
                onApplyGridOverlay={(overlay) =>
                  setGridOverlay(
                    overlay ?? {
                      ...gridOverlay,
                      enabled: false,
                    },
                  )
                }
                onSaveGridToStrategy={(gridPatch) =>
                  void handleSaveStrategyParams(
                    {
                      ...activeParams,
                      stopR: gridPatch.stopR,
                      takeProfitR: gridPatch.takeProfitR,
                      maxMarginUsdt: gridPatch.maxMarginUsdt,
                    },
                    "网格量化风控参数",
                  )
                }
                saving={savingStrategy}
              />
            </TabsContent>
            <TabsContent value="bots">
              <BotList
                strategies={strategies}
                engines={engines}
                pauseBusyId={pauseBusyId}
                onTogglePause={(id, paused) => void togglePause(id, paused)}
                actionBusyId={actionBusyId}
                onStartBot={(id) => void handleEngineLifecycle(id, "start")}
                onResumeBot={(id) => void handleEngineLifecycle(id, "resume")}
                onStopBot={(id) => void handleEngineLifecycle(id, "stop")}
                onSelectCoin={handleSelectCoin}
                onCreateBotForCoin={(sym) => void handleQuickCreateStrategyForCoin(sym)}
                creatingSymbol={creatingSymbol}
              />
            </TabsContent>
          </Tabs>
        </section>

        {/* 5. UIArc 多维量化分析图块 */}
        <AnalyticsBlocks
          coin={coin}
          balance={balance ?? effectiveBalanceInfo.balance}
          activePos={activeOrPreviewPosition}
          strategy={strategy}
          entries={effectiveHistory.entries}
          livePrices={livePrices}
          onSelectCoin={handleSelectCoin}
        />
      </div>
    </AdminLayout>
  );
}
