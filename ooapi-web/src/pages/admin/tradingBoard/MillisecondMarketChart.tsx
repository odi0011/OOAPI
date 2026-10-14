/**
 * UIArc `market-terminal` + `line-replay` + `semantic-zoom` 毫秒级交互式行情终端图表。
 *
 * 核心特性：
 * 1. 顶部终端栏：币种徽标、毫秒级 Live 脉冲指示器（支持暂停/继续与 100ms/250ms/500ms/1s 采样速率切换）、
 *    大字号等宽跳动价格、今日涨跌额/涨跌幅、24h Open / High / Low / Volume / Funding。
 * 2. 工具栏：多周期切换（100ms / 1s / 1m / 5m / 15m / 1H / 1D）、图表形态切换（K线蜡烛 / 毫秒闪电图 / 深度面积）、
 *    技术指标开关（EMA 快慢线、BOLL 布林带）、图层融合开关（持仓融合线、网格挂单线、决策信号打点）、语义缩放（放大/缩小/重置）。
 * 3. 仓位深度融合进图表（Positions Integrated on Chart）：
 *    - 入场价水平线 + 图内胶囊徽标（方向 LONG/SHORT、杠杆、数量、入场价、实时跳动浮盈 USDT 与 ROE%、R 倍数）
 *    - 止盈线（TP）与目标收益预计标签 + 入场至止盈的浅绿收益带渲染
 *    - 止损线（SL）与强平参考线（LIQ）+ 入场至止损的浅红风险带渲染
 *    - 实时标记价（Mark Price）脉冲呼吸灯与右侧价格轴高亮尾标
 * 4. 决策信号与网格图层：
 *    - 在 K 线序列上绘制策略决策打点（入场、止盈、风控拦截、加速扫描），支持与右侧「决策记录」点击高亮联动。
 */

import { useMemo, useRef, useState, type PointerEvent } from "react";
import {
  Activity,
  CandlestickChart,
  Layers,
  Maximize2,
  Pause,
  Play,
  Sparkles,
  Target,
  TrendingUp,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import CoinIcon from "./CoinIcon";
import { roundToPrecision, type CoinInfo, type EnrichedPosition, type RichDecisionRecord } from "./coins";
import type { EngineKline } from "../tradingApi";
import styles from "../TradingBoard.module.css";

export type ChartMode = "candles" | "replay" | "area";
export type TickSpeedMs = 100 | 250 | 500 | 1000;

export interface GridOverlaySpec {
  enabled: boolean;
  upper: number;
  lower: number;
  count: number;
  mode: "arithmetic" | "geometric";
}

interface MillisecondMarketChartProps {
  coin: CoinInfo;
  timeframe: string;
  onTimeframeChange: (tf: string) => void;
  klines: readonly EngineKline[];
  livePrice: number;
  tickDelta: number;
  tickCount: number;
  isLiveRunning: boolean;
  onToggleLive: () => void;
  tickSpeed: TickSpeedMs;
  onTickSpeedChange: (speed: TickSpeedMs) => void;
  position: EnrichedPosition | null;
  showPositionOverlay: boolean;
  onTogglePositionOverlay: () => void;
  positionPreviewEnabled: boolean;
  onTogglePositionPreview: () => void;
  gridOverlay: GridOverlaySpec;
  onToggleGridOverlay: () => void;
  decisions: readonly RichDecisionRecord[];
  highlightedDecisionId: string | null;
  onSelectDecision?: (id: string | null) => void;
  emaFastPeriod?: number;
  emaSlowPeriod?: number;
}

const TIMEFRAME_OPTIONS = ["100ms", "1s", "1m", "5m", "15m", "1H", "1D"] as const;
const SPEED_OPTIONS: readonly TickSpeedMs[] = [100, 250, 500, 1000];

function computeEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  }
  return out;
}

function computeBollinger(values: number[], period = 20, mult = 2): { upper: number[]; lower: number[] } {
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = values.slice(start, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    const std = Math.sqrt(variance);
    upper.push(mean + mult * std);
    lower.push(mean - mult * std);
  }
  return { upper, lower };
}

export default function MillisecondMarketChart({
  coin,
  timeframe,
  onTimeframeChange,
  klines,
  livePrice,
  tickDelta,
  tickCount,
  isLiveRunning,
  onToggleLive,
  tickSpeed,
  onTickSpeedChange,
  position,
  showPositionOverlay,
  onTogglePositionOverlay,
  positionPreviewEnabled,
  onTogglePositionPreview,
  gridOverlay,
  onToggleGridOverlay,
  decisions,
  highlightedDecisionId,
  onSelectDecision,
  emaFastPeriod = 9,
  emaSlowPeriod = 21,
}: MillisecondMarketChartProps) {
  const [chartMode, setChartMode] = useState<ChartMode>("candles");
  const [showEma, setShowEma] = useState(true);
  const [showBoll, setShowBoll] = useState(false);
  const [showSignals, setShowSignals] = useState(true);
  const [zoomLevel, setZoomLevel] = useState<number>(1); // 1 = 64 bars, 1.5 = 42 bars, 2.2 = 28 bars, 0.75 = 90 bars
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverYPrice, setHoverYPrice] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Switch automatically to replay mode when 100ms is selected for authentic sub-second feel
  const handleTfClick = (tf: string) => {
    onTimeframeChange(tf);
    if (tf === "100ms") {
      setChartMode("replay");
    } else if (chartMode === "replay" && tf !== "1s") {
      setChartMode("candles");
    }
  };

  // Slice visible klines based on semantic zoom level
  const visibleBars = useMemo(() => {
    const targetCount = Math.max(20, Math.min(klines.length, Math.round(64 / zoomLevel)));
    const sliced = klines.slice(-targetCount);
    if (sliced.length === 0) return [];
    // Ensure the last bar reflects the latest millisecond livePrice
    const last = { ...sliced[sliced.length - 1]! };
    last.close = livePrice;
    last.high = Math.max(last.high, livePrice);
    last.low = Math.min(last.low, livePrice);
    return [...sliced.slice(0, -1), last];
  }, [klines, zoomLevel, livePrice]);

  const closes = useMemo(() => visibleBars.map((b) => b.close), [visibleBars]);
  const emaFast = useMemo(() => computeEMA(closes, emaFastPeriod), [closes, emaFastPeriod]);
  const emaSlow = useMemo(() => computeEMA(closes, emaSlowPeriod), [closes, emaSlowPeriod]);
  const boll = useMemo(() => computeBollinger(closes, 20, 2), [closes]);

  // Synthetic volume per bar derived deterministically from bar range & close
  const volumes = useMemo(() => {
    return visibleBars.map((bar, idx) => {
      const spread = Math.max(coin.tickSize, bar.high - bar.low);
      const baseVol = (spread / Math.max(1e-6, bar.close)) * 180_000 * (0.65 + ((idx * 17) % 10) * 0.08);
      return Math.max(10, baseVol);
    });
  }, [visibleBars, coin.tickSize]);

  // Price domain calculation: include visible bars + active position TP/SL/Entry so position lines are always visible on chart!
  const priceDomain = useMemo(() => {
    if (visibleBars.length === 0) {
      return { min: coin.basePrice * 0.98, max: coin.basePrice * 1.02 };
    }
    let min = Infinity;
    let 생각하는Max = -Infinity;
    for (const bar of visibleBars) {
      if (bar.low < min) min = bar.low;
      if (bar.high > 생각하는Max) 생각하는Max = bar.high;
    }
    if (showBoll) {
      for (const u of boll.upper) if (u > 생각하는Max) 생각하는Max = u;
      for (const l of boll.lower) if (l < min) min = l;
    }
    if (showPositionOverlay && position && position.open) {
      if (position.entryPrice && position.entryPrice > 0) {
        min = Math.min(min, position.entryPrice);
        생각하는Max = Math.max(생각하는Max, position.entryPrice);
      }
      if (position.stopPrice > 0) {
        min = Math.min(min, position.stopPrice);
        생각하는Max = Math.max(생각하는Max, position.stopPrice);
      }
      if (position.takeProfitPrice > 0) {
        min = Math.min(min, position.takeProfitPrice);
        생각하는Max = Math.max(생각하는Max, position.takeProfitPrice);
      }
    }
    const span = Math.max(coin.tickSize * 12, 생각하는Max - min);
    const pad = span * 0.14;
    return { min: Math.max(coin.tickSize, min - pad), max: 생각하는Max + pad };
  }, [visibleBars, coin.basePrice, coin.tickSize, showBoll, boll, showPositionOverlay, position]);

  const W = 920;
  const H = 410;
  const PAD_LEFT = 14;
  const PAD_RIGHT = 86;
  const PAD_TOP = 18;
  const PAD_BOTTOM = 28;
  const PLOT_W = W - PAD_LEFT - PAD_RIGHT;
  const PLOT_H = H - PAD_TOP - PAD_BOTTOM;
  const VOL_H = 64;

  const toY = (price: number) => {
    const { min, max } = priceDomain;
    const ratio = (price - min) / Math.max(1e-9, max - min);
    return PAD_TOP + (1 - Math.min(1.03, Math.max(-0.03, ratio))) * PLOT_H;
  };

  const toPrice = (y: number) => {
    const { min, max } = priceDomain;
    const ratio = 1 - (y - PAD_TOP) / PLOT_H;
    return roundToPrecision(min + ratio * (max - min), coin.precision);
  };

  const toX = (idx: number) => {
    const count = Math.max(1, visibleBars.length);
    const step = PLOT_W / count;
    return PAD_LEFT + step * (idx + 0.5);
  };

  const maxVol = useMemo(() => Math.max(1, ...volumes), [volumes]);

  // Grid price ticks on right axis
  const yTicks = useMemo(() => {
    const count = 6;
    const { min, max } = priceDomain;
    return Array.from({ length: count }, (_, i) => {
      const val = min + ((max - min) * i) / (count - 1);
      return roundToPrecision(val, coin.precision);
    });
  }, [priceDomain, coin.precision]);

  // Grid strategy overlay lines
  const gridLevels = useMemo(() => {
    if (!gridOverlay.enabled || gridOverlay.upper <= gridOverlay.lower || gridOverlay.count < 2) {
      return [];
    }
    const levels: number[] = [];
    const n = Math.min(24, Math.max(2, gridOverlay.count));
    if (gridOverlay.mode === "geometric" && gridOverlay.lower > 0) {
      const ratio = (gridOverlay.upper / gridOverlay.lower) ** (1 / n);
      for (let i = 0; i <= n; i++) {
        levels.push(roundToPrecision(gridOverlay.lower * ratio ** i, coin.precision));
      }
    } else {
      const step = (gridOverlay.upper - gridOverlay.lower) / n;
      for (let i = 0; i <= n; i++) {
        levels.push(roundToPrecision(gridOverlay.lower + step * i, coin.precision));
      }
    }
    return levels;
  }, [gridOverlay, coin.precision]);

  // Map decision records onto visible bar indices
  const visibleDecisions = useMemo(() => {
    if (!showSignals || visibleBars.length === 0) return [];
    const offset = Math.max(0, klines.length - visibleBars.length);
    return decisions
      .map((d) => {
        const localIdx = d.klineIndex - offset;
        if (localIdx < 0 || localIdx >= visibleBars.length) return null;
        return { ...d, localIdx };
      })
      .filter((item): item is RichDecisionRecord & { localIdx: number } => item !== null);
  }, [showSignals, decisions, klines.length, visibleBars.length]);

  const activeIdx = hoverIdx != null && hoverIdx < visibleBars.length ? hoverIdx : visibleBars.length - 1;
  const activeBar = visibleBars[activeIdx] ?? {
    openTime: new Date().toISOString(),
    open: coin.open24h,
    high: coin.high24h,
    low: coin.low24h,
    close: livePrice,
  };
  const activeEmaFast = emaFast[activeIdx] ?? livePrice;
  const activeEmaSlow = emaSlow[activeIdx] ?? livePrice;
  const activeBollUp = boll.upper[activeIdx] ?? livePrice;
  const activeBollLow = boll.lower[activeIdx] ?? livePrice;

  const dailyChange = livePrice - coin.open24h;
  const dailyChangePct = coin.open24h > 0 ? (dailyChange / coin.open24h) * 100 : coin.change24hPct;
  const isUpDay = dailyChange >= 0;

  const handlePointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || visibleBars.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const relY = ((e.clientY - rect.top) / rect.height) * H;
    if (relX < PAD_LEFT || relX > W - PAD_RIGHT) {
      setHoverIdx(null);
      setHoverYPrice(null);
      return;
    }
    const idx = Math.max(
      0,
      Math.min(visibleBars.length - 1, Math.floor(((relX - PAD_LEFT) / PLOT_W) * visibleBars.length)),
    );
    setHoverIdx(idx);
    if (relY >= PAD_TOP && relY <= H - PAD_BOTTOM) {
      setHoverYPrice(toPrice(relY));
    } else {
      setHoverYPrice(null);
    }
  };

  const handlePointerLeave = () => {
    setHoverIdx(null);
    setHoverYPrice(null);
  };

  // Path builders for smooth lines
  const buildPolyline = (vals: number[]) =>
    vals.map((v, idx) => `${toX(idx).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");

  const buildAreaPath = (vals: number[]) => {
    if (vals.length === 0) return "";
    const pts = vals.map((v, idx) => `${toX(idx).toFixed(1)},${toY(v).toFixed(1)}`);
    const firstX = toX(0).toFixed(1);
    const lastX = toX(vals.length - 1).toFixed(1);
    const bottomY = (H - PAD_BOTTOM).toFixed(1);
    return `M ${pts.join(" L ")} L ${lastX},${bottomY} L ${firstX},${bottomY} Z`;
  };

  const formatBarTime = (iso: string) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "--:--";
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    if (timeframe === "100ms" || timeframe === "1s") {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const barStep = PLOT_W / Math.max(1, visibleBars.length);
  const candleWidth = Math.max(3, Math.min(14, barStep * 0.64));

  return (
    <div className={styles.terminalContainer}>
      {/* ---------------- 1. UIArc Market-Terminal 顶栏 ---------------- */}
      <div className={styles.terminalHeader}>
        <div className={styles.terminalSymbolBlock}>
          <CoinIcon icon={coin.icon} color={coin.color} label={coin.name} size={36} />
          <div>
            <div className={styles.terminalSymbolTitleRow}>
              <h2 className={styles.terminalSymbolName}>{coin.displaySymbol}</h2>
              <span className={styles.terminalCoinCn}>{coin.name}</span>
              <span className={styles.terminalCategoryBadge}>{coin.category}</span>
              <button
                type="button"
                className={`${styles.liveControlPill} ${isLiveRunning ? styles.liveControlOn : styles.liveControlPaused}`}
                onClick={onToggleLive}
                title={isLiveRunning ? "点击暂停毫秒级行情流" : "点击恢复毫秒级行情流"}
              >
                <span className={styles.livePulseDot} />
                {isLiveRunning ? <Pause size={11} /> : <Play size={11} />}
                <span>{isLiveRunning ? `LIVE · ${tickSpeed}ms` : "已暂停回放"}</span>
              </button>
            </div>
            <p className={styles.terminalMechanismText}>
              {coin.mechanism} · 风险等级：<strong>{coin.riskLevel}</strong>
            </p>
          </div>
        </div>

        <div className={styles.terminalPriceHero}>
          <div
            className={`${styles.terminalBigPrice} ${
              tickDelta > 0 ? styles.priceFlashUp : tickDelta < 0 ? styles.priceFlashDown : ""
            }`}
          >
            ${livePrice.toLocaleString("en-US", {
              minimumFractionDigits: coin.precision,
              maximumFractionDigits: coin.precision,
            })}
          </div>
          <div className={styles.terminalPriceSubRow}>
            <span className={isUpDay ? styles.toneUp : styles.toneDown}>
              {isUpDay ? "+" : ""}
              {dailyChange.toFixed(coin.precision)} ({isUpDay ? "+" : ""}
              {dailyChangePct.toFixed(2)}%) 今日
            </span>
            <span className={styles.tickCounterBadge}>
              Tick #{tickCount}
            </span>
          </div>
        </div>

        <dl className={styles.terminalStatGrid}>
          <div>
            <dt>24h 最高</dt>
            <dd>{Math.max(coin.high24h, livePrice).toFixed(coin.precision)}</dd>
          </div>
          <div>
            <dt>24h 最低</dt>
            <dd>{Math.min(coin.low24h, livePrice).toFixed(coin.precision)}</dd>
          </div>
          <div>
            <dt>24h 成交额</dt>
            <dd>{coin.volume24h}</dd>
          </div>
          <div>
            <dt>未平仓合约</dt>
            <dd>{coin.openInterest}</dd>
          </div>
          <div>
            <dt>资金费率</dt>
            <dd className={coin.fundingRate.startsWith("-") ? styles.toneDown : styles.toneUp}>
              {coin.fundingRate}
            </dd>
          </div>
          <div>
            <dt>日内波动率</dt>
            <dd>{coin.volatility24h.toFixed(1)}%</dd>
          </div>
        </dl>
      </div>

      {/* ---------------- 2. 终端图表工具条 ---------------- */}
      <div className={styles.terminalToolbar}>
        <div className={styles.toolbarGroup} role="group" aria-label="时间周期">
          {TIMEFRAME_OPTIONS.map((tf) => (
            <button
              key={tf}
              type="button"
              className={`${styles.toolbarPill} ${timeframe === tf ? styles.toolbarPillActive : ""}`}
              onClick={() => handleTfClick(tf)}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className={styles.toolbarDivider} />

        <div className={styles.toolbarGroup} role="group" aria-label="刷新频率">
          <span className={styles.toolbarGroupLabel}>采样</span>
          {SPEED_OPTIONS.map((spd) => (
            <button
              key={spd}
              type="button"
              className={`${styles.toolbarPill} ${tickSpeed === spd ? styles.toolbarPillActive : ""}`}
              onClick={() => onTickSpeedChange(spd)}
            >
              {spd === 1000 ? "1s" : `${spd}ms`}
            </button>
          ))}
        </div>

        <div className={styles.toolbarDivider} />

        <div className={styles.toolbarGroup} role="group" aria-label="图表模式">
          <button
            type="button"
            className={`${styles.toolbarPill} ${chartMode === "candles" ? styles.toolbarPillActive : ""}`}
            onClick={() => setChartMode("candles")}
          >
            <CandlestickChart size={13} />
            K线
          </button>
          <button
            type="button"
            className={`${styles.toolbarPill} ${chartMode === "replay" ? styles.toolbarPillActive : ""}`}
            onClick={() => setChartMode("replay")}
          >
            <Activity size={13} />
            毫秒闪电图
          </button>
          <button
            type="button"
            className={`${styles.toolbarPill} ${chartMode === "area" ? styles.toolbarPillActive : ""}`}
            onClick={() => setChartMode("area")}
          >
            <TrendingUp size={13} />
            深度面积
          </button>
        </div>

        <div className={styles.toolbarDivider} />

        <div className={styles.toolbarGroup} role="group" aria-label="指标与图层融合">
          <button
            type="button"
            className={`${styles.toolbarPill} ${showEma ? styles.toolbarPillAccent : ""}`}
            onClick={() => setShowEma((v) => !v)}
          >
            EMA {emaFastPeriod}/{emaSlowPeriod}
          </button>
          <button
            type="button"
            className={`${styles.toolbarPill} ${showBoll ? styles.toolbarPillAccent : ""}`}
            onClick={() => setShowBoll((v) => !v)}
          >
            BOLL(20,2)
          </button>
          <button
            type="button"
            className={`${styles.toolbarPill} ${showPositionOverlay ? styles.toolbarPillPosition : ""}`}
            onClick={onTogglePositionOverlay}
            title="将当前持仓的入场线、止盈线、止损线与实时浮盈标签直接融合绘制在图表画布中"
          >
            <Target size={13} />
            持仓融合图层
          </button>
          {position?.isSimulated || !position ? (
            <button
              type="button"
              className={`${styles.toolbarPill} ${positionPreviewEnabled ? styles.toolbarPillAccent : ""}`}
              onClick={onTogglePositionPreview}
              title="当实盘空仓时，在图表上生成演示持仓线以预览入场/止盈/止损空间"
            >
              <Sparkles size={12} />
              {positionPreviewEnabled ? "演练仓位: 开" : "演练仓位: 关"}
            </button>
          ) : null}
          <button
            type="button"
            className={`${styles.toolbarPill} ${gridOverlay.enabled ? styles.toolbarPillAccent : ""}`}
            onClick={onToggleGridOverlay}
          >
            <Layers size={13} />
            网格线
          </button>
          <button
            type="button"
            className={`${styles.toolbarPill} ${showSignals ? styles.toolbarPillAccent : ""}`}
            onClick={() => setShowSignals((v) => !v)}
          >
            决策打点
          </button>
        </div>

        <div className={styles.toolbarGroupRight}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setZoomLevel((z) => Math.min(2.6, Number((z * 1.25).toFixed(2))))}
            title="语义放大（聚焦毫秒级微结构）"
            aria-label="放大图表"
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setZoomLevel((z) => Math.max(0.65, Number((z / 1.25).toFixed(2))))}
            title="语义缩小（查看全局波段结构）"
            aria-label="缩小图表"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setZoomLevel(1)}
            title="重置缩放比例"
            aria-label="重置缩放"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {/* ---------------- 3. Crosshair OHLCV + 指标实时读数条 ---------------- */}
      <div className={styles.ohlcStrip}>
        <span className={styles.ohlcTime}>{formatBarTime(activeBar.openTime)}</span>
        <span>
          开 <strong>{activeBar.open.toFixed(coin.precision)}</strong>
        </span>
        <span>
          高 <strong className={styles.toneUp}>{activeBar.high.toFixed(coin.precision)}</strong>
        </span>
        <span>
          低 <strong className={styles.toneDown}>{activeBar.low.toFixed(coin.precision)}</strong>
        </span>
        <span>
          收{" "}
          <strong className={activeBar.close >= activeBar.open ? styles.toneUp : styles.toneDown}>
            {activeBar.close.toFixed(coin.precision)}
          </strong>
        </span>
        {showEma ? (
          <>
            <span className={styles.emaFastReadout}>
              EMA({emaFastPeriod}) {activeEmaFast.toFixed(coin.precision)}
            </span>
            <span className={styles.emaSlowReadout}>
              EMA({emaSlowPeriod}) {activeEmaSlow.toFixed(coin.precision)}
            </span>
          </>
        ) : null}
        {showBoll ? (
          <span className={styles.bollReadout}>
            BOLL [{activeBollLow.toFixed(coin.precision)} ~ {activeBollUp.toFixed(coin.precision)}]
          </span>
        ) : null}
        {showPositionOverlay && position && position.open ? (
          <span className={styles.ohlcPositionHint}>
            图内仓位：{position.side === "short" ? "空 SHORT" : "多 LONG"} {position.leverage}x · 入场{" "}
            {position.entryPrice?.toFixed(coin.precision)} · 止盈 {position.takeProfitPrice.toFixed(coin.precision)} · 止损{" "}
            {position.stopPrice.toFixed(coin.precision)}
          </span>
        ) : null}
      </div>

      {/* ---------------- 4. 主交互式 SVG 画布（含仓位融合层、网格层、信号打点） ---------------- */}
      <div className={styles.chartCanvasWrap} data-chart-lib="uiarc-market-terminal">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className={styles.terminalSvg}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          role="img"
          aria-label={`${coin.displaySymbol} ${timeframe} 毫秒级行情与持仓融合图表`}
        >
          <defs>
            <linearGradient id="terminalAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={isUpDay ? "#10b981" : "#ef4444"} stopOpacity="0.28" />
              <stop offset="85%" stopColor={isUpDay ? "#10b981" : "#ef4444"} stopOpacity="0.02" />
              <stop offset="100%" stopColor={isUpDay ? "#10b981" : "#ef4444"} stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="tpZoneGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.13" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.04" />
            </linearGradient>
            <linearGradient id="slZoneGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity="0.05" />
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0.14" />
            </linearGradient>
          </defs>

          {/* 背景水平价格网格线与右侧坐标轴刻度 */}
          {yTicks.map((tick) => {
            const y = toY(tick);
            return (
              <g key={tick}>
                <line
                  x1={PAD_LEFT}
                  x2={W - PAD_RIGHT}
                  y1={y}
                  y2={y}
                  stroke="var(--border-subtle)"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text
                  x={W - PAD_RIGHT + 8}
                  y={y + 3.5}
                  fill="var(--text-muted)"
                  fontSize="10.5"
                  fontFamily="var(--font-mono, monospace)"
                >
                  {tick.toFixed(coin.precision)}
                </text>
              </g>
            );
          })}

          {/* 垂直时间参考线 */}
          {visibleBars.map((bar, idx) => {
            const step = Math.max(6, Math.round(visibleBars.length / 6));
            if (idx % step !== 0 && idx !== visibleBars.length - 1) return null;
            const x = toX(idx);
            return (
              <g key={`x-${bar.openTime}-${idx}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={PAD_TOP}
                  y2={H - PAD_BOTTOM}
                  stroke="var(--border-subtle)"
                  strokeDasharray="2 4"
                  strokeWidth="1"
                />
                <text
                  x={x}
                  y={H - 8}
                  textAnchor="middle"
                  fill="var(--text-muted)"
                  fontSize="10"
                  fontFamily="var(--font-mono, monospace)"
                >
                  {formatBarTime(bar.openTime)}
                </text>
              </g>
            );
          })}

          {/* ---------------- 仓位背景盈亏区间带（当有持仓时直接融入画布底层） ---------------- */}
          {showPositionOverlay && position && position.open && position.entryPrice ? (
            <g aria-label="持仓止盈止损区间带">
              {/* 入场价 ~ 止盈价 收益目标区 */}
              <rect
                x={PAD_LEFT}
                y={Math.min(toY(position.entryPrice), toY(position.takeProfitPrice))}
                width={PLOT_W}
                height={Math.max(2, Math.abs(toY(position.takeProfitPrice) - toY(position.entryPrice)))}
                fill="url(#tpZoneGrad)"
              />
              {/* 入场价 ~ 止损价 风险控制区 */}
              <rect
                x={PAD_LEFT}
                y={Math.min(toY(position.entryPrice), toY(position.stopPrice))}
                width={PLOT_W}
                height={Math.max(2, Math.abs(toY(position.stopPrice) - toY(position.entryPrice)))}
                fill="url(#slZoneGrad)"
              />
            </g>
          ) : null}

          {/* ---------------- 网格策略水平挂单线图层 ---------------- */}
          {gridLevels.map((lvl, idx) => {
            const y = toY(lvl);
            if (y < PAD_TOP || y > H - PAD_BOTTOM) return null;
            const isBuyGrid = lvl <= livePrice;
            return (
              <g key={`grid-${lvl}-${idx}`}>
                <line
                  x1={PAD_LEFT}
                  x2={W - PAD_RIGHT}
                  y1={y}
                  y2={y}
                  stroke={isBuyGrid ? "rgba(16, 185, 129, 0.45)" : "rgba(239, 68, 68, 0.45)"}
                  strokeDasharray="2 5"
                  strokeWidth="1"
                />
                {idx === 0 || idx === gridLevels.length - 1 ? (
                  <text
                    x={PAD_LEFT + 6}
                    y={y - 3}
                    fontSize="9.5"
                    fill={isBuyGrid ? "#10b981" : "#ef4444"}
                  >
                    网格 #{idx + 1} ({isBuyGrid ? "买" : "卖"} {lvl.toFixed(coin.precision)})
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* ---------------- 底部成交量柱状图 ---------------- */}
          {visibleBars.map((bar, idx) => {
            const x = toX(idx);
            const vol = volumes[idx] ?? 0;
            const barH = Math.max(2, (vol / maxVol) * VOL_H);
            const y = H - PAD_BOTTOM - barH;
            const isUp = bar.close >= bar.open;
            return (
              <rect
                key={`vol-${idx}`}
                x={x - candleWidth / 2}
                y={y}
                width={candleWidth}
                height={barH}
                rx={1}
                fill={isUp ? "rgba(16, 185, 129, 0.22)" : "rgba(239, 68, 68, 0.22)"}
              />
            );
          })}

          {/* ---------------- 布林带通道 ---------------- */}
          {showBoll && closes.length > 1 ? (
            <g>
              <polyline
                fill="none"
                stroke="rgba(139, 92, 246, 0.55)"
                strokeWidth="1.2"
                strokeDasharray="3 3"
                points={buildPolyline(boll.upper)}
              />
              <polyline
                fill="none"
                stroke="rgba(139, 92, 246, 0.55)"
                strokeWidth="1.2"
                strokeDasharray="3 3"
                points={buildPolyline(boll.lower)}
              />
            </g>
          ) : null}

          {/* ---------------- 主价格序列：K线蜡烛 或 毫秒闪电图/面积图 ---------------- */}
          {chartMode === "candles" ? (
            <g>
              {visibleBars.map((bar, idx) => {
                const x = toX(idx);
                const isUp = bar.close >= bar.open;
                const color = isUp ? "#089981" : "#f23645";
                const highY = toY(bar.high);
                const lowY = toY(bar.low);
                const openY = toY(bar.open);
                const closeY = toY(bar.close);
                const bodyTop = Math.min(openY, closeY);
                const bodyH = Math.max(2, Math.abs(closeY - openY));
                return (
                  <g key={`bar-${bar.openTime}-${idx}`}>
                    <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth="1.3" />
                    <rect
                      x={x - candleWidth / 2}
                      y={bodyTop}
                      width={candleWidth}
                      height={bodyH}
                      rx={1}
                      fill={color}
                    />
                  </g>
                );
              })}
            </g>
          ) : (
            <g>
              <path d={buildAreaPath(closes)} fill="url(#terminalAreaGrad)" />
              <polyline
                fill="none"
                stroke={isUpDay ? "#089981" : "#f23645"}
                strokeWidth="2.2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={buildPolyline(closes)}
              />
              {/* 毫秒级最新价格脉冲圆点 */}
              {closes.length > 0 ? (
                <g transform={`translate(${toX(closes.length - 1)}, ${toY(livePrice)})`}>
                  <circle r="7" fill={isUpDay ? "rgba(16, 185, 129, 0.28)" : "rgba(239, 68, 68, 0.28)"} />
                  <circle r="3.6" fill={isUpDay ? "#10b981" : "#ef4444"} stroke="#fff" strokeWidth="1.2" />
                </g>
              ) : null}
            </g>
          )}

          {/* ---------------- EMA 快慢均线图层 ---------------- */}
          {showEma && closes.length > 1 ? (
            <g>
              <polyline
                fill="none"
                stroke="#f59e0b"
                strokeWidth="1.6"
                points={buildPolyline(emaFast)}
              />
              <polyline
                fill="none"
                stroke="#3b82f6"
                strokeWidth="1.6"
                points={buildPolyline(emaSlow)}
              />
            </g>
          ) : null}

          {/* ---------------- 仓位融合图层（入场线、止盈线、止损线、图内交互式持仓胶囊） ---------------- */}
          {showPositionOverlay && position && position.open && position.entryPrice ? (
            <g aria-label="图内持仓融合图层">
              {/* 1. 止盈线 (TP) */}
              {position.takeProfitPrice > 0 ? (
                <g transform={`translate(0, ${toY(position.takeProfitPrice)})`}>
                  <line
                    x1={PAD_LEFT}
                    x2={W - PAD_RIGHT}
                    y1={0}
                    y2={0}
                    stroke="#089981"
                    strokeWidth="1.5"
                    strokeDasharray="5 4"
                  />
                  <rect
                    x={PAD_LEFT + 12}
                    y={-11}
                    width={228}
                    height={20}
                    rx={5}
                    fill="#089981"
                  />
                  <text
                    x={PAD_LEFT + 20}
                    y={3}
                    fill="#ffffff"
                    fontSize="10.5"
                    fontWeight="600"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    止盈 TP {position.takeProfitPrice.toFixed(coin.precision)} · 预计 +$
                    {(
                      Math.abs(position.takeProfitPrice - position.entryPrice) *
                      (position.qty ?? coin.defaultQty)
                    ).toFixed(2)}
                  </text>
                  {/* 右侧坐标轴止盈尾标 */}
                  <rect x={W - PAD_RIGHT} y={-9} width={PAD_RIGHT - 2} height={18} rx={3} fill="#089981" />
                  <text
                    x={W - PAD_RIGHT + 6}
                    y={3.5}
                    fill="#fff"
                    fontSize="10"
                    fontWeight="700"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    TP {position.takeProfitPrice.toFixed(coin.precision)}
                  </text>
                </g>
              ) : null}

              {/* 2. 止损线 (SL) */}
              {position.stopPrice > 0 ? (
                <g transform={`translate(0, ${toY(position.stopPrice)})`}>
                  <line
                    x1={PAD_LEFT}
                    x2={W - PAD_RIGHT}
                    y1={0}
                    y2={0}
                    stroke="#f23645"
                    strokeWidth="1.5"
                    strokeDasharray="5 4"
                  />
                  <rect
                    x={PAD_LEFT + 12}
                    y={-11}
                    width={228}
                    height={20}
                    rx={5}
                    fill="#f23645"
                  />
                  <text
                    x={PAD_LEFT + 20}
                    y={3}
                    fill="#ffffff"
                    fontSize="10.5"
                    fontWeight="600"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    止损 SL {position.stopPrice.toFixed(coin.precision)} · 风险 -$
                    {(
                      Math.abs(position.entryPrice - position.stopPrice) *
                      (position.qty ?? coin.defaultQty)
                    ).toFixed(2)}
                  </text>
                  {/* 右侧坐标轴止损尾标 */}
                  <rect x={W - PAD_RIGHT} y={-9} width={PAD_RIGHT - 2} height={18} rx={3} fill="#f23645" />
                  <text
                    x={W - PAD_RIGHT + 6}
                    y={3.5}
                    fill="#fff"
                    fontSize="10"
                    fontWeight="700"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    SL {position.stopPrice.toFixed(coin.precision)}
                  </text>
                </g>
              ) : null}

              {/* 3. 入场线 (Entry) + 实时浮盈胶囊徽标 */}
              <g transform={`translate(0, ${toY(position.entryPrice)})`}>
                <line
                  x1={PAD_LEFT}
                  x2={W - PAD_RIGHT}
                  y1={0}
                  y2={0}
                  stroke="#f59e0b"
                  strokeWidth="1.8"
                />
                <rect
                  x={PAD_LEFT + 12}
                  y={-13}
                  width={368}
                  height={24}
                  rx={6}
                  fill="var(--surface)"
                  stroke="#f59e0b"
                  strokeWidth="1.5"
                />
                <rect
                  x={PAD_LEFT + 12}
                  y={-13}
                  width={68}
                  height={24}
                  rx={6}
                  fill={position.side === "short" ? "#f23645" : "#089981"}
                />
                <text
                  x={PAD_LEFT + 46}
                  y={3}
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize="10.5"
                  fontWeight="700"
                >
                  {position.side === "short" ? "空 SHORT" : "多 LONG"} {position.leverage}x
                </text>
                <text
                  x={PAD_LEFT + 88}
                  y={3}
                  fill="var(--foreground)"
                  fontSize="10.5"
                  fontWeight="600"
                  fontFamily="var(--font-mono, monospace)"
                >
                  {position.qty} {coin.base} @ {position.entryPrice.toFixed(coin.precision)}
                </text>
                <text
                  x={PAD_LEFT + 228}
                  y={3}
                  fill={(position.unrealizedPnl ?? 0) >= 0 ? "#089981" : "#f23645"}
                  fontSize="10.5"
                  fontWeight="700"
                  fontFamily="var(--font-mono, monospace)"
                >
                  {(position.unrealizedPnl ?? 0) >= 0 ? "+" : ""}
                  {(position.unrealizedPnl ?? 0).toFixed(2)}U ({position.roePct >= 0 ? "+" : ""}
                  {position.roePct.toFixed(2)}% / {position.rMultiple >= 0 ? "+" : ""}
                  {position.rMultiple.toFixed(2)}R)
                </text>
                {/* 右侧坐标轴入场尾标 */}
                <rect x={W - PAD_RIGHT} y={-9} width={PAD_RIGHT - 2} height={18} rx={3} fill="#f59e0b" />
                <text
                  x={W - PAD_RIGHT + 6}
                  y={3.5}
                  fill="#111827"
                  fontSize="10"
                  fontWeight="700"
                  fontFamily="var(--font-mono, monospace)"
                >
                  入场 {position.entryPrice.toFixed(coin.precision)}
                </text>
              </g>
            </g>
          ) : null}

          {/* ---------------- 实时标记价（Mark Price）水平基准线与右侧高亮标签 ---------------- */}
          <g transform={`translate(0, ${toY(livePrice)})`}>
            <line
              x1={PAD_LEFT}
              x2={W - PAD_RIGHT}
              y1={0}
              y2={0}
              stroke="#2563eb"
              strokeWidth="1.2"
              strokeDasharray="2 2"
            />
            <rect
              x={W - PAD_RIGHT}
              y={-10}
              width={PAD_RIGHT - 2}
              height={20}
              rx={4}
              fill="#2563eb"
            />
            <text
              x={W - PAD_RIGHT + 6}
              y={3.5}
              fill="#ffffff"
              fontSize="10.5"
              fontWeight="700"
              fontFamily="var(--font-mono, monospace)"
            >
              {livePrice.toFixed(coin.precision)}
            </text>
          </g>

          {/* ---------------- 策略与 AI 决策记录图上信号打点 ---------------- */}
          {visibleDecisions.map((dec) => {
            const x = toX(dec.localIdx);
            const bar = visibleBars[dec.localIdx];
            if (!bar) return null;
            const isLongSig = dec.side !== "short";
            const y = isLongSig ? toY(bar.low) + 16 : toY(bar.high) - 16;
            const isHighlighted = highlightedDecisionId === dec.id;
            const pinColor =
              dec.action === "GATE_SKIP"
                ? "#f59e0b"
                : isLongSig
                  ? "#10b981"
                  : "#ef4444";
            return (
              <g
                key={dec.id}
                transform={`translate(${x}, ${y})`}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectDecision?.(isHighlighted ? null : dec.id);
                }}
              >
                {isHighlighted ? (
                  <circle r="13" fill="none" stroke={pinColor} strokeWidth="2" strokeDasharray="3 2" />
                ) : null}
                <circle
                  r={isHighlighted ? "8.5" : "6.5"}
                  fill={pinColor}
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
                <text
                  x="0"
                  y="3"
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize="8.5"
                  fontWeight="800"
                >
                  {dec.action === "GATE_SKIP" ? "!" : isLongSig ? "B" : "S"}
                </text>
              </g>
            );
          })}

          {/* ---------------- 鼠标十字光标 (Crosshair) ---------------- */}
          {hoverIdx != null && visibleBars[hoverIdx] ? (
            <g pointerEvents="none">
              <line
                x1={toX(hoverIdx)}
                x2={toX(hoverIdx)}
                y1={PAD_TOP}
                y2={H - PAD_BOTTOM}
                stroke="var(--text-secondary)"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              {hoverYPrice != null ? (
                <g>
                  <line
                    x1={PAD_LEFT}
                    x2={W - PAD_RIGHT}
                    y1={toY(hoverYPrice)}
                    y2={toY(hoverYPrice)}
                    stroke="var(--text-secondary)"
                    strokeDasharray="3 3"
                    strokeWidth="1"
                  />
                  <rect
                    x={W - PAD_RIGHT}
                    y={toY(hoverYPrice) - 9}
                    width={PAD_RIGHT - 2}
                    height={18}
                    rx={3}
                    fill="var(--foreground)"
                  />
                  <text
                    x={W - PAD_RIGHT + 6}
                    y={toY(hoverYPrice) + 3.5}
                    fill="var(--background)"
                    fontSize="10"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    {hoverYPrice.toFixed(coin.precision)}
                  </text>
                </g>
              ) : null}
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
}
