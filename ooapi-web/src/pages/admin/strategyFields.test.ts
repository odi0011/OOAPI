import {
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
} from "./strategyFields.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
  }
}

assertEqual(strategyTimeframeError("1s"), null, "1s is valid");
assertEqual(strategyTimeframeError("1m"), null, "1m is valid");
assertEqual(strategyTimeframeError("3m"), null, "3m is valid");
assertEqual(strategyTimeframeError("5m"), null, "5m is valid");
assertEqual(strategyTimeframeError("2s"), "K 线周期只支持 1s、1m、3m、5m、15m", "2s is rejected");

assertEqual(strategyOneRPctError(0.8), null, "0.8% is the production 1R");
assertEqual(strategyOneRPctError(0), "1R 比例要大于 0 且不超过 20%", "zero 1R is rejected");
assertEqual(strategyOneRPctError(20.1), "1R 比例要大于 0 且不超过 20%", "1R above 20% is rejected");

assertEqual(strategyExpectancyCapError(4), null, "cap 4 is the default");
assertEqual(strategyExpectancyCapError(3), null, "cap 3 is valid");
assertEqual(strategyExpectancyCapError(0), "期望止盈上限要大于 0 且不超过 20R", "cap 0 is rejected");
assertEqual(strategyExpectancyCapError(21), "期望止盈上限要大于 0 且不超过 20R", "cap 21 is rejected");

assertEqual(strategyFeePctError(0.05, "taker "), null, "taker fallback is valid");
assertEqual(strategyFeePctError(0.02, "maker "), null, "maker fallback is valid");
assertEqual(strategyFeePctError(0, "taker "), "taker 手续费回退要大于 0 且不超过 1%", "zero fee is rejected");
assertEqual(strategyFeePctError(1.1, "maker "), "maker 手续费回退要大于 0 且不超过 1%", "fee above 1% is rejected");

assertEqual(strategyStopDistanceError(1, 1.5), null, "default stop and take are valid");
assertEqual(strategyStopDistanceError(0, 1), "止损和止盈要大于 0 且不超过 20", "missing stop is rejected");
assertEqual(strategyMinScoreError(4), null, "score 4 is the max");
assertEqual(strategyMinScoreError(3), null, "score 3 is the default");
assertEqual(strategyMinScoreError(0), "分数门槛要在 1 到 4", "score 0 is rejected");
assertEqual(strategyLiveSampleError("live", false, 0.38, 10), null, "live 0.38/10 is allowed");
assertEqual(strategyLiveSampleError("live", false, 0.37, 10), "实盘胜率门槛不能低于 0.38", "live win rate below 0.38 is rejected");
assertEqual(strategyLiveSampleError("live", false, 0.38, 9), "实盘样本笔数不能低于 10", "live sample below 10 is rejected");
assertEqual(strategyLiveSampleError("live", true, 0, 1), null, "gamble skips the live floor");
assertEqual(strategyLiveSampleError("testnet", false, 0, 1), null, "testnet skips the live floor");
assertEqual(strategyDailyLossError(100), null, "100 turns the daily halt off");
assertEqual(strategyDailyLossError(100.01), "日亏停机阈值要大于 0 且不超过 100", "above 100 is rejected");
assertEqual(strategyPauseBalanceError(0.5), null, "floor is valid");
assertEqual(strategyPauseBalanceError(0.4), "暂停余额不能低于 0.5", "below floor is rejected");
assertEqual(strategyMaxMarginError(1.7), null, "1.7 is valid");
assertEqual(strategyMaxMarginError(0), "单笔保证金上限要大于 0", "zero margin is rejected");
assertEqual(strategyToggleError(true, "期望门"), null, "gate on is valid");
assertEqual(strategyToggleError(false, "赌一把"), null, "gamble off is valid");
