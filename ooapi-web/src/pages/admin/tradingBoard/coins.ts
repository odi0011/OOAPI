/**
 * 币种详细信息对象。选择器展示的不只是 symbol，
 * 而是包含图标、中文名、介绍、精度等的完整对象。
 */
export interface CoinInfo {
  /** 交易对，如 BTCUSDT */
  symbol: string;
  /** 基础币种，如 BTC */
  base: string;
  /** 图标 key，对应 CoinIcon 的内联 SVG */
  icon: string;
  /** 中文名 */
  name: string;
  /** 一句话介绍 */
  description: string;
  /** 价格小数位 */
  precision: number;
  /** 品牌色（浅色底上的图标底色） */
  color: string;
}

export const COINS: readonly CoinInfo[] = [
  {
    symbol: "BTCUSDT",
    base: "BTC",
    icon: "btc",
    name: "比特币",
    description: "市值最大的加密资产，机构配置首选，波动相对温和。",
    precision: 1,
    color: "#f7931a",
  },
  {
    symbol: "ETHUSDT",
    base: "ETH",
    icon: "eth",
    name: "以太坊",
    description: "智能合约公链龙头，DeFi 与 Layer2 生态的核心资产。",
    precision: 2,
    color: "#627eea",
  },
  {
    symbol: "DOGEUSDT",
    base: "DOGE",
    icon: "doge",
    name: "狗狗币",
    description: "社区驱动的 Meme 币鼻祖，波动大、弹性足，适合趋势策略。",
    precision: 4,
    color: "#c2a633",
  },
  {
    symbol: "XRPUSDT",
    base: "XRP",
    icon: "xrp",
    name: "瑞波币",
    description: "跨境支付场景的老牌资产，流动性好，点差稳定。",
    precision: 4,
    color: "#25a4e8",
  },
  {
    symbol: "SOLUSDT",
    base: "SOL",
    icon: "sol",
    name: "索拉纳",
    description: "高性能公链代币，生态活跃，日内波动机会多。",
    precision: 2,
    color: "#9945ff",
  },
  {
    symbol: "BNBUSDT",
    base: "BNB",
    icon: "bnb",
    name: "币安币",
    description: "币安生态平台币，手续费抵扣，走势与平台景气度相关。",
    precision: 2,
    color: "#f0b90b",
  },
];

/** 未知币种时的兜底对象，保证选择器永远有完整信息可展示。 */
export function coinInfoOf(symbol: string | undefined | null): CoinInfo {
  const upper = (symbol ?? "").toUpperCase();
  const found = COINS.find((coin) => coin.symbol === upper);
  if (found) return found;
  const base = upper.replace(/USDT$/, "") || upper || "?";
  return {
    symbol: upper || "UNKNOWN",
    base,
    icon: "generic",
    name: base,
    description: "该币种暂无详细介绍。",
    precision: 4,
    color: "#8a8f98",
  };
}
