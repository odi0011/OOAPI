/**
 * 把各品种的 K 线收成同一条时间轴上的涨跌幅，并合并持仓、开仓和决策。
 * 价格量级差很大（比特币和狗狗币不能共用一根价格轴），所以纵轴是
 * 「相对共同窗口第一根收盘」的百分比，价格本身留在图例上。
 */
import type { DetectionEvent, EngineBalance, EngineKline, EngineMarket, TradeEntry } from "../tradingApi";
import { openTimeToUnix } from "../candleSeries.ts";
import { coinInfoOf } from "./coins.ts";

export interface ReturnPoint {
  time: number;
  value: number;
}

export interface FusedSeries {
  symbol: string;
  name: string;
  color: string;
  precision: number;
  strategyId: number;
  timeframe: string;
  lastPrice: number;
  /** 窗口涨跌幅，单位是百分点，例如 1.25 表示 +1.25%。 */
  changePct: number;
  points: ReturnPoint[];
}

interface CloseBar {
  time: number;
  close: number;
}

export function closeBars(klines: readonly EngineKline[]): CloseBar[] {
  const bars: CloseBar[] = [];
  for (const bar of klines) {
    const time = openTimeToUnix(bar.openTime);
    if (time == null || !Number.isFinite(bar.close) || bar.close <= 0) continue;
    bars.push({ time, close: bar.close });
  }
  bars.sort((a, b) => a.time - b.time);
  const ordered: CloseBar[] = [];
  for (const bar of bars) {
    const prev = ordered[ordered.length - 1];
    if (prev && prev.time === bar.time) ordered[ordered.length - 1] = bar;
    else ordered.push(bar);
  }
  return ordered;
}

function indexFrom(bars: readonly CloseBar[], start: number, end: number): { points: ReturnPoint[]; lastPrice: number; changePct: number } {
  const window = bars.filter((bar) => bar.time >= start && bar.time <= end);
  const used = window.length >= 2 ? window : bars;
  if (used.length === 0) return { points: [], lastPrice: 0, changePct: 0 };
  const base = used[0].close;
  const last = used[used.length - 1].close;
  return {
    points: used.map((bar) => ({ time: bar.time, value: (bar.close / base - 1) * 100 })),
    lastPrice: last,
    changePct: (last / base - 1) * 100,
  };
}

/**
 * 多条曲线共用一段重叠时间。各自从这段里的第一根收盘起算 0%，
 * 这样狗狗币的 +2% 和比特币的 +2% 画在同一高度。
 * 重叠不足两根时退回各品种自己的窗口，避免整图空白。
 */
export function fuseMarkets(markets: readonly EngineMarket[]): FusedSeries[] {
  const prepared = markets
    .map((market) => ({ market, bars: closeBars(market.klines ?? []) }))
    .filter((item) => item.bars.length >= 2);
  if (prepared.length === 0) return [];

  const start = Math.max(...prepared.map((item) => item.bars[0].time));
  const end = Math.min(...prepared.map((item) => item.bars[item.bars.length - 1].time));
  const shared = end > start;

  return prepared.map(({ market, bars }) => {
    const coin = coinInfoOf(market.symbol);
    const indexed = indexFrom(bars, shared ? start : bars[0].time, shared ? end : bars[bars.length - 1].time);
    return {
      symbol: coin.symbol,
      name: coin.name,
      color: coin.color,
      precision: coin.precision,
      strategyId: market.strategyId,
      timeframe: market.timeframe,
      lastPrice: indexed.lastPrice,
      changePct: indexed.changePct,
      points: indexed.points,
    };
  }).filter((series) => series.points.length >= 2);
}

export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatPrice(price: number, precision: number): string {
  if (!Number.isFinite(price) || price <= 0) return "--";
  return price.toLocaleString("zh-CN", {
    minimumFractionDigits: Math.min(precision, 2),
    maximumFractionDigits: precision,
  });
}

export interface BookTotals {
  equity: number;
  available: number;
  unrealized: number;
  todayPnl: number;
  marginUsed: number;
  accounts: number;
}

/** 同一交易所密钥只计一次，避免两个策略共用一个账户时把权益加两遍。 */
export function bookTotals(balances: readonly EngineBalance[]): BookTotals {
  const seen = new Set<string>();
  const totals: BookTotals = { equity: 0, available: 0, unrealized: 0, todayPnl: 0, marginUsed: 0, accounts: 0 };
  for (const balance of balances) {
    const key = balance.exchangeKeyId > 0
      ? `key:${balance.exchangeKeyId}:${balance.network}`
      : `strategy:${balance.strategyId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    totals.accounts += 1;
    totals.equity += finite(balance.equity);
    totals.available += finite(balance.available);
    totals.unrealized += finite(balance.unrealized);
    totals.todayPnl += finite(balance.todayPnl);
    totals.marginUsed += finite(balance.marginUsed);
  }
  return totals;
}

function finite(value: number | undefined): number {
  return value != null && Number.isFinite(value) ? value : 0;
}

export interface TimelineItem {
  ms: number;
  time?: string;
  symbol: string;
  kind: "trade" | "decision";
  side?: string;
  price?: number;
  score?: number;
  action?: string;
  message?: string;
  expectancyR?: number;
}

export function fuseTimeline(entries: readonly TradeEntry[], events: readonly DetectionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const seenTrades = new Set<string>();
  for (const entry of entries) {
    const symbol = (entry.symbol ?? "").toUpperCase();
    const key = `${entry.openedAt}-${entry.entryPrice}-${entry.side}-${symbol}`;
    if (seenTrades.has(key)) continue;
    seenTrades.add(key);
    const ms = Date.parse(entry.openedAt ?? "");
    items.push({
      ms: Number.isFinite(ms) ? ms : 0,
      time: entry.openedAt,
      symbol,
      kind: "trade",
      side: entry.side,
      price: entry.entryPrice,
      score: entry.score,
      expectancyR: entry.expectancyR,
    });
  }
  for (const event of events) {
    const ms = Date.parse(event.ts ?? "");
    items.push({
      ms: Number.isFinite(ms) ? ms : 0,
      time: event.ts,
      symbol: (event.symbol ?? "").toUpperCase(),
      kind: "decision",
      side: event.side,
      score: event.score,
      action: event.action,
      message: event.msg,
    });
  }
  items.sort((a, b) => b.ms - a.ms);
  return items.slice(0, 60);
}

export interface ChartMark {
  symbol: string;
  time: number;
  text: string;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle";
}

/** 标记必须落在该曲线已有的时间上，否则 Lightweight Charts 会丢掉它。 */
export function snapTime(points: readonly ReturnPoint[], raw: string | undefined): number | null {
  if (!raw || points.length === 0) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const target = Math.floor(ms / 1000);
  const first = points[0].time;
  const last = points[points.length - 1].time;
  const span = Math.max(last - first, 0);
  const slack = Math.max(span * 0.05, 3600);
  if (target < first - slack || target > last + slack) return null;
  let best = first;
  let bestDist = Math.abs(first - target);
  for (const point of points) {
    const dist = Math.abs(point.time - target);
    if (dist < bestDist) {
      best = point.time;
      bestDist = dist;
    }
  }
  return best;
}

function sideWord(side: string | undefined): string {
  const value = (side ?? "").toLowerCase();
  if (value === "long" || value === "buy") return "多";
  if (value === "short" || value === "sell") return "空";
  return "";
}

export function chartMarks(
  series: readonly FusedSeries[],
  entries: readonly TradeEntry[],
  events: readonly DetectionEvent[],
): ChartMark[] {
  const bySymbol = new Map(series.map((item) => [item.symbol, item]));
  const grouped = new Map<string, ChartMark[]>();

  const push = (symbol: string, mark: ChartMark) => {
    const list = grouped.get(symbol) ?? [];
    if (list.some((item) => item.time === mark.time && item.text === mark.text)) return;
    list.push(mark);
    grouped.set(symbol, list);
  };

  for (const entry of entries) {
    const symbol = (entry.symbol ?? "").toUpperCase();
    const line = bySymbol.get(symbol);
    if (!line) continue;
    const time = snapTime(line.points, entry.openedAt);
    if (time == null) continue;
    const word = sideWord(entry.side);
    const long = word !== "空";
    push(symbol, {
      symbol,
      time,
      text: word || "开",
      position: long ? "belowBar" : "aboveBar",
      color: long ? "#089981" : "#f23645",
      shape: long ? "arrowUp" : "arrowDown",
    });
  }

  for (const event of events) {
    const symbol = (event.symbol ?? "").toUpperCase();
    const line = bySymbol.get(symbol);
    if (!line) continue;
    const time = snapTime(line.points, event.ts);
    if (time == null) continue;
    const action = (event.action ?? "扫描").trim();
    push(symbol, {
      symbol,
      time,
      text: action.length > 8 ? `${action.slice(0, 8)}…` : action,
      position: "aboveBar",
      color: line.color,
      shape: "circle",
    });
  }

  const marks: ChartMark[] = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => a.time - b.time);
    const capped = list.length > 12 ? list.slice(list.length - 12) : list;
    const unique: ChartMark[] = [];
    for (const mark of capped) {
      const prev = unique[unique.length - 1];
      if (prev && prev.time === mark.time) unique[unique.length - 1] = mark;
      else unique.push(mark);
    }
    marks.push(...unique);
  }
  return marks;
}
