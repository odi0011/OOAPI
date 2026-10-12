import styles from "./TradingDesk.module.css";
import {
  formatEngineCard,
  formatEngineTotals,
  type EngineCardView,
  type PnlTone,
  type SideTone,
  type TradingEnginesSnapshot,
} from "./engineOverview";

interface EngineOverviewProps {
  snapshot: TradingEnginesSnapshot;
  selectedId: number | null;
  onSelect: (strategyId: number) => void;
}

export default function EngineOverview({ snapshot, selectedId, onSelect }: EngineOverviewProps) {
  const totals = formatEngineTotals(snapshot.totals);
  const cards = snapshot.engines.map(formatEngineCard);

  return (
    <section className={styles.panel} aria-label="多品种引擎">
      <header className={styles.panelHead}>
        <h2>引擎一览</h2>
        <p>合计全部品种。点一行，下方 K 线、持仓和委托换成这台引擎。</p>
      </header>

      <dl className={styles.overviewTotals} aria-label="合计">
        <div>
          <dt>未实现盈亏</dt>
          <dd className={pnlClass(totals.unrealizedTone)}>{totals.unrealized}</dd>
        </div>
        <div>
          <dt>今日已实现</dt>
          <dd className={pnlClass(totals.realizedTone)}>{totals.realizedToday}</dd>
        </div>
        <div>
          <dt>持仓数</dt>
          <dd>{totals.openPositions}</dd>
        </div>
      </dl>

      {cards.length === 0 ? (
        <p className={`${styles.emptyTitle} ${styles.overviewEmpty}`}>暂无引擎</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>交易对</th>
                <th>状态</th>
                <th>方向</th>
                <th>数量</th>
                <th>开仓价</th>
                <th>标记价</th>
                <th>未实现盈亏</th>
                <th>今日已实现</th>
                <th>最近原因</th>
                <th>回测胜率</th>
                <th>回测笔数</th>
                <th>回测净R</th>
                <th>回测期望</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card, index) => (
                <EngineRow
                  key={`${card.strategyId ?? "none"}-${index}`}
                  card={card}
                  selected={card.strategyId != null && card.strategyId === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EngineRow({
  card,
  selected,
  onSelect,
}: {
  card: EngineCardView;
  selected: boolean;
  onSelect: (strategyId: number) => void;
}) {
  const selectable = card.strategyId != null;
  const select = () => {
    if (card.strategyId == null) return;
    onSelect(card.strategyId);
  };

  return (
    <tr
      className={selectable ? (selected ? styles.engineSelected : styles.engineRow) : undefined}
      aria-selected={selectable ? selected : undefined}
      tabIndex={selectable ? 0 : undefined}
      onClick={select}
      onKeyDown={(event) => {
        if (!selectable) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      }}
    >
      <th scope="row">{card.symbol}</th>
      <td>{card.state}</td>
      <td className={sideClass(card.sideTone)}>{card.side}</td>
      <td>{card.qty}</td>
      <td>{card.entry}</td>
      <td>{card.mark}</td>
      <td className={pnlClass(card.unrealizedTone)}>{card.unrealized}</td>
      <td className={pnlClass(card.realizedTone)}>{card.realizedToday}</td>
      <td className={styles.reasonCell} title={card.lastReason === "—" ? undefined : card.lastReason}>
        {card.lastReason}
      </td>
      <td>{card.winRate}</td>
      <td>{card.trades}</td>
      <td>{card.netR}</td>
      <td>{card.expectancy}</td>
    </tr>
  );
}

function pnlClass(tone: PnlTone): string | undefined {
  if (tone === "up") return styles.pnlUp;
  if (tone === "down") return styles.pnlDown;
  return undefined;
}

function sideClass(tone: SideTone): string | undefined {
  if (tone === "long") return styles.sideLong;
  if (tone === "short") return styles.sideShort;
  return undefined;
}
