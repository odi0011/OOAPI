/**
 * 交易台展示。数字只来自只读接口：
 * state、market.klines、position、orders。
 * 盈亏用 realizedNetwork 标当前侧，另一侧保持「—」，不写成 0。
 */

export interface EngineSlice {
  state?: string;
  mode?: string;
  testnetGreen?: boolean;
  running?: boolean;
  lastError?: string;
  symbol?: string;
  leverage?: number;
  marginMode?: string;
  timeframe?: string;
  exchangeKeyLabel?: string;
  dayRealizedUsdt?: number;
  cumulativeRealizedUsdt?: number;
  realizedNetwork?: string;
}

export interface PositionSlice {
  open?: boolean;
  side?: string;
  qty?: number;
  entryPrice?: number;
  markPrice?: number;
  unrealizedPnl?: number;
  leverage?: number;
  margin?: number;
}

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

export function formatAmount(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function engineStateText(state: string | undefined, running: boolean | undefined): string {
  const name = state && state.trim() ? state.trim() : "Idle";
  const label = STATE_LABEL[name] ?? name;
  const motion = running ? "运行中" : "未运行";
  return `${name} ${label} · ${motion}`;
}

export function modeText(mode: string | undefined): string {
  if (mode === "live") return "live 实盘";
  if (mode === "testnet") return "testnet 测网";
  return mode && mode.trim() ? mode : "—";
}

export function testnetGreenText(open: boolean | undefined): "开" | "关" {
  return open ? "开" : "关";
}

export function marginModeText(mode: string | undefined): string {
  if (mode === "cross") return "全仓";
  if (mode === "isolated") return "逐仓";
  return mode && mode.trim() ? mode : "—";
}

export function sideText(side: string | undefined): string {
  if (side === "long") return "多";
  if (side === "short") return "空";
  if (side && side.trim()) return side;
  return "—";
}

export function orderSideText(side: string | undefined): string {
  const value = side?.trim().toLowerCase() ?? "";
  if (value === "buy") return "买";
  if (value === "sell") return "卖";
  if (value === "long") return "多";
  if (value === "short") return "空";
  return value || "—";
}

export function orderKindText(kind: string | undefined): string {
  if (kind === "entry") return "入场";
  if (kind === "stop") return "止损";
  if (kind === "takeProfit") return "止盈";
  if (kind === "exit") return "出场";
  return kind && kind.trim() ? kind : "—";
}

export function orderSourceText(source: string | undefined): string {
  if (source === "order") return "普通";
  if (source === "algo") return "条件单";
  return source && source.trim() ? source : "—";
}

export function orderPriceText(order: { price?: number; stopPrice?: number }): string {
  if (order.price != null && order.price > 0) return formatAmount(order.price);
  if (order.stopPrice != null && order.stopPrice > 0) return formatAmount(order.stopPrice);
  return "—";
}

export interface DeskStatus {
  stateText: string;
  modeText: string;
  testnetGreenText: "开" | "关";
  symbol: string;
  leverageText: string;
  marginModeText: string;
  accountLabel: string;
  lastError: string;
  timeframe: string;
}

export function buildDeskStatus(input: {
  engine: EngineSlice | null;
  symbol?: string;
  leverage?: number;
  marginMode?: string;
  accountLabel?: string;
  mode?: string;
  timeframe?: string;
}): DeskStatus {
  const engine = input.engine;
  const mode = engine?.mode || input.mode;
  const leverage = engine?.leverage ?? input.leverage;
  const account = engine
    ? (engine.exchangeKeyLabel?.trim() || "未绑定")
    : (input.accountLabel?.trim() || "未绑定");
  return {
    stateText: engineStateText(engine?.state, engine?.running),
    modeText: modeText(mode),
    testnetGreenText: testnetGreenText(engine?.testnetGreen),
    symbol: engine?.symbol?.trim() || input.symbol?.trim() || "XRPUSDT",
    leverageText: leverage != null && Number.isFinite(leverage) ? `${leverage} 倍` : "—",
    marginModeText: marginModeText(engine?.marginMode || input.marginMode),
    accountLabel: account,
    lastError: engine?.lastError?.trim() ?? "",
    timeframe: engine?.timeframe?.trim() || input.timeframe?.trim() || "—",
  };
}

export interface PositionView {
  open: boolean;
  side: string;
  qty: string;
  entry: string;
  mark: string;
  unrealized: string;
  leverage: string;
  margin: string;
}

export function positionView(position: PositionSlice | null): PositionView {
  if (!position || position.open !== true) {
    return {
      open: false,
      side: "—",
      qty: "—",
      entry: "—",
      mark: "—",
      unrealized: "—",
      leverage: "—",
      margin: "—",
    };
  }
  return {
    open: true,
    side: sideText(position.side),
    qty: formatAmount(position.qty),
    entry: formatAmount(position.entryPrice),
    mark: formatAmount(position.markPrice),
    unrealized: formatAmount(position.unrealizedPnl),
    leverage: position.leverage != null && Number.isFinite(position.leverage) ? `${position.leverage} 倍` : "—",
    margin: formatAmount(position.margin),
  };
}

export interface PnlBoard {
  testnetDay: string;
  liveDay: string;
  testnetCumulative: string;
  liveCumulative: string;
}

const BLANK_PNL: PnlBoard = {
  testnetDay: "—",
  liveDay: "—",
  testnetCumulative: "—",
  liveCumulative: "—",
};

/** 只把当日和本会话累计写进 realizedNetwork 那一列。另一列保持「—」。 */
export function pnlBoard(engine: EngineSlice | null): PnlBoard {
  if (!engine) return BLANK_PNL;
  const network = engine.realizedNetwork;
  if (network !== "testnet" && network !== "live") return BLANK_PNL;
  const day = engine.dayRealizedUsdt == null ? "—" : formatAmount(engine.dayRealizedUsdt);
  const cumulative = engine.cumulativeRealizedUsdt == null ? "—" : formatAmount(engine.cumulativeRealizedUsdt);
  if (network === "testnet") {
    return { testnetDay: day, liveDay: "—", testnetCumulative: cumulative, liveCumulative: "—" };
  }
  return { testnetDay: "—", liveDay: day, testnetCumulative: "—", liveCumulative: cumulative };
}

/** 没有 levels 表示无仓。有 levels 时按接口数字显示，0 也显示。 */
export function levelText(value: number | undefined, hasLevels: boolean): string {
  if (!hasLevels) return "无仓";
  return formatAmount(value);
}
