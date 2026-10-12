import { Button } from "@/components/arc/button/button";

import styles from "./TradingDesk.module.css";
import type { EngineKline, EngineMarket, EngineOrders, EnginePosition } from "./tradingApi";
import {
  buildDeskStatus,
  formatAmount,
  levelText,
  orderKindText,
  orderPriceText,
  orderSideText,
  orderSourceText,
  pnlBoard,
  positionView,
  type EngineSlice,
} from "./tradingDeskView";

export interface DeskReadErrors {
  state?: string;
  market?: string;
  position?: string;
  orders?: string;
}

interface TradingDeskProps {
  engine: EngineSlice | null;
  market: EngineMarket | null;
  position: EnginePosition | null;
  orders: EngineOrders | null;
  /** 首屏还在拉策略时，状态条先标明正在读取。 */
  loading?: boolean;
  readErrors?: DeskReadErrors;
  symbol?: string;
  leverage?: number;
  marginMode?: string;
  timeframe?: string;
  mode?: string;
  accountLabel?: string;
  /** 用户关掉的那条 lastError。引擎换了一条新错误会再显示。只影响本页，不请求后端。 */
  dismissedError?: string;
  onDismissError?: () => void;
}

export default function TradingDesk({
  engine,
  market,
  position,
  orders,
  loading = false,
  readErrors,
  symbol,
  leverage,
  marginMode,
  timeframe,
  mode,
  accountLabel,
  dismissedError = "",
  onDismissError,
}: TradingDeskProps) {
  const status = buildDeskStatus({ engine, symbol, leverage, marginMode, accountLabel, mode, timeframe });
  const held = positionView(position);
  const pnl = pnlBoard(engine);
  const showError = status.lastError.length > 0 && status.lastError !== dismissedError;
  const stateText = loading && !engine ? "正在读取" : status.stateText;
  const chartTimeframe = market?.timeframe || status.timeframe;
  const hasLevels = market?.levels != null;

  return (
    <div className={styles.desk}>
      <dl className={styles.statusBar} aria-label="策略状态" data-engine-state={engine?.state ?? "Idle"} data-testnet-green={engine?.testnetGreen ? "on" : "off"} data-realized-network={engine?.realizedNetwork ?? ""}>
        <StatusItem label="状态" value={stateText} />
        <StatusItem label="环境" value={status.modeText} />
        <StatusItem label="测网全绿" value={status.testnetGreenText} />
        <StatusItem label="交易对" value={status.symbol} />
        <StatusItem label="杠杆" value={status.leverageText} />
        <StatusItem label="保证金模式" value={status.marginModeText} />
        <StatusItem label="账户" value={status.accountLabel} />
      </dl>
      {readErrors?.state ? <p className={styles.readError}>{readErrors.state}</p> : null}

      {showError && (
        <div className={styles.errorBar} role="alert">
          <p>{status.lastError}</p>
          <Button variant="secondary" size="sm" onClick={onDismissError}>
            关闭
          </Button>
        </div>
      )}

      <section className={styles.panel} aria-label="K线">
        <header className={styles.panelHead}>
          <h2>K 线</h2>
          <p>周期 {chartTimeframe}。蜡烛和标记价来自行情。有仓时画出 levels 里的入场、止损、止盈。</p>
        </header>
        <CandleChart
          timeframe={chartTimeframe}
          market={market}
          loading={loading}
          error={readErrors?.market}
          hasLevels={hasLevels}
        />
      </section>

      <section className={styles.panel} aria-label="持仓">
        <header className={styles.panelHead}>
          <h2>持仓</h2>
          <p>方向、数量、开仓均价、标记价、未实现盈亏、杠杆和保证金。</p>
        </header>
        {position == null ? (
          <p className={styles.emptyTitle}>{readErrors?.position ?? (loading ? "正在读取持仓…" : "先保存策略后再看持仓。")}</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>方向</th>
                  <th>数量</th>
                  <th>开仓均价</th>
                  <th>标记价</th>
                  <th>未实现盈亏</th>
                  <th>杠杆</th>
                  <th>保证金</th>
                </tr>
              </thead>
              <tbody>
                {held.open ? (
                  <tr>
                    <td>{held.side}</td>
                    <td>{held.qty}</td>
                    <td>{held.entry}</td>
                    <td>{held.mark}</td>
                    <td>{held.unrealized}</td>
                    <td>{held.leverage}</td>
                    <td>{held.margin}</td>
                  </tr>
                ) : (
                  <tr>
                    <td colSpan={7} className={styles.emptyCell}>当前无持仓</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {position != null && readErrors?.position ? <p className={styles.readError}>{readErrors.position}</p> : null}
      </section>

      <section className={styles.panel} aria-label="委托">
        <header className={styles.panelHead}>
          <h2>委托</h2>
          <p>入场单，以及止损、止盈。条件单来源是 algo。</p>
        </header>
        <OrdersTable orders={orders} loading={loading} error={readErrors?.orders} />
      </section>

      <section className={styles.panel} aria-label="已实现盈亏">
        <header className={styles.panelHead}>
          <h2>已实现盈亏</h2>
          <p>当日和本会话累计都在引擎 state 里，只标 realizedNetwork 这一侧。本会话累计不是跨天永久账本。另一侧保持「—」。</p>
        </header>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>项目</th>
                <th>测网</th>
                <th>实盘</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">当日已实现</th>
                <td>{pnl.testnetDay}</td>
                <td>{pnl.liveDay}</td>
              </tr>
              <tr>
                <th scope="row">本会话累计</th>
                <td>{pnl.testnetCumulative}</td>
                <td>{pnl.liveCumulative}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.statusItem}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CandleChart({
  timeframe,
  market,
  loading,
  error,
  hasLevels,
}: {
  timeframe: string;
  market: EngineMarket | null;
  loading: boolean;
  error?: string;
  hasLevels: boolean;
}) {
  const klines = market?.klines ?? [];
  const mark = market?.markPrice;
  return (
    <div className={styles.chart}>
      {market == null ? (
        <div className={styles.chartEmpty}>
          <p className={styles.chartTitle}>{timeframe}</p>
          <p>{error ?? (loading ? "正在读取 K 线…" : "先保存策略后再看 K 线。")}</p>
        </div>
      ) : klines.length > 0 ? (
        <CandleSvg
          candles={klines}
          markPrice={mark}
          entry={market.levels?.entryPrice}
          stop={market.levels?.stopPrice}
          take={market.levels?.takeProfitPrice}
        />
      ) : (
        <div className={styles.chartEmpty}>
          <p className={styles.chartTitle}>{timeframe} · 暂无 K 线</p>
        </div>
      )}
      <dl className={styles.levels}>
        <div>
          <dt>标记价</dt>
          <dd>{mark != null && mark > 0 ? formatAmount(mark) : "—"}</dd>
        </div>
        <div>
          <dt>入场</dt>
          <dd>{levelText(market?.levels?.entryPrice, hasLevels)}</dd>
        </div>
        <div>
          <dt>止损</dt>
          <dd>{levelText(market?.levels?.stopPrice, hasLevels)}</dd>
        </div>
        <div>
          <dt>止盈</dt>
          <dd>{levelText(market?.levels?.takeProfitPrice, hasLevels)}</dd>
        </div>
      </dl>
      {market != null && error ? <p className={styles.readError}>{error}</p> : null}
    </div>
  );
}

function CandleSvg({
  candles,
  markPrice,
  entry,
  stop,
  take,
}: {
  candles: EngineKline[];
  markPrice?: number;
  entry?: number;
  stop?: number;
  take?: number;
}) {
  const width = 640;
  const height = 200;
  const pad = { l: 52, r: 8, t: 10, b: 8 };
  const prices = candles.flatMap((candle) => [candle.high, candle.low, candle.open, candle.close]);
  for (const level of [markPrice, entry, stop, take]) {
    if (level != null && level > 0) prices.push(level);
  }
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const y = (value: number) => pad.t + ((max - value) / span) * (height - pad.t - pad.b);
  const slot = (width - pad.l - pad.r) / candles.length;
  const closes = candles.map((candle, index) => {
    const x = pad.l + slot * index + slot / 2;
    return `${x},${y(candle.close)}`;
  }).join(" ");

  return (
    <svg className={styles.svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="收盘价与参考线">
      {candles.map((candle, index) => {
        const x = pad.l + slot * index + slot / 2;
        const bodyWidth = Math.max(2, slot * 0.55);
        const up = candle.close >= candle.open;
        const top = y(Math.max(candle.open, candle.close));
        const bottom = y(Math.min(candle.open, candle.close));
        const color = up ? "var(--success, #1a7f4b)" : "var(--danger, #d94a3d)";
        return (
          <g key={candle.openTime || index}>
            <line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="1" />
            <rect x={x - bodyWidth / 2} y={top} width={bodyWidth} height={Math.max(1, bottom - top)} fill={color} />
          </g>
        );
      })}
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.25" points={closes} />
      <LevelLine y={y} value={entry} label="入场" color="var(--accent)" width={width} padL={pad.l} />
      <LevelLine y={y} value={stop} label="止损" color="var(--danger, #d94a3d)" width={width} padL={pad.l} />
      <LevelLine y={y} value={take} label="止盈" color="var(--success, #1a7f4b)" width={width} padL={pad.l} />
      <LevelLine y={y} value={markPrice} label="标记" color="var(--text-secondary)" width={width} padL={pad.l} />
    </svg>
  );
}

function LevelLine({
  y,
  value,
  label,
  color,
  width,
  padL,
}: {
  y: (value: number) => number;
  value?: number | null;
  label: string;
  color: string;
  width: number;
  padL: number;
}) {
  if (value == null || !(value > 0)) return null;
  const yy = y(value);
  return (
    <line x1={padL} x2={width} y1={yy} y2={yy} stroke={color} strokeDasharray="4 3" strokeWidth="1">
      <title>{label} {value}</title>
    </line>
  );
}

function OrdersTable({
  orders,
  loading,
  error,
}: {
  orders: EngineOrders | null;
  loading: boolean;
  error?: string;
}) {
  if (orders == null) {
    return <p className={styles.emptyTitle}>{error ?? (loading ? "正在读取委托…" : "先保存策略后再看委托。")}</p>;
  }
  if (orders.empty || orders.items.length === 0) {
    return (
      <>
        <p className={styles.emptyTitle}>无挂单</p>
        {error ? <p className={styles.readError}>{error}</p> : null}
      </>
    );
  }
  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>类型</th>
              <th>来源</th>
              <th>状态</th>
              <th>方向</th>
              <th>价格</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            {orders.items.map((order, index) => (
              <tr key={order.id || `${order.kind}-${order.source}-${index}`}>
                <td>{orderKindText(order.kind)}</td>
                <td>{orderSourceText(order.source)}</td>
                <td>{order.status || "—"}</td>
                <td>{orderSideText(order.side)}</td>
                <td>{orderPriceText(order)}</td>
                <td>{formatAmount(order.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <p className={styles.readError}>{error}</p> : null}
    </>
  );
}
