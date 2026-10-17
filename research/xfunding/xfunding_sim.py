#!/usr/bin/env python
"""Cross-exchange funding-rate spread study (Binance / Bybit / OKX).

Question
--------
Different venues can charge different perpetual funding rates for the same coin.
Is a delta-neutral position (short the high-funding venue perp, long the
low-funding venue perp or spot) profitable after realistic costs?

Data
----
- funding/<venue>_<BASE>.csv          (fetch.py)
- prices/<venue>_<BASE>_<kind>_1h.csv (fetch.py; Binance spot reused from
                                       research/data/spot/)
- 8h grid 2026-04-20 .. 2026-10-17 UTC. Calibration = first 120 days,
  holdout = last 60 days.
- OKX's *public* funding endpoint only retains ~3 months of history
  (observed first bar 2026-07-13 16:00 UTC). Therefore:
    * 180-day evidence uses Binance vs Bybit only.
    * Any strategy involving OKX runs on the common window with a 7-day
      warm-up (about 2026-07-20 .. 2026-10-17); calibration there is the
      first ~29 days and holdout the last 60 days.

Strategy A
----------
Every 8h, rank venues by trailing mean funding (7d base). Short the highest
venue perp, long the lowest venue perp (or spot variant), equal notional.
Only information available at the decision bar is used. Rebalances are
leg-level (a common leg is kept). Base cadence: every 8h (weekly variant too).

Strategy B
----------
Fixed venue pair, held throughout. Direction either fixed ex ante (both
directions reported) or selected at the start from the trailing 7d mean
(the honest "no lookahead" version).

Costs (per leg, per side)
-------------------------
- perp taker 7.5 bp (sensitivity 5 / 10 bp) + slippage 2 bp
- spot taker 10 bp + slippage 2 bp
- cross-venue transfer 10 bp of the switched leg notional
  (sensitivity 5 / 20 bp)
- 30 min in transit with no yield: 0.5/8 of the leg's 8h funding rate
- capital: perp-perp margin = 2/leverage (base 3x, sensitivity 5x);
  spot-long variant capital = 1 + 1/leverage.
- Funding is credited on the settlement notional (qty x venue price).

Outputs: results.csv, report.md (report written separately).
"""
import os
from itertools import combinations

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.dirname(os.path.abspath(__file__))
FUND_DIR = os.path.join(OUT, "funding")
PRICE_DIR = os.path.join(OUT, "prices")

SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "LINK"]
VENUES = ["binance", "bybit", "okx"]

START = pd.Timestamp("2026-04-20 00:00:00", tz="UTC")
SPLIT = pd.Timestamp("2026-08-18 00:00:00", tz="UTC")   # after 120 days
END = pd.Timestamp("2026-10-17 00:00:00", tz="UTC")     # +60 days
GRID = pd.date_range(START, END, freq="8h", tz="UTC")
T = len(GRID)
SPLIT_IDX = int(np.where(GRID == SPLIT)[0][0])
FULL_DAYS = (END - START).total_seconds() / 86400.0
CAL_DAYS = (SPLIT - START).total_seconds() / 86400.0
HOLD_DAYS = (END - SPLIT).total_seconds() / 86400.0
assert T == 541 and SPLIT_IDX == 360

LEV = 3.0
LOOKBACK = 21          # 7 days of 8h bars
MAX_LOOKBACK = 42      # 14d sensitivity; also the funding history buffer
NO = 1.0               # notional per leg
HIST_GRID = pd.date_range(START - pd.Timedelta(hours=8 * MAX_LOOKBACK), END,
                          freq="8h", tz="UTC")

BASE_COSTS = {
    "perp_fee": 7.5e-4,   # 7.5 bp
    "spot_fee": 10.0e-4,  # 10 bp
    "slip": 2.0e-4,       # 2 bp
    "transfer": 10.0e-4,  # 10 bp of switched leg notional
    "transit_frac": 0.5 / 8.0,
}
FEE_SENS = [5.0e-4, 10.0e-4]
TRANSFER_SENS = [5.0e-4, 20.0e-4]


# --------------------------------------------------------------------------- #
# data
# --------------------------------------------------------------------------- #
def _round_8h(ts):
    return ts.dt.round("8h")


def load_funding_series(venue, base):
    path = os.path.join(FUND_DIR, f"{venue}_{base}.csv")
    df = pd.read_csv(path)
    t = _round_8h(pd.to_datetime(df["funding_time"], unit="ms", utc=True))
    s = (pd.Series(df["funding_rate"].astype(float).values, index=t)
         .groupby(level=0).sum())
    return s.reindex(HIST_GRID)


def load_price(venue, base, kind):
    if venue == "binance" and kind == "spot":
        path = os.path.join(ROOT, "research", "data", "spot", f"{base}USDT_1h.csv")
        df = pd.read_csv(path)
        tcol = "open_time"
    else:
        path = os.path.join(PRICE_DIR, f"{venue}_{base}_{kind}_1h.csv")
        df = pd.read_csv(path)
        tcol = "open_time"
    t = pd.to_datetime(df[tcol], unit="ms", utc=True)
    s = pd.Series(df["open"].astype(float).values, index=t)
    s = s[~s.index.duplicated(keep="last")]
    return s.reindex(GRID).to_numpy(dtype=float)


def _fill_internal_gaps(a, limit=3):
    s = pd.Series(a)
    idx = s.first_valid_index()
    if idx is not None:
        s.loc[idx:] = s.loc[idx:].ffill(limit=limit)
    return s.to_numpy(dtype=float)


def load_all():
    fund_series = {v: {b: load_funding_series(v, b) for b in SYMBOLS}
                   for v in VENUES}
    fund = {}
    px = {v: {b: {} for b in SYMBOLS} for v in VENUES}
    for v in VENUES:
        fund[v] = {}
        for b in SYMBOLS:
            s = fund_series[v][b]
            idx = s.first_valid_index()
            if idx is not None:
                s.loc[idx:] = s.loc[idx:].ffill(limit=1)
            fund[v][b] = s.reindex(GRID).to_numpy(dtype=float)
        # Binance spot is reused from research/data/spot/ (already on disk)
        for b in SYMBOLS:
            for kind in ("spot", "perp"):
                px[v][b][kind] = load_price(v, b, kind)

    gaps = []
    for v in VENUES:
        for b in SYMBOLS:
            for kind, a in px[v][b].items():
                a = _fill_internal_gaps(a, limit=3)
                px[v][b][kind] = a
                n_bad = int(np.isfinite(a).sum())
                if n_bad < T:
                    gaps.append((v, b, kind, T - n_bad,
                                 int(np.argmax(np.isfinite(a))),
                                 int(np.where(np.isfinite(a))[0][-1])
                                 if np.isfinite(a).any() else -1))
    return fund, fund_series, px, gaps


def _rolling_mean_on_grid(fund_series, venue, base, lookback):
    return (fund_series[venue][base]
            .rolling(lookback, min_periods=lookback).mean()
            .reindex(GRID).to_numpy(dtype=float))


def common_window(fund, fund_series, px, venues, signal_lookback=None):
    """First grid index with complete execution data and, if requested,
    a full signal warm-up. Funding history before the grid start is used."""
    starts = []
    for v in venues:
        for b in SYMBOLS:
            f = fund[v][b]
            idx = np.where(np.isfinite(f))[0]
            if len(idx) == 0:
                return None
            starts.append(int(idx[0]))
            if signal_lookback is not None:
                rm = _rolling_mean_on_grid(fund_series, v, b, signal_lookback)
                idx = np.where(np.isfinite(rm))[0]
                if len(idx) == 0:
                    return None
                starts.append(int(idx[0]))
            for p in px[v][b].values():
                idx = np.where(np.isfinite(p))[0]
                if len(idx) == 0:
                    return None
                starts.append(int(idx[0]))
    i0 = int(max(starts))
    if i0 > T - 1:
        return None
    for v in venues:
        for b in SYMBOLS:
            if not np.isfinite(fund[v][b][i0:]).all():
                return None
            if signal_lookback is not None:
                rm = _rolling_mean_on_grid(fund_series, v, b, signal_lookback)
                if not np.isfinite(rm[i0:]).all():
                    return None
            for p in px[v][b].values():
                if not np.isfinite(p[i0:]).all():
                    return None
    return i0


# --------------------------------------------------------------------------- #
# simulation
# --------------------------------------------------------------------------- #
def notional_cost(kind, costs):
    fee = costs["spot_fee"] if kind == "spot" else costs["perp_fee"]
    return fee + costs["slip"]


def run_strategy(fund, px, base, venues, i0, i1, target_fn, mode, costs):
    """Leg-level delta-neutral backtest on grid indices i0..i1 inclusive.

    target_fn(k) -> None or (short_venue, long_venue); data through k only.
    mode: "perp_perp" or "spot_long".
    Returns dict of PnL arrays in units of per-leg notional (NO = 1).
    """
    n = i1 - i0 + 1
    arr = {name: np.zeros(n) for name in
           ["eq", "fund", "price", "fee", "slip", "transfer", "transit",
            "pred_spread", "in_market"]}
    cash = 0.0
    fund_cum = price_real = fee_cum = slip_cum = trans_cum = transit_cum = 0.0
    legs = {}
    last_venue = {}
    prev_target = None
    n_leg_switches = 0
    n_pair_changes = 0
    hold_bars = []
    pair_change_bars = []
    leg_switch_bars = []
    open_bar = None
    initial_transfer_done = False

    def unreal(k):
        u = 0.0
        for side, leg in legs.items():
            p = px[leg["venue"]][base][leg["kind"]][k]
            if side == "short":
                u += leg["qty"] * (leg["entry"] - p)
            else:
                u += leg["qty"] * (p - leg["entry"])
        return u

    def close_leg(side, k):
        nonlocal cash, price_real, fee_cum, slip_cum
        leg = legs.pop(side)
        p = px[leg["venue"]][base][leg["kind"]][k]
        pnl = (leg["qty"] * (leg["entry"] - p) if side == "short"
               else leg["qty"] * (p - leg["entry"]))
        cash += pnl
        price_real += pnl
        c = leg["qty"] * p * notional_cost(leg["kind"], costs)
        fee_part = leg["qty"] * p * (costs["spot_fee"] if leg["kind"] == "spot"
                                     else costs["perp_fee"])
        cash -= c
        fee_cum += fee_part
        slip_cum += c - fee_part
        last_venue[side] = leg["venue"]

    def open_leg(side, venue, kind, k):
        nonlocal cash, fee_cum, slip_cum, trans_cum, transit_cum
        p = px[venue][base][kind][k]
        qty = NO / p
        legs[side] = {"venue": venue, "kind": kind, "qty": qty, "entry": p}
        c = NO * notional_cost(kind, costs)
        fee_part = NO * (costs["spot_fee"] if kind == "spot"
                         else costs["perp_fee"])
        cash -= c
        fee_cum += fee_part
        slip_cum += c - fee_part
        if side in last_venue and last_venue[side] != venue:
            cash -= costs["transfer"] * NO
            trans_cum += costs["transfer"] * NO
            f = fund[venue][base][k]
            f = 0.0 if not np.isfinite(f) else abs(f)
            t = costs["transit_frac"] * f * NO
            cash -= t
            transit_cum += t

    for j, k in enumerate(range(i0, i1 + 1)):
        # 1) funding for the interval that just ended (settled at grid k)
        if k > i0:
            for side, leg in legs.items():
                if leg["kind"] == "perp":
                    f = fund[leg["venue"]][base][k]
                    if np.isfinite(f):
                        pnl = f * leg["qty"] * px[leg["venue"]][base]["perp"][k]
                        if side == "long":
                            pnl = -pnl
                        cash += pnl
                        fund_cum += pnl

        # 2) desired target for [k, k+1); forced flat on the last bar
        target = None if k == i1 else target_fn(k)
        arr["pred_spread"][j] = np.nan
        if target is not None:
            hv, lv = target
            spread = target_fn.pred_spread if hasattr(target_fn, "pred_spread") else np.nan
            arr["pred_spread"][j] = spread * 1e4 if np.isfinite(spread) else 0.0
        if k > i0 and target != prev_target:
            n_pair_changes += 1
            pair_change_bars.append(k)

        # 3) rebalance
        if target is None:
            for side in list(legs):
                close_leg(side, k)
                n_leg_switches += 1
                leg_switch_bars.append(k)
            if open_bar is not None:
                hold_bars.append(k - open_bar)
                open_bar = None
        else:
            hv, lv = target
            desired = {"short": (hv, "perp"),
                       "long": (lv, "spot" if mode == "spot_long" else "perp")}
            for side, (venue, kind) in desired.items():
                cur = legs.get(side)
                if cur is not None and cur["venue"] == venue and cur["kind"] == kind:
                    continue
                if cur is not None:
                    close_leg(side, k)
                    n_leg_switches += 1
                    leg_switch_bars.append(k)
                open_leg(side, venue, kind, k)
                n_leg_switches += 1
                leg_switch_bars.append(k)
                if open_bar is None:
                    open_bar = k
            # Funding a cross-venue position requires one initial transfer
            # (capital is assumed to start on the short-leg venue). Same-venue
            # carry incurs no cross-venue transfer.
            if not initial_transfer_done and hv != lv:
                cash -= costs["transfer"] * NO
                trans_cum += costs["transfer"] * NO
                f = fund[lv][base][k]
                f = 0.0 if not np.isfinite(f) else abs(f)
                t = costs["transit_frac"] * f * NO
                cash -= t
                transit_cum += t
            initial_transfer_done = True
        prev_target = target

        # 4) mark
        arr["eq"][j] = cash + unreal(k)
        arr["fund"][j] = fund_cum
        arr["price"][j] = price_real + unreal(k)
        arr["fee"][j] = fee_cum
        arr["slip"][j] = slip_cum
        arr["transfer"][j] = trans_cum
        arr["transit"][j] = transit_cum
        arr["in_market"][j] = 1.0 if legs else 0.0

    assert not legs, "position left open"
    del hold_bars
    # reconstruct holding spells from in_market transitions for reporting
    spells, start = [], None
    for j in range(n):
        if arr["in_market"][j] > 0 and start is None:
            start = j
        elif arr["in_market"][j] == 0 and start is not None:
            spells.append(j - start)
            start = None
    if start is not None:
        spells.append(n - start)
    return {
        "arr": arr, "i0": i0, "i1": i1,
        "n_leg_switches": n_leg_switches,
        "n_pair_changes": n_pair_changes,
        "avg_hold_bars": float(np.mean(spells)) if spells else 0.0,
        "n_spells": len(spells),
        "bars_per_pair_change": n / max(1, n_pair_changes),
        "bars_per_leg_switch": n / max(1, n_leg_switches),
        "pair_change_bars": pair_change_bars,
        "leg_switch_bars": leg_switch_bars,
    }


def rolling_means(fund_series, base, venues, lookback=LOOKBACK):
    return {v: _rolling_mean_on_grid(fund_series, v, base, lookback)
            for v in venues}


def make_a_target(means, venues, i0, threshold=0.0, cadence=1):
    state = {"target": None, "pred_spread": np.nan}

    def fn(k):
        if (k - i0) % cadence == 0:
            avail = [v for v in venues if np.isfinite(means[v][k])]
            if len(avail) < 2:
                state["target"] = None
                state["pred_spread"] = np.nan
            else:
                hv = max(avail, key=lambda v: means[v][k])
                lv = min(avail, key=lambda v: means[v][k])
                spread = means[hv][k] - means[lv][k]
                state["pred_spread"] = spread
                state["target"] = (hv, lv) if spread >= threshold else None
        return state["target"]

    fn.pred_spread = np.nan

    def fn_wrap(k):
        t = fn(k)
        fn_wrap.pred_spread = state["pred_spread"]
        return t

    fn_wrap.pred_spread = np.nan
    return fn_wrap


def make_b_target(short_v, long_v):
    fn = lambda k: (short_v, long_v)  # noqa: E731
    fn.pred_spread = np.nan
    return fn


# --------------------------------------------------------------------------- #
# stats
# --------------------------------------------------------------------------- #
def ann(net_ret, days):
    if net_ret <= -1.0:
        return -100.0
    return ((1.0 + net_ret) ** (365.0 / days) - 1.0) * 100.0


def mdd_pct(eq, a, b, capital):
    base = eq[a - 1] if a > 0 else 0.0
    path = np.concatenate([[base], eq[a:b + 1]])
    peak = np.maximum.accumulate(path)
    return float(np.min(path - peak) / capital * 100.0)


def period_stats(res, a, b, capital, gross_notional=2.0):
    """a,b are local indices into the simulation window (inclusive)."""
    eq = res["arr"]["eq"]
    base_arr = lambda x: x[a - 1] if a > 0 else 0.0  # noqa: E731
    net = eq[b] - base_arr(eq)
    fund = res["arr"]["fund"][b] - base_arr(res["arr"]["fund"])
    price = res["arr"]["price"][b] - base_arr(res["arr"]["price"])
    fee = res["arr"]["fee"][b] - base_arr(res["arr"]["fee"])
    slip = res["arr"]["slip"][b] - base_arr(res["arr"]["slip"])
    transfer = res["arr"]["transfer"][b] - base_arr(res["arr"]["transfer"])
    transit = res["arr"]["transit"][b] - base_arr(res["arr"]["transit"])
    days = (GRID[res["i0"] + b] - GRID[res["i0"] + a]).total_seconds() / 86400.0
    cost = fee + slip + transfer + transit
    tm = float(np.mean(res["arr"]["in_market"][a:b + 1]) * 100.0)
    pred = res["arr"]["pred_spread"][a:b + 1]
    pred = pred[np.isfinite(pred)]
    return {
        "days": days,
        "gross_funding_bp": fund * 1e4,
        "price_pnl_bp": price * 1e4,
        "fee_bp": fee * 1e4,
        "slip_bp": slip * 1e4,
        "transfer_bp": transfer * 1e4,
        "transit_bp": transit * 1e4,
        "total_cost_bp": cost * 1e4,
        "net_bp": net * 1e4,
        "net_ret_on_capital": net / capital,
        "ann_gross_pct": ann(net / gross_notional, days),
        "ann_capital_pct": ann(net / capital, days),
        "mdd_pct": mdd_pct(eq, a, b, capital),
        "time_in_market_pct": tm,
        "avg_pred_spread_bp": float(np.mean(pred)) if len(pred) else np.nan,
    }


def portfolio_arrays(results):
    out = {}
    for key in results[0]["arr"]:
        stack = np.array([r["arr"][key] for r in results])
        if key == "pred_spread":
            cnt = np.sum(np.isfinite(stack), axis=0)
            total = np.nansum(stack, axis=0)
            out[key] = np.where(cnt > 0, total / np.maximum(cnt, 1), np.nan)
        else:
            out[key] = np.mean(stack, axis=0)
    return out


def run_meta(r):
    return {
        "n_switches": r["n_leg_switches"],
        "n_pair_changes": r["n_pair_changes"],
        "avg_hold_bars": r["avg_hold_bars"],
        "bars_per_pair_change": r["bars_per_pair_change"],
        "bars_per_leg_switch": r["bars_per_leg_switch"],
    }


def portfolio_meta(results):
    return {
        "n_switches": sum(r["n_leg_switches"] for r in results),
        "n_pair_changes": sum(r["n_pair_changes"] for r in results),
        "avg_hold_bars": float(np.mean([r["avg_hold_bars"] for r in results])),
        "bars_per_pair_change": float(np.mean(
            [r["bars_per_pair_change"] for r in results])),
        "bars_per_leg_switch": float(np.mean(
            [r["bars_per_leg_switch"] for r in results])),
    }


def _spell_len(in_market):
    spells, start = [], None
    for j, v in enumerate(in_market):
        if v > 0 and start is None:
            start = j
        elif v <= 0 and start is not None:
            spells.append(j - start)
            start = None
    if start is not None:
        spells.append(len(in_market) - start)
    return spells


def period_meta(r, a, b):
    lo, hi = r["i0"] + a, r["i0"] + b
    pc = sum(1 for k in r["pair_change_bars"] if lo <= k <= hi)
    ls = sum(1 for k in r["leg_switch_bars"] if lo <= k <= hi)
    bars = b - a + 1
    spells = _spell_len(r["arr"]["in_market"][a:b + 1])
    return {
        "n_switches": ls,
        "n_pair_changes": pc,
        "avg_hold_bars": float(np.mean(spells)) if spells else 0.0,
        "bars_per_pair_change": bars / max(1, pc),
        "bars_per_leg_switch": bars / max(1, ls),
    }


def portfolio_period_meta(results, a, b):
    metas = [period_meta(r, a, b) for r in results]
    return {
        "n_switches": sum(m["n_switches"] for m in metas),
        "n_pair_changes": sum(m["n_pair_changes"] for m in metas),
        "avg_hold_bars": float(np.mean([m["avg_hold_bars"] for m in metas])),
        "bars_per_pair_change": float(np.mean(
            [m["bars_per_pair_change"] for m in metas])),
        "bars_per_leg_switch": float(np.mean(
            [m["bars_per_leg_switch"] for m in metas])),
    }


def stats_from_arrays(arr, i0, a, b, capital, gross_notional=2.0):
    eq = arr["eq"]
    base_arr = lambda x: x[a - 1] if a > 0 else 0.0  # noqa: E731
    net = eq[b] - base_arr(eq)
    fund = arr["fund"][b] - base_arr(arr["fund"])
    price = arr["price"][b] - base_arr(arr["price"])
    fee = arr["fee"][b] - base_arr(arr["fee"])
    slip = arr["slip"][b] - base_arr(arr["slip"])
    transfer = arr["transfer"][b] - base_arr(arr["transfer"])
    transit = arr["transit"][b] - base_arr(arr["transit"])
    days = (GRID[i0 + b] - GRID[i0 + a]).total_seconds() / 86400.0
    cost = fee + slip + transfer + transit
    tm = float(np.mean(arr["in_market"][a:b + 1]) * 100.0)
    pred = arr["pred_spread"][a:b + 1]
    pred = pred[np.isfinite(pred)]
    return {
        "days": days,
        "gross_funding_bp": fund * 1e4,
        "price_pnl_bp": price * 1e4,
        "fee_bp": fee * 1e4,
        "slip_bp": slip * 1e4,
        "transfer_bp": transfer * 1e4,
        "transit_bp": transit * 1e4,
        "total_cost_bp": cost * 1e4,
        "net_bp": net * 1e4,
        "net_ret_on_capital": net / capital,
        "ann_gross_pct": ann(net / gross_notional, days),
        "ann_capital_pct": ann(net / capital, days),
        "mdd_pct": mdd_pct(eq, a, b, capital),
        "time_in_market_pct": tm,
        "avg_pred_spread_bp": float(np.mean(pred)) if len(pred) else np.nan,
    }


def nw_tstat(x, lags=7):
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 10:
        return np.nan
    mu = x.mean()
    e = x - mu
    s = float(e @ e) / n
    for l in range(1, lags + 1):
        if l >= n:
            break
        w = 1.0 - l / (lags + 1.0)
        s += 2.0 * w * float(e[l:] @ e[:-l]) / n
    if s <= 0:
        return np.nan
    return mu / np.sqrt(s / n)


def signflip(x):
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) < 2:
        return np.nan, np.nan
    flips = float(np.mean(np.sign(x[1:]) != np.sign(x[:-1])) * 100.0)
    p = float(np.mean(x > 0))
    rand = 2.0 * p * (1.0 - p) * 100.0
    return flips, rand


def ar1(x):
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) < 10:
        return np.nan
    return float(np.corrcoef(x[:-1], x[1:])[0, 1])


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    fund, fund_series, px, gaps = load_all()
    print(f"grid {GRID[0]} .. {GRID[-1]}  T={T}")
    print(f"price/funding gaps (venue, coin, kind, n_missing, first, last): "
          f"{len(gaps)} series")
    for g in gaps[:20]:
        print("  gap", g)

    rows = []

    def add(section, **kw):
        rec = {"section": section}
        rec.update(kw)
        rows.append(rec)

    # ---------------- funding level / spread statistics ----------------
    windows = {
        "binance": (0, T - 1),
        "bybit": (0, T - 1),
        "okx": None,  # filled below
    }
    okx_stat_i0 = common_window(fund, fund_series, px, ["okx"],
                                signal_lookback=None)
    okx_i0 = common_window(fund, fund_series, px, ["okx"],
                           signal_lookback=LOOKBACK)
    okx3_i0 = common_window(fund, fund_series, px,
                            ["binance", "bybit", "okx"],
                            signal_lookback=LOOKBACK)
    print(f"OKX-only data start idx={okx_stat_i0} -> "
          f"{GRID[okx_stat_i0] if okx_stat_i0 else None}")
    print(f"OKX-only signal start idx={okx_i0} -> "
          f"{GRID[okx_i0] if okx_i0 else None}")
    print(f"3-venue signal start idx={okx3_i0} -> "
          f"{GRID[okx3_i0] if okx3_i0 else None}")
    # funding statistics do not need a 7d warm-up
    windows["okx"] = (okx_stat_i0, T - 1) if okx_stat_i0 is not None else None

    for v in VENUES:
        w = windows[v]
        if w is None:
            continue
        for b in SYMBOLS:
            f = fund[v][b][w[0]:w[1] + 1]
            f = f[np.isfinite(f)]
            add("funding_stats", venue=v, symbol=b, period="full" if w[0] == 0 else "common",
                n_obs=len(f), days=(w[1] - w[0] + 1) * 8 / 24.0,
                funding_mean_bp=float(np.mean(f) * 1e4),
                funding_median_bp=float(np.median(f) * 1e4),
                funding_std_bp=float(np.std(f, ddof=1) * 1e4),
                funding_pos_share_pct=float(np.mean(f > 0) * 100.0),
                funding_ann_pct=float(np.mean(f) * 3 * 365 * 100.0),
                funding_ar1=ar1(f),
                notes="OKX public funding history starts 2026-07-13" if v == "okx" else "")

    for v1, v2 in combinations(VENUES, 2):
        w0 = max(windows[v1][0] if windows[v1] else T,
                 windows[v2][0] if windows[v2] else T)
        if w0 >= T:
            continue
        for b in SYMBOLS:
            a = fund[v1][b][w0:]
            c = fund[v2][b][w0:]
            ok = np.isfinite(a) & np.isfinite(c)
            d = (a - c)[ok]
            flips, rand = signflip(d)
            add("spread_stats", venue=f"{v1}-{v2}", symbol=b,
                period="full" if w0 == 0 else "common",
                n_obs=int(ok.sum()),
                days=float(ok.sum() * 8 / 24.0),
                spread_mean_bp=float(np.mean(d) * 1e4),
                spread_median_bp=float(np.median(d) * 1e4),
                spread_abs_mean_bp=float(np.mean(np.abs(d)) * 1e4),
                spread_7d_abs_mean_bp=float(
                    pd.Series(np.abs(d)).rolling(21).mean().mean() * 1e4),
                spread_std_bp=float(np.std(d, ddof=1) * 1e4),
                spread_ann_pct=float(np.mean(d) * 3 * 365 * 100.0),
                spread_ar1=ar1(d),
                spread_signflip_pct=flips,
                spread_random_signflip_pct=rand,
                spread_tstat_nw=nw_tstat(d, lags=7),
                spread_pos_share_pct=float(np.mean(d > 0) * 100.0),
                notes="positive = first venue has higher funding "
                      "(short first / long second)")

    # equal-weight cross-coin average spread (one series per venue pair)
    for v1, v2 in combinations(VENUES, 2):
        w0 = max(windows[v1][0] if windows[v1] else T,
                 windows[v2][0] if windows[v2] else T)
        if w0 >= T:
            continue
        mat = []
        for b in SYMBOLS:
            a = fund[v1][b][w0:]
            c = fund[v2][b][w0:]
            ok = np.isfinite(a) & np.isfinite(c)
            mat.append((a - c)[ok])
        L = min(len(x) for x in mat)
        avg = np.mean([x[:L] for x in mat], axis=0)
        add("spread_portfolio", venue=f"{v1}-{v2}",
            period="full" if w0 == 0 else "common",
            n_obs=L, days=L * 8 / 24.0,
            spread_mean_bp=float(np.mean(avg) * 1e4),
            spread_std_bp=float(np.std(avg, ddof=1) * 1e4),
            spread_ann_pct=float(np.mean(avg) * 3 * 365 * 100.0),
            spread_tstat_nw=nw_tstat(avg, lags=7),
            notes="equal-weight average across the 8 coins; "
                  "positive = first venue higher")

    # ---------------- strategy A, 2 venues (180 days) ----------------
    a2_venues = ["binance", "bybit"]
    a2_i0 = common_window(fund, fund_series, px, a2_venues,
                          signal_lookback=MAX_LOOKBACK)
    assert a2_i0 == 0, f"2-venue history does not cover 14d warm-up: {a2_i0}"
    a2_i1 = T - 1
    a2_capital = 2.0 / LEV
    a_runs = []   # (name, venues, i0, i1, mode, costs, threshold, cadence)

    # pre-specified base + lookback/threshold grid (13 alpha variants)
    for lb_days in (3, 7, 14):
        for thr_bp in (0.0, 0.5, 1.0):
            a_runs.append((f"A_pp_lb{lb_days}d_thr{thr_bp:g}bp", a2_venues,
                           a2_i0, a2_i1, "perp_perp", dict(BASE_COSTS),
                           lb_days * 3, thr_bp * 1e-4, 1))
    a_runs.append(("A_pp_lb7d_thr0bp_weekly", a2_venues, a2_i0, a2_i1,
                   "perp_perp", dict(BASE_COSTS), 21, 0.0, 21))
    a_runs.append(("A_pp_lb7d_thr0bp_monthly", a2_venues, a2_i0, a2_i1,
                   "perp_perp", dict(BASE_COSTS), 21, 0.0, 90))
    a_runs.append(("A_pp_lb7d_thr0.25bp", a2_venues, a2_i0, a2_i1,
                   "perp_perp", dict(BASE_COSTS), 21, 0.25e-4, 1))
    for thr_bp in (0.0, 0.5, 1.0):
        a_runs.append((f"A_spot_lb7d_thr{thr_bp:g}bp", a2_venues, a2_i0, a2_i1,
                       "spot_long", dict(BASE_COSTS), 21, thr_bp * 1e-4, 1))

    a_results = {}
    for name, venues, i0, i1, mode, costs, lookback, thr, cadence in a_runs:
        coin_res = {}
        for b in SYMBOLS:
            means = rolling_means(fund_series, b, venues, lookback)
            fn = make_a_target(means, venues, i0, threshold=thr, cadence=cadence)
            coin_res[b] = run_strategy(fund, px, b, venues, i0, i1, fn, mode, costs)
        a_results[name] = coin_res
        p = portfolio_arrays(list(coin_res.values()))
        cap = (2.0 / LEV) if mode == "perp_perp" else (1.0 + 1.0 / LEV)
        # per-coin and portfolio rows
        for b in SYMBOLS:
            for per, (aa, bb) in {"full": (0, i1 - i0),
                                  "calib": (0, SPLIT_IDX - i0),
                                  "holdout": (SPLIT_IDX - i0, i1 - i0)}.items():
                st = period_stats(coin_res[b], aa, bb, cap)
                add("strategy_A", variant=name, mode=mode, venue_set="+".join(venues),
                    period=per, symbol=b, venue_pair="", direction="",
                    **period_meta(coin_res[b], aa, bb), **st)
        for per, (aa, bb) in {"full": (0, i1 - i0),
                              "calib": (0, SPLIT_IDX - i0),
                              "holdout": (SPLIT_IDX - i0, i1 - i0)}.items():
            st = stats_from_arrays(p, i0, aa, bb, cap)
            add("strategy_A", variant=name, mode=mode, venue_set="+".join(venues),
                period=per, symbol="PORTFOLIO", venue_pair="", direction="",
                **portfolio_period_meta(list(coin_res.values()), aa, bb), **st)

    # ---------------- strategy A, 3 venues (common window) ----------------
    a3_venues = ["binance", "bybit", "okx"]
    a3_runs = []
    if okx3_i0 is not None:
        for thr_bp in (0.0, 0.25, 0.5):
            a3_runs.append((f"A3_pp_lb7d_thr{thr_bp:g}bp", "perp_perp",
                            dict(BASE_COSTS), 21, thr_bp * 1e-4, 1))
        a3_runs.append(("A3_pp_lb7d_thr0bp_monthly", "perp_perp",
                        dict(BASE_COSTS), 21, 0.0, 90))
        a3_runs.append(("A3_spot_lb7d_thr0bp", "spot_long", dict(BASE_COSTS),
                        21, 0.0, 1))
    for name, mode, costs, lookback, thr, cadence in a3_runs:
        coin_res = {}
        for b in SYMBOLS:
            means = rolling_means(fund_series, b, a3_venues, lookback)
            fn = make_a_target(means, a3_venues, okx3_i0, threshold=thr,
                               cadence=cadence)
            coin_res[b] = run_strategy(fund, px, b, a3_venues, okx3_i0, T - 1,
                                       fn, mode, costs)
        a_results[name] = coin_res
        p = portfolio_arrays(list(coin_res.values()))
        cap = (2.0 / LEV) if mode == "perp_perp" else (1.0 + 1.0 / LEV)
        split_local = SPLIT_IDX - okx3_i0
        for b in SYMBOLS:
            for per, (aa, bb) in {"full": (0, T - 1 - okx3_i0),
                                  "calib": (0, split_local),
                                  "holdout": (split_local, T - 1 - okx3_i0)}.items():
                st = period_stats(coin_res[b], aa, bb, cap)
                add("strategy_A", variant=name, mode=mode,
                    venue_set="+".join(a3_venues), period=per, symbol=b,
                    venue_pair="", direction="",
                    **period_meta(coin_res[b], aa, bb), **st)
        for per, (aa, bb) in {"full": (0, T - 1 - okx3_i0),
                              "calib": (0, split_local),
                              "holdout": (split_local, T - 1 - okx3_i0)}.items():
            st = stats_from_arrays(p, okx3_i0, aa, bb, cap)
            add("strategy_A", variant=name, mode=mode,
                venue_set="+".join(a3_venues), period=per, symbol="PORTFOLIO",
                venue_pair="", direction="",
                **portfolio_period_meta(list(coin_res.values()), aa, bb), **st)

    # ---------------- strategy B: fixed pairs ----------------
    b_specs = []
    for v1, v2 in combinations(VENUES, 2):
        i0_fixed = common_window(fund, fund_series, px, [v1, v2],
                                 signal_lookback=None)
        i0_sel = common_window(fund, fund_series, px, [v1, v2],
                               signal_lookback=LOOKBACK)
        if i0_fixed is None or i0_sel is None:
            continue
        tag = f"{v1}-{v2}"
        for short_v, long_v in ((v1, v2), (v2, v1)):
            b_specs.append((f"B_fixed_short{short_v}_long{long_v}", tag,
                            [v1, v2], i0_fixed, short_v, long_v, "perp_perp",
                            dict(BASE_COSTS)))
        # start-selected direction from trailing 7d mean at i0
        b_specs.append((f"B_sel_{tag}", tag, [v1, v2], i0_sel, None, None,
                        "perp_perp", dict(BASE_COSTS)))
        # spot-long variant of the start-selected direction
        b_specs.append((f"B_sel_spot_{tag}", tag, [v1, v2], i0_sel, None, None,
                        "spot_long", dict(BASE_COSTS)))

    b_results = {}
    for name, tag, venues, i0, short_v, long_v, mode, costs in b_specs:
        if short_v is None:
            # choose direction once, at i0, from trailing 7d means
            diffs = {}
            for b in SYMBOLS:
                m = _rolling_mean_on_grid(fund_series, venues[0], b, LOOKBACK)
                n = _rolling_mean_on_grid(fund_series, venues[1], b, LOOKBACK)
                diffs[b] = m[i0] - n[i0]
            mean_diff = float(np.nanmean(list(diffs.values())))
            short_v, long_v = ((venues[0], venues[1]) if mean_diff >= 0
                               else (venues[1], venues[0]))
        coin_res = {}
        for b in SYMBOLS:
            fn = make_b_target(short_v, long_v)
            coin_res[b] = run_strategy(fund, px, b, venues, i0, T - 1, fn,
                                       mode, costs)
        b_results[name] = coin_res
        p = portfolio_arrays(list(coin_res.values()))
        cap = (2.0 / LEV) if mode == "perp_perp" else (1.0 + 1.0 / LEV)
        split_local = SPLIT_IDX - i0
        for b in SYMBOLS:
            for per, (aa, bb) in {"full": (0, T - 1 - i0),
                                  "calib": (0, split_local),
                                  "holdout": (split_local, T - 1 - i0)}.items():
                st = period_stats(coin_res[b], aa, bb, cap)
                add("strategy_B", variant=name, mode=mode, venue_set="+".join(venues),
                    period=per, symbol=b, venue_pair=tag,
                    direction=f"short {short_v} / long {long_v}",
                    **period_meta(coin_res[b], aa, bb), **st)
        for per, (aa, bb) in {"full": (0, T - 1 - i0),
                              "calib": (0, split_local),
                              "holdout": (split_local, T - 1 - i0)}.items():
            st = stats_from_arrays(p, i0, aa, bb, cap)
            add("strategy_B", variant=name, mode=mode, venue_set="+".join(venues),
                period=per, symbol="PORTFOLIO", venue_pair=tag,
                direction=f"short {short_v} / long {long_v}",
                **portfolio_period_meta(list(coin_res.values()), aa, bb), **st)

    # ---------------- benchmark: same-venue cash-and-carry ----------------
    # Short perp + long spot on the *same* venue (the classic carry trade).
    # Included for comparison; it is not a cross-venue spread strategy.
    for v in VENUES:
        i0 = common_window(fund, fund_series, px, [v], signal_lookback=None)
        if i0 is None:
            continue
        coin_res = {}
        for b in SYMBOLS:
            fn = make_b_target(v, v)
            coin_res[b] = run_strategy(fund, px, b, [v], i0, T - 1, fn,
                                       "spot_long", dict(BASE_COSTS))
        p = portfolio_arrays(list(coin_res.values()))
        cap = 1.0 + 1.0 / LEV
        split_local = SPLIT_IDX - i0
        for per, (aa, bb) in {"full": (0, T - 1 - i0),
                              "calib": (0, split_local),
                              "holdout": (split_local, T - 1 - i0)}.items():
            st = stats_from_arrays(p, i0, aa, bb, cap)
            add("benchmark_carry", variant=f"C_carry_{v}", mode="spot_long",
                venue_set=v, period=per, symbol="PORTFOLIO", venue_pair="",
                direction=f"short perp {v} / long spot {v}",
                **portfolio_period_meta(list(coin_res.values()), aa, bb), **st)

    # ---------------- cost sensitivities on the base A variant ----------------
    base_name = "A_pp_lb7d_thr0bp"
    for label, costs, lev in [
        ("fee5bp", {**BASE_COSTS, "perp_fee": 5.0e-4}, LEV),
        ("fee10bp", {**BASE_COSTS, "perp_fee": 10.0e-4}, LEV),
        ("transfer5bp", {**BASE_COSTS, "transfer": 5.0e-4}, LEV),
        ("transfer20bp", {**BASE_COSTS, "transfer": 20.0e-4}, LEV),
        ("transfer0bp", {**BASE_COSTS, "transfer": 0.0}, LEV),
        ("maker2bp", {**BASE_COSTS, "perp_fee": 2.0e-4}, LEV),
        ("lev5x", dict(BASE_COSTS), 5.0),
    ]:
        coin_res = {}
        for b in SYMBOLS:
            means = rolling_means(fund_series, b, a2_venues, LOOKBACK)
            fn = make_a_target(means, a2_venues, 0, threshold=0.0, cadence=1)
            coin_res[b] = run_strategy(fund, px, b, a2_venues, 0, T - 1, fn,
                                       "perp_perp", costs)
        p = portfolio_arrays(list(coin_res.values()))
        cap = 2.0 / lev
        for per, (aa, bb) in {"full": (0, T - 1),
                              "calib": (0, SPLIT_IDX),
                              "holdout": (SPLIT_IDX, T - 1)}.items():
            st = stats_from_arrays(p, 0, aa, bb, cap)
            add("cost_sensitivity", variant=base_name, mode="perp_perp",
                venue_set="+".join(a2_venues), period=per, symbol="PORTFOLIO",
                venue_pair="", direction="", cost_scenario=label,
                **portfolio_period_meta(list(coin_res.values()), aa, bb), **st)

    # ---------------- cost / persistence breakeven ----------------
    switch_cost_bp = (2 * 2 * (BASE_COSTS["perp_fee"] + BASE_COSTS["slip"])
                      + 2 * BASE_COSTS["transfer"]) * 1e4
    for v1, v2 in combinations(VENUES, 2):
        w0 = max(windows[v1][0] if windows[v1] else T,
                 windows[v2][0] if windows[v2] else T)
        if w0 >= T:
            continue
        abs_bp, signed_bp = [], []
        for b in SYMBOLS:
            a = fund[v1][b][w0:]
            c = fund[v2][b][w0:]
            ok = np.isfinite(a) & np.isfinite(c)
            d = (a - c)[ok]
            if len(d) == 0:
                continue
            abs_bp.append(float(np.mean(np.abs(d)) * 1e4))
            signed_bp.append(float(np.mean(d) * 1e4))
        abs_bp = float(np.mean(abs_bp))
        signed_bp = float(np.mean(signed_bp))
        if "okx" in (v1, v2) and "A3_pp_lb7d_thr0bp" in a_results:
            src = a_results["A3_pp_lb7d_thr0bp"]
            pred_bp = float(np.nanmean([r["arr"]["pred_spread"][
                r["arr"]["in_market"] > 0].mean() for r in src.values()]))
        else:
            src = a_results["A_pp_lb7d_thr0bp"]
            pred_bp = float(np.nanmean([r["arr"]["pred_spread"][
                r["arr"]["in_market"] > 0].mean() for r in src.values()]))
        hold_bars = float(np.mean([r["bars_per_pair_change"]
                                   for r in src.values()]))
        n_bars = float(np.mean([r["i1"] - r["i0"] + 1 for r in src.values()]))
        tm = float(np.mean([r["arr"]["in_market"].mean() for r in src.values()]))
        gross_bp = float(np.mean([r["arr"]["fund"][-1] for r in src.values()])) * 1e4
        captured_bp = gross_bp / max(n_bars * tm, 1.0)
        add("cost_breakeven", venue_pair=f"{v1}-{v2}",
            period="full" if w0 == 0 else "common",
            days=(T - 1 - w0) * 8 / 24.0,
            spread_abs_mean_bp=abs_bp,
            spread_mean_bp=signed_bp,
            avg_pred_spread_bp=pred_bp,
            captured_spread_bp=captured_bp,
            switch_cost_bp=switch_cost_bp,
            breakeven_bars_at_abs=switch_cost_bp / abs_bp if abs_bp > 0 else np.nan,
            breakeven_bars_at_pred=switch_cost_bp / pred_bp if pred_bp > 0 else np.nan,
            breakeven_bars_at_captured=(switch_cost_bp / captured_bp
                                        if captured_bp > 0 else np.nan),
            signal_hold_bars=hold_bars,
            gap_factor=((switch_cost_bp / captured_bp) / hold_bars
                        if captured_bp > 0 else np.nan),
            est_gross_ann_pct=abs_bp * 3 * 365 / 100.0,
            est_cost_drag_ann_pct=switch_cost_bp * 3 * 365 / hold_bars / 100.0,
            est_net_ann_pct=(abs_bp - switch_cost_bp / hold_bars) * 3 * 365 / 100.0,
            est_net_captured_ann_pct=(captured_bp - switch_cost_bp / hold_bars)
            * 3 * 365 / 100.0,
            b_one_time_cost_bp=(2 * 2 * (BASE_COSTS["perp_fee"] +
                                         BASE_COSTS["slip"]) +
                                BASE_COSTS["transfer"]) * 1e4,
            b_breakeven_days=((2 * 2 * (BASE_COSTS["perp_fee"] +
                                        BASE_COSTS["slip"]) +
                               BASE_COSTS["transfer"]) * 1e4
                              / (signed_bp * 3)) if signed_bp > 0 else np.nan,
            notes=("switch cost = 2 legs x 2 sides x (7.5+2bp) + 2 x 10bp "
                   "transfer; signal hold from the base A variant; "
                   "signed spread positive = first venue higher"))

    # ---------------- variant summary / multiple testing ----------------
    df = pd.DataFrame(rows)
    alpha_mask = df["section"].isin(["strategy_A", "strategy_B"]) & \
        (df["symbol"] == "PORTFOLIO")
    variants = sorted(df.loc[alpha_mask, "variant"].dropna().unique())
    add("multiple_testing", variant="ALL", period="holdout",
        n_variants=len(variants),
        notes="; ".join(variants))
    hold = df[(df.section.isin(["strategy_A", "strategy_B"])) &
              (df.symbol == "PORTFOLIO") & (df.period == "holdout")]
    if len(hold):
        vals = hold["ann_capital_pct"].astype(float)
        add("multiple_testing", variant="SUMMARY", period="holdout",
            n_variants=len(hold),
            net_bp=float(hold["net_bp"].median()),
            ann_capital_pct=float(vals.median()),
            notes=(f"median={vals.median():.2f}%; "
                   f"p10={vals.quantile(.1):.2f}%; p90={vals.quantile(.9):.2f}%; "
                   f"best={vals.max():.2f}%; worst={vals.min():.2f}%"))

    df = pd.DataFrame(rows)
    out = os.path.join(OUT, "results.csv")
    df.to_csv(out, index=False, float_format="%.6f")
    print(f"\nwrote {out} rows={len(df)}")

    # console summary
    show = df[(df.section.isin(["strategy_A", "strategy_B"])) &
              (df.symbol == "PORTFOLIO") &
              (df.period.isin(["full", "calib", "holdout"]))]
    pt = show.pivot_table(index="variant", columns="period",
                          values="ann_capital_pct")
    print("\nannualised return on deployed capital (%) -- portfolio")
    print(pt.round(2).to_string())
    print("\nnet bp and cost decomposition, full period")
    print(show[show.period == "full"][
        ["variant", "gross_funding_bp", "price_pnl_bp", "fee_bp", "slip_bp",
         "transfer_bp", "transit_bp", "net_bp", "mdd_pct", "time_in_market_pct",
         "n_pair_changes", "bars_per_pair_change"]].round(2).to_string(index=False))


if __name__ == "__main__":
    main()
