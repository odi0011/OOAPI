/**
 * 交易数据看板核心展示与交互分区组件：
 * - CoinSelector：多币种结构化详情选择器 + 资产深度档案与合约规格横幅
 * - BalanceHero：首屏总余额、今日盈亏（修复 100x 百分比 bug）、净值迷你曲线与加速扫描
 * - PositionCard：当前持仓状态条（支持实盘持仓与图表融合演练仓位）
 * - QuickTradePanel：快速执行与图表仓位融合沙盒
 * - ParamPanel：策略核心风控与信号参数概览
 * - HistoryPanel：历史开仓记录 + 活跃保护挂单双视图
 * - DecisionLogPanel：多因子 AI/策略决策记录（支持一键图上定位回放）
 * 全品种涨跌幅图在 FusedMarketOverview，不替换这里的单品种选择器。
 */
import { useState } from "react";

import { Button } from "@/components/arc/button/button";

import CoinIcon from "./CoinIcon";
import {
  COINS,
  coinInfoOf,
  roundToPrecision,
  type CoinInfo,
  type EnrichedPosition,
  type RichDecisionRecord,
} from "./coins";
import type {
  DetectionEvent,
  EngineBalance,
  EngineOrder,
  EnginePosition,
  EngineState,
  Strategy,
  TradeEntry,
} from "../tradingApi";
import { formatAmount, sideText } from "../tradingDeskView";

import styles from "../TradingBoard.module.css";

function toneClass(value: number | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "";
  return value > 0 ? styles.toneUp : styles.toneDown;
}

function formatTime(value?: string): string {
  if (!value) return "--";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 渲染内联 SVG Sparkline 迷你走势线 */
function MiniSparkline({
  points,
  positive,
  width = 76,
  height = 24,
}: {
  points: readonly number[];
  positive: boolean;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const span = Math.max(1e-9, max - min);
  const coords = points.map((p, idx) => {
    const x = (idx / (points.length - 1)) * (width - 4) + 2;
    const y = height - 3 - ((p - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke = positive ? "#10b981" : "#f43f5e";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={styles.sparkSvg} aria-hidden>
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={coords.join(" ")}
      />
    </svg>
  );
}

/* ---------------------------------- 币种选择器与多币种深度档案 ---------------------------------- */

interface CoinSelectorProps {
  value: string;
  onChange: (symbol: string) => void;
  /** 每个币种对应的策略数量（用于展示“有策略”角标） */
  strategyCount?: Record<string, number>;
  /** 每个币种的实时跳动价格映射 */
  livePrices?: Record<string, number>;
  /** 快速为当前未配置币种初始化策略 */
  onQuickCreateStrategy?: (symbol: string) => void;
  creatingSymbol?: string | null;
}

export function CoinSelector({
  value,
  onChange,
  strategyCount,
  livePrices,
  onQuickCreateStrategy,
  creatingSymbol,
}: CoinSelectorProps) {
  const [showProfile, setShowProfile] = useState(true);
  const activeCoin = coinInfoOf(value);
  const activeCount = strategyCount?.[activeCoin.symbol] ?? 0;

  return (
    <section className={styles.panel} aria-label="币种选择">
      <div className={styles.coinSelectorHead}>
        <div className={styles.coinSelectorTitleWrap}>
          <span className={styles.sectionEyebrow}>MULTI-ASSET WATCHLIST</span>
          <h2 className={styles.panelTitle}>多币种合约矩阵与标的研究档案</h2>
        </div>
        <div className={styles.coinSelectorActions}>
          {activeCount === 0 && onQuickCreateStrategy ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={creatingSymbol === activeCoin.symbol}
              onClick={() => onQuickCreateStrategy(activeCoin.symbol)}
            >
              {creatingSymbol === activeCoin.symbol ? "正在初始化…" : `+ 为 ${activeCoin.base} 创建策略`}
            </Button>
          ) : null}
          <button
            type="button"
            className={styles.profileToggleBtn}
            onClick={() => setShowProfile((prev) => !prev)}
          >
            {showProfile ? "收起币种深度档案" : "展开币种深度档案"}
          </button>
        </div>
      </div>

      <div className={styles.coinList} role="listbox" aria-label="选择币种">
        {COINS.map((coin) => {
          const selected = coin.symbol === value;
          const count = strategyCount?.[coin.symbol] ?? 0;
          const livePrice = livePrices?.[coin.symbol] ?? coin.basePrice;
          const changePct =
            coin.open24h > 0 ? ((livePrice - coin.open24h) / coin.open24h) * 100 : coin.change24hPct;
          const isUp = changePct >= 0;

          return (
            <button
              key={coin.symbol}
              type="button"
              role="option"
              aria-selected={selected}
              className={`${styles.coinItem} ${selected ? styles.coinItemActive : ""}`}
              onClick={() => onChange(coin.symbol)}
            >
              <div className={styles.coinTopRow}>
                <CoinIcon icon={coin.icon} color={coin.color} label={coin.name} size={32} />
                <div className={styles.coinMeta}>
                  <span className={styles.coinNameRow}>
                    <strong className={styles.coinName}>{coin.name}</strong>
                    <span className={styles.coinSymbol}>{coin.symbol}</span>
                    {count > 0 ? (
                      <span className={styles.coinBadge}>{count} 策略</span>
                    ) : (
                      <span className={styles.coinBadgeMuted}>待建</span>
                    )}
                  </span>
                  <span className={styles.coinCategoryTag}>{coin.category}</span>
                </div>
                <div className={styles.coinPriceCol}>
                  <strong className={styles.coinLivePrice}>{livePrice.toFixed(coin.precision)}</strong>
                  <span className={`${styles.coinChangeBadge} ${isUp ? styles.toneUp : styles.toneDown}`}>
                    {isUp ? "+" : ""}
                    {changePct.toFixed(2)}%
                  </span>
                </div>
              </div>

              <p className={styles.coinDesc}>{coin.description}</p>

              <div className={styles.coinBottomRow}>
                <div className={styles.coinMiniStats}>
                  <span>24h 量 {coin.volume24h}</span>
                  <span>OI {coin.openInterest}</span>
                  <span>费率 {coin.fundingRate}</span>
                </div>
                <MiniSparkline points={coin.sparkline} positive={isUp} width={68} height={20} />
              </div>
            </button>
          );
        })}
      </div>

      {showProfile ? (
        <div className={styles.assetProfileCard} aria-label={`${activeCoin.name} 深度档案`}>
          <div className={styles.assetProfileMain}>
            <div className={styles.assetProfileHeader}>
              <CoinIcon icon={activeCoin.icon} color={activeCoin.color} label={activeCoin.name} size={36} />
              <div>
                <div className={styles.assetProfileTitleRow}>
                  <strong>
                    {activeCoin.name}（{activeCoin.displaySymbol}）
                  </strong>
                  <span className={styles.assetTag}>{activeCoin.fullName}</span>
                  <span className={styles.assetRiskTag}>{activeCoin.riskLevel}</span>
                </div>
                <p className={styles.assetMechanism}>{activeCoin.mechanism}</p>
              </div>
            </div>
            <p className={styles.assetIntro}>{activeCoin.introduction}</p>
            <dl className={styles.contractSpecsGrid}>
              <div>
                <dt>最小变动价位 (Tick)</dt>
                <dd>{activeCoin.tickSize} USDT</dd>
              </div>
              <div>
                <dt>最小下单数量</dt>
                <dd>
                  {activeCoin.minOrder} {activeCoin.base}
                </dd>
              </div>
              <div>
                <dt>最高支持杠杆</dt>
                <dd>{activeCoin.maxLeverage}x 逐仓</dd>
              </div>
              <div>
                <dt>Maker / Taker 费率</dt>
                <dd>
                  {activeCoin.makerFee} / {activeCoin.takerFee}
                </dd>
              </div>
              <div>
                <dt>市值规模 / 24h 成交</dt>
                <dd>
                  {activeCoin.marketCap} / {activeCoin.volume24h}
                </dd>
              </div>
              <div>
                <dt>日内年化波动率</dt>
                <dd>{activeCoin.volatility24h.toFixed(1)}%</dd>
              </div>
            </dl>
          </div>

          <div className={styles.assetFactorBox}>
            <span className={styles.factorTitle}>量化五维因子适配画像</span>
            <div className={styles.factorList}>
              {[
                { label: "趋势持续度 (Trend)", val: activeCoin.factors.trend },
                { label: "动量爆发力 (Momentum)", val: activeCoin.factors.momentum },
                { label: "盘口深度 (Liquidity)", val: activeCoin.factors.liquidity },
                { label: "波动率弹性 (Volatility)", val: activeCoin.factors.volatility },
                { label: "均值回归 (Mean-Rev)", val: activeCoin.factors.meanReversion },
              ].map((item) => (
                <div key={item.label} className={styles.factorRow}>
                  <span className={styles.factorLabel}>
                    <span>{item.label}</span>
                    <strong>{item.val}/100</strong>
                  </span>
                  <div className={styles.factorTrack}>
                    <div
                      className={styles.factorFill}
                      style={{ width: `${item.val}%`, background: activeCoin.color }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ---------------------------------- 余额首屏 (First Screen Balance Hero) ---------------------------------- */

interface KpiProps {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}

function Kpi({ label, value, sub, tone }: KpiProps) {
  return (
    <div className={styles.kpiCard}>
      <span className={styles.kpiLabel}>{label}</span>
      <strong className={`${styles.kpiValue} ${tone ?? ""}`}>{value}</strong>
      {sub ? <span className={styles.kpiSub}>{sub}</span> : null}
    </div>
  );
}

interface BalanceHeroProps {
  coin: CoinInfo;
  balance: EngineBalance | null;
  loading: boolean;
  error?: string;
  isSimulated?: boolean;
  engine?: EngineState | null;
  strategy?: Strategy | null;
  onTriggerBoost?: () => void;
  boostBusy?: boolean;
}

export function BalanceHero({
  coin,
  balance,
  loading,
  error,
  isSimulated = false,
  engine,
  strategy,
  onTriggerBoost,
  boostBusy = false,
}: BalanceHeroProps) {
  // 注意：后端 ComputeTodayPanelPnL 返回的 balance.todayPct 已经是百分比数值（如 2.58 表示 2.58%），
  // 严禁二次乘以 100（修复审计报告 D3 问题）。
  const todayPctText =
    balance && Number.isFinite(balance.todayPct)
      ? `${balance.todayPct >= 0 ? "+" : ""}${balance.todayPct.toFixed(2)}%`
      : undefined;

  const marginRatio =
    balance && balance.equity > 0 ? (balance.marginUsed / balance.equity) * 100 : 0;

  const equityPoints =
    balance?.history && balance.history.length > 1
      ? balance.history.map((pt) => pt.equity)
      : coin.sparkline;

  const isRunning =
    strategy != null &&
    (strategy.running === true ||
      engine?.state === "Armed" ||
      engine?.state === "InPosition" ||
      engine?.state === "Entering" ||
      engine?.state === "Exiting");

  const engineLabel =
    engine?.state === "InPosition"
      ? "持仓盯盘中 (InPosition)"
      : engine?.state === "Armed"
        ? "实时扫描待命 (Armed)"
        : engine?.state === "DailyHalt"
          ? "日亏熔断保护 (DailyHalt)"
          : engine?.state === "Error"
            ? "保护异常待恢复 (Error)"
            : isRunning
              ? "运行中 (Active)"
              : "待命未启动 (Idle)";

  return (
    <section className={styles.panel} aria-label="总余额">
      <header className={styles.panelHeadRow}>
        <div>
          <div className={styles.heroTitleRow}>
            <h2 className={styles.panelTitle}>总余额</h2>
            <span className={styles.heroBadge}>
              {isSimulated ? "多维终端组合视图" : "交易所实时账户"}
            </span>
            <span className={styles.heroEngineBadge} data-active={isRunning}>
              {engineLabel}
            </span>
          </div>
          <p className={styles.panelDesc}>
            {coin.name}（{coin.symbol}）账户总览。钱包、可用与权益来自交易所账户，今日盈亏按上海 0 点起算。
          </p>
        </div>

        <div className={styles.heroRightControls}>
          {onTriggerBoost ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={boostBusy}
              onClick={onTriggerBoost}
            >
              {boostBusy ? "加速扫描中…" : "⚡ Boost 毫秒级强扫"}
            </Button>
          ) : null}
          <span className={styles.liveDot} aria-label="实时更新中">
            <i />
            实时
          </span>
        </div>
      </header>

      {error ? (
        <p className={styles.errorBar} role="alert">
          {error}
        </p>
      ) : balance == null ? (
        <p className={styles.emptyText}>
          {loading ? "正在读取账户余额…" : "该币种暂无策略，先在系统设置里创建策略。"}
        </p>
      ) : (
        <div className={styles.balanceHeroBody}>
          <div className={styles.balancePrimaryBanner}>
            <div className={styles.balancePrimaryCol}>
              <span className={styles.balancePrimaryLabel}>PORTFOLIO TOTAL EQUITY · 账户总权益</span>
              <div className={styles.balancePrimaryValueRow}>
                <strong className={styles.balancePrimaryValue}>
                  ${formatAmount(balance.equity)} <small>USDT</small>
                </strong>
                {todayPctText ? (
                  <span
                    className={`${styles.balanceTodayPill} ${toneClass(balance.todayPnl)}`}
                    title="今日收益率（按上海 00:00 基准本金核算）"
                  >
                    今日 {todayPctText} ({balance.todayPnl >= 0 ? "+" : ""}
                    {formatAmount(balance.todayPnl)} USDT)
                  </span>
                ) : null}
              </div>
              <div className={styles.balanceSubMeta}>
                <span>钱包净值：{formatAmount(balance.wallet)} USDT</span>
                <span>日初基准：{formatAmount(balance.todayBase ?? balance.wallet)} USDT</span>
                <span>已实现盈亏：{balance.todayRealized >= 0 ? "+" : ""}{formatAmount(balance.todayRealized)} USDT</span>
              </div>
            </div>

            <div className={styles.balanceCurveCol}>
              <div className={styles.balanceCurveHead}>
                <span>日内净值轨迹 (Intraday Equity Curve)</span>
                <strong className={toneClass(balance.todayPnl)}>
                  {todayPctText ?? "+0.00%"}
                </strong>
              </div>
              <MiniSparkline
                points={equityPoints}
                positive={(balance.todayPnl ?? 0) >= 0}
                width={210}
                height={42}
              />
            </div>
          </div>

          <div className={styles.kpiRow}>
            <Kpi
              label="账户权益"
              value={`${formatAmount(balance.equity)} USDT`}
              sub={`钱包 ${formatAmount(balance.wallet)} USDT`}
            />
            <Kpi
              label="可用余额"
              value={`${formatAmount(balance.available)} USDT`}
              sub={`可用购买力 ${(balance.available * (strategy?.leverage ?? 5)).toFixed(0)} USDT`}
            />
            <Kpi
              label="今日盈亏"
              value={`${balance.todayPnl >= 0 ? "+" : ""}${formatAmount(balance.todayPnl)} USDT`}
              sub={todayPctText}
              tone={toneClass(balance.todayPnl)}
            />
            <Kpi
              label="持仓浮盈"
              value={`${balance.unrealized >= 0 ? "+" : ""}${formatAmount(balance.unrealized)} USDT`}
              sub={`今日已实现 ${balance.todayRealized >= 0 ? "+" : ""}${formatAmount(balance.todayRealized)}`}
              tone={toneClass(balance.unrealized)}
            />
            <Kpi
              label="保证金占用"
              value={`${formatAmount(balance.marginUsed)} USDT`}
              sub={`保证金率 ${marginRatio.toFixed(2)}%`}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------- 持仓卡片 (Position Fusion Control Bar) ---------------------------------- */

interface PositionCardProps {
  position: EnginePosition | EnrichedPosition | null;
  coin: CoinInfo;
  previewEnabled?: boolean;
  onTogglePreview?: () => void;
  onClearCustomOrder?: () => void;
  hasCustomOrder?: boolean;
}

export function PositionCard({
  position,
  coin,
  previewEnabled,
  onTogglePreview,
  onClearCustomOrder,
  hasCustomOrder,
}: PositionCardProps) {
  if (position == null || !position.open) {
    return (
      <div className={styles.positionCard} data-open="false">
        <span className={styles.positionEmpty}>当前空仓，无持仓标记</span>
        {onTogglePreview ? (
          <button type="button" className={styles.positionActionBtn} onClick={onTogglePreview}>
            {previewEnabled ? "隐藏图表持仓预览" : "开启图表持仓融合预览"}
          </button>
        ) : null}
      </div>
    );
  }
  const info = coinInfoOf(position.symbol);
  const enriched = position as EnrichedPosition;
  return (
    <div className={styles.positionCard} data-open="true">
      <CoinIcon icon={info.icon} color={info.color} label={info.name} size={24} />
      <span className={styles.positionSide} data-side={position.side}>
        {sideText(position.side)} {Math.abs(position.qty ?? 0)} {info.base}
      </span>
      <span className={styles.positionMeta}>
        入场 <strong>{position.entryPrice?.toFixed(coin.precision)}</strong>
      </span>
      <span className={styles.positionMeta}>
        标记 <strong>{position.markPrice?.toFixed(coin.precision)}</strong>
      </span>
      {enriched.takeProfitPrice ? (
        <span className={`${styles.positionMeta} ${styles.toneUp}`}>
          止盈 {enriched.takeProfitPrice.toFixed(coin.precision)}
        </span>
      ) : null}
      {enriched.stopPrice ? (
        <span className={`${styles.positionMeta} ${styles.toneDown}`}>
          止损 {enriched.stopPrice.toFixed(coin.precision)}
        </span>
      ) : null}
      <strong className={`${styles.positionPnl} ${toneClass(position.unrealizedPnl)}`}>
        {position.unrealizedPnl != null
          ? `${position.unrealizedPnl >= 0 ? "+" : ""}${formatAmount(position.unrealizedPnl)} USDT`
          : "--"}
        {enriched.roePct != null
          ? ` (${enriched.roePct >= 0 ? "+" : ""}${enriched.roePct.toFixed(2)}% / ${enriched.rMultiple >= 0 ? "+" : ""}${enriched.rMultiple.toFixed(2)}R)`
          : ""}
      </strong>
      <span className={styles.positionMeta}>
        {position.leverage}x {position.marginMode === "isolated" ? "逐仓" : position.marginMode}
      </span>
      {enriched.isSimulated ? (
        <span className={styles.simPositionTag}>图上演练融合中</span>
      ) : (
        <span className={styles.realPositionTag}>实盘持仓已融合至图表</span>
      )}
      {hasCustomOrder && onClearCustomOrder ? (
        <button type="button" className={styles.positionActionBtn} onClick={onClearCustomOrder}>
          重置模拟单
        </button>
      ) : null}
    </div>
  );
}

/* ---------------------------------- 快速执行与图表仓位融合面板 (QuickTradePanel) ---------------------------------- */

export interface SimulatedOrderDraft {
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  leverage: number;
  stopR: number;
  takeProfitR: number;
}

interface QuickTradePanelProps {
  coin: CoinInfo;
  livePrice: number;
  defaultLeverage: number;
  onApplyPosition: (order: SimulatedOrderDraft) => void;
  onClearPosition: () => void;
  hasCustomOrder: boolean;
}

export function QuickTradePanel({
  coin,
  livePrice,
  defaultLeverage,
  onApplyPosition,
  onClearPosition,
  hasCustomOrder,
}: QuickTradePanelProps) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState<string>(String(coin.defaultQty));
  const [limitPrice, setLimitPrice] = useState<string>("");
  const [leverage, setLeverage] = useState<number>(defaultLeverage || 5);
  const [stopR, setStopR] = useState<number>(1.0);
  const [takeProfitR, setTakeProfitR] = useState<number>(2.5);

  const effectiveEntry =
    orderType === "limit" && Number(limitPrice) > 0
      ? Number(limitPrice)
      : livePrice > 0
        ? livePrice
        : coin.basePrice;
  const numQty = Math.max(coin.minOrder, Number(qty) || coin.defaultQty);
  const notional = effectiveEntry * numQty;
  const estMargin = notional / Math.max(1, leverage);
  const oneR = effectiveEntry * 0.008;
  const estSl = roundToPrecision(
    side === "long" ? effectiveEntry - oneR * stopR : effectiveEntry + oneR * stopR,
    coin.precision,
  );
  const estTp = roundToPrecision(
    side === "long" ? effectiveEntry + oneR * takeProfitR : effectiveEntry - oneR * takeProfitR,
    coin.precision,
  );

  return (
    <div className={styles.quickTradeBox}>
      <div className={styles.quickDirectionRow}>
        <button
          type="button"
          className={`${styles.dirBtn} ${side === "long" ? styles.dirBtnLong : ""}`}
          onClick={() => setSide("long")}
        >
          做多 Buy / Long
        </button>
        <button
          type="button"
          className={`${styles.dirBtn} ${side === "short" ? styles.dirBtnShort : ""}`}
          onClick={() => setSide("short")}
        >
          做空 Sell / Short
        </button>
      </div>

      <div className={styles.quickTypeTabs}>
        <button
          type="button"
          className={`${styles.miniTab} ${orderType === "market" ? styles.miniTabActive : ""}`}
          onClick={() => setOrderType("market")}
        >
          市价演练 (Market)
        </button>
        <button
          type="button"
          className={`${styles.miniTab} ${orderType === "limit" ? styles.miniTabActive : ""}`}
          onClick={() => {
            setOrderType("limit");
            if (!limitPrice) setLimitPrice(effectiveEntry.toFixed(coin.precision));
          }}
        >
          限价挂单 (Limit)
        </button>
      </div>

      <div className={styles.quickFormGrid}>
        <label className={styles.quickField}>
          <span>数量 ({coin.base})</span>
          <input
            type="number"
            step={coin.minOrder}
            min={coin.minOrder}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className={styles.quickInput}
          />
        </label>
        <label className={styles.quickField}>
          <span>逐仓杠杆 ({leverage}x)</span>
          <input
            type="range"
            min={1}
            max={coin.maxLeverage}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className={styles.slider}
          />
        </label>
        {orderType === "limit" ? (
          <label className={styles.quickFieldFull}>
            <span>委托入场价 (USDT)</span>
            <input
              type="number"
              step={coin.tickSize}
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              className={styles.quickInput}
            />
          </label>
        ) : null}
        <label className={styles.quickField}>
          <span>止损倍数 ({stopR}R)</span>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.1}
            value={stopR}
            onChange={(e) => setStopR(Number(e.target.value))}
            className={styles.slider}
          />
        </label>
        <label className={styles.quickField}>
          <span>止盈倍数 ({takeProfitR}R)</span>
          <input
            type="range"
            min={1}
            max={6}
            step={0.1}
            value={takeProfitR}
            onChange={(e) => setTakeProfitR(Number(e.target.value))}
            className={styles.slider}
          />
        </label>
      </div>

      <dl className={styles.quickSummaryList}>
        <div>
          <dt>参考入场价</dt>
          <dd>{effectiveEntry.toFixed(coin.precision)} USDT</dd>
        </div>
        <div>
          <dt>名义价值 / 保证金</dt>
          <dd>
            {notional.toFixed(2)} / {estMargin.toFixed(2)} USDT
          </dd>
        </div>
        <div>
          <dt>预计止盈 (TP)</dt>
          <dd className={styles.toneUp}>{estTp.toFixed(coin.precision)} USDT</dd>
        </div>
        <div>
          <dt>预计止损 (SL)</dt>
          <dd className={styles.toneDown}>{estSl.toFixed(coin.precision)} USDT</dd>
        </div>
      </dl>

      <div className={styles.quickBtnRow}>
        <Button
          variant="primary"
          size="sm"
          onClick={() =>
            onApplyPosition({
              side,
              qty: numQty,
              entryPrice: effectiveEntry,
              leverage,
              stopR,
              takeProfitR,
            })
          }
        >
          {side === "long" ? "融合多单至主图" : "融合空单至主图"}
        </Button>
        {hasCustomOrder ? (
          <Button variant="secondary" size="sm" onClick={onClearPosition}>
            清除演练仓位
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------- 参数面板 ---------------------------------- */

interface ParamPanelProps {
  strategy: Strategy | null;
}

const PARAM_ROWS: Array<{
  key: keyof Strategy;
  label: string;
  format?: (val: unknown) => string;
}> = [
  { key: "leverage", label: "杠杆", format: (v) => `${v}x` },
  { key: "marginMode", label: "保证金模式", format: (v) => (v === "isolated" ? "逐仓 (Isolated)" : String(v)) },
  { key: "timeframe", label: "K 线周期" },
  { key: "emaFast", label: "快 EMA" },
  { key: "emaSlow", label: "慢 EMA" },
  { key: "stopR", label: "止损（R）", format: (v) => `${v}R` },
  { key: "takeProfitR", label: "止盈（R）", format: (v) => `${v}R` },
  { key: "rFraction", label: "1R 基准距离", format: (v) => `${(Number(v) * 100).toFixed(2)}%` },
  { key: "dailyLossPct", label: "日亏熔断 %", format: (v) => `${v}%` },
  { key: "maxMarginUsdt", label: "最大保证金 USDT", format: (v) => `${v} USDT` },
  { key: "minScore", label: "最低评分 (1-4)", format: (v) => `${v} / 4` },
  { key: "minWinRate", label: "最低胜率", format: (v) => `${(Number(v) * 100).toFixed(0)}%` },
  { key: "expectancyGate", label: "期望门" },
];

export function ParamPanel({ strategy }: ParamPanelProps) {
  if (strategy == null) {
    return <p className={styles.emptyText}>暂无策略参数，可在下方「决策模板 / 决策调参」一键保存创建。</p>;
  }
  return (
    <dl className={styles.paramGrid}>
      {PARAM_ROWS.map((row) => {
        const raw = strategy[row.key];
        const text =
          raw == null
            ? "--"
            : typeof raw === "boolean"
              ? raw
                ? "开启"
                : "关闭"
              : row.format
                ? row.format(raw)
                : String(raw);
        return (
          <div key={row.key} className={styles.paramItem}>
            <dt>{row.label}</dt>
            <dd>{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/* ---------------------------------- 历史记录与当前委托 ---------------------------------- */

interface HistoryPanelProps {
  entries: TradeEntry[];
  orders?: EngineOrder[];
  precision?: number;
}

export function HistoryPanel({ entries, orders = [], precision = 4 }: HistoryPanelProps) {
  const [subTab, setSubTab] = useState<"entries" | "orders">("entries");

  return (
    <div>
      {orders.length > 0 ? (
        <div className={styles.subTabHeader}>
          <button
            type="button"
            className={`${styles.miniTab} ${subTab === "entries" ? styles.miniTabActive : ""}`}
            onClick={() => setSubTab("entries")}
          >
            历史开仓 ({entries.length})
          </button>
          <button
            type="button"
            className={`${styles.miniTab} ${subTab === "orders" ? styles.miniTabActive : ""}`}
            onClick={() => setSubTab("orders")}
          >
            保护挂单 ({orders.length})
          </button>
        </div>
      ) : null}

      {subTab === "orders" && orders.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>类型</th>
                <th>方向</th>
                <th>触发价</th>
                <th>数量</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order, idx) => (
                <tr key={`${order.id ?? idx}`}>
                  <td>{order.kind === "takeProfit" ? "止盈保护 (TP)" : order.kind === "stop" ? "止损保护 (SL)" : order.type}</td>
                  <td>
                    <span data-side={order.side}>{sideText(order.side)}</span>
                  </td>
                  <td className={styles.num}>
                    {(order.stopPrice ?? order.price)?.toFixed(precision) ?? "--"}
                  </td>
                  <td className={styles.num}>{order.qty ?? "--"}</td>
                  <td>
                    <span className={styles.orderStatusTag}>{order.status ?? "NEW"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : entries.length === 0 ? (
        <p className={styles.emptyText}>暂无历史开仓记录。</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>时间</th>
                <th>方向</th>
                <th>入场价</th>
                <th>数量</th>
                <th>评分</th>
                <th>期望 R</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, 50).map((entry, index) => (
                <tr key={`${entry.openedAt}-${entry.entryPrice}-${index}`}>
                  <td>{formatTime(entry.openedAt)}</td>
                  <td>
                    <span className={styles.sidePill} data-side={entry.side}>
                      {sideText(entry.side)}
                    </span>
                  </td>
                  <td className={styles.num}>{entry.entryPrice?.toFixed(precision) ?? "--"}</td>
                  <td className={styles.num}>{entry.qty ?? "--"}</td>
                  <td className={styles.num}>
                    {entry.score?.toFixed(1) ?? "--"}
                    {entry.boost ? <span className={styles.boostMiniTag}>Boost</span> : null}
                  </td>
                  <td className={`${styles.num} ${toneClass(entry.expectancyR)}`}>
                    {entry.expectancyR != null
                      ? `${entry.expectancyR >= 0 ? "+" : ""}${entry.expectancyR.toFixed(2)}R`
                      : "--"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- 决策记录 (Decision Log with Chart Replay Link) ---------------------------------- */

interface DecisionLogPanelProps {
  events: Array<DetectionEvent | RichDecisionRecord>;
  enabled: boolean;
  activeDecisionId?: string | null;
  onSelectDecision?: (id: string) => void;
}

export function DecisionLogPanel({
  events,
  enabled,
  activeDecisionId,
  onSelectDecision,
}: DecisionLogPanelProps) {
  if (!enabled) {
    return <p className={styles.emptyText}>检测事件接口无权限或不可用，决策记录暂不展示。</p>;
  }
  if (events.length === 0) {
    return <p className={styles.emptyText}>暂无决策事件。引擎每次扫描的评分与动作会记录在这里。</p>;
  }

  return (
    <ol className={styles.logList}>
      {events.slice(0, 30).map((event, index) => {
        const rich = event as RichDecisionRecord;
        const id = rich.id ?? `${event.ts}-${event.action}-${index}`;
        const isSelected = activeDecisionId === id;
        const winPct =
          event.winrate != null
            ? event.winrate <= 1
              ? event.winrate * 100
              : event.winrate
            : null;

        return (
          <li
            key={id}
            className={`${styles.logItem} ${isSelected ? styles.logItemActive : ""}`}
          >
            <div className={styles.logItemTop}>
              <span className={styles.logTime}>{formatTime(event.ts)}</span>
              <span className={styles.logAction} data-action={event.action}>
                {event.action ?? "扫描"}
              </span>
              {event.side ? (
                <span className={styles.sidePill} data-side={event.side}>
                  {sideText(event.side)}
                </span>
              ) : null}
              {event.score != null ? (
                <span className={styles.logScore}>评分 {event.score.toFixed(1)}/4</span>
              ) : null}
              {winPct != null ? (
                <span className={styles.logWinrate}>胜率 {winPct.toFixed(1)}%</span>
              ) : null}
            </div>

            <p className={styles.logMsg}>{event.msg ?? ""}</p>

            {rich.factors ? (
              <div className={styles.logFactorGrid}>
                <span>{rich.factors.emaTrend}</span>
                <span>{rich.factors.rsiMomentum}</span>
                <span>{rich.factors.volFilter}</span>
                <span>{rich.factors.expectancyGate}</span>
              </div>
            ) : null}

            {onSelectDecision ? (
              <div className={styles.logItemFoot}>
                {rich.regime ? <span className={styles.regimeTag}>{rich.regime}</span> : null}
                <button
                  type="button"
                  className={styles.locateOnChartBtn}
                  onClick={() => onSelectDecision(isSelected ? "" : id)}
                >
                  {isSelected ? "已定位在主图" : "在主图定位信号"}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
