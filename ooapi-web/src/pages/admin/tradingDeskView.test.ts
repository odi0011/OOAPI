import {
  buildDeskStatus,
  engineStateText,
  levelText,
  orderKindText,
  orderPriceText,
  orderSideText,
  orderSourceText,
  pnlBoard,
  positionView,
  testnetGreenText,
} from "./tradingDeskView.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
  }
}

assertEqual(engineStateText("Armed", true), "Armed 待命 · 运行中", "armed running");
assertEqual(engineStateText(undefined, false), "Idle 空闲 · 未运行", "missing state");
assertEqual(testnetGreenText(false), "关", "gate closed");
assertEqual(testnetGreenText(true), "开", "gate open");

const idle = buildDeskStatus({
  engine: null,
  symbol: "XRPUSDT",
  leverage: 3,
  marginMode: "isolated",
  accountLabel: "币安测网",
  mode: "testnet",
  timeframe: "5m",
});
assertEqual(idle.stateText, "Idle 空闲 · 未运行", "idle status");
assertEqual(idle.modeText, "testnet 测网", "testnet mode");
assertEqual(idle.testnetGreenText, "关", "green default");
assertEqual(idle.leverageText, "3 倍", "leverage");

const twenty = buildDeskStatus({ engine: null, leverage: 20 });
assertEqual(twenty.leverageText, "20 倍", "leverage 20 is shown as stored");
assertEqual(idle.marginModeText, "逐仓", "isolated");
assertEqual(idle.accountLabel, "币安测网", "account");
assertEqual(idle.timeframe, "5m", "timeframe fallback");

const fromState = buildDeskStatus({
  engine: {
    state: "Armed",
    running: true,
    mode: "testnet",
    testnetGreen: true,
    symbol: "XRPUSDT",
    leverage: 2,
    marginMode: "isolated",
    timeframe: "5m",
    exchangeKeyLabel: "测网主号",
    realizedNetwork: "testnet",
  },
  accountLabel: "别用草稿",
  leverage: 3,
});
assertEqual(fromState.accountLabel, "测网主号", "label comes from state");
assertEqual(fromState.leverageText, "2 倍", "leverage comes from state");
assertEqual(fromState.testnetGreenText, "开", "green from state");
assertEqual(fromState.stateText, "Armed 待命 · 运行中", "armed from state");

const flat = positionView({ open: false });
assertEqual(flat.open, false, "flat is closed");
assertEqual(flat.mark, "—", "flat has no mark");

const held = positionView({
  open: true,
  side: "short",
  qty: 8,
  entryPrice: 0.6,
  markPrice: 0.58,
  unrealizedPnl: -0.16,
  leverage: 3,
  margin: 1.6,
});
assertEqual(held.open, true, "position open");
assertEqual(held.side, "空", "short");
assertEqual(held.entry, "0.60", "entry");
assertEqual(held.mark, "0.58", "mark");
assertEqual(held.unrealized, "-0.16", "unrealized pnl");
assertEqual(held.margin, "1.60", "margin");
assertEqual(held.leverage, "3 倍", "position leverage");

const heldTwenty = positionView({
  open: true,
  side: "long",
  qty: 1,
  entryPrice: 1.4,
  markPrice: 1.41,
  unrealizedPnl: 0.01,
  leverage: 20,
  margin: 1,
});
assertEqual(heldTwenty.leverage, "20 倍", "position leverage 20 is shown as stored");

assertEqual(levelText(0.5, true), "0.50", "stop level");
assertEqual(levelText(undefined, false), "无仓", "no levels means flat");

const testnetPnl = pnlBoard({
  realizedNetwork: "testnet",
  dayRealizedUsdt: 1.25,
  cumulativeRealizedUsdt: 4,
});
assertEqual(testnetPnl.testnetDay, "1.25", "day on testnet");
assertEqual(testnetPnl.liveDay, "—", "live day stays dash");
assertEqual(testnetPnl.testnetCumulative, "4.00", "session cumulative on testnet");
assertEqual(testnetPnl.liveCumulative, "—", "live cumulative stays dash");

const livePnl = pnlBoard({
  realizedNetwork: "live",
  dayRealizedUsdt: 0,
  cumulativeRealizedUsdt: 0,
});
assertEqual(livePnl.liveDay, "0.00", "zero day is real");
assertEqual(livePnl.liveCumulative, "0.00", "zero session cumulative is real");
assertEqual(livePnl.testnetDay, "—", "other side is not zero");
assertEqual(livePnl.testnetCumulative, "—", "other cumulative is not zero");

const unread = pnlBoard(null);
assertEqual(unread.testnetDay, "—", "no snapshot day");
assertEqual(unread.liveCumulative, "—", "no snapshot cumulative");

const missingNetwork = pnlBoard({ dayRealizedUsdt: 3, cumulativeRealizedUsdt: 9, mode: "testnet" });
assertEqual(missingNetwork.testnetDay, "—", "mode alone does not place pnl");
assertEqual(missingNetwork.liveDay, "—", "missing network leaves live blank");

assertEqual(orderKindText("takeProfit"), "止盈", "takeProfit kind");
assertEqual(orderKindText("stop"), "止损", "stop kind");
assertEqual(orderKindText("entry"), "入场", "entry kind");
assertEqual(orderSourceText("algo"), "条件单", "algo source");
assertEqual(orderSourceText("order"), "普通", "book source");
assertEqual(orderSideText("sell"), "卖", "order side");
assertEqual(orderPriceText({ price: 0, stopPrice: 0.55 }), "0.55", "stop price when limit is zero");
