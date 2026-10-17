"""下载币安 USDT-M 公开 K 线 / 资金费 / 交易对规则，供离线研究使用。

走本机代理 127.0.0.1:7897。数据只读、公开，不需要密钥。

输出：
  research/data/klines/<SYMBOL>_<TF>.csv
  research/data/funding/<SYMBOL>.csv
  research/data/exchange_info.json

CSV 列：open_time_ms,open,high,low,close,volume,quote_volume,trades
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROXY = "http://127.0.0.1:7897"
BASE = "https://fapi.binance.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "LINKUSDT", "KORUUSDT",
]
TIMEFRAMES = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000}
DAYS = 180

opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
)


def get(path: str, params: dict | None = None) -> object:
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(6):
        try:
            with opener.open(url, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code in (418, 429):
                wait = 2 ** attempt
                print(f"    rate limited ({exc.code}), sleep {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            raise
        except Exception as exc:  # 网络抖动
            wait = 2 ** attempt
            print(f"    {exc}, retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed: {url}")


def download_klines(symbol: str, tf: str, interval_ms: int) -> None:
    out = os.path.join(DATA, "klines", f"{symbol}_{tf}.csv")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    end = int(time.time() * 1000)
    start = end - DAYS * 86_400_000
    rows: list[list] = []
    cursor = start
    while cursor < end:
        batch = get("/fapi/v1/klines", {
            "symbol": symbol, "interval": tf, "startTime": cursor,
            "endTime": end, "limit": 1500,
        })
        if not batch:
            break
        rows.extend(batch)
        next_cursor = int(batch[-1][0]) + interval_ms
        if next_cursor <= cursor:
            break
        cursor = next_cursor
        time.sleep(0.12)
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["open_time", "open", "high", "low", "close",
                    "volume", "quote_volume", "trades"])
        for r in rows:
            w.writerow([r[0], r[1], r[2], r[3], r[4], r[5], r[7], r[8]])
    print(f"  {symbol:10s} {tf:3s} bars={len(rows):7d} -> {out}")


def download_funding(symbol: str) -> None:
    out = os.path.join(DATA, "funding", f"{symbol}.csv")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    rows = get("/fapi/v1/fundingRate", {"symbol": symbol, "limit": 1000})
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["funding_time", "funding_rate"])
        for r in rows:
            w.writerow([r["fundingTime"], r["fundingRate"]])
    print(f"  {symbol:10s} funding={len(rows):4d}")


def main() -> None:
    t0 = time.time()
    print("规则 / exchangeInfo")
    info = get("/fapi/v1/exchangeInfo")
    with open(os.path.join(DATA, "exchange_info.json"), "w") as fh:
        json.dump(info, fh, indent=1)

    for sym in SYMBOLS:
        print(f"下载 {sym}")
        for tf, ms in TIMEFRAMES.items():
            download_klines(sym, tf, ms)
        download_funding(sym)
    print(f"完成，用时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
