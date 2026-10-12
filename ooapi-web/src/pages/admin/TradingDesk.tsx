import { Button } from "@/components/arc/button/button";

import styles from "./TradingDesk.module.css";
import {
  MARKET_CANDLES_PATH,
  OPEN_ORDERS_PATH,
  PNL_PATH,
  type MarketCandle,
  type TradingOrder,
} from "./tradingApi";
import {
  buildDeskStatus,
  levelText,
  pnlBoard,
  positionView,
  type EngineSlice,
} from "./tradingDeskView";

interface TradingDeskProps {
  engine: EngineSlice | null;
  /** 首屏还在拉策略时，状态条先标明正在读取，避免把空快照说成 Idle。 */
  loading?: boolean;
  symbol?: string;
  leverage?: number;
  marginMode?: string;
  timeframe?: string;
  mode?: string;
  accountLabel?: string;
  /** 用户关掉的那条 lastError。引擎换了一条新错误会再显示。只影响本页，不请求后端。 */
  dismissedError?: string;
  onDismissError?: () => void;
  /**
   * K 线预留。接入后把 listMarketCandles 的结果传进来。
   * 不传时保持空态，本组件不会自己请求。
   */
  candles?: MarketCandle[] | null;
  markPrice?: number | null;
  /**
   * 委托预留。接入后把 listOpenOrders 的结果传进来。
   * null 表示接口还没接，空数组表示接口确认没有挂单。两种都显示「无挂单」。
   */
  orders?: TradingOrder[] | null;
}

export default function TradingDesk({
  engine,
  loading = false,
  symbol,
  leverage,
  marginMode,
  timeframe = "5m",
  mode,
  accountLabel,
  dismissedError = "",
  onDismissError,
  candles = null,
  markPrice = null,
  orders = null,
}: TradingDeskProps) {
  const status = buildDeskStatus({ engine, symbol, leverage, marginMode, accountLabel, mode });
  const position = positionView(engine, leverage);
  const pnl = pnlBoard(engine, mode);
  const showError = status.lastError.length > 0 && status.lastError !== dismissedError;
  const stateText = loading && !engine ? "正在读取" : status.stateText;

  return (
    <div className={styles.desk}>
      <dl className={styles.statusBar} aria-label="策略状态" data-engine-state={engine?.state ?? "Idle"} data-testnet-green={engine?.testnetGreen ? "on" : "off"}>
        <StatusItem label="状态" value={stateText} />
        <StatusItem label="环境" value={status.modeText} />
        <StatusItem label="测网全绿" value={status.testnetGreenText} />
        <StatusItem label="交易对" value={status.symbol} />
        <StatusItem label="杠杆" value={status.leverageText} />
        <StatusItem label="保证金模式" value={status.marginModeText} />
        <StatusItem label="账户" value={status.accountLabel} />
      </dl>

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
          <p>周期 {timeframe}。收盘价和标记价等行情接口，入场、止损、止盈有仓时直接用引擎快照。</p>
        </header>
        <CandleChart
          timeframe={timeframe}
          candles={candles}
          markPrice={markPrice}
          open={position.open}
          entry={position.entryPrice}
          stop={position.stopPrice}
          take={position.takeProfitPrice}
        />
      </section>

      <section className={styles.panel} aria-label="持仓">
        <header className={styles.panelHead}>
          <h2>持仓</h2>
          <p>方向、数量、开仓均价来自引擎 state。标记价、未实现盈亏、保证金等持仓明细接口。</p>
        </header>
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
              {position.open ? (
                <tr>
                  <td>{position.side}</td>
                  <td>{position.qty}</td>
                  <td>{position.entry}</td>
                  <td className={styles.pending}>{position.mark}</td>
                  <td className={styles.pending}>{position.unrealized}</td>
                  <td>{position.leverage}</td>
                  <td className={styles.pending}>{position.margin}</td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={7} className={styles.emptyCell}>当前无持仓</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.panel} aria-label="委托">
        <header className={styles.panelHead}>
          <h2>委托</h2>
          <p>入场单，以及止损、止盈（algo）。</p>
        </header>
        <OrdersTable orders={orders} />
      </section>

      <section className={styles.panel} aria-label="已实现盈亏">
        <header className={styles.panelHead}>
          <h2>已实现盈亏</h2>
          <p>当日已实现来自 state.dayRealizedUsdt，只填当前环境那一列。累计等 {PNL_PATH}。</p>
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
                <th scope="row">累计已实现</th>
                <td className={styles.pending}>{pnl.testnetCumulative}</td>
                <td className={styles.pending}>{pnl.liveCumulative}</td>
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
  candles,
  markPrice,
  open,
  entry,
  stop,
  take,
}: {
  timeframe: string;
  candles: MarketCandle[] | null;
  markPrice: number | null;
  open: boolean;
  entry?: number;
  stop?: number;
  take?: number;
}) {
  const series = candles ?? [];
  return (
    <div className={styles.chart}>
      {series.length > 0 ? (
        <CandleSvg candles={series} markPrice={markPrice} entry={entry} stop={stop} take={take} />
      ) : (
        <div className={styles.chartEmpty}>
          <p className={styles.chartTitle}>{timeframe} · 尚无 K 线</p>
          <p>
            预留 {MARKET_CANDLES_PATH}。接入后传入 openTime、open、high、low、close，这里改画蜡烛和收盘价。
            现在不请求这条路由。
          </p>
        </div>
      )}
      <dl className={styles.levels}>
        <div>
          <dt>标记价</dt>
          <dd>{markPrice != null && markPrice > 0 ? markPrice : "待行情接口"}</dd>
        </div>
        <div>
          <dt>入场</dt>
          <dd>{levelText(entry, open)}</dd>
        </div>
        <div>
          <dt>止损</dt>
          <dd>{levelText(stop, open)}</dd>
        </div>
        <div>
          <dt>止盈</dt>
          <dd>{levelText(take, open)}</dd>
        </div>
      </dl>
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
  candles: MarketCandle[];
  markPrice: number | null;
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

function OrdersTable({ orders }: { orders: TradingOrder[] | null }) {
  if (orders == null || orders.length === 0) {
    return (
      <div className={styles.emptyBlock}>
        <p className={styles.emptyTitle}>无挂单</p>
        <p>
          预留 {OPEN_ORDERS_PATH}。接入后展示入场单和止损、止盈的状态、方向、价格、数量，以及是否为 algo。
          现在不请求这条路由。
        </p>
      </div>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>类型</th>
            <th>状态</th>
            <th>方向</th>
            <th>价格</th>
            <th>数量</th>
            <th>algo</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order, index) => (
            <tr key={order.id || `${order.kind}-${index}`}>
              <td>{orderKindText(order.kind)}</td>
              <td>{order.status || "—"}</td>
              <td>{order.side || "—"}</td>
              <td>{order.price ?? "—"}</td>
              <td>{order.qty ?? "—"}</td>
              <td>{order.algo ? "是" : "否"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function orderKindText(kind: TradingOrder["kind"]): string {
  if (kind === "entry") return "入场";
  if (kind === "stop") return "止损";
  if (kind === "take_profit") return "止盈";
  return kind;
}
