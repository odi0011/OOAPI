import { describe, expect, it } from "vitest";
import type { EngineBalance, EngineMarket } from "../tradingApi.ts";
import { bookTotals, chartMarks, closeBars, formatPct, fuseMarkets, fuseTimeline, snapTime } from "./fusedSeries.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  expect(actual, message).toEqual(expected);
}

describe("全品种融合曲线", () => {
  it("归一化、时间对齐与账户合计都按真实数据计算", () => {

const btc: EngineMarket = {
  strategyId: 1,
  symbol: "BTCUSDT",
  timeframe: "15m",
  limit: 3,
  markPrice: 102,
  klines: [
    { openTime: "2026-10-12T00:00:00Z", open: 100, high: 101, low: 99, close: 100 },
    { openTime: "2026-10-12T00:15:00Z", open: 100, high: 110, low: 100, close: 110 },
    { openTime: "2026-10-12T00:30:00Z", open: 110, high: 112, low: 108, close: 102 },
  ],
};

const doge: EngineMarket = {
  strategyId: 2,
  symbol: "DOGEUSDT",
  timeframe: "15m",
  limit: 4,
  markPrice: 0.2,
  klines: [
    { openTime: "2026-10-11T23:00:00Z", open: 1, high: 1, low: 1, close: 1 },
    { openTime: "2026-10-12T00:00:00Z", open: 0.1, high: 0.1, low: 0.1, close: 0.1 },
    { openTime: "2026-10-12T00:15:00Z", open: 0.1, high: 0.12, low: 0.1, close: 0.12 },
    { openTime: "2026-10-12T00:30:00Z", open: 0.12, high: 0.12, low: 0.11, close: 0.11 },
  ],
};

const fused = fuseMarkets([doge, btc]);
assertEqual(fused.map((series) => series.symbol), ["DOGEUSDT", "BTCUSDT"], "keeps both symbols");
assertEqual(fused[0]?.points[0]?.value, 0, "doge baseline is the shared window, not the earlier bar");
assertEqual(Number(fused[0]?.changePct.toFixed(2)), 10, "doge +10% across the shared window");
assertEqual(Number(fused[1]?.changePct.toFixed(2)), 2, "btc +2% on the same window");
assertEqual(fused[0]?.points.length, 3, "drops the bar before the overlap");

assertEqual(closeBars([
  { openTime: "2026-10-12T00:15:00Z", open: 1, high: 1, low: 1, close: 2 },
  { openTime: "2026-10-12T00:00:00Z", open: 1, high: 1, low: 1, close: 1 },
  { openTime: "2026-10-12T00:15:00Z", open: 1, high: 1, low: 1, close: 3 },
  { openTime: "nope", open: 1, high: 1, low: 1, close: 9 },
]).map((bar) => bar.close), [1, 3], "sorts and keeps the last close");

assertEqual(formatPct(1.2), "+1.20%", "positive percent");
assertEqual(formatPct(-0.5), "-0.50%", "negative percent");
assertEqual(formatPct(Number.NaN), "--", "blank percent");

const totals = bookTotals([
  balance(1, 7, 100, 1),
  balance(2, 7, 100, 4),
  balance(3, 8, 40, 2),
]);
assertEqual(totals.accounts, 2, "one key is one account");
assertEqual(totals.equity, 140, "does not double count a shared key");
assertEqual(totals.todayPnl, 3, "today pnl summed once per key");

const timeline = fuseTimeline(
  [
    { symbol: "BTCUSDT", side: "long", entryPrice: 100, openedAt: "2026-10-12T00:15:00Z", score: 70, minScore: 60, boost: false, forced: false, winRate: 0.4, trades: 10, netR: 1, expectancyR: 0.2, expectancyUsdt: 1, oneRUsdt: 5 },
    { symbol: "BTCUSDT", side: "long", entryPrice: 100, openedAt: "2026-10-12T00:15:00Z", score: 70, minScore: 60, boost: false, forced: false, winRate: 0.4, trades: 10, netR: 1, expectancyR: 0.2, expectancyUsdt: 1, oneRUsdt: 5 },
    { symbol: "DOGEUSDT", side: "short", entryPrice: 0.1, openedAt: "2026-10-12T00:30:00Z", score: 61, minScore: 60, boost: false, forced: false, winRate: 0.4, trades: 10, netR: 1, expectancyR: -0.1, expectancyUsdt: 1, oneRUsdt: 5 },
  ],
  [{ ts: "2026-10-12T00:20:00Z", symbol: "ethusdt", action: "跳过", score: 40, msg: "分数不够" }],
);
assertEqual(timeline.map((item) => item.kind), ["trade", "decision", "trade"], "newest first and trades deduped");
assertEqual(timeline[1]?.symbol, "ETHUSDT", "decision symbol normalized");

const series = fuseMarkets([btc]);
const snapped = snapTime(series[0].points, "2026-10-12T00:16:00Z");
assertEqual(snapped, series[0].points[1].time, "snaps an entry onto the nearest bar");
assertEqual(snapTime(series[0].points, "2026-01-01T00:00:00Z"), null, "ignores marks far outside the window");

const marks = chartMarks(series, [
  { symbol: "BTCUSDT", side: "long", entryPrice: 110, openedAt: "2026-10-12T00:15:00Z", score: 70, minScore: 60, boost: false, forced: false, winRate: 0.4, trades: 10, netR: 1, expectancyR: 0.2, expectancyUsdt: 1, oneRUsdt: 5 },
], [
  { ts: "2026-10-12T00:30:00Z", symbol: "BTCUSDT", action: "持有", msg: "趋势未破" },
]);
assertEqual(marks.map((mark) => mark.text), ["多", "持有"], "entry and decision share the candle axis");

function balance(strategyId: number, exchangeKeyId: number, equity: number, todayPnl: number): EngineBalance {
  return {
    strategyId,
    exchangeKeyId,
    network: "testnet",
    symbol: "BTCUSDT",
    wallet: equity,
    available: equity,
    unrealized: 0,
    equity,
    marginUsed: 0,
    todayPnl,
    todayRealized: todayPnl,
    todayPct: 0,
    todayBase: equity,
    todaySrc: "test",
    updatedAt: "2026-10-12T00:00:00Z",
    history: [],
    markers: [],
    positions: [],
  };
}

console.log("fusedSeries.test.ts ok");
  });
});
