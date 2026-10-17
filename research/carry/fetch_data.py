"""Fetch Binance spot 1h klines and extended funding history for the carry study.

Network access requires HTTPS_PROXY=http://127.0.0.1:7897.
Spot klines go to research/data/spot/ (as instructed).
Extended funding history goes to research/carry/funding_ext/ so that the
pre-existing research/data/funding/ files are left untouched.
"""
import json
import os
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SPOT_DIR = os.path.join(ROOT, "research", "data", "spot")
FUND_DIR = os.path.join(ROOT, "research", "carry", "funding_ext")
PERP_DIR = os.path.join(ROOT, "research", "carry", "perp_ext")

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "BNBUSDT", "ADAUSDT", "LINKUSDT"]
START_MS = 1776470400000  # 2026-04-18 00:00 UTC
END_MS = 1792280000000    # past 2026-10-17


def get(url, tries=5):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"failed {url}: {last}")


def fetch_spot(sym):
    rows = []
    start = START_MS
    while start < END_MS:
        url = (f"https://api.binance.com/api/v3/klines?symbol={sym}"
               f"&interval=1h&limit=1000&startTime={start}")
        batch = get(url)
        if not batch:
            break
        rows.extend(batch)
        nxt = batch[-1][0] + 3600_000
        if nxt <= start:
            break
        start = nxt
        if len(batch) < 1000:
            break
        time.sleep(0.15)
    out = []
    seen = set()
    for r in rows:
        if r[0] in seen:
            continue
        seen.add(r[0])
        out.append([r[0], r[1], r[2], r[3], r[4], r[5], r[7], r[8]])
    path = os.path.join(SPOT_DIR, f"{sym}_1h.csv")
    with open(path, "w", encoding="utf-8") as f:
        f.write("open_time,open,high,low,close,volume,quote_volume,trades\n")
        for r in out:
            f.write(",".join(str(x) for x in r) + "\n")
    print(f"spot {sym}: {len(out)} rows {out[0][0]} .. {out[-1][0]} -> {path}")
    return out


def fetch_funding(sym):
    rows = []
    start = START_MS
    while start < END_MS:
        url = (f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={sym}"
               f"&startTime={start}&limit=1000")
        batch = get(url)
        if not batch:
            break
        rows.extend(batch)
        nxt = batch[-1]["fundingTime"] + 1
        if nxt <= start:
            break
        start = nxt
        if len(batch) < 1000:
            break
        time.sleep(0.15)
    seen = set()
    out = []
    for r in rows:
        if r["fundingTime"] in seen:
            continue
        seen.add(r["fundingTime"])
        out.append((r["fundingTime"], r["fundingRate"]))
    out.sort()
    path = os.path.join(FUND_DIR, f"{sym}.csv")
    with open(path, "w", encoding="utf-8") as f:
        f.write("funding_time,funding_rate\n")
        for t, rate in out:
            f.write(f"{t},{rate}\n")
    print(f"funding {sym}: {len(out)} rows {out[0][0]} .. {out[-1][0]} -> {path}")
    return out


def fetch_perp(sym):
    """1h futures klines into carry/perp_ext, so research/data/klines stays untouched."""
    rows = []
    start = START_MS
    while start < END_MS:
        url = (f"https://fapi.binance.com/fapi/v1/klines?symbol={sym}"
               f"&interval=1h&limit=1000&startTime={start}")
        batch = get(url)
        if not batch:
            break
        rows.extend(batch)
        nxt = batch[-1][0] + 3600_000
        if nxt <= start:
            break
        start = nxt
        if len(batch) < 1000:
            break
        time.sleep(0.15)
    out = []
    seen = set()
    for r in rows:
        if r[0] in seen:
            continue
        seen.add(r[0])
        out.append([r[0], r[1], r[2], r[3], r[4], r[5], r[7], r[8]])
    path = os.path.join(PERP_DIR, f"{sym}_1h.csv")
    with open(path, "w", encoding="utf-8") as f:
        f.write("open_time,open,high,low,close,volume,quote_volume,trades\n")
        for r in out:
            f.write(",".join(str(x) for x in r) + "\n")
    print(f"perp {sym}: {len(out)} rows {out[0][0]} .. {out[-1][0]} -> {path}")
    return out


def main():
    os.makedirs(SPOT_DIR, exist_ok=True)
    os.makedirs(FUND_DIR, exist_ok=True)
    os.makedirs(PERP_DIR, exist_ok=True)
    for sym in SYMBOLS:
        fetch_spot(sym)
        fetch_perp(sym)
        fetch_funding(sym)
    # KORU: funding only (no Binance spot market; excluded from main study)
    fetch_funding("KORUUSDT")


if __name__ == "__main__":
    main()
