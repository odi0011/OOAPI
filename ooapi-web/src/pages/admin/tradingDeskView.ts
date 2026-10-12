/**
 * 交易台展示模型。
 *
 * 已上线、本页会读的只有 GET /api/trading/engine/state，加上策略和账户列表。
 * state 能填：引擎 state、mode、testnetGreen、lastError、仓位方向/数量/开仓价/止损/止盈、当日已实现。
 * 标记价、未实现盈亏、保证金、委托、K 线、累计已实现不在这份快照里。
 * 那些格子保留字段名，值写「待接口」，不编数字。
 */

export interface EngineSlice {
  state?: string;
  side?: string;
  qty?: number;
  entryPrice?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  dayRealizedUsdt?: number;
  lastError?: string;
  mode?: string;
  testnetGreen?: boolean;
  running?: boolean;
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

/** 价格 0 视为快照没带这个字段（Go 的 omitempty）。 */
export function formatPrice(value: number | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return formatAmount(value);
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
  return "testnet 测网";
}

export function testnetGreenText(open: boolean | undefined): "开" | "关" {
  return open ? "开" : "关";
}

export function marginModeText(mode: string | undefined): string {
  if (mode === "cross") return "全仓";
  return "逐仓";
}

export function sideText(side: string | undefined): string {
  if (side === "long") return "多";
  if (side === "short") return "空";
  if (side && side.trim()) return side;
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
}

export function buildDeskStatus(input: {
  engine: EngineSlice | null;
  symbol?: string;
  leverage?: number;
  marginMode?: string;
  accountLabel?: string;
  mode?: string;
}): DeskStatus {
  const engine = input.engine;
  const mode = engine?.mode || input.mode;
  const leverage = input.leverage;
  return {
    stateText: engineStateText(engine?.state, engine?.running),
    modeText: modeText(mode),
    testnetGreenText: testnetGreenText(engine?.testnetGreen),
    symbol: input.symbol && input.symbol.trim() ? input.symbol : "XRPUSDT",
    leverageText: leverage != null && Number.isFinite(leverage) ? `${leverage} 倍` : "—",
    marginModeText: marginModeText(input.marginMode),
    accountLabel: input.accountLabel && input.accountLabel.trim() ? input.accountLabel : "未绑定",
    lastError: engine?.lastError?.trim() ?? "",
  };
}

export interface PositionView {
  open: boolean;
  side: string;
  qty: string;
  entry: string;
  /** 快照没有标记价。 */
  mark: string;
  /** 快照没有未实现盈亏。 */
  unrealized: string;
  leverage: string;
  /** 快照没有占用保证金。 */
  margin: string;
  entryPrice?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
}

export function positionView(engine: EngineSlice | null, leverage: number | undefined): PositionView {
  const qty = engine?.qty ?? 0;
  const side = engine?.side?.trim() ?? "";
  const open = side.length > 0 || qty > 0;
  if (!open) {
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
    side: sideText(side),
    qty: formatAmount(qty),
    entry: formatPrice(engine?.entryPrice),
    mark: "待接口",
    unrealized: "待接口",
    leverage: leverage != null && Number.isFinite(leverage) ? `${leverage} 倍` : "—",
    margin: "待接口",
    entryPrice: engine?.entryPrice,
    stopPrice: engine?.stopPrice,
    takeProfitPrice: engine?.takeProfitPrice,
  };
}

export interface PnlBoard {
  /** 有引擎快照时，当日已实现只填当前 mode 那一列。另一列保持「—」，不当成 0。 */
  testnetDay: string;
  liveDay: string;
  testnetCumulative: string;
  liveCumulative: string;
}

export function pnlBoard(engine: EngineSlice | null, fallbackMode: string | undefined): PnlBoard {
  const pending = "待接口";
  if (!engine) {
    return {
      testnetDay: "—",
      liveDay: "—",
      testnetCumulative: pending,
      liveCumulative: pending,
    };
  }
  const mode = engine.mode || fallbackMode;
  const day = engine.dayRealizedUsdt == null ? "—" : formatAmount(engine.dayRealizedUsdt);
  const testnet = mode === "testnet";
  const live = mode === "live";
  return {
    testnetDay: testnet ? day : "—",
    liveDay: live ? day : "—",
    testnetCumulative: pending,
    liveCumulative: pending,
  };
}

export function levelText(value: number | undefined, open: boolean): string {
  if (!open) return "无仓";
  return formatPrice(value);
}
