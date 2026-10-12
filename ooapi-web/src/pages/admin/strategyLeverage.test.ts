import {
  MAX_STRATEGY_LEVERAGE,
  boundStrategyLeverage,
  strategyLeverageError,
} from "./strategyLeverage.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
  }
}

assertEqual(MAX_STRATEGY_LEVERAGE, 20, "backend max is 20");
assertEqual(boundStrategyLeverage(20), 20, "saved 20 stays 20");
assertEqual(boundStrategyLeverage(20.4), 20, "20.4 rounds inside the range");
assertEqual(boundStrategyLeverage(3), 3, "default 3 is unchanged");
assertEqual(boundStrategyLeverage(1), 1, "minimum stays");
assertEqual(boundStrategyLeverage(21), 20, "above max clamps to 20");
assertEqual(boundStrategyLeverage(0), 1, "below min clamps to 1");
assertEqual(boundStrategyLeverage(Number.NaN), 3, "missing value uses default");
assertEqual(strategyLeverageError(20), null, "20 is valid");
assertEqual(strategyLeverageError(1), null, "1 is valid");
assertEqual(strategyLeverageError(21), "杠杆必须是 1 到 20 的整数", "21 is rejected");
assertEqual(strategyLeverageError(0), "杠杆必须是 1 到 20 的整数", "0 is rejected");
assertEqual(strategyLeverageError(3.5), "杠杆必须是 1 到 20 的整数", "fraction is rejected");
