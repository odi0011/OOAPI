/**
 * 策略杠杆闭区间，与后端 trading.MaxLeverage 对齐。
 * 默认仍是 3。读回 20 时保持 20，只有越界才收到端点。
 */

export const MIN_STRATEGY_LEVERAGE = 1;
export const MAX_STRATEGY_LEVERAGE = 125;
export const DEFAULT_STRATEGY_LEVERAGE = 3;

/** 把接口读回的杠杆收进 1–125。非数字回到 fallback。 */
export function boundStrategyLeverage(value: number, fallback = DEFAULT_STRATEGY_LEVERAGE): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < MIN_STRATEGY_LEVERAGE) return MIN_STRATEGY_LEVERAGE;
  if (rounded > MAX_STRATEGY_LEVERAGE) return MAX_STRATEGY_LEVERAGE;
  return rounded;
}

/** 保存前校验。合法时返回 null。 */
export function strategyLeverageError(value: number): string | null {
  if (!Number.isInteger(value) || value < MIN_STRATEGY_LEVERAGE || value > MAX_STRATEGY_LEVERAGE) {
    return `杠杆必须是 ${MIN_STRATEGY_LEVERAGE} 到 ${MAX_STRATEGY_LEVERAGE} 的整数`;
  }
  return null;
}
