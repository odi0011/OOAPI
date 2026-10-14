import {
  COINS,
  buildActiveOrPreviewPosition,
  buildEffectiveBalance,
  buildRichDecisionRecords,
  buildSyntheticKlines,
  coinInfoOf,
} from "./coins.ts";
import {
  STRATEGY_TEMPLATES,
  normalizeMinScore,
  resolveBotRuntimeStatus,
  templateParamsOf,
} from "./tradingSystemModel.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
  }
}

function assertTrue(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// 1. 校验多币种详细信息对象完整性
assertTrue(COINS.length >= 8, "COINS should contain at least 8 rich coin objects");
for (const coin of COINS) {
  assertTrue(coin.symbol.endsWith("USDT"), `${coin.symbol} is a USDT perpetual`);
  assertTrue(coin.introduction.length > 20, `${coin.symbol} has rich introduction`);
  assertTrue(coin.description.length > 10, `${coin.symbol} has summary description`);
  assertTrue(coin.sparkline.length >= 12, `${coin.symbol} has sparkline array`);
  assertTrue(coin.maxLeverage >= 20, `${coin.symbol} has maxLeverage`);
  assertTrue(coin.tickSize > 0 && coin.minOrder > 0, `${coin.symbol} has contract specs`);
}

const fallback = coinInfoOf("LINKUSDT");
assertEqual(fallback.symbol, "LINKUSDT", "unknown symbol fallback preserves symbol");
assertEqual(fallback.displaySymbol, "LINK/USDT", "unknown symbol displaySymbol");

// 2. 校验审计修复 #1：minScore 严格在 1..4 之间，且快慢均线 emaFast < emaSlow
for (const tpl of STRATEGY_TEMPLATES) {
  assertTrue(
    tpl.params.minScore >= 1 && tpl.params.minScore <= 4 && Number.isInteger(tpl.params.minScore),
    `template ${tpl.id} minScore (${tpl.params.minScore}) must be integer in 1..4`,
  );
  assertTrue(
    tpl.params.emaFast < tpl.params.emaSlow,
    `template ${tpl.id} emaFast (${tpl.params.emaFast}) < emaSlow (${tpl.params.emaSlow})`,
  );
  assertTrue(
    tpl.params.minWinRate >= 0.38 && tpl.params.minWinRate <= 0.85,
    `template ${tpl.id} minWinRate (${tpl.params.minWinRate}) in valid range`,
  );
}

assertEqual(normalizeMinScore(70), 3, "legacy 70 score normalizes to 3");
assertEqual(normalizeMinScore(90), 4, "legacy 90 score normalizes to 4");
assertEqual(normalizeMinScore(4), 4, "valid score 4 stays 4");
assertEqual(normalizeMinScore(1), 1, "valid score 1 stays 1");
assertEqual(normalizeMinScore(0), 1, "0 clamps to 1");

const derivedParams = templateParamsOf({
  id: 1,
  symbol: "BTCUSDT",
  leverage: 5,
  marginMode: "isolated",
  emaFast: 25,
  emaSlow: 20, // 异常反序输入自动修复
  timeframe: "5m",
  stopR: 1,
  takeProfitR: 2,
  rFraction: 0.008,
  expectancyTpCapR: 4,
  takerFeeRate: 0.0005,
  makerFeeRate: 0.0002,
  expectancyGate: true,
  dailyLossPct: 4,
  maxMarginUsdt: 20,
  exchangeKeyId: 1,
  mode: "testnet",
  minScore: 65,
  minWinRate: 0.42,
  minTrades: 12,
  gambleMode: false,
  scalpTpPct: 0.003,
  scalpSlPct: 0.003,
  exchangeKeyActive: true,
  createdAt: "",
  updatedAt: "",
});
assertTrue(derivedParams.minScore >= 1 && derivedParams.minScore <= 4, "derived minScore in 1..4");
assertTrue(derivedParams.emaFast < derivedParams.emaSlow, "derived emaFast < emaSlow");

// 3. 校验审计修复 #2：机器人与引擎真实运行态判定（不把未启动/熔断/报错误判为运行中）
const baseStrategy = {
  id: 2,
  symbol: "ETHUSDT",
  leverage: 5,
  marginMode: "isolated",
  emaFast: 9,
  emaSlow: 21,
  timeframe: "5m",
  stopR: 1,
  takeProfitR: 2,
  rFraction: 0.008,
  expectancyTpCapR: 4,
  takerFeeRate: 0.0005,
  makerFeeRate: 0.0002,
  expectancyGate: true,
  dailyLossPct: 4,
  maxMarginUsdt: 20,
  exchangeKeyId: 1,
  mode: "testnet" as const,
  minScore: 3,
  minWinRate: 0.4,
  minTrades: 12,
  gambleMode: false,
  scalpTpPct: 0.003,
  scalpSlPct: 0.003,
  exchangeKeyActive: true,
  pauseEntries: false,
  running: false,
  createdAt: "",
  updatedAt: "",
};

const idleStatus = resolveBotRuntimeStatus(baseStrategy, { strategyId: 2, state: "Idle" });
assertEqual(idleStatus.stateKey, "idle", "Idle engine with running=false is idle, not running");
assertEqual(idleStatus.isRunning, false, "Idle engine isRunning=false");
assertEqual(idleStatus.canStart, true, "Idle engine canStart=true");

const haltedStatus = resolveBotRuntimeStatus(
  { ...baseStrategy, pauseReason: "daily_loss" },
  { strategyId: 2, state: "DailyHalt" },
);
assertEqual(haltedStatus.stateKey, "halted", "DailyHalt engine is halted");
assertEqual(haltedStatus.canResume, true, "DailyHalt engine canResume=true");

const errorStatus = resolveBotRuntimeStatus(baseStrategy, {
  strategyId: 2,
  state: "Error",
  lastReason: "protection_failed",
});
assertEqual(errorStatus.stateKey, "error", "Error engine is error");
assertEqual(errorStatus.canResume, true, "Error engine canResume=true");

const runningStatus = resolveBotRuntimeStatus(
  { ...baseStrategy, running: true },
  { strategyId: 2, state: "Armed" },
);
assertEqual(runningStatus.stateKey, "running", "Armed engine with running=true is running");
assertEqual(runningStatus.canStop, true, "Running engine canStop=true");

// 4. 校验审计修复 #3：todayPct 百分比单位一致（约 2.58 表示 2.58%，不二次乘 100）
const btc = COINS[0]!;
const simBal = buildEffectiveBalance(btc, null, null);
assertTrue(
  simBal.balance.todayPct > 0.5 && simBal.balance.todayPct < 20,
  `todayPct (${simBal.balance.todayPct}) is already in percentage points (e.g. ~2.58 for 2.58%)`,
);

// 5. 校验 K 线与图表仓位融合计算
const klines = buildSyntheticKlines(btc, "1s", 48, 88420.5);
assertEqual(klines.length, 48, "synthetic klines count");
assertEqual(klines[klines.length - 1]!.close, 88420.5, "last candle close matches anchor price");

const previewPos = buildActiveOrPreviewPosition({
  coin: btc,
  realPosition: null,
  markPrice: 88500,
  leverage: 5,
  previewEnabled: true,
});
assertTrue(previewPos != null && previewPos.open, "preview position is open");
assertTrue((previewPos?.takeProfitPrice ?? 0) > (previewPos?.entryPrice ?? 0), "long TP > entry");
assertTrue((previewPos?.stopPrice ?? 0) < (previewPos?.entryPrice ?? 0), "long SL < entry");

const decisions = buildRichDecisionRecords(btc, [], klines);
assertTrue(decisions.length >= 4, "rich decision records generated");
