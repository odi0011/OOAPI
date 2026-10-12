import { useState } from "react";

import { Button } from "@/components/arc/button/button";
import { NumberField } from "@/components/arc/number-field/number-field";
import { Select } from "@/components/arc/select/select";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import AdminLayout from "@/components/admin/AdminLayout";
import { useNotify } from "@/lib/useNotify";

import sectionStyles from "./sections/Section.module.css";
import styles from "./AdminTrading.module.css";

/**
 * 自动交易策略壳。
 *
 * 首发只启用「XRPUSDT + 逐仓 ≤3x + 短周期 EMA」。
 * 网格 / 布林 / DCA 先留切换入口，标明「本金够再开」。
 *
 * TODO(trading): 后端还没有策略与环境字段。
 * 保存只记在本机，不请求计费、不改 CORS、不下单。
 * 接通后改为 apiRequest("/api/trading/strategy")。
 */

const STORAGE_KEY = "ooapi_trading_strategy_draft";

const INTERVALS = ["1m", "3m", "5m", "15m"] as const;

interface StrategyDraft {
  strategy: "ema";
  symbol: "XRPUSDT";
  marginMode: "isolated";
  leverage: number;
  interval: (typeof INTERVALS)[number];
  emaFast: number;
  emaSlow: number;
  stopLossPct: number;
  takeProfitPct: number;
  positionPct: number;
  dailyLossPct: number;
  /** 测网 / 实盘。只影响本页，等后端环境字段。 */
  env: "testnet" | "live";
}

const DEFAULT_DRAFT: StrategyDraft = {
  strategy: "ema",
  symbol: "XRPUSDT",
  marginMode: "isolated",
  leverage: 2,
  interval: "5m",
  emaFast: 9,
  emaSlow: 21,
  stopLossPct: 1.5,
  takeProfitPct: 3,
  positionPct: 10,
  dailyLossPct: 5,
  env: "testnet",
};

/** 可切换，但除 EMA 外都先禁用。 */
const STRATEGIES: { id: string; label: string; enabled: boolean }[] = [
  { id: "ema", label: "短周期 EMA 趋势", enabled: true },
  { id: "grid", label: "网格", enabled: false },
  { id: "boll", label: "布林", enabled: false },
  { id: "dca", label: "DCA", enabled: false },
];

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function loadDraft(): StrategyDraft {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DRAFT;
    const parsed = JSON.parse(raw) as Partial<StrategyDraft>;
    const interval = INTERVALS.find((item) => item === parsed.interval) ?? DEFAULT_DRAFT.interval;
    return {
      strategy: "ema",
      symbol: "XRPUSDT",
      marginMode: "isolated",
      leverage: clamp(Number(parsed.leverage), 1, 3, DEFAULT_DRAFT.leverage),
      interval,
      emaFast: clamp(Number(parsed.emaFast), 2, 50, DEFAULT_DRAFT.emaFast),
      emaSlow: clamp(Number(parsed.emaSlow), 3, 200, DEFAULT_DRAFT.emaSlow),
      stopLossPct: clamp(Number(parsed.stopLossPct), 0.1, 100, DEFAULT_DRAFT.stopLossPct),
      takeProfitPct: clamp(Number(parsed.takeProfitPct), 0.1, 100, DEFAULT_DRAFT.takeProfitPct),
      positionPct: clamp(Number(parsed.positionPct), 1, 100, DEFAULT_DRAFT.positionPct),
      dailyLossPct: clamp(Number(parsed.dailyLossPct), 0.1, 100, DEFAULT_DRAFT.dailyLossPct),
      env: parsed.env === "live" ? "live" : "testnet",
    };
  } catch {
    return DEFAULT_DRAFT;
  }
}

function validate(draft: StrategyDraft): string | null {
  if (draft.symbol !== "XRPUSDT") return "首发交易对只支持 XRPUSDT";
  if (draft.marginMode !== "isolated") return "首发只允许逐仓";
  if (!Number.isInteger(draft.leverage) || draft.leverage < 1 || draft.leverage > 3) {
    return "杠杆必须是 1 到 3 的整数";
  }
  if (draft.stopLossPct <= 0 || draft.takeProfitPct <= 0) return "每单止损和止盈都必填";
  if (draft.positionPct <= 0 || draft.positionPct > 100) return "单笔本金比例要在 1% 到 100% 之间";
  if (draft.dailyLossPct <= 0 || draft.dailyLossPct > 100) return "日亏停机阈值要大于 0";
  if (draft.emaFast >= draft.emaSlow) return "快线周期要小于慢线";
  return null;
}

export default function AdminTrading() {
  const notify = useNotify();
  const [draft, setDraft] = useState<StrategyDraft>(loadDraft);
  const [saving, setSaving] = useState(false);

  function patch(partial: Partial<StrategyDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  function save() {
    const problem = validate(draft);
    if (problem) {
      notify.error("还不能保存", problem);
      return;
    }
    setSaving(true);
    try {
      // TODO(trading): 换成后端字段后删除这段本地草稿。
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      notify.success("策略已记在本机", "后端字段未就绪，这份配置还不会下发到交易服务。");
    } catch {
      notify.error("没能记在本机", "浏览器禁止了本地存储。配置仍留在当前页面。");
    } finally {
      setSaving(false);
    }
  }

  const live = draft.env === "live";

  return (
    <AdminLayout
      crumbs={[{ label: "后台", href: "/admin" }, { label: "策略配置" }]}
      actions={
        <Button variant="primary" size="sm" loading={saving} onClick={save}>
          保存配置
        </Button>
      }
    >
      <div className={styles.page}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.title}>策略配置</h1>
            <p className={styles.lead}>
              首发只做 XRPUSDT 的短周期 EMA 趋势，逐仓，杠杆不超过 3 倍。每单都要填止损和止盈。
            </p>
          </div>
        </header>

        <section className={styles.block}>
          <header className={sectionStyles.sectionHead}>
            <h2 className={sectionStyles.sectionTitle}>交易环境</h2>
            <p className={sectionStyles.sectionLead}>
              测网与实盘只在本页切换。后端还没有环境字段，切换不会发请求。
            </p>
          </header>
          <div className={sectionStyles.rows}>
            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>测网 / 实盘</strong>
                <p>测网用于试跑。切到实盘只改变这里的标记，不会真下单。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <SegmentedControl
                  label="交易环境"
                  value={draft.env}
                  onValueChange={(env) => patch({ env: env === "live" ? "live" : "testnet" })}
                  options={[
                    { value: "testnet", label: "测网" },
                    { value: "live", label: "实盘" },
                  ]}
                />
                <p className={live ? styles.envLive : styles.envNote}>
                  {live
                    ? "实盘会动用真实资金。当前只是界面开关，下单接口还没接。"
                    : "测网不使用真实资金。等后端环境字段接通后才会生效。"}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.block}>
          <header className={sectionStyles.sectionHead}>
            <h2 className={sectionStyles.sectionTitle}>策略</h2>
            <p className={sectionStyles.sectionLead}>
              网格、布林、DCA 的入口先留着，本金够再开。现在只能选短周期 EMA。
            </p>
          </header>

          <div className={sectionStyles.rows}>
            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>策略类型</strong>
                <p>点选切换。灰掉的项还不能启用。</p>
              </div>
              <div className={sectionStyles.rowControlInline}>
                <div className={styles.choices} role="group" aria-label="策略类型">
                  {STRATEGIES.map((item) => {
                    const active = item.enabled && draft.strategy === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={active ? `${styles.choice} ${styles.choiceOn}` : styles.choice}
                        aria-pressed={item.enabled ? active : undefined}
                        disabled={!item.enabled}
                        title={item.enabled ? undefined : "本金够再开"}
                        onClick={() => {
                          if (item.enabled) patch({ strategy: "ema" });
                        }}
                      >
                        {item.enabled ? item.label : `${item.label} · 本金够再开`}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>交易对</strong>
                <p>首发固定 XRPUSDT。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <Select
                  hideLabel
                  label="交易对"
                  value={draft.symbol}
                  options={[{ value: "XRPUSDT", label: "XRPUSDT" }]}
                  onValueChange={() => patch({ symbol: "XRPUSDT" })}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>保证金模式</strong>
                <p>首发只允许逐仓。全仓先禁用。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <Select
                  hideLabel
                  label="保证金模式"
                  value={draft.marginMode}
                  options={[
                    { value: "isolated", label: "逐仓" },
                    { value: "cross", label: "全仓", disabled: true },
                  ]}
                  onValueChange={(marginMode) => {
                    if (marginMode === "isolated") patch({ marginMode: "isolated" });
                  }}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>杠杆</strong>
                <p>逐仓，最高 3 倍。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="杠杆"
                  suffix=" 倍"
                  value={draft.leverage}
                  min={1}
                  max={3}
                  step={1}
                  limitHint={(edge) => (edge === "max" ? "最高 3 倍" : "至少 1 倍")}
                  onValueChange={(leverage) => patch({ leverage: Math.round(leverage) })}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>K 线周期</strong>
                <p>短周期趋势，只放到 15 分钟。</p>
              </div>
              <div className={sectionStyles.rowControlInline}>
                <SegmentedControl
                  label="K 线周期"
                  value={draft.interval}
                  onValueChange={(interval) => {
                    const next = INTERVALS.find((item) => item === interval);
                    if (next) patch({ interval: next });
                  }}
                  options={INTERVALS.map((item) => ({ value: item, label: item }))}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>快线 EMA</strong>
                <p>短周期均线。必须小于慢线。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="快线 EMA"
                  suffix=" 根"
                  value={draft.emaFast}
                  min={2}
                  max={50}
                  step={1}
                  onValueChange={(emaFast) => patch({ emaFast: Math.round(emaFast) })}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>慢线 EMA</strong>
                <p>趋势过滤。必须大于快线。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="慢线 EMA"
                  suffix=" 根"
                  value={draft.emaSlow}
                  min={3}
                  max={200}
                  step={1}
                  onValueChange={(emaSlow) => patch({ emaSlow: Math.round(emaSlow) })}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>止损</strong>
                <p>每单必填，按本笔本金的百分比。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="止损"
                  suffix=" %"
                  value={draft.stopLossPct}
                  min={0.1}
                  max={100}
                  step={0.1}
                  onValueChange={(stopLossPct) => patch({ stopLossPct })}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>止盈</strong>
                <p>每单必填，按本笔本金的百分比。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="止盈"
                  suffix=" %"
                  value={draft.takeProfitPct}
                  min={0.1}
                  max={100}
                  step={0.1}
                  onValueChange={(takeProfitPct) => patch({ takeProfitPct })}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>单笔本金比例</strong>
                <p>每一单占用账户权益的比例。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="单笔本金比例"
                  suffix=" %"
                  value={draft.positionPct}
                  min={1}
                  max={100}
                  step={1}
                  onValueChange={(positionPct) => patch({ positionPct: Math.round(positionPct) })}
                />
              </div>
            </div>

            <div className={sectionStyles.row}>
              <div className={sectionStyles.rowText}>
                <strong>日亏停机阈值</strong>
                <p>当天亏损达到权益的这个比例后，停止开新仓。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="日亏停机阈值"
                  suffix=" %"
                  value={draft.dailyLossPct}
                  min={0.1}
                  max={100}
                  step={0.1}
                  onValueChange={(dailyLossPct) => patch({ dailyLossPct })}
                />
              </div>
            </div>
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
