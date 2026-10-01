import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function requestBinance(endpoint, { userId, method = "GET", body, signal, keyFile, engineUrl, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw Object.assign(new Error("用户身份无效"), { status: 401 });
  const base = new URL(engineUrl || process.env.OD_BINANCE_URL || "http://127.0.0.1:8001");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.protocol !== "http:") throw new Error("交易引擎必须使用本机 HTTP 地址");
  let bridgeKey;
  try { bridgeKey = fs.readFileSync(keyFile || process.env.OD_BINANCE_KEY_FILE || path.join(serverRoot, "data/binance-bridge.key"), "utf8").trim(); } catch { /* 下方返回未配置状态 */ }
  if (!bridgeKey || bridgeKey.length < 32) throw Object.assign(new Error("交易服务尚未配置，请联系管理员"), { status: 503 });
  const url = new URL(endpoint, base);
  if (url.origin !== base.origin) throw new Error("交易引擎路径无效");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, endpoint.startsWith("/api/backtests") && method === "POST" ? 120000 : 60000);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(url, {
      method, redirect: "error", signal: controller.signal,
      // 身份只能来自验证后的 OOAPI JWT / harness ctx.user，不能透传浏览器头。
      headers: { "Content-Type": "application/json", "X-OOAPI-Bridge": bridgeKey, "X-OOAPI-User": String(userId) },
      body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(body || {}),
    });
    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail;
      const message = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((it) => it.msg).join("；") : "交易引擎请求失败";
      throw Object.assign(new Error(message), { status: response.status === 401 ? 502 : response.status });
    }
    return data;
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error("已停止"), { code: "ABORTED" });
    if (e.status) throw e;
    const timeout = controller.signal.aborted;
    throw Object.assign(new Error(timeout ? "请求超时，订单请先查询状态，勿重复下单" : "交易引擎未连接，请检查本机服务"), { status: timeout ? 504 : 503 });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
