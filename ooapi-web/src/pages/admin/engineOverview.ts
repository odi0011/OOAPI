/**
 * GET /api/trading/engines 的展示层。
 * 字段都可缺。今日已实现在类型里叫 realizedToday，读的时候也接受后端现有的别名。
 * 数字格式和交易台共用 formatAmount，缺数显示「—」。
 */

import { formatAmount } from "./tradingDeskView.ts";

const STATE_LABEL: Record<string, string> = {
  Idle: "空闲",
  Armed: "待命",
  EntrySubmitted: "入场已提交",
  InPosition: "持仓中",
  ExitSubmitted: "出场已提交",
  Settled: "已结算",
  DailyHalt: "日亏停机",
  Blocked: "已拦截",
  Error: "出错",
};

/** 今日已实现。canonical 名在前，缺这个键时才看后面的别名。 */
const REALIZED_KEYS = [
  "realizedToday",
  "dayRealizedUsdt",
  "realizedPnlToday",
  "todayRealizedPnl",
  "todayRealized",
  "totalRealizedToday",
  "dayRealized",
  "realizedTodayUsdt",
] as const;

const UNREALIZED_KEYS = ["unrealizedPnl", "totalUnrealizedPnl", "totalUnrealized", "unrealized"] as const;

const OPEN_KEYS = ["openPositions", "openPositionCount", "openCount", "positionCount"] as const;

export interface EngineBacktestWire {
  winRate?: number | string | null;
  win_rate?: number | string | null;
  trades?: number | string | null;
  tradeCount?: number | string | null;
  trade_count?: number | string | null;
  netR?: number | string | null;
  net_r?: number | string | null;
  expectancyR?: number | string | null;
  expectancy_r?: number | string | null;
  expectancy?: number | string | null;
}

/**
 * 列表里的一台引擎。全部可选：接口还在加，缺字段不能把看板打崩。
 * 今日已实现写成 realizedToday；dayRealizedUsdt 等别名只在映射时认。
 */
export interface TradingEngineWire {
  strategyId?: number | string | null;
  symbol?: string | null;
  state?: string | null;
  side?: string | null;
  qty?: number | string | null;
  entryPrice?: number | string | null;
  markPrice?: number | string | null;
  unrealizedPnl?: number | string | null;
  realizedToday?: number | string | null;
  dayRealizedUsdt?: number | string | null;
  realizedPnlToday?: number | string | null;
  todayRealizedPnl?: number | string | null;
  todayRealized?: number | string | null;
  totalRealizedToday?: number | string | null;
  dayRealized?: number | string | null;
  realizedTodayUsdt?: number | string | null;
  lastReason?: string | null;
  lastBacktest?: EngineBacktestWire | null;
  backtest?: EngineBacktestWire | null;
}

export interface TradingEnginesTotalsWire {
  unrealizedPnl?: number | string | null;
  totalUnrealizedPnl?: number | string | null;
  totalUnrealized?: number | string | null;
  unrealized?: number | string | null;
  realizedToday?: number | string | null;
  dayRealizedUsdt?: number | string | null;
  realizedPnlToday?: number | string | null;
  todayRealizedPnl?: number | string | null;
  todayRealized?: number | string | null;
  totalRealizedToday?: number | string | null;
  dayRealized?: number | string | null;
  realizedTodayUsdt?: number | string | null;
  openPositions?: number | string | null;
  openPositionCount?: number | string | null;
  openCount?: number | string | null;
  positionCount?: number | string | null;
}

/** 列表响应。engines / items 都认；totals 没有时按引擎自己加总。 */
export interface TradingEnginesWire {
  engines?: TradingEngineWire[] | null;
  items?: TradingEngineWire[] | null;
  totals?: TradingEnginesTotalsWire | null;
  data?: TradingEnginesWire | TradingEngineWire[] | null;
}

export interface EngineBacktestSummary {
  winRate: number | null;
  trades: number | null;
  netR: number | null;
  expectancyR: number | null;
}

export interface TradingEngineSummary {
  strategyId: number | null;
  symbol: string;
  state: string;
  side: string;
  qty: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  realizedToday: number | null;
  lastReason: string;
  lastBacktest: EngineBacktestSummary | null;
  pauseEntries: boolean;
}

export interface TradingEnginesTotals {
  unrealizedPnl: number | null;
  realizedToday: number | null;
  openPositions: number | null;
}

export interface TradingEnginesSnapshot {
  engines: TradingEngineSummary[];
  totals: TradingEnginesTotals;
}

export type PnlTone = "up" | "down" | "flat";
export type SideTone = "long" | "short" | "flat";

export interface EngineTotalsView {
  unrealized: string;
  unrealizedTone: PnlTone;
  realizedToday: string;
  realizedTone: PnlTone;
  openPositions: string;
}

export interface EngineCardView {
  strategyId: number | null;
  symbol: string;
  state: string;
  side: string;
  sideTone: SideTone;
  qty: string;
  entry: string;
  mark: string;
  unrealized: string;
  unrealizedTone: PnlTone;
  realizedToday: string;
  realizedTone: PnlTone;
  lastReason: string;
  winRate: string;
  trades: string;
  netR: string;
  expectancy: string;
  pauseEntries: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInt(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed == null) return null;
  return Math.trunc(parsed);
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 键不存在时返回 undefined，键在但不是数时返回 null。 */
function readKeyedNumber(source: Record<string, unknown>, keys: readonly string[]): number | null | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    return finiteNumber(source[key]);
  }
  return undefined;
}

function sumNumbers(values: Array<number | null>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value == null) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

export function isOpenEngine(engine: { side?: string | null; qty?: number | null }): boolean {
  if (engine.qty != null) return engine.qty !== 0;
  const side = engine.side?.trim().toLowerCase() ?? "";
  return side === "long" || side === "short" || side === "buy" || side === "sell" || side === "多" || side === "空";
}

function readStrategyId(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed == null || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function readBacktest(entry: Record<string, unknown>): EngineBacktestSummary | null {
  const raw = isRecord(entry.lastBacktest) ? entry.lastBacktest : isRecord(entry.backtest) ? entry.backtest : null;
  if (!raw) return null;
  return {
    winRate: finiteNumber(raw.winRate ?? raw.win_rate),
    trades: finiteInt(raw.trades ?? raw.tradeCount ?? raw.trade_count),
    netR: finiteNumber(raw.netR ?? raw.net_r),
    expectancyR: finiteNumber(raw.expectancyR ?? raw.expectancy_r ?? raw.expectancy),
  };
}

function mapEngine(entry: Record<string, unknown>): TradingEngineSummary {
  const realized = readKeyedNumber(entry, REALIZED_KEYS);
  return {
    strategyId: readStrategyId(entry.strategyId),
    symbol: readText(entry.symbol),
    state: readText(entry.state),
    side: readText(entry.side),
    qty: finiteNumber(entry.qty),
    entryPrice: finiteNumber(entry.entryPrice),
    markPrice: finiteNumber(entry.markPrice),
    unrealizedPnl: finiteNumber(entry.unrealizedPnl),
    realizedToday: realized === undefined ? null : realized,
    lastReason: readText(entry.lastReason),
    lastBacktest: readBacktest(entry),
    pauseEntries: readPause(entry.pauseEntries ?? entry.pause_entries),
  };
}

function readPause(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes";
}

function readEngineRecords(payload: unknown): Record<string, unknown>[] {
  const body = unwrapPayload(payload);
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  const listed = body.engines ?? body.items;
  if (Array.isArray(listed)) return listed.filter(isRecord);
  if ("strategyId" in body || "symbol" in body) return [body];
  return [];
}

function unwrapPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if ("engines" in payload || "items" in payload || "totals" in payload || "strategyId" in payload || "symbol" in payload) {
    return payload;
  }
  if ("data" in payload) return payload.data;
  return payload;
}

function totalsSource(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.totals)) return body.totals;
  // 合计也可能跟 engines 平铺。单台引擎对象不能当成合计，否则会和下面的加总抢。
  if ("strategyId" in body) return null;
  return body;
}

function readTotals(payload: unknown, engines: TradingEngineSummary[]): TradingEnginesTotals {
  const totals = totalsSource(unwrapPayload(payload));
  const unrealized = totals ? readKeyedNumber(totals, UNREALIZED_KEYS) : undefined;
  const realized = totals ? readKeyedNumber(totals, REALIZED_KEYS) : undefined;
  const open = totals ? readKeyedNumber(totals, OPEN_KEYS) : undefined;
  return {
    unrealizedPnl: unrealized === undefined ? sumNumbers(engines.map((engine) => engine.unrealizedPnl)) : unrealized,
    realizedToday: realized === undefined ? sumNumbers(engines.map((engine) => engine.realizedToday)) : realized,
    openPositions: open === undefined ? engines.filter((engine) => isOpenEngine(engine)).length : finiteInt(open),
  };
}

/** 任何坏掉的响应都变成空快照，不抛。 */
export function mapEnginesPayload(payload: unknown): TradingEnginesSnapshot {
  const engines = readEngineRecords(payload).map(mapEngine);
  return { engines, totals: readTotals(payload, engines) };
}

export function engineStateLabel(state: string | null | undefined): string {
  const name = state?.trim() ?? "";
  if (!name) return "—";
  return STATE_LABEL[name] ?? name;
}

export function engineSideText(side: string | null | undefined): string {
  const value = side?.trim().toLowerCase() ?? "";
  if (value === "long" || value === "buy" || value === "多") return "多";
  if (value === "short" || value === "sell" || value === "空") return "空";
  if (side && side.trim()) return side.trim();
  return "—";
}

export function sideTone(side: string | null | undefined): SideTone {
  const value = side?.trim().toLowerCase() ?? "";
  if (value === "long" || value === "buy" || value === "多") return "long";
  if (value === "short" || value === "sell" || value === "空") return "short";
  return "flat";
}

export function pnlTone(value: number | null | undefined): PnlTone {
  if (value == null || !Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.trunc(value).toLocaleString("zh-CN");
}

/** 0–1 当比率，大于 1 当已经是百分数。1 显示 100%。 */
export function formatWinRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  const text = pct.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${text}%`;
}

export function formatNetR(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatAmount(value)} R`;
}

/** 每笔期望，单位是 R。缺数显示「—」，0 仍显示。 */
export function formatExpectancyR(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatAmount(value)} R`;
}

export function formatTrades(value: number | null | undefined): string {
  return formatCount(value);
}

function textOrDash(value: string): string {
  return value.trim() ? value.trim() : "—";
}

export function formatEngineTotals(totals: TradingEnginesTotals): EngineTotalsView {
  return {
    unrealized: formatAmount(totals.unrealizedPnl ?? undefined),
    unrealizedTone: pnlTone(totals.unrealizedPnl),
    realizedToday: formatAmount(totals.realizedToday ?? undefined),
    realizedTone: pnlTone(totals.realizedToday),
    openPositions: formatCount(totals.openPositions),
  };
}

export function formatEngineCard(engine: TradingEngineSummary): EngineCardView {
  const backtest = engine.lastBacktest;
  return {
    strategyId: engine.strategyId,
    symbol: textOrDash(engine.symbol),
    state: engineStateLabel(engine.state),
    side: engineSideText(engine.side),
    sideTone: sideTone(engine.side),
    qty: formatAmount(engine.qty ?? undefined),
    entry: formatAmount(engine.entryPrice ?? undefined),
    mark: formatAmount(engine.markPrice ?? undefined),
    unrealized: formatAmount(engine.unrealizedPnl ?? undefined),
    unrealizedTone: pnlTone(engine.unrealizedPnl),
    realizedToday: formatAmount(engine.realizedToday ?? undefined),
    realizedTone: pnlTone(engine.realizedToday),
    lastReason: textOrDash(engine.lastReason),
    winRate: formatWinRate(backtest?.winRate),
    trades: formatTrades(backtest?.trades),
    netR: formatNetR(backtest?.netR),
    expectancy: formatExpectancyR(backtest?.expectancyR),
    pauseEntries: engine.pauseEntries,
  };
}

/**
 * 多引擎时保留当前选中；选中不在列表里就用第一台有 strategyId 的。
 * 一台都点不了，或列表接口失败时，回到原来的第一份策略，避免详情被清空。
 */
export function resolveSelectedStrategyId(input: {
  multi: boolean;
  engines: Array<{ strategyId: number | null }>;
  current: number | null;
  fallbackStrategyId: number | null;
}): number | null {
  if (!input.multi) return input.fallbackStrategyId;
  if (input.current != null && input.engines.some((engine) => engine.strategyId === input.current)) {
    return input.current;
  }
  return input.engines.find((engine) => engine.strategyId != null)?.strategyId ?? input.fallbackStrategyId;
}
