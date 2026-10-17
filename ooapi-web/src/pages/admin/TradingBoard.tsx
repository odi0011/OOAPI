import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AdminLayout from "@/components/admin/AdminLayout";
import { Accordion } from "@/components/arc/accordion/accordion";
import { AnimatedCounter } from "@/components/arc/animated-counter/animated-counter";
import { Button } from "@/components/arc/button/button";
import { MetricCard } from "@/components/arc/metric-card/metric-card";
import { Sparkline } from "@/components/arc/sparkline/sparkline";
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
  type EngineFactors,
  type EngineMarket,
  type EngineQuote,
  type EngineOrders,
  type EnginePosition,
  type EngineState,
  type ExchangeKey,
  type Strategy,
  type StrategyWrite,
} from "./tradingApi";
import AnalyticsBlocks from "./tradingBoard/AnalyticsBlocks";
import {
  CoinProfile,
  CoinSelector,
  DecisionLogPanel,
  HistoryPanel,
  ParamPanel,
  MiniSparkline,
  PositionCard,
  QuickTradePanel,
  type SimulatedOrderDraft,
} from "./tradingBoard/BoardPanels";
import CoinIcon from "./tradingBoard/CoinIcon";
import {
  COINS,
  buildActiveOrPreviewPosition,
  buildEffectiveHistoryAndOrders,
  buildRichDecisionRecords,
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
  /*
    最近一次真实标记价的变化量（图上据此闪一下涨跌色）。

    由后端两次报价相减得到 —— 早先它来自假行情生成器的随机漂移，与市场无关。
  */
  const [tickDelta, setTickDelta] = useState(0);
  const [showPositionOverlay, setShowPositionOverlay] = useState<boolean>(true);
  const [previewPositionEnabled, setPreviewPositionEnabled] = useState<boolean>(true);
  const [customOrder, setCustomOrder] = useState<SimulatedOrderDraft | null>(null);
  /*
    网格覆盖线。

    上下沿初始为 0（未设置），第一次拿到真实标记价时再按 ±4.5% 预填 ——
    早先这里直接乘硬编码的 basePrice，用户看到的是「围绕一个过期价格」的网格。
  */
  const [gridOverlay, setGridOverlay] = useState<GridOverlaySpec>({
    enabled: false,
    upper: 0,
    lower: 0,
    count: 10,
    mode: "arithmetic",
  });
  const [activeDecisionId, setActiveDecisionId] = useState<string | null>(null);

  /*
    多币种标记价。

    **来源只有一个**：后端 /api/trading/engine/market 返回的真实标记价。
    早先这里用硬编码的 basePrice 打底、再由一个定时器加随机漂移，
    页面上的价格看着在跳，其实与市场无关；真实价格到达后才被悄悄替换。
    那种「兜底」比空白更糟 —— 用户分不清哪个数是行情、哪个是噪声。

    没有真实价时保持 undefined，界面显示占位符。
  */
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});

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

  /*
    24h 统计与多因子：直接从每个币种的 market 响应里取。

    这两项是后端在 /engine/market 里一并返回的（交易所公开数据 +
    按真实 K 线算的因子）—— 前端不再需要任何本地兜底。
  */
  const quotesBySymbol = useMemo(() => {
    const out: Record<string, EngineQuote | undefined> = {};
    for (const [sym, mkt] of Object.entries(marketsBySymbol)) out[sym] = mkt.quote;
    return out;
  }, [marketsBySymbol]);

  const factorsBySymbol = useMemo(() => {
    const out: Record<string, EngineFactors | undefined> = {};
    for (const [sym, mkt] of Object.entries(marketsBySymbol)) out[sym] = mkt.factors;
    return out;
  }, [marketsBySymbol]);


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
        const nextMark = marketRes.value.markPrice;
        if (nextMark && nextMark > 0) {
          const sym = marketRes.value.symbol || coinRef.current;
          setLivePrices((prev) => {
            // 变化量由**两次真实报价**相减得到，供图上闪涨跌色。
            const before = prev[sym];
            if (sym === coinRef.current && before && before > 0) {
              setTickDelta(nextMark - before);
            }
            return { ...prev, [sym]: nextMark };
          });
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

  /*
    行情刷新循环（唯一的一条）。

    历史教训，两层：

      ① **假行情生成器**：每 250ms 给价格加 `Math.random()` 漂移，
         页面跳的全是噪声；
      ② **真行情但照搬 250ms**：改成拉真实数据后仍按 250ms 轮询，
         每轮对 8 个币种各发 3 个请求 —— 约 96 次/秒打向交易所，
         直接把服务器 IP 打成币安 418 封禁（整个看板不可用）。
      ③ **两条 5 秒轮询同时跑**：加载完成后这条 effect 与下面那条
         `streamPlaying` 的 effect 同时生效，请求量直接翻倍 ——
         这是 2026-10-15 再次把 IP 打进封禁的直接原因。

    现在只有这一条循环：未加载完不跑、暂停刷流不跑、页面隐藏不跑。
    POLL_MS（5 秒）与交易所公开行情的粒度匹配，视觉上感知不到差别，
    请求量却降到 250ms 方案的两千分之一。250ms 那个档位保留给
    **界面重绘**（tick 计数与价格高亮动画），不再触发网络请求。
  */
  useEffect(() => {
    if (loading || !streamPlaying) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const target = strategiesRef.current.find(
        (item) => (item.symbol ?? "").toUpperCase() === coinRef.current,
      );
      void refresh(target?.id ?? null);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loading, streamPlaying, refresh]);

  /*
    纯视觉的重绘节拍：只累加计数（驱动价格闪烁、图表脉冲），
    不碰网络。频率由界面上的「刷流频率」控制。
  */
  useEffect(() => {
    if (!streamPlaying) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      setTickCount((c) => c + 1);
    }, tickIntervalMs);
    return () => window.clearInterval(timer);
  }, [streamPlaying, tickIntervalMs]);

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

  /*
    K 线序列：**只用后端真实 K 线**。

    早先在没有真实数据时回退到前端合成序列（正弦波形 + 随机漂移），
    图上看着有走势，其实与市场无关 —— 交易页上这种「有图但没数据」
    比空白更危险：用户可能据此下单。现在没有数据就画空白并说明原因。
  */
  const effectiveCandles = useMemo(() => market?.klines ?? [], [market]);

  const effectiveMarkPrice = useMemo(() => {
    if (market?.markPrice && market.markPrice > 0) {
      return market.markPrice;
    }
    return livePrices[coin.symbol] ?? effectiveCandles[effectiveCandles.length - 1]?.close ?? 0;
  }, [coin.symbol, effectiveCandles, livePrices, market?.markPrice]);

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
        mergedRealEntries,
        orders?.items ?? [],
      ),
    [mergedRealEntries, orders?.items],
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
        {/*
          紧凑页头：只放「现在是什么状态」与主操作。

          重构前这里是标题 + 三个状态胶囊，紧接着一整屏的币种大卡与常驻档案——
          用户要滚过两屏才看到最重要的账户盈亏。现在账户数据在下方 KPI 条里，
          页头只留一行状态。
        */}
        <header className={styles.pageHead}>
          <div className={styles.pageHeadMain}>
            <h1 className={styles.pageTitle}>交易数据看板</h1>
            <span className={styles.pageMeta}>
              <span>{coin.displaySymbol}</span>
              <span aria-hidden="true">·</span>
              <span>{tickIntervalMs}ms</span>
              <span aria-hidden="true">·</span>
              <span>
                <AnimatedCounter value={strategies.length} /> 个策略
              </span>
            </span>
          </div>
          <div className={styles.pageHeadActions}>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              刷新
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={boostBusy}
              onClick={() => void handleTriggerBoost()}
            >
              {boostBusy ? "强扫中…" : "Boost 强扫"}
            </Button>
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

        {/*
          账户 KPI 条。

          全页只有这一处展示账户数字 —— 重构前「全品种一张图」区块里还有一份
          同样的权益/可用/盈亏，两处口径略有差异时用户无法判断该信哪个。
        */}
        {balance ? (
          <section className={styles.kpiStrip} aria-label="账户概览">
            <MetricCard
              label="账户权益"
              value={balance.equity}
              suffix="USDT"
              decimals={3}
              context={`钱包 ${balance.wallet.toFixed(3)} · 可用 ${balance.available.toFixed(3)}`}
            />
            <MetricCard
              label="今日盈亏"
              value={balance.todayPnl}
              suffix="USDT"
              decimals={3}
              change={`${balance.todayPct >= 0 ? "+" : ""}${balance.todayPct.toFixed(2)}%`}
              context={`日初 ${balance.todayBase.toFixed(3)} · 已实现 ${balance.todayRealized.toFixed(3)}`}
            />
            <MetricCard
              label="持仓浮盈"
              value={balance.unrealized}
              suffix="USDT"
              decimals={3}
              context={
                balance.positions.filter((item) => item.open).length > 0
                  ? `${balance.positions.filter((item) => item.open).length} 个持仓`
                  : "当前空仓"
              }
            />
            <MetricCard
              label="保证金占用"
              value={balance.marginUsed}
              suffix="USDT"
              decimals={3}
              context={`保证金率 ${
                balance.equity > 0
                  ? ((balance.marginUsed / balance.equity) * 100).toFixed(1)
                  : "0.0"
              }%`}
            />
            <div className={styles.kpiCurve}>
              {balance.history.length > 1 ? (
                <Sparkline
                  data={balance.history.map((point) => point.equity)}
                  label="权益曲线"
                  value={`${balance.equity.toFixed(3)} USDT`}
                  change={`${balance.todayPct >= 0 ? "+" : ""}${balance.todayPct.toFixed(2)}%`}
                  tone={balance.todayPct >= 0 ? "success" : "danger"}
                  width={220}
                  height={64}
                />
              ) : (
                <p className={styles.kpiCurveEmpty}>权益曲线将在采样后出现</p>
              )}
            </div>
          </section>
        ) : balanceError ? (
          <p className={styles.errorBar} role="alert">
            <span>{balanceError}</span>
          </p>
        ) : null}

        {/*
          主工作区：左侧行情终端，右侧数据栏。

          仓位与成交/决策都在右侧栏的页签里；「币种档案」也放进右侧栏，
          不再常驻首屏占掉一整屏高度。
        */}
        <div className={styles.main}>
          <section className={styles.chartPanel} aria-label="行情图表">
            <div className={styles.chartPanelTop}>
              <CoinSelector
                value={coinSymbol}
                onChange={handleSelectCoin}
                strategyCount={strategyCount}
                livePrices={livePrices}
                quotes={quotesBySymbol}
                factors={factorsBySymbol}
              />
              <div className={styles.chartPanelHead}>
                <h2 className={styles.panelTitle}>
                  {coin.name} {coin.symbol} · {strategy?.timeframe ?? timeframe}
                </h2>
                <button
                  type="button"
                  className={`${styles.miniTab} ${previewPositionEnabled ? styles.miniTabActive : ""}`}
                  onClick={() => setPreviewPositionEnabled((v) => !v)}
                >
                  {previewPositionEnabled ? "仓位图层已开启" : "开启仓位图层"}
                </button>
              </div>
            </div>

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
                  quote={market?.quote}
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
                <TabsTrigger value="history">历史</TabsTrigger>
                <TabsTrigger value="decisions">决策</TabsTrigger>
                <TabsTrigger value="profile">档案</TabsTrigger>
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
              <TabsContent value="profile">
                <CoinProfile
                  value={coinSymbol}
                  strategyCount={strategyCount}
                  quotes={quotesBySymbol}
                  factors={factorsBySymbol}
                  onQuickCreateStrategy={(sym) => void handleQuickCreateStrategyForCoin(sym)}
                  creatingSymbol={creatingSymbol}
                />
              </TabsContent>
            </Tabs>
          </aside>
        </div>

        {/*
          全品种行情：一张归一化叠加图 + 一张紧凑列表。

          重构前这里是 8 张各自独立的 K 线卡片（每张 240px 高，还带仓位卡），
          加上下方的融合图，光行情部分就超过 3000px。现在列表只保留
          「一行一个币种」：价格、涨跌幅、持仓、策略数、迷你走势。
          单币种细节在上面的大图里看。
        */}
        <section className={styles.panel} aria-label="全品种行情">
          <header className={styles.panelHeadRow}>
            <h2 className={styles.panelTitle}>全品种行情</h2>
          </header>
          <FusedMarketOverview />

          <div className={styles.marketTable} role="table" aria-label="全部币种">
            <div className={`${styles.marketRow} ${styles.marketRowHead}`} role="row">
              <span role="columnheader">币种</span>
              <span role="columnheader">最新价</span>
              <span role="columnheader">24h</span>
              <span role="columnheader">持仓</span>
              <span role="columnheader">策略</span>
              <span role="columnheader">走势</span>
            </div>
            {boardCoins.map((item) => {
              const itemQuote = quotesBySymbol[item.symbol];
              const itemMarket = marketsBySymbol[item.symbol];
              const itemPosition = positionsBySymbol[item.symbol];
              const price = livePrices[item.symbol] ?? itemQuote?.lastPrice ?? 0;
              const changePct = itemQuote?.changePercent;
              const count = strategyCount[item.symbol] ?? 0;
              const sparkPoints = (itemMarket?.klines ?? []).map((kline) => kline.close);
              const active = item.symbol === coinSymbol;
              return (
                <button
                  key={item.symbol}
                  type="button"
                  role="row"
                  className={`${styles.marketRow} ${active ? styles.marketRowActive : ""}`}
                  onClick={() => handleSelectCoin(item.symbol)}
                >
                  <span className={styles.marketCoin} role="cell">
                    <CoinIcon icon={item.icon} color={item.color} label={item.name} size={20} />
                    <span className={styles.marketCoinText}>
                      <strong>{item.base}</strong>
                      <span className={styles.coinSymbol}>{item.symbol}</span>
                    </span>
                  </span>
                  <span className={styles.marketPrice} role="cell">
                    {price > 0 ? price.toFixed(item.precision) : "—"}
                  </span>
                  <span
                    role="cell"
                    className={
                      changePct == null ? "" : changePct >= 0 ? styles.toneUp : styles.toneDown
                    }
                  >
                    {changePct == null
                      ? "—"
                      : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`}
                  </span>
                  <span role="cell" className={styles.marketPosition}>
                    {itemPosition?.open
                      ? `${itemPosition.side === "short" ? "空" : "多"} ${itemPosition.qty}`
                      : "—"}
                  </span>
                  <span role="cell" className={styles.marketStrategyCount}>
                    {count > 0 ? count : "—"}
                  </span>
                  <span className={styles.marketSpark} role="cell">
                    {sparkPoints.length > 1 ? (
                      <MiniSparkline
                        points={sparkPoints}
                        positive={(changePct ?? 0) >= 0}
                        width={88}
                        height={22}
                      />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/*
          交易系统：策略模板、调参、自动化、网格、机器人。

          这些是「偶尔来改一次」的配置，重构前与行情平级铺在页尾，
          想改一次参数要滚很久。收进折叠面板，默认收起。
        */}
        <section className={styles.panel} aria-label="交易系统">
          <Accordion
            defaultOpen={-1}
            size="md"
            items={[
              {
                title: "交易系统与策略配置",
                content: (
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
                ),
              },
            ]}
          />
        </section>

        <AnalyticsBlocks coin={coin} entries={effectiveHistory.entries} />
      </div>
    </AdminLayout>
  );
}
