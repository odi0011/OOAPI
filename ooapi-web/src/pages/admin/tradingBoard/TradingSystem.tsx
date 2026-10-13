/**
 * 交易系统模块：决策模板、决策调参、自动化开关、网格策略配置、交易机器人列表。
 * 模板与调参为本地草稿（UI 标注），自动化开关与机器人启停走真实接口。
 */
import { useState } from "react";

import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";

import CoinIcon from "./CoinIcon";
import { coinInfoOf } from "./coins";
import type { EngineState, Strategy } from "../tradingApi";
import { networkLabel } from "../tradingApi";

import styles from "../TradingBoard.module.css";

/* ---------------------------------- 决策模板 ---------------------------------- */

export interface TemplateParams {
  leverage: number;
  emaFast: number;
  emaSlow: number;
  stopR: number;
  takeProfitR: number;
  dailyLossPct: number;
  minScore: number;
  minWinRate: number;
  expectancyGate: boolean;
}

interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
  params: TemplateParams;
}

export const STRATEGY_TEMPLATES: readonly StrategyTemplate[] = [
  {
    id: "steady",
    name: "稳健趋势",
    description: "慢 EMA 趋势跟随，低杠杆，严格期望门，适合震荡偏弱市。",
    params: { leverage: 3, emaFast: 9, emaSlow: 21, stopR: 1, takeProfitR: 2, dailyLossPct: 4, minScore: 70, minWinRate: 0.45, expectancyGate: true },
  },
  {
    id: "balanced",
    name: "均衡动量",
    description: "中等杠杆与评分门槛，兼顾胜率与盈亏比，默认推荐。",
    params: { leverage: 5, emaFast: 12, emaSlow: 26, stopR: 1, takeProfitR: 2.5, dailyLossPct: 5, minScore: 65, minWinRate: 0.4, expectancyGate: true },
  },
  {
    id: "aggressive",
    name: "激进突破",
    description: "高杠杆、低评分门槛，捕捉突破行情，回撤较大请谨慎。",
    params: { leverage: 10, emaFast: 7, emaSlow: 14, stopR: 1, takeProfitR: 3, dailyLossPct: 6, minScore: 55, minWinRate: 0.35, expectancyGate: false },
  },
  {
    id: "scalp",
    name: "剥头皮",
    description: "超短周期快进快出，小止盈高频次，依赖低手续费环境。",
    params: { leverage: 8, emaFast: 5, emaSlow: 10, stopR: 0.5, takeProfitR: 1, dailyLossPct: 3, minScore: 60, minWinRate: 0.5, expectancyGate: true },
  },
];

export function templateParamsOf(strategy: Strategy | null): TemplateParams {
  return {
    leverage: strategy?.leverage ?? 5,
    emaFast: strategy?.emaFast ?? 12,
    emaSlow: strategy?.emaSlow ?? 26,
    stopR: strategy?.stopR ?? 1,
    takeProfitR: strategy?.takeProfitR ?? 2.5,
    dailyLossPct: strategy?.dailyLossPct ?? 5,
    minScore: strategy?.minScore ?? 65,
    minWinRate: strategy?.minWinRate ?? 0.4,
    expectancyGate: strategy?.expectancyGate ?? true,
  };
}

interface TemplatesProps {
  onApply: (params: TemplateParams, name: string) => void;
  activeId: string | null;
}

export function StrategyTemplates({ onApply, activeId }: TemplatesProps) {
  return (
    <div>
      <p className={styles.mockNote}>
        <span className={styles.mockBadge}>预设模板</span>
        点击应用后填入下方调参区（本地草稿），不会直接修改线上策略。
      </p>
      <div className={styles.templateGrid}>
        {STRATEGY_TEMPLATES.map((template) => (
          <div key={template.id} className={`${styles.templateCard} ${activeId === template.id ? styles.templateActive : ""}`}>
            <strong className={styles.templateName}>{template.name}</strong>
            <p className={styles.templateDesc}>{template.description}</p>
            <dl className={styles.templateParams}>
              <div><dt>杠杆</dt><dd>{template.params.leverage}x</dd></div>
              <div><dt>EMA</dt><dd>{template.params.emaFast}/{template.params.emaSlow}</dd></div>
              <div><dt>止盈止损</dt><dd>{template.params.takeProfitR}R / {template.params.stopR}R</dd></div>
            </dl>
            <Button variant="secondary" size="sm" onClick={() => onApply(template.params, template.name)}>
              应用模板
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- 决策调参 ---------------------------------- */

interface TunerProps {
  draft: TemplateParams;
  onChange: (next: TemplateParams) => void;
  templateName: string | null;
}

function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.sliderRow}>
      <span className={styles.sliderLabel}>
        {props.label}
        <strong>{props.value}{props.unit ?? ""}</strong>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className={styles.slider}
      />
    </label>
  );
}

export function ParamTuner({ draft, onChange, templateName }: TunerProps) {
  const set = (patch: Partial<TemplateParams>) => onChange({ ...draft, ...patch });
  return (
    <div>
      <p className={styles.mockNote}>
        <span className={styles.mockBadge}>本地草稿</span>
        {templateName ? `当前草稿来自模板「${templateName}」` : "拖动滑杆调整参数"}，仅本地预览；正式保存请前往系统设置 → 策略配置。
      </p>
      <div className={styles.tunerGrid}>
        <SliderRow label="杠杆" value={draft.leverage} min={1} max={20} step={1} unit="x" onChange={(leverage) => set({ leverage })} />
        <SliderRow label="快 EMA" value={draft.emaFast} min={3} max={30} step={1} onChange={(emaFast) => set({ emaFast })} />
        <SliderRow label="慢 EMA" value={draft.emaSlow} min={10} max={60} step={1} onChange={(emaSlow) => set({ emaSlow })} />
        <SliderRow label="止损" value={draft.stopR} min={0.5} max={3} step={0.1} unit="R" onChange={(stopR) => set({ stopR })} />
        <SliderRow label="止盈" value={draft.takeProfitR} min={1} max={5} step={0.1} unit="R" onChange={(takeProfitR) => set({ takeProfitR })} />
        <SliderRow label="日亏熔断" value={draft.dailyLossPct} min={1} max={10} step={0.5} unit="%" onChange={(dailyLossPct) => set({ dailyLossPct })} />
        <SliderRow label="最低评分" value={draft.minScore} min={40} max={90} step={1} onChange={(minScore) => set({ minScore })} />
        <SliderRow label="最低胜率" value={draft.minWinRate} min={0.3} max={0.7} step={0.01} onChange={(minWinRate) => set({ minWinRate })} />
      </div>
      <label className={styles.switchRow}>
        <button
          type="button"
          role="switch"
          aria-checked={draft.expectancyGate}
          className={styles.switch}
          data-on={draft.expectancyGate}
          onClick={() => set({ expectancyGate: !draft.expectancyGate })}
        >
          <span />
        </button>
        期望门（期望不为正时跳过开仓）
      </label>
    </div>
  );
}

/* ---------------------------------- 自动化开关 ---------------------------------- */

interface AutomationProps {
  strategy: Strategy | null;
  engine: EngineState | null;
  pauseBusy: boolean;
  onTogglePause: (paused: boolean) => void;
}

export function AutomationPanel({ strategy, engine, pauseBusy, onTogglePause }: AutomationProps) {
  const paused = strategy?.pauseEntries === true;
  return (
    <div className={styles.automation}>
      <div className={styles.automationRow}>
        <div>
          <strong>自动开仓</strong>
          <p>关闭后引擎不再开新仓，已有持仓与止损止盈不受影响。</p>
        </div>
        <label className={styles.switchRow}>
          <button
            type="button"
            role="switch"
            aria-checked={!paused}
            aria-label="自动开仓开关"
            className={styles.switch}
            data-on={!paused}
            disabled={pauseBusy || strategy == null}
            onClick={() => onTogglePause(!paused)}
          >
            <span />
          </button>
          {pauseBusy ? "更新中…" : !paused ? "运行中" : "已暂停"}
        </label>
      </div>
      <dl className={styles.automationMeta}>
        <div><dt>引擎状态</dt><dd>{engine?.state ?? "--"}</dd></div>
        <div><dt>网络</dt><dd>{networkLabel(strategy?.mode ?? engine?.mode ?? "")}</dd></div>
        <div><dt>上次动作</dt><dd>{engine?.lastAction ?? "--"}</dd></div>
        <div><dt>上次原因</dt><dd>{engine?.lastReason ?? "--"}</dd></div>
      </dl>
      <p className={styles.mockNote}>引擎启动 / 停止等高危操作请前往交易台执行，本页仅做状态展示与开仓开关。</p>
    </div>
  );
}

/* ---------------------------------- 网格策略配置 ---------------------------------- */

interface GridForm {
  upper: string;
  lower: string;
  count: string;
  amount: string;
  stopLoss: string;
}

export function GridConfig() {
  const [form, setForm] = useState<GridForm>({ upper: "", lower: "", count: "10", amount: "10", stopLoss: "" });
  const set = (patch: Partial<GridForm>) => setForm((prev) => ({ ...prev, ...patch }));
  return (
    <div>
      <p className={styles.mockNote}>
        <span className={styles.mockBadge}>本地草稿 · 未接入后端</span>
        网格策略配置界面预览，参数仅保存在本地，暂未接入交易引擎。
      </p>
      <div className={styles.gridForm}>
        <label>价格上限（USDT）<Input label="价格上限（USDT）" hideLabel value={form.upper} onChange={(e) => set({ upper: e.target.value })} placeholder="如 70000" inputMode="decimal" /></label>
        <label>价格下限（USDT）<Input label="价格下限（USDT）" hideLabel value={form.lower} onChange={(e) => set({ lower: e.target.value })} placeholder="如 60000" inputMode="decimal" /></label>
        <label>网格数量<Input label="网格数量" hideLabel value={form.count} onChange={(e) => set({ count: e.target.value })} inputMode="numeric" /></label>
        <label>每格金额（USDT）<Input label="每格金额（USDT）" hideLabel value={form.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" /></label>
        <label>网格止损价（USDT，可空）<Input label="网格止损价（USDT，可空）" hideLabel value={form.stopLoss} onChange={(e) => set({ stopLoss: e.target.value })} placeholder="留空表示不设" inputMode="decimal" /></label>
      </div>
      <p className={styles.gridHint}>
        {form.upper && form.lower && Number(form.upper) > Number(form.lower) && Number(form.count) > 0
          ? `每格间距约 ${((Number(form.upper) - Number(form.lower)) / Number(form.count)).toFixed(2)} USDT`
          : "填写上下限与网格数后可预览每格间距。"}
      </p>
    </div>
  );
}

/* ---------------------------------- 交易机器人列表 ---------------------------------- */

interface BotListProps {
  strategies: Strategy[];
  engines: Map<number, EngineState>;
  pauseBusyId: number | null;
  onTogglePause: (strategyId: number, paused: boolean) => void;
}

export function BotList({ strategies, engines, pauseBusyId, onTogglePause }: BotListProps) {
  if (strategies.length === 0) {
    return <p className={styles.emptyText}>暂无交易机器人，先在系统设置里创建策略。</p>;
  }
  return (
    <ul className={styles.botList}>
      {strategies.map((strategy) => {
        const coin = coinInfoOf(strategy.symbol);
        const engine = engines.get(strategy.id);
        const paused = strategy.pauseEntries === true;
        const busy = pauseBusyId === strategy.id;
        return (
          <li key={strategy.id} className={styles.botItem}>
            <CoinIcon icon={coin.icon} color={coin.color} label={coin.name} size={30} />
            <div className={styles.botMeta}>
              <strong>{coin.name} <span className={styles.coinSymbol}>{strategy.symbol}</span></strong>
              <span className={styles.botSub}>
                {networkLabel(strategy.mode)} · {strategy.leverage}x · {strategy.timeframe}
                {engine?.state ? ` · ${engine.state}` : ""}
              </span>
            </div>
            <span className={`${styles.botStatus} ${paused ? styles.botPaused : styles.botRunning}`}>
              {paused ? "已暂停" : "运行中"}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onTogglePause(strategy.id, !paused)}
            >
              {busy ? "更新中…" : paused ? "启动" : "暂停"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
