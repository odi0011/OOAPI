/**
 * 网格的接口封装。
 *
 * 与 tradingApi 分开一个文件，是因为网格的字段和策略**几乎没有交集**：
 * 网格没有 emaFast / stopR，策略没有 lower / upper / levels。
 * 合在一个模块里，一半的类型对另一半永远是空 —— 那正是排查时最容易
 * 出错的地方。
 *
 * 网格有两个方向：long（现货或合约）与 short（必须 USDT-M 合约）。
 * 两个方向是镜像的：多头在低位买、涨一档卖；空头在高位卖、跌一档买回。
 */

import { apiRequest } from "@/lib/api";

import type { GridDirection, GridLineState, GridMarket, GridRunState } from "./gridView";

import type { TradingNetwork } from "./tradingApi";

export type { GridDirection, GridMarket } from "./gridView";

export interface GridPlanLevel {
  index: number;
  buy: number;
  sell: number;
}

/**
 * 一份算好的网格计划。
 *
 * 关键字段是 StepDustPct 和 EffectiveNetPct —— 网格的收益不是
 * "间距减手续费"那么简单：币安现货的数量必须是步长的整数倍，
 * 而买入到账量不是（手续费以基础币扣），于是每完成一次往返就有
 * 不到一个步长的货卖不出去。在低价币上这一项经常比手续费还大。
 */
export interface GridPlan {
  symbol: string;
  direction: GridDirection;
  market: GridMarket;
  leverage: number;
  lower: number;
  upper: number;
  levels: number;
  spacingPct: number;
  qtyPerLevel: number;
  lines: GridPlanLevel[];
  /** 现货是买货的计价币，合约是保证金。 */
  quoteNeeded: number;
  /** 满仓名义。合约 = quoteNeeded × 杠杆。 */
  notionalNeeded: number;
  marginPerLevel: number;
  notionalPerLevel: number;
  netProfitPct: number;
  netProfitPerLevel: number;
  stepDustPct: number;
  effectiveNetPct: number;
  effectiveNetPerLevel: number;
  dustQtyPerLevel: number;
  minNotionalForDust: number;
  worstLossUsdt: number;
  stopPrice: number;
  takeProfitPrice: number;
  lastPrice: number;
  initialBuys: number;
  initialSells: number;
}

/**
 * 资金门槛。**这是这个页面最重要的输出。**
 *
 * MinBudget 是"刚刚能跑"，ComfortableBudget 是"零头不超过收益的一成"。
 * 两者经常差一个数量级，中间那条线是用户自己要做的选择 ——
 * 但两边都得先摆在桌上。
 */
export interface GridRequirement {
  minBudget: number;
  comfortableBudget: number;
  perLevelNotionalMin: number;
  perLevelNotionalOk: number;
  levels: number;
  spacingPct: number;
  netPct: number;
  /** notional = 交易所最小名义顶起来的；dust = 步长零头顶起来的。 */
  limitedBy: "notional" | "dust";
  dustPctAtMin: number;
  effectivePctAtMin: number;
}

export interface GridPreviewResponse {
  ok: boolean;
  message?: string;
  reason?: string;
  requirementError?: string;
  requirement?: GridRequirement;
  plan?: GridPlan;
  symbol: string;
  mode: string;
  lastPrice: number;
  feeRate: number;
  stepSize: number;
  tickSize: number;
  minNotional: number;
  baseAsset: string;
  quoteAsset: string;
  minNotionalKnown: boolean;
  /** 现价是否落在区间内。false 时网格起不来（在下沿之下挂不出买单）。 */
  priceInRange?: boolean;
  priceWarning?: string;
}

export interface GridRestingOrder {
  level: number;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  at: string;
}

export interface GridLineView {
  index: number;
  price: number;
  state: GridLineState;
  qty?: number;
  side?: "BUY" | "SELL";
}

export interface GridSnapshot {
  id?: number;
  symbol: string;
  state: GridRunState;
  running: boolean;
  mode: string;
  direction: GridDirection;
  market: GridMarket;
  leverage: number;
  lower: number;
  upper: number;
  levels: number;
  spacingPct: number;
  stopPrice: number;
  /** 多头走完上沿 / 空头跌破下沿的那个价。 */
  takeProfitPrice: number;
  lastPrice?: number;
  qtyPerLevel: number;
  notionalPerLevel: number;
  netProfitPct: number;
  netProfitPerLevel: number;
  quoteNeeded: number;
  worstLossUsdt: number;
  inventoryQty: number;
  inventoryCost: number;
  /** 卖单取整之后卖不掉的零头（小于一个步长）。 */
  dustQty: number;
  buys: number;
  sells: number;
  roundTrips: number;
  realizedUsdt: number;
  unrealizedUsdt: number;
  resting: GridRestingOrder[];
  lines: GridLineView[];
  lastAction?: string;
  lastReason?: string;
  lastError?: string;
  /** 这一拍因为穿价（只做 maker 被拒）而没挂上的格数。 */
  placeFailed: number;
}

export interface GridFill {
  id?: number;
  symbol: string;
  level: number;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  quote: number;
  feeQuote: number;
  realizedUsdt: number;
  orderId?: number;
  clientOrderId?: string;
  filledAt: string;
  fillSource?: string;
}

export interface Grid {
  id: number;
  symbol: string;
  mode: TradingNetwork;
  direction: GridDirection;
  market: GridMarket;
  leverage: number;
  exchangeKeyId: number;
  lower: number;
  upper: number;
  levels: number;
  quoteBudget: number;
  stopPct: number;
  feeRate: number;
  running: boolean;
  pauseReason: string;
  exchangeKeyNetwork: string;
  exchangeKeyActive: boolean;
  warnings: string[];
  /** 内存里没有引擎时为 null —— 不编一个"全零的运行状态"出来。 */
  snapshot: GridSnapshot | null;
  fills?: GridFill[];
  holdings?: Record<string, number>;
  realizedUsdt?: number;
}

export interface GridWrite {
  symbol?: string;
  exchangeKeyId?: number;
  mode?: TradingNetwork;
  direction?: GridDirection;
  market?: GridMarket;
  leverage?: number;
  lower?: number;
  upper?: number;
  levels?: number;
  quoteBudget?: number;
  stopPct?: number;
}

export interface GridPreviewRequest {
  symbol: string;
  direction?: GridDirection;
  market?: GridMarket;
  leverage?: number;
  lower: number;
  upper: number;
  levels: number;
  quoteBudget?: number;
  stopPct?: number;
  exchangeKeyId?: number;
  mode?: TradingNetwork;
}

const BASE = "/api/trading/grids";

/*
 * **body 传对象，不要自己 JSON.stringify。**
 *
 * apiRequest 内部会 stringify 一次；这里再 stringify 就把请求体变成了
 * 一个"装着 JSON 的 JSON 字符串"，服务端 ShouldBindJSON 拿到的是
 * 字符串字面量而不是对象，回一个看不懂的「请求格式不正确」。
 * 这种错只有把真实请求抓出来才看得见 —— 浏览器里看起来完全正常。
 */

export async function listGrids(): Promise<Grid[]> {
  const data = await apiRequest<{ items: Grid[] }>(BASE);
  return data.items ?? [];
}

export async function getGrid(id: number): Promise<Grid> {
  return apiRequest<Grid>(`${BASE}/${id}`);
}

export async function createGrid(body: GridWrite): Promise<Grid> {
  return apiRequest<Grid>(BASE, { method: "POST", body });
}

export async function updateGrid(id: number, body: GridWrite): Promise<Grid> {
  return apiRequest<Grid>(`${BASE}/${id}`, { method: "PUT", body });
}

export async function deleteGrid(id: number): Promise<void> {
  await apiRequest<void>(`${BASE}/${id}`, { method: "DELETE" });
}

export async function startGrid(id: number): Promise<Grid> {
  return apiRequest<Grid>(`${BASE}/${id}/start`, { method: "POST" });
}

export async function stopGrid(id: number): Promise<Grid> {
  return apiRequest<Grid>(`${BASE}/${id}/stop`, { method: "POST" });
}

/**
 * 算一份网格计划，**不保存、不下单**。
 *
 * 用户真正的困惑不是"怎么填参数"，而是"我这个账户到底能不能跑、
 * 要多少钱"。这个接口一次把两个问题都答了。
 */
export async function previewGrid(body: GridPreviewRequest): Promise<GridPreviewResponse> {
  return apiRequest<GridPreviewResponse>(`${BASE}/preview`, { method: "POST", body });
}

// 展示层的纯函数在 gridView.ts（那里不 import 任何东西，好让测试直接跑）。
export * from "./gridView";
