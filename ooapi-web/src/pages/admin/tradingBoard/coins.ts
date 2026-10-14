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
  /**
    推荐默认持仓数量。

    这里**故意不再有** 24h 涨跌幅、成交量、持仓量、资金费率、市值、
    多因子评分这些字段 —— 它们曾经是写死的常量，页面上却显示成实时行情，
    最严重时用「实时价 ÷ 几周前的旧开盘价」算出 -42% 的假跌幅。

    现在这些数字全部来自后端：
      · 24h 统计（涨跌幅/成交量/高低）→ EngineMarket.quote（交易所公开接口）
      · 多因子评分 → EngineMarket.factors（从真实 K 线算出）
    后端给不出时不显示 —— 「没有数据」比「编一个数」诚实。
  */
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
    defaultQty: 50,
  };
}

/* --------------------- 毫秒级终端仿真流与兜底快照合成器 --------------------- */

export function roundToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

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
  // markPrice 是入参（来自后端真实标记价）。没有就不画仓位列，不用别的数顶替。
  const liveMark = markPrice > 0 ? markPrice : 0;

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

  /*
    3. 图表持仓预览线（用户显式开启才画）。

    这是**用户自己要求**的沙盘：在图上按当前标记价假设一条持仓线，
    用来比划止损止盈位置。它不来自任何账户，所以必须
    （a）由 previewEnabled 开关控制、（b）标记 isSimulated=true
    让界面显示「预览」字样 —— 否则会被误当成真实持仓。
  */
  if (!previewEnabled || liveMark <= 0) return null;

  // 方向按用户语义取「顺势」：标记价高于入场示意价就算多，
  // 不看涨跌幅（那是行情属性，不是持仓属性）。
  const isLong = true;
  const entry = roundToPrecision(liveMark * (isLong ? 0.9935 : 1.0065), coin.precision);
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
 * 总余额快照。
 *
 * **只用后端返回的真实数据。** 早先这里在没有真实账户时会返回一整套
 * 编造的演示组合（钱包 24680、今日 +486.4、三条假持仓、36 点假净值曲线），
 * 页面上显示得像真账户 —— 用户可能据此判断「我有多少钱、该不该下单」。
 * 交易页上的余额必须是可追溯的真实值，拿不到就不显示。
 */
export function buildEffectiveBalance(
  realBalance: EngineBalance | null,
): EngineBalance | null {
  return realBalance;
}

export interface RichDecisionRecord extends DetectionEvent {
  id: string;
  symbol: string;
  side: "long" | "short";
  score: number;
  winrate: number;
  confidence: number;
  regime: string;
  priceAtSignal: number;
  klineIndex: number;
}

/**
 * 决策记录（来自后端事件）。
 *
 * 事件为空就返回空数组 —— **不再编造模板记录**。
 * 早先这里在没有事件时会造出几条「SIGNAL_ENTRY 评分 3.8 / 胜率 64.2%」
 * 之类的假决策（连入场理由、EMA 数值、止盈倍数都是写死的），
 * 页面上看着像系统真的做出过这些判断，属于最不该出现在交易页的欺骗。
 */
export function buildRichDecisionRecords(
  coin: CoinInfo,
  realEvents: DetectionEvent[],
  klines: readonly EngineKline[],
): RichDecisionRecord[] {
  const len = klines.length;
  const fallbackPrice = klines[len - 1]?.close ?? 0;

  return realEvents.slice(-30).reverse().map((ev, idx) => {
    const kIdx = Math.max(0, len - 1 - idx * 3);
    const barPrice = klines[kIdx]?.close ?? fallbackPrice;
    const score = ev.score ?? 0;
    const winrate = ev.winrate != null ? (ev.winrate <= 1 ? ev.winrate * 100 : ev.winrate) : 0;
    return {
      ...ev,
      id: `real-${ev.ts}-${idx}`,
      symbol: ev.symbol ?? coin.symbol,
      side: ev.side === "short" ? "short" : "long",
      score,
      winrate,
      confidence: Math.min(98, Math.round(score * 22 + winrate * 0.2)),
      regime: score >= 3.5 ? "强势单边趋势" : score >= 3.0 ? "动量确认扩张" : "震荡收敛观察",
      priceAtSignal: barPrice,
      klineIndex: kIdx,
    };
  });
}

/**
 * 成交与委托列表。
 *
 * **只用后端数据**：早先在没有记录时会编造「14 分钟前开多、净 R 6.8、
 * 期望 0.72R」这类看起来极其可信的成交，以及一笔不存在的止盈委托。
 * 交易页上的成交记录必须来自交易所，编不出来就是空的。
 */
export function buildEffectiveHistoryAndOrders(
  realEntries: TradeEntry[],
  realOrders: EngineOrder[],
): { entries: TradeEntry[]; orders: EngineOrder[] } {
  return { entries: realEntries, orders: realOrders };
}
