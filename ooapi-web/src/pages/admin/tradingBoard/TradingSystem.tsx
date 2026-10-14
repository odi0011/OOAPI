/**
 * 交易系统模块：
 * 1. 决策模板（StrategyTemplates）：修复 minScore 量纲为后端合法的 1..4，支持填充草稿或一键直接保存至当前币种策略
 * 2. 决策调参（ParamTuner）：1..4 评分量纲、快慢均线联动校验、实时期望收益预测曲线（Connected-Scatter / Forecast）及真实后端保存
 * 3. 自动化与引擎控制（AutomationPanel）：完整绑定 startEngine / resumeEngine / stepEngine / stopEngine / setPauseEntries
 * 4. 网格策略工作台（GridConfig）：等差/等比计算、阶梯挂单表、主图网格线叠加与策略保存
 * 5. 多币种交易机器人矩阵（BotList）：真实反映 Idle / Armed / InPosition / DailyHalt / Error 状态与启停控制
 */
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";

import CoinIcon from "./CoinIcon";
import { COINS, coinInfoOf, roundToPrecision, type CoinInfo } from "./coins";
import type { GridOverlaySpec } from "./MillisecondMarketChart";
import {
  STRATEGY_TEMPLATES,
  normalizeMinScore,
  resolveBotRuntimeStatus,
  templateParamsOf,
  type BotRuntimeInfo,
  type StrategyTemplate,
  type TemplateParams,
} from "./tradingSystemModel";
import type { EngineQuote, EngineState, Strategy } from "../tradingApi";
import { networkLabel } from "../tradingApi";

import styles from "../TradingBoard.module.css";

export {
  STRATEGY_TEMPLATES,
  normalizeMinScore,
  resolveBotRuntimeStatus,
  templateParamsOf,
  type BotRuntimeInfo,
  type StrategyTemplate,
  type TemplateParams,
};

interface TemplatesProps {
  onApply: (params: TemplateParams, name: string) => void;
  activeId: string | null;
  onSaveTemplate?: (params: TemplateParams, name: string) => void;
  saving?: boolean;
  coinSymbol?: string;
}

export function StrategyTemplates({
  onApply,
  activeId,
  onSaveTemplate,
  saving = false,
  coinSymbol = "BTCUSDT",
}: TemplatesProps) {
  return (
    <div>
      <p className={styles.mockNote}>
        <span className={styles.mockBadge}>预设模板 · 1-4 评分已对齐后端</span>
        可点击「应用模板」载入调参器预览，或直接点击「应用并保存」持久化到当前币种（{coinSymbol}）策略。
      </p>
      <div className={styles.templateGrid}>
        {STRATEGY_TEMPLATES.map((template) => (
          <div
            key={template.id}
            className={`${styles.templateCard} ${activeId === template.id ? styles.templateActive : ""}`}
          >
            <div className={styles.templateCardHead}>
              <strong className={styles.templateName}>{template.name}</strong>
              <span className={styles.templateTag}>{template.badge}</span>
            </div>
            <p className={styles.templateDesc}>{template.description}</p>
            <dl className={styles.templateParams}>
              <div>
                <dt>杠杆</dt>
                <dd>{template.params.leverage}x</dd>
              </div>
              <div>
                <dt>EMA 快/慢</dt>
                <dd>
                  {template.params.emaFast}/{template.params.emaSlow}
                </dd>
              </div>
              <div>
                <dt>止盈/止损</dt>
                <dd>
                  {template.params.takeProfitR}R / {template.params.stopR}R
                </dd>
              </div>
              <div>
                <dt>最低评分</dt>
                <dd>{template.params.minScore} / 4</dd>
              </div>
              <div>
                <dt>最低胜率</dt>
                <dd>{Math.round(template.params.minWinRate * 100)}%</dd>
              </div>
              <div>
                <dt>参考夏普</dt>
                <dd>{template.expectedSharpe}</dd>
              </div>
            </dl>
            <div className={styles.templateBtnRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onApply(template.params, template.name)}
              >
                应用模板
              </Button>
              {onSaveTemplate ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving}
                  onClick={() => onSaveTemplate(template.params, template.name)}
                >
                  {saving ? "保存中…" : "应用并保存"}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- 决策调参 (ParamTuner + Live Forecast & Save) ---------------------------------- */

interface TunerProps {
  draft: TemplateParams;
  onChange: (next: TemplateParams) => void;
  templateName: string | null;
  onSave?: (draft: TemplateParams) => void;
  onReset?: () => void;
  saving?: boolean;
  hasStrategy?: boolean;
  coinSymbol?: string;
}

function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  displayValue?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.sliderRow}>
      <span className={styles.sliderLabel}>
        {props.label}
        <strong>{props.displayValue ?? `${props.value}${props.unit ?? ""}`}</strong>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className={styles.slider}
      />
    </label>
  );
}

export function ParamTuner({
  draft,
  onChange,
  templateName,
  onSave,
  onReset,
  saving = false,
  hasStrategy = false,
  coinSymbol = "BTCUSDT",
}: TunerProps) {
  const normalizedScore = normalizeMinScore(draft.minScore);

  const set = (patch: Partial<TemplateParams>) => {
    const next = { ...draft, ...patch };
    // 保证后端硬性约束 emaFast < emaSlow
    if (next.emaFast >= next.emaSlow) {
      if (patch.emaFast != null) {
        next.emaSlow = Math.min(200, next.emaFast + 1);
      } else {
        next.emaFast = Math.max(2, next.emaSlow - 1);
      }
    }
    next.minScore = normalizeMinScore(next.minScore);
    onChange(next);
  };

  // 计算实时期望收益 E[R] 与 30 笔交易净值预测扇形（Connected-Scatter / Usage-Forecast 风格）
  const forecast = useMemo(() => {
    const p = Math.min(0.85, Math.max(0.35, draft.minWinRate + (normalizedScore - 2) * 0.045));
    const q = 1 - p;
    const feeR = 0.09; // 手续费折合 R 损耗
    const expectedRPerTrade = p * draft.takeProfitR - q * draft.stopR - feeR;
    const riskPerTradePct = ((draft.oneRPct ?? 0.8) / 100) * draft.leverage * 100;
    const points: Array<{ step: number; mean: number; upper: number; lower: number }> = [];
    for (let i = 0; i <= 20; i++) {
      const meanR = expectedRPerTrade * i;
      const spreadR = Math.sqrt(i) * (draft.stopR * 0.85);
      points.push({
        step: i,
        mean: 100 + meanR * Math.min(2.5, riskPerTradePct * 0.35),
        upper: 100 + (meanR + spreadR) * Math.min(2.5, riskPerTradePct * 0.35),
        lower: Math.max(60, 100 + (meanR - spreadR) * Math.min(2.5, riskPerTradePct * 0.35)),
      });
    }
    return {
      estWinRatePct: p * 100,
      expectedRPerTrade,
      rewardRiskRatio: draft.stopR > 0 ? draft.takeProfitR / draft.stopR : 1,
      points,
    };
  }, [draft.leverage, draft.minWinRate, draft.oneRPct, draft.stopR, draft.takeProfitR, normalizedScore]);

  return (
    <div>
      <div className={styles.tunerHeaderBar}>
        <p className={styles.mockNote}>
          <span className={styles.mockBadge}>实时调参工作台</span>
          {templateName ? `当前参数来自模板「${templateName}」` : "拖动滑杆实时测算期望值 E[R]"}
          ，支持直接保存到当前币种（{coinSymbol}）后端策略。
        </p>
        <div className={styles.tunerActionBtns}>
          {onReset ? (
            <Button variant="secondary" size="sm" onClick={onReset}>
              还原已存参数
            </Button>
          ) : null}
          {onSave ? (
            <Button
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={() => onSave({ ...draft, minScore: normalizedScore })}
            >
              {saving
                ? "正在保存…"
                : hasStrategy
                  ? `保存并更新 ${coinSymbol} 策略`
                  : `创建并保存 ${coinSymbol} 策略`}
            </Button>
          ) : null}
        </div>
      </div>

      <div className={styles.tunerLayout}>
        <div className={styles.tunerGrid}>
          <SliderRow
            label="杠杆"
            value={draft.leverage}
            min={1}
            max={50}
            step={1}
            unit="x"
            onChange={(leverage) => set({ leverage })}
          />
          <SliderRow
            label="快 EMA"
            value={draft.emaFast}
            min={2}
            max={45}
            step={1}
            onChange={(emaFast) => set({ emaFast })}
          />
          <SliderRow
            label="慢 EMA"
            value={draft.emaSlow}
            min={4}
            max={120}
            step={1}
            onChange={(emaSlow) => set({ emaSlow })}
          />
          <SliderRow
            label="止损"
            value={draft.stopR}
            min={0.5}
            max={3}
            step={0.1}
            unit="R"
            onChange={(stopR) => set({ stopR })}
          />
          <SliderRow
            label="止盈"
            value={draft.takeProfitR}
            min={1}
            max={6}
            step={0.1}
            unit="R"
            onChange={(takeProfitR) => set({ takeProfitR })}
          />
          <SliderRow
            label="日亏熔断"
            value={draft.dailyLossPct}
            min={1}
            max={15}
            step={0.5}
            unit="%"
            onChange={(dailyLossPct) => set({ dailyLossPct })}
          />
          <SliderRow
            label="最低评分"
            value={normalizedScore}
            min={1}
            max={4}
            step={1}
            displayValue={`${normalizedScore} / 4 分`}
            onChange={(minScore) => set({ minScore })}
          />
          <SliderRow
            label="最低胜率"
            value={draft.minWinRate}
            min={0.38}
            max={0.75}
            step={0.01}
            displayValue={`${Math.round(draft.minWinRate * 100)}%`}
            onChange={(minWinRate) => set({ minWinRate })}
          />
          <SliderRow
            label="1R 基准距离"
            value={draft.oneRPct ?? 0.8}
            min={0.2}
            max={3.0}
            step={0.1}
            unit="%"
            onChange={(oneRPct) => set({ oneRPct })}
          />
          <SliderRow
            label="单笔最大保证金"
            value={draft.maxMarginUsdt ?? 20}
            min={2}
            max={200}
            step={1}
            unit=" U"
            onChange={(maxMarginUsdt) => set({ maxMarginUsdt })}
          />
        </div>

        {/* UIArc usage-forecast + connected-scatter 期望收益扇形推演卡片 */}
        <div className={styles.tunerForecastCard}>
          <div className={styles.forecastHead}>
            <div>
              <span className={styles.sectionEyebrow}>EXPECTANCY & MONTE CARLO FAN</span>
              <strong>参数期望值推演（未来 20 笔交易净值置信带）</strong>
            </div>
            <span
              className={`${styles.expectancyBadge} ${
                forecast.expectedRPerTrade >= 0 ? styles.toneUp : styles.toneDown
              }`}
            >
              单笔期望 E[R] = {forecast.expectedRPerTrade >= 0 ? "+" : ""}
              {forecast.expectedRPerTrade.toFixed(2)}R
            </span>
          </div>

          <svg viewBox="0 0 360 110" className={styles.forecastSvg} aria-label="期望收益扇形预测图">
            {(() => {
              const allVals = forecast.points.flatMap((pt) => [pt.lower, pt.upper]);
              const minV = Math.min(...allVals, 92);
              const maxV = Math.max(...allVals, 108);
              const span = Math.max(1, maxV - minV);
              const toX = (step: number) => 16 + (step / 20) * 328;
              const toY = (v: number) => 96 - ((v - minV) / span) * 78;

              const upperCoords = forecast.points.map((pt) => `${toX(pt.step).toFixed(1)},${toY(pt.upper).toFixed(1)}`);
              const lowerCoords = [...forecast.points]
                .reverse()
                .map((pt) => `${toX(pt.step).toFixed(1)},${toY(pt.lower).toFixed(1)}`);
              const meanCoords = forecast.points.map((pt) => `${toX(pt.step).toFixed(1)},${toY(pt.mean).toFixed(1)}`);
              const baseLineY = toY(100);

              return (
                <>
                  <line
                    x1={16}
                    x2={344}
                    y1={baseLineY}
                    y2={baseLineY}
                    stroke="rgba(148,163,184,0.28)"
                    strokeDasharray="3 3"
                  />
                  <polygon
                    points={[...upperCoords, ...lowerCoords].join(" ")}
                    fill={
                      forecast.expectedRPerTrade >= 0
                        ? "rgba(16, 185, 129, 0.16)"
                        : "rgba(244, 63, 94, 0.16)"
                    }
                  />
                  <polyline
                    fill="none"
                    stroke={forecast.expectedRPerTrade >= 0 ? "#10b981" : "#f43f5e"}
                    strokeWidth="2.2"
                    points={meanCoords.join(" ")}
                  />
                  {forecast.points
                    .filter((_, idx) => idx % 4 === 0)
                    .map((pt) => (
                      <circle
                        key={pt.step}
                        cx={toX(pt.step)}
                        cy={toY(pt.mean)}
                        r={3}
                        fill={forecast.expectedRPerTrade >= 0 ? "#10b981" : "#f43f5e"}
                      />
                    ))}
                </>
              );
            })()}
          </svg>

          <dl className={styles.forecastMetrics}>
            <div>
              <dt>盈亏比 (R/R)</dt>
              <dd>{forecast.rewardRiskRatio.toFixed(2)} : 1</dd>
            </div>
            <div>
              <dt>推演胜率</dt>
              <dd>{forecast.estWinRatePct.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>快慢均线差</dt>
              <dd>
                EMA{draft.emaFast} &lt; EMA{draft.emaSlow} (合法)
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <label className={styles.switchRow}>
        <button
          type="button"
          role="switch"
          aria-checked={draft.expectancyGate}
          className={styles.switch}
          data-on={draft.expectancyGate}
          onClick={() => set({ expectancyGate: !draft.expectancyGate })}
        >
          <span />
        </button>
        期望门（期望不为正时跳过开仓）
      </label>
    </div>
  );
}

/* ---------------------------------- 自动化开关与引擎生命周期控制 ---------------------------------- */

interface AutomationProps {
  strategy: Strategy | null;
  engine: EngineState | null;
  pauseBusy: boolean;
  onTogglePause: (paused: boolean) => void;
  engineActionBusy?: string | null;
  onStartEngine?: () => void;
  onResumeEngine?: () => void;
  onStopEngine?: () => void;
  onStepEngine?: () => void;
}

export function AutomationPanel({
  strategy,
  engine,
  pauseBusy,
  onTogglePause,
  engineActionBusy = null,
  onStartEngine,
  onResumeEngine,
  onStopEngine,
  onStepEngine,
}: AutomationProps) {
  const runtime = resolveBotRuntimeStatus(strategy, engine);
  const paused = strategy?.pauseEntries === true;

  return (
    <div className={styles.automation}>
      <div className={styles.automationRow}>
        <div>
          <strong>自动开仓门控（Pause Entries）</strong>
          <p>关闭后引擎不再开新仓，已有持仓与止损止盈挂单继续受保护。</p>
        </div>
        <label className={styles.switchRow}>
          <button
            type="button"
            role="switch"
            aria-checked={!paused}
            aria-label="自动开仓开关"
            className={styles.switch}
            data-on={!paused}
            disabled={pauseBusy || strategy == null}
            onClick={() => onTogglePause(!paused)}
          >
            <span />
          </button>
          {pauseBusy ? "更新中…" : runtime.label}
        </label>
      </div>

      {/* 引擎真实生命周期控制按钮组（修复审计报告 D2） */}
      <div className={styles.engineLifecycleRow}>
        <div className={styles.engineLifecycleInfo}>
          <span className={styles.sectionEyebrow}>ENGINE LIFECYCLE CONTROLS</span>
          <strong>
            当前状态：{runtime.label}（{engine?.state ?? (strategy?.running ? "Armed" : "Idle")}）
          </strong>
          <span>{runtime.subLabel}</span>
        </div>
        <div className={styles.engineLifecycleBtns}>
          {onStartEngine ? (
            <Button
              variant="primary"
              size="sm"
              disabled={strategy == null || engineActionBusy != null || runtime.isRunning}
              onClick={onStartEngine}
            >
              {engineActionBusy === "start" ? "启动中…" : "启动引擎"}
            </Button>
          ) : null}
          {onResumeEngine && (runtime.canResume || strategy?.pauseReason) ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={strategy == null || engineActionBusy != null}
              onClick={onResumeEngine}
            >
              {engineActionBusy === "resume" ? "恢复中…" : "解除熔断恢复"}
            </Button>
          ) : null}
          {onStepEngine ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={strategy == null || engineActionBusy != null}
              onClick={onStepEngine}
            >
              {engineActionBusy === "step" ? "推进中…" : "单步扫描推进"}
            </Button>
          ) : null}
          {onStopEngine ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={strategy == null || engineActionBusy != null || (!runtime.canStop && !strategy?.running)}
              onClick={onStopEngine}
            >
              {engineActionBusy === "stop" ? "停止中…" : "停止引擎"}
            </Button>
          ) : null}
        </div>
      </div>

      <dl className={styles.automationMeta}>
        <div>
          <dt>引擎状态</dt>
          <dd>{engine?.state ?? (strategy?.running ? "Armed" : "Idle")}</dd>
        </div>
        <div>
          <dt>交易网络</dt>
          <dd>{networkLabel(strategy?.mode ?? engine?.mode ?? "")}</dd>
        </div>
        <div>
          <dt>上次动作</dt>
          <dd>{engine?.lastAction ?? "--"}</dd>
        </div>
        <div>
          <dt>上次原因</dt>
          <dd>{engine?.lastReason || strategy?.pauseReason || "--"}</dd>
        </div>
        <div>
          <dt>回测胜率 / 样本</dt>
          <dd>
            {engine?.lastBacktest && engine.lastBacktest.winRate != null
              ? `${(engine.lastBacktest.winRate * 100).toFixed(1)}% (${engine.lastBacktest.trades ?? 0} 笔)`
              : "--"}
          </dd>
        </div>
        <div>
          <dt>实盘期望 / 止盈距离</dt>
          <dd>
            {engine?.liveExpectancy != null
              ? `${(engine.liveExpectancy * 100).toFixed(3)}% / ${((engine.takeProfitDist ?? 0) * 100).toFixed(2)}%`
              : "--"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* ---------------------------------- 网格策略配置工作台 (GridConfig) ---------------------------------- */

interface GridForm {
  mode: "arithmetic" | "geometric";
  upper: string;
  lower: string;
  count: string;
  amount: string;
  stopLoss: string;
}

interface GridConfigProps {
  coin?: CoinInfo;
  livePrice?: number;
  /** 交易所 24h 统计（真实高/低点）。缺失时「按 24h 高低点填入」按钮不出现。 */
  quote?: EngineQuote;
  activeGridOverlay?: GridOverlaySpec | null;
  onApplyGridOverlay?: (overlay: GridOverlaySpec | null) => void;
  onSaveGridToStrategy?: (params: { stopR: number; takeProfitR: number; maxMarginUsdt: number }) => void;
  saving?: boolean;
}

export function GridConfig({
  coin = COINS[0]!,
  livePrice,
  quote,
  activeGridOverlay,
  onApplyGridOverlay,
  onSaveGridToStrategy,
  saving = false,
}: GridConfigProps) {
  // 网格上下沿要围绕真实标记价；没有价格就不预填（让用户自己填）
  const refPrice = livePrice && livePrice > 0 ? livePrice : 0;
  const defaultUpper = roundToPrecision(refPrice * 1.045, coin.precision);
  const defaultLower = roundToPrecision(refPrice * 0.955, coin.precision);

  const [form, setForm] = useState<GridForm>({
    mode: "arithmetic",
    upper: String(defaultUpper),
    lower: String(defaultLower),
    count: "10",
    amount: "20",
    stopLoss: String(roundToPrecision(defaultLower * 0.98, coin.precision)),
  });

  /*
    切换币种时按真实标记价预填区间。

    没有真实价时**不动表单** —— 早先会用写死的基准价填一套上下沿，
    用户看到的网格是围绕一个过期价格画的。
  */
  useEffect(() => {
    if (!(livePrice && livePrice > 0)) return;
    const up = roundToPrecision(livePrice * 1.045, coin.precision);
    const low = roundToPrecision(livePrice * 0.955, coin.precision);
    setForm((prev) => ({
      ...prev,
      upper: String(up),
      lower: String(low),
      stopLoss: String(roundToPrecision(low * 0.98, coin.precision)),
    }));
  }, [coin.symbol, coin.precision, livePrice]);

  const set = (patch: Partial<GridForm>) => setForm((prev) => ({ ...prev, ...patch }));

  const upperNum = Number(form.upper);
  const lowerNum = Number(form.lower);
  const countNum = Math.min(24, Math.max(2, Math.round(Number(form.count) || 10)));
  const amountNum = Math.max(1, Number(form.amount) || 20);
  const valid = Number.isFinite(upperNum) && Number.isFinite(lowerNum) && upperNum > lowerNum && countNum >= 2;

  const gridAnalysis = useMemo(() => {
    if (!valid) return null;
    const step = (upperNum - lowerNum) / countNum;
    const ratio = (upperNum / lowerNum) ** (1 / countNum);
    const levels: Array<{ index: number; price: number; side: "buy" | "sell"; spreadPct: number }> = [];
    for (let i = 0; i <= countNum; i++) {
      const price =
        form.mode === "geometric"
          ? roundToPrecision(lowerNum * ratio ** i, coin.precision)
          : roundToPrecision(lowerNum + step * i, coin.precision);
      const side = price <= refPrice ? "buy" : "sell";
      const spreadPct = ((price - refPrice) / refPrice) * 100;
      levels.push({ index: i + 1, price, side, spreadPct });
    }
    const midSpreadPct = (step / ((upperNum + lowerNum) / 2)) * 100;
    const netGridProfitPct = Math.max(0.02, midSpreadPct - 0.04); // 扣除双边 Maker 0.02% 费率
    const totalInvestment = countNum * amountNum;
    const estApr = netGridProfitPct * 14 * 365 * 0.35;
    return {
      step,
      midSpreadPct,
      netGridProfitPct,
      totalInvestment,
      estApr,
      levels,
    };
  }, [amountNum, coin.precision, countNum, form.mode, lowerNum, refPrice, upperNum, valid]);

  return (
    <div>
      <div className={styles.gridHeaderBar}>
        <p className={styles.mockNote}>
          <span className={styles.mockBadge}>网格量化工作台</span>
          支持等差/等比网格挂单测算、主图网格线实时叠加预览，以及将网格风控参数同步至当前币种策略。
        </p>
        <div className={styles.gridModeTabs}>
          <button
            type="button"
            className={`${styles.miniTab} ${form.mode === "arithmetic" ? styles.miniTabActive : ""}`}
            onClick={() => set({ mode: "arithmetic" })}
          >
            等差网格 (Arithmetic)
          </button>
          <button
            type="button"
            className={`${styles.miniTab} ${form.mode === "geometric" ? styles.miniTabActive : ""}`}
            onClick={() => set({ mode: "geometric" })}
          >
            等比网格 (Geometric)
          </button>
          {/* 只有在拿到真实 24h 高低点时才提供这个快捷填入 */}
          {quote ? (
            <button
              type="button"
              className={styles.miniTab}
              onClick={() => {
                set({
                  upper: String(roundToPrecision(quote.highPrice * 1.005, coin.precision)),
                  lower: String(roundToPrecision(quote.lowPrice * 0.995, coin.precision)),
                  stopLoss: String(roundToPrecision(quote.lowPrice * 0.975, coin.precision)),
                });
              }}
            >
              按 24h 高低点填入
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.gridForm}>
        <label>
          价格上限（USDT）
          <Input
            label="价格上限（USDT）"
            hideLabel
            value={form.upper}
            onChange={(e) => set({ upper: e.target.value })}
            placeholder="如 70000"
            inputMode="decimal"
          />
        </label>
        <label>
          价格下限（USDT）
          <Input
            label="价格下限（USDT）"
            hideLabel
            value={form.lower}
            onChange={(e) => set({ lower: e.target.value })}
            placeholder="如 60000"
            inputMode="decimal"
          />
        </label>
        <label>
          网格数量
          <Input
            label="网格数量"
            hideLabel
            value={form.count}
            onChange={(e) => set({ count: e.target.value })}
            inputMode="numeric"
          />
        </label>
        <label>
          每格金额（USDT）
          <Input
            label="每格金额（USDT）"
            hideLabel
            value={form.amount}
            onChange={(e) => set({ amount: e.target.value })}
            inputMode="decimal"
          />
        </label>
        <label>
          网格止损价（USDT，可空）
          <Input
            label="网格止损价（USDT，可空）"
            hideLabel
            value={form.stopLoss}
            onChange={(e) => set({ stopLoss: e.target.value })}
            placeholder="留空表示不设"
            inputMode="decimal"
          />
        </label>
      </div>

      <p className={styles.gridHint}>
        {gridAnalysis
          ? `每格间距约 ${gridAnalysis.step.toFixed(coin.precision)} USDT（单格净利约 ${gridAnalysis.netGridProfitPct.toFixed(2)}%，总投入 ${gridAnalysis.totalInvestment.toFixed(0)} USDT，预估年化 ${gridAnalysis.estApr.toFixed(1)}%）`
          : "填写上下限与网格数后可预览每格间距。"}
      </p>

      {gridAnalysis ? (
        <div className={styles.gridWorkbenchFooter}>
          <div className={styles.gridLadderPreview}>
            <span className={styles.sectionEyebrow}>GRID LADDER PREVIEW · 挂单阶梯预览</span>
            <div className={styles.gridLevelsRow}>
              {gridAnalysis.levels.slice(0, 12).map((lvl) => (
                <span
                  key={lvl.index}
                  className={`${styles.gridLevelChip} ${
                    lvl.side === "buy" ? styles.gridLevelBuy : styles.gridLevelSell
                  }`}
                >
                  #{lvl.index} {lvl.side === "buy" ? "买" : "卖"} {lvl.price.toFixed(coin.precision)}
                </span>
              ))}
            </div>
          </div>

          <div className={styles.gridActionBtns}>
            {onApplyGridOverlay ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  onApplyGridOverlay(
                    activeGridOverlay?.enabled
                      ? null
                      : {
                          upper: upperNum,
                          lower: lowerNum,
                          count: countNum,
                          mode: form.mode,
                          enabled: true,
                        },
                  )
                }
              >
                {activeGridOverlay?.enabled ? "隐藏主图网格线" : "在主图叠加网格线"}
              </Button>
            ) : null}
            {onSaveGridToStrategy ? (
              <Button
                variant="primary"
                size="sm"
                disabled={saving}
                onClick={() =>
                  onSaveGridToStrategy({
                    stopR: 1.0,
                    takeProfitR: Number(Math.max(1, gridAnalysis.midSpreadPct * 1.8).toFixed(2)),
                    maxMarginUsdt: Math.min(200, Math.max(5, gridAnalysis.totalInvestment)),
                  })
                }
              >
                {saving ? "同步中…" : `保存网格参数至 ${coin.base} 策略`}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------- 交易机器人矩阵 (BotList) ---------------------------------- */

interface BotListProps {
  strategies: Strategy[];
  engines: Map<number, EngineState>;
  pauseBusyId: number | null;
  onTogglePause: (strategyId: number, paused: boolean) => void;
  actionBusyId?: number | null;
  onStartBot?: (strategyId: number) => void;
  onResumeBot?: (strategyId: number) => void;
  onStopBot?: (strategyId: number) => void;
  onSelectCoin?: (symbol: string) => void;
  onCreateBotForCoin?: (symbol: string) => void;
  creatingSymbol?: string | null;
}

export function BotList({
  strategies,
  engines,
  pauseBusyId,
  onTogglePause,
  actionBusyId = null,
  onStartBot,
  onResumeBot,
  onStopBot,
  onSelectCoin,
  onCreateBotForCoin,
  creatingSymbol = null,
}: BotListProps) {
  const configuredSymbols = new Set(strategies.map((s) => s.symbol));
  const unconfiguredCoins = COINS.filter((c) => !configuredSymbols.has(c.symbol));

  if (strategies.length === 0) {
    return (
      <div>
        <p className={styles.emptyText}>暂无交易机器人，先在系统设置里创建策略，或点击下方币种一键初始化。</p>
        {onCreateBotForCoin ? (
          <div className={styles.quickBotInitRow}>
            {COINS.slice(0, 6).map((coin) => (
              <Button
                key={coin.symbol}
                variant="secondary"
                size="sm"
                disabled={creatingSymbol === coin.symbol}
                onClick={() => onCreateBotForCoin(coin.symbol)}
              >
                {creatingSymbol === coin.symbol ? "创建中…" : `+ 创建 ${coin.base} 机器人`}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.botMatrixWrap}>
      <ul className={styles.botList}>
        {strategies.map((strategy) => {
          const coin = coinInfoOf(strategy.symbol);
          const engine = engines.get(strategy.id);
          const runtime = resolveBotRuntimeStatus(strategy, engine);
          const paused = strategy.pauseEntries === true;
          const busy = pauseBusyId === strategy.id || actionBusyId === strategy.id;

          const statusClass =
            runtime.stateKey === "running"
              ? styles.botRunning
              : runtime.stateKey === "error" || runtime.stateKey === "halted"
                ? styles.botHalted
                : styles.botPaused;

          return (
            <li key={strategy.id} className={styles.botItem}>
              <CoinIcon icon={coin.icon} color={coin.color} label={coin.name} size={32} />
              <div className={styles.botMeta}>
                <div className={styles.botTitleLine}>
                  <strong>
                    {coin.name} <span className={styles.coinSymbol}>{strategy.symbol}</span>
                  </strong>
                  <span className={styles.botCategoryPill}>{coin.category}</span>
                </div>
                <span className={styles.botSub}>
                  {networkLabel(strategy.mode)} · {strategy.leverage}x · {strategy.timeframe} · EMA(
                  {strategy.emaFast}/{strategy.emaSlow}) · 评分≥{normalizeMinScore(strategy.minScore)}/4
                  {engine?.state ? ` · ${engine.state}` : ""}
                </span>
                {engine?.lastBacktest ? (
                  <span className={styles.botPerfLine}>
                    回测胜率 {((engine.lastBacktest.winRate ?? 0) * 100).toFixed(1)}% · 净收益{" "}
                    {(engine.lastBacktest.netR ?? 0) >= 0 ? "+" : ""}
                    {(engine.lastBacktest.netR ?? 0).toFixed(2)}R · 当日已实现{" "}
                    {(engine.dayRealizedUsdt ?? 0) >= 0 ? "+" : ""}
                    {(engine.dayRealizedUsdt ?? 0).toFixed(2)} USDT
                  </span>
                ) : null}
              </div>

              <span className={`${styles.botStatus} ${statusClass}`}>{runtime.label}</span>

              <div className={styles.botActions}>
                {onSelectCoin ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onSelectCoin(strategy.symbol)}
                  >
                    盯盘
                  </Button>
                ) : null}

                {onStartBot && runtime.canStart ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => onStartBot(strategy.id)}
                  >
                    {busy ? "处理中…" : "启动引擎"}
                  </Button>
                ) : null}

                {onResumeBot && runtime.canResume ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => onResumeBot(strategy.id)}
                  >
                    {busy ? "恢复中…" : "恢复运行"}
                  </Button>
                ) : null}

                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => onTogglePause(strategy.id, !paused)}
                >
                  {pauseBusyId === strategy.id ? "更新中…" : paused ? "开启开仓" : "暂停开仓"}
                </Button>

                {onStopBot && runtime.canStop ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => onStopBot(strategy.id)}
                  >
                    停止
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {onCreateBotForCoin && unconfiguredCoins.length > 0 ? (
        <div className={styles.unconfiguredBotBar}>
          <span>快速扩展其余币种机器人：</span>
          <div className={styles.quickBotInitRow}>
            {unconfiguredCoins.map((coin) => (
              <button
                key={coin.symbol}
                type="button"
                className={styles.quickInitChip}
                disabled={creatingSymbol === coin.symbol}
                onClick={() => onCreateBotForCoin(coin.symbol)}
              >
                {creatingSymbol === coin.symbol ? `正在创建 ${coin.base}…` : `+ 初始化 ${coin.base} (${coin.symbol})`}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
