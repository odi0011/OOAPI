"""Download long-history Binance USDT-M perpetual klines (1d & 4h).

Usage:
    HTTPS_PROXY=http://127.0.0.1:7897 python research/longterm/download.py

Cache-aware: existing CSV files are resumed from the last stored bar.
Rate limit: 150 ms between requests.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import pandas as pd

BASE_URL = "https://fapi.binance.com/fapi/v1/klines"
SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "LINK", "AVAX", "DOT",
    "LTC", "BCH", "TRX", "ETC", "ATOM", "UNI", "NEAR", "APT", "ARB", "OP",
]
# first futures listing dates are discovered from the API (start early, it truncates)
START_MS = int(datetime(2019, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
END_MS = int(time.time() * 1000)
INTERVALS = {"1d": 24 * 3600 * 1000, "4h": 4 * 3600 * 1000}
LIMIT = 1500
SLEEP = 0.15

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "data", "longterm"))

COLS = ["open_time", "open", "high", "low", "close", "volume",
        "close_time", "quote_volume", "trades", "taker_buy_base",
        "taker_buy_quote", "ignore"]


def make_opener():
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    return urllib.request.build_opener(*handlers)


OPENER = make_opener()


def fetch(symbol, interval, start_ms):
    url = (f"{BASE_URL}?symbol={symbol}USDT&interval={interval}"
           f"&startTime={start_ms}&endTime={END_MS}&limit={LIMIT}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    last_err = None
    for attempt in range(5):
        try:
            with OPENER.open(req, timeout=40) as resp:
                data = json.load(resp)
            if isinstance(data, dict):  # API error payload
                raise RuntimeError(f"API error: {data}")
            return data
        except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
            last_err = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed {symbol} {interval}: {last_err}")


def load_existing(path):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return None
    try:
        df = pd.read_csv(path)
    except Exception:
        return None
    if df.empty or "open_time" not in df.columns:
        return None
    return df


def download_symbol(symbol, interval):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{symbol}_{interval}.csv")
    existing = load_existing(path)
    step = INTERVALS[interval]

    if existing is not None:
        last_open = int(pd.Timestamp(existing["open_time"].iloc[-1]).timestamp() * 1000)
        start = last_open + step
        rows = []
        if start >= END_MS - step:
            print(f"{symbol:5s} {interval:2s} cached  {existing['open_time'].iloc[0]} -> "
                  f"{existing['open_time'].iloc[-1]}  bars={len(existing)}")
            return
    else:
        start = START_MS
        rows = []

    n_new = 0
    while start < END_MS:
        chunk = fetch(symbol, interval, start)
        if not chunk:
            break
        rows.extend(chunk)
        n_new += len(chunk)
        last_close = int(chunk[-1][6])
        start = last_close + 1
        if len(chunk) < LIMIT:
            break
        time.sleep(SLEEP)

    if not rows:
        if existing is not None:
            print(f"{symbol:5s} {interval:2s} cached  bars={len(existing)} (no new)")
            return
        print(f"{symbol:5s} {interval:2s} NO DATA")
        return

    new_df = pd.DataFrame(rows, columns=COLS)
    if existing is not None:
        new_df = pd.concat([existing, new_df], ignore_index=True)
    new_df = new_df.drop_duplicates(subset="open_time", keep="last")
    new_df = new_df.sort_values("open_time").reset_index(drop=True)

    for c in ["open", "high", "low", "close", "volume", "quote_volume",
              "taker_buy_base", "taker_buy_quote"]:
        new_df[c] = pd.to_numeric(new_df[c], errors="coerce")
    new_df["trades"] = pd.to_numeric(new_df["trades"], errors="coerce").astype("Int64")
    new_df["open_time"] = pd.to_datetime(new_df["open_time"], unit="ms", utc=True)
    new_df["close_time"] = pd.to_datetime(new_df["close_time"], unit="ms", utc=True)
    new_df = new_df.drop(columns=["ignore"])

    new_df.to_csv(path, index=False, float_format="%.10g")
    print(f"{symbol:5s} {interval:2s} saved   {new_df['open_time'].iloc[0]} -> "
          f"{new_df['open_time'].iloc[-1]}  bars={len(new_df)} (+{n_new})")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"output: {OUT_DIR}")
    print(f"range : {datetime.fromtimestamp(START_MS/1000, timezone.utc):%Y-%m-%d} -> "
          f"{datetime.fromtimestamp(END_MS/1000, timezone.utc):%Y-%m-%d}")
    for interval in INTERVALS:
        for sym in SYMBOLS:
            try:
                download_symbol(sym, interval)
            except Exception as exc:
                print(f"{sym:5s} {interval:2s} FAILED: {exc}", file=sys.stderr)
            time.sleep(SLEEP)


if __name__ == "__main__":
    main()
