import { requestBinance } from "./binance-engine.js";

export async function readBinanceAnalysis(args, ctx, request = requestBinance) {
  const action = String(args?.action || "analysis");
  const userId = Number(ctx?.user?.id);
  const options = { userId, signal: ctx?.signal };
  const accounts = await request("/api/accounts", options);
  const accountId = Number(args?.account_id) || 0;
  if (accountId && !accounts.some((account) => account.id === accountId)) throw new Error("账户不存在");
  const active = accounts.filter((account) => account.active);
  const query = accountId ? `?account_id=${accountId}` : "";
  const endpoints = { accounts: "/api/accounts", overview: `/api/dashboard${query}`, positions: `/api/positions${query}`, orders: `/api/orders${query}`, strategies: "/api/strategies", backtests: "/api/backtests" };
  if (action === "risk") {
    if (!accountId) throw new Error("查询风控需要 account_id");
    return await request(`/api/risk/${accountId}`, options);
  }
  if (Object.hasOwn(endpoints, action)) {
    if (action === "accounts") return accounts;
    const data = await request(endpoints[action], options);
    if (action === "strategies") return accountId ? data.filter((row) => row.accountId === accountId) : data;
    if (action === "backtests" && accountId) {
      const strategies = await request("/api/strategies", options);
      const ids = new Set(strategies.filter((row) => row.accountId === accountId).map((row) => row.id));
      return data.filter((row) => ids.has(row.strategyId));
    }
    return data;
  }
  if (action !== "analysis") throw new Error("未知的币安查询动作");
  const [summary, rawPositions, orders, rawStrategies] = await Promise.all([
    request(`/api/dashboard${query}`, options), request(`/api/positions${query}`, options),
    request(`/api/orders${query}`, options), request("/api/strategies", options),
  ]);
  const selected = accountId ? accounts.filter((account) => account.id === accountId) : active;
  const ids = new Set(selected.map((account) => account.id));
  const positions = rawPositions.filter((row) => ids.has(row.accountId)).map((row) => ({ ...row,
    notional: row.quantity * row.markPrice,
    liquidationDistancePct: row.liquidationPrice > 0 && row.markPrice > 0 ? (row.side === "LONG" ? row.markPrice - row.liquidationPrice : row.liquidationPrice - row.markPrice) / row.markPrice * 100 : null,
  }));
  const risk = await Promise.all(selected.map(async (account) => ({ accountId: account.id, ...(await request(`/api/risk/${account.id}`, options)) })));
  return {
    capturedAt: new Date().toISOString(), accounts: selected, summary, positions, risk,
    strategies: rawStrategies.filter((row) => ids.has(row.accountId)),
    recentOrders: orders.filter((row) => ids.has(row.accountId)).slice(0, 30),
    exposure: { grossNotional: positions.reduce((sum, row) => sum + row.notional, 0), netNotional: positions.reduce((sum, row) => sum + row.notional * (row.side === "LONG" ? 1 : -1), 0) },
    units: "交易资金均为 USDT，与 OOAPI 的 OD币额度无关",
  };
}
