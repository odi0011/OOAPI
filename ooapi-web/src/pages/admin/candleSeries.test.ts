import { openTimeToUnix, referenceLineSpecs, toCandlePoints } from "./candleSeries.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${message}: ${left} !== ${right}`);
  }
}

assertEqual(openTimeToUnix("2026-10-12T00:00:00Z"), Date.parse("2026-10-12T00:00:00Z") / 1000, "rfc3339 to unix seconds");
assertEqual(openTimeToUnix("  "), null, "blank open time");
assertEqual(openTimeToUnix("not-a-time"), null, "bad open time");

const candles = toCandlePoints([
  { openTime: "2026-10-12T00:05:00Z", open: 0.52, high: 0.56, low: 0.51, close: 0.54 },
  { openTime: "2026-10-12T00:00:00Z", open: 0.5, high: 0.55, low: 0.48, close: 0.52 },
  { openTime: "2026-10-12T00:05:00Z", open: 0.53, high: 0.57, low: 0.52, close: 0.55 },
  { openTime: "nope", open: 1, high: 1, low: 1, close: 1 },
]);
assertEqual(candles.map((bar) => bar.close), [0.52, 0.55], "sorted and last bar wins");
assertEqual(candles[0]?.time < candles[1]?.time, true, "ascending time");

const levels = { entryPrice: 0.5, stopPrice: 0.45, takeProfitPrice: 0.6 };
assertEqual(
  referenceLineSpecs({ markPrice: 0.52, levels, positionOpen: true }).map((line) => line.key),
  ["mark", "entry", "stop", "takeProfit"],
  "open position draws levels",
);
assertEqual(
  referenceLineSpecs({ markPrice: 0.52, levels, positionOpen: false }).map((line) => line.key),
  ["mark"],
  "flat position keeps mark only",
);
assertEqual(
  referenceLineSpecs({ markPrice: 0.52, levels, positionOpen: null }).map((line) => line.title),
  ["标记", "入场", "止损", "止盈"],
  "levels stand in until position loads",
);
assertEqual(
  referenceLineSpecs({ markPrice: 0.52, positionOpen: true }).map((line) => line.key),
  ["mark"],
  "open without levels has no entry line",
);
assertEqual(
  referenceLineSpecs({ markPrice: 0, levels, positionOpen: true }).map((line) => line.key),
  ["entry", "stop", "takeProfit"],
  "zero mark is not a line",
);
assertEqual(
  referenceLineSpecs({
    markPrice: 0.52,
    levels: { entryPrice: 0, stopPrice: 0.45, takeProfitPrice: 0.6 },
    positionOpen: true,
  }).map((line) => line.key),
  ["mark", "stop", "takeProfit"],
  "zero entry is not a line",
);
