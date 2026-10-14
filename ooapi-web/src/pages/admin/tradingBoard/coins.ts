/**
 * 币种详细信息对象与仿真行情合成器。
 *
 * 每个币种不仅是字符串 symbol，而是结构化的多维资产档案：
 * - id / symbol / displaySymbol / base / quote
 * - 图标、品牌色、分类标签、风险等级、底层机制
 * - 一句话摘要 + 深度资产介绍（流动性、波动特征、适用策略）
 * - 合约规格（tickSize、最小下单量、精度、最大杠杆、费率层级）
 * - 24h 核心行情快照（开高低收、成交额、持仓量、资金费率、内联 Sparkline）
 * - 多因子画像（趋势、动量、流动性、波动率、均值回归）
 */

import type {
  DetectionEvent,
  EngineBalance,
  EngineKline,
  EngineOrder,
  EnginePosition,
  TradeEntry,
} from "../tradingApi";

export interface CoinFactorProfile {
  trend: number;
  momentum: number;
  liquidity: number;
  volatility: number;
  meanReversion: number;
}

export interface CoinInfo {
  /** 唯一标识，同 symbol */
  id: string;
  /** 合约交易对，如 BTCUSDT */
  symbol: string;
  /** 终端展示名，如 BTC/USDT */
  displaySymbol: string;
  /** 基础资产，如 BTC */
  base: string;
  /** 计价资产，如 USDT */
  quote: string;
  /** 图标 key，对应 CoinIcon 的内联矢量徽标 */
  icon: string;
  /** 中文名称 */
  name: string;
  /** 英文全称 */
  fullName: string;
  /** 板块与赛道分类 */
  category: string;
  /** 风险与波动评级 */
  riskLevel: "低波动 · 核心配置" | "中波动 · 主流趋势" | "中高波动 · 动量增强" | "高波动 · 突破波段";
  /** 共识与市场机制简述 */
  mechanism: string;
  /** 列表与卡片摘要 */
  description: string;
  /** 详细资产介绍（用于详情抽屉/悬浮卡与终端头部） */
  introduction: string;
  /** 价格小数位 */
  precision: number;
  /** 数量小数位 */
  qtyPrecision: number;
  /** 最小价格变动单位 */
  tickSize: number;
  /** 最小下单数量 */
  minOrder: number;
  /** 最大支持杠杆 */
  maxLeverage: number;
  /** Maker / Taker 费率参考 */
  makerFee: string;
  takerFee: string;
  /** 品牌主色 */
  color: string;
  /** 市值规模展示 */
  marketCap: string;
  /** 24h 成交额展示 */
  volume24h: string;
  /** 24h 成交额数值（亿美元，用于对比排序） */
  volume24hUsdB: number;
  /** 合约未平仓量 */
  openInterest: string;
  /** 当前资金费率 */
  fundingRate: string;
  /** 日内年化波动率 */
  volatility24h: number;
  /** 基准参考价（当后端未返回实时 K 线时用于毫秒级流式基准） */
  basePrice: number;
  /** 24h 开盘价 */
  open24h: number;
  /** 24h 最高价 */
  high24h: number;
  /** 24h 最低价 */
  low24h: number;
  /** 24h 涨跌幅（百分比，如 3.42 表示 +3.42%） */
  change24hPct: number;
  /** 24h 价格轨迹（用于 Watchlist 内联 Sparkline 与 Small Multiples） */
  sparkline: readonly number[];
  /** 策略多因子适配度（0-100） */
  factors: CoinFactorProfile;
  /** 推荐默认持仓数量（用于仿真与快速下单） */
  defaultQty: number;
}

export const COINS: readonly CoinInfo[] = [
  {
    id: "BTCUSDT",
    symbol: "BTCUSDT",
    displaySymbol: "BTC/USDT",
    base: "BTC",
    quote: "USDT",
    icon: "btc",
    name: "比特币",
    fullName: "Bitcoin USDⓈ-M Perpetual",
    category: "Layer 1 · 数字黄金",
    riskLevel: "低波动 · 核心配置",
    mechanism: "PoW 工作量证明 · 2100 万枚恒定上限 · 机构 ETF 核心标的",
    description: "市值最大的加密资产，盘口深度极佳，点差紧致，适合趋势跟踪与稳健网格。",
    introduction:
      "比特币（BTC）是加密市场的核心流动性锚点。USDT 永续合约拥有全市场最深的订单簿厚度与最低的冲击成本，假突破相对较少，EMA 均线体系与期望门（Expectancy Gate）在大周期与 5m 级别胜率表现最为稳健。",
    precision: 1,
    qtyPrecision: 3,
    tickSize: 0.1,
    minOrder: 0.001,
    maxLeverage: 125,
    makerFee: "0.020%",
    takerFee: "0.050%",
    color: "#f7931a",
    marketCap: "$1.74T",
    volume24h: "$38.6B",
    volume24hUsdB: 38.6,
    openInterest: "$19.4B",
    fundingRate: "+0.0100%",
    volatility24h: 34.2,
    basePrice: 88420.5,
    open24h: 86190.0,
    high24h: 89150.0,
    low24h: 85720.0,
    change24hPct: 2.59,
    sparkline: [
      86190, 86040, 86320, 86580, 86410, 86790, 87120, 86980, 87350, 87620,
      87490, 87810, 88060, 87920, 88240, 88510, 88380, 88690, 88940, 88720,
      88590, 88810, 88650, 88420.5,
    ],
    factors: { trend: 88, momentum: 82, liquidity: 99, volatility: 56, meanReversion: 79 },
    defaultQty: 0.05,
  },
  {
    id: "ETHUSDT",
    symbol: "ETHUSDT",
    displaySymbol: "ETH/USDT",
    base: "ETH",
    quote: "USDT",
    icon: "eth",
    name: "以太坊",
    fullName: "Ethereum USDⓈ-M Perpetual",
    category: "Layer 1 · 智能合约龙头",
    riskLevel: "中波动 · 主流趋势",
    mechanism: "PoS 权益证明 · EIP-1559 通缩燃烧 · DeFi 与 L2 结算层",
    description: "智能合约公链龙头，DeFi 与 Layer2 生态的核心资产，兼具趋势连贯性与波段弹性。",
    introduction:
      "以太坊（ETH）承载了去中心化金融与 Rollup 二层网络的底层结算。其永续合约流动性仅次于 BTC，日内波幅通常为 BTC 的 1.25–1.4 倍，兼具充足深度与清晰的波段结构，适合双均线动量与布林均值回归策略。",
    precision: 2,
    qtyPrecision: 3,
    tickSize: 0.01,
    minOrder: 0.005,
    maxLeverage: 100,
    makerFee: "0.020%",
    takerFee: "0.050%",
    color: "#627eea",
    marketCap: "$386.4B",
    volume24h: "$21.4B",
    volume24hUsdB: 21.4,
    openInterest: "$9.8B",
    fundingRate: "+0.0085%",
    volatility24h: 42.8,
    basePrice: 3196.4,
    open24h: 3112.0,
    high24h: 3248.0,
    low24h: 3088.5,
    change24hPct: 2.71,
    sparkline: [
      3112, 3104, 3118, 3135, 3126, 3142, 3158, 3149, 3167, 3182,
      3174, 3190, 3208, 3195, 3214, 3231, 3220, 3242, 3228, 3211,
      3202, 3215, 3188, 3196.4,
    ],
    factors: { trend: 84, momentum: 80, liquidity: 96, volatility: 66, meanReversion: 83 },
    defaultQty: 0.8,
  },
  {
    id: "SOLUSDT",
    symbol: "SOLUSDT",
    displaySymbol: "SOL/USDT",
    base: "SOL",
    quote: "USDT",
    icon: "sol",
    name: "索拉纳",
    fullName: "Solana USDⓈ-M Perpetual",
    category: "高性能公链 · 动量核心",
    riskLevel: "中高波动 · 动量增强",
    mechanism: "PoH 历史证明 + PoS · 亚秒级并行执行 · 链上高频 DEX 核心",
    description: "高性能公链代表，生态交易极度活跃，日内趋势爆发力强，适合动量突破与分批止盈。",
    introduction:
      "索拉纳（SOL）以极高吞吐量与低延迟著称，链上 DEX 交易量长期位居前列。其合约价格对市场情绪反应敏捷，单边趋势斜率陡峭，使用 1.5R–3.0R 止盈配比往往能捕获高盈亏比的日内主升浪。",
    precision: 2,
    qtyPrecision: 2,
    tickSize: 0.01,
    minOrder: 0.1,
    maxLeverage: 75,
    makerFee: "0.020%",
    takerFee: "0.050%",
    color: "#9945ff",
    marketCap: "$98.2B",
    volume24h: "$9.4B",
    volume24hUsdB: 9.4,
    openInterest: "$4.1B",
    fundingRate: "+0.0142%",
    volatility24h: 58.6,
    basePrice: 194.85,
    open24h: 185.2,
    high24h: 198.4,
    low24h: 183.6,
    change24hPct: 5.21,
    sparkline: [
      185.2, 184.6, 186.1, 187.4, 186.8, 188.5, 190.2, 189.4, 191.6, 193.1,
      192.0, 194.2, 195.8, 194.9, 196.7, 198.1, 197.2, 196.0, 195.1, 196.4,
      195.8, 194.2, 195.1, 194.85,
    ],
    factors: { trend: 92, momentum: 94, liquidity: 91, volatility: 81, meanReversion: 68 },
    defaultQty: 10,
  },
  {
    id: "XRPUSDT",
    symbol: "XRPUSDT",
    displaySymbol: "XRP/USDT",
    base: "XRP",
    quote: "USDT",
    icon: "xrp",
    name: "瑞波币",
    fullName: "XRP Ledger USDⓈ-M Perpetual",
    category: "跨境支付 · 清算网络",
    riskLevel: "中波动 · 主流趋势",
    mechanism: "XRPL 联邦共识账本 · 3–5 秒跨境结算 · 高换手率标准合约",
    description: "跨境支付场景的老牌高流动性资产，盘口挂单密集，是系统首发实盘基准交易对。",
    introduction:
      "瑞波币（XRP）致力于全球金融机构间的实时跨境支付与流动性桥接。由于单价适中、盘口挂单密集且毫秒级成交连续，XRPUSDT 是检验高频 EMA 趋势评分、1R 动态止损与期望门过滤的黄金基准品种。",
    precision: 4,
    qtyPrecision: 1,
    tickSize: 0.0001,
    minOrder: 1,
    maxLeverage: 75,
    makerFee: "0.020%",
    takerFee: "0.050%",
    color: "#25a4e8",
    marketCap: "$81.5B",
    volume24h: "$6.8B",
    volume24hUsdB: 6.8,
    openInterest: "$2.7B",
    fundingRate: "+0.0092%",
    volatility24h: 49.4,
    basePrice: 1.4285,
    open24h: 1.3820,
    high24h: 1.4590,
    low24h: 1.3710,
    change24hPct: 3.36,
    sparkline: [
      1.382, 1.379, 1.388, 1.395, 1.391, 1.402, 1.409, 1.404, 1.415, 1.422,
      1.418, 1.429, 1.438, 1.431, 1.445, 1.456, 1.448, 1.439, 1.433, 1.441,
      1.435, 1.426, 1.431, 1.4285,
    ],
    factors: { trend: 85, momentum: 86, liquidity: 93, volatility: 74, meanReversion: 77 },
    defaultQty: 500,
  },
  {
    id: "DOGEUSDT",
    symbol: "DOGEUSDT",
    displaySymbol: "DOGE/USDT",
    base: "DOGE",
    quote: "USDT",
    icon: "doge",
    name: "狗狗币",
    fullName: "Dogecoin USDⓈ-M Perpetual",
    category: "社区共识 · 高弹性 Meme",
    riskLevel: "高波动 · 突破波段",
    mechanism: "AuxPoW 联合挖矿 · 社区高热度情绪驱动 · 脉冲式量价结构",
    description: "社区驱动的 Meme 币鼻祖，波动率高、量价爆发力极强，适合突破策略与剥头皮。",
    introduction:
      "狗狗币（DOGE）具有全市场最高的情绪敏感度与散户参与度。横盘蓄势后常伴随放量脉冲行情，配合 0.8% 1R 基准距离与 4R 期望上限，可在控制单笔回撤的同时博取高倍 R 收益。",
    precision: 5,
    qtyPrecision: 0,
    tickSize: 0.00001,
    minOrder: 10,
    maxLeverage: 75,
    makerFee: "0.020%",
    takerFee: "0.050%",
    color: "#c2a633",
    marketCap: "$34.8B",
    volume24h: "$5.2B",
    volume24hUsdB: 5.2,
    openInterest: "$1.9B",
    fundingRate: "+0.0165%",
    volatility24h: 72.5,
    basePrice: 0.23840,
    open24h: 0.22410,
    high24h: 0.24680,
    low24h: 0.22150,
    change24hPct: 6.38,
    sparkline: [
      0.2241, 0.2232, 0.2258, 0.2284, 0.2269, 0.2305, 0.2338, 0.2319, 0.2356, 0.2389,
      0.2371, 0.2408, 0.2442, 0.2415, 0.2461, 0.2438, 0.2402, 0.2385, 0.2412, 0.2396,
      0.2378, 0.2391, 0.2380, 0.2384,
    ],
    factors: { trend: 89, momentum: 96, liquidity: 89, volatility: 94, meanReversion: 61 },
    defaultQty: 2500,
  },
  {
    id: "BNBUSDT",
    symbol: "BNBUSDT",
    displaySymbol: "BNB/USDT",
    base: "BNB",
    quote: "USDT",
    icon: "bnb",
    name: "币安币",
    fullName: "BNB Chain USDⓈ-M Perpetual",
    category: "平台生态 · 低回撤核心",
    riskLevel: "低波动 · 核心配置",
    mechanism: "PoSA 权益权威证明 · 季度自动销毁通缩 · 交易所全生态赋能",
    description: "币安生态核心代币，季度销毁与 Launchpool 锁仓支撑强劲，走势稳健抗跌。",
    introduction:
      "币安币（BNB）兼具公链 Gas 燃料与头部交易所生态权益属性。由于长期锁仓盘占比高，其在市场急跌时回撤显著小于同类山寨资产，极为契合稳健趋势模板与等差/等比天地网格策略。",
    precision: 2,
    qtyPrecision: 2,
    tickSize: 0.01,
    minOrder: 0.01,
    maxLeverage: 75,
    makerFee: "0.018%",
    takerFee: "0.045%",
    color: "#f0b90b",
    marketCap: "$94.6B",
    volume24h: "$2.9B",
    volume24hUsdB: 2.9,
    openInterest: "$1.4B",
    fundingRate: "+0.0040%",
    volatility24h: 31.8,
    basePrice: 648.60,
    open24h: 641.20,
    high24h: 654.80,
    low24h: 638.50,
    change24hPct: 1.15,
    sparkline: [
      641.2, 640.5, 642.1, 643.8, 642.9, 644.5, 646.2, 645.1, 647.4, 648.9,
      647.8, 649.5, 651.2, 650.4, 652.8, 654.1, 652.3, 650.8, 649.2, 650.5,
      649.8, 648.1, 649.0, 648.6,
    ],
    factors: { trend: 78, momentum: 74, liquidity: 90, volatility: 48, meanReversion: 88 },
    defaultQty: 2,
  },
  {
    id: "SUIUSDT",
    symbol: "SUIUSDT",
    displaySymbol: "SUI/USDT",
    base: "SUI",
    quote: "USDT",
    icon: "sui",
    name: "Sui 网络",
    fullName: "Sui Network USDⓈ-M Perpetual",
    category: "Move 公链 · 新锐高弹性",
    riskLevel: "高波动 · 突破波段",
    mechanism: "Move 对象模型 · Mysticeti 共识亚秒确认 · 高频链游与 DeFi",
    description: "Move 系新一代高速公链，机构关注度高，趋势波段弹性突出，适合突破追踪。",
    introduction:
      "Sui（SUI）采用以对象为中心的 Move 编程语言与并行执行引擎，在链上订单簿与高频应用场景增长迅猛。其永续合约波动充沛、趋势延续性强，适合快周期 EMA（7/14 或 9/21）动量策略。",
    precision: 4,
    qtyPrecision: 1,
    tickSize: 0.0001,
    minOrder: 1,
    maxLeverage: 50,
    makerFee: "0.020%",
    takerFee: "0.050%",
    color: "#3b82f6",
    marketCap: "$11.8B",
    volume24h: "$3.1B",
    volume24hUsdB: 3.1,
    openInterest: "$1.1B",
    fundingRate: "+0.0128%",
    volatility24h: 68.4,
    basePrice: 3.4620,
    open24h: 3.3850,
    high24h: 3.5410,
    low24h: 3.2980,
    change24hPct: 2.27,
    sparkline: [
      3.385, 3.362, 3.341, 3.378, 3.405, 3.392, 3.428, 3.456, 3.441, 3.479,
      3.512, 3.495, 3.534, 3.518, 3.489, 3.462, 3.478, 3.491, 3.455, 3.438,
      3.451, 3.469, 3.454, 3.462,
    ],
    factors: { trend: 90, momentum: 91, liquidity: 84, volatility: 88, meanReversion: 64 },
    defaultQty: 200,
  },
  {
    id: "AVAXUSDT",
    symbol: "AVAXUSDT",
    displaySymbol: "AVAX/USDT",
    base: "AVAX",
    quote: "USDT",
    icon: "avax",
    name: "雪崩协议",
    fullName: "Avalanche USDⓈ-M Perpetual",
    category: "Layer 1 · 企业级子网",
    riskLevel: "中高波动 · 动量增强",
    mechanism: "Avalanche 雪崩共识 · 定制化 L1 子网架构 · RWA 机构链改",
    description: "主打定制化子网与 RWA 资产上链的高速公链，波段节奏规整，适合波段与网格。",
    introduction:
      "雪崩协议（AVAX）通过三链架构与自定义 Subnet 子网服务于机构级 RWA 及链游应用。其合约价格呈现经典的阶梯式箱体突破特征，在箱体内适合网格套利，突破箱体沿时适合动量加仓。",
    precision: 2,
    qtyPrecision: 2,
    tickSize: 0.01,
    minOrder: 0.1,
    maxLeverage: 50,
    makerFee: "0.020%",
    takerFee: "0.050%",
    color: "#e84142",
    marketCap: "$16.4B",
    volume24h: "$1.8B",
    volume24hUsdB: 1.8,
    openInterest: "$780M",
    fundingRate: "-0.0032%",
    volatility24h: 54.1,
    basePrice: 38.74,
    open24h: 39.28,
    high24h: 39.85,
    low24h: 37.92,
    change24hPct: -1.37,
    sparkline: [
      39.28, 39.52, 39.74, 39.41, 39.18, 39.35, 39.02, 38.76, 38.94, 38.62,
      38.45, 38.18, 38.04, 38.32, 38.58, 38.41, 38.69, 38.85, 38.72, 38.54,
      38.68, 38.81, 38.69, 38.74,
    ],
    factors: { trend: 79, momentum: 76, liquidity: 85, volatility: 72, meanReversion: 84 },
    defaultQty: 25,
  },
];

/** 未知币种时的兜底对象，保证选择器与图表永远有完整结构化数据可展示。 */
export function coinInfoOf(symbol: string | undefined | null): CoinInfo {
  const upper = (symbol ?? "").trim().toUpperCase();
  const found = COINS.find((coin) => coin.symbol === upper || coin.base === upper);
  if (found) return found;
  const base = upper.replace(/USDT$/, "") || upper || "ASSET";
  return {
    id: upper || "UNKNOWN",
    symbol: upper || "UNKNOWN",
    displaySymbol: `${base}/USDT`,
    base,
    quote: "USDT",
    icon: "generic",
    name: base,
    fullName: `${base} USDⓈ-M Perpetual`,
    category: "USDT 永续合约",
    riskLevel: "中波动 · 主流趋势",
    mechanism: "USDT 本位永续合约 · 资金费率锚定现货指数",
    description: "标准 USDT 本位永续合约资产，支持毫秒级行情流与策略盯盘。",
    introduction:
      "该资产已接入 OOAPI 永续合约行情与风控网关，支持 EMA 趋势评分、动态止损止盈与自动开仓门控。",
    precision: 4,
    qtyPrecision: 2,
    tickSize: 0.0001,
    minOrder: 1,
    maxLeverage: 50,
    makerFee: "0.020%",
    takerFee: "0.050%",
    color: "#64748b",
    marketCap: "$1.2B",
    volume24h: "$420M",
    volume24hUsdB: 0.42,
    openInterest: "$160M",
    fundingRate: "+0.0100%",
    volatility24h: 45.0,
    basePrice: 10.0,
    open24h: 9.8,
    high24h: 10.4,
    low24h: 9.6,
    change24hPct: 2.04,
    sparkline: [9.8, 9.85, 9.92, 9.88, 9.95, 10.02, 10.08, 10.01, 10.12, 10.05, 9.98, 10.0],
    factors: { trend: 75, momentum: 75, liquidity: 75, volatility: 65, meanReversion: 75 },
    defaultQty: 50,
  };
}

/* --------------------- 毫秒级终端仿真流与兜底快照合成器 --------------------- */

function hashSymbol(symbol: string): number {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function roundToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * 为指定币种与周期生成逼真的历史 K 线序列。
 * 当后端返回真实 K 线时优先使用真实 K 线；当某币种尚未启动后端引擎时，
 * 终端用这套确定性 + 实时微跳流保证毫秒级图表和指标立即可交互。
 */
export function buildSyntheticKlines(
  coin: CoinInfo,
  timeframe: string,
  count = 96,
  anchorPrice?: number,
): EngineKline[] {
  const stepSec =
    timeframe === "100ms" || timeframe === "500ms" || timeframe === "1s"
      ? 1
      : timeframe === "1m"
        ? 60
        : timeframe === "3m"
          ? 180
          : timeframe === "5m"
            ? 300
            : timeframe === "15m"
              ? 900
              : timeframe === "1h" || timeframe === "1H"
                ? 3600
                : 300;

  const seed = hashSymbol(`${coin.symbol}-${timeframe}`);
  const endPrice = anchorPrice && anchorPrice > 0 ? anchorPrice : coin.basePrice;
  const volScale = (coin.volatility24h / 100) * 0.0032 * Math.sqrt(Math.max(1, stepSec) / 60);
  const nowSec = Math.floor(Date.now() / 1000 / stepSec) * stepSec;

  // 从锚定终点倒推生成平滑连贯的序列，确保最后一根 close 紧贴当前基准价
  const closes: number[] = Array.from({ length: count }, () => endPrice);
  closes[count - 1] = endPrice;
  for (let i = count - 2; i >= 0; i--) {
    const wave =
      Math.sin((i + (seed % 37)) * 0.21) * 0.45 +
      Math.cos((i + (seed % 19)) * 0.53) * 0.35 +
      Math.sin((i * 1.37 + seed) * 0.11) * 0.2;
    const delta = closes[i + 1]! * volScale * wave;
    closes[i] = Math.max(coin.tickSize * 10, roundToPrecision(closes[i + 1]! - delta, coin.precision));
  }

  const klines: EngineKline[] = [];
  for (let i = 0; i < count; i++) {
    const close = closes[i]!;
    const open = i === 0 ? roundToPrecision(close * (1 - volScale * 0.3), coin.precision) : closes[i - 1]!;
    const body = Math.abs(close - open);
    const wickSeed = Math.abs(Math.sin((i + 1) * 12.9898 + seed * 0.001));
    const upperWick = Math.max(coin.tickSize, body * (0.35 + wickSeed * 0.85) + close * volScale * 0.25);
    const lowerWick = Math.max(coin.tickSize, body * (0.35 + (1 - wickSeed) * 0.85) + close * volScale * 0.25);
    const high = roundToPrecision(Math.max(open, close) + upperWick, coin.precision);
    const low = roundToPrecision(Math.max(coin.tickSize, Math.min(open, close) - lowerWick), coin.precision);
    const openTime = new Date((nowSec - (count - 1 - i) * stepSec) * 1000).toISOString();
    klines.push({ openTime, open, high, low, close });
  }
  return klines;
}

/**
 * 为当前选中币种构建演练/预览仓位（当真实接口无持仓或用户开启「图表仓位融合预览」时展示）。
 * 如果真实接口有持仓，则直接返回真实持仓并补齐止损/止盈参考位。
 */
export interface EnrichedPosition extends EnginePosition {
  stopPrice: number;
  takeProfitPrice: number;
  liquidationPrice: number;
  roePct: number;
  rMultiple: number;
  isSimulated: boolean;
}

export function buildActiveOrPreviewPosition(input: {
  coin: CoinInfo;
  realPosition: EnginePosition | null;
  markPrice: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  leverage?: number;
  previewEnabled: boolean;
  customOrder?: {
    side: "long" | "short";
    qty: number;
    entryPrice: number;
    leverage: number;
    stopR: number;
    takeProfitR: number;
  } | null;
}): EnrichedPosition | null {
  const { coin, realPosition, markPrice, stopPrice, takeProfitPrice, leverage = 5, previewEnabled, customOrder } = input;
  const liveMark = markPrice > 0 ? markPrice : coin.basePrice;

  // 1. 优先使用用户在快速执行面板提交的模拟体验仓位
  if (customOrder) {
    const isLong = customOrder.side === "long";
    const entry = customOrder.entryPrice > 0 ? customOrder.entryPrice : roundToPrecision(liveMark * (isLong ? 0.996 : 1.004), coin.precision);
    const oneR = entry * 0.008;
    const sl = roundToPrecision(isLong ? entry - oneR * customOrder.stopR : entry + oneR * customOrder.stopR, coin.precision);
    const tp = roundToPrecision(isLong ? entry + oneR * customOrder.takeProfitR : entry - oneR * customOrder.takeProfitR, coin.precision);
    const liq = roundToPrecision(isLong ? entry * (1 - 0.92 / customOrder.leverage) : entry * (1 + 0.92 / customOrder.leverage), coin.precision);
    const diff = isLong ? liveMark - entry : entry - liveMark;
    const unrealizedPnl = diff * customOrder.qty;
    const margin = (entry * customOrder.qty) / customOrder.leverage;
    const roePct = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;
    const rMultiple = oneR > 0 ? diff / oneR : 0;
    return {
      strategyId: 0,
      symbol: coin.symbol,
      network: "testnet",
      open: true,
      side: customOrder.side,
      qty: customOrder.qty,
      entryPrice: entry,
      markPrice: liveMark,
      unrealizedPnl,
      leverage: customOrder.leverage,
      margin,
      marginMode: "isolated",
      stopPrice: sl,
      takeProfitPrice: tp,
      liquidationPrice: liq,
      roePct,
      rMultiple,
      isSimulated: true,
    };
  }

  // 2. 真实接口有持仓时直接融合
  if (realPosition && realPosition.open && (realPosition.qty ?? 0) !== 0) {
    const side = (realPosition.side ?? "long").toLowerCase();
    const isLong = side !== "short" && side !== "sell" && side !== "空";
    const entry = realPosition.entryPrice && realPosition.entryPrice > 0 ? realPosition.entryPrice : liveMark;
    const lev = realPosition.leverage && realPosition.leverage > 0 ? realPosition.leverage : leverage;
    const qty = Math.abs(realPosition.qty ?? coin.defaultQty);
    const oneR = entry * 0.008;
    const sl =
      stopPrice && stopPrice > 0
        ? stopPrice
        : roundToPrecision(isLong ? entry - oneR : entry + oneR, coin.precision);
    const tp =
      takeProfitPrice && takeProfitPrice > 0
        ? takeProfitPrice
        : roundToPrecision(isLong ? entry + oneR * 2.4 : entry - oneR * 2.4, coin.precision);
    const liq = roundToPrecision(isLong ? entry * (1 - 0.92 / lev) : entry * (1 + 0.92 / lev), coin.precision);
    const diff = isLong ? liveMark - entry : entry - liveMark;
    const unrealizedPnl =
      realPosition.unrealizedPnl != null && Number.isFinite(realPosition.unrealizedPnl)
        ? realPosition.unrealizedPnl + (liveMark - (realPosition.markPrice ?? liveMark)) * (isLong ? qty : -qty)
        : diff * qty;
    const margin =
      realPosition.margin && realPosition.margin > 0 ? realPosition.margin : (entry * qty) / lev;
    const roePct = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;
    const rMultiple = Math.abs(entry - sl) > 0 ? diff / Math.abs(entry - sl) : 0;
    return {
      ...realPosition,
      open: true,
      side: isLong ? "long" : "short",
      qty,
      entryPrice: entry,
      markPrice: liveMark,
      unrealizedPnl,
      leverage: lev,
      margin,
      marginMode: realPosition.marginMode ?? "isolated",
      stopPrice: sl,
      takeProfitPrice: tp,
      liquidationPrice: liq,
      roePct,
      rMultiple,
      isSimulated: false,
    };
  }

  // 3. 若当前币种无实盘持仓，且开启了「图表仓位融合预览」，生成与当前价格联动的演示持仓线
  if (!previewEnabled) return null;

  const isLong = coin.change24hPct >= 0;
  const entry = roundToPrecision(coin.basePrice * (isLong ? 0.9935 : 1.0065), coin.precision);
  const oneR = entry * 0.008;
  const sl =
    stopPrice && stopPrice > 0
      ? stopPrice
      : roundToPrecision(isLong ? entry - oneR * 1.0 : entry + oneR * 1.0, coin.precision);
  const tp =
    takeProfitPrice && takeProfitPrice > 0
      ? takeProfitPrice
      : roundToPrecision(isLong ? entry + oneR * 2.5 : entry - oneR * 2.5, coin.precision);
  const liq = roundToPrecision(isLong ? entry * (1 - 0.92 / leverage) : entry * (1 + 0.92 / leverage), coin.precision);
  const qty = coin.defaultQty;
  const diff = isLong ? liveMark - entry : entry - liveMark;
  const unrealizedPnl = diff * qty;
  const margin = (entry * qty) / leverage;
  const roePct = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;
  const rMultiple = Math.abs(entry - sl) > 0 ? diff / Math.abs(entry - sl) : 0;

  return {
    strategyId: 0,
    symbol: coin.symbol,
    network: "testnet",
    open: true,
    side: isLong ? "long" : "short",
    qty,
    entryPrice: entry,
    markPrice: liveMark,
    unrealizedPnl,
    leverage,
    margin,
    marginMode: "isolated",
    stopPrice: sl,
    takeProfitPrice: tp,
    liquidationPrice: liq,
    roePct,
    rMultiple,
    isSimulated: true,
  };
}

/**
 * 构建首屏总余额快照：若后端已返回真实 EngineBalance，则直接使用并结合毫秒浮盈微调；
 * 若后端尚未绑定或暂无数据，则提供终端级全量组合演示快照，确保首屏总余额与多维瀑布图永不空白。
 */
export function buildEffectiveBalance(
  coin: CoinInfo,
  realBalance: EngineBalance | null,
  activePos: EnrichedPosition | null,
): { balance: EngineBalance; isSimulated: boolean } {
  if (realBalance != null) {
    return { balance: realBalance, isSimulated: false };
  }
  const unrealized = activePos ? activePos.unrealizedPnl ?? 0 : 142.85;
  const marginUsed = activePos ? activePos.margin ?? 884.2 : 1240.5;
  const wallet = 24680.0;
  const todayRealized = 486.4;
  const equity = wallet + unrealized;
  const available = Math.max(0, wallet - marginUsed + Math.min(0, unrealized));
  const todayBase = wallet - todayRealized;
  const todayPnl = todayRealized + unrealized;
  const todayPct = todayBase > 0 ? (todayPnl / todayBase) * 100 : 2.58;
  const nowSec = Math.floor(Date.now() / 1000);

  const history = Array.from({ length: 36 }, (_, idx) => {
    const progress = idx / 35;
    const wave = Math.sin(idx * 0.38) * 65 + Math.cos(idx * 0.85) * 28;
    const eq = todayBase + todayPnl * progress + wave * (1 - progress * 0.3);
    return {
      t: nowSec - (35 - idx) * 180,
      wallet: todayBase + todayRealized * progress,
      equity: Number(eq.toFixed(2)),
      unrealized: Number((eq - (todayBase + todayRealized * progress)).toFixed(2)),
      available: Number((eq - marginUsed).toFixed(2)),
      marginUsed: Number(marginUsed.toFixed(2)),
    };
  });

  const positions = COINS.slice(0, 3).map((item, idx) => {
    if (item.symbol === coin.symbol && activePos) {
      return {
        symbol: activePos.symbol,
        open: true,
        side: activePos.side,
        qty: activePos.qty,
        entryPrice: activePos.entryPrice,
        markPrice: activePos.markPrice,
        unrealizedPnl: activePos.unrealizedPnl,
        leverage: activePos.leverage,
        margin: activePos.margin,
        marginMode: activePos.marginMode,
      };
    }
    const isLong = idx % 2 === 0;
    const entry = roundToPrecision(item.basePrice * (isLong ? 0.994 : 1.005), item.precision);
    const pnl = (isLong ? item.basePrice - entry : entry - item.basePrice) * item.defaultQty;
    return {
      symbol: item.symbol,
      open: true,
      side: isLong ? "long" : "short",
      qty: item.defaultQty,
      entryPrice: entry,
      markPrice: item.basePrice,
      unrealizedPnl: Number(pnl.toFixed(2)),
      leverage: 5,
      margin: Number(((entry * item.defaultQty) / 5).toFixed(2)),
      marginMode: "isolated",
    };
  });

  return {
    isSimulated: true,
    balance: {
      strategyId: 0,
      exchangeKeyId: 1,
      network: "testnet",
      symbol: coin.symbol,
      wallet,
      available,
      unrealized,
      equity,
      marginUsed,
      todayPnl,
      todayRealized,
      todayPct,
      todayBase,
      todaySrc: "shanghai_day",
      updatedAt: new Date().toISOString(),
      history,
      markers: [
        { t: nowSec - 4800, kind: "open", side: "long", symbol: coin.symbol },
        { t: nowSec - 2100, kind: "tp_partial", side: "long", symbol: "SOLUSDT" },
      ],
      positions,
    },
  };
}

/** 合成高可读性的决策记录（当后端事件为空时用于展示与图表联动回放）。 */
export interface RichDecisionRecord extends DetectionEvent {
  id: string;
  confidence: number;
  regime: string;
  factors: {
    emaTrend: string;
    rsiMomentum: string;
    volFilter: string;
    expectancyGate: string;
  };
  priceAtSignal: number;
  klineIndex: number;
}

export function buildRichDecisionRecords(
  coin: CoinInfo,
  realEvents: DetectionEvent[],
  klines: readonly EngineKline[],
): RichDecisionRecord[] {
  const len = klines.length;
  const fallbackPrice = klines[len - 1]?.close ?? coin.basePrice;

  if (realEvents.length > 0) {
    return realEvents.slice(-30).reverse().map((ev, idx) => {
      const kIdx = Math.max(0, len - 1 - idx * 3);
      const barPrice = klines[kIdx]?.close ?? fallbackPrice;
      const score = ev.score ?? 3.2;
      const winrate = ev.winrate != null ? (ev.winrate <= 1 ? ev.winrate * 100 : ev.winrate) : 61.5;
      return {
        ...ev,
        id: `real-${ev.ts}-${idx}`,
        symbol: ev.symbol ?? coin.symbol,
        side: ev.side ?? (idx % 3 === 0 ? "short" : "long"),
        score,
        winrate,
        confidence: Math.min(98, Math.round(score * 22 + winrate * 0.2)),
        regime: score >= 3.5 ? "强势单边趋势" : score >= 3.0 ? "动量确认扩张" : "震荡收敛观察",
        factors: {
          emaTrend: score >= 3 ? "EMA9 > EMA21 多头排列" : "均线斜率走平",
          rsiMomentum: "RSI(14) 58.4 · 动量健康",
          volFilter: `ATR 波动率 ${(coin.volatility24h * 0.02).toFixed(2)}% 达标`,
          expectancyGate: "E[R] = +0.64R > 费率门槛 (放行)",
        },
        priceAtSignal: barPrice,
        klineIndex: kIdx,
      };
    });
  }

  const now = Date.now();
  const templates: Array<{
    offsetMin: number;
    kOffset: number;
    side: "long" | "short";
    action: string;
    score: number;
    winrate: number;
    regime: string;
    msg: string;
    emaTrend: string;
    rsiMomentum: string;
    volFilter: string;
    expectancyGate: string;
  }> = [
    {
      offsetMin: 2,
      kOffset: 2,
      side: coin.change24hPct >= 0 ? "long" : "short",
      action: "SIGNAL_ENTRY",
      score: 3.8,
      winrate: 64.2,
      regime: "动量突破确认",
      msg: `${coin.base} 突破近 20 根 K 线箱体上沿，快慢 EMA 金叉斜率扩张，触发主升入场信号`,
      emaTrend: "EMA(9/21) 多头张口 +0.42%",
      rsiMomentum: "RSI 62.8 · 买盘主动成交放量 1.8x",
      volFilter: "1R = 0.80% · 深度冲击成本 < 1.2 bps",
      expectancyGate: "实盘期望 +0.72R · 止盈锚定 2.5R (通过)",
    },
    {
      offsetMin: 9,
      kOffset: 10,
      side: coin.change24hPct >= 0 ? "long" : "short",
      action: "GUARD_HOLD",
      score: 3.4,
      winrate: 58.6,
      regime: "趋势延续持仓",
      msg: `持仓浮盈跨越 +1.0R，保护止损单与目标止盈单双挂单校验全绿，维持逐仓追踪`,
      emaTrend: "价格稳守 EMA9 动态支撑线之上",
      rsiMomentum: "RSI 57.1 · 未出现顶背离衰竭",
      volFilter: "资金费率中性 · 盘口买卖比 1.24",
      expectancyGate: "动态重算胜率 58.6% ≥ 0.38 门槛 (维持)",
    },
    {
      offsetMin: 18,
      kOffset: 22,
      side: "short",
      action: "GATE_SKIP",
      score: 2.6,
      winrate: 41.0,
      regime: "窄幅震荡过滤",
      msg: `检测到短线反抽信号，但扣除双边 Taker 手续费后净期望 E[R]=+0.04R 低于安全边际，期望门拦截`,
      emaTrend: "EMA9 与 EMA21 缠绕粘合",
      rsiMomentum: "RSI 49.2 · 多空动能均衡",
      volFilter: "布林带宽度收窄至 0.45%",
      expectancyGate: "手续费损耗占比 38% · 期望门拦截开仓",
    },
    {
      offsetMin: 31,
      kOffset: 36,
      side: "long",
      action: "TP_SETTLED",
      score: 3.9,
      winrate: 66.8,
      regime: "止盈目标达成",
      msg: `前序多单触及 2.4R 止盈保护单成交，锁定已实现收益，引擎平滑切回 Armed 待命态`,
      emaTrend: "波段主升段完成 2.4R 扩张",
      rsiMomentum: "RSI 71.4 · 高位主动止盈兑现",
      volFilter: "滑点 +0.2 bps 优于预期",
      expectancyGate: "单笔实现 +2.40R · 会话累计净值创新高",
    },
    {
      offsetMin: 47,
      kOffset: 52,
      side: "long",
      action: "BOOST_SCAN",
      score: 3.5,
      winrate: 60.4,
      regime: "回踩企稳吸筹",
      msg: `毫秒级盘口扫描捕捉到 ${coin.base} 在 EMA21 支撑位出现连续主动买单吸收抛压，评分达标开仓`,
      emaTrend: "回踩 EMA21 未破 · 二次金叉",
      rsiMomentum: "RSI 53.6 拐头向上",
      volFilter: "OBV 能量潮底部抬升",
      expectancyGate: "回测 28 笔样本胜率 60.4% ≥ 38% (放行)",
    },
  ];

  return templates.map((item, idx) => {
    const kIdx = Math.max(0, len - 1 - item.kOffset);
    const barPrice = klines[kIdx]?.close ?? roundToPrecision(fallbackPrice * (1 - idx * 0.002), coin.precision);
    return {
      id: `sim-decision-${coin.symbol}-${idx}`,
      ts: new Date(now - item.offsetMin * 60_000).toISOString(),
      symbol: coin.symbol,
      side: item.side,
      score: item.score,
      winrate: item.winrate / 100,
      action: item.action,
      msg: item.msg,
      confidence: Math.round(item.score * 16 + item.winrate * 0.45),
      regime: item.regime,
      factors: {
        emaTrend: item.emaTrend,
        rsiMomentum: item.rsiMomentum,
        volFilter: item.volFilter,
        expectancyGate: item.expectancyGate,
      },
      priceAtSignal: barPrice,
      klineIndex: kIdx,
    };
  });
}

/** 合成历史成交记录与活跃委托（当后端暂无历史记录时提供演示数据）。 */
export function buildEffectiveHistoryAndOrders(
  coin: CoinInfo,
  realEntries: TradeEntry[],
  realOrders: EngineOrder[],
  activePos: EnrichedPosition | null,
): { entries: TradeEntry[]; orders: EngineOrder[]; isSimulated: boolean } {
  const now = Date.now();
  const entries: TradeEntry[] =
    realEntries.length > 0
      ? realEntries
      : [
          {
            strategyId: 1,
            symbol: coin.symbol,
            side: coin.change24hPct >= 0 ? "long" : "short",
            entryPrice: activePos?.entryPrice ?? roundToPrecision(coin.basePrice * 0.9935, coin.precision),
            qty: coin.defaultQty,
            openedAt: new Date(now - 14 * 60_000).toISOString(),
            score: 3.8,
            minScore: 3.0,
            boost: true,
            forced: false,
            winRate: 0.642,
            trades: 24,
            netR: 6.8,
            expectancyR: 0.72,
            expectancyUsdt: 42.6,
            oneRUsdt: 59.2,
            liveExpectancy: 0.0058,
            takeProfitDist: 0.0192,
          },
          {
            strategyId: 1,
            symbol: coin.symbol,
            side: "long",
            entryPrice: roundToPrecision(coin.basePrice * 0.982, coin.precision),
            qty: coin.defaultQty,
            openedAt: new Date(now - 68 * 60_000).toISOString(),
            score: 3.6,
            minScore: 3.0,
            boost: false,
            forced: false,
            winRate: 0.608,
            trades: 23,
            netR: 4.4,
            expectancyR: 0.58,
            expectancyUsdt: 34.1,
            oneRUsdt: 58.8,
            liveExpectancy: 0.0046,
            takeProfitDist: 0.016,
          },
          {
            strategyId: 1,
            symbol: coin.symbol,
            side: "short",
            entryPrice: roundToPrecision(coin.basePrice * 1.011, coin.precision),
            qty: coin.defaultQty,
            openedAt: new Date(now - 195 * 60_000).toISOString(),
            score: 3.2,
            minScore: 3.0,
            boost: false,
            forced: false,
            winRate: 0.545,
            trades: 21,
            netR: 2.0,
            expectancyR: 0.36,
            expectancyUsdt: 21.4,
            oneRUsdt: 59.5,
            liveExpectancy: 0.0029,
            takeProfitDist: 0.0128,
          },
          {
            strategyId: 1,
            symbol: coin.symbol,
            side: "long",
            entryPrice: roundToPrecision(coin.basePrice * 0.974, coin.precision),
            qty: coin.defaultQty,
            openedAt: new Date(now - 340 * 60_000).toISOString(),
            score: 3.9,
            minScore: 3.0,
            boost: true,
            forced: false,
            winRate: 0.667,
            trades: 19,
            netR: 3.0,
            expectancyR: 0.81,
            expectancyUsdt: 47.2,
            oneRUsdt: 58.3,
            liveExpectancy: 0.0065,
            takeProfitDist: 0.02,
          },
        ];

  const orders: EngineOrder[] =
    realOrders.length > 0
      ? realOrders
      : activePos
        ? [
            {
              id: `tp-${coin.symbol}`,
              source: "algo",
              kind: "takeProfit",
              symbol: coin.symbol,
              side: activePos.side === "long" ? "sell" : "buy",
              type: "TAKE_PROFIT_MARKET",
              status: "NEW",
              stopPrice: activePos.takeProfitPrice,
              qty: activePos.qty,
              reduceOnly: true,
              closePosition: true,
            },
            {
              id: `sl-${coin.symbol}`,
              source: "algo",
              kind: "stop",
              symbol: coin.symbol,
              side: activePos.side === "long" ? "sell" : "buy",
              type: "STOP_MARKET",
              status: "NEW",
              stopPrice: activePos.stopPrice,
              qty: activePos.qty,
              reduceOnly: true,
              closePosition: true,
            },
          ]
        : [];

  return {
    entries,
    orders,
    isSimulated: realEntries.length === 0 && realOrders.length === 0,
  };
}
