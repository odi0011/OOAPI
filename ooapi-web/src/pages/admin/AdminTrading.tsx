import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { NumberField } from "@/components/arc/number-field/number-field";
import { Select } from "@/components/arc/select/select";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import Switch from "@/components/arc/switch/switch";
import AdminLayout from "@/components/admin/AdminLayout";
import { ApiRequestError } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import sectionStyles from "./sections/Section.module.css";
import settingsStyles from "./AdminSettings.module.css";
import styles from "./AdminTrading.module.css";
import SettingsRail from "./SettingsRail";
import { ACCOUNT_PATH, DASHBOARD_PATH } from "./settingsNav";
import {
  TIMEFRAMES,
  DEFAULT_EXCHANGE_KEY_ID,
  DEFAULT_STRATEGY_MODE,
  createStrategy,
  deleteStrategy,
  discardLegacyStrategyDraft,
  getEngineState,
  setPauseEntries,
  listExchangeKeys,
  listStrategies,
  networkLabel,
  startEngine,
  stepEngine,
  updateStrategy,
  type EngineState,
  type ExchangeKey,
  type Strategy,
  type StrategyWrite,
  type Timeframe,
  type TradingNetwork,
} from "./tradingApi";
import {
  MAX_STRATEGY_LEVERAGE,
  MIN_STRATEGY_LEVERAGE,
  boundStrategyLeverage,
  strategyLeverageError,
} from "./strategyLeverage";
import {
  DEFAULT_EXPECTANCY_TP_CAP_R,
  DEFAULT_MAKER_FEE_PCT,
  DEFAULT_MIN_SCORE,
  DEFAULT_MIN_TRADES,
  DEFAULT_MIN_WIN_RATE,
  DEFAULT_ONE_R_PCT,
  DEFAULT_TAKER_FEE_PCT,
  MAX_TREND_SCORE,
  strategyDailyLossError,
  strategyExpectancyCapError,
  strategyFeePctError,
  strategyLiveSampleError,
  strategyMaxMarginError,
  strategyMinScoreError,
  strategyOneRPctError,
  strategyPauseBalanceError,
  strategyStopDistanceError,
  strategyTimeframeError,
  strategyToggleError,
} from "./strategyFields";

/**
 * 自动交易策略。
 *
 * 首发只启用「XRPUSDT + 逐仓 1–125x + 短周期 EMA」。
 * 网格 / 布林 / DCA 先留切换入口，标明「本金够再开」。
 *
 * 持久化字段与验收一致，直接读写 /api/trading/strategies（option:edit）：
 * symbol, leverage, marginMode, emaFast, emaSlow, timeframe,
 * stopR, takeProfitR, dailyLossPct, maxMarginUsdt, exchangeKeyId, mode.
 *
 * 列表按 updatedAt 倒序，页面只编辑 items[0]。没有记录时 POST，已有则 PATCH。
 * mode=live 可以保存；引擎必须测网全绿才会真下单。
 * 本页只放配置，可以启动和推进，但不会打开测网全绿门闩。
 * 行情、持仓、委托和盈亏在侧栏「交易 → 数据看板」。
 */

interface StrategyDraft {
  symbol: string;
  leverage: number;
  marginMode: "isolated";
  emaFast: number;
  emaSlow: number;
  timeframe: Timeframe;
  stopR: number;
  takeProfitR: number;
  /** 百分数。0.8 表示 0.8%。 */
  oneRPct: number;
  expectancyTpCapR: number;
  expectancyGate: boolean;
  /** 百分数。0.05 表示 0.05%。 */
  takerFeePct: number;
  makerFeePct: number;
  dailyLossPct: number;
  pauseBalanceUsdt: number;
  maxMarginUsdt: number;
  exchangeKeyId: number | null;
  mode: TradingNetwork;
  minScore: number;
  minWinRate: number;
  minTrades: number;
  gambleMode: boolean;
  /** 表单里用百分数。0.3 表示 0.3%，保存时换成 0.003。 */
  scalpTpPct: number;
  scalpSlPct: number;
}

const DEFAULT_DRAFT: StrategyDraft = {
  symbol: "XRPUSDT",
  leverage: 3,
  marginMode: "isolated",
  emaFast: 9,
  emaSlow: 21,
  timeframe: "5m",
  stopR: 1,
  takeProfitR: 1.5,
  oneRPct: DEFAULT_ONE_R_PCT,
  expectancyTpCapR: DEFAULT_EXPECTANCY_TP_CAP_R,
  expectancyGate: true,
  takerFeePct: DEFAULT_TAKER_FEE_PCT,
  makerFeePct: DEFAULT_MAKER_FEE_PCT,
  dailyLossPct: 4,
  pauseBalanceUsdt: 0.5,
  maxMarginUsdt: 1.7,
  exchangeKeyId: DEFAULT_EXCHANGE_KEY_ID,
  mode: DEFAULT_STRATEGY_MODE,
  minScore: DEFAULT_MIN_SCORE,
  minWinRate: DEFAULT_MIN_WIN_RATE,
  minTrades: DEFAULT_MIN_TRADES,
  gambleMode: false,
  scalpTpPct: 0.3,
  scalpSlPct: 0.3,
};

/** 可切换，但除 EMA 外都先禁用。类型不入库，接口没有这个字段。 */
const STRATEGIES: { id: string; label: string; enabled: boolean }[] = [
  { id: "ema", label: "短周期 EMA 趋势", enabled: true },
  { id: "grid", label: "网格", enabled: false },
  { id: "boll", label: "布林", enabled: false },
  { id: "dca", label: "DCA", enabled: false },
];

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

const SYMBOLS = ["XRPUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "BNBUSDT"] as const;

function normalizeSymbol(raw: string | undefined): string {
  const cleaned = (raw ?? "").trim().toUpperCase();
  if (/^[A-Z0-9]{2,12}USDT$/.test(cleaned)) return cleaned;
  return DEFAULT_DRAFT.symbol;
}

function draftFromStrategy(item: Strategy): StrategyDraft {
  return {
    symbol: normalizeSymbol(item.symbol),
    leverage: boundStrategyLeverage(item.leverage, DEFAULT_DRAFT.leverage),
    marginMode: "isolated",
    emaFast: clamp(Math.round(item.emaFast), 2, 50, DEFAULT_DRAFT.emaFast),
    emaSlow: clamp(Math.round(item.emaSlow), 3, 200, DEFAULT_DRAFT.emaSlow),
    timeframe: isTimeframe(item.timeframe) ? item.timeframe : DEFAULT_DRAFT.timeframe,
    stopR: clamp(item.stopR, 0.1, 20, DEFAULT_DRAFT.stopR),
    takeProfitR: clamp(item.takeProfitR, 0.1, 20, DEFAULT_DRAFT.takeProfitR),
    oneRPct: clamp((item.rFraction > 0 ? item.rFraction : DEFAULT_ONE_R_PCT / 100) * 100, 0.01, 20, DEFAULT_DRAFT.oneRPct),
    expectancyTpCapR: clamp(item.expectancyTpCapR > 0 ? item.expectancyTpCapR : DEFAULT_EXPECTANCY_TP_CAP_R, 0.1, 20, DEFAULT_DRAFT.expectancyTpCapR),
    expectancyGate: item.expectancyGate !== false,
    takerFeePct: clamp((item.takerFeeRate > 0 ? item.takerFeeRate : DEFAULT_TAKER_FEE_PCT / 100) * 100, 0.01, 1, DEFAULT_DRAFT.takerFeePct),
    makerFeePct: clamp((item.makerFeeRate > 0 ? item.makerFeeRate : DEFAULT_MAKER_FEE_PCT / 100) * 100, 0.01, 1, DEFAULT_DRAFT.makerFeePct),
    dailyLossPct: clamp(item.dailyLossPct, 0.1, 100, DEFAULT_DRAFT.dailyLossPct),
    pauseBalanceUsdt: typeof item.pauseBalanceUsdt === "number" ? item.pauseBalanceUsdt : DEFAULT_DRAFT.pauseBalanceUsdt,
    maxMarginUsdt: clamp(item.maxMarginUsdt, 0.1, 100, DEFAULT_DRAFT.maxMarginUsdt),
    exchangeKeyId: item.exchangeKeyId > 0 ? item.exchangeKeyId : DEFAULT_EXCHANGE_KEY_ID,
    mode: item.mode === "live" ? "live" : DEFAULT_STRATEGY_MODE,
    minScore: clamp(Math.round(item.minScore), 1, MAX_TREND_SCORE, DEFAULT_DRAFT.minScore),
    minWinRate: clamp(item.minWinRate, 0, 1, DEFAULT_DRAFT.minWinRate),
    minTrades: clamp(Math.round(item.minTrades), 1, 10000, DEFAULT_DRAFT.minTrades),
    gambleMode: item.gambleMode === true,
    scalpTpPct: clamp((item.scalpTpPct > 0 ? item.scalpTpPct : 0.003) * 100, 0.01, 20, DEFAULT_DRAFT.scalpTpPct),
    scalpSlPct: clamp((item.scalpSlPct > 0 ? item.scalpSlPct : 0.003) * 100, 0.01, 20, DEFAULT_DRAFT.scalpSlPct),
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function toWrite(draft: StrategyDraft): StrategyWrite {
  return {
    symbol: normalizeSymbol(draft.symbol),
    leverage: Math.round(draft.leverage),
    marginMode: "isolated",
    emaFast: Math.round(draft.emaFast),
    emaSlow: Math.round(draft.emaSlow),
    timeframe: draft.timeframe,
    stopR: round4(draft.stopR),
    takeProfitR: round4(draft.takeProfitR),
    rFraction: round8(draft.oneRPct / 100),
    expectancyTpCapR: round4(draft.expectancyTpCapR),
    takerFeeRate: round8(draft.takerFeePct / 100),
    makerFeeRate: round8(draft.makerFeePct / 100),
    expectancyGate: draft.expectancyGate,
    dailyLossPct: round4(draft.dailyLossPct),
    pauseBalanceUsdt: round4(draft.pauseBalanceUsdt),
    maxMarginUsdt: round4(draft.maxMarginUsdt),
    exchangeKeyId: draft.exchangeKeyId ?? DEFAULT_EXCHANGE_KEY_ID,
    mode: draft.mode === "live" ? "live" : DEFAULT_STRATEGY_MODE,
    minScore: Math.round(draft.minScore),
    minWinRate: round4(draft.minWinRate),
    minTrades: Math.round(draft.minTrades),
    gambleMode: draft.gambleMode,
    scalpTpPct: round4(draft.scalpTpPct / 100),
    scalpSlPct: round4(draft.scalpSlPct / 100),
  };
}

function validate(draft: StrategyDraft, keys: ExchangeKey[]): string | null {
  if (!/^[A-Z0-9]{2,12}USDT$/.test((draft.symbol ?? "").trim().toUpperCase())) return "交易对只支持 USDT 永续合约（如 XRPUSDT）";
  if (draft.marginMode !== "isolated") return "首发只允许逐仓";
  const leverageError = strategyLeverageError(draft.leverage);
  if (leverageError) return leverageError;
  const timeframeError = strategyTimeframeError(draft.timeframe);
  if (timeframeError) return timeframeError;
  const distanceError = strategyStopDistanceError(draft.stopR, draft.takeProfitR);
  if (distanceError) return distanceError;
  const oneRError = strategyOneRPctError(draft.oneRPct);
  if (oneRError) return oneRError;
  const capError = strategyExpectancyCapError(draft.expectancyTpCapR);
  if (capError) return capError;
  const takerError = strategyFeePctError(draft.takerFeePct, "taker ");
  if (takerError) return takerError;
  const makerError = strategyFeePctError(draft.makerFeePct, "maker ");
  if (makerError) return makerError;
  const gateError = strategyToggleError(draft.expectancyGate, "期望门");
  if (gateError) return gateError;
  const gambleError = strategyToggleError(draft.gambleMode, "赌一把");
  if (gambleError) return gambleError;
  const dailyLossError = strategyDailyLossError(draft.dailyLossPct);
  if (dailyLossError) return dailyLossError;
  const pauseError = strategyPauseBalanceError(draft.pauseBalanceUsdt);
  if (pauseError) return pauseError;
  const marginError = strategyMaxMarginError(draft.maxMarginUsdt);
  if (marginError) return marginError;
  if (draft.emaFast >= draft.emaSlow) return "快线周期要小于慢线";
  const scoreError = strategyMinScoreError(draft.minScore);
  if (scoreError) return scoreError;
  if (draft.minWinRate < 0 || draft.minWinRate > 1) return "胜率门槛要在 0 到 1";
  if (draft.minTrades < 1 || draft.minTrades > 10000) return "样本笔数要在 1 到 10000";
  const sampleError = strategyLiveSampleError(draft.mode, draft.gambleMode, draft.minWinRate, draft.minTrades);
  if (sampleError) return sampleError;
  if (draft.scalpTpPct <= 0 || draft.scalpTpPct > 20 || draft.scalpSlPct <= 0 || draft.scalpSlPct > 20) {
    return "剥头皮止损和止盈要大于 0 且不超过 20%";
  }
  if (draft.mode !== "testnet" && draft.mode !== "live") return "环境只能是测网或实盘";
  const bound = keys.some((key) => key.id === draft.exchangeKeyId && !key.revoked);
  if (!bound) return "请先绑定一个未作废的账户";
  return null;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export default function AdminTrading() {
  const notify = useNotify();
  const action = useAsyncGuard();
  const [keys, setKeys] = useState<ExchangeKey[]>([]);
  const [strategyId, setStrategyId] = useState<number | null>(null);
  const [extraCount, setExtraCount] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draft, setDraft] = useState<StrategyDraft>(DEFAULT_DRAFT);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [liveGate, setLiveGate] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [equity, setEquity] = useState(100);
  const [engineBusy, setEngineBusy] = useState<"start" | "step" | null>(null);
  const [pauseEntries, setPauseFlag] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);

  const applyLoaded = useCallback((items: Strategy[], keyItems: ExchangeKey[]) => {
    setKeys(keyItems);
    const current = items[0] ?? null;
    setExtraCount(Math.max(0, items.length - 1));
    if (!current) {
      setStrategyId(null);
      setWarnings([]);
      setPauseFlag(false);
      setDraft(DEFAULT_DRAFT);
      return;
    }
    setStrategyId(current.id);
    setWarnings(current.warnings ?? []);
    setPauseFlag(current.pauseEntries === true);
    setDraft(draftFromStrategy(current));
  }, []);

  const refreshEngine = useCallback(async (id: number | null) => {
    if (id == null) {
      setEngine(null);
      return;
    }
    try {
      const next = await getEngineState(id);
      setEngine(next);
      if (typeof next.pauseEntries === "boolean") setPauseFlag(next.pauseEntries);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setEngine(null);
        return;
      }
      // 配置页不靠状态条撑着。读失败就留上次的状态，保存和启动仍可用。
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    discardLegacyStrategyDraft();
    try {
      const [strategies, keyItems] = await Promise.all([listStrategies(), listExchangeKeys()]);
      applyLoaded(strategies, keyItems);
      await refreshEngine(strategies[0]?.id ?? null);
    } catch (err) {
      setLoadError(errorText(err, "加载策略失败"));
    } finally {
      setLoading(false);
    }
  }, [applyLoaded, refreshEngine]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (strategyId == null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshEngine(strategyId);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [strategyId, refreshEngine]);

  const activeKeys = keys.filter((key) => !key.revoked);
  const selectedKey = activeKeys.find((key) => key.id === draft.exchangeKeyId) ?? null;
  const savedKey = keys.find((key) => key.id === draft.exchangeKeyId) ?? null;

  function patch(partial: Partial<StrategyDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  function onModeChange(next: string) {
    if (next === "live") {
      if (draft.mode !== "live") setLiveGate(true);
      return;
    }
    patch({ mode: "testnet" });
  }

  function confirmLive() {
    patch({ mode: "live" });
    setLiveGate(false);
  }

  async function save() {
    const problem = validate(draft, keys);
    if (problem) {
      notify.error("还不能保存", problem);
      return;
    }
    if (!action.acquire()) return;
    setSaving(true);
    const body = toWrite(draft);
    try {
      const saved = strategyId == null
        ? await createStrategy(body)
        : await updateStrategy(strategyId, body);
      setStrategyId(saved.id);
      setWarnings(saved.warnings ?? []);
      setDraft(draftFromStrategy(saved));
      await refreshEngine(saved.id);
      if (saved.mode === "live") {
        notify.success("实盘配置已保存", "引擎须测网全绿才会真下单。这次只写入了配置。");
      } else {
        notify.success("策略已保存");
      }
    } catch (err) {
      notify.error("保存失败", errorText(err, "请稍后再试"));
    } finally {
      setSaving(false);
      action.release();
    }
  }

  async function runEngine(kind: "start" | "step") {
    if (strategyId == null) {
      notify.error("请先保存策略");
      return;
    }
    if (kind === "start" && !(equity > 0)) {
      notify.error("启动需要账户权益");
      return;
    }
    if (!action.acquire()) return;
    setEngineBusy(kind);
    try {
      const next = kind === "start"
        ? await startEngine({ strategyId, equityUsdt: equity })
        : await stepEngine(strategyId);
      setEngine(next);
      notify.success(kind === "start" ? "引擎已启动" : "已推进一次", `当前状态 ${next.state}`);
      void refreshEngine(strategyId);
    } catch (err) {
      notify.error(kind === "start" ? "启动失败" : "推进失败", errorText(err, "请稍后再试"));
    } finally {
      setEngineBusy(null);
      action.release();
    }
  }

  async function togglePause(next: boolean) {
    if (strategyId == null) return;
    setPauseBusy(true);
    setPauseFlag(next);
    try {
      const saved = await setPauseEntries(strategyId, next);
      setPauseFlag(saved.pauseEntries);
      setEngine((current) => (current ? { ...current, pauseEntries: saved.pauseEntries } : current));
      notify.success(saved.pauseEntries ? "已暂停新开仓" : "已恢复新开仓", "已有仓和止损止盈保持不动。");
    } catch (err) {
      setPauseFlag(!next);
      notify.error("更新暂停开仓失败", errorText(err, "请稍后再试"));
    } finally {
      setPauseBusy(false);
    }
  }

  async function remove() {
    if (strategyId == null || !action.acquire()) return;
    try {
      await deleteStrategy(strategyId);
      setDeleteOpen(false);
      notify.success("策略已删除");
      const [strategies, keyItems] = await Promise.all([listStrategies(), listExchangeKeys()]);
      applyLoaded(strategies, keyItems);
      await refreshEngine(strategies[0]?.id ?? null);
    } catch (err) {
      notify.error("删除失败", errorText(err, "请稍后再试"));
    } finally {
      action.release();
    }
  }

  const live = draft.mode === "live";
  const mismatch = selectedKey != null && selectedKey.network !== draft.mode;

  return (
    <AdminLayout
      crumbs={[
        { label: "后台", href: "/admin" },
        { label: "系统设置", href: "/admin/system" },
        { label: "策略" },
      ]}
      actions={
        <>
          {strategyId != null && (
            <Button
              variant="secondary"
              size="sm"
              disabled={loading || action.busy}
              onClick={() => setDeleteOpen(true)}
            >
              删除策略
            </Button>
          )}
          <Button variant="primary" size="sm" loading={saving} disabled={loading || action.busy} onClick={() => void save()}>
            保存配置
          </Button>
        </>
      }
    >
      <div className={settingsStyles.page}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.title}>策略</h1>
            <p className={styles.lead}>
              首发只做 XRPUSDT 的短周期 EMA 趋势，逐仓，杠杆 1 到 {MAX_STRATEGY_LEVERAGE} 倍。每单都要填止损和止盈。保存后下一拍生效，不用重启。
              行情在<Link to={DASHBOARD_PATH}>交易 → 数据看板</Link>，交易所密钥在<Link to={ACCOUNT_PATH}>交易 → 账户</Link>。
            </p>
          </div>
        </header>

        <div className={settingsStyles.layout}>
          <SettingsRail current="strategy" />
          <div className={settingsStyles.formArea}>
        {loading ? (
          <p className={styles.status}>正在读取策略…</p>
        ) : loadError ? (
          <p className={`${styles.status} ${styles.statusError}`}>
            {loadError}
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </p>
        ) : (
          <>
            <section className={styles.block}>
              <header className={sectionStyles.sectionHead}>
                <h2 className={sectionStyles.sectionTitle}>交易环境</h2>
                <p className={sectionStyles.sectionLead}>
                  测网与实盘写在策略的 mode 上。切到实盘前要确认测网全绿。保存 live 不会下单，引擎必须测网全绿才会真下单。
                </p>
              </header>
              <div className={sectionStyles.rows}>
                <div className={sectionStyles.row} data-field="mode">
                  <div className={sectionStyles.rowText}>
                    <strong>测网 / 实盘</strong>
                    <p>切到实盘之前，测网需要全绿。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <SegmentedControl
                      label="交易环境"
                      value={draft.mode}
                      onValueChange={onModeChange}
                      options={[
                        { value: "testnet", label: "测网" },
                        { value: "live", label: "实盘" },
                      ]}
                    />
                    <p className={live ? styles.envLive : styles.envNote} data-mode={draft.mode}>
                      {live
                        ? "已选择实盘。保存后后端会记下 live，但引擎须测网全绿才会真下单。这里只保存配置。"
                        : "测网不使用真实资金。点实盘前会先要求确认测网全绿。"}
                    </p>
                    {warnings.length > 0 && (
                      <div className={styles.warning} role="status">
                        <ul className={styles.warningList}>
                          {warnings.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className={styles.block}>
              <header className={sectionStyles.sectionHead}>
                <h2 className={sectionStyles.sectionTitle}>策略</h2>
                <p className={sectionStyles.sectionLead}>
                  网格、布林、DCA 的入口先留着，本金够再开。现在只能选短周期 EMA。
                  {extraCount > 0 ? ` 当前编辑最近更新的一条，另外 ${extraCount} 条仍留在服务器上。` : ""}
                </p>
              </header>

              <div className={sectionStyles.rows}>
                <div className={sectionStyles.row}>
                  <div className={sectionStyles.rowText}>
                    <strong>策略类型</strong>
                    <p>点选切换。灰掉的项还不能启用。</p>
                  </div>
                  <div className={sectionStyles.rowControlInline}>
                    <div className={styles.choices} role="group" aria-label="策略类型">
                      {STRATEGIES.map((item) => {
                        const active = item.enabled;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={active ? `${styles.choice} ${styles.choiceOn}` : styles.choice}
                            aria-pressed={item.enabled ? active : undefined}
                            disabled={!item.enabled}
                            title={item.enabled ? undefined : "本金够再开"}
                          >
                            {item.enabled ? item.label : `${item.label} · 本金够再开`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="symbol">
                  <div className={sectionStyles.rowText}>
                    <strong>交易对</strong>
                    <p>支持 USDT 永续合约（默认 XRPUSDT）。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <Select
                      hideLabel
                      label="交易对"
                      value={draft.symbol}
                      options={ Array.from(new Set([...SYMBOLS, draft.symbol])).map((sym) => ({ value: sym, label: sym })) }
                      onValueChange={(symbol) => patch({ symbol: normalizeSymbol(symbol) })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="marginMode">
                  <div className={sectionStyles.rowText}>
                    <strong>保证金模式</strong>
                    <p>首发只允许逐仓。全仓先禁用。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <Select
                      hideLabel
                      label="保证金模式"
                      value={draft.marginMode}
                      options={[
                        { value: "isolated", label: "逐仓" },
                        { value: "cross", label: "全仓", disabled: true },
                      ]}
                      onValueChange={(marginMode) => {
                        if (marginMode === "isolated") patch({ marginMode: "isolated" });
                      }}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="leverage">
                  <div className={sectionStyles.rowText}>
                    <strong>杠杆</strong>
                    <p>逐仓，默认 {DEFAULT_DRAFT.leverage} 倍，最高 {MAX_STRATEGY_LEVERAGE} 倍。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="杠杆"
                      suffix=" 倍"
                      value={draft.leverage}
                      min={MIN_STRATEGY_LEVERAGE}
                      max={MAX_STRATEGY_LEVERAGE}
                      step={1}
                      limitHint={(edge) =>
                        edge === "max" ? `最高 ${MAX_STRATEGY_LEVERAGE} 倍` : `至少 ${MIN_STRATEGY_LEVERAGE} 倍`
                      }
                      onValueChange={(leverage) => patch({ leverage: Math.round(leverage) })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="timeframe">
                  <div className={sectionStyles.rowText}>
                    <strong>K 线周期</strong>
                    <p>可选 1 秒、1 分钟、3 分钟、5 分钟。已保存的 15 分钟策略仍可继续用。</p>
                  </div>
                  <div className={sectionStyles.rowControlInline}>
                    <SegmentedControl
                      label="K 线周期"
                      value={draft.timeframe}
                      onValueChange={(timeframe) => {
                        if (isTimeframe(timeframe)) patch({ timeframe });
                      }}
                      options={TIMEFRAMES.map((item) => ({ value: item, label: item }))}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="emaFast">
                  <div className={sectionStyles.rowText}>
                    <strong>快线 EMA</strong>
                    <p>默认 9，必须小于慢线。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="快线 EMA"
                      suffix=" 根"
                      value={draft.emaFast}
                      min={2}
                      max={50}
                      step={1}
                      onValueChange={(emaFast) => patch({ emaFast: Math.round(emaFast) })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="emaSlow">
                  <div className={sectionStyles.rowText}>
                    <strong>慢线 EMA</strong>
                    <p>默认 21，必须大于快线。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="慢线 EMA"
                      suffix=" 根"
                      value={draft.emaSlow}
                      min={3}
                      max={200}
                      step={1}
                      onValueChange={(emaSlow) => patch({ emaSlow: Math.round(emaSlow) })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="stopR">
                  <div className={sectionStyles.rowText}>
                    <strong>止损</strong>
                    <p>每单必填，按 R 计，默认 1。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="止损"
                      suffix=" R"
                      value={draft.stopR}
                      min={0.1}
                      max={20}
                      step={0.1}
                      onValueChange={(stopR) => patch({ stopR })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="takeProfitR">
                  <div className={sectionStyles.rowText}>
                    <strong>止盈</strong>
                    <p>每单必填，按 R 计，默认 1.5。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="止盈"
                      suffix=" R"
                      value={draft.takeProfitR}
                      min={0.1}
                      max={20}
                      step={0.1}
                      onValueChange={(takeProfitR) => patch({ takeProfitR })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="oneRPct">
                  <div className={sectionStyles.rowText}>
                    <strong>1R 距离</strong>
                    <p>按入场价的百分比。止损距离 = 止损 R × 1R。生产默认 0.8%。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="1R 距离"
                      suffix=" %"
                      value={draft.oneRPct}
                      min={0.01}
                      max={20}
                      step={0.1}
                      onValueChange={(oneRPct) => patch({ oneRPct })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="expectancyTpCapR">
                  <div className={sectionStyles.rowText}>
                    <strong>期望止盈上限</strong>
                    <p>期望门最多把止盈放到这么多 R。默认 {DEFAULT_EXPECTANCY_TP_CAP_R}。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="期望止盈上限"
                      suffix=" R"
                      value={draft.expectancyTpCapR}
                      min={0.1}
                      max={20}
                      step={0.1}
                      onValueChange={(expectancyTpCapR) => patch({ expectancyTpCapR })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="expectancyGate">
                  <div className={sectionStyles.rowText}>
                    <strong>期望门</strong>
                    <p>打开后，止盈放到上限时期望仍不为正就跳过开仓。赌一把不能单独关掉它。默认打开。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <Switch
                      label={draft.expectancyGate ? "已打开" : "关闭"}
                      checked={draft.expectancyGate}
                      onCheckedChange={(expectancyGate) => patch({ expectancyGate })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="takerFeePct">
                  <div className={sectionStyles.rowText}>
                    <strong>taker 费率回退</strong>
                    <p>读不到交易所 commissionRate 时用它。默认 0.05%。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="taker 费率回退"
                      suffix=" %"
                      value={draft.takerFeePct}
                      min={0.01}
                      max={1}
                      step={0.01}
                      onValueChange={(takerFeePct) => patch({ takerFeePct })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="makerFeePct">
                  <div className={sectionStyles.rowText}>
                    <strong>maker 费率回退</strong>
                    <p>读不到交易所 commissionRate 时用它。止盈按 maker 出场。默认 0.02%。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="maker 费率回退"
                      suffix=" %"
                      value={draft.makerFeePct}
                      min={0.01}
                      max={1}
                      step={0.01}
                      onValueChange={(makerFeePct) => patch({ makerFeePct })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="minScore">
                  <div className={sectionStyles.rowText}>
                    <strong>分数门槛</strong>
                    <p>1 到 4。普通开仓要达到这个分数。加速窗口里达标会马上开，到点仍不达标就按当时趋势强制开一笔。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="分数门槛"
                      suffix=" 分"
                      value={draft.minScore}
                      min={1}
                      max={MAX_TREND_SCORE}
                      step={1}
                      onValueChange={(minScore) => patch({ minScore: Math.round(minScore) })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="gambleMode">
                  <div className={sectionStyles.rowText}>
                    <strong>赌一把</strong>
                    <p>打开后不再用回测胜率、样本笔数和净 R 拦开仓。分数门槛仍按上面的设置。止损止盈改用下面的剥头皮距离。默认关闭。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <Switch
                      label={draft.gambleMode ? "已打开" : "关闭"}
                      checked={draft.gambleMode}
                      onCheckedChange={(gambleMode) => patch({ gambleMode })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="minWinRate">
                  <div className={sectionStyles.rowText}>
                    <strong>胜率门槛</strong>
                    <p>策略回测胜率下限。实盘未开赌一把时不能低于 {DEFAULT_MIN_WIN_RATE}。赌一把打开后这道门不生效。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="胜率门槛"
                      value={draft.minWinRate}
                      min={0}
                      max={1}
                      step={0.01}
                      onValueChange={(minWinRate) => patch({ minWinRate })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="minTrades">
                  <div className={sectionStyles.rowText}>
                    <strong>样本笔数</strong>
                    <p>回测至少要有这么多笔。实盘未开赌一把时不能低于 {DEFAULT_MIN_TRADES}。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="样本笔数"
                      suffix=" 笔"
                      value={draft.minTrades}
                      min={1}
                      max={10000}
                      step={1}
                      onValueChange={(minTrades) => patch({ minTrades: Math.round(minTrades) })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="scalpTpPct">
                  <div className={sectionStyles.rowText}>
                    <strong>剥头皮止盈</strong>
                    <p>赌一把时按入场价的这个百分比挂止盈，默认 0.3%。低于 0.15% 时下单会抬到 0.15%，用来盖住手续费和滑点。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="剥头皮止盈"
                      suffix=" %"
                      value={draft.scalpTpPct}
                      min={0.01}
                      max={20}
                      step={0.01}
                      onValueChange={(scalpTpPct) => patch({ scalpTpPct })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="scalpSlPct">
                  <div className={sectionStyles.rowText}>
                    <strong>剥头皮止损</strong>
                    <p>赌一把时按入场价的这个百分比挂止损，默认 0.3%。止损仍然必须落在强平价之前。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="剥头皮止损"
                      suffix=" %"
                      value={draft.scalpSlPct}
                      min={0.01}
                      max={20}
                      step={0.01}
                      onValueChange={(scalpSlPct) => patch({ scalpSlPct })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="maxMarginUsdt">
                  <div className={sectionStyles.rowText}>
                    <strong>单笔保证金上限</strong>
                    <p>默认 1.7 USDT。下一拍开仓按最新值。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="单笔保证金上限"
                      suffix=" USDT"
                      value={draft.maxMarginUsdt}
                      min={0.1}
                      max={100}
                      step={0.1}
                      onValueChange={(maxMarginUsdt) => patch({ maxMarginUsdt })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="dailyLossPct">
                  <div className={sectionStyles.rowText}>
                    <strong>日亏停机阈值</strong>
                    <p>当天亏损达到权益的这个比例后停止开新仓。填 100 表示关闭。默认 4%。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="日亏停机阈值"
                      suffix=" %"
                      value={draft.dailyLossPct}
                      min={0.1}
                      max={100}
                      step={0.1}
                      onValueChange={(dailyLossPct) => patch({ dailyLossPct })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="pauseBalanceUsdt">
                  <div className={sectionStyles.rowText}>
                    <strong>余额暂停线</strong>
                    <p>钱包余额低于这条线时，下一拍暂停该策略，不用重启。最低 0.5 USDT，默认 0.5。权益落到 0.5 以下仍会停掉这把密钥下的全部引擎。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <NumberField
                      hideLabel
                      label="余额暂停线"
                      suffix=" USDT"
                      value={draft.pauseBalanceUsdt}
                      min={0.5}
                      max={1_000_000}
                      step={0.1}
                      onValueChange={(pauseBalanceUsdt) => patch({ pauseBalanceUsdt })}
                    />
                  </div>
                </div>

                <div className={sectionStyles.row} data-field="exchangeKeyId">
                  <div className={sectionStyles.rowText}>
                    <strong>账户</strong>
                    <p>只用还没作废的那一个。作废的旧账户不会出现在这里。</p>
                  </div>
                  <div className={sectionStyles.rowControl}>
                    <Select
                      hideLabel
                      label="账户"
                      value={selectedKey ? String(selectedKey.id) : ""}
                      placeholder="请先绑定账户"
                      options={activeKeys.map((key) => ({
                        value: String(key.id),
                        label: `${key.label || "未命名"} · ${networkLabel(key.network)}`,
                      }))}
                      onValueChange={(value) => {
                        const id = Number(value);
                        if (Number.isInteger(id) && id > 0) patch({ exchangeKeyId: id });
                      }}
                      disabled={activeKeys.length === 0}
                    />
                    <p className={styles.keyHint}>
                      {activeKeys.length === 0
                        ? `当前没有可使用的账户。未改选择时按账户 ${DEFAULT_EXCHANGE_KEY_ID} 保存。`
                        : "作废的旧账户不会出现在这里。"}
                      {draft.exchangeKeyId === DEFAULT_EXCHANGE_KEY_ID && !selectedKey
                        ? ` 默认是账户 ${DEFAULT_EXCHANGE_KEY_ID}。`
                        : ""}
                      {savedKey?.revoked ? " 当前保存的账户已作废，请重新选择。" : ""}
                      {mismatch ? " 这个账户的网络和当前环境不一致，可以保存，运行前请改成同一边。" : ""}
                      <Link to={ACCOUNT_PATH}>去绑定</Link>
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className={styles.block}>
              <header className={sectionStyles.sectionHead}>
                <h2 className={sectionStyles.sectionTitle}>策略引擎</h2>
                <p className={sectionStyles.sectionLead}>
                  启动和推进需要登录，并走 option:edit。本页不调用测网全绿接口，也不打开 TRADING_TESTNET_GREEN。
                  推进一次不附带 K 线；没有交叉就不会下单。
                </p>
              </header>
              <div className={styles.engineActions}>
                <NumberField
                  label="账户权益"
                  suffix=" USDT"
                  value={equity}
                  min={0.1}
                  max={1_000_000}
                  step={1}
                  onValueChange={setEquity}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={engineBusy === "start"}
                  disabled={strategyId == null || action.busy}
                  onClick={() => void runEngine("start")}
                >
                  启动
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={engineBusy === "step"}
                  disabled={strategyId == null || action.busy}
                  onClick={() => void runEngine("step")}
                >
                  推进一次
                </Button>
              </div>
              <div className={styles.engineActions} data-field="pauseEntries">
                <Switch
                  label={pauseEntries ? "新开仓已暂停" : "允许新开仓"}
                  checked={pauseEntries}
                  disabled={strategyId == null || pauseBusy}
                  onCheckedChange={(next) => void togglePause(next)}
                />
                <p className={styles.keyHint}>只停止新开仓。已有仓和它的止损止盈保持不动，对账继续。这不是余额暂停线。</p>
              </div>
              <p className={styles.envNote} data-engine-state={engine?.state ?? "Idle"} data-testnet-green={engine?.testnetGreen ? "on" : "off"} data-pause-entries={pauseEntries ? "on" : "off"}>
                {strategyId == null
                  ? "先保存策略，再启动。默认环境是测网。"
                  : `状态 ${engine?.state ?? "Idle"}。测网全绿门闩${engine?.testnetGreen ? "已打开" : "关着"}，本页不会去开它。`}
              </p>
              {engine?.lastAction ? (
                <p className={styles.keyHint}>
                  最近动作 {engine.lastAction}
                  {engine.lastReason ? ` · ${engine.lastReason}` : ""}
                </p>
              ) : null}
            </section>
          </>
        )}
          </div>
        </div>
      </div>

      <Dialog open={liveGate} onOpenChange={setLiveGate}>
        <DialogContent
          title="切到实盘前先看测网"
          description="确认后可以把 mode 存成 live。引擎仍须测网全绿才会真下单，本页保存不会直接下单。"
        >
          <p className={styles.gateCopy}>请确认测网检查都已通过，再把环境标成实盘。</p>
          <div className={styles.dialogActions}>
            <Button variant="secondary" size="sm" onClick={() => setLiveGate(false)}>
              留在测网
            </Button>
            <Button variant="primary" size="sm" onClick={confirmLive}>
              测网已全绿，标记实盘
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(next) => { if (!action.busy) setDeleteOpen(next); }}>
        <DialogContent
          title="删除这条策略"
          description="只删除最近更新的这一条。账户不会一起作废。"
        >
          <p className={styles.gateCopy}>删除后页面会再读一次列表。如果还有更早的策略，会接着编辑那一条。</p>
          <div className={styles.dialogActions}>
            <Button variant="secondary" size="sm" disabled={action.busy} onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="danger" size="sm" loading={action.busy} onClick={() => void remove()}>
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
