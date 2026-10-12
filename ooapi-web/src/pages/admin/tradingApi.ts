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
export type Timeframe = "1m" | "3m" | "5m" | "15m";

export const TIMEFRAMES: readonly Timeframe[] = ["1m", "3m", "5m", "15m"];

/** 没有读到策略时的首发默认：测网，交易所密钥 1。 */
export const DEFAULT_STRATEGY_MODE: TradingNetwork = "testnet";
export const DEFAULT_EXCHANGE_KEY_ID = 1;

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
  leverage: number;
  marginMode: string;
  emaFast: number;
  emaSlow: number;
  timeframe: string;
  stopR: number;
  takeProfitR: number;
  dailyLossPct: number;
  maxMarginUsdt: number;
  exchangeKeyId: number;
  mode: TradingNetwork;
  exchangeKeyActive: boolean;
  exchangeKeyNetwork?: string;
  warnings?: string[];
  createdAt: string;
  updatedAt: string;
}

/** 与后端 strategyWrite 同名。ID 必须是数字，不能是会话里的字符串。 */
export interface StrategyWrite {
  symbol: "XRPUSDT";
  leverage: number;
  marginMode: "isolated";
  emaFast: number;
  emaSlow: number;
  timeframe: Timeframe;
  stopR: number;
  takeProfitR: number;
  dailyLossPct: number;
  maxMarginUsdt: number;
  exchangeKeyId: number;
  mode: TradingNetwork;
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
    throw new ApiRequestError("返回的不是完整密钥", "masked_key", 0);
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

/** 引擎状态。testnetGreen 只读展示，本页不会去打开它。 */
export interface EngineState {
  strategyId: number;
  state: string;
  side?: string;
  dayRealizedUsdt?: number;
  halted?: boolean;
  lastError?: string;
  mode?: string;
  testnetGreen?: boolean;
  running?: boolean;
  lastAction?: string;
  lastReason?: string;
}

export async function getEngineState(strategyId: number): Promise<EngineState> {
  return apiRequest<EngineState>(`/api/trading/engine/state?strategyId=${strategyId}`);
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
