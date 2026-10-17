#!/usr/bin/env python
"""Cash-and-carry (spot long / perp short) backtest for Binance USDT perps.

Data
----
- Spot 1h klines:      research/data/spot/<SYM>_1h.csv   (downloaded by fetch_data.py)
- Perp 1h klines:      research/carry/perp_ext/<SYM>_1h.csv (extended copy, see fetch_data.py)
- Funding history:     research/carry/funding_ext/<SYM>.csv

Design
------
- 8h grid at 00/08/16 UTC, 2026-04-20 00:00 .. 2026-10-17 00:00 (180 days).
- Calibration = first 120 days, holdout = last 60 days. Holdout is never used
  for parameter selection.
- Prices at a grid point use the *open* of the 1h candle stamped at that time
  (i.e. the tradable price at the settlement instant), spot and perp identical.
- Position: long $1 spot + short $1 perp at entry. No intra-hold rebalancing.
- Funding at t_k is credited/debited to whoever held the position over
  [t_{k-1}, t_k); a position opened at t_k does not receive f(t_k).
- Strategy signals at t_k use only funding rates realised at or before t_k.

Costs (per side, per leg)
-------------------------
- taker: spot 10 bp, perp 5 bp; maker: spot 10 bp, perp 2 bp.
- slippage 2 bp per leg per side in both modes.
- taker_bnb sensitivity: spot fee x0.75 (25% BNB discount), perp unchanged.

Return calibers
---------------
- total capital = spot notional + perp margin (notional/leverage).
- margin only   = pnl / perp margin (i.e. leverage x pnl on notional). This is a
  capital-efficiency figure, NOT a funded return: it ignores the spot leg.
"""
import os
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CARRY = os.path.join(ROOT, "research", "carry")

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
           "BNBUSDT", "ADAUSDT", "LINKUSDT"]
START = pd.Timestamp("2026-04-20 00:00:00", tz="UTC")
SPLIT = pd.Timestamp("2026-08-18 00:00:00", tz="UTC")   # 120 days
END = pd.Timestamp("2026-10-17 00:00:00", tz="UTC")     # +60 days
GRID = pd.date_range(START, END, freq="8h", tz="UTC")
T = len(GRID)
assert T == 541, T
SPLIT_IDX = int(np.where(GRID == SPLIT)[0][0])
assert SPLIT_IDX == 360, SPLIT_IDX
FULL_DAYS = (END - START).total_seconds() / 86400
CAL_DAYS = (SPLIT - START).total_seconds() / 86400
HOLD_DAYS = (END - SPLIT).total_seconds() / 86400

SLIP = 2e-4
FEE_MODES = {
    "taker": {"spot": 1.0e-3, "perp": 5.0e-4},
    "maker": {"spot": 1.0e-3, "perp": 2.0e-4},
    "taker_bnb": {"spot": 7.5e-4, "perp": 5.0e-4},
}
LEVERAGES = [3, 5]
STRATEGIES = {
    "A_always": ("A", None),
    "B_thr0": ("B", 0.0),
    "B_thr0.005pct": ("B", 5e-5),    # 0.5 bp per 8h
    "B_thr0.01pct": ("B", 1e-4),     # 1 bp per 8h
    "B_thr0.02pct": ("B", 2e-4),     # 2 bp per 8h
    "C_top23": ("C", None),
    # C implementation sensitivities (rebalance frequency / static calibration pick)
    "C_top23_weekly": ("Cw", None),
    "C_top23_monthly": ("Cm", None),
    "C_static_calib": ("Cs", None),
}


# --------------------------------------------------------------------------- #
# data
# --------------------------------------------------------------------------- #
def _load_open(path):
    df = pd.read_csv(path)
    df["t"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    s = df.set_index("t")["open"].astype(float)
    return s


def load_data():
    spot, perp, fund = {}, {}, {}
    for sym in SYMBOLS:
        s = _load_open(os.path.join(ROOT, "research", "data", "spot", f"{sym}_1h.csv"))
        p = _load_open(os.path.join(CARRY, "perp_ext", f"{sym}_1h.csv"))
        f = pd.read_csv(os.path.join(CARRY, "funding_ext", f"{sym}.csv"))
        ft = pd.to_datetime(f["funding_time"], unit="ms", utc=True).dt.round("8h")
        fs = pd.Series(f["funding_rate"].astype(float).values, index=ft)
        fs = fs[~fs.index.duplicated(keep="last")]
        spot[sym] = s.reindex(GRID)
        perp[sym] = p.reindex(GRID)
        fund[sym] = fs.reindex(GRID)
        assert spot[sym].notna().all(), f"spot gaps {sym}: {spot[sym].isna().sum()}"
        assert perp[sym].notna().all(), f"perp gaps {sym}: {perp[sym].isna().sum()}"
        assert fund[sym].notna().all(), f"funding gaps {sym}: {fund[sym].isna().sum()}"
    spot_df = pd.DataFrame(spot)
    perp_df = pd.DataFrame(perp)
    fund_df = pd.DataFrame(fund)
    return spot_df, perp_df, fund_df


def build_active(fund_df, strategy):
    """Boolean [n_symbols, T]; act[k] = hold over [t_k, t_{k+1}). act[-1] forced flat."""
    n = fund_df.shape[1]
    act = np.zeros((n, T), dtype=bool)
    kind, thr = STRATEGIES[strategy]
    if kind == "A":
        act[:, :T - 1] = True
    elif kind == "B":
        act[:, :T - 1] = fund_df.values.T[:, :T - 1] > thr
    elif kind == "C":
        trail = fund_df.rolling(21, min_periods=21).mean()
        act[:, :21] = True                      # 7-day warm-up: hold everything
        n_top = int(np.floor(n * 2 / 3))        # 8 * 2/3 -> 5
        for k in range(21, T - 1):
            vals = trail.iloc[k].values
            order = np.argsort(-vals, kind="stable")
            act[order[:n_top], k] = True
    elif kind in ("Cw", "Cm"):
        trail = fund_df.rolling(21, min_periods=21).mean()
        n_top = int(np.floor(n * 2 / 3))
        period = 21 if kind == "Cw" else 90     # 7 or 30 days
        act[:, :period] = True                  # warm-up: hold everything
        last = np.ones(n, dtype=bool)
        for k in range(period, T - 1):
            if (k - period) % period == 0:
                vals = trail.iloc[k].values
                order = np.argsort(-vals, kind="stable")
                last = np.zeros(n, dtype=bool)
                last[order[:n_top]] = True
            act[:, k] = last
    elif kind == "Cs":
        # Select top 2/3 using calibration-period mean funding only; hold through holdout.
        n_top = int(np.floor(n * 2 / 3))
        act[:, :SPLIT_IDX] = True
        means = fund_df.iloc[:SPLIT_IDX].mean().values
        order = np.argsort(-means, kind="stable")
        act[order[:n_top], SPLIT_IDX:] = True
    act[:, -1] = False
    return act


# --------------------------------------------------------------------------- #
# simulation
# --------------------------------------------------------------------------- #
@dataclass
class CoinResult:
    eq: np.ndarray
    eps: np.ndarray          # cumulative spot price pnl (incl. unrealised)
    epp: np.ndarray          # cumulative perp price pnl (incl. unrealised)
    fc: np.ndarray           # cumulative funding received
    c_sf: np.ndarray         # cumulative spot fee
    c_pf: np.ndarray         # cumulative perp fee
    c_ss: np.ndarray         # cumulative spot slippage
    c_ps: np.ndarray         # cumulative perp slippage
    entry_basis_bp: list = field(default_factory=list)
    exit_basis_bp: list = field(default_factory=list)
    entries: int = 0
    round_trips: int = 0
    extra: dict = field(default_factory=dict)


def sim_coin(s, p, f, act, fees, lev=3):
    cap = 1.0 + 1.0 / lev
    eq = np.empty(T)
    eps = np.zeros(T)
    epp = np.zeros(T)
    fc = np.zeros(T)
    c_sf = np.zeros(T)
    c_pf = np.zeros(T)
    c_ss = np.zeros(T)
    c_ps = np.zeros(T)

    cash = cap
    in_pos = False
    qs = qp = 0.0
    se = pe = 0.0
    fund_acc = 0.0
    real_s = real_p = 0.0
    cum_f = 0.0
    cum_sf = cum_pf = cum_ss = cum_ps = 0.0
    res = CoinResult(eq=eq, eps=eps, epp=epp, fc=fc,
                     c_sf=c_sf, c_pf=c_pf, c_ss=c_ss, c_ps=c_ps)

    fs, fp = fees["spot"], fees["perp"]

    for k in range(T):
        # funding for the interval that just ended
        if k > 0 and in_pos:
            pay = f[k] * qp * p[k]      # short receives positive funding
            fund_acc += pay
            cum_f += pay

        # trade at t_k to the target for [t_k, t_{k+1})
        if act[k] and not in_pos:
            qs = 1.0 / s[k]
            qp = 1.0 / p[k]
            se, pe = s[k], p[k]
            fund_acc = 0.0
            fee_s = fs * qs * s[k]
            fee_p = fp * qp * p[k]
            sl_s = SLIP * qs * s[k]
            sl_p = SLIP * qp * p[k]
            cash -= fee_s + fee_p + sl_s + sl_p
            cum_sf += fee_s
            cum_pf += fee_p
            cum_ss += sl_s
            cum_ps += sl_p
            in_pos = True
            res.entries += 1
            res.entry_basis_bp.append((pe / se - 1.0) * 1e4)
        elif not act[k] and in_pos:
            spx = qs * (s[k] - se)
            ppx = qp * (pe - p[k])
            fee_s = fs * qs * s[k]
            fee_p = fp * qp * p[k]
            sl_s = SLIP * qs * s[k]
            sl_p = SLIP * qp * p[k]
            cash += spx + ppx + fund_acc - fee_s - fee_p - sl_s - sl_p
            real_s += spx
            real_p += ppx
            cum_sf += fee_s
            cum_pf += fee_p
            cum_ss += sl_s
            cum_ps += sl_p
            res.exit_basis_bp.append((p[k] / s[k] - 1.0) * 1e4)
            fund_acc = 0.0
            in_pos = False
            res.round_trips += 1

        if in_pos:
            eq[k] = cash + qs * (s[k] - se) + qp * (pe - p[k]) + fund_acc
            eps[k] = real_s + qs * (s[k] - se)
            epp[k] = real_p + qp * (pe - p[k])
        else:
            eq[k] = cash
            eps[k] = real_s
            epp[k] = real_p
        fc[k] = cum_f
        c_sf[k] = cum_sf
        c_pf[k] = cum_pf
        c_ss[k] = cum_ss
        c_ps[k] = cum_ps

    assert not in_pos
    return res


# --------------------------------------------------------------------------- #
# metrics
# --------------------------------------------------------------------------- #
def _ann(net_ret, days):
    if net_ret <= -1.0:
        return -100.0
    return ((1.0 + net_ret) ** (365.0 / days) - 1.0) * 100.0


def _mdd(eq, i0, base):
    path = np.concatenate([[base], eq[i0:]])
    peak = np.maximum.accumulate(path)
    return float(np.min(path / peak - 1.0) * 100.0)


def _monthly(eq, i0, i1, base):
    s = pd.Series(eq[i0:i1 + 1], index=GRID[i0:i1 + 1])
    ends = s.resample("ME").last()
    starts = ends.shift(1)
    starts.iloc[0] = base
    return (ends / starts - 1.0)


def period_stats(res, i0, i1, lev, base_eq=None):
    """Stats over grid indices i0..i1 inclusive, with period starting equity base_eq."""
    base = (1.0 + 1.0 / lev) if base_eq is None else base_eq
    end_eq = res.eq[i1]
    net = end_eq - base
    # full/calibration start before t0 (zero baseline); holdout starts at eq[i0]
    b = i0 if i0 > 0 else None
    # component deltas relative to the period baseline
    def d(arr):
        return arr[i1] - (arr[b] if b is not None else 0.0)
    gross_f = d(res.fc)
    spot_px = d(res.eps)
    perp_px = d(res.epp)
    s_fee = d(res.c_sf)
    p_fee = d(res.c_pf)
    s_slip = d(res.c_ss)
    p_slip = d(res.c_ps)
    cost = s_fee + p_fee + s_slip + p_slip
    days = (GRID[i1] - GRID[i0]).total_seconds() / 86400
    if i0 == 0:
        days = (GRID[i1] - START).total_seconds() / 86400 + 8 / 24
    mret = _monthly(res.eq, i0, i1, base)
    return {
        "gross_funding_bp": gross_f * 1e4,
        "spot_px_bp": spot_px * 1e4,
        "perp_px_bp": perp_px * 1e4,
        "spot_fee_bp": s_fee * 1e4,
        "perp_fee_bp": p_fee * 1e4,
        "spot_slip_bp": s_slip * 1e4,
        "perp_slip_bp": p_slip * 1e4,
        "total_cost_bp": cost * 1e4,
        "net_bp": net * 1e4,
        "net_ret": net / base,
        "ann_total_pct": _ann(net / base, days),
        "ann_margin_pct": _ann(net * lev, days),
        "ann_notional_pct": _ann(net, days),
        "mdd_pct": _mdd(res.eq, i0, base),
        "pos_months_pct": 100.0 * float((mret > 0).mean()),
        "n_months": int(len(mret)),
        "time_in_market_pct": np.nan,  # filled by caller
    }


def portfolio_arrays(results, lev):
    cap = 1.0 + 1.0 / lev
    n = len(results)
    eq = cap + np.mean([r.eq - cap for r in results], axis=0)
    eps = np.mean([r.eps for r in results], axis=0)
    epp = np.mean([r.epp for r in results], axis=0)
    fc = np.mean([r.fc for r in results], axis=0)
    c_sf = np.mean([r.c_sf for r in results], axis=0)
    c_pf = np.mean([r.c_pf for r in results], axis=0)
    c_ss = np.mean([r.c_ss for r in results], axis=0)
    c_ps = np.mean([r.c_ps for r in results], axis=0)
    return pd.DataFrame({"eq": eq, "eps": eps, "epp": epp, "fc": fc,
                         "c_sf": c_sf, "c_pf": c_pf, "c_ss": c_ss, "c_ps": c_ps})


def stats_from_arrays(eq, fc, eps, epp, c_sf, c_pf, c_ss, c_ps,
                      i0, i1, lev, base_eq=None):
    base = (1.0 + 1.0 / lev) if base_eq is None else base_eq
    net = eq[i1] - base
    b = i0 if i0 > 0 else None
    def d(a):
        return a[i1] - (a[b] if b is not None else 0.0)
    gross_f, spot_px, perp_px = d(fc), d(eps), d(epp)
    s_fee, p_fee, s_slip, p_slip = d(c_sf), d(c_pf), d(c_ss), d(c_ps)
    cost = s_fee + p_fee + s_slip + p_slip
    days = (GRID[i1] - GRID[i0]).total_seconds() / 86400
    if i0 == 0:
        days = FULL_DAYS
    mret = _monthly(eq, i0, i1, base)
    return {
        "gross_funding_bp": gross_f * 1e4,
        "spot_px_bp": spot_px * 1e4,
        "perp_px_bp": perp_px * 1e4,
        "spot_fee_bp": s_fee * 1e4,
        "perp_fee_bp": p_fee * 1e4,
        "spot_slip_bp": s_slip * 1e4,
        "perp_slip_bp": p_slip * 1e4,
        "total_cost_bp": cost * 1e4,
        "net_bp": net * 1e4,
        "net_ret": net / base,
        "ann_total_pct": _ann(net / base, days),
        "ann_margin_pct": _ann(net * lev, days),
        "ann_notional_pct": _ann(net, days),
        "mdd_pct": _mdd(eq, i0, base),
        "pos_months_pct": 100.0 * float((mret > 0).mean()),
        "n_months": int(len(mret)),
    }


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    spot_df, perp_df, fund_df = load_data()
    print(f"grid {GRID[0]} .. {GRID[-1]}  T={T}  symbols={len(SYMBOLS)}")
    print(f"funding mean bp: {dict((s, round(fund_df[s].mean()*1e4,3)) for s in SYMBOLS)}")

    rows = []
    # ---------------- data diagnostics ----------------
    for sym in SYMBOLS:
        basis = (perp_df[sym] / spot_df[sym] - 1.0) * 1e4
        f = fund_df[sym]
        rows.append({
            "section": "data_diag", "variant": "", "fee_mode": "", "leverage": "",
            "period": "full", "symbol": sym,
            "funding_mean_bp": f.mean() * 1e4,
            "funding_std_bp": f.std() * 1e4,
            "funding_min_bp": f.min() * 1e4,
            "funding_max_bp": f.max() * 1e4,
            "funding_pos_share_pct": (f > 0).mean() * 100.0,
            "funding_ge_0.005pct": (f >= 5e-5).mean() * 100.0,
            "funding_ge_0.01pct": (f >= 1e-4).mean() * 100.0,
            "funding_ge_0.02pct": (f >= 2e-4).mean() * 100.0,
            "basis_mean_bp": basis.mean(),
            "basis_std_bp": basis.std(),
            "basis_abs_max_bp": basis.abs().max(),
            "notes": (f"basis_p1={basis.quantile(.01):.3f}bp; "
                      f"basis_p99={basis.quantile(.99):.3f}bp"),
        })

    # ---------------- margin / liquidation risk diagnostics ----------------
    for sym in SYMBOLS:
        s = spot_df[sym].values
        p = perp_df[sym].values
        rise = p.max() / p[0] - 1.0
        basis = (perp_df[sym] / spot_df[sym] - 1.0).abs() * 1e4
        rows.append({
            "section": "risk", "variant": "", "fee_mode": "", "leverage": "",
            "period": "full", "symbol": sym,
            "max_perp_rise_pct": rise * 100.0,
            "max_perp_dd_pct": (p.min() / p.max() - 1.0) * 100.0,
            "max_spot_rise_pct": (s.max() / s[0] - 1.0) * 100.0,
            "basis_abs_max_bp": basis.max(),
            "safe_isolated_lev_x": 1.0 / rise,
            "notes": "max_perp_rise is the adverse move for the short leg; "
                     "safe_isolated_lev assumes no margin top-up and no cross-margin",
        })

    # ---------------- run all strategy/fee combinations ----------------
    for strat in STRATEGIES:
        act = build_active(fund_df, strat)
        for fee_mode in ["taker", "maker"]:
            fees = FEE_MODES[fee_mode]
            for lev in [3]:   # per-coin detail only at 3x
                coin_res = {}
                for i, sym in enumerate(SYMBOLS):
                    coin_res[sym] = sim_coin(spot_df[sym].values, perp_df[sym].values,
                                             fund_df[sym].values, act[i], fees, lev)
                # per-coin rows at the primary period split
                if strat == "A_always" and fee_mode == "taker":
                    for si, sym in enumerate(SYMBOLS):
                        r = coin_res[sym]
                        rec = {"section": "per_coin", "variant": strat,
                               "fee_mode": fee_mode, "leverage": lev,
                               "period": "full", "symbol": sym}
                        rec.update(period_stats(r, 0, T - 1, lev))
                        rec.update({
                            "time_in_market_pct": 100.0 * act[si].mean(),
                            "n_roundtrips": r.round_trips,
                            "entries": r.entries,
                            "mean_basis_entry_bp": float(np.mean(r.entry_basis_bp)) if r.entry_basis_bp else np.nan,
                            "mean_basis_exit_bp": float(np.mean(r.exit_basis_bp)) if r.exit_basis_bp else np.nan,
                            "net_basis0_bp": rec["net_bp"] - rec["spot_px_bp"] - rec["perp_px_bp"],
                            "net_shock_10bp": rec["net_bp"] - 10.0,
                            "net_shock_30bp": rec["net_bp"] - 30.0,
                        })
                        rec["notes"] = ""
                        rows.append(rec)
                        # calib / holdout per coin
                        for per, (i0, i1) in {"calib": (0, SPLIT_IDX),
                                              "holdout": (SPLIT_IDX, T - 1)}.items():
                            rec2 = {"section": "per_coin", "variant": strat,
                                    "fee_mode": fee_mode, "leverage": lev,
                                    "period": per, "symbol": sym}
                            base_eq = r.eq[SPLIT_IDX] if per == "holdout" else None
                            rec2.update(period_stats(r, i0, i1, lev, base_eq=base_eq))
                            tm = act[si, i0:i1].mean() * 100.0 if i1 > i0 else 0.0
                            rec2.update({"time_in_market_pct": tm,
                                         "n_roundtrips": np.nan, "entries": np.nan,
                                         "mean_basis_entry_bp": np.nan,
                                         "mean_basis_exit_bp": np.nan,
                                         "net_basis0_bp": np.nan,
                                         "net_shock_10bp": np.nan,
                                         "net_shock_30bp": np.nan,
                                         "notes": ""})
                            rows.append(rec2)

                # portfolio rows for every strat/fee/leverage combo
                p = portfolio_arrays([coin_res[s] for s in SYMBOLS], lev)
                for lev2 in LEVERAGES:
                    cap = 1.0 + 1.0 / lev2
                    eq = cap + (p["eq"].values - (1.0 + 1.0 / lev))
                    # portfolio arrays are per-slot averages; rebase to lev2 capital
                    fc, eps, epp = p["fc"].values, p["eps"].values, p["epp"].values
                    c_sf, c_pf = p["c_sf"].values, p["c_pf"].values
                    c_ss, c_ps = p["c_ss"].values, p["c_ps"].values
                    for per, (i0, i1) in {"full": (0, T - 1),
                                          "calib": (0, SPLIT_IDX),
                                          "holdout": (SPLIT_IDX, T - 1)}.items():
                        if per == "full":
                            base_eq = cap
                        elif per == "calib":
                            base_eq = cap
                        else:
                            base_eq = eq[SPLIT_IDX]
                        st = stats_from_arrays(eq, fc, eps, epp, c_sf, c_pf,
                                               c_ss, c_ps, i0, i1, lev2, base_eq)
                        rec = {"section": "portfolio", "variant": strat,
                               "fee_mode": fee_mode, "leverage": lev2,
                               "period": per, "symbol": "PORTFOLIO"}
                        rec.update(st)
                        tm = act[:, i0:i1].mean() * 100.0
                        nrt = sum(coin_res[s].round_trips for s in SYMBOLS)
                        rec.update({"time_in_market_pct": tm,
                                    "n_roundtrips": nrt,
                                    "entries": sum(coin_res[s].entries for s in SYMBOLS),
                                    "mean_basis_entry_bp": np.nan,
                                    "mean_basis_exit_bp": np.nan,
                                    "net_basis0_bp": st["net_bp"] - st["spot_px_bp"] - st["perp_px_bp"],
                                    "net_shock_10bp": st["net_bp"] - 10.0,
                                    "net_shock_30bp": st["net_bp"] - 30.0,
                                    "notes": ""})
                        rows.append(rec)

    # ---------------- BNB discount sensitivity (primary A) ----------------
    act = build_active(fund_df, "A_always")
    coin_res = {}
    for i, sym in enumerate(SYMBOLS):
        coin_res[sym] = sim_coin(spot_df[sym].values, perp_df[sym].values,
                                 fund_df[sym].values, act[i], FEE_MODES["taker_bnb"], 3)
    p = portfolio_arrays([coin_res[s] for s in SYMBOLS], 3)
    for per, (i0, i1) in {"full": (0, T - 1), "calib": (0, SPLIT_IDX),
                          "holdout": (SPLIT_IDX, T - 1)}.items():
        base_eq = 1.0 + 1.0 / 3 if per != "holdout" else p["eq"].values[SPLIT_IDX]
        st = stats_from_arrays(p["eq"].values, p["fc"].values, p["eps"].values,
                               p["epp"].values, p["c_sf"].values, p["c_pf"].values,
                               p["c_ss"].values, p["c_ps"].values,
                               i0, i1, 3, base_eq)
        rec = {"section": "bnb_sensitivity", "variant": "A_always",
               "fee_mode": "taker_bnb", "leverage": 3, "period": per,
               "symbol": "PORTFOLIO"}
        rec.update(st)
        rec.update({"time_in_market_pct": 100.0, "n_roundtrips": 8, "entries": 8,
                    "mean_basis_entry_bp": np.nan, "mean_basis_exit_bp": np.nan,
                    "net_basis0_bp": st["net_bp"] - st["spot_px_bp"] - st["perp_px_bp"],
                    "net_shock_10bp": st["net_bp"] - 10.0,
                    "net_shock_30bp": st["net_bp"] - 30.0,
                    "notes": "spot fee x0.75 BNB discount; perp unchanged"})
        rows.append(rec)

    # ---------------- KORU exclusion diagnostics ----------------
    kf = pd.read_csv(os.path.join(CARRY, "funding_ext", "KORUUSDT.csv"))
    kr = kf["funding_rate"].astype(float)
    rows.append({
        "section": "excluded", "variant": "", "fee_mode": "", "leverage": "",
        "period": "full", "symbol": "KORUUSDT",
        "funding_mean_bp": kr.mean() * 1e4,
        "funding_std_bp": kr.std() * 1e4,
        "funding_min_bp": kr.min() * 1e4,
        "funding_max_bp": kr.max() * 1e4,
        "funding_pos_share_pct": (kr > 0).mean() * 100.0,
        "notes": (f"excluded: no Binance spot KORUUSDT market; n={len(kr)}; "
                  f"21.212963 contract conversion on 2026-07-15 (halt 00:20-09:35 UTC)"),
    })

    df = pd.DataFrame(rows)
    cols = ["section", "variant", "fee_mode", "leverage", "period", "symbol",
            "gross_funding_bp", "spot_px_bp", "perp_px_bp", "spot_fee_bp",
            "perp_fee_bp", "spot_slip_bp", "perp_slip_bp", "total_cost_bp",
            "net_bp", "ann_total_pct", "ann_margin_pct", "ann_notional_pct",
            "mdd_pct", "pos_months_pct", "n_months", "time_in_market_pct",
            "n_roundtrips", "entries", "mean_basis_entry_bp",
            "mean_basis_exit_bp", "net_basis0_bp", "net_shock_10bp",
            "net_shock_30bp",
            "funding_mean_bp", "funding_std_bp", "funding_min_bp",
            "funding_max_bp", "funding_pos_share_pct", "funding_ge_0.005pct",
            "funding_ge_0.01pct", "funding_ge_0.02pct",
            "basis_mean_bp", "basis_std_bp", "basis_abs_max_bp",
            "max_perp_rise_pct", "max_perp_dd_pct", "max_spot_rise_pct",
            "safe_isolated_lev_x",
            "notes"]
    df = df.reindex(columns=cols)
    out = os.path.join(CARRY, "results.csv")
    df.to_csv(out, index=False, float_format="%.4f")
    print(f"wrote {out}  rows={len(df)}")

    # console summary
    show = df[(df.section == "portfolio") & (df.period.isin(["full", "calib", "holdout"]))]
    pt = show.pivot_table(index=["variant", "fee_mode", "leverage"],
                          columns="period", values="ann_total_pct")
    print("\nannualised return on total capital (%)")
    print(pt.round(2).to_string())
    print("\nfull-period net bp and MDD (%)")
    print(show[show.leverage == 3].pivot_table(
        index=["variant", "fee_mode"], columns="period",
        values=["net_bp", "mdd_pct"]).round(2).to_string())


if __name__ == "__main__":
    main()
