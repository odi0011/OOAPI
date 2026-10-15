import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/arc/button/button";

import LightweightEquityChart from "./LightweightEquityChart";
import styles from "./TradingDesk.module.css";
import {
  formatAmount,
  orderKindText,
  orderPriceText,
  sideText,
} from "./tradingDeskView";
import type {
  DetectionEvent,
  EngineBalance,
  EngineOrder,
  EngineOrders,
  PanelPosition,
} from "./tradingApi";

/**
 * 账户实时余额看板：权益大数字、今日盈亏、曲线、检测事件条、持仓标签。
 * 样式跟 TradingDesk 面板一致，不做独立 bento / 玻璃拟态。
 */

interface LiveBalancePanelProps {
  balance: EngineBalance | null;
  loading?: boolean;
  error?: string;
  orders?: EngineOrders | null;
  events?: DetectionEvent[];
  eventsEnabled?: boolean;
  boostUntil?: string;
  boostBusy?: boolean;
  boostError?: string;
  onBoost?: () => void;
  /**
   * rail：窄栏里的紧凑形态 —— 去掉曲线，权益与今日盈亏改竖排，
   * 明细改成一列「名称 / 数值」两栏。工作台左侧用它；
   * 交易台与数据看板用默认的 full，一个字都不变。
   */
  variant?: "full" | "rail";
}

export default function LiveBalancePanel({
  balance,
  loading = false,
  error,
  orders,
  events = [],
  eventsEnabled = false,
  boostUntil = "",
  boostBusy = false,
  boostError,
  onBoost,
  variant = "full",
}: LiveBalancePanelProps) {
  const rail = variant === "rail";
  const countdown = useCountdown(boostUntil);
  const boostDisabled = boostBusy || countdown > 0;
  const protectBySymbol = useMemo(
    () => groupProtectiveOrders(orders?.items ?? [], orders?.symbol),
    [orders],
  );

  return (
    <section className={styles.panel} aria-label="账户余额">
      <header className={styles.panelHead}>
        <h2>{rail ? "账户" : "账户余额"}</h2>
        <p>
          钱包、可用、浮盈与保证金占用来自交易所账户。今日盈亏按上海 0 点起算，含已实现、手续费、资金费与当前浮盈，不含划转。
          {rail ? "" : "曲线默认近 2 小时。"}
        </p>
      </header>

      {balance == null ? (
        <p className={styles.emptyTitle}>{error ?? (loading ? "正在读取账户余额…" : "先保存策略后再看账户余额。")}</p>
      ) : (
        <>
          <div className={rail ? styles.liveHeadRail : styles.liveHead}>
            <div className={styles.liveEquity}>
              <span className={styles.liveEquityLabel}>权益</span>
              <strong className={styles.liveEquityValue}>
                <EquityParts value={balance.equity} />
                <span className={styles.liveEquityUnit}> USDT</span>
              </strong>
            </div>
            <TodayPill pnl={balance.todayPnl} pct={balance.todayPct} src={balance.todaySrc} />
          </div>

          <dl className={rail ? styles.liveMetricsRail : styles.liveMetrics} aria-label="余额明细">
            <Metric label="钱包" value={formatAmount(balance.wallet)} />
            <Metric label="可用" value={formatAmount(balance.available)} />
            <Metric label="浮盈" value={formatAmount(balance.unrealized)} tone={pnlTone(balance.unrealized)} />
            <Metric label="保证金占用" value={formatAmount(balance.marginUsed)} />
            <Metric label="今日已实现" value={formatAmount(balance.todayRealized)} tone={pnlTone(balance.todayRealized)} />
          </dl>

          {/* 曲线只在交易台那块摆得下：拉到窄栏里既看不清也占地方。 */}
          {rail ? null : (
            <div className={styles.chart}>
              {balance.history.length > 0 ? (
                <LightweightEquityChart points={balance.history} markers={balance.markers} />
              ) : (
                <div className={styles.chartEmpty}>
                  <p className={styles.chartTitle}>权益曲线</p>
                  <p>采样会随看板刷新积累，重启服务后从零开始。</p>
                </div>
              )}
            </div>
          )}

          {(eventsEnabled || onBoost) && (
            <div className={styles.liveStrip}>
              {onBoost ? (
                <Button variant="secondary" size="sm" disabled={boostDisabled} onClick={onBoost} aria-label="加速扫描">
                  {countdown > 0 ? `加速 ${formatCountdown(countdown)}` : "加速"}
                </Button>
              ) : null}
              {eventsEnabled ? (
                <div className={styles.eventStrip} aria-label="检测事件">
                  {events.length === 0 ? (
                    <span className={styles.eventEmpty}>暂无检测事件</span>
                  ) : (
                    <div className={styles.eventTrack}>
                      {events.slice(-12).map((ev, index) => (
                        <span key={`${ev.ts}-${ev.action}-${index}`} className={styles.eventItem} title={ev.msg || undefined}>
                          {formatEvent(ev)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
          {boostError ? <p className={styles.readError}>{boostError}</p> : null}

          <div className={styles.positionTags} aria-label="账户持仓">
            {balance.positions.length === 0 ? (
              <span className={styles.positionTagMuted}>暂无仓位</span>
            ) : (
              balance.positions.map((pos) => (
                <PositionTag key={pos.symbol} position={pos} protects={protectBySymbol.get(pos.symbol.toUpperCase())} />
              ))
            )}
          </div>

          {error ? <p className={styles.readError}>{error}</p> : null}
          <p className={styles.liveUpdated}>更新于 {formatUpdated(balance.updatedAt)}</p>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={tone === "up" ? styles.pnlUp : tone === "down" ? styles.pnlDown : undefined}>{value}</dd>
    </div>
  );
}

function TodayPill({ pnl, pct, src }: { pnl: number; pct: number; src: string }) {
  const tone = pnlTone(pnl);
  const label = src === "session" ? "启动以来" : "今日";
  return (
    <span className={`${styles.todayPill} ${tone === "up" ? styles.todayUp : tone === "down" ? styles.todayDown : ""}`}>
      {label} {formatSigned(pnl)} · {formatSigned(pct)}%
    </span>
  );
}

function PositionTag({ position, protects }: { position: PanelPosition; protects?: EngineOrder[] }) {
  const side = sideText(position.side);
  const sl = protects?.find((o) => o.kind === "stop");
  const tp = protects?.find((o) => o.kind === "takeProfit");
  return (
    <div className={styles.positionTag}>
      <span className={styles.positionSym}>{position.symbol.replace(/USDT$/i, "")}</span>
      <span className={position.side === "short" ? styles.sideShort : styles.sideLong}>
        {side}
        {position.leverage ? ` ×${position.leverage}` : ""}
      </span>
      <span>{formatAmount(position.qty)}</span>
      <span
        className={
          pnlTone(position.unrealizedPnl) === "up"
            ? styles.pnlUp
            : pnlTone(position.unrealizedPnl) === "down"
              ? styles.pnlDown
              : undefined
        }
      >
        {formatAmount(position.unrealizedPnl)}
      </span>
      {sl ? (
        <span className={styles.protectChip}>
          {orderKindText(sl.kind)} {orderPriceText(sl)}
        </span>
      ) : null}
      {tp ? (
        <span className={styles.protectChip}>
          {orderKindText(tp.kind)} {orderPriceText(tp)}
        </span>
      ) : null}
    </div>
  );
}

function EquityParts({ value }: { value: number }): ReactNode {
  if (!Number.isFinite(value)) return "—";
  const [whole, frac = "00"] = Math.abs(value).toFixed(4).split(".");
  const sign = value < 0 ? "-" : "";
  return (
    <>
      {sign}
      {Number(whole).toLocaleString("zh-CN")}
      <span className={styles.liveEquityFrac}>.{frac}</span>
    </>
  );
}

function groupProtectiveOrders(items: EngineOrder[], fallbackSymbol?: string): Map<string, EngineOrder[]> {
  const map = new Map<string, EngineOrder[]>();
  const fallback = (fallbackSymbol ?? "").toUpperCase();
  for (const order of items) {
    if (order.kind !== "stop" && order.kind !== "takeProfit") continue;
    const symbol = (order.symbol ?? fallback).toUpperCase();
    if (!symbol) continue;
    const list = map.get(symbol) ?? [];
    list.push(order);
    map.set(symbol, list);
  }
  return map;
}

function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

function pnlTone(value: number | undefined): "up" | "down" | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? "up" : "down";
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatEvent(ev: DetectionEvent): string {
  const time = formatEventTime(ev.ts);
  const sym = (ev.symbol ?? "").replace(/USDT$/i, "");
  const side = sideText(ev.side);
  const score = ev.score != null ? `score${ev.score}` : "";
  const wr = ev.winrate != null ? `胜率${Math.round(ev.winrate <= 1 ? ev.winrate * 100 : ev.winrate)}%` : "";
  const action = ev.action ?? "";
  return [time, sym, side !== "—" ? side : "", score, wr, action].filter(Boolean).join(" ");
}

function formatEventTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function useCountdown(until: string): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const tick = () => {
      if (!until) {
        setLeft(0);
        return;
      }
      const end = new Date(until).getTime();
      if (!Number.isFinite(end)) {
        setLeft(0);
        return;
      }
      setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return left;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
