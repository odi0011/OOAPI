import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { NumberField } from "@/components/arc/number-field/number-field";
import { Select } from "@/components/arc/select/select";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import AdminLayout from "@/components/admin/AdminLayout";
import { useNotify } from "@/lib/useNotify";

import { useExchangeKeys, type ExchangeKey } from "./exchangeKeyStore";
import sectionStyles from "./sections/Section.module.css";
import styles from "./AdminTrading.module.css";

/**
 * 自动交易策略壳。
 *
 * 首发只启用「XRPUSDT + 逐仓 ≤3x + 短周期 EMA」。
 * 网格 / 布林 / DCA 先留切换入口，标明「本金够再开」。
 *
 * 持久化字段与验收一致：
 * symbol, leverage, marginMode, emaFast, emaSlow, timeframe,
 * stopR, takeProfitR, dailyLossPct, maxMarginUsdt, exchangeKeyId, mode.
 *
 * TODO(trading): 后端还没有这些字段。
 * 保存只记在本机，不请求计费、不改 CORS、不下单。
 * 接通后改为 apiRequest("/api/trading/strategy")。
 */

const STORAGE_KEY = "ooapi_trading_strategy_v2";

const TIMEFRAMES = ["1m", "3m", "5m", "15m"] as const;

interface StrategyDraft {
  strategy: "ema";
  symbol: "XRPUSDT";
  leverage: number;
  marginMode: "isolated";
  emaFast: number;
  emaSlow: number;
  timeframe: (typeof TIMEFRAMES)[number];
  stopR: number;
  takeProfitR: number;
  dailyLossPct: number;
  maxMarginUsdt: number;
  exchangeKeyId: string;
  mode: "testnet" | "live";
}

const DEFAULT_DRAFT: StrategyDraft = {
  strategy: "ema",
  symbol: "XRPUSDT",
  leverage: 3,
  marginMode: "isolated",
  emaFast: 9,
  emaSlow: 21,
  timeframe: "5m",
  stopR: 1,
  takeProfitR: 1.5,
  dailyLossPct: 4,
  maxMarginUsdt: 1.7,
  exchangeKeyId: "",
  mode: "testnet",
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
    const timeframe = TIMEFRAMES.find((item) => item === parsed.timeframe) ?? DEFAULT_DRAFT.timeframe;
    return {
      strategy: "ema",
      symbol: "XRPUSDT",
      marginMode: "isolated",
      leverage: clamp(Number(parsed.leverage), 1, 3, DEFAULT_DRAFT.leverage),
      timeframe,
      emaFast: clamp(Number(parsed.emaFast), 2, 50, DEFAULT_DRAFT.emaFast),
      emaSlow: clamp(Number(parsed.emaSlow), 3, 200, DEFAULT_DRAFT.emaSlow),
      stopR: clamp(Number(parsed.stopR), 0.1, 20, DEFAULT_DRAFT.stopR),
      takeProfitR: clamp(Number(parsed.takeProfitR), 0.1, 20, DEFAULT_DRAFT.takeProfitR),
      dailyLossPct: clamp(Number(parsed.dailyLossPct), 0.1, 100, DEFAULT_DRAFT.dailyLossPct),
      maxMarginUsdt: clamp(Number(parsed.maxMarginUsdt), 0.1, 100, DEFAULT_DRAFT.maxMarginUsdt),
      exchangeKeyId: typeof parsed.exchangeKeyId === "string" ? parsed.exchangeKeyId : "",
      mode: parsed.mode === "live" ? "live" : "testnet",
    };
  } catch {
    return DEFAULT_DRAFT;
  }
}

function validate(draft: StrategyDraft, keys: ExchangeKey[]): string | null {
  if (draft.symbol !== "XRPUSDT") return "首发交易对只支持 XRPUSDT";
  if (draft.marginMode !== "isolated") return "首发只允许逐仓";
  if (!Number.isInteger(draft.leverage) || draft.leverage < 1 || draft.leverage > 3) {
    return "杠杆必须是 1 到 3 的整数";
  }
  if (draft.stopR <= 0 || draft.takeProfitR <= 0) return "每单止损和止盈都必填";
  if (draft.dailyLossPct <= 0 || draft.dailyLossPct > 100) return "日亏停机阈值要大于 0";
  if (draft.maxMarginUsdt <= 0) return "单笔保证金上限要大于 0";
  if (draft.emaFast >= draft.emaSlow) return "快线周期要小于慢线";
  if (draft.mode !== "testnet" && draft.mode !== "live") return "环境只能是测网或实盘";
  const bound = keys.some((key) => key.id === draft.exchangeKeyId && !key.revoked);
  if (!bound) return "请先绑定一把未作废的交易所密钥";
  return null;
}

export default function AdminTrading() {
  const notify = useNotify();
  const keys = useExchangeKeys();
  const [draft, setDraft] = useState<StrategyDraft>(loadDraft);
  const [saving, setSaving] = useState(false);
  const [liveGate, setLiveGate] = useState(false);

  const activeKeys = keys.filter((key) => !key.revoked);

  useEffect(() => {
    setDraft((current) => {
      if (!current.exchangeKeyId) return current;
      const alive = keys.some((key) => key.id === current.exchangeKeyId && !key.revoked);
      if (alive) return current;
      return { ...current, exchangeKeyId: "" };
    });
  }, [keys]);

  function patch(partial: Partial<StrategyDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  function onModeChange(next: string) {
    if (next === "live") {
      setLiveGate(true);
      return;
    }
    patch({ mode: "testnet" });
  }

  function confirmLive() {
    patch({ mode: "live" });
    setLiveGate(false);
  }

  function save() {
    const problem = validate(draft, keys);
    if (problem) {
      notify.error("还不能保存", problem);
      return;
    }
    setSaving(true);
    try {
      // TODO(trading): 换成后端字段后删除这段本地草稿。字段名保持验收口径。
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      notify.success("策略已记在本机", "后端字段未就绪，这份配置还不会下发到交易服务。");
    } catch {
      notify.error("没能记在本机", "浏览器禁止了本地存储。配置仍留在当前页面。");
    } finally {
      setSaving(false);
    }
  }

  const live = draft.mode === "live";

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
              测网与实盘只在本页切换。切到实盘前要确认测网全绿。后端还没有 mode 字段，切换不会发请求。
            </p>
          </header>
          <div className={sectionStyles.rows}>
            <div className={sectionStyles.row} data-field="mode">
              <div className={sectionStyles.rowText}>
                <strong>测网 / 实盘</strong>
                <p>切到实盘之前，测网需要全绿。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <SegmentedControl
                  label="交易环境"
                  value={draft.mode}
                  onValueChange={onModeChange}
                  options={[
                    { value: "testnet", label: "测网" },
                    { value: "live", label: "实盘" },
                  ]}
                />
                <p className={live ? styles.envLive : styles.envNote}>
                  {live
                    ? "已标记实盘。请确认当时测网是全绿。当前只改 mode，不会真下单。"
                    : "测网不使用真实资金。点实盘前会先要求确认测网全绿。"}
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

            <div className={sectionStyles.row} data-field="symbol">
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

            <div className={sectionStyles.row} data-field="marginMode">
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

            <div className={sectionStyles.row} data-field="leverage">
              <div className={sectionStyles.rowText}>
                <strong>杠杆</strong>
                <p>逐仓，默认 3 倍，最高 3 倍。</p>
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

            <div className={sectionStyles.row} data-field="timeframe">
              <div className={sectionStyles.rowText}>
                <strong>K 线周期</strong>
                <p>短周期，默认 5 分钟。</p>
              </div>
              <div className={sectionStyles.rowControlInline}>
                <SegmentedControl
                  label="K 线周期"
                  value={draft.timeframe}
                  onValueChange={(timeframe) => {
                    const next = TIMEFRAMES.find((item) => item === timeframe);
                    if (next) patch({ timeframe: next });
                  }}
                  options={TIMEFRAMES.map((item) => ({ value: item, label: item }))}
                />
              </div>
            </div>

            <div className={sectionStyles.row} data-field="emaFast">
              <div className={sectionStyles.rowText}>
                <strong>快线 EMA</strong>
                <p>默认 9，必须小于慢线。</p>
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

            <div className={sectionStyles.row} data-field="emaSlow">
              <div className={sectionStyles.rowText}>
                <strong>慢线 EMA</strong>
                <p>默认 21，必须大于快线。</p>
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

            <div className={sectionStyles.row} data-field="stopR">
              <div className={sectionStyles.rowText}>
                <strong>止损</strong>
                <p>每单必填，按 R 计，默认 1。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="止损"
                  suffix=" R"
                  value={draft.stopR}
                  min={0.1}
                  max={20}
                  step={0.1}
                  onValueChange={(stopR) => patch({ stopR })}
                />
              </div>
            </div>

            <div className={sectionStyles.row} data-field="takeProfitR">
              <div className={sectionStyles.rowText}>
                <strong>止盈</strong>
                <p>每单必填，按 R 计，默认 1.5。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="止盈"
                  suffix=" R"
                  value={draft.takeProfitR}
                  min={0.1}
                  max={20}
                  step={0.1}
                  onValueChange={(takeProfitR) => patch({ takeProfitR })}
                />
              </div>
            </div>

            <div className={sectionStyles.row} data-field="maxMarginUsdt">
              <div className={sectionStyles.rowText}>
                <strong>单笔保证金上限</strong>
                <p>首发默认约 1.6–1.8 USDT。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <NumberField
                  hideLabel
                  label="单笔保证金上限"
                  suffix=" USDT"
                  value={draft.maxMarginUsdt}
                  min={0.1}
                  max={100}
                  step={0.1}
                  onValueChange={(maxMarginUsdt) => patch({ maxMarginUsdt })}
                />
              </div>
            </div>

            <div className={sectionStyles.row} data-field="dailyLossPct">
              <div className={sectionStyles.rowText}>
                <strong>日亏停机阈值</strong>
                <p>当天亏损达到权益的这个比例后停止开新仓，默认 4%。</p>
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

            <div className={sectionStyles.row} data-field="exchangeKeyId">
              <div className={sectionStyles.rowText}>
                <strong>交易所密钥</strong>
                <p>只用还没作废的那一把。</p>
              </div>
              <div className={sectionStyles.rowControl}>
                <Select
                  hideLabel
                  label="交易所密钥"
                  value={draft.exchangeKeyId}
                  placeholder="请先绑定密钥"
                  options={activeKeys.map((key) => ({ value: key.id, label: key.name }))}
                  onValueChange={(exchangeKeyId) => patch({ exchangeKeyId })}
                  disabled={activeKeys.length === 0}
                />
                <p className={styles.keyHint}>
                  {activeKeys.length === 0 ? "当前没有可使用的密钥。" : "作废的旧 Key 不会出现在这里。"}
                  <Link to="/admin/exchange-keys">去绑定</Link>
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>

      <Dialog open={liveGate} onOpenChange={setLiveGate}>
        <DialogContent
          title="切到实盘前先看测网"
          description="mode 标成 live 之前，测网需要全绿。未全绿就标过去，也只是改了本页，仍然不会真下单。"
        >
          <p className={styles.gateCopy}>请确认测网检查都已通过，再标记为实盘。</p>
          <div className={styles.dialogActions}>
            <Button variant="secondary" size="sm" onClick={() => setLiveGate(false)}>
              留在测网
            </Button>
            <Button variant="primary" size="sm" onClick={confirmLive}>
              测网已全绿，标记实盘
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
