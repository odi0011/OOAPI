/**
 * 把只读行情收成 Lightweight Charts 能吃的蜡烛和参考线。
 * 这里不画图，也不改盈亏规则。
 */

import type { EngineKline, EngineLevels } from "./tradingApi";

export interface CandlePoint {
  /** UTC 秒。Lightweight Charts 的时间轴用秒，不用毫秒。 */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function openTimeToUnix(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/** 按时间升序，同一根只留最后一条，避免时间轴报「必须递增」。 */
export function toCandlePoints(klines: readonly EngineKline[]): CandlePoint[] {
  const points: CandlePoint[] = [];
  for (const bar of klines) {
    const time = openTimeToUnix(bar.openTime);
    if (time == null) continue;
    if (![bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price))) continue;
    points.push({
      time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });
  }
  points.sort((a, b) => a.time - b.time);
  const ordered: CandlePoint[] = [];
  for (const point of points) {
    const prev = ordered[ordered.length - 1];
    if (prev && prev.time === point.time) ordered[ordered.length - 1] = point;
    else ordered.push(point);
  }
  return ordered;
}

export type LevelLineKey = "mark" | "entry" | "stop" | "takeProfit";

export interface LevelLineSpec {
  key: LevelLineKey;
  title: string;
  price: number;
}

function positive(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/**
 * 标记价有数字就画。
 * 入场、止损、止盈只在有仓时取 levels。明确空仓不画，哪怕 levels 还留着旧值。
 * 持仓接口还没回来时，levels 在就按有仓画。
 */
export function referenceLineSpecs(input: {
  markPrice?: number;
  levels?: EngineLevels | null;
  positionOpen: boolean | null;
}): LevelLineSpec[] {
  const lines: LevelLineSpec[] = [];
  if (positive(input.markPrice)) {
    lines.push({ key: "mark", title: "标记", price: input.markPrice });
  }
  const drawLevels = input.positionOpen === true || (input.positionOpen == null && input.levels != null);
  if (!drawLevels || input.levels == null) return lines;
  if (positive(input.levels.entryPrice)) {
    lines.push({ key: "entry", title: "入场", price: input.levels.entryPrice });
  }
  if (positive(input.levels.stopPrice)) {
    lines.push({ key: "stop", title: "止损", price: input.levels.stopPrice });
  }
  if (positive(input.levels.takeProfitPrice)) {
    lines.push({ key: "takeProfit", title: "止盈", price: input.levels.takeProfitPrice });
  }
  return lines;
}
