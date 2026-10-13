/**
 * 策略表单里新增字段的保存前校验。
 * 杠杆上下限仍在 strategyLeverage.ts，这里覆盖 1R、期望门、手续费回退和周期。
 */

export const STRATEGY_TIMEFRAMES = ["1s", "1m", "3m", "5m", "15m"] as const;
export type StrategyTimeframe = (typeof STRATEGY_TIMEFRAMES)[number];

export const DEFAULT_ONE_R_PCT = 0.8;
export const DEFAULT_EXPECTANCY_TP_CAP_R = 4;
export const DEFAULT_MIN_SCORE = 3;
export const MAX_TREND_SCORE = 4;
export const DEFAULT_MIN_WIN_RATE = 0.38;
export const DEFAULT_MIN_TRADES = 10;
export const DEFAULT_TAKER_FEE_PCT = 0.05;
export const DEFAULT_MAKER_FEE_PCT = 0.02;

export function strategyTimeframeError(value: string): string | null {
  if (!(STRATEGY_TIMEFRAMES as readonly string[]).includes(value)) {
    return "K 线周期只支持 1s、1m、3m、5m、15m";
  }
  return null;
}

/** 表单用百分数。0.8 表示 0.8%，对应接口的 rFraction 0.008。 */
export function strategyOneRPctError(percent: number): string | null {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 20) {
    return "1R 比例要大于 0 且不超过 20%";
  }
  return null;
}

export function strategyExpectancyCapError(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 20) {
    return "期望止盈上限要大于 0 且不超过 20R";
  }
  return null;
}

/** 表单用百分数。0.05 表示 0.05%，对应费率 0.0005。 */
export function strategyFeePctError(percent: number, label: string): string | null {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 1) {
    return `${label}手续费回退要大于 0 且不超过 1%`;
  }
  return null;
}

export function strategyStopDistanceError(stopR: number, takeProfitR: number): string | null {
  if (!Number.isFinite(stopR) || !Number.isFinite(takeProfitR) || stopR <= 0 || takeProfitR <= 0 || stopR > 20 || takeProfitR > 20) {
    return "止损和止盈要大于 0 且不超过 20";
  }
  return null;
}

export function strategyMinScoreError(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TREND_SCORE) {
    return `分数门槛要在 1 到 ${MAX_TREND_SCORE}`;
  }
  return null;
}

/** 实盘未开赌一把时，胜率和样本不能低于默认地板。测网和赌一把不套这道地板。 */
export function strategyLiveSampleError(mode: string, gambleMode: boolean, minWinRate: number, minTrades: number): string | null {
  if (mode !== "live" || gambleMode) return null;
  if (!(minWinRate >= DEFAULT_MIN_WIN_RATE)) {
    return `实盘胜率门槛不能低于 ${DEFAULT_MIN_WIN_RATE}`;
  }
  if (!(minTrades >= DEFAULT_MIN_TRADES)) {
    return `实盘样本笔数不能低于 ${DEFAULT_MIN_TRADES}`;
  }
  return null;
}

export function strategyDailyLossError(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    return "日亏停机阈值要大于 0 且不超过 100";
  }
  return null;
}

export function strategyPauseBalanceError(value: number): string | null {
  if (!Number.isFinite(value) || value < 0.5 || value > 1_000_000) {
    return "暂停余额不能低于 0.5";
  }
  return null;
}

export function strategyMaxMarginError(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    return "单笔保证金上限要大于 0";
  }
  return null;
}

export function strategyToggleError(value: boolean, label: string): string | null {
  if (typeof value !== "boolean") {
    return `${label}只能打开或关闭`;
  }
  return null;
}
