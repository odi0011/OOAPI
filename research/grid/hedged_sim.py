#!/usr/bin/env python
"""Delta-neutral hedge + regime-filter variants of the grid study.

Reuses grid_sim.py for data loading, causal ranges, grid mechanics, fees,
funding, stops and detrending.  Adds:

A. Hedge variants (perpetual hedge of the grid's net inventory):
   - hedge_immediate : after every grid fill, hedge to net delta 0
                       (taker 5bp + 2bp slippage per hedge trade)
   - hedge_thr0.5    : at each 5m close, if |net delta| >= 0.5 * per-level
                       qty, hedge to 0
   - hedge_thr1.0    : same with 1.0x
   - hedge_timed15m  : every 15m boundary, hedge to 0 at the bar close
   - hedge_timed1h   : every 1h boundary
   - unhedged        : benchmark, no hedge leg

B. Regime-filter variants (applied to the unhedged grid):
   - ema200 : price > EMA200(1h) at campaign start -> long only;
              price < EMA200(1h) -> short only
   - ret7   : trailing 7d return sign -> long/short
   - ret30  : trailing 30d return sign -> long/short
   The filter is decided at campaign start with data strictly before t0.

Time discipline is unchanged: 30d warm-up + campaigns 0-5 (90d) = 120d
calibration; campaigns 6-9 (60d) = holdout; folds 0-2 / 3-5 / 6-9.

Output: research/grid/results_hedged.csv (long table, campaign + scope rows).
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time

import numpy as np
import pandas as pd
from scipy import stats

import grid_sim as g

HEDGE_TAKER = 0.0005
HEDGE_SLIP = 0.0002
B = g.NOTIONAL_BUDGET
LEV = g.FUT_LEVERAGE
MARGIN_GRID = B / LEV

HEDGE_MODES = [
    "unhedged", "hedge_immediate", "hedge_thr0.5", "hedge_thr1.0",
    "hedge_timed15m", "hedge_timed1h",
]
FILTERS = ["ema200", "ret7", "ret30"]

SCOPES = {
    "research": list(range(0, g.RESEARCH_CAMPAIGNS)),
    "holdout": list(range(g.RESEARCH_CAMPAIGNS, g.N_CAMPAIGNS)),
    "fold1": [0, 1, 2],
    "fold2": [3, 4, 5],
    "fold3": [6, 7, 8, 9],
    "all": list(range(g.N_CAMPAIGNS)),
}


def horizon_and_liq(sim: dict) -> tuple[int, float]:
    n = len(sim["_pos"])
    horizon = int(sim["stop_bar"]) if sim.get("stopped", 0) else n - 1
    liq = float(sim.get("_liq_px", float("nan")))
    return horizon, liq


def run_hedge(sim: dict, c: np.ndarray, t: np.ndarray,
              funding_t: np.ndarray, funding_r: np.ndarray,
              start_ms: int, end_ms: int, mode: str, qty: float) -> dict:
    """Compute the hedge leg and the combined grid+hedge PnL for one campaign."""
    n = len(c)
    pos = sim["_pos"]
    horizon, liq_px = horizon_and_liq(sim)

    dh = np.zeros(n, dtype=float)
    dcash = np.zeros(n, dtype=float)
    state = {"trades": 0, "notional": 0.0, "cost": 0.0}
    H = 0.0

    def trade(bar: int, size: float, price: float) -> None:
        nonlocal H
        if abs(size) <= 1e-12:
            return
        price = float(price)
        if not np.isfinite(price) or price <= 0:
            return
        if size > 0:
            gross = size * price
            cash = -gross * (1.0 + HEDGE_SLIP) * (1.0 + HEDGE_TAKER)
            cost = -cash - gross
        else:
            q = -size
            gross = q * price
            cash = gross * (1.0 - HEDGE_SLIP) * (1.0 - HEDGE_TAKER)
            cost = gross - cash
        dh[bar] += size
        dcash[bar] += cash
        state["trades"] += 1
        state["notional"] += abs(size) * price
        state["cost"] += cost
        H += size

    if mode == "hedge_immediate":
        gp = 0.0
        for bar, delta, price in sim["_fill_events"]:
            if bar > horizon:
                break
            gp += delta
            trade(bar, -gp - H, price)
        # the grid liquidation event should have closed the hedge; protect anyway
        if abs(H) > 1e-12:
            px = liq_px if (sim.get("stopped", 0) and np.isfinite(liq_px)) else c[horizon]
            trade(horizon, -H, px)
    elif mode in ("hedge_thr0.5", "hedge_thr1.0"):
        thr = 0.5 if mode.endswith("0.5") else 1.0
        for bar in range(horizon + 1):
            net = pos[bar] + H
            if abs(net) >= thr * qty:
                trade(bar, -pos[bar] - H, c[bar])
        if abs(H) > 1e-12:
            px = liq_px if (sim.get("stopped", 0) and np.isfinite(liq_px)) else c[horizon]
            trade(horizon, -H, px)
    elif mode in ("hedge_timed15m", "hedge_timed1h"):
        interval = 900_000 if mode.endswith("15m") else 3_600_000
        b = ((start_ms + interval - 1) // interval) * interval
        if b == start_ms:
            b += interval
        while b < end_ms:
            j = int(np.searchsorted(t, b, side="left")) - 1
            if 0 <= j <= horizon:
                trade(j, -pos[j] - H, c[j])
            b += interval
        if abs(H) > 1e-12:
            px = liq_px if (sim.get("stopped", 0) and np.isfinite(liq_px)) else c[horizon]
            trade(horizon, -H, px)
    else:
        raise ValueError(mode)

    # funding on the hedge leg
    hedge_funding = 0.0
    H_path = np.cumsum(dh)
    if len(funding_t):
        fsel = (funding_t >= start_ms) & (funding_t < end_ms)
        fts, frs = funding_t[fsel], funding_r[fsel]
        if len(fts):
            fidx = np.searchsorted(t, fts, side="right") - 1
            good = (fidx >= 0) & (fidx < n)
            for ft, fr, fi in zip(fts[good], frs[good], fidx[good]):
                h = float(H_path[fi])
                if abs(h) <= 1e-12:
                    continue
                pnl = -h * float(c[fi]) * float(fr)
                dcash[fi] += pnl
                hedge_funding += pnl

    hedge_equity = np.cumsum(dcash) + H_path * c
    combined = sim["_equity"] + hedge_equity

    hedge_cost = float(state["cost"])
    hedge_notional = float(state["notional"])
    hedge_trades = int(state["trades"])
    hedge_price_pnl = float(hedge_equity[-1]) + hedge_cost - hedge_funding
    grid_fees = float(sim["cycle_fees"] + sim["open_entry_fee"])
    grid_liq = float(sim["liquidation_cost"])
    grid_funding = float(sim["funding_pnl"])
    residual_market = float(sim["cycle_gross"] + sim["open_gross"] + hedge_price_pnl)
    total = float(combined[-1])
    identity = residual_market - grid_fees - grid_liq - hedge_cost + grid_funding + hedge_funding

    runmax = np.maximum.accumulate(np.concatenate(([0.0], combined)))
    dd = runmax[1:] - combined
    max_dd = float(np.max(dd)) if n else 0.0
    max_float = float(max(0.0, -np.min(combined))) if n else 0.0

    net_delta = pos + H_path
    max_abs_delta_qty = float(np.max(np.abs(net_delta))) if n else 0.0
    max_abs_delta_notional = float(np.max(np.abs(net_delta) * c)) if n else 0.0
    avg_abs_delta_notional = float(np.mean(np.abs(net_delta) * c)) if n else 0.0
    max_hedge_notional = float(np.max(np.abs(H_path) * c)) if n else 0.0
    margin_hedge = max_hedge_notional / LEV
    margin_gross = MARGIN_GRID + margin_hedge
    margin_net = MARGIN_GRID + max(0.0, max_abs_delta_notional) / LEV

    cycles = int(sim["cycles"])
    return {
        "total_pnl": total,
        "grid_total_pnl": float(sim["total_pnl"]),
        "cycle_gross": float(sim["cycle_gross"]),
        "grid_fees": grid_fees,
        "grid_liq": grid_liq,
        "grid_funding": grid_funding,
        "hedge_cost": hedge_cost,
        "hedge_funding": hedge_funding,
        "net_funding": grid_funding + hedge_funding,
        "hedge_price_pnl": hedge_price_pnl,
        "residual_market_pnl": residual_market,
        "identity_check": total - identity,
        "hedge_trades": hedge_trades,
        "hedge_notional": hedge_notional,
        "hedge_turnover": hedge_notional / B,
        "hedge_cost_per_cycle": hedge_cost / cycles if cycles else float("nan"),
        "hedge_cost_pct_gross": hedge_cost / float(sim["cycle_gross"]) if sim["cycle_gross"] > 0 else float("nan"),
        "max_dd_usdt": max_dd,
        "max_floating_loss": max_float,
        "max_abs_delta_qty": max_abs_delta_qty,
        "max_abs_delta_notional": max_abs_delta_notional,
        "avg_abs_delta_notional": avg_abs_delta_notional,
        "max_hedge_notional": max_hedge_notional,
        "margin_grid": MARGIN_GRID,
        "margin_hedge": margin_hedge,
        "margin_gross": margin_gross,
        "margin_net": margin_net,
        "ret_margin_gross": total / margin_gross if margin_gross else float("nan"),
        "ret_margin_net": total / margin_net if margin_net else float("nan"),
        "ret_notional": total / B,
        "max_dd_pct_margin": max_dd / margin_gross if margin_gross else float("nan"),
        "max_dd_pct_notional": max_dd / B,
        "cycles": cycles,
        "cycles_per_day": cycles / g.CAMPAIGN_DAYS,
        "stopped": int(sim.get("stopped", 0)),
        "idle_share": float(sim["idle_share"]),
        "max_concurrent": int(sim["max_concurrent"]),
    }


def aggregate(campaign_rows: list[dict]) -> list[dict]:
    """Aggregate campaign rows by config/variant/scope."""
    if not campaign_rows:
        return []
    df = pd.DataFrame(campaign_rows)
    keys = ["variant", "symbol", "direction", "levels", "rule", "stop_pct"]
    out = []
    for key, grp in df.groupby(keys, dropna=False):
        base = dict(zip(keys, key))
        for scope, ks in SCOPES.items():
            x = grp[grp["campaign_id"].isin(ks)]
            n = len(x)
            run = x[x["runnable"] == 1]
            nr = len(run)
            total = float(x["total_pnl"].sum())
            pnls = run["total_pnl"].values
            mean_run = float(np.mean(pnls)) if nr else float("nan")
            std_run = float(np.std(pnls, ddof=1)) if nr >= 2 else float("nan")
            if nr >= 2 and std_run > 1e-12:
                tstat = mean_run / (std_run / math.sqrt(nr))
                pval = float(2 * stats.t.sf(abs(tstat), df=nr - 1))
            else:
                tstat = float("nan")
                pval = float("nan")
            margin_gross = float(run["margin_gross"].max()) if nr else float("nan")
            margin_net = float(run["margin_net"].max()) if nr else float("nan")
            max_dd = float(run["max_dd_usdt"].max()) if nr else 0.0
            cycle_gross = float(x["cycle_gross"].sum())
            hedge_cost = float(x["hedge_cost"].sum())
            cycles = float(x["cycles"].sum())
            row = dict(base)
            row.update({
                "scope": scope,
                "n_campaigns": n, "n_runnable": nr,
                "run_rate": nr / n if n else float("nan"),
                "calendar_days": g.CAMPAIGN_DAYS * n,
                "trading_days": g.CAMPAIGN_DAYS * nr,
                "total_pnl": total,
                "mean_pnl_all": total / n if n else float("nan"),
                "mean_pnl_run": mean_run,
                "median_pnl_run": float(np.median(pnls)) if nr else float("nan"),
                "std_pnl_run": std_run,
                "t_stat": tstat, "p_value": pval,
                "positive_share_run": float(np.mean(pnls > 0)) if nr else float("nan"),
                "grid_total_pnl": float(x["grid_total_pnl"].sum()),
                "cycle_gross": cycle_gross,
                "grid_fees": float(x["grid_fees"].sum()),
                "grid_liq": float(x["grid_liq"].sum()),
                "grid_funding": float(x["grid_funding"].sum()),
                "hedge_cost": hedge_cost,
                "hedge_funding": float(x["hedge_funding"].sum()),
                "net_funding": float(x["net_funding"].sum()),
                "hedge_price_pnl": float(x["hedge_price_pnl"].sum()),
                "residual_market_pnl": float(x["residual_market_pnl"].sum()),
                "identity_check": float(np.max(np.abs(x["identity_check"]))) if n else 0.0,
                "hedge_trades": float(x["hedge_trades"].sum()),
                "hedge_notional": float(x["hedge_notional"].sum()),
                "hedge_turnover": float(x["hedge_notional"].sum()) / B,
                "hedge_turnover_per_day": float(x["hedge_notional"].sum()) / (g.CAMPAIGN_DAYS * nr) if nr else float("nan"),
                "hedge_cost_per_cycle": hedge_cost / cycles if cycles else float("nan"),
                "hedge_cost_pct_gross": hedge_cost / cycle_gross if cycle_gross > 0 else float("nan"),
                "residual_share_gross": float(x["residual_market_pnl"].sum()) / cycle_gross if cycle_gross > 0 else float("nan"),
                "max_dd_usdt": max_dd,
                "max_floating_loss": float(run["max_floating_loss"].max()) if nr else 0.0,
                "max_abs_delta_qty": float(run["max_abs_delta_qty"].max()) if nr else 0.0,
                "max_abs_delta_notional": float(run["max_abs_delta_notional"].max()) if nr else 0.0,
                "avg_abs_delta_notional": float(run["avg_abs_delta_notional"].mean()) if nr else float("nan"),
                "max_hedge_notional": float(run["max_hedge_notional"].max()) if nr else 0.0,
                "margin_grid": MARGIN_GRID,
                "margin_hedge": float(run["margin_hedge"].max()) if nr else 0.0,
                "margin_gross": margin_gross,
                "margin_net": margin_net,
                "ret_margin_gross": total / margin_gross if nr and margin_gross else float("nan"),
                "ret_margin_net": total / margin_net if nr and margin_net else float("nan"),
                "ret_notional": total / B,
                "max_dd_pct_margin": max_dd / margin_gross if nr and margin_gross else float("nan"),
                "max_dd_pct_notional": max_dd / B,
                "cycles": cycles,
                "cycles_per_day": cycles / (g.CAMPAIGN_DAYS * nr) if nr else float("nan"),
                "stopped_share": float(x["stopped"].mean()) if n else float("nan"),
                "idle_share": float(x["idle_share"].mean()) if n else float("nan"),
                "max_concurrent": int(run["max_concurrent"].max()) if nr else 0,
                "selected_long_share": float((x.get("selected_dir") == "long").mean()) if "selected_dir" in x else float("nan"),
                "selected_short_share": float((x.get("selected_dir") == "short").mean()) if "selected_dir" in x else float("nan"),
                "selected_skip_share": float((x.get("selected_dir") == "skip").mean()) if "selected_dir" in x else float("nan"),
            })
            out.append(row)
    return out


def signal_ema200(sd: g.SymData, t0: int) -> int:
    if sd.h1 is not None and len(sd.h1) > 20:
        h = sd.h1
        m = (h["open_time"].values.astype(np.int64) + g.HOUR_MS) <= t0
        h = h[m]
        closes = h["close"].values.astype(float)
    else:
        b = g.resample_bars(sd.o, sd.h, sd.l, sd.c, sd.t, g.HOUR_MS)
        m = (b["t"] + g.HOUR_MS) <= t0
        closes = b["c"][m]
    if len(closes) < 200:
        return 0
    ema = pd.Series(closes).ewm(span=200, adjust=False).mean().values[-1]
    return 1 if closes[-1] > ema else -1


def signal_return(sd: g.SymData, t0: int, days: int) -> int:
    lo = t0 - days * g.DAY_MS
    if len(sd.t) == 0 or int(sd.t[0]) > lo + g.HOUR_MS:
        return 0
    j0 = int(np.searchsorted(sd.t, lo, side="left"))
    j1 = int(np.searchsorted(sd.t, t0, side="left")) - 1
    if j0 >= len(sd.c) or j1 < 0 or j0 > j1:
        return 0
    p0, p1 = float(sd.c[j0]), float(sd.c[j1])
    if p0 <= 0 or p1 <= 0:
        return 0
    return 1 if p1 > p0 else -1


def make_signals(sd: g.SymData, campaigns: list[tuple[int, int]]) -> dict[int, dict[str, int]]:
    out = {}
    for k, (start_ms, _end_ms) in enumerate(campaigns):
        out[k] = {
            "ema200": signal_ema200(sd, start_ms),
            "ret7": signal_return(sd, start_ms, 7),
            "ret30": signal_return(sd, start_ms, 30),
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default=",".join(g.SYMBOLS))
    ap.add_argument("--levels", default=",".join(map(str, g.LEVELS)))
    ap.add_argument("--rules", default=",".join(g.RULES))
    ap.add_argument("--stops", default="0,0.02")
    ap.add_argument("--hedge-modes", default=",".join(HEDGE_MODES))
    ap.add_argument("--filters", default=",".join(FILTERS))
    ap.add_argument("--out", default=os.path.join(g.OUTDIR, "results_hedged.csv"))
    ap.add_argument("--max-symbols", type=int, default=0)
    args = ap.parse_args()

    symbols = [x.strip().upper() for x in args.symbols.split(",") if x.strip()]
    levels = [int(x) for x in args.levels.split(",") if x.strip()]
    rules = [x.strip() for x in args.rules.split(",") if x.strip()]
    stops = [float(x) for x in args.stops.split(",") if x.strip()]
    modes = [x.strip() for x in args.hedge_modes.split(",") if x.strip()]
    filters = [x.strip() for x in args.filters.split(",") if x.strip()]
    if args.max_symbols:
        symbols = symbols[:args.max_symbols]

    rules_ex = g.load_exchange_rules()
    data = {}
    for sym in symbols:
        t0 = time.time()
        data[sym] = g.load_symbol(sym, rules_ex)
        adj = data[sym].adjustment
        msg = ""
        if adj:
            msg = f" [contract change x{adj['factor']:.4f}, dropped {adj['dropped_bars']} halt bars]"
        print(f"loaded {sym}: 5m={len(data[sym].t)} daily={len(data[sym].daily)} "
              f"({time.time()-t0:.1f}s){msg}", file=sys.stderr)

    global_start = min(int(d.t[0]) for d in data.values())
    campaigns = [
        (global_start + (g.WARMUP_DAYS + g.CAMPAIGN_DAYS * k) * g.DAY_MS,
         global_start + (g.WARMUP_DAYS + g.CAMPAIGN_DAYS * (k + 1)) * g.DAY_MS)
        for k in range(g.N_CAMPAIGNS)
    ]

    all_rows: list[dict] = []
    # key -> unhedged campaign rows by direction, for the regime filter
    base_rows: dict[tuple, dict[str, dict]] = {}
    t_start = time.time()
    for sym in symbols:
        sd = data[sym]
        signals = make_signals(sd, campaigns)
        for levels_ in levels:
            for rule in rules:
                for k, (start_ms, end_ms) in enumerate(campaigns):
                    # build the same grid for both directions / stops
                    rng = g.range_for_rule(sd, start_ms, rule)
                    if rng is None:
                        built = {"ok": False, "reason": "insufficient_history",
                                 "lines": None, "qty": 0.0, "spacing_pct": float("nan"),
                                 "range_width_pct": float("nan"),
                                 "lower": float("nan"), "upper": float("nan")}
                    else:
                        lower, upper = rng
                        built = g.build_grid(sd, lower, upper, levels_, g.MAKER_FUT)
                        built["lower"], built["upper"] = lower, upper
                    bars = g.campaign_bars(sd, start_ms, end_ms, 300000)
                    start_price = float(bars["o"][0]) if bars is not None else float("nan")
                    runnable = (built["ok"] and bars is not None
                                and built["lower"] <= start_price <= built["upper"])
                    skip_reason = ""
                    if not built["ok"]:
                        skip_reason = built["reason"]
                    elif bars is None:
                        skip_reason = "no_bars"
                    elif not (built["lower"] <= start_price <= built["upper"]):
                        skip_reason = "price_out_of_range"
                    hits = None
                    if runnable:
                        hits = g.precompute_hits(bars["o"], bars["h"], bars["l"],
                                                 bars["c"], built["lines"], start_price)

                    for direction in ("long", "short"):
                        for stop in stops:
                            base = {
                                "variant": "", "symbol": sym, "direction": direction,
                                "levels": levels_, "rule": rule, "stop_pct": stop,
                                "scope": "campaign",
                                "campaign_id": k, "calendar_days": g.CAMPAIGN_DAYS,
                                "runnable": 1 if runnable else 0,
                                "skip_reason": skip_reason,
                                "range_lower": built.get("lower", float("nan")),
                                "range_upper": built.get("upper", float("nan")),
                                "range_width_pct": built.get("range_width_pct", float("nan")),
                                "spacing_pct": built.get("spacing_pct", float("nan")),
                                "qty": built.get("qty", 0.0),
                            }
                            if runnable:
                                sim = g.simulate_campaign(
                                    sd, bars, built["lines"], built["qty"],
                                    direction, "futures", g.MAKER_FUT, g.TAKER_FUT,
                                    hits, start_ms, end_ms, stop_pct=stop,
                                    compute_daily=False,
                                )
                            else:
                                sim = None

                            if sim is None:
                                # skipped rows for every hedge mode
                                for mode in modes:
                                    row = dict(base)
                                    row["variant"] = mode
                                    row.update({k2: 0.0 for k2 in (
                                        "total_pnl", "grid_total_pnl", "cycle_gross",
                                        "grid_fees", "grid_liq", "grid_funding",
                                        "hedge_cost", "hedge_funding", "net_funding",
                                        "hedge_price_pnl", "residual_market_pnl",
                                        "identity_check", "hedge_trades", "hedge_notional",
                                        "hedge_turnover", "hedge_cost_per_cycle",
                                        "hedge_cost_pct_gross", "max_dd_usdt",
                                        "max_floating_loss", "max_abs_delta_qty",
                                        "max_abs_delta_notional", "avg_abs_delta_notional",
                                        "max_hedge_notional", "margin_grid", "margin_hedge",
                                        "margin_gross", "margin_net", "max_dd_pct_margin",
                                        "max_dd_pct_notional", "cycles", "stopped",
                                        "residual_share_gross")})
                                    row.update({
                                        "ret_margin_gross": 0.0, "ret_margin_net": 0.0,
                                        "ret_notional": 0.0, "cycles_per_day": 0.0,
                                        "idle_share": 1.0, "max_concurrent": 0,
                                        "margin_grid": MARGIN_GRID,
                                        "margin_gross": MARGIN_GRID,
                                        "margin_net": MARGIN_GRID,
                                    })
                                    all_rows.append(row)
                                    if mode == "unhedged":
                                        base_rows[(sym, levels_, rule, stop, k, direction)] = row
                                continue

                            # unhedged benchmark from the raw sim
                            for mode in modes:
                                if mode == "unhedged":
                                    hedge = {
                                        "total_pnl": float(sim["total_pnl"]),
                                        "grid_total_pnl": float(sim["total_pnl"]),
                                        "cycle_gross": float(sim["cycle_gross"]),
                                        "grid_fees": float(sim["cycle_fees"] + sim["open_entry_fee"]),
                                        "grid_liq": float(sim["liquidation_cost"]),
                                        "grid_funding": float(sim["funding_pnl"]),
                                        "hedge_cost": 0.0, "hedge_funding": 0.0,
                                        "net_funding": float(sim["funding_pnl"]),
                                        "hedge_price_pnl": 0.0,
                                        "residual_market_pnl": float(sim["cycle_gross"] + sim["open_gross"]),
                                        "identity_check": 0.0,
                                        "hedge_trades": 0, "hedge_notional": 0.0,
                                        "hedge_turnover": 0.0,
                                        "hedge_cost_per_cycle": 0.0,
                                        "hedge_cost_pct_gross": 0.0,
                                        "max_dd_usdt": float(sim["max_dd_usdt"]),
                                        "max_floating_loss": float(sim["max_floating_loss"]),
                                        "max_abs_delta_qty": float(np.max(np.abs(sim["_pos"]))) if len(sim["_pos"]) else 0.0,
                                        "max_abs_delta_notional": float(np.max(np.abs(sim["_pos"]) * bars["c"])) if len(sim["_pos"]) else 0.0,
                                        "avg_abs_delta_notional": float(np.mean(np.abs(sim["_pos"]) * bars["c"])) if len(sim["_pos"]) else 0.0,
                                        "max_hedge_notional": 0.0,
                                        "margin_grid": MARGIN_GRID, "margin_hedge": 0.0,
                                        "margin_gross": MARGIN_GRID, "margin_net": MARGIN_GRID,
                                        "ret_margin_gross": float(sim["total_pnl"]) / MARGIN_GRID,
                                        "ret_margin_net": float(sim["total_pnl"]) / MARGIN_GRID,
                                        "ret_notional": float(sim["total_pnl"]) / B,
                                        "max_dd_pct_margin": float(sim["max_dd_usdt"]) / MARGIN_GRID,
                                        "max_dd_pct_notional": float(sim["max_dd_usdt"]) / B,
                                        "cycles": int(sim["cycles"]),
                                        "cycles_per_day": int(sim["cycles"]) / g.CAMPAIGN_DAYS,
                                        "stopped": int(sim.get("stopped", 0)),
                                        "idle_share": float(sim["idle_share"]),
                                        "max_concurrent": int(sim["max_concurrent"]),
                                        "residual_share_gross": 1.0,
                                    }
                                else:
                                    hedge = run_hedge(
                                        sim, bars["c"], bars["t"], sd.funding_t, sd.funding_r,
                                        start_ms, end_ms, mode, built["qty"],
                                    )
                                row = dict(base)
                                row["variant"] = mode
                                row.update(hedge)
                                all_rows.append(row)
                                if mode == "unhedged":
                                    base_rows[(sym, levels_, rule, stop, k, direction)] = row
        print(f"done {sym} ({time.time()-t_start:.0f}s)", file=sys.stderr)

    # ---------------- regime-filter rows (applied to unhedged grid) --------
    for sym in symbols:
        sd = data[sym]
        signals = make_signals(sd, campaigns)
        for levels_ in levels:
            for rule in rules:
                for stop in stops:
                    for filt in filters:
                        for k, _ in enumerate(campaigns):
                            sig = signals[k].get(filt, 0)
                            if sig > 0:
                                sel = "long"
                            elif sig < 0:
                                sel = "short"
                            else:
                                sel = "skip"
                            if sel == "skip":
                                row = {
                                    "variant": f"filter_{filt}", "symbol": sym,
                                    "direction": "filtered", "levels": levels_,
                                    "rule": rule, "stop_pct": stop,
                                    "scope": "campaign", "campaign_id": k,
                                    "selected_dir": "skip", "calendar_days": g.CAMPAIGN_DAYS,
                                    "runnable": 0, "skip_reason": "filter_no_signal",
                                    "range_lower": float("nan"), "range_upper": float("nan"),
                                    "range_width_pct": float("nan"), "spacing_pct": float("nan"),
                                    "qty": 0.0,
                                }
                                row.update({k2: 0.0 for k2 in (
                                    "total_pnl", "grid_total_pnl", "cycle_gross",
                                    "grid_fees", "grid_liq", "grid_funding",
                                    "hedge_cost", "hedge_funding", "net_funding",
                                    "hedge_price_pnl", "residual_market_pnl",
                                    "identity_check", "hedge_trades", "hedge_notional",
                                    "hedge_turnover", "hedge_cost_per_cycle",
                                    "hedge_cost_pct_gross", "max_dd_usdt",
                                    "max_floating_loss", "max_abs_delta_qty",
                                    "max_abs_delta_notional", "avg_abs_delta_notional",
                                    "max_hedge_notional", "margin_hedge",
                                    "max_dd_pct_margin", "max_dd_pct_notional",
                                    "cycles", "stopped", "residual_share_gross")})
                                row.update({
                                    "margin_grid": MARGIN_GRID, "margin_gross": MARGIN_GRID,
                                    "margin_net": MARGIN_GRID, "ret_margin_gross": 0.0,
                                    "ret_margin_net": 0.0, "ret_notional": 0.0,
                                    "cycles_per_day": 0.0, "idle_share": 1.0,
                                    "max_concurrent": 0,
                                })
                                all_rows.append(row)
                                continue
                            # use the unhedged campaign row for the selected direction
                            src = base_rows.get((sym, levels_, rule, stop, k, sel))
                            if src is None:
                                continue
                            row = dict(src)
                            row["variant"] = f"filter_{filt}"
                            row["direction"] = "filtered"
                            row["selected_dir"] = sel
                            all_rows.append(row)

    aggs = aggregate(all_rows)
    rows = all_rows + aggs
    preferred = [
        "variant", "symbol", "direction", "levels", "rule", "stop_pct",
        "scope", "campaign_id", "selected_dir", "calendar_days", "trading_days",
        "runnable", "run_rate", "skip_reason", "range_lower", "range_upper",
        "range_width_pct", "spacing_pct", "qty",
        "total_pnl", "mean_pnl_all", "mean_pnl_run", "median_pnl_run",
        "std_pnl_run", "t_stat", "p_value", "positive_share_run",
        "grid_total_pnl", "cycle_gross", "grid_fees", "grid_liq", "grid_funding",
        "hedge_cost", "hedge_funding", "net_funding", "hedge_price_pnl",
        "residual_market_pnl", "identity_check", "residual_share_gross",
        "hedge_trades", "hedge_notional", "hedge_turnover",
        "hedge_turnover_per_day", "hedge_cost_per_cycle", "hedge_cost_pct_gross",
        "max_dd_usdt", "max_floating_loss", "max_abs_delta_qty",
        "max_abs_delta_notional", "avg_abs_delta_notional", "max_hedge_notional",
        "margin_grid", "margin_hedge", "margin_gross", "margin_net",
        "ret_margin_gross", "ret_margin_net", "ret_notional",
        "max_dd_pct_margin", "max_dd_pct_notional", "cycles", "cycles_per_day",
        "stopped", "stopped_share", "idle_share", "max_concurrent",
        "selected_long_share", "selected_short_share", "selected_skip_share",
        "n_campaigns", "n_runnable",
    ]
    extra = sorted({k for r in rows for k in r} - set(preferred))
    cols = preferred + extra
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    df = pd.DataFrame(rows)
    df.to_csv(args.out, index=False, columns=cols, float_format="%.10g")
    print(f"wrote {len(rows)} rows -> {args.out} ({time.time()-t_start:.0f}s)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
