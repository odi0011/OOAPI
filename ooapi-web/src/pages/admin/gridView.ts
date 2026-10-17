/**
 * 网格页的纯展示逻辑。
 *
 * **刻意不 import 任何东西** —— 这个文件要能被一个 `node` 脚本直接跑起来
 * （见 gridView.test.ts）。混进网络请求或浏览器 API，测试就得拖一个
 * 运行时进来，而那些测试本来只是想验证"这个数字显示成几位小数"。
 *
 * 和 tradingDeskView.ts / tradingApi.ts 是同一个分法。
 */

/** 网格各条线的状态。与后端 trading.GridLine* 常量一一对应。 */
export type GridLineState = "buy" | "sell" | "holding" | "empty";

export type GridRunState = "Idle" | "Running" | "Stopped" | "Error";

/** 网格方向。做空只能跑在 USDT-M 合约上。 */
export type GridDirection = "long" | "short";

/** 网格市场。 */
export type GridMarket = "spot" | "futures";

export const GRID_LINE_BUY = "buy";
export const GRID_LINE_SELL = "sell";
export const GRID_LINE_HOLDING = "holding";
export const GRID_LINE_EMPTY = "empty";

/** 界面上的交易对下拉项。 */
export const GRID_SYMBOL_PRESETS: readonly string[] = [
  "SHIBUSDT",
  "PEPEUSDT",
  "BONKUSDT",
  "FLOKIUSDT",
  "1000SATSUSDT",
  "NEIROUSDT",
  "DOGEUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "TRXUSDT",
  "SOLUSDT",
  "BTCUSDT",
];

/**
 * 价格格式化。
 *
 * 小数位**按量级自适应**，不能用固定位数：SHIB 是 0.0000051、
 * DOGE 是 0.08、BTC 是 6 万，同一个位数要么让低价币的相邻网格线
 * 显示成同一个数，要么让高价币挂一长串没意义的 0。
 */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  return trimZeros(value.toFixed(8));
}

/** 比例格式化：入参是小数（0.0025 → 0.250%）。 */
export function formatPct(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatUsdt(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** 数量格式化。整数币不该显示成 "44.00" 个。 */
export function formatQty(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 1) return trimZeros(value.toFixed(2));
  return trimZeros(value.toFixed(8));
}

function trimZeros(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

/** 网格在界面上的中文状态。 */
export function gridStateLabel(state: string | undefined, running: boolean): string {
  if (!state) return running ? "待推进" : "未运行";
  switch (state) {
    case "Running":
      return "运行中";
    case "Stopped":
      return "已停止";
    case "Error":
      return "出错";
    default:
      return running ? "待推进" : "未运行";
  }
}

/**
 * 停机原因的中文说明。
 *
 * 只在**已经停机**时才把原因翻译成句子 —— 同一条 reason 在运行中
 * 出现的含义完全不同（"止损价"在运行中只是参数，停机时才是结果）。
 * 认不出来的原因原样显示，不吞掉：一个没见过的停机原因比一句
 * 含糊的"已停止"有用得多。
 */
export function gridReasonLabel(
  reason: string | undefined,
  state: string | undefined,
): string {
  if (!reason) return "";
  if (state !== "Stopped" && state !== "Error") return "";
  switch (reason) {
    case "grid_stop_loss":
      return "跌破止损，已清仓停机";
    case "grid_take_profit":
      return "涨过上沿，已止盈停机";
    case "grid_stopped_by_user":
      return "手动停止";
    default:
      return reason;
  }
}

/** 单条网格线的状态说明。空头网格的"持有"是持有空单。 */
export function lineStateLabel(state: string, direction: GridDirection = "long"): string {
  switch (state) {
    case GRID_LINE_BUY:
      return direction === "short" ? "挂着买平" : "挂着买单";
    case GRID_LINE_SELL:
      return direction === "short" ? "挂着卖开" : "挂着卖单";
    case GRID_LINE_HOLDING:
      return direction === "short" ? "已卖出，等买回" : "已买到，等卖";
    default:
      return "空着";
  }
}

export function gridDirectionLabel(direction: GridDirection): string {
  return direction === "short" ? "做空" : "做多";
}

export function gridMarketLabel(market: GridMarket): string {
  return market === "futures" ? "U 本位合约" : "现货";
}

/**
 * 资金门槛的说明文案。
 *
 * 门槛被哪一项顶起来，决定了解法 —— 这里必须分开说：
 *   · notional（交易所最小名义）—— 加钱或减少网格线；
 *   · dust（价格精度）—— 换一个步长更细的交易对，门槛立刻降下来。
 * 两者混成一句"资金不够"，用户会一直往一个错误的数字上加钱。
 */
export function requirementHint(limitedBy: string): string {
  if (limitedBy === "dust") {
    return "门槛是被**价格精度**顶起来的：步长越细的交易对，每格可以越小。";
  }
  return "门槛是被**交易所最小名义**顶起来的：加钱或者减少网格线都可以。";
}

/** 默认参数：一条看得过去的 DOGE 网格（现货多头）。 */
export function defaultGridDraft() {
  return {
    symbol: "DOGEUSDT",
    direction: "long" as GridDirection,
    market: "spot" as GridMarket,
    leverage: 3,
    lower: 0.075,
    upper: 0.085,
    levels: 8,
    quoteBudget: 50,
    stopPctPct: 2,
    exchangeKeyId: null as number | null,
    mode: "testnet" as "testnet" | "live",
  };
}

/**
 * 方向与市场是联动的：做空只能跑合约，现货只能是做多。
 * 返回规整之后的（方向, 市场）。
 */
export function normalizeGridShape(
  direction: GridDirection,
  market: GridMarket,
): { direction: GridDirection; market: GridMarket } {
  if (direction === "short") return { direction: "short", market: "futures" };
  return { direction, market };
}
