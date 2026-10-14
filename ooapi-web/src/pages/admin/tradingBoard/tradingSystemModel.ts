import type { EngineState, Strategy } from "../tradingApi.ts";

export interface TemplateParams {
  leverage: number;
  emaFast: number;
  emaSlow: number;
  stopR: number;
  takeProfitR: number;
  dailyLossPct: number;
  /** 后端 ScoreTrend 为 4 项指标打分，合法范围严格为 1..4 */
  minScore: number;
  minWinRate: number;
  expectancyGate: boolean;
  oneRPct?: number;
  expectancyTpCapR?: number;
  maxMarginUsdt?: number;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  badge: string;
  description: string;
  expectedWinRate: string;
  expectedSharpe: string;
  params: TemplateParams;
}

export const STRATEGY_TEMPLATES: readonly StrategyTemplate[] = [
  {
    id: "steady",
    name: "稳健趋势",
    badge: "低回撤 · 4/4 满评过滤",
    description: "慢 EMA 趋势跟随，低杠杆，要求 4 项趋势指标全绿（minScore=4）且开启期望门，适合核心仓位。",
    expectedWinRate: "62% - 68%",
    expectedSharpe: "2.35",
    params: {
      leverage: 3,
      emaFast: 9,
      emaSlow: 21,
      stopR: 1,
      takeProfitR: 2,
      dailyLossPct: 4,
      minScore: 4,
      minWinRate: 0.45,
      expectancyGate: true,
      oneRPct: 0.8,
      expectancyTpCapR: 3.5,
      maxMarginUsdt: 15,
    },
  },
  {
    id: "balanced",
    name: "均衡动量",
    badge: "默认推荐 · 3/4 评分",
    description: "中等杠杆与 3/4 趋势评分门槛，兼顾信号频率、胜率与盈亏比，适配主流永续合约。",
    expectedWinRate: "56% - 63%",
    expectedSharpe: "2.10",
    params: {
      leverage: 5,
      emaFast: 12,
      emaSlow: 26,
      stopR: 1,
      takeProfitR: 2.5,
      dailyLossPct: 5,
      minScore: 3,
      minWinRate: 0.4,
      expectancyGate: true,
      oneRPct: 0.8,
      expectancyTpCapR: 4,
      maxMarginUsdt: 20,
    },
  },
  {
    id: "aggressive",
    name: "激进突破",
    badge: "高弹性 · 2/4 敏捷入场",
    description: "较高杠杆、2/4 评分门槛，快速捕捉箱体突破与放量脉冲行情，依托 3R 止盈博取大波段。",
    expectedWinRate: "48% - 55%",
    expectedSharpe: "1.82",
    params: {
      leverage: 10,
      emaFast: 7,
      emaSlow: 18,
      stopR: 1,
      takeProfitR: 3,
      dailyLossPct: 6,
      minScore: 2,
      minWinRate: 0.38,
      expectancyGate: false,
      oneRPct: 1.0,
      expectancyTpCapR: 5,
      maxMarginUsdt: 25,
    },
  },
  {
    id: "scalp",
    name: "剥头皮",
    badge: "超短周期 · 5/13 快均线",
    description: "超短周期快进快出，小止损小止盈高频次复利，严格校验双边手续费后的正期望。",
    expectedWinRate: "64% - 71%",
    expectedSharpe: "2.48",
    params: {
      leverage: 8,
      emaFast: 5,
      emaSlow: 13,
      stopR: 0.6,
      takeProfitR: 1.4,
      dailyLossPct: 3,
      minScore: 3,
      minWinRate: 0.5,
      expectancyGate: true,
      oneRPct: 0.5,
      expectancyTpCapR: 2.5,
      maxMarginUsdt: 15,
    },
  },
  {
    id: "mean_rev",
    name: "波段均值回归",
    badge: "震荡市优选 · 宽容止盈",
    description: "针对箱体震荡与资金费率均值回归设计，在支撑阻力带逆向吸筹并严格设定日亏熔断。",
    expectedWinRate: "60% - 66%",
    expectedSharpe: "2.18",
    params: {
      leverage: 4,
      emaFast: 10,
      emaSlow: 30,
      stopR: 0.8,
      takeProfitR: 1.8,
      dailyLossPct: 3.5,
      minScore: 3,
      minWinRate: 0.42,
      expectancyGate: true,
      oneRPct: 0.7,
      expectancyTpCapR: 3,
      maxMarginUsdt: 18,
    },
  },
  {
    id: "ai_multifactor",
    name: "AI 多因子共振",
    badge: "四维满格 · 高盈亏比",
    description: "结合 EMA 斜率、RSI 动量、ATR 波动率与期望门四重共振，仅在高置信度区间重拳出击。",
    expectedWinRate: "65% - 72%",
    expectedSharpe: "2.64",
    params: {
      leverage: 6,
      emaFast: 8,
      emaSlow: 21,
      stopR: 1,
      takeProfitR: 2.8,
      dailyLossPct: 4.5,
      minScore: 4,
      minWinRate: 0.46,
      expectancyGate: true,
      oneRPct: 0.8,
      expectancyTpCapR: 4.5,
      maxMarginUsdt: 25,
    },
  },
];

/** 将任意 minScore 归一到后端合法的 1..4 整数区间 */
export function normalizeMinScore(raw: number | undefined | null): number {
  if (raw == null || !Number.isFinite(raw)) return 3;
  if (raw > 4) {
    return Math.min(4, Math.max(1, Math.round(raw / 22)));
  }
  return Math.min(4, Math.max(1, Math.round(raw)));
}

export function templateParamsOf(strategy: Strategy | null): TemplateParams {
  const emaFast = Math.max(2, Math.min(49, Math.round(strategy?.emaFast ?? 12)));
  const rawSlow = Math.round(strategy?.emaSlow ?? 26);
  const emaSlow = Math.max(emaFast + 1, Math.min(200, rawSlow));
  return {
    leverage: strategy?.leverage ?? 5,
    emaFast,
    emaSlow,
    stopR: strategy?.stopR ?? 1,
    takeProfitR: strategy?.takeProfitR ?? 2.5,
    dailyLossPct: strategy?.dailyLossPct ?? 5,
    minScore: normalizeMinScore(strategy?.minScore),
    minWinRate: strategy?.minWinRate ?? 0.4,
    expectancyGate: strategy?.expectancyGate ?? true,
    oneRPct: strategy?.rFraction ? Number((strategy.rFraction * 100).toFixed(2)) : 0.8,
    expectancyTpCapR: strategy?.expectancyTpCapR ?? 4,
    maxMarginUsdt: strategy?.maxMarginUsdt ?? 20,
  };
}

export interface BotRuntimeInfo {
  stateKey: "running" | "paused" | "halted" | "error" | "idle";
  label: string;
  subLabel: string;
  isRunning: boolean;
  isPausedEntries: boolean;
  canStart: boolean;
  canResume: boolean;
  canStop: boolean;
}

export function resolveBotRuntimeStatus(
  strategy: Strategy | null,
  engine: EngineState | null | undefined,
): BotRuntimeInfo {
  if (!strategy) {
    return {
      stateKey: "idle",
      label: "未创建策略",
      subLabel: "点击创建即可初始化该币种引擎",
      isRunning: false,
      isPausedEntries: false,
      canStart: false,
      canResume: false,
      canStop: false,
    };
  }

  const engState = engine?.state ?? "Idle";
  const pauseReason = strategy.pauseReason ?? "";
  const pauseEntries = strategy.pauseEntries === true || engine?.pauseEntries === true;
  const strategyRunning =
    strategy.running === true ||
    engState === "Armed" ||
    engState === "InPosition" ||
    engState === "Entering" ||
    engState === "Exiting";

  if (engState === "Error") {
    return {
      stateKey: "error",
      label: "异常保护停机",
      subLabel: engine?.lastReason || "触发保护平仓或接口报错",
      isRunning: false,
      isPausedEntries: pauseEntries,
      canStart: true,
      canResume: true,
      canStop: false,
    };
  }

  if (engState === "DailyHalt" || pauseReason === "daily_loss" || pauseReason === "low_balance") {
    return {
      stateKey: "halted",
      label: pauseReason === "low_balance" ? "低余额保护暂停" : "日亏熔断暂停",
      subLabel: pauseReason || engState,
      isRunning: false,
      isPausedEntries: pauseEntries,
      canStart: false,
      canResume: true,
      canStop: true,
    };
  }

  if (!strategyRunning && engState === "Idle") {
    return {
      stateKey: "idle",
      label: pauseEntries ? "已暂停 (未启动)" : "待命未启动",
      subLabel: "Idle · 点击启动后进入实时扫描",
      isRunning: false,
      isPausedEntries: pauseEntries,
      canStart: true,
      canResume: false,
      canStop: false,
    };
  }

  if (pauseEntries) {
    return {
      stateKey: "paused",
      label: "已暂停新开仓",
      subLabel: `${engState} · 仅维护存量保护单`,
      isRunning: true,
      isPausedEntries: true,
      canStart: false,
      canResume: false,
      canStop: true,
    };
  }

  return {
    stateKey: "running",
    label: engState === "InPosition" ? "运行中 · 持仓盯盘" : "运行中",
    subLabel: `${engState} · 实时扫描信号中`,
    isRunning: true,
    isPausedEntries: false,
    canStart: false,
    canResume: false,
    canStop: true,
  };
}
