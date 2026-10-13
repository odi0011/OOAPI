/**
 * 交易数据看板的展示型分区组件：币种选择器、余额首屏、
 * 持仓卡片、参数面板、历史记录、决策记录。
 * 数据全部由父组件传入，这里只做展示与空状态。
 */
import CoinIcon from "./CoinIcon";
import { COINS, coinInfoOf, type CoinInfo } from "./coins";
import type { DetectionEvent, EngineBalance, EnginePosition, Strategy, TradeEntry } from "../tradingApi";
import { formatAmount, sideText } from "../tradingDeskView";

import styles from "../TradingBoard.module.css";

/* ---------------------------------- 币种选择器 ---------------------------------- */

interface CoinSelectorProps {
  value: string;
  onChange: (symbol: string) => void;
  /** 每个币种对应的策略数量（用于展示“有策略”角标） */
  strategyCount?: Record<string, number>;
}

export function CoinSelector({ value, onChange, strategyCount }: CoinSelectorProps) {
  return (
    <section className={styles.panel} aria-label="币种选择">
      <div className={styles.coinList} role="listbox" aria-label="选择币种">
        {COINS.map((coin) => {
          const selected = coin.symbol === value;
          const count = strategyCount?.[coin.symbol] ?? 0;
          return (
            <button
              key={coin.symbol}
              type="button"
              role="option"
              aria-selected={selected}
              className={`${styles.coinItem} ${selected ? styles.coinItemActive : ""}`}
              onClick={() => onChange(coin.symbol)}
            >
              <CoinIcon icon={coin.icon} color={coin.color} label={coin.name} size={30} />
              <span className={styles.coinMeta}>
                <span className={styles.coinNameRow}>
                  <strong className={styles.coinName}>{coin.name}</strong>
                  <span className={styles.coinSymbol}>{coin.symbol}</span>
                  {count > 0 ? <span className={styles.coinBadge}>{count} 策略</span> : null}
                </span>
                <span className={styles.coinDesc}>{coin.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------------------------- 余额首屏 ---------------------------------- */

function toneClass(value: number | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "";
  return value > 0 ? styles.toneUp : styles.toneDown;
}

interface KpiProps {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}

function Kpi({ label, value, sub, tone }: KpiProps) {
  return (
    <div className={styles.kpiCard}>
      <span className={styles.kpiLabel}>{label}</span>
      <strong className={`${styles.kpiValue} ${tone ?? ""}`}>{value}</strong>
      {sub ? <span className={styles.kpiSub}>{sub}</span> : null}
    </div>
  );
}

interface BalanceHeroProps {
  coin: CoinInfo;
  balance: EngineBalance | null;
  loading: boolean;
  error?: string;
}

export function BalanceHero({ coin, balance, loading, error }: BalanceHeroProps) {
  return (
    <section className={styles.panel} aria-label="总余额">
      <header className={styles.panelHeadRow}>
        <div>
          <h2 className={styles.panelTitle}>总余额</h2>
          <p className={styles.panelDesc}>
            {coin.name}（{coin.symbol}）账户总览。钱包、可用与权益来自交易所账户，今日盈亏按上海 0 点起算。
          </p>
        </div>
        <span className={styles.liveDot} aria-label="实时更新中">
          <i />
          实时
        </span>
      </header>

      {error ? (
        <p className={styles.errorBar} role="alert">{error}</p>
      ) : balance == null ? (
        <p className={styles.emptyText}>{loading ? "正在读取账户余额…" : "该币种暂无策略，先在系统设置里创建策略。"}</p>
      ) : (
        <div className={styles.kpiRow}>
          <Kpi label="账户权益" value={`${formatAmount(balance.equity)} USDT`} sub={`钱包 ${formatAmount(balance.wallet)}`} />
          <Kpi label="可用余额" value={`${formatAmount(balance.available)} USDT`} />
          <Kpi
            label="今日盈亏"
            value={`${balance.todayPnl >= 0 ? "+" : ""}${formatAmount(balance.todayPnl)} USDT`}
            sub={Number.isFinite(balance.todayPct) ? `${(balance.todayPct * 100).toFixed(2)}%` : undefined}
            tone={toneClass(balance.todayPnl)}
          />
          <Kpi
            label="持仓浮盈"
            value={`${balance.unrealized >= 0 ? "+" : ""}${formatAmount(balance.unrealized)} USDT`}
            tone={toneClass(balance.unrealized)}
          />
          <Kpi label="保证金占用" value={`${formatAmount(balance.marginUsed)} USDT`} />
        </div>
      )}
    </section>
  );
}

/* ---------------------------------- 持仓卡片 ---------------------------------- */

interface PositionCardProps {
  position: EnginePosition | null;
  coin: CoinInfo;
}

export function PositionCard({ position, coin }: PositionCardProps) {
  if (position == null || !position.open) {
    return (
      <div className={styles.positionCard} data-open="false">
        <span className={styles.positionEmpty}>当前空仓，无持仓标记</span>
      </div>
    );
  }
  const info = coinInfoOf(position.symbol);
  return (
    <div className={styles.positionCard} data-open="true">
      <CoinIcon icon={info.icon} color={info.color} label={info.name} size={22} />
      <span className={styles.positionSide} data-side={position.side}>
        {sideText(position.side)} {Math.abs(position.qty ?? 0)}
      </span>
      <span className={styles.positionMeta}>入场 {position.entryPrice?.toFixed(coin.precision)}</span>
      <span className={styles.positionMeta}>标记 {position.markPrice?.toFixed(coin.precision)}</span>
      <strong className={`${styles.positionPnl} ${toneClass(position.unrealizedPnl)}`}>
        {position.unrealizedPnl != null ? `${position.unrealizedPnl >= 0 ? "+" : ""}${formatAmount(position.unrealizedPnl)}` : "--"}
      </strong>
      <span className={styles.positionMeta}>{position.leverage}x {position.marginMode === "isolated" ? "逐仓" : position.marginMode}</span>
    </div>
  );
}

/* ---------------------------------- 参数面板 ---------------------------------- */

interface ParamPanelProps {
  strategy: Strategy | null;
}

const PARAM_ROWS: Array<{ key: keyof Strategy; label: string; format?: (v: never) => string }> = [
  { key: "leverage", label: "杠杆" },
  { key: "marginMode", label: "保证金模式" },
  { key: "timeframe", label: "K 线周期" },
  { key: "emaFast", label: "快 EMA" },
  { key: "emaSlow", label: "慢 EMA" },
  { key: "stopR", label: "止损（R）" },
  { key: "takeProfitR", label: "止盈（R）" },
  { key: "dailyLossPct", label: "日亏熔断 %" },
  { key: "maxMarginUsdt", label: "最大保证金 USDT" },
  { key: "minScore", label: "最低评分" },
  { key: "minWinRate", label: "最低胜率" },
  { key: "expectancyGate", label: "期望门" },
];

export function ParamPanel({ strategy }: ParamPanelProps) {
  if (strategy == null) {
    return <p className={styles.emptyText}>暂无策略参数。</p>;
  }
  return (
    <dl className={styles.paramGrid}>
      {PARAM_ROWS.map((row) => {
        const raw = strategy[row.key];
        const text =
          raw == null ? "--"
          : typeof raw === "boolean" ? (raw ? "开" : "关")
          : typeof raw === "number" && row.key === "marginMode" ? String(raw)
          : String(raw);
        return (
          <div key={row.key} className={styles.paramItem}>
            <dt>{row.label}</dt>
            <dd>{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/* ---------------------------------- 历史记录 ---------------------------------- */

function formatTime(value?: string): string {
  if (!value) return "--";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface HistoryPanelProps {
  entries: TradeEntry[];
}

export function HistoryPanel({ entries }: HistoryPanelProps) {
  if (entries.length === 0) {
    return <p className={styles.emptyText}>暂无历史开仓记录。</p>;
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>时间</th>
            <th>方向</th>
            <th>入场价</th>
            <th>数量</th>
            <th>评分</th>
            <th>期望 R</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, 50).map((entry, index) => (
            <tr key={`${entry.openedAt}-${entry.entryPrice}-${index}`}>
              <td>{formatTime(entry.openedAt)}</td>
              <td><span data-side={entry.side}>{sideText(entry.side)}</span></td>
              <td className={styles.num}>{entry.entryPrice?.toFixed(4) ?? "--"}</td>
              <td className={styles.num}>{entry.qty ?? "--"}</td>
              <td className={styles.num}>{entry.score?.toFixed(1) ?? "--"}</td>
              <td className={`${styles.num} ${toneClass(entry.expectancyR)}`}>
                {entry.expectancyR != null ? entry.expectancyR.toFixed(2) : "--"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------- 决策记录 ---------------------------------- */

interface DecisionLogPanelProps {
  events: DetectionEvent[];
  enabled: boolean;
}

export function DecisionLogPanel({ events, enabled }: DecisionLogPanelProps) {
  if (!enabled) {
    return <p className={styles.emptyText}>检测事件接口无权限或不可用，决策记录暂不展示。</p>;
  }
  if (events.length === 0) {
    return <p className={styles.emptyText}>暂无决策事件。引擎每次扫描的评分与动作会记录在这里。</p>;
  }
  return (
    <ol className={styles.logList}>
      {events.slice(-30).reverse().map((event, index) => (
        <li key={`${event.ts}-${event.action}-${index}`} className={styles.logItem}>
          <span className={styles.logTime}>{formatTime(event.ts)}</span>
          <span className={styles.logAction}>{event.action ?? "扫描"}</span>
          <span className={styles.logMsg}>{event.msg ?? ""}</span>
          {event.score != null ? <span className={styles.logScore}>评分 {event.score.toFixed(1)}</span> : null}
        </li>
      ))}
    </ol>
  );
}
