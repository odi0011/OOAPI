#!/usr/bin/env python
"""Fetch cross-exchange funding rates and 1h spot/perp klines (public APIs).

Venues: Binance USDT-M futures, Bybit linear/spot, OKX swap/spot.
Coins : BTC ETH SOL XRP DOGE BNB ADA LINK (all listed on all three venues).

Outputs (research/xfunding/ only):
  funding/<venue>_<BASE>.csv           funding_time,funding_rate
  prices/<venue>_<BASE>_<kind>_1h.csv  open_time,open,high,low,close,volume
  fetch_meta.json                      coverage summary

Network: set HTTPS_PROXY=http://127.0.0.1:7897 before running.
No API keys are used or read.
"""
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.dirname(os.path.abspath(__file__))
FUND_DIR = os.path.join(OUT, "funding")
PRICE_DIR = os.path.join(OUT, "prices")

SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "LINK"]
VENUES = ["binance", "bybit", "okx"]

# Fetch a buffer before the simulation start (2026-04-20) so that the 14-day
# rolling-mean sensitivity is warm from the first simulation bar.
FETCH_START = int(datetime(2026, 3, 1, tzinfo=timezone.utc).timestamp() * 1000)
FETCH_END = int(datetime(2026, 10, 17, 12, tzinfo=timezone.utc).timestamp() * 1000)

UA = {"User-Agent": "Mozilla/5.0 (research; public-data only)"}


def get_json(url, tries=6, pause=0.0):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=40) as r:
                data = json.loads(r.read())
            if pause:
                time.sleep(pause)
            return data
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.0 * (i + 1))
    raise RuntimeError(f"failed {url}: {last}")


def bybit_ok(payload):
    if payload.get("retCode") != 0:
        raise RuntimeError(f"bybit error {payload.get('retCode')}: {payload.get('retMsg')}")
    return payload["result"]


def okx_ok(payload):
    if payload.get("code") != "0":
        raise RuntimeError(f"okx error {payload.get('code')}: {payload.get('msg')}")
    return payload["data"]


# --------------------------------------------------------------------------- #
# symbols
# --------------------------------------------------------------------------- #
def sym(venue, base, kind):
    if venue == "binance":
        return f"{base}USDT"
    if venue == "bybit":
        return f"{base}USDT"
    if venue == "okx":
        return f"{base}-USDT-SWAP" if kind == "perp" else f"{base}-USDT"
    raise ValueError(venue)


# --------------------------------------------------------------------------- #
# funding
# --------------------------------------------------------------------------- #
def fetch_funding_binance(base):
    symbol = sym("binance", base, "perp")
    rows, start = [], FETCH_START
    while start < FETCH_END:
        url = ("https://fapi.binance.com/fapi/v1/fundingRate?"
               + urllib.parse.urlencode({"symbol": symbol, "startTime": start,
                                         "limit": 1000}))
        batch = get_json(url, pause=0.12)
        if not batch:
            break
        rows.extend((int(r["fundingTime"]), float(r["fundingRate"])) for r in batch)
        nxt = int(batch[-1]["fundingTime"]) + 1
        if nxt <= start:
            break
        start = nxt
        if len(batch) < 1000:
            break
    return rows


def fetch_funding_bybit(base):
    symbol = sym("bybit", base, "perp")
    rows, end = [], FETCH_END
    while True:
        url = ("https://api.bybit.com/v5/market/funding/history?"
               + urllib.parse.urlencode({"category": "linear", "symbol": symbol,
                                         "limit": 200, "endTime": end}))
        result = bybit_ok(get_json(url, pause=0.12))
        batch = result.get("list", [])
        if not batch:
            break
        rows.extend((int(r["fundingRateTimestamp"]), float(r["fundingRate"]))
                    for r in batch)
        oldest = min(int(r["fundingRateTimestamp"]) for r in batch)
        if oldest <= FETCH_START:
            break
        end = oldest - 1
        if len(batch) < 200 and oldest > FETCH_START:
            # no more history
            break
    return rows


def fetch_funding_okx(base):
    inst = sym("okx", base, "perp")
    rows, after = [], None
    while True:
        params = {"instId": inst, "limit": 100}
        if after is not None:
            params["after"] = after
        url = "https://www.okx.com/api/v5/public/funding-rate-history?" + urllib.parse.urlencode(params)
        batch = okx_ok(get_json(url, pause=0.12))
        if not batch:
            break
        for r in batch:
            rate = r.get("realizedRate") or r.get("fundingRate")
            rows.append((int(r["fundingTime"]), float(rate)))
        oldest = min(int(r["fundingTime"]) for r in batch)
        if oldest <= FETCH_START:
            break
        after = oldest
        if len(batch) < 100 and oldest > FETCH_START:
            break
    return rows


# --------------------------------------------------------------------------- #
# klines
# --------------------------------------------------------------------------- #
def _write_klines(path, rows):
    rows = sorted({int(r[0]): r for r in rows}.values())
    with open(path, "w", encoding="utf-8") as f:
        f.write("open_time,open,high,low,close,volume\n")
        for r in rows:
            f.write(",".join(str(x) for x in r) + "\n")
    return rows


def fetch_kline_binance(base, kind):
    assert kind == "perp"
    symbol = sym("binance", base, kind)
    rows, start = [], FETCH_START
    while start < FETCH_END:
        url = ("https://fapi.binance.com/fapi/v1/klines?"
               + urllib.parse.urlencode({"symbol": symbol, "interval": "1h",
                                         "startTime": start, "limit": 1000}))
        batch = get_json(url, pause=0.10)
        if not batch:
            break
        rows.extend((int(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in batch)
        nxt = int(batch[-1][0]) + 3600_000
        if nxt <= start:
            break
        start = nxt
        if len(batch) < 1000:
            break
    path = os.path.join(PRICE_DIR, f"binance_{base}_{kind}_1h.csv")
    return path, _write_klines(path, rows)


def fetch_kline_bybit(base, kind):
    symbol = sym("bybit", base, kind)
    category = "linear" if kind == "perp" else "spot"
    rows, end = [], FETCH_END
    while True:
        url = ("https://api.bybit.com/v5/market/kline?"
               + urllib.parse.urlencode({"category": category, "symbol": symbol,
                                         "interval": "60", "end": end,
                                         "limit": 1000}))
        batch = bybit_ok(get_json(url, pause=0.10)).get("list", [])
        if not batch:
            break
        rows.extend((int(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in batch)
        oldest = min(int(r[0]) for r in batch)
        if oldest <= FETCH_START:
            break
        end = oldest - 1
        if len(batch) < 1000 and oldest > FETCH_START:
            break
    path = os.path.join(PRICE_DIR, f"bybit_{base}_{kind}_1h.csv")
    return path, _write_klines(path, rows)


def fetch_kline_okx(base, kind):
    inst = sym("okx", base, kind)
    rows, after = [], None
    # recent window first
    url = ("https://www.okx.com/api/v5/market/candles?"
           + urllib.parse.urlencode({"instId": inst, "bar": "1H", "limit": 300}))
    batch = okx_ok(get_json(url, pause=0.30))
    if batch:
        rows.extend((int(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in batch)
        after = min(int(r[0]) for r in batch)
    while after is not None and after > FETCH_START:
        url = ("https://www.okx.com/api/v5/market/history-candles?"
               + urllib.parse.urlencode({"instId": inst, "bar": "1H",
                                         "limit": 100, "after": after}))
        batch = okx_ok(get_json(url, pause=0.30))
        if not batch:
            break
        rows.extend((int(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in batch)
        oldest = min(int(r[0]) for r in batch)
        if oldest >= after:
            break
        after = oldest
    path = os.path.join(PRICE_DIR, f"okx_{base}_{kind}_1h.csv")
    return path, _write_klines(path, rows)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def write_funding(venue, base, rows):
    rows = sorted({int(t): float(r) for t, r in rows}.items())
    path = os.path.join(FUND_DIR, f"{venue}_{base}.csv")
    with open(path, "w", encoding="utf-8") as f:
        f.write("funding_time,funding_rate\n")
        for t, r in rows:
            f.write(f"{t},{r:.12g}\n")
    return path, rows


def main():
    os.makedirs(FUND_DIR, exist_ok=True)
    os.makedirs(PRICE_DIR, exist_ok=True)
    meta = {"fetch_start_ms": FETCH_START, "fetch_end_ms": FETCH_END,
            "symbols": SYMBOLS, "venues": VENUES, "funding": {}, "prices": {}}

    fetchers = {"binance": fetch_funding_binance,
                "bybit": fetch_funding_bybit,
                "okx": fetch_funding_okx}
    for base in SYMBOLS:
        for venue in VENUES:
            try:
                rows = fetchers[venue](base)
                path, rows = write_funding(venue, base, rows)
                if not rows:
                    raise RuntimeError("no rows")
                diffs = sorted({round((b[0] - a[0]) / 3600_000.0, 3)
                                for a, b in zip(rows, rows[1:])})
                meta["funding"][f"{venue}_{base}"] = {
                    "n": len(rows),
                    "first_ms": rows[0][0], "last_ms": rows[-1][0],
                    "interval_hours_seen": diffs[:8],
                }
                print(f"funding {venue:8s} {base:5s} n={len(rows):4d} "
                      f"first={datetime.utcfromtimestamp(rows[0][0]/1000):%Y-%m-%d} "
                      f"last={datetime.utcfromtimestamp(rows[-1][0]/1000):%Y-%m-%d}")
            except Exception as e:  # noqa: BLE001
                print(f"FUNDING FAIL {venue} {base}: {e}")
                meta["funding"][f"{venue}_{base}"] = {"error": str(e)}

    kline_jobs = [("binance", "perp", fetch_kline_binance),
                  ("bybit", "spot", fetch_kline_bybit),
                  ("bybit", "perp", fetch_kline_bybit),
                  ("okx", "spot", fetch_kline_okx),
                  ("okx", "perp", fetch_kline_okx)]
    for base in SYMBOLS:
        for venue, kind, fn in kline_jobs:
            try:
                path, rows = fn(base, kind)
                meta["prices"][f"{venue}_{base}_{kind}"] = {
                    "n": len(rows), "first_ms": rows[0][0],
                    "last_ms": rows[-1][0], "path": os.path.basename(path)}
                print(f"kline   {venue:8s} {base:5s} {kind:4s} n={len(rows):5d} "
                      f"first={datetime.utcfromtimestamp(rows[0][0]/1000):%Y-%m-%d} "
                      f"last={datetime.utcfromtimestamp(rows[-1][0]/1000):%Y-%m-%d}")
            except Exception as e:  # noqa: BLE001
                print(f"KLINE FAIL {venue} {base} {kind}: {e}")
                meta["prices"][f"{venue}_{base}_{kind}"] = {"error": str(e)}

    with open(os.path.join(OUT, "fetch_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"\nwrote {OUT}/fetch_meta.json")


if __name__ == "__main__":
    main()
