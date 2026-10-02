import { requestBinance } from "./binance-engine.js";

const ACTIONS = new Set(["accounts", "overview", "positions", "orders", "strategies", "risk", "backtests", "analysis"]);
const number = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const id = (value) => ["number", "string"].includes(typeof value) && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const pick = (value, fields) => Object.fromEntries(fields.filter((field) => Object.hasOwn(value || {}, field)).map((field) => [field, value[field]]));
const date = (value) => {
  if (!value) return null;
  const text = String(value), time = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : `${text}Z`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const array = (value) => { if (!Array.isArray(value)) throw new Error("交易服务响应无效，请稍后重试"); return value; };
const publicAccount = (account) => ({ id: id(account.id), name: String(account.name || "").slice(0, 120),
  environment: ["demo", "testnet", "live"].includes(account.environment) ? account.environment : "unknown",
  active: account.active === true || account.active === 1, last_sync_at: date(account.last_sync_at),
  syncStatus: account.last_sync_error ? "error" : account.last_sync_at ? "synced" : "unknown" });
const publicPosition = (row) => {
  const result = pick(row, ["id", "accountId", "symbol", "side", "positionSide"]);
  for (const field of ["quantity", "entryPrice", "markPrice", "pnl", "leverage", "margin", "liquidationPrice", "stopLoss", "takeProfit", "trailingPct"]) result[field] = number(row[field]);
  result.notional = result.quantity !== null && result.markPrice !== null ? Math.abs(result.quantity * result.markPrice) : null;
  result.liquidationDistancePct = result.liquidationPrice > 0 && result.markPrice > 0 && ["LONG", "SHORT"].includes(result.side)
    ? (result.side === "LONG" ? result.markPrice - result.liquidationPrice : result.liquidationPrice - result.markPrice) / result.markPrice * 100 : null;
  return result;
};
const publicOrder = (row) => ({ ...pick(row, ["id", "accountId", "symbol", "side", "quantity", "filledQuantity", "ledgerComplete", "price", "realizedPnl", "commission", "status", "mode", "createdAt"]),
  commissionAssets: Array.isArray(row.commissionAssets) ? row.commissionAssets.map((asset) => pick(asset, ["asset", "amount"])) : [] });
const publicStrategy = (row) => ({ ...pick(row, ["id", "accountId", "name", "symbol", "timeframe", "strategyType", "status", "lastSignal", "lastRunAt", "realizedPnl", "filledOrders", "winRate"]),
  config: pick(row.config, ["fast_period", "slow_period", "quantity", "auto_execute", "position_side"]) });
const publicRisk = (row) => pick(row, ["max_margin_ratio", "max_order_notional", "max_daily_loss", "max_open_positions", "max_leverage", "liquidation_buffer_pct", "trading_halted"]);
const publicBacktest = (row) => ({ ...pick(row, ["id", "strategyId", "createdAt"]),
  result: pick(row.result, ["initialBalance", "finalBalance", "returnPct", "maxDrawdownPct", "winRate", "tradeCount", "feeRate", "slippage"]) });

/** 系统对话的只读工具：账号由ctx.user隔离，缺省读取本人的全部启用账户。 */
export async function readBinanceAnalysis(args, ctx, request = requestBinance) {
  const userId = id(ctx?.user?.id);
  if (!userId) throw new Error("当前会话没有登录用户，无法查询币安账户");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是 JSON 对象");
  const action = String(args.action || "analysis").trim().toLowerCase();
  if (!ACTIONS.has(action)) throw new Error("未知的币安查询动作；本工具只读，不能执行交易");
  const hasAccount = args.account_id !== undefined;
  const accountId = hasAccount ? id(args.account_id) : 0;
  if (hasAccount && !accountId) throw new Error("account_id 必须是正整数");
  const options = { userId, signal: ctx?.signal, method: "GET" };
  const read = async (endpoint) => {
    if (ctx?.signal?.aborted) throw Object.assign(new Error("已停止"), { code: "ABORTED" });
    return request(endpoint, options);
  };
  // 先取得引擎按用户隔离的账号清单，后续每条子资源还要与这份清单求交。
  const accounts = [...new Map(array(await read("/api/accounts")).map(publicAccount).filter((account) => account.id).map((account) => [account.id, account])).values()];
  if (accountId && !accounts.some((account) => account.id === accountId)) throw new Error("账户不存在或无权读取");
  const selected = accountId ? accounts.filter((account) => account.id === accountId) : accounts.filter((account) => account.active);
  const common = { action, capturedAt: new Date().toISOString(), selection: accountId ? "account" : "all_active_accounts", accounts: action === "accounts" ? accounts : selected,
    units: "交易资金均为 USDT，与 OOAPI 的 OD币额度无关；只读取已保存的数据，不同步账户或执行交易" };
  if (action === "accounts") return { ...common, status: accounts.length ? "ok" : "no_accounts" };
  if (!selected.length) return { ...common, status: accounts.length ? "no_active_accounts" : "no_accounts",
    message: accounts.length ? "尚无启用的币安账户，请在 OD Binance 配置中启用账户" : "尚未添加币安账户，请在 OD Binance 配置中添加账户",
    summary: null, positions: [], orders: [], recentOrders: [], strategies: [], risk: [], backtests: [], snapshots: [] };

  const ids = new Set(selected.map((account) => account.id));
  const ownedRows = (value) => array(value).filter((row) => ids.has(id(row.accountId)));
  // 明确逐账户查询，既不混入停用账户，也不依赖页面按钮预填的account_id。
  const perAccount = async (endpoint, map) => (await Promise.all(selected.map(async (account) => {
    const rows = array(await read(`/api/${endpoint}?account_id=${account.id}`));
    return rows.filter((row) => id(row.accountId) === account.id).map(map);
  }))).flat();
  const strategies = async () => ownedRows(await read("/api/strategies")).map(publicStrategy);
  const positions = () => perAccount("positions", publicPosition);
  const orders = async () => (await perAccount("orders", publicOrder)).sort((a, b) => (id(b.id) - id(a.id))).slice(0, 30);
  const risks = () => Promise.all(selected.map(async (account) => ({ accountId: account.id, ...publicRisk(await read(`/api/risk/${account.id}`)) })));
  const overview = async () => {
    const summaries = await Promise.all(selected.map(async (account) => {
      const [raw, equity] = await Promise.all([read(`/api/dashboard?account_id=${account.id}`), read(`/api/equity?account_id=${account.id}`)]);
      const latest = array(equity).filter((point) => number(point.time) > 0 && number(point.time) <= 8640000000000000 && number(point.value) !== null).sort((a, b) => b.time - a.time)[0];
      // dashboard用0填补“尚无快照”；对话必须与真实0余额区分，不能据此作风险判断。
      const summary = Object.fromEntries(["totalEquity", "dayPnl", "dayPnlPct", "marginUsed", "marginTotal"].map((field) => [field, latest && account.active ? number(raw?.[field]) : null]));
      if (latest) summary.totalEquity = number(latest.value); // 停用账户的dashboard返回0，历史权益仍来自真实快照。
      const snapshotTime = latest ? number(latest.time) : null;
      const snapshot = { accountId: account.id, lastSyncAt: account.last_sync_at, capturedAt: snapshotTime ? new Date(snapshotTime).toISOString() : null,
        status: snapshotTime ? Date.now() - snapshotTime > 90000 ? "stale" : "available" : "not_recorded", syncStatus: account.syncStatus };
      const market = { connected: raw?.market?.connected === true, lastMessageAt: number(raw?.market?.lastMessageAt), status: raw?.market?.error ? "error" : raw?.market?.connected ? "connected" : "disconnected" };
      return { accountId: account.id, summary, snapshot, market };
    }));
    const sum = (field) => summaries.every((row) => row.summary[field] !== null) ? summaries.reduce((n, row) => n + row.summary[field], 0) : null;
    const summary = Object.fromEntries(["totalEquity", "dayPnl", "marginUsed", "marginTotal"].map((field) => [field, sum(field)]));
    summary.dayPnlPct = summary.totalEquity !== null && summary.dayPnl !== null && summary.totalEquity !== summary.dayPnl ? summary.dayPnl / (summary.totalEquity - summary.dayPnl) * 100 : null;
    return { summary, accountSummaries: summaries, snapshots: summaries.map((row) => row.snapshot) };
  };
  const result = { ...common, status: "ok" };
  if (action === "overview") return { ...result, ...await overview() };
  if (action === "positions") return { ...result, positions: await positions() };
  if (action === "orders") return { ...result, orders: await orders() };
  if (action === "strategies") return { ...result, strategies: await strategies() };
  if (action === "risk") return { ...result, risk: await risks() };
  if (action === "backtests") {
    const [ownedStrategies, raw] = await Promise.all([strategies(), read("/api/backtests")]);
    const strategyIds = new Set(ownedStrategies.map((row) => id(row.id)));
    return { ...result, backtests: array(raw).filter((row) => strategyIds.has(id(row.strategyId))).map(publicBacktest) };
  }
  const [snapshot, currentPositions, recentOrders, currentStrategies, risk] = await Promise.all([overview(), positions(), orders(), strategies(), risks()]);
  return { ...result, ...snapshot, positions: currentPositions, recentOrders, strategies: currentStrategies, risk,
    exposure: { grossNotional: currentPositions.every((row) => row.notional !== null) ? currentPositions.reduce((sum, row) => sum + row.notional, 0) : null,
      netNotional: currentPositions.every((row) => row.notional !== null && ["LONG", "SHORT"].includes(row.side)) ? currentPositions.reduce((sum, row) => sum + row.notional * (row.side === "LONG" ? 1 : -1), 0) : null } };
}
