import express from "express";
import { authRequired } from "../middleware/auth.js";
import { ok, fail } from "../utils.js";
import { requestBinance } from "../services/binance-engine.js";

export function createBinanceRouter({ authorize = authRequired, fetchImpl, keyFile, engineUrl } = {}) {
  const router = express.Router();
  const endpoints = [
    ["GET", /^\/(status|dashboard|equity|accounts|positions|strategies|orders|backtests|protection-orders|platform)$/],
    ["GET", /^\/(risk\/\d+|strategies\/\d+\/events)$/],
    ["POST", /^\/(accounts|orders|strategies|backtests|platform\/network)$/],
    ["POST", /^\/(accounts\/\d+\/(sync|validate)|positions\/\d+\/close|strategies\/\d+\/run|orders\/\d+\/(cancel|refresh))$/],
    ["PATCH", /^\/(accounts|strategies)\/\d+$/],
    ["PUT", /^\/(risk\/\d+|positions\/\d+\/protection|platform)$/],
    ["DELETE", /^\/(accounts|strategies)\/\d+$/],
  ];
  // 全体登录用户可用。交易引擎对账户以及全部子资源按 OOAPI user.id 强制隔离。
  router.use(authorize, express.json({ limit: "128kb" }));
  router.use(async (req, res) => {
    if (!endpoints.some(([method, pattern]) => method === req.method && pattern.test(req.path))) return fail(res, "未实现的币安接口", 404);
    const query = new URLSearchParams();
    for (const key of ["account_id", "strategy_id", "limit"]) {
      if (req.query[key] !== undefined) {
        const value = String(req.query[key]);
        if (!/^\d+$/.test(value)) return fail(res, "查询参数无效", 400);
        query.set(key, value);
      }
    }
    const endpoint = req.path === "/status" ? "/health" : `/api${req.path}${query.size ? `?${query}` : ""}`;
    try { return ok(res, await requestBinance(endpoint, { userId: req.user.id, method: req.method, body: req.body, fetchImpl, keyFile, engineUrl })); }
    catch (e) { return fail(res, e.message, e.status || 503); }
  });
  return router;
}

export default createBinanceRouter();
