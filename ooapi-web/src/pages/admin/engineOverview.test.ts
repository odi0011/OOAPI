import {
  engineSideText,
  engineStateLabel,
  finiteNumber,
  formatEngineCard,
  formatEngineTotals,
  formatExpectancyR,
  formatNetR,
  formatWinRate,
  isOpenEngine,
  mapEnginesPayload,
  pnlTone,
  resolveSelectedStrategyId,
  sideTone,
} from "./engineOverview.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${message}: ${left} !== ${right}`);
  }
}

assertEqual(finiteNumber("1.5"), 1.5, "numeric string");
assertEqual(finiteNumber("  "), null, "blank string is not zero");
assertEqual(finiteNumber(Number.NaN), null, "nan");
assertEqual(finiteNumber(Number.POSITIVE_INFINITY), null, "infinity");
assertEqual(finiteNumber(true), null, "boolean is not a number");

assertEqual(mapEnginesPayload(null), {
  engines: [],
  totals: { unrealizedPnl: null, realizedToday: null, openPositions: 0 },
}, "null payload");
assertEqual(mapEnginesPayload("nope").engines, [], "string payload");
assertEqual(mapEnginesPayload(3).engines, [], "number payload");

const mixed = mapEnginesPayload({
  engines: [
    null,
    "skip",
    {
      strategyId: "7",
      symbol: " BTCUSDT ",
      state: "InPosition",
      side: " LONG ",
      qty: "2",
      entryPrice: 0.6,
      markPrice: "0.58",
      unrealizedPnl: -0.25,
      dayRealizedUsdt: 1.25,
      lastReason: " 回踩 ",
      lastBacktest: { winRate: 0.625, trades: "12.9", netR: 1.5, expectancyR: "0.5" },
    },
    {
      strategyId: 8,
      symbol: "ETHUSDT",
      state: "Armed",
      side: "short",
      qty: 0,
      unrealizedPnl: 2,
      realizedToday: null,
      dayRealizedUsdt: 9,
      backtest: { win_rate: 62, trade_count: 3, net_r: -0.4 },
    },
  ],
});

assertEqual(mixed.engines.map((engine) => engine.strategyId), [7, 8], "string id and junk rows dropped");
assertEqual(mixed.engines[0]?.symbol, "BTCUSDT", "symbol trimmed");
assertEqual(mixed.engines[0]?.realizedToday, 1.25, "dayRealizedUsdt fills realizedToday");
assertEqual(mixed.engines[1]?.realizedToday, null, "explicit null realizedToday does not use the alias");
assertEqual(mixed.engines[0]?.lastBacktest, { winRate: 0.625, trades: 12, netR: 1.5, expectancyR: 0.5 }, "backtest fields");
assertEqual(mixed.engines[1]?.lastBacktest, { winRate: 62, trades: 3, netR: -0.4, expectancyR: null }, "backtest alias keys");
assertEqual(mixed.engines[0]?.qty, 2, "qty string");
assertEqual(mixed.engines[0]?.lastReason, "回踩", "reason trimmed");
assertEqual(mixed.totals, { unrealizedPnl: 1.75, realizedToday: 1.25, openPositions: 1 }, "computed totals");
assertEqual(isOpenEngine(mixed.engines[0]!), true, "nonzero qty is open");
assertEqual(isOpenEngine(mixed.engines[1]!), false, "zero qty is flat");
assertEqual(isOpenEngine({ side: "short", qty: null }), true, "side without qty still counts as open");

const overridden = mapEnginesPayload({
  items: [{ strategyId: 1, unrealizedPnl: 1, realizedToday: 1, side: "long", qty: 1 }],
  totals: { totalUnrealizedPnl: 9, totalRealizedToday: 8, openCount: "4" },
});
assertEqual(overridden.totals, { unrealizedPnl: 9, realizedToday: 8, openPositions: 4 }, "totals object wins");

const partial = mapEnginesPayload({
  engines: [{ strategyId: 2, unrealizedPnl: 1.25, realizedToday: 0.5, side: "空", qty: 1 }],
  totals: { unrealizedPnl: 9 },
});
assertEqual(partial.totals.unrealizedPnl, 9, "given unrealized is kept");
assertEqual(partial.totals.realizedToday, 0.5, "missing realized is summed");
assertEqual(partial.totals.openPositions, 1, "missing open count is counted");

const flatTotals = mapEnginesPayload({
  engines: [{ strategyId: 6, symbol: "XRPUSDT", qty: 1, side: "long" }],
  totalUnrealized: 4.5,
  openPositions: 2,
});
assertEqual(flatTotals.totals.unrealizedPnl, 4.5, "root totalUnrealized");
assertEqual(flatTotals.totals.openPositions, 2, "root openPositions beats the row count");
assertEqual(flatTotals.totals.realizedToday, null, "missing root realized stays empty");

const bare = mapEnginesPayload([
  { strategyId: 3, symbol: "XRPUSDT", realizedPnlToday: 0.2 },
]);
assertEqual(bare.engines[0]?.realizedToday, 0.2, "bare array and realizedPnlToday");

const single = mapEnginesPayload({ strategyId: 4, symbol: "SOLUSDT", todayRealizedPnl: "3" });
assertEqual(single.engines[0]?.strategyId, 4, "single object becomes one engine");
assertEqual(single.engines[0]?.realizedToday, 3, "todayRealizedPnl alias");

const wrapped = mapEnginesPayload({
  success: true,
  data: { engines: [{ strategyId: 5, symbol: "BNBUSDT", realizedTodayUsdt: 1 }] },
});
assertEqual(wrapped.engines[0]?.realizedToday, 1, "unwrap data and realizedTodayUsdt");

const card = formatEngineCard(mixed.engines[0]!);
assertEqual(card.symbol, "BTCUSDT", "card symbol");
assertEqual(card.state, "持仓中", "state label");
assertEqual(card.side, "多", "long side");
assertEqual(card.sideTone, "long", "long tone");
assertEqual(card.qty, "2.00", "qty format");
assertEqual(card.entry, "0.60", "entry format");
assertEqual(card.mark, "0.58", "mark format");
assertEqual(card.unrealized, "-0.25", "unrealized format");
assertEqual(card.unrealizedTone, "down", "loss tone");
assertEqual(card.realizedToday, "1.25", "realized format");
assertEqual(card.realizedTone, "up", "profit tone");
assertEqual(card.lastReason, "回踩", "reason");
assertEqual(card.winRate, "62.5%", "ratio win rate");
assertEqual(card.trades, "12", "trade count truncates");
assertEqual(card.netR, "1.50 R", "net R");
assertEqual(card.expectancy, "0.50 R", "expectancy");

const shortCard = formatEngineCard(mixed.engines[1]!);
assertEqual(shortCard.side, "空", "short side");
assertEqual(shortCard.sideTone, "short", "short tone");
assertEqual(shortCard.winRate, "62.0%", "percent win rate stays percent");
assertEqual(shortCard.netR, "-0.40 R", "negative net R");
assertEqual(shortCard.expectancy, "—", "missing expectancy");
assertEqual(shortCard.realizedToday, "—", "null realized formats as dash");

const emptyCard = formatEngineCard({
  strategyId: null,
  symbol: " ",
  state: "",
  side: "",
  qty: null,
  entryPrice: null,
  markPrice: null,
  unrealizedPnl: null,
  realizedToday: null,
  lastReason: "",
  lastBacktest: null,
});
assertEqual(emptyCard.symbol, "—", "missing symbol");
assertEqual(emptyCard.state, "—", "missing state");
assertEqual(emptyCard.side, "—", "missing side");
assertEqual(emptyCard.sideTone, "flat", "flat tone");
assertEqual(emptyCard.qty, "—", "missing qty");
assertEqual(emptyCard.lastReason, "—", "missing reason");
assertEqual(emptyCard.winRate, "—", "missing win rate");
assertEqual(emptyCard.trades, "—", "missing trades");
assertEqual(emptyCard.netR, "—", "missing net R");
assertEqual(emptyCard.expectancy, "—", "missing expectancy");
assertEqual(formatExpectancyR(0), "0.00 R", "zero expectancy is shown");
assertEqual(emptyCard.unrealizedTone, "flat", "missing pnl is flat");

assertEqual(formatEngineTotals(mixed.totals).unrealized, "1.75", "totals unrealized text");
assertEqual(formatEngineTotals(mixed.totals).openPositions, "1", "totals open count");
assertEqual(formatEngineTotals({ unrealizedPnl: 0, realizedToday: null, openPositions: null }), {
  unrealized: "0.00",
  unrealizedTone: "flat",
  realizedToday: "—",
  realizedTone: "flat",
  openPositions: "—",
}, "zero is flat and null stays dash");

assertEqual(engineStateLabel("Armed"), "待命", "armed label");
assertEqual(engineStateLabel("Custom"), "Custom", "unknown state passes through");
assertEqual(engineSideText("sell"), "空", "sell is short");
assertEqual(sideTone("多"), "long", "chinese long");
assertEqual(pnlTone(0), "flat", "zero pnl");
assertEqual(formatWinRate(1), "100.0%", "ratio one is 100 percent");
assertEqual(formatWinRate(null), "—", "null win rate");
assertEqual(formatNetR(undefined), "—", "missing net R");

const engines = [
  { strategyId: 1 },
  { strategyId: 5 },
  { strategyId: null },
];
assertEqual(
  resolveSelectedStrategyId({ multi: true, engines, current: 5, fallbackStrategyId: 1 }),
  5,
  "keep the clicked engine",
);
assertEqual(
  resolveSelectedStrategyId({ multi: true, engines, current: 9, fallbackStrategyId: 1 }),
  1,
  "missing selection falls to the first engine",
);
assertEqual(
  resolveSelectedStrategyId({ multi: false, engines, current: 5, fallbackStrategyId: 1 }),
  1,
  "endpoint failure uses the original single strategy",
);
assertEqual(
  resolveSelectedStrategyId({ multi: true, engines: [{ strategyId: null }], current: null, fallbackStrategyId: 1 }),
  1,
  "no selectable engine keeps the original strategy",
);
