/**
 * 交易看板的数据来源契约。
 *
 * 这组测试**不检查渲染**，只钉死一件事：**页面上每个数字都必须有真实来源**。
 *
 * 背景：这个页面此前有整套编造数据 —— 涨跌幅用「实时价 ÷ 本地写死的旧开盘价」
 * 算（页面显示 -42%，真实是 ±2%）、五因子评分写死、24h 成交量/持仓/资金费率
 * 是字符串常量、余额兜底到 24680、成交记录能凭空造出「净 R 6.8」。
 * 交易页上这些数字会直接影响用户是否下单，所以必须锁死。
 */
import {
  COINS,
  buildActiveOrPreviewPosition,
  buildEffectiveBalance,
  buildRichDecisionRecords,
  buildEffectiveHistoryAndOrders,
  coinInfoOf,
  type CoinInfo,
} from "./coins.ts";
import {
  STRATEGY_TEMPLATES,
  normalizeMinScore,
  resolveBotRuntimeStatus,
  templateParamsOf,
} from "./tradingSystemModel.ts";
import type { EngineBalance, EngineQuote, TradeEntry } from "../tradingApi";
import { describe, expect, it } from "vitest";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  expect(actual, message).toBe(expected);
}

function assertTrue(condition: boolean, message: string) {
  expect(condition, message).toBe(true);
}

describe("交易看板数据来源契约", () => {
  it("币种元数据只含静态信息，不含任何行情字段", () => {

// 1. 币种元数据：只保留「与行情无关」的静态信息
assertTrue(COINS.length >= 8, "COINS should contain at least 8 coin objects");
for (const coin of COINS) {
  assertTrue(coin.symbol.endsWith("USDT"), `${coin.symbol} is a USDT perpetual`);
  assertTrue(coin.maxLeverage >= 20, `${coin.symbol} has maxLeverage`);
  assertTrue(coin.tickSize > 0 && coin.minOrder > 0, `${coin.symbol} has contract specs`);

  /*
    关键断言：任何「会随行情变化的数字」都**不允许**出现在静态元数据里。

    这些字段一旦存在，界面就会拿它们当行情显示（而它们永远不会变）。
    想加回来的人会立刻在这里看到失败 —— 这是有意的。
  */
  const forbidden = [
    "basePrice",
    "open24h",
    "high24h",
    "low24h",
    "change24hPct",
    "sparkline",
    "factors",
    "volume24h",
    "volume24hUsdB",
    "openInterest",
    "fundingRate",
    "volatility24h",
    "marketCap",
  ];
  for (const field of forbidden) {
    assertTrue(
      !(field in coin),
      `${coin.symbol} must not carry hardcoded market field "${field}" — 行情必须来自后端`,
    );
  }
}

const fallback = coinInfoOf("LINKUSDT");
assertEqual(fallback.symbol, "LINKUSDT", "unknown symbol fallback preserves symbol");
assertEqual(fallback.displaySymbol, "LINK/USDT", "unknown symbol displaySymbol");

// 2. minScore 严格在 1..4 之间，且快慢均线 emaFast < emaSlow
for (const tpl of STRATEGY_TEMPLATES) {
  // 模板是「策略参数的预设」，不是 Strategy 记录本身 —— 取其参数再断言。
  const p = templateParamsOf({ ...tpl, id: 0, symbol: "BTCUSDT", timeframe: "5m", mode: "live", running: false, network: "live", exchangeKeyId: 1 } as never);
  assertTrue(p.emaFast < p.emaSlow, `${tpl.name}: emaFast must be < emaSlow`);
  assertTrue(normalizeMinScore(p.minScore) >= 1 && normalizeMinScore(p.minScore) <= 4, `${tpl.name}: minScore in 1..4`);
}

const baseStrategy = {
  id: 1, name: "t", symbol: "BTCUSDT", timeframe: "5m", mode: "live" as const,
  running: false, network: "live" as const,
  emaFast: 9, emaSlow: 21, minScore: 3, leverage: 5, rFraction: 0.008,
  stopR: 1, takeProfitR: 2.5, dailyLossPct: 5, maxMarginUsdt: 100,
  maxMarginPerTradeUsdt: 20, maxConsecutiveLosses: 3, pauseBalanceUsdt: 0,
  exchangeKeyId: 1, entryMode: "cross" as const, minWinRate: 0.5,
  minTrades: 30, createdAt: "", updatedAt: "",
  rsiLongMin: 50, rsiLongMax: 70, rsiShortMin: 30, rsiShortMax: 50,
};

const runningStatus = resolveBotRuntimeStatus(
  { ...baseStrategy, running: true } as never,
  { strategyId: 2, state: "Armed" } as never,
);
assertEqual(runningStatus.stateKey, "running", "Armed engine with running=true is running");
assertEqual(runningStatus.canStop, true, "Running engine canStop=true");

// 3. 余额：没有真实数据时必须返回 null（而不是编一个 24680）
assertEqual(
  buildEffectiveBalance(null),
  null,
  "无真实余额时返回 null —— 不编造演示组合（此前会返回 wallet=24680 的假快照）",
);
const realBalance = { wallet: 100, equity: 105, todayPct: 5 } as unknown as EngineBalance;
assertEqual(buildEffectiveBalance(realBalance), realBalance, "有真实余额时原样透传");

// 4. 决策记录：没有后端事件时为空（不再生成模板记录）
assertEqual(
  buildRichDecisionRecords(COINS[0]!, [], []).length,
  0,
  "无事件时决策记录为空 —— 不编造「评分 3.8 / 胜率 64.2%」的假决策",
);

// 5. 成交与委托：没有真实数据时为空
const history = buildEffectiveHistoryAndOrders([], []);
assertEqual(history.entries.length, 0, "无成交记录时为空 —— 不编造净 R 6.8 的假成交");
assertEqual(history.orders.length, 0, "无委托时为空");

// 6. 预览持仓：仅在用户显式开启且价格有效时生成，且必须标记为模拟
const btc = COINS[0]!;
assertEqual(
  buildActiveOrPreviewPosition({
    coin: btc, realPosition: null, markPrice: 88500, previewEnabled: false,
  }),
  null,
  "预览关闭时不生成任何持仓线",
);
assertEqual(
  buildActiveOrPreviewPosition({
    coin: btc, realPosition: null, markPrice: 0, previewEnabled: true,
  }),
  null,
  "没有真实价格时不生成预览持仓（避免围绕 0 画线）",
);
const previewPos = buildActiveOrPreviewPosition({
  coin: btc, realPosition: null, markPrice: 88500, leverage: 5, previewEnabled: true,
});
assertTrue(previewPos != null && previewPos.open, "预览开启且有价格时生成持仓线");
assertTrue(previewPos?.isSimulated === true, "预览持仓必须标记 isSimulated，界面据此显示「预览」");
assertTrue((previewPos?.takeProfitPrice ?? 0) > (previewPos?.entryPrice ?? 0), "long TP > entry");
assertTrue((previewPos?.stopPrice ?? 0) < (previewPos?.entryPrice ?? 0), "long SL < entry");

// 7. 真实 24h 报价的形状（后端 EngineQuote）—— 涨跌幅直接来自交易所
const quote: EngineQuote = {
  lastPrice: 83430.2, openPrice: 86190.0, highPrice: 89150.0, lowPrice: 85720.0,
  priceChange: -2759.8, changePercent: -3.2, quoteVolume: 38.6e9,
};
assertTrue(
  Math.abs(quote.changePercent - (quote.priceChange / quote.openPrice) * 100) < 0.01,
  "changePercent 与 priceChange/openPrice 自洽（同一份交易所快照）",
);

// 8. 成交统计只汇总真实记录
const entries: TradeEntry[] = [
  { score: 3.5, minScore: 3, boost: true, forced: false, winRate: 0.6, trades: 10, netR: 2.5, expectancyR: 0.5, expectancyUsdt: 5, oneRUsdt: 10 } as TradeEntry,
  { score: 3.0, minScore: 3, boost: false, forced: true, winRate: 0.5, trades: 10, netR: -1, expectancyR: 0.2, expectancyUsdt: 2, oneRUsdt: 10 } as TradeEntry,
];
const merged = buildEffectiveHistoryAndOrders(entries, []);
assertEqual(merged.entries.length, 2, "真实成交如实透传");
const netR = merged.entries.reduce((sum, e) => sum + (e.netR ?? 0), 0);
assertEqual(netR, 1.5, "净 R 由真实记录累加得出");

// 静态类型使用（避免 coin 参数被误删时测试静默通过）
const _typedCoin: CoinInfo = btc;
void _typedCoin;
  });
});
