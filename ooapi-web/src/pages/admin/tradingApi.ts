import { ApiRequestError, apiRequest } from "@/lib/api";

/**
 * 自动交易配置接口。
 *
 * 策略与交易所密钥都只走服务端。不要再写 localStorage
 * `ooapi_trading_strategy_v2`，也不要再维护内存里的 Key 列表。
 * 列表接口只回打码值；明文只来自 POST /reveal。
 */

export const LEGACY_STRATEGY_STORAGE_KEY = "ooapi_trading_strategy_v2";

/** 清掉旧前端壳留下的本机草稿。失败时忽略（隐私模式没有 localStorage）。 */
export function discardLegacyStrategyDraft(): void {
  try {
    localStorage.removeItem(LEGACY_STRATEGY_STORAGE_KEY);
  } catch {
    /* 非浏览器或隐私模式 */
  }
}

export type TradingNetwork = "testnet" | "live";
export type Timeframe = "1s" | "1m" | "3m" | "5m" | "15m";

export const TIMEFRAMES: readonly Timeframe[] = ["1s", "1m", "3m", "5m", "15m"];

/** 没有读到策略时的首发默认：测网，交易所密钥 1。 */
export const DEFAULT_STRATEGY_MODE: TradingNetwork = "testnet";
export const DEFAULT_EXCHANGE_KEY_ID = 1;

/** 策略杠杆闭区间。与后端 trading.MaxLeverage 对齐，表单校验和读回都用这一对。 */
export {
  MAX_STRATEGY_LEVERAGE,
  MIN_STRATEGY_LEVERAGE,
  boundStrategyLeverage,
} from "./strategyLeverage";

export interface ExchangeKey {
  id: number;
  label: string;
  exchange: string;
  network: TradingNetwork;
  apiKeyMasked: string;
  apiSecretMasked: string;
  revoked: boolean;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExchangeKeyPlain {
  apiKey: string;
  apiSecret: string;
}

export interface Strategy {
  id: number;
  symbol: string;
  /** 整数，1–MAX_STRATEGY_LEVERAGE（当前 125）。 */
  leverage: number;
  marginMode: string;
  emaFast: number;
  emaSlow: number;
  timeframe: string;
  stopR: number;
  takeProfitR: number;
  /** 1R 占入场价的比例。0.008 表示 0.8%。 */
  rFraction: number;
  /** 期望门允许的止盈上限，单位 R。 */
  expectancyTpCapR: number;
  /** 读不到交易所费率时的 taker / maker 回退。 */
  takerFeeRate: number;
  makerFeeRate: number;
  /** 为假时不再因手续费后期望不为正而跳过开仓。 */
  expectancyGate: boolean;
  dailyLossPct: number;
  /** 钱包余额暂停线，单位 USDT。不能低于 0.5。 */
  pauseBalanceUsdt?: number;
  maxMarginUsdt: number;
  exchangeKeyId: number;
  mode: TradingNetwork;
  minScore: number;
  minWinRate: number;
  minTrades: number;
  gambleMode: boolean;
  /** 相对入场价的比例。0.003 表示 0.3%。 */
  scalpTpPct: number;
  scalpSlPct: number;
  exchangeKeyActive: boolean;
  exchangeKeyNetwork?: string;
  warnings?: string[];
  /** 暂停新开仓。与暂停余额无关。 */
  pauseEntries?: boolean;
  /** 自动暂停原因（如连亏或余额触线）。 */
  pauseReason?: string;
  /** 策略是否处于运行状态（后端持久化标记）。 */
  running?: boolean;
  entryMode?: string;
  createdAt: string;
  updatedAt: string;
}

/** 与后端 strategyWrite 同名。ID 必须是数字，不能是会话里的字符串。 */
export interface StrategyWrite {
  symbol: string;
  /** 整数，1–MAX_STRATEGY_LEVERAGE（当前 125）。 */
  leverage: number;
  marginMode: "isolated";
  emaFast: number;
  emaSlow: number;
  timeframe: Timeframe;
  stopR: number;
  takeProfitR: number;
  rFraction: number;
  expectancyTpCapR: number;
  takerFeeRate: number;
  makerFeeRate: number;
  expectancyGate: boolean;
  dailyLossPct: number;
  /** 钱包余额暂停线，单位 USDT。不能低于 0.5。 */
  pauseBalanceUsdt: number;
  maxMarginUsdt: number;
  exchangeKeyId: number;
  mode: TradingNetwork;
  minScore: number;
  minWinRate: number;
  minTrades: number;
  gambleMode: boolean;
  /** 相对入场价的比例。0.003 表示 0.3%。 */
  scalpTpPct: number;
  scalpSlPct: number;
}

export function networkLabel(network: string): string {
  return network === "live" ? "实盘" : "测网";
}

export function exchangeLabel(exchange: string): string {
  if (exchange === "binance" || exchange === "binance_usdm") return "币安 USDT 合约";
  return exchange || "交易所";
}

/**
 * reveal 回来的才是可复制的明文。
 * 打码串（含 • 或 *）、密文前缀、空白都拒绝，避免写进剪贴板。
 */
export function isPlainExchangeSecret(value: string): boolean {
  const text = value.trim();
  if (text.length < 8 || text.length > 512) return false;
  if (/\s/.test(text)) return false;
  if (text.includes("•") || text.includes("*")) return false;
  if (text.startsWith("enc:")) return false;
  return true;
}

export async function listExchangeKeys(): Promise<ExchangeKey[]> {
  const data = await apiRequest<{ items?: ExchangeKey[] | null }>("/api/trading/exchange-keys");
  return data.items ?? [];
}

export async function createExchangeKey(input: {
  label: string;
  network: TradingNetwork;
  apiKey: string;
  apiSecret: string;
}): Promise<ExchangeKey> {
  return apiRequest<ExchangeKey>("/api/trading/exchange-keys", {
    method: "POST",
    body: {
      label: input.label,
      name: input.label,
      exchange: "binance",
      network: input.network,
      apiKey: input.apiKey,
      apiSecret: input.apiSecret,
    },
  });
}

/** 明文只走这一条。创建和列表都不会带回 apiKey / apiSecret。 */
export async function revealExchangeKey(id: number): Promise<ExchangeKeyPlain> {
  const data = await apiRequest<{ apiKey?: string; apiSecret?: string }>(
    `/api/trading/exchange-keys/${id}/reveal`,
    { method: "POST" },
  );
  const apiKey = (data.apiKey ?? "").trim();
  const apiSecret = (data.apiSecret ?? "").trim();
  if (!isPlainExchangeSecret(apiKey) || !isPlainExchangeSecret(apiSecret)) {
    throw new ApiRequestError("返回的不是完整凭证", "masked_key", 0);
  }
  return { apiKey, apiSecret };
}

/** DELETE 与 POST /revoke 都是作废，密文仍留在库里。 */
export async function revokeExchangeKey(id: number): Promise<ExchangeKey> {
  return apiRequest<ExchangeKey>(`/api/trading/exchange-keys/${id}`, { method: "DELETE" });
}

export async function listStrategies(): Promise<Strategy[]> {
  const data = await apiRequest<{ items?: Strategy[] | null }>("/api/trading/strategies");
  return data.items ?? [];
}

export async function createStrategy(body: StrategyWrite): Promise<Strategy> {
  return apiRequest<Strategy>("/api/trading/strategies", { method: "POST", body });
}

export async function updateStrategy(id: number, body: StrategyWrite): Promise<Strategy> {
  return apiRequest<Strategy>(`/api/trading/strategies/${id}`, { method: "PATCH", body });
}

export async function deleteStrategy(id: number): Promise<void> {
  await apiRequest(`/api/trading/strategies/${id}`, { method: "DELETE" });
}

export interface PauseEntriesState {
  strategyId: number;
  pauseEntries: boolean;
}

/** 立刻暂停或恢复新开仓。已有仓和止损止盈不动，也不改 pauseBalanceUsdt。 */
export async function getPauseEntries(strategyId: number): Promise<PauseEntriesState> {
  return apiRequest<PauseEntriesState>(`/api/trading/strategies/${strategyId}/pause-entries`);
}

export async function setPauseEntries(strategyId: number, pauseEntries: boolean): Promise<PauseEntriesState> {
  return apiRequest<PauseEntriesState>(`/api/trading/strategies/${strategyId}/pause-entries`, {
    method: "POST",
    body: { pauseEntries },
  });
}

/**
 * 引擎状态。testnetGreen 只读展示。
 * 本页不调用 /api/trading/engine/testnet-green，也不打开 TRADING_TESTNET_GREEN。
 * 当日和本会话累计都在这份快照里，用 realizedNetwork 标明当前侧。
 */
export interface EngineState {
  strategyId: number;
  state: string;
  side?: string;
  entryPrice?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  qty?: number;
  dayRealizedUsdt?: number;
  cumulativeRealizedUsdt?: number;
  realizedNetwork?: string;
  halted?: boolean;
  lastError?: string;
  mode?: string;
  testnetGreen?: boolean;
  running?: boolean;
  pauseEntries?: boolean;
  lastAction?: string;
  lastReason?: string;
  symbol?: string;
  leverage?: number;
  marginMode?: string;
  timeframe?: string;
  exchangeKeyId?: number;
  exchangeKeyLabel?: string;
  exchangeKeyNetwork?: string;
  lastBacktest?: {
    winRate?: number;
    trades?: number;
    netR?: number;
    expectancyR?: number;
  } | null;
  liveExpectancy?: number;
  takeProfitDist?: number;
  entry?: TradeEntry | null;
  entries?: TradeEntry[];
}

/** 一笔开仓当时的分数、门槛、是否加速，以及匹配的回测期望。 */
export interface TradeEntry {
  strategyId?: number;
  symbol?: string;
  side?: string;
  entryPrice?: number;
  qty?: number;
  openedAt?: string;
  score: number;
  minScore: number;
  boost: boolean;
  forced: boolean;
  winRate: number;
  trades: number;
  netR: number;
  expectancyR: number;
  expectancyUsdt: number;
  oneRUsdt: number;
  /** 放行后止盈距离上重算胜率得到的实盘期望，价格比例。回测期望仍是 expectancyR。 */
  liveExpectancy?: number;
  /** 期望门放行后的止盈距离，相对入场价。 */
  takeProfitDist?: number;
}

export interface EngineKline {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface EngineLevels {
  entryPrice?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
}

/** GET /api/trading/engine/market?strategyId=&limit= */
export interface EngineMarket {
  strategyId: number;
  symbol: string;
  timeframe: string;
  limit: number;
  markPrice: number;
  klines: EngineKline[];
  levels?: EngineLevels;
}

/** GET /api/trading/engine/position?strategyId= 。open 为 false 时没有数量。 */
export interface EnginePosition {
  strategyId: number;
  symbol: string;
  network: string;
  open: boolean;
  side?: string;
  qty?: number;
  entryPrice?: number;
  markPrice?: number;
  unrealizedPnl?: number;
  leverage?: number;
  margin?: number;
  marginMode?: string;
}

/** kind 用 takeProfit，不用 take_profit。条件单看 source=algo。 */
export interface EngineOrder {
  id?: string;
  source: string;
  kind: string;
  symbol?: string;
  side?: string;
  type?: string;
  status?: string;
  price?: number;
  stopPrice?: number;
  qty?: number;
  reduceOnly?: boolean;
  closePosition?: boolean;
  entry?: TradeEntry | null;
}

/** GET /api/trading/engine/orders?strategyId= 。empty 为 true 即无挂单。 */
export interface EngineOrders {
  strategyId: number;
  symbol: string;
  network: string;
  items: EngineOrder[];
  empty: boolean;
  entries?: TradeEntry[];
}

export type TradingEnginesListEntry =
  | EngineState
  | {
      strategy: Strategy;
      engine: EngineState;
    };

export interface TradingEnginesListResponse {
  engines: TradingEnginesListEntry[];
  totals?: {
    realizedToday: number;
    openPositions: number;
  };
}

/**
 * 多品种引擎一览。后端还没接上时会 404，调用方要回退到单引擎，不能把看板打白。
 * 不改已有的 /api/trading/engine/{state,market,position,orders}。
 */
export async function listTradingEngines(): Promise<TradingEnginesListResponse> {
  return apiRequest<TradingEnginesListResponse>("/api/trading/engines");
}

export async function getEngineState(strategyId: number): Promise<EngineState> {
  return apiRequest<EngineState>(`/api/trading/engine/state?strategyId=${strategyId}`);
}

export async function getEngineMarket(strategyId: number, limit = 100): Promise<EngineMarket> {
  const data = await apiRequest<EngineMarket>(
    `/api/trading/engine/market?strategyId=${strategyId}&limit=${limit}`,
  );
  return { ...data, klines: data.klines ?? [] };
}

export async function getEnginePosition(strategyId: number): Promise<EnginePosition> {
  return apiRequest<EnginePosition>(`/api/trading/engine/position?strategyId=${strategyId}`);
}

export async function getEngineOrders(strategyId: number): Promise<EngineOrders> {
  const data = await apiRequest<EngineOrders>(`/api/trading/engine/orders?strategyId=${strategyId}`);
  const items = data.items ?? [];
  return { ...data, items, entries: data.entries ?? [], empty: data.empty ?? items.length === 0 };
}

/** 权益曲线一点。服务端按约 5 秒采样，默认下发近 2 小时。 */
export interface EquityPoint {
  t: number;
  wallet: number;
  equity: number;
  unrealized: number;
  available: number;
  marginUsed: number;
}

/** 持仓开 / 平 / 调仓标记。 */
export interface EquityMarker {
  t: number;
  kind: string;
  side?: string;
  symbol?: string;
}

/** 账户级持仓一行。 */
export interface PanelPosition {
  symbol: string;
  open: boolean;
  side?: string;
  qty?: number;
  entryPrice?: number;
  markPrice?: number;
  unrealizedPnl?: number;
  leverage?: number;
  margin?: number;
  marginMode?: string;
}

/**
 * GET /api/trading/engine/balance?strategyId=
 * 钱包、可用、浮盈、保证金占用、今日盈亏与权益曲线。密钥只在服务端签名。
 */
export interface EngineBalance {
  strategyId: number;
  exchangeKeyId: number;
  network: string;
  symbol: string;
  wallet: number;
  available: number;
  unrealized: number;
  equity: number;
  marginUsed: number;
  todayPnl: number;
  todayRealized: number;
  todayPct: number;
  todayBase: number;
  todaySrc: string;
  updatedAt: string;
  history: EquityPoint[];
  markers: EquityMarker[];
  positions: PanelPosition[];
  boostUntil?: string;
}

export async function getEngineBalance(strategyId: number): Promise<EngineBalance> {
  const data = await apiRequest<EngineBalance>(`/api/trading/engine/balance?strategyId=${strategyId}`);
  return {
    ...data,
    history: data.history ?? [],
    markers: data.markers ?? [],
    positions: data.positions ?? [],
  };
}

/** 检测事件。鉴权与加速相同：管理员 JWT 或 OOAPI_BOOST_TOKEN。 */
export interface DetectionEvent {
  ts: string;
  symbol?: string;
  side?: string;
  score?: number;
  winrate?: number;
  action?: string;
  msg?: string;
  dayRealizedUsdt?: number;
  cumulativeRealizedUsdt?: number;
}

export async function getEngineEvents(): Promise<DetectionEvent[]> {
  const data = await apiRequest<DetectionEvent[] | { items?: DetectionEvent[] }>("/api/trading/engine/events");
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}

export interface BoostResult {
  ok: boolean;
  until: string;
  status: number;
}

/** POST /api/trading/engine/boost。成功与 429 都直接读 body.until（不走统一 error 包）。 */
export async function postEngineBoost(): Promise<BoostResult> {
  let res: Response;
  try {
    res = await fetch("/api/trading/engine/boost", { method: "POST", credentials: "include" });
  } catch {
    throw new ApiRequestError("网络连接失败，请检查网络后重试", "network_error", 0);
  }
  let payload: { ok?: boolean; until?: string; error?: { message?: string; code?: string } } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new ApiRequestError("响应解析失败", "parse_error", res.status);
  }
  if (res.status === 200 || res.status === 429) {
    return { ok: payload.ok === true && res.status === 200, until: payload.until ?? "", status: res.status };
  }
  throw new ApiRequestError(
    payload.error?.message ?? `请求失败（${res.status}）`,
    payload.error?.code ?? "unknown",
    res.status,
  );
}

/** 启动检查。需要账户权益。不下单，也不打开测网全绿门闩。 */
export async function startEngine(input: { strategyId: number; equityUsdt: number }): Promise<EngineState> {
  return apiRequest<EngineState>("/api/trading/engine/start", {
    method: "POST",
    body: {
      strategyId: input.strategyId,
      equityUsdt: input.equityUsdt,
    },
  });
}

/**
 * 推进一次。不附带 K 线和标记价时，引擎只空转，不会因为这一下单。
 * 不调用 /api/trading/engine/testnet-green。
 */
export async function stepEngine(strategyId: number): Promise<EngineState> {
  return apiRequest<EngineState>("/api/trading/engine/step", {
    method: "POST",
    body: { strategyId },
  });
}

/** 清除自动暂停原因并重新武装启动引擎。 */
export async function resumeEngine(input: { strategyId: number; equityUsdt?: number }): Promise<EngineState> {
  return apiRequest<EngineState>("/api/trading/engine/resume", {
    method: "POST",
    body: {
      strategyId: input.strategyId,
      equityUsdt: input.equityUsdt ?? 100,
    },
  });
}

/** 停止策略引擎会话并撤销保护挂单。 */
export async function stopEngine(strategyId: number): Promise<EngineState> {
  return apiRequest<EngineState>("/api/trading/engine/stop", {
    method: "POST",
    body: { strategyId },
  });
}

