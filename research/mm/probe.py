#!/usr/bin/env python
"""Binance USDT-M order-book market-making feasibility probe.

Stdlib only, so it can be run with ``python -I`` (the downloaded zip/csv files
are treated as untrusted data and are only parsed, never executed).

Modes
-----
  python probe.py history [--date 2026-10-15]
      Probe data.binance.vision availability and summarise one day of
      futures/um daily bookDepth (percentage-level snapshots every 30 s).

  python probe.py sample [--seconds 600] [--hz 1.0]
      Live REST sampling of bookTicker + depth(limit=20) + recent trades for
      BTC/ETH/SOL/DOGE.  Writes samples.csv, trades.csv, sampling_meta.json,
      exchange_filters.json.

  python probe.py analyze
      Spread / depth / trade-arrival / adverse-selection markout analysis of the
      live sample.  Writes analysis_summary.csv, markout.csv, regimes.csv and
      prints a readable summary.

No API keys are used and no orders are placed.
"""

import argparse
import bisect
import csv
import io
import json
import math
import os
import statistics
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
RAW_DIR = BASE_DIR / "raw"
FAPI = "https://fapi.binance.com"
VISION = "https://data.binance.vision"
S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"]
FEE_BP = 2.0                    # maker fee per side, basis points
MARKOUT_HORIZONS_S = [0, 1, 5, 30]

SAMPLES_CSV = BASE_DIR / "samples.csv"
TRADES_CSV = BASE_DIR / "trades.csv"
META_JSON = BASE_DIR / "sampling_meta.json"
FILTERS_JSON = BASE_DIR / "exchange_filters.json"
HISTORY_CSV = BASE_DIR / "history_depth.csv"
HISTORY_JSON = BASE_DIR / "history_probe.json"
HISTORY_BT_CSV = BASE_DIR / "history_bookticker_2024.csv"
ANALYSIS_CSV = BASE_DIR / "analysis_summary.csv"
MARKOUT_CSV = BASE_DIR / "markout.csv"
REGIME_CSV = BASE_DIR / "regimes.csv"

UA = "mm-feasibility-probe/1.0"


# ----------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------
def http_get(url, timeout=25, method="GET", retries=3):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read() if method != "HEAD" else b""
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                return {
                    "ok": True, "status": resp.status, "body": body,
                    "elapsed_ms": elapsed_ms,
                    "weight": resp.headers.get("x-mbx-used-weight-1m"),
                }
        except urllib.error.HTTPError as exc:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            last = {"ok": False, "status": exc.code, "body": b"",
                    "elapsed_ms": elapsed_ms, "error": f"HTTP {exc.code}",
                    "weight": exc.headers.get("x-mbx-used-weight-1m") if exc.headers else None}
            if exc.code == 404:
                return last
        except Exception as exc:  # noqa: BLE001 - network probe must not die
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            last = {"ok": False, "status": None, "body": b"",
                    "elapsed_ms": elapsed_ms, "error": repr(exc), "weight": None}
        time.sleep(0.4 * (attempt + 1))
    return last


def get_json(url, timeout=25):
    r = http_get(url, timeout=timeout)
    if not r["ok"]:
        raise RuntimeError(f"GET {url} failed: {r.get('error') or r.get('status')}")
    return json.loads(r["body"].decode("utf-8")), r


def quantile(values, q):
    if not values:
        return float("nan")
    s = sorted(values)
    pos = (len(s) - 1) * q
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(s) - 1)
    frac = pos - lo
    return s[lo] * (1.0 - frac) + s[hi] * frac


def mean(values):
    return sum(values) / len(values) if values else float("nan")


def fmt(v, nd=4):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "nan"
    return f"{v:.{nd}f}"


def write_csv(path, fieldnames, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k) for k in fieldnames})
    print(f"[write] {path} ({len(rows)} rows)")


# ----------------------------------------------------------------------------
# history probe / bookDepth summary
# ----------------------------------------------------------------------------
def s3_prefixes(prefix):
    url = f"{S3}?delimiter=/&prefix={urllib.parse.quote(prefix)}&max-keys=100"
    r = http_get(url)
    if not r["ok"]:
        return []
    root = ET.fromstring(r["body"])
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    out = []
    for cp in root.findall("s3:CommonPrefixes", ns):
        p = cp.find("s3:Prefix", ns)
        if p is not None and p.text:
            out.append(p.text)
    return out


def download_bookdepth(symbol, date):
    name = f"{symbol}-bookDepth-{date}.zip"
    url = f"{VISION}/data/futures/um/daily/bookDepth/{symbol}/{name}"
    dest = RAW_DIR / name
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    r = http_get(url, timeout=120)
    if not r["ok"]:
        raise RuntimeError(f"download failed {symbol} {date}: {r.get('error') or r.get('status')}")
    dest.write_bytes(r["body"])
    return dest


def summarise_bookdepth(zip_path, symbol, date):
    rows = []
    with zipfile.ZipFile(zip_path) as zf:
        member = zf.namelist()[0]
        with zf.open(member) as fh:
            text = io.TextIOWrapper(fh, encoding="utf-8-sig")
            for rec in csv.DictReader(text):
                try:
                    rows.append((rec["timestamp"], float(rec["percentage"]),
                                 float(rec["depth"]), float(rec["notional"])))
                except (KeyError, ValueError):
                    continue
    levels = {}
    for ts, pct, depth, notional in rows:
        levels.setdefault(pct, []).append((notional, depth))
    out = []
    for pct in (-5.0, -2.0, -1.0, -0.2, 0.2, 1.0, 2.0, 5.0):
        vals = levels.get(pct, [])
        if not vals:
            continue
        notionals = [v[0] for v in vals]
        depths = [v[1] for v in vals]
        out.append({
            "symbol": symbol, "date": date, "percentage": pct,
            "n_snapshots": len(vals),
            "median_notional_usd": quantile(notionals, 0.5),
            "p10_notional_usd": quantile(notionals, 0.1),
            "p90_notional_usd": quantile(notionals, 0.9),
            "median_depth_base": quantile(depths, 0.5),
        })
    return out


def cmd_history(args):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    report = {"data_types": [], "availability": {}, "bookticker_archive": {}}

    report["data_types"] = s3_prefixes("data/futures/um/daily/")

    # bookTicker archive cutoff (daily vs monthly)
    for d in ("2024-03-30", "2024-03-31", "2024-06-01"):
        url = f"{VISION}/data/futures/um/daily/bookTicker/BTCUSDT/BTCUSDT-bookTicker-{d}.zip"
        r = http_get(url, method="HEAD")
        report["bookticker_archive"][f"daily_{d}"] = r["status"]
    for m in ("2024-03", "2024-04", "2024-12", "2026-09"):
        url = f"{VISION}/data/futures/um/monthly/bookTicker/BTCUSDT/BTCUSDT-bookTicker-{m}.zip"
        r = http_get(url, method="HEAD")
        report["bookticker_archive"][f"monthly_{m}"] = r["status"]

    for sym in SYMBOLS:
        report["availability"][sym] = {}
        for d in (args.date, "2026-10-15", "2025-10-15"):
            url = f"{VISION}/data/futures/um/daily/bookDepth/{sym}/{sym}-bookDepth-{d}.zip"
            r = http_get(url, method="HEAD")
            report["availability"][sym][d] = r["status"]

    all_rows = []
    for sym in SYMBOLS:
        zp = download_bookdepth(sym, args.date)
        try:
            all_rows.extend(summarise_bookdepth(zp, sym, args.date))
        except Exception as exc:  # noqa: BLE001
            print(f"[history] {sym} parse failed: {exc}")

    if all_rows:
        write_csv(HISTORY_CSV, list(all_rows[0].keys()), all_rows)
    with open(HISTORY_JSON, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"[write] {HISTORY_JSON}")
    print(json.dumps(report, indent=2))

    print("\nbookDepth medians (USD notional at level):")
    for sym in SYMBOLS:
        sub = {r["percentage"]: r for r in all_rows if r["symbol"] == sym}
        if not sub:
            continue
        print(f"  {sym:9s} " + "  ".join(
            f"{pct:+.1f}%={sub[pct]['median_notional_usd']/1e6:9.2f}M"
            for pct in (-1.0, -0.2, 0.2, 1.0) if pct in sub))


# ----------------------------------------------------------------------------
# last available historical bookTicker (monthly 2024-04 is a partial day)
# ----------------------------------------------------------------------------
def download_bookticker(symbol, month):
    name = f"{symbol}-bookTicker-{month}.zip"
    url = f"{VISION}/data/futures/um/monthly/bookTicker/{symbol}/{name}"
    dest = RAW_DIR / name
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    r = http_get(url, timeout=600)
    if not r["ok"]:
        raise RuntimeError(f"download failed {symbol} {month}: {r.get('error') or r.get('status')}")
    dest.write_bytes(r["body"])
    return dest


def cmd_bookticker(args):
    """Event-level spread distribution from the last archived bookTicker month.

    Fields: update_id, best_bid_price, best_bid_qty, best_ask_price,
    best_ask_qty, transaction_time, event_time.
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    rows_out = []
    for sym in SYMBOLS:
        zp = download_bookticker(sym, args.month)
        with zipfile.ZipFile(zp) as zf:
            with zf.open(zf.namelist()[0]) as fh:
                text = io.TextIOWrapper(fh, encoding="utf-8-sig")
                rd = csv.reader(text)
                next(rd)
                n = 0
                sample = []
                gt2 = gt4 = 0
                wtot = w4 = 0.0
                mx = 0.0
                prev_t = prev_sp = None
                t0 = t1 = None
                for row in rd:
                    n += 1
                    try:
                        bid = float(row[1])
                        ask = float(row[3])
                        et = int(row[6])
                        if bid <= 0 or ask <= bid:
                            continue
                        mid = (bid + ask) / 2.0
                        sp = (ask - bid) / mid * 1e4
                    except (ValueError, IndexError):
                        continue
                    if t0 is None:
                        t0 = et
                    t1 = et
                    if sp > 2:
                        gt2 += 1
                    if sp > 4:
                        gt4 += 1
                    if sp > mx:
                        mx = sp
                    if n % 10 == 0:
                        sample.append(sp)
                    if prev_t is not None:
                        dt = min(max((et - prev_t) / 1000.0, 0.0), 1.0)
                        wtot += dt
                        if prev_sp > 4:
                            w4 += dt
                    prev_t, prev_sp = et, sp
        if not sample:
            continue
        s = sorted(sample)
        L = len(s)
        rows_out.append({
            "symbol": sym, "month": args.month, "rows": n,
            "start_utc": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t0 / 1000)),
            "end_utc": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t1 / 1000)),
            "median_bp": statistics.median(s),
            "mean_sample_bp": sum(s) / L,
            "p99_bp": s[int(0.99 * (L - 1))],
            "p999_bp": s[int(0.999 * (L - 1))],
            "max_bp": mx,
            "pct_rows_gt2bp": gt2 / max(n, 1) * 100.0,
            "pct_rows_gt4bp": gt4 / max(n, 1) * 100.0,
            "pct_time_gt4bp": (w4 / wtot * 100.0) if wtot else float("nan"),
        })
        print(f"[bookticker] {sym} {rows_out[-1]}")

    if rows_out:
        write_csv(HISTORY_BT_CSV, list(rows_out[0].keys()), rows_out)


# ----------------------------------------------------------------------------
# live sampling
# ----------------------------------------------------------------------------
def fetch_exchange_filters():
    info, _ = get_json(f"{FAPI}/fapi/v1/exchangeInfo", timeout=30)
    out = {}
    for s in info.get("symbols", []):
        if s["symbol"] not in SYMBOLS:
            continue
        filters = {f["filterType"]: f for f in s.get("filters", [])}
        out[s["symbol"]] = {
            "tick_size": float(filters.get("PRICE_FILTER", {}).get("tickSize", "nan")),
            "step_size": float(filters.get("LOT_SIZE", {}).get("stepSize", "nan")),
            "min_notional": float(filters.get("MIN_NOTIONAL", {}).get("notional", "nan")),
        }
    with open(FILTERS_JSON, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print(f"[write] {FILTERS_JSON}: {out}")
    return out


def parse_trade_rows(sym, payload, recv_ms, seen_ids):
    rows = []
    for t in payload:
        tid = t.get("id")
        if tid in seen_ids:
            continue
        seen_ids.add(tid)
        rows.append({
            "symbol": sym,
            "trade_id": tid,
            "trade_time_ms": int(t["time"]),
            "price": float(t["price"]),
            "qty": float(t["qty"]),
            "quote_qty": float(t.get("quoteQty", float(t["price"]) * float(t["qty"]))),
            "is_buyer_maker": bool(t["isBuyerMaker"]),
            "recv_ms": recv_ms,
        })
    return rows


class Sampler:
    def __init__(self, seconds, hz):
        self.seconds = seconds
        self.hz = hz
        self.lock = threading.Lock()
        self.samples = []
        self.trades = []
        self.errors = []
        self.request_times = {"bookTicker": [], "depth": [], "trades": []}
        self.max_weight = 0
        self.stop = threading.Event()
        self.trade_every_ticks = max(1, int(round(2.0 * hz)))  # ~2 s
        self.depth_every_ticks = max(1, int(round(5.0 * hz)))  # ~5 s
        self.seen = {s: set() for s in SYMBOLS}
        self.last_trade_id = {s: None for s in SYMBOLS}
        self.trade_gaps = {s: 0 for s in SYMBOLS}
        self.n_requests = 0
        self.filters = {}

    def _record_weight(self, w):
        if w is None:
            return
        try:
            self.max_weight = max(self.max_weight, int(w))
        except ValueError:
            pass

    def _fetch_bookticker(self, sym):
        url = f"{FAPI}/fapi/v1/ticker/bookTicker?symbol={sym}"
        r = http_get(url, timeout=15)
        self._record_weight(r.get("weight"))
        if not r["ok"]:
            return None, r
        d = json.loads(r["body"].decode())
        return {
            "bt_time_ms": int(d.get("time", 0)),
            "bt_bid": float(d["bidPrice"]),
            "bt_ask": float(d["askPrice"]),
            "bt_bid_qty": float(d["bidQty"]),
            "bt_ask_qty": float(d["askQty"]),
            "bt_last_update_id": d.get("lastUpdateId"),
        }, r

    def _fetch_depth(self, sym):
        url = f"{FAPI}/fapi/v1/depth?symbol={sym}&limit=20"
        r = http_get(url, timeout=15)
        self._record_weight(r.get("weight"))
        if not r["ok"]:
            return None, r
        d = json.loads(r["body"].decode())
        bids = [(float(p), float(q)) for p, q in d.get("bids", [])[:5]]
        asks = [(float(p), float(q)) for p, q in d.get("asks", [])[:5]]
        if not bids or not asks:
            return None, r
        return {
            "d_E_ms": int(d.get("E", 0)),
            "d_T_ms": int(d.get("T", 0)),
            "d_bid": bids[0][0], "d_ask": asks[0][0],
            "d_bid_qty": bids[0][1], "d_ask_qty": asks[0][1],
            "bid_notional5": sum(p * q for p, q in bids),
            "ask_notional5": sum(p * q for p, q in asks),
            "bid_qty5": sum(q for _, q in bids),
            "ask_qty5": sum(q for _, q in asks),
            "depth_last_update_id": d.get("lastUpdateId"),
        }, r

    def _fetch_trades(self, sym):
        url = f"{FAPI}/fapi/v1/trades?symbol={sym}&limit=1000"
        r = http_get(url, timeout=15)
        self._record_weight(r.get("weight"))
        if not r["ok"]:
            return None, r
        payload = json.loads(r["body"].decode())
        if payload:
            ids = [int(t["id"]) for t in payload]
            oldest, newest = min(ids), max(ids)
            prev = self.last_trade_id[sym]
            if prev is not None and oldest > prev + 1:
                # more than 1000 trades arrived between polls
                self.trade_gaps[sym] += 1
            self.last_trade_id[sym] = max(newest, prev or newest)
        return payload, r

    def worker(self, sym, executor, start_ms):
        next_t = time.monotonic()
        end = next_t + self.seconds
        tick_i = 0
        interval = 1.0 / self.hz
        last_depth = None
        while not self.stop.is_set() and time.monotonic() < end:
            recv_ms = int(time.time() * 1000)
            futs = {
                # bookTicker is the only endpoint needed every tick; it carries
                # best bid/ask and top-of-book size.
                "bookTicker": executor.submit(self._fetch_bookticker, sym),
            }
            # Depth (5 levels) is slow-moving, ~5 s is enough for capacity stats.
            if tick_i % self.depth_every_ticks == 0:
                futs["depth"] = executor.submit(self._fetch_depth, sym)
            # Trades are polled at ~0.5 Hz; limit=1000 covers >1000 trades/2 s.
            if tick_i % self.trade_every_ticks == 0:
                futs["trades"] = executor.submit(self._fetch_trades, sym)
            res = {}
            for kind, fut in futs.items():
                try:
                    data, r = fut.result(timeout=20)
                except Exception as exc:  # noqa: BLE001
                    data, r = None, {"ok": False, "error": repr(exc), "elapsed_ms": float("nan")}
                res[kind] = data
                with self.lock:
                    self.n_requests += 1
                    if r.get("elapsed_ms") is not None:
                        self.request_times[kind].append(r["elapsed_ms"])
                    if not r.get("ok"):
                        self.errors.append({"symbol": sym, "kind": kind,
                                            "error": r.get("error"), "ts": recv_ms})

            bt = res.get("bookTicker")
            dp = res.get("depth")
            if dp:
                last_depth = dp
            else:
                dp = last_depth
            if bt and dp and bt["bt_bid"] > 0 and bt["bt_ask"] > bt["bt_bid"]:
                mid = (bt["bt_bid"] + bt["bt_ask"]) / 2.0
                row = {
                    "symbol": sym,
                    "ts_local_ms": int(time.time() * 1000),
                    **bt, **dp,
                    "mid": mid,
                    "spread_bp": (bt["bt_ask"] - bt["bt_bid"]) / mid * 1e4,
                    "bid_notional_top": bt["bt_bid"] * bt["bt_bid_qty"],
                    "ask_notional_top": bt["bt_ask"] * bt["bt_ask_qty"],
                    "book_ask_minus_depth_bid_ticks": float("nan"),
                }
                with self.lock:
                    self.samples.append(row)

            tr = res.get("trades")
            if tr:
                rows = parse_trade_rows(sym, tr, recv_ms, self.seen[sym])
                if rows:
                    with self.lock:
                        self.trades.extend(rows)

            tick_i += 1
            next_t += interval
            now = time.monotonic()
            if next_t < now:
                # Do not skip a whole slot when a request overruns; start the next
                # cycle immediately so the effective cadence is max(RTT, interval).
                next_t = now
            time.sleep(max(0.0, next_t - time.monotonic()))

    def run(self):
        self.filters = fetch_exchange_filters()
        start_ms = int(time.time() * 1000)
        meta = {
            "start_ms": start_ms,
            "start_iso_local": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(start_ms / 1000)),
            "seconds_requested": self.seconds,
            "hz_requested": self.hz,
            "symbols": SYMBOLS,
            "fee_bp_per_side": FEE_BP,
        }
        print(f"[sample] start {meta['start_iso_local']} for {self.seconds}s at {self.hz} Hz")

        sample_fields = [
            "symbol", "ts_local_ms", "bt_time_ms", "bt_bid", "bt_ask", "bt_bid_qty",
            "bt_ask_qty", "bt_last_update_id", "d_E_ms", "d_T_ms", "d_bid", "d_ask",
            "d_bid_qty", "d_ask_qty", "depth_last_update_id", "bid_notional5",
            "ask_notional5", "bid_qty5", "ask_qty5", "mid", "spread_bp",
            "bid_notional_top", "ask_notional_top",
        ]
        trade_fields = ["symbol", "trade_id", "trade_time_ms", "price", "qty",
                        "quote_qty", "is_buyer_maker", "recv_ms"]
        s_fh = open(SAMPLES_CSV, "w", newline="", encoding="utf-8")
        t_fh = open(TRADES_CSV, "w", newline="", encoding="utf-8")
        s_w = csv.DictWriter(s_fh, fieldnames=sample_fields, extrasaction="ignore")
        t_w = csv.DictWriter(t_fh, fieldnames=trade_fields, extrasaction="ignore")
        s_w.writeheader()
        t_w.writeheader()
        s_fh.flush()
        t_fh.flush()

        with ThreadPoolExecutor(max_workers=16) as executor:
            threads = [threading.Thread(target=self.worker, args=(s, executor, start_ms), daemon=True)
                       for s in SYMBOLS]
            for th in threads:
                th.start()
            last_report = time.monotonic()
            n_s_written = n_t_written = 0
            while any(th.is_alive() for th in threads):
                time.sleep(2.0)
                with self.lock:
                    bs = self.samples
                    self.samples = []
                    bt = self.trades
                    self.trades = []
                for row in bs:
                    s_w.writerow(row)
                for row in bt:
                    t_w.writerow(row)
                n_s_written += len(bs)
                n_t_written += len(bt)
                s_fh.flush()
                t_fh.flush()
                if time.monotonic() - last_report >= 20:
                    last_report = time.monotonic()
                    print(f"[sample] samples={n_s_written} trades={n_t_written} "
                          f"errors={len(self.errors)} max_weight={self.max_weight}", flush=True)
            for th in threads:
                th.join(timeout=5)

        with self.lock:
            for row in self.samples:
                s_w.writerow(row)
            for row in self.trades:
                t_w.writerow(row)
        s_fh.close()
        t_fh.close()

        meta.update({
            "end_ms": int(time.time() * 1000),
            "n_requests": self.n_requests,
            "errors": len(self.errors),
            "error_examples": self.errors[:10],
            "max_used_weight_1m": self.max_weight,
            "trade_id_gaps": self.trade_gaps,
            "rtt_ms": {k: {"median": quantile(v, 0.5), "p95": quantile(v, 0.95),
                           "n": len(v)} for k, v in self.request_times.items()},
            "exchange_filters": self.filters,
        })
        with open(META_JSON, "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=2)
        print(f"[write] {SAMPLES_CSV}, {TRADES_CSV}, {META_JSON}")
        print(json.dumps(meta.get("rtt_ms"), indent=2))


def cmd_sample(args):
    if args.seconds > 540:
        print("[warn] >540 s sampling may exceed a 10-minute shell timeout; "
              "run in background or use --seconds 480.")
    Sampler(args.seconds, args.hz).run()


# ----------------------------------------------------------------------------
# analysis
# ----------------------------------------------------------------------------
def load_samples():
    by_sym = {}
    with open(SAMPLES_CSV, newline="", encoding="utf-8") as fh:
        for rec in csv.DictReader(fh):
            try:
                local_ms = int(rec["ts_local_ms"])
                bt_ms = int(rec["bt_time_ms"])
                row = {
                    "symbol": rec["symbol"],
                    # exchange event time aligns with trade_time_ms; fall back to receive time
                    "ts": bt_ms if bt_ms > 0 else local_ms,
                    "recv_ts": local_ms,
                    "bid": float(rec["bt_bid"]),
                    "ask": float(rec["bt_ask"]),
                    "bid_qty": float(rec["bt_bid_qty"]),
                    "ask_qty": float(rec["bt_ask_qty"]),
                    "mid": float(rec["mid"]),
                    "spread_bp": float(rec["spread_bp"]),
                    "bid_notional_top": float(rec["bid_notional_top"]),
                    "ask_notional_top": float(rec["ask_notional_top"]),
                    "bid_notional5": float(rec["bid_notional5"]),
                    "ask_notional5": float(rec["ask_notional5"]),
                }
            except (KeyError, ValueError):
                continue
            by_sym.setdefault(row["symbol"], []).append(row)
    for sym in by_sym:
        by_sym[sym].sort(key=lambda r: r["ts"])
    return by_sym


def load_trades():
    by_sym = {}
    with open(TRADES_CSV, newline="", encoding="utf-8") as fh:
        for rec in csv.DictReader(fh):
            try:
                row = {
                    "symbol": rec["symbol"],
                    "id": int(rec["trade_id"]),
                    "time": int(rec["trade_time_ms"]),
                    "price": float(rec["price"]),
                    "qty": float(rec["qty"]),
                    "quote_qty": float(rec["quote_qty"]),
                    "is_buyer_maker": rec["is_buyer_maker"].strip().lower() == "true",
                }
            except (KeyError, ValueError):
                continue
            by_sym.setdefault(row["symbol"], []).append(row)
    for sym in by_sym:
        by_sym[sym].sort(key=lambda r: r["time"])
    return by_sym


def tw_stats(rows, key):
    """Time-weighted mean of a field, plus sample quantiles."""
    vals = [r[key] for r in rows if r[key] == r[key]]
    if not vals:
        return {"n": 0, "tw_mean": float("nan"), "median": float("nan")}
    num = den = 0.0
    for i, r in enumerate(rows):
        dt = (rows[i + 1]["ts"] - r["ts"]) if i + 1 < len(rows) else 0.0
        dt = min(max(dt, 0.0), 5000.0)
        v = r[key]
        if v == v:
            num += v * dt
            den += dt
    return {
        "n": len(vals),
        "tw_mean": num / den if den else float("nan"),
        "median": quantile(vals, 0.5),
        "p10": quantile(vals, 0.1),
        "p90": quantile(vals, 0.9),
        "p99": quantile(vals, 0.99),
        "frac_le_2bp": sum(1 for v in vals if v <= 2.0) / len(vals),
        "frac_le_4bp": sum(1 for v in vals if v <= 4.0) / len(vals),
    }


def markout_for_symbol(sym, samples, trades, fee_bp, tick=None):
    ts_list = [r["ts"] for r in samples]
    mids = [r["mid"] for r in samples]
    spreads = [r["spread_bp"] for r in samples]
    out = {}
    fills = []
    for tr in trades:
        t = tr["time"]
        i = bisect.bisect_right(ts_list, t) - 1
        if i < 0 or t - ts_list[i] > 3000:
            continue
        mid0 = mids[i]
        side = 1.0 if tr["is_buyer_maker"] else -1.0  # maker side
        price = tr["price"]
        rec = {"symbol": sym, "side": side, "price": price, "qty": tr["qty"],
               "quote_qty": tr["quote_qty"], "mid0": mid0,
               "spread_bp": spreads[i],
               "dist_ticks": abs(price - mid0) / tick if tick else float("nan"),
               "gross0_bp": side * (mid0 - price) / mid0 * 1e4}
        ok = True
        for h in MARKOUT_HORIZONS_S:
            target = t + h * 1000
            j = bisect.bisect_right(ts_list, target) - 1
            if j < 0 or target - ts_list[j] > 3000 or j > len(ts_list) - 1:
                ok = False
                break
            midh = mids[j]
            gross = side * (midh - price) / mid0 * 1e4
            rec[f"gross_{h}s_bp"] = gross
            rec[f"net_{h}s_bp"] = gross - fee_bp
            rec[f"adverse_{h}s_bp"] = side * (mid0 - midh) / mid0 * 1e4
        if ok:
            fills.append(rec)

    out["n_fills"] = len(fills)
    out["fill_quote_usd"] = sum(f["quote_qty"] for f in fills)
    for h in MARKOUT_HORIZONS_S:
        net = [f[f"net_{h}s_bp"] for f in fills]
        adv = [f[f"adverse_{h}s_bp"] for f in fills]
        gross = [f[f"gross_{h}s_bp"] for f in fills]
        w = [f["quote_qty"] for f in fills]
        wsum = sum(w) or 1.0
        out[f"gross_{h}s_mean_bp"] = mean(gross)
        out[f"adverse_{h}s_mean_bp"] = mean(adv)
        out[f"adverse_{h}s_median_bp"] = quantile(adv, 0.5)
        out[f"adverse_{h}s_wmean_bp"] = sum(a * wi for a, wi in zip(adv, w)) / wsum
        out[f"net_{h}s_mean_bp"] = mean(net)
        out[f"net_{h}s_median_bp"] = quantile(net, 0.5)
        out[f"net_{h}s_wmean_bp"] = sum(n * wi for n, wi in zip(net, w)) / wsum
        out[f"net_{h}s_frac_pos"] = (sum(1 for v in net if v > 0) / len(net)) if net else float("nan")
        # clean continuation: mid at t+h has crossed to the wrong side of the fill
        out[f"gross_{h}s_frac_neg"] = (sum(1 for v in gross if v < 0) / len(gross)) if gross else float("nan")
        # continuation probability: mid moved further in the taker's direction
        out[f"adverse_{h}s_frac_pos"] = (sum(1 for v in adv if v > 1e-12) / len(adv)) if adv else float("nan")
        out[f"adverse_{h}s_frac_neg"] = (sum(1 for v in adv if v < -1e-12) / len(adv)) if adv else float("nan")
        if len(net) > 1:
            sd = statistics.pstdev(net)
            out[f"net_{h}s_tstat_naive"] = mean(net) / (sd / math.sqrt(len(net))) if sd > 0 else float("nan")
        else:
            out[f"net_{h}s_tstat_naive"] = float("nan")
    # touch-only robustness: exclude prints far from the last snapshot mid
    # (deep sweeps or a stale mid). A resting order at the touch can only fill
    # at/near the touch, so this is the cleaner fill subset.
    if tick and fills:
        touch = [f for f in fills if f["dist_ticks"] <= 1.0]
        out["touch_n"] = len(touch)
        for h in MARKOUT_HORIZONS_S:
            out[f"touch_gross_{h}s_mean_bp"] = mean([f[f"gross_{h}s_bp"] for f in touch])
            out[f"touch_net_{h}s_mean_bp"] = mean([f[f"net_{h}s_bp"] for f in touch])

    # small vs large aggressor trades: large sweeps are more likely informed
    if fills:
        med_q = quantile([f["quote_qty"] for f in fills], 0.5)
        for label, sub in (("small", [f for f in fills if f["quote_qty"] <= med_q]),
                           ("large", [f for f in fills if f["quote_qty"] > med_q])):
            out[f"{label}_n"] = len(sub)
            for h in (1, 5, 30):
                out[f"{label}_adverse_{h}s_mean_bp"] = mean([f[f"adverse_{h}s_bp"] for f in sub])
                out[f"{label}_net_{h}s_mean_bp"] = mean([f[f"net_{h}s_bp"] for f in sub])
    out["fills"] = fills
    return out


def minute_regimes(samples):
    """Per-minute realised vol (bp per sqrt(minute)) from ~1 Hz mids."""
    buckets = {}
    for r in samples:
        buckets.setdefault(r["ts"] // 60000, []).append(r)
    rv = {}
    for m, rows in buckets.items():
        rets = []
        for a, b in zip(rows, rows[1:]):
            if a["mid"] > 0 and b["mid"] > 0:
                rets.append(math.log(b["mid"] / a["mid"]))
        if len(rets) >= 10:
            rv[m] = math.sqrt(sum(x * x for x in rets)) * 1e4
    return rv


def cmd_analyze(args):
    samples = load_samples()
    trades = load_trades()
    if not samples:
        raise SystemExit("no samples.csv rows")

    summary_rows = []
    markout_rows = []
    regime_rows = []
    all_marks = {}

    for sym in SYMBOLS:
        ss = samples.get(sym, [])
        raw_tt = trades.get(sym, [])
        if not ss:
            print(f"[analyze] no samples for {sym}")
            continue
        # Drop the pre-roll returned by the first /trades poll: keep trades that
        # fall inside the exchange-time window covered by our snapshots.
        tt = [t for t in raw_tt if ss[0]["ts"] <= t["time"] <= ss[-1]["ts"]]

        spread = tw_stats(ss, "spread_bp")
        bid_top = [r["bid_notional_top"] for r in ss]
        ask_top = [r["ask_notional_top"] for r in ss]
        bid5 = [r["bid_notional5"] for r in ss]
        ask5 = [r["ask_notional5"] for r in ss]
        dt = [b["ts"] - a["ts"] for a, b in zip(ss, ss[1:])]
        duration_min = (ss[-1]["ts"] - ss[0]["ts"]) / 60000.0
        n_trades = len(tt)
        notional = sum(t["quote_qty"] for t in tt)
        # top-of-book spread in ticks
        tick = None
        try:
            with open(FILTERS_JSON, encoding="utf-8") as fh:
                tick = json.load(fh)[sym]["tick_size"]
        except Exception:  # noqa: BLE001
            pass
        tick_bp = tick / quantile([r["mid"] for r in ss], 0.5) * 1e4 if tick else float("nan")

        m = markout_for_symbol(sym, ss, tt, args.fee_bp, tick)
        all_marks[sym] = m

        # Clean adverse-selection decomposition. gross_h already includes the
        # half-spread captured at the fill; subtracting it from the time-weighted
        # half-spread gives the post-fill drift without using a stale mid-at-t.
        half_spread_tw = spread["tw_mean"] / 2.0
        for h in MARKOUT_HORIZONS_S:
            m[f"adverse_clean_{h}s_mean_bp"] = half_spread_tw - m.get(f"gross_{h}s_mean_bp", float("nan"))

        row = {
            "symbol": sym,
            "n_samples": len(ss),
            "sample_median_dt_s": quantile(dt, 0.5) / 1000.0 if dt else float("nan"),
            "sample_p95_dt_s": quantile(dt, 0.95) / 1000.0 if dt else float("nan"),
            "duration_min": duration_min,
            "spread_tw_mean_bp": spread["tw_mean"],
            "spread_median_bp": spread["median"],
            "spread_p10_bp": spread["p10"],
            "spread_p90_bp": spread["p90"],
            "spread_p99_bp": spread["p99"],
            "frac_time_spread_le_2bp": spread["frac_le_2bp"],
            "frac_time_spread_le_4bp": spread["frac_le_4bp"],
            "half_spread_tw_mean_bp": spread["tw_mean"] / 2.0,
            "tick_size": tick,
            "tick_bp": tick_bp,
            "spread_ticks_median": spread["median"] / tick_bp if tick_bp == tick_bp and tick_bp > 0 else float("nan"),
            "bid_top_notional_median_usd": quantile(bid_top, 0.5),
            "ask_top_notional_median_usd": quantile(ask_top, 0.5),
            "bid_depth5_median_usd": quantile(bid5, 0.5),
            "ask_depth5_median_usd": quantile(ask5, 0.5),
            "n_trades": n_trades,
            "trades_per_min": n_trades / duration_min if duration_min > 0 else float("nan"),
            "trade_notional_per_min_usd": notional / duration_min if duration_min > 0 else float("nan"),
            "mean_trade_notional_usd": notional / n_trades if n_trades else float("nan"),
            "taker_buy_share": (sum(1 for t in tt if not t["is_buyer_maker"]) / n_trades) if n_trades else float("nan"),
            "n_fills_used": m["n_fills"],
            "fill_quote_usd": m["fill_quote_usd"],
        }
        for h in MARKOUT_HORIZONS_S:
            for k in ("gross", "adverse", "net"):
                row[f"{k}_{h}s_mean_bp"] = m.get(f"{k}_{h}s_mean_bp")
            row[f"adverse_clean_{h}s_mean_bp"] = m.get(f"adverse_clean_{h}s_mean_bp")
            row[f"net_{h}s_median_bp"] = m.get(f"net_{h}s_median_bp")
            row[f"net_{h}s_wmean_bp"] = m.get(f"net_{h}s_wmean_bp")
            row[f"net_{h}s_frac_pos"] = m.get(f"net_{h}s_frac_pos")
            row[f"gross_{h}s_frac_neg"] = m.get(f"gross_{h}s_frac_neg")
            row[f"touch_gross_{h}s_mean_bp"] = m.get(f"touch_gross_{h}s_mean_bp")
            row[f"touch_net_{h}s_mean_bp"] = m.get(f"touch_net_{h}s_mean_bp")
            row[f"net_{h}s_tstat_naive"] = m.get(f"net_{h}s_tstat_naive")
        row["touch_n"] = m.get("touch_n")
        # break-even: half spread must exceed fee + adverse
        row["breakeven_adverse_tolerance_bp"] = half_spread_tw - args.fee_bp
        row["required_spread_fee_only_bp"] = 2.0 * args.fee_bp
        row["required_spread_1s_bp"] = 2.0 * (args.fee_bp + m.get("adverse_clean_1s_mean_bp", 0.0))
        row["required_spread_5s_bp"] = 2.0 * (args.fee_bp + m.get("adverse_clean_5s_mean_bp", 0.0))
        row["required_spread_30s_bp"] = 2.0 * (args.fee_bp + m.get("adverse_clean_30s_mean_bp", 0.0))
        summary_rows.append(row)
        for h in MARKOUT_HORIZONS_S:
            markout_rows.append({
                "symbol": sym, "horizon_s": h,
                "n_fills": m["n_fills"],
                "gross_mean_bp": m.get(f"gross_{h}s_mean_bp"),
                "adverse_mean_bp": m.get(f"adverse_{h}s_mean_bp"),
                "adverse_clean_mean_bp": m.get(f"adverse_clean_{h}s_mean_bp"),
                "adverse_median_bp": m.get(f"adverse_{h}s_median_bp"),
                "adverse_notional_wmean_bp": m.get(f"adverse_{h}s_wmean_bp"),
                "net_mean_bp": m.get(f"net_{h}s_mean_bp"),
                "net_median_bp": m.get(f"net_{h}s_median_bp"),
                "net_notional_wmean_bp": m.get(f"net_{h}s_wmean_bp"),
                "net_frac_positive": m.get(f"net_{h}s_frac_pos"),
                "gross_frac_negative": m.get(f"gross_{h}s_frac_neg"),
                "net_tstat_naive": m.get(f"net_{h}s_tstat_naive"),
            })

        # volatility regimes
        rv = minute_regimes(ss)
        if rv and tt:
            med_rv = quantile(list(rv.values()), 0.5)
            regime_trades = {"low": [], "high": []}
            for tr in tt:
                mnt = tr["time"] // 60000
                if mnt in rv:
                    regime_trades["high" if rv[mnt] > med_rv else "low"].append(tr)
            regime_samples = {"low": [], "high": []}
            for r in ss:
                mnt = r["ts"] // 60000
                if mnt in rv:
                    regime_samples["high" if rv[mnt] > med_rv else "low"].append(r)
            for reg in ("low", "high"):
                rs = regime_samples[reg]
                rt = regime_trades[reg]
                if not rs or not rt:
                    continue
                rspread = tw_stats(rs, "spread_bp")
                rm = markout_for_symbol(sym, ss, rt, args.fee_bp)
                rhalf = rspread["tw_mean"] / 2.0
                regime_rows.append({
                    "symbol": sym, "regime": reg, "median_minute_rv_bp": med_rv,
                    "n_samples": len(rs), "n_trades": len(rt),
                    "spread_tw_mean_bp": rspread["tw_mean"],
                    "adverse_1s_mean_bp": rm.get("adverse_1s_mean_bp"),
                    "adverse_clean_1s_bp": rhalf - rm.get("gross_1s_mean_bp", float("nan")),
                    "adverse_clean_5s_bp": rhalf - rm.get("gross_5s_mean_bp", float("nan")),
                    "adverse_clean_30s_bp": rhalf - rm.get("gross_30s_mean_bp", float("nan")),
                    "net_5s_mean_bp": rm.get("net_5s_mean_bp"),
                    "net_30s_mean_bp": rm.get("net_30s_mean_bp"),
                })

    if summary_rows:
        write_csv(ANALYSIS_CSV, list(summary_rows[0].keys()), summary_rows)
    if markout_rows:
        write_csv(MARKOUT_CSV, list(markout_rows[0].keys()), markout_rows)
    if regime_rows:
        write_csv(REGIME_CSV, list(regime_rows[0].keys()), regime_rows)

    # ---------------------------------------------------------------- print
    print("\n=== SPREAD / DEPTH / FLOW ===")
    hdr = (f"{'symbol':9s} {'samp':>5s} {'dt_s':>5s} {'spr_tw':>7s} {'spr_med':>8s} "
           f"{'p10':>6s} {'p90':>6s} {'<=2bp%':>7s} {'<=4bp%':>7s} {'top$k':>7s} "
           f"{'d5$k':>8s} {'trd/m':>7s} {'$k/m':>8s}")
    print(hdr)
    for r in summary_rows:
        print(f"{r['symbol']:9s} {r['n_samples']:5d} {r['sample_median_dt_s']:5.2f} "
              f"{r['spread_tw_mean_bp']:7.3f} {r['spread_median_bp']:8.3f} "
              f"{r['spread_p10_bp']:6.2f} {r['spread_p90_bp']:6.2f} "
              f"{100*r['frac_time_spread_le_2bp']:7.1f} {100*r['frac_time_spread_le_4bp']:7.1f} "
              f"{(r['bid_top_notional_median_usd']+r['ask_top_notional_median_usd'])/2000:7.1f} "
              f"{(r['bid_depth5_median_usd']+r['ask_depth5_median_usd'])/2000:8.1f} "
              f"{r['trades_per_min']:7.1f} {r['trade_notional_per_min_usd']/1000:8.1f}")

    print("\n=== PER-FILL MARKOUT (fee=2bp/side, maker side, fill at trade price) ===")
    print(f"{'symbol':9s} {'h':>4s} {'n':>7s} {'gross':>7s} {'adv_clean':>10s} {'net':>7s} "
          f"{'net_med':>8s} {'net_w':>7s} {'win%':>6s} {'t_naive':>8s}")
    for r in summary_rows:
        sym = r["symbol"]
        m = all_marks[sym]
        for h in MARKOUT_HORIZONS_S:
            print(f"{sym:9s} {h:3d}s {m['n_fills']:7d} "
                  f"{m.get(f'gross_{h}s_mean_bp', float('nan')):7.3f} "
                  f"{m.get(f'adverse_clean_{h}s_mean_bp', float('nan')):10.3f} "
                  f"{m.get(f'net_{h}s_mean_bp', float('nan')):7.3f} "
                  f"{m.get(f'net_{h}s_median_bp', float('nan')):8.3f} "
                  f"{m.get(f'net_{h}s_wmean_bp', float('nan')):7.3f} "
                  f"{100*m.get(f'net_{h}s_frac_pos', float('nan')):6.1f} "
                  f"{m.get(f'net_{h}s_tstat_naive', float('nan')):8.2f}")
    print("adv_clean = time-weighted half-spread - gross markout; net = gross - 2bp. "
          "The h=0 gross is inflated for BTC/ETH by stale mid-at-t; use row h>=1s.")

    print("\n=== TOUCH-ONLY SUBSET (print within 1 tick of last snapshot mid) ===")
    print(f"{'symbol':9s} {'n':>7s} {'gross1':>7s} {'net1':>7s} {'net5':>7s} {'net30':>7s}")
    for r in summary_rows:
        m = all_marks[r["symbol"]]
        print(f"{r['symbol']:9s} {m.get('touch_n', 0):7d} "
              f"{m.get('touch_gross_1s_mean_bp', float('nan')):7.3f} "
              f"{m.get('touch_net_1s_mean_bp', float('nan')):7.3f} "
              f"{m.get('touch_net_5s_mean_bp', float('nan')):7.3f} "
              f"{m.get('touch_net_30s_mean_bp', float('nan')):7.3f}")

    print("\n=== P(mid crosses to wrong side of fill price) ===")
    print(f"{'symbol':9s} {'h':>4s} {'cross%':>7s}")
    for r in summary_rows:
        m = all_marks[r["symbol"]]
        for h in MARKOUT_HORIZONS_S:
            print(f"{r['symbol']:9s} {h:3d}s "
                  f"{100*m.get(f'gross_{h}s_frac_neg', float('nan')):7.1f}")

    print("\n=== SMALL vs LARGE AGGRESSOR TRADES (net bp after 2bp fee) ===")
    print(f"{'symbol':9s} {'size':>5s} {'n':>7s} {'adv1':>7s} {'adv5':>7s} {'adv30':>7s} "
          f"{'net1':>7s} {'net5':>7s} {'net30':>7s}")
    for r in summary_rows:
        m = all_marks[r["symbol"]]
        for label in ("small", "large"):
            print(f"{r['symbol']:9s} {label:>5s} {m.get(f'{label}_n', 0):7d} "
                  f"{m.get(f'{label}_adverse_1s_mean_bp', float('nan')):7.3f} "
                  f"{m.get(f'{label}_adverse_5s_mean_bp', float('nan')):7.3f} "
                  f"{m.get(f'{label}_adverse_30s_mean_bp', float('nan')):7.3f} "
                  f"{m.get(f'{label}_net_1s_mean_bp', float('nan')):7.3f} "
                  f"{m.get(f'{label}_net_5s_mean_bp', float('nan')):7.3f} "
                  f"{m.get(f'{label}_net_30s_mean_bp', float('nan')):7.3f}")

    print("\n=== BREAK-EVEN ===")
    print(f"{'symbol':9s} {'half_spr':>9s} {'tol_bp':>7s} {'fee_only':>9s} {'req_spr1s':>10s} "
          f"{'req_spr5s':>10s} {'req_spr30s':>11s} {'act_spr':>8s}")
    for r in summary_rows:
        print(f"{r['symbol']:9s} {r['half_spread_tw_mean_bp']:9.3f} "
              f"{r['breakeven_adverse_tolerance_bp']:7.3f} "
              f"{r['required_spread_fee_only_bp']:9.2f} "
              f"{r['required_spread_1s_bp']:10.2f} {r['required_spread_5s_bp']:10.2f} "
              f"{r['required_spread_30s_bp']:11.2f} {r['spread_tw_mean_bp']:8.3f}")

    if regime_rows:
        print("\n=== VOL REGIME (per-symbol minute RV split) ===")
        print(f"{'symbol':9s} {'reg':>4s} {'spr_tw':>7s} {'adv1':>7s} {'adv5':>7s} "
              f"{'adv30':>7s} {'net5':>7s} {'net30':>7s} {'n_trd':>7s}")
        for r in regime_rows:
            print(f"{r['symbol']:9s} {r['regime']:>4s} {r['spread_tw_mean_bp']:7.3f} "
                  f"{r['adverse_clean_1s_bp']:7.3f} {r['adverse_clean_5s_bp']:7.3f} "
                  f"{r['adverse_clean_30s_bp']:7.3f} {r['net_5s_mean_bp']:7.3f} "
                  f"{r['net_30s_mean_bp']:7.3f} {r['n_trades']:7d}")

    print("\nNOTE: markout uses REST snapshots at ~1 Hz; mid(t) can be up to 1 s stale, "
          "and every aggressor trade at our price is assumed to fill us. Both make the "
          "adverse-selection number optimistic.")


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    h = sub.add_parser("history")
    h.add_argument("--date", default="2026-10-15")
    h.set_defaults(func=cmd_history)

    s = sub.add_parser("sample")
    s.add_argument("--seconds", type=int, default=480)
    s.add_argument("--hz", type=float, default=1.0)
    s.set_defaults(func=cmd_sample)

    b = sub.add_parser("bookticker")
    b.add_argument("--month", default="2024-04")
    b.set_defaults(func=cmd_bookticker)

    a = sub.add_parser("analyze")
    a.add_argument("--fee-bp", type=float, default=FEE_BP)
    a.set_defaults(func=cmd_analyze)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
