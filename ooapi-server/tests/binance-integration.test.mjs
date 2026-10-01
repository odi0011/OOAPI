import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { createBinanceRouter } from "../src/routes/binance.js";
import { readBinanceAnalysis } from "../src/services/binance-analysis.js";
import { pool } from "../src/db.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooapi-binance-test-"));
const keyFile = path.join(dir, "bridge.key");
const key = crypto.randomBytes(48).toString("hex");
fs.writeFileSync(keyFile, key);
let forwarded = 0;
const app = express();
app.use("/api/binance", createBinanceRouter({ keyFile,
  authorize: (req, res, next) => { if (req.headers.authorization !== "Bearer test-only") return res.status(401).json({ success: false }); req.user = { id: 7, role: 1 }; next(); },
  fetchImpl: async (url, options) => {
    forwarded++;
    assert.equal(options.headers["X-OOAPI-User"], "7");
    assert.equal(options.headers["X-OOAPI-Bridge"], key);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(url.pathname, "/api/accounts");
    return new Response(JSON.stringify([{ id: 1, name: "owned" }]), { status: 200 });
  },
}));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}/api/binance`;
try {
  assert.equal((await fetch(`${base}/accounts`)).status, 401);
  const headers = { Authorization: "Bearer test-only", "X-OOAPI-User": "999", "X-OOAPI-Bridge": "spoofed", Cookie: "qp_session=spoofed" };
  assert.equal((await fetch(`${base}/accounts`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/auth/login`, { method: "POST", headers })).status, 404);
  assert.equal((await fetch(`${base}/accounts?account_id=../1`, { headers })).status, 400);
  assert.equal(forwarded, 1);
  const records = [];
  const read = async (endpoint, options) => {
    records.push(endpoint); assert.equal(options.userId, 7);
    if (endpoint === "/api/accounts") return [{ id: 1, active: true }];
    if (endpoint.startsWith("/api/dashboard")) return { totalEquity: 10000 };
    if (endpoint.startsWith("/api/positions")) return [{ accountId: 1, quantity: 2, markPrice: 100, liquidationPrice: 90, side: "LONG" }];
    if (endpoint.startsWith("/api/risk")) return { max_leverage: 5 };
    return [];
  };
  const result = await readBinanceAnalysis({ action: "analysis", account_id: 1, user_id: 999 }, { user: { id: 7 } }, read);
  assert.equal(result.exposure.grossNotional, 200);
  assert.equal(result.positions[0].liquidationDistancePct, 10);
  const before = records.length;
  await assert.rejects(() => readBinanceAnalysis({ action: "positions", account_id: 999 }, { user: { id: 7 } }, read), /账户不存在/);
  assert.equal(records.length, before + 1);
  assert(records.every((endpoint) => !/\/orders$/.test(endpoint) || endpoint.startsWith("/api/")));
  console.log("BINANCE_INTEGRATION_PASS: JWT identity, restricted routes, agent ownership and risk calculations");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
}
