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

assertEqual(MAX_STRATEGY_LEVERAGE, 125, "backend max is 125");
assertEqual(boundStrategyLeverage(20), 20, "saved 20 stays 20");
assertEqual(boundStrategyLeverage(125), 125, "saved 125 stays 125");
assertEqual(boundStrategyLeverage(20.4), 20, "20.4 rounds inside the range");
assertEqual(boundStrategyLeverage(3), 3, "default 3 is unchanged");
assertEqual(boundStrategyLeverage(1), 1, "minimum stays");
assertEqual(boundStrategyLeverage(126), 125, "above max clamps to 125");
assertEqual(boundStrategyLeverage(0), 1, "below min clamps to 1");
assertEqual(boundStrategyLeverage(Number.NaN), 3, "missing value uses default");
assertEqual(strategyLeverageError(125), null, "125 is valid");
assertEqual(strategyLeverageError(20), null, "20 is valid");
assertEqual(strategyLeverageError(1), null, "1 is valid");
assertEqual(strategyLeverageError(126), "杠杆必须是 1 到 125 的整数", "126 is rejected");
assertEqual(strategyLeverageError(0), "杠杆必须是 1 到 125 的整数", "0 is rejected");
assertEqual(strategyLeverageError(3.5), "杠杆必须是 1 到 125 的整数", "fraction is rejected");
