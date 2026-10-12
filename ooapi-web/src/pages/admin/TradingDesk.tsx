import { Button } from "@/components/arc/button/button";
import Switch from "@/components/arc/switch/switch";

import LightweightCandleChart from "./LightweightCandleChart";
import styles from "./TradingDesk.module.css";
import { formatExpectancyR, formatNetR, formatWinRate } from "./engineOverview";
import type { EngineMarket, EngineOrders, EnginePosition, TradeEntry } from "./tradingApi";
import {
  buildDeskStatus,
  entryScoreText,
  formatAmount,
  levelText,
  orderKindText,
  orderPriceText,
  orderSideText,
  orderSourceText,
  pnlBoard,
  positionView,
  sideText,
  yesNo,
  type EngineSlice,
  type TradeEntrySlice,
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
  /** 立刻切换暂停新开仓。不传时只展示当前状态。 */
  onTogglePauseEntries?: (paused: boolean) => void;
  pauseBusy?: boolean;
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
  onTogglePauseEntries,
  pauseBusy = false,
}: TradingDeskProps) {
  const status = buildDeskStatus({ engine, symbol, leverage, marginMode, accountLabel, mode, timeframe });
  const held = positionView(position);
  const pnl = pnlBoard(engine);
  const showError = status.lastError.length > 0 && status.lastError !== dismissedError;
  const stateText = loading && !engine ? "正在读取" : status.stateText;
  const chartTimeframe = market?.timeframe || status.timeframe;
  const hasLevels = market?.levels != null;
  const positionOpen = position == null ? null : position.open === true;

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
        <StatusItem label="回测期望" value={formatExpectancyR(engine?.lastBacktest?.expectancyR)} />
        <div className={styles.statusItem}>
          <dt>新开仓</dt>
          <dd>
            {onTogglePauseEntries ? (
              <Switch
                label={status.pauseEntriesText}
                checked={status.pauseEntries}
                disabled={pauseBusy}
                onCheckedChange={onTogglePauseEntries}
              />
            ) : (
              status.pauseEntriesText
            )}
          </dd>
        </div>
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
          positionOpen={positionOpen}
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
        {engine?.entry ? <OpenEntryNote entry={engine.entry} /> : null}
      </section>

      <section className={styles.panel} aria-label="委托">
        <header className={styles.panelHead}>
          <h2>委托</h2>
          <p>入场单，以及止损、止盈。条件单来源是 algo。</p>
        </header>
        <OrdersTable orders={orders} loading={loading} error={readErrors?.orders} />
        <EntriesTable entries={orders?.entries} />
      </section>

      <section className={styles.panel} aria-label="已实现盈亏">
        <header className={styles.panelHead}>
          <h2>已实现盈亏</h2>
          <p>当日从上海时间 0 点算到现在，累计从策略创建算起，都直接来自币安账单。只标 realizedNetwork 这一侧，另一侧保持「—」。</p>
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

function OpenEntryNote({ entry }: { entry: TradeEntrySlice }) {
  return (
    <p className={styles.pageLead}>
      本笔开仓 {entryScoreText(entry)}，加速 {yesNo(entry.boost)}，强制 {yesNo(entry.forced)}，回测期望{" "}
      {formatExpectancyR(entry.expectancyR)}（{formatAmount(entry.expectancyUsdt ?? undefined)} USDT）
    </p>
  );
}

function EntriesTable({ entries }: { entries?: TradeEntry[] | null }) {
  if (entries == null) return null;
  return (
    <div>
      <header className={styles.panelHead}>
        <h2>开仓记录</h2>
        <p>每笔开仓当时的分数、门槛、是否加速或强制，以及该策略配置的回测胜率、笔数、净 R 和每笔期望。重启后仍在。</p>
      </header>
      {entries.length === 0 ? (
        <p className={styles.emptyTitle}>还没有开仓记录</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>时间</th>
                <th>方向</th>
                <th>分数</th>
                <th>加速</th>
                <th>强制</th>
                <th>胜率</th>
                <th>笔数</th>
                <th>净R</th>
                <th>期望R</th>
                <th>期望USDT</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.openedAt ?? "open"}-${entry.symbol ?? ""}-${index}`}>
                  <td>{formatOpened(entry.openedAt)}</td>
                  <td>{sideText(entry.side)}</td>
                  <td>{entryScoreText(entry)}</td>
                  <td>{yesNo(entry.boost)}</td>
                  <td>{yesNo(entry.forced)}</td>
                  <td>{formatWinRate(entry.winRate)}</td>
                  <td>{entry.trades}</td>
                  <td>{formatNetR(entry.netR)}</td>
                  <td>{formatExpectancyR(entry.expectancyR)}</td>
                  <td>{formatAmount(entry.expectancyUsdt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatOpened(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
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
  positionOpen,
}: {
  timeframe: string;
  market: EngineMarket | null;
  loading: boolean;
  error?: string;
  hasLevels: boolean;
  positionOpen: boolean | null;
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
        <LightweightCandleChart
          timeframe={timeframe}
          candles={klines}
          markPrice={mark}
          levels={market.levels}
          positionOpen={positionOpen}
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
