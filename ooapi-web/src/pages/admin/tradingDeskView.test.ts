import {
  buildDeskStatus,
  engineStateText,
  levelText,
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
});
assertEqual(idle.stateText, "Idle 空闲 · 未运行", "idle status");
assertEqual(idle.modeText, "testnet 测网", "testnet mode");
assertEqual(idle.testnetGreenText, "关", "green default");
assertEqual(idle.leverageText, "3 倍", "leverage");
assertEqual(idle.marginModeText, "逐仓", "isolated");
assertEqual(idle.accountLabel, "币安测网", "account");
assertEqual(idle.lastError, "", "no error");

const errored = buildDeskStatus({
  engine: { state: "Error", lastError: "名义价值不足", mode: "testnet", testnetGreen: false, running: false },
  symbol: "XRPUSDT",
  leverage: 3,
  marginMode: "isolated",
  accountLabel: "未绑定",
});
assertEqual(errored.lastError, "名义价值不足", "error text");
assertEqual(errored.stateText, "Error 出错 · 未运行", "error state");

const flat = positionView({ state: "Armed", side: "", qty: 0 }, 3);
assertEqual(flat.open, false, "flat is closed");
assertEqual(flat.side, "—", "flat side");

const held = positionView({
  state: "InPosition",
  side: "long",
  qty: 12,
  entryPrice: 0.52,
  stopPrice: 0.5,
  takeProfitPrice: 0.55,
}, 3);
assertEqual(held.open, true, "position open");
assertEqual(held.side, "多", "long");
assertEqual(held.entry, "0.52", "entry");
assertEqual(held.mark, "待接口", "mark waits");
assertEqual(held.unrealized, "待接口", "upnl waits");
assertEqual(held.margin, "待接口", "margin waits");
assertEqual(held.leverage, "3 倍", "position leverage");
assertEqual(levelText(held.stopPrice, true), "0.50", "stop level");
assertEqual(levelText(undefined, false), "无仓", "no level without a position");

const testnetPnl = pnlBoard({ mode: "testnet", dayRealizedUsdt: 1.25 }, "testnet");
assertEqual(testnetPnl.testnetDay, "1.25", "day on testnet");
assertEqual(testnetPnl.liveDay, "—", "live day not invented");
assertEqual(testnetPnl.testnetCumulative, "待接口", "cumulative waits");
assertEqual(testnetPnl.liveCumulative, "待接口", "live cumulative waits");

const livePnl = pnlBoard({ mode: "live", dayRealizedUsdt: 0 }, "live");
assertEqual(livePnl.liveDay, "0.00", "zero day is real");
assertEqual(livePnl.testnetDay, "—", "other mode stays dash");

const unread = pnlBoard(null, "testnet");
assertEqual(unread.testnetDay, "—", "no snapshot does not become zero");
assertEqual(unread.liveDay, "—", "no snapshot live stays dash");

const missingDay = pnlBoard({ mode: "testnet" }, "testnet");
assertEqual(missingDay.testnetDay, "—", "missing day is not zero");
