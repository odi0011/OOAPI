"""Long-history trend / momentum backtest on Binance USDT-M perpetuals.

Families
  A  time-series momentum (lookback 20/50/100/200 bars), sign long/short,
     vol-normalised position, weekly/monthly rebalance.
  B  EMA50/200 trend (cross state or price vs EMA200), ATR(14) 2/3 stop,
     weekly/monthly rebalance.
  C  cross-sectional momentum (20/50/100 bars), long top 1/3 short bottom 1/3,
     equal or inverse-vol weights, weekly/monthly rebalance, optional buffer.
  D  equal-risk combination of A+B+C (1d), target 20% portfolio vol.

Execution: signal at close of bar t, trade at open of bar t+1.  P&L is
open-to-open.  Stops are checked intra-bar and filled at the stop (or the
open on a gap).  Costs: taker 5bp + 2bp slippage = 7bp per side;
maker 2bp + 1bp = 3bp per side.  Cost = sum(|dw|) * one-side cost.

Walk-forward: 12-month train / 3-month test, rolling quarterly, OOS from
2021-01.  Parameters are chosen on the training window only (net Sharpe,
minimum activity).  All test windows are concatenated.

Outputs: results.csv, console tables.
"""
import itertools
import math
import os
import warnings
from datetime import timezone

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(HERE, "..", "data", "longterm"))
OUT_CSV = os.path.join(HERE, "results.csv")

SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "LINK", "AVAX", "DOT",
    "LTC", "BCH", "TRX", "ETC", "ATOM", "UNI", "NEAR", "APT", "ARB", "OP",
]
TFS = ["1d", "4h"]
BARS_PER_YEAR = {"1d": 365.0, "4h": 365.0 * 6.0}
VOL_WIN = {"1d": 30, "4h": 180}          # ~30 calendar days
NW_LAG = {"1d": 10, "4h": 42}
COSTS = {"taker": 0.0007, "maker": 0.0003}
MAX_LEV = 3.0
OOS_START = pd.Timestamp("2021-01-01", tz="UTC")
TRAIN_MONTHS = 12
TEST_MONTHS = 3
NOW = pd.Timestamp.now(tz="UTC")

A_LOOKBACKS = [20, 50, 100, 200]
VOL_TARGETS = [0.20, 0.40]
REBAL = ["W", "M"]

B_RULES = ["cross", "price200"]
B_STOPS = [2.0, 3.0]

C_LOOKBACKS = [20, 50, 100]
C_WEIGHTS = ["equal", "invvol"]
C_BUFFERS = [False, True]


# ----------------------------------------------------------------------------
# data
# ----------------------------------------------------------------------------
def load_panel(tf):
    frames = {}
    for sym in SYMBOLS:
        path = os.path.join(DATA_DIR, f"{sym}_{tf}.csv")
        if not os.path.exists(path):
            continue
        df = pd.read_csv(path)
        df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
        df["close_time"] = pd.to_datetime(df["close_time"], utc=True)
        df = df[df["close_time"] <= NOW]          # drop the unfinished bar
        df = df.drop_duplicates("open_time").sort_values("open_time")
        df = df.set_index("open_time")
        frames[sym] = df[["open", "high", "low", "close", "volume"]].astype(float)
    idx = pd.DatetimeIndex(sorted(set().union(*[set(f.index) for f in frames.values()])))
    panel = {}
    for col in ["open", "high", "low", "close", "volume"]:
        panel[col] = pd.DataFrame(
            {s: f[col].reindex(idx) for s, f in frames.items()}, index=idx)
    return panel


def rolling_sigma(close, tf):
    win = VOL_WIN[tf]
    return (close.pct_change()
            .rolling(win, min_periods=max(10, win // 2))
            .std() * math.sqrt(BARS_PER_YEAR[tf]))


def rebal_mask(idx, freq):
    """True on the first bar of each ISO week / calendar month."""
    if freq == "W":
        iso = idx.isocalendar()
        key = iso.year.astype(str) + "-" + iso.week.astype(str)
    else:
        key = idx.year.astype(str) + "-" + idx.month.astype(str)
    s = pd.Series(key, index=idx)
    out = s.ne(s.shift(1))
    out.iloc[0] = True
    return out.values


def atr14(high, low, close):
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / 14.0, adjust=False, min_periods=14).mean()


# ----------------------------------------------------------------------------
# family A: time-series momentum
# ----------------------------------------------------------------------------
def run_tsmom(panel, tf, lookback, vol_target, freq):
    idx = panel["close"].index
    sigma = rolling_sigma(panel["close"], tf)
    mask = rebal_mask(idx, freq)
    gross = pd.DataFrame(0.0, index=idx, columns=SYMBOLS)
    turn = pd.DataFrame(0.0, index=idx, columns=SYMBOLS)
    trades = pd.DataFrame(0.0, index=idx, columns=SYMBOLS)

    for sym in SYMBOLS:
        c = panel["close"][sym]
        s = sigma[sym]
        mom = c / c.shift(lookback) - 1.0
        w_sig = pd.Series(np.nan, index=idx)
        valid = mask & mom.notna().values & s.notna().values & (s > 1e-8).values
        w_sig[valid] = (np.sign(mom.values[valid])
                        * np.minimum(vol_target / s.values[valid], MAX_LEV))
        w_sig = w_sig.ffill().fillna(0.0)
        w_eff = w_sig.shift(1).fillna(0.0)

        r = panel["open"][sym].shift(-1) / panel["open"][sym] - 1.0
        gross[sym] = w_eff * r
        turn[sym] = (w_eff - w_eff.shift(1)).abs().fillna(0.0)

        pos = np.sign(w_sig)
        pos_prev = pos.shift(1).fillna(0.0)
        changed = (pos != pos_prev) & ((pos != 0) | (pos_prev != 0))
        trades[sym] = changed.astype(float)

    n = len(SYMBOLS)
    return gross.sum(axis=1) / n, turn.sum(axis=1) / n, trades.sum(axis=1)


# ----------------------------------------------------------------------------
# family B: EMA trend + ATR stop
# ----------------------------------------------------------------------------
def run_ema_trend(panel, tf, rule, stop_k, vol_target, freq):
    idx = panel["close"].index
    sigma = rolling_sigma(panel["close"], tf)
    mask = rebal_mask(idx, freq)
    gross = pd.DataFrame(0.0, index=idx, columns=SYMBOLS)
    turn = pd.DataFrame(0.0, index=idx, columns=SYMBOLS)
    trades = pd.DataFrame(0.0, index=idx, columns=SYMBOLS)

    for sym in SYMBOLS:
        c = panel["close"][sym]
        ema50 = c.ewm(span=50, adjust=False).mean()
        ema200 = c.ewm(span=200, adjust=False).mean()
        if rule == "cross":
            sig_series = np.sign(ema50 - ema200)
            sig_series[ema50.isna() | ema200.isna()] = np.nan
        else:
            sig_series = np.sign(c - ema200)
            sig_series[ema200.isna()] = np.nan
        atr = atr14(panel["high"][sym], panel["low"][sym], c)

        o = panel["open"][sym].values
        h = panel["high"][sym].values
        lo = panel["low"][sym].values
        sg = sigma[sym].values
        at = atr.values
        si = sig_series.values
        n = len(o)

        g = np.zeros(n)
        tu = np.zeros(n)
        tr = np.zeros(n)
        pos = 0
        w = 0.0
        stop = np.nan

        for t in range(n):
            # execute the signal formed at the previous close
            if t > 0 and mask[t - 1] and np.isfinite(o[t]):
                s_prev = si[t - 1]
                sg_prev = sg[t - 1]
                at_prev = at[t - 1]
                tradable = (np.isfinite(s_prev) and s_prev != 0
                            and np.isfinite(sg_prev) and sg_prev > 1e-8
                            and np.isfinite(at_prev))
                if tradable:
                    tw = np.sign(s_prev) * min(vol_target / sg_prev, MAX_LEV)
                    if pos != 0 and int(np.sign(s_prev)) == pos:
                        tu[t] += abs(tw - w)
                        w = tw
                    else:
                        if pos != 0:
                            tu[t] += abs(w)
                            tr[t] += 1
                        pos = int(np.sign(s_prev))
                        w = tw
                        stop = o[t] - pos * stop_k * at_prev
                        tu[t] += abs(w)
                        tr[t] += 1
                elif pos != 0:
                    tu[t] += abs(w)
                    tr[t] += 1
                    pos, w, stop = 0, 0.0, np.nan

            if pos != 0 and np.isfinite(o[t]):
                exit_px = np.nan
                if pos == 1:
                    if np.isfinite(stop) and o[t] <= stop:
                        exit_px = o[t]
                    elif np.isfinite(stop) and lo[t] <= stop:
                        exit_px = stop
                else:
                    if np.isfinite(stop) and o[t] >= stop:
                        exit_px = o[t]
                    elif np.isfinite(stop) and h[t] >= stop:
                        exit_px = stop
                if np.isfinite(exit_px):
                    g[t] = w * pos * (exit_px / o[t] - 1.0)
                    tu[t] += abs(w)
                    tr[t] += 1
                    pos, w, stop = 0, 0.0, np.nan
                elif t + 1 < n and np.isfinite(o[t + 1]):
                    g[t] = w * pos * (o[t + 1] / o[t] - 1.0)

        gross[sym] = g
        turn[sym] = tu
        trades[sym] = tr

    n = len(SYMBOLS)
    return gross.sum(axis=1) / n, turn.sum(axis=1) / n, trades.sum(axis=1)


# ----------------------------------------------------------------------------
# family C: cross-sectional momentum
# ----------------------------------------------------------------------------
def run_xsmom(panel, tf, lookback, weighting, freq, buffer):
    idx = panel["close"].index
    close = panel["close"]
    open_ = panel["open"]
    sigma = rolling_sigma(close, tf)
    mask = rebal_mask(idx, freq)

    target = pd.DataFrame(np.nan, index=idx, columns=SYMBOLS)
    prev_w = pd.Series(0.0, index=SYMBOLS)

    for t in np.where(mask)[0]:
        if t < lookback:
            target.iloc[t] = 0.0
            prev_w[:] = 0.0
            continue
        scores = close.iloc[t] / close.iloc[t - lookback] - 1.0
        sg = sigma.iloc[t]
        valid = scores.notna() & sg.notna() & (sg > 1e-8) & close.iloc[t].notna()
        names = valid[valid].index
        n = len(names)
        if n < 6:
            target.iloc[t] = 0.0
            prev_w[:] = 0.0
            continue

        rank = scores[names].rank(pct=True, method="first")
        n_side = max(1, n // 3)
        long_set = set(rank.nlargest(n_side).index)
        short_set = set(rank.nsmallest(n_side).index)
        if buffer:
            for sym in SYMBOLS:
                if prev_w[sym] > 0 and sym in rank.index and rank[sym] <= 0.5:
                    long_set.add(sym)
                if prev_w[sym] < 0 and sym in rank.index and rank[sym] >= 0.5:
                    short_set.add(sym)
        for sym in list(long_set & short_set):
            short_set.discard(sym)

        row = pd.Series(0.0, index=SYMBOLS)
        if weighting == "equal":
            if long_set:
                row[list(long_set)] = 0.5 / len(long_set)
            if short_set:
                row[list(short_set)] = -0.5 / len(short_set)
        else:
            if long_set:
                inv = 1.0 / sg[list(long_set)]
                inv = inv.replace([np.inf, -np.inf], np.nan).dropna()
                if len(inv) and inv.sum() > 0:
                    row[inv.index] = 0.5 * inv / inv.sum()
            if short_set:
                inv = 1.0 / sg[list(short_set)]
                inv = inv.replace([np.inf, -np.inf], np.nan).dropna()
                if len(inv) and inv.sum() > 0:
                    row[inv.index] = -0.5 * inv / inv.sum()
        target.iloc[t] = row
        prev_w = row

    w_sig = target.ffill().fillna(0.0)
    w_eff = w_sig.shift(1).fillna(0.0)
    r = open_.shift(-1) / open_ - 1.0
    gross = (w_eff * r).sum(axis=1)
    dw = (w_eff - w_eff.shift(1)).abs()
    turn = dw.sum(axis=1)
    name_trades = (dw > 1e-9).sum(axis=1)

    exec_mask = pd.Series(mask, index=idx).shift(1).fillna(False).values
    rebalances = ((turn > 1e-9) & exec_mask).astype(float)
    return gross, turn, name_trades, rebalances


# ----------------------------------------------------------------------------
# config grids
# ----------------------------------------------------------------------------
def build_configs(panel, tf):
    out = {}
    # A
    g, t, tr = {}, {}, {}
    for L, vt, f in itertools.product(A_LOOKBACKS, VOL_TARGETS, REBAL):
        key = f"L{L}_vt{int(vt*100)}_r{f}"
        gg, tt, rr = run_tsmom(panel, tf, L, vt, f)
        g[key], t[key], tr[key] = gg, tt, rr
    out["A"] = (pd.DataFrame(g), pd.DataFrame(t), pd.DataFrame(tr), None)

    # B
    g, t, tr = {}, {}, {}
    for rule, sk, vt, f in itertools.product(B_RULES, B_STOPS, VOL_TARGETS, REBAL):
        key = f"{rule}_k{int(sk)}_vt{int(vt*100)}_r{f}"
        gg, tt, rr = run_ema_trend(panel, tf, rule, sk, vt, f)
        g[key], t[key], tr[key] = gg, tt, rr
    out["B"] = (pd.DataFrame(g), pd.DataFrame(t), pd.DataFrame(tr), None)

    # C
    g, t, tr, rb = {}, {}, {}, {}
    for L, wt, f, buf in itertools.product(C_LOOKBACKS, C_WEIGHTS, REBAL, C_BUFFERS):
        key = f"L{L}_{wt}_r{f}_buf{int(buf)}"
        gg, tt, nt, rr = run_xsmom(panel, tf, L, wt, f, buf)
        g[key], t[key], tr[key], rb[key] = gg, tt, nt, rr
    # activity for C = portfolio rebalance events (the pass-criterion unit)
    out["C"] = (pd.DataFrame(g), pd.DataFrame(t), pd.DataFrame(rb), pd.DataFrame(tr))
    return out


# ----------------------------------------------------------------------------
# walk-forward
# ----------------------------------------------------------------------------
def quarter_starts(idx):
    starts = []
    ts = OOS_START
    last = idx[-1]
    while ts <= last:
        starts.append(ts)
        ts = ts + pd.DateOffset(months=TEST_MONTHS)
    folds = []
    for ts in starts:
        te = min(ts + pd.DateOffset(months=TEST_MONTHS), last + pd.Timedelta(seconds=1))
        tr_s = ts - pd.DateOffset(months=TRAIN_MONTHS)
        if tr_s < idx[0]:
            continue
        folds.append((tr_s, ts, ts, te))
    return folds


def select_walk_forward(idx, gross, turn, activity, folds, tf, rate, min_activity):
    bpy = BARS_PER_YEAR[tf]
    test_r, test_g, test_act = [], [], []
    selected = []
    fold_rows = []
    for tr_s, tr_e, te_s, te_e in folds:
        trm = (idx >= tr_s) & (idx < tr_e)
        tem = (idx >= te_s) & (idx < te_e)
        net = gross - turn * rate
        act = activity.loc[trm].sum()
        best, best_score = None, -np.inf
        for col in net.columns:
            if act.get(col, 0.0) < min_activity:
                continue
            r = net.loc[trm, col].dropna()
            if len(r) < 0.5 * trm.sum():
                continue
            sd = r.std()
            if not np.isfinite(sd) or sd <= 0:
                continue
            score = r.mean() / sd * math.sqrt(bpy)
            if score > best_score:
                best, best_score = col, score
        used_fallback = False
        if best is None:
            used_fallback = True
            # fall back to the most active config
            act_sorted = act.sort_values(ascending=False)
            best = act_sorted.index[0] if len(act_sorted) else net.columns[0]
            best_score = np.nan
        r_te = net.loc[tem, best].fillna(0.0)
        test_r.append(r_te)
        test_g.append(gross.loc[tem, best].fillna(0.0))
        test_act.append(activity.loc[tem, best].fillna(0.0))
        selected.append(best)
        fold_rows.append({
            "train_start": tr_s, "test_start": te_s, "test_end": te_e,
            "config": best, "train_score": best_score,
            "train_activity": float(act.get(best, np.nan)),
            "fallback": used_fallback,
            "test_net": float((1.0 + r_te).prod() - 1.0),
            "test_activity": float(activity.loc[tem, best].sum()),
        })
    return (pd.concat(test_r), pd.concat(test_g), pd.concat(test_act),
            selected, fold_rows)


def aggregate_metrics(r, gross_r, activity, tf, rate):
    bpy = BARS_PER_YEAR[tf]
    r = r.fillna(0.0)
    eq = (1.0 + r).cumprod()
    total = float(eq.iloc[-1] - 1.0) if len(eq) else np.nan
    n = len(r)
    ann_ret = float(eq.iloc[-1] ** (bpy / n) - 1.0) if len(eq) and eq.iloc[-1] > 0 else -1.0
    vol = float(r.std() * math.sqrt(bpy)) if n > 1 else np.nan
    sharpe = float(r.mean() / r.std() * math.sqrt(bpy)) if n > 1 and r.std() > 0 else np.nan
    mdd = float((eq / eq.cummax() - 1.0).min()) if len(eq) else np.nan
    var = r.var()
    t_naive = float(r.mean() / math.sqrt(var / n)) if n > 1 and var > 0 else np.nan
    t_nw = newey_west_t(r.values, NW_LAG[tf])
    gross_total = float((1.0 + gross_r.fillna(0.0)).prod() - 1.0)
    return {
        "n_bars": n, "net_total": total, "gross_total": gross_total,
        "cost_drag": gross_total - total, "ann_return": ann_ret,
        "ann_vol": vol, "sharpe": sharpe, "t_naive": t_naive, "t_nw": t_nw,
        "mdd": mdd, "activity": float(activity.sum()),
    }


def newey_west_t(x, lag):
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 3:
        return np.nan
    mu = x.mean()
    e = x - mu
    s = e @ e / n
    for k in range(1, min(lag, n - 1) + 1):
        w = 1.0 - k / (lag + 1.0)
        s += 2.0 * w * (e[k:] @ e[:-k]) / n
    if s <= 0:
        return np.nan
    return float(mu / math.sqrt(s / n))


def fold_positivity(fold_rows, n_folds):
    pos = sum(1 for f in fold_rows if f["test_net"] > 0)
    need = math.ceil(0.8 * n_folds)
    return pos, pos / n_folds if n_folds else np.nan, pos >= need


def extra_metrics(r, g, act, fold_rows, tf, rate):
    """Concentration diagnostics: post-2021 performance and fold dependence."""
    out = {}
    mask = r.index.year >= 2022
    if mask.sum() > 0:
        m = aggregate_metrics(r[mask], g[mask], act[mask], tf, rate)
        for k in ["net_total", "ann_return", "ann_vol", "sharpe", "mdd"]:
            out[k + "_2022on"] = m[k]
    nets = pd.Series([f["test_net"] for f in fold_rows], dtype=float)
    out["best_fold_net"] = float(nets.max()) if len(nets) else np.nan
    pos_sum = float(nets[nets > 0].sum())
    out["top_fold_share"] = float(nets.max() / pos_sum) if pos_sum > 0 else np.nan
    out["pos_last5"] = int((nets.tail(5) > 0).sum())
    return out


# ----------------------------------------------------------------------------
# year / regime tables
# ----------------------------------------------------------------------------
def yearly_stats(r, tf, activity=None):
    bpy = BARS_PER_YEAR[tf]
    rows = []
    for year, grp in r.groupby(r.index.year):
        if len(grp) == 0:
            continue
        eq = (1.0 + grp).cumprod()
        vol = grp.std() * math.sqrt(bpy)
        rows.append({
            "year": int(year), "net_return": float(eq.iloc[-1] - 1.0),
            "ann_vol": float(vol),
            "sharpe": float(grp.mean() / grp.std() * math.sqrt(bpy)) if grp.std() > 0 else np.nan,
            "mdd": float((eq / eq.cummax() - 1.0).min()),
            "bars": len(grp),
        })
    return pd.DataFrame(rows)


def regime_series(tf, idx):
    """BTC 200d direction and 30d realised-vol tercile, known at bar open."""
    btc = pd.read_csv(os.path.join(DATA_DIR, "BTC_1d.csv"))
    btc["open_time"] = pd.to_datetime(btc["open_time"], utc=True)
    btc["close_time"] = pd.to_datetime(btc["close_time"], utc=True)
    btc = btc[btc["close_time"] <= NOW].set_index("open_time")
    c = btc["close"].astype(float)
    sma200 = c.rolling(200, min_periods=100).mean()
    rv = c.pct_change().rolling(30, min_periods=20).std() * math.sqrt(365.0)
    trend = (c > sma200).astype(float)
    trend[c.isna() | sma200.isna()] = np.nan
    # shift one day: use information available before the return period
    trend_lag = trend.shift(1)
    rv_lag = rv.shift(1)
    q33 = rv_lag.quantile(0.33)
    q67 = rv_lag.quantile(0.67)
    vol_bucket = pd.Series(np.nan, index=rv_lag.index)
    vol_bucket[rv_lag <= q33] = 0.0
    vol_bucket[(rv_lag > q33) & (rv_lag <= q67)] = 1.0
    vol_bucket[rv_lag > q67] = 2.0
    trend_map = trend_lag.reindex(idx, method="ffill")
    vol_map = vol_bucket.reindex(idx, method="ffill")
    return trend_map, vol_map, q33, q67


def regime_stats(r, tf, trend_map, vol_map):
    bpy = BARS_PER_YEAR[tf]
    out = []
    for label, mask in [
        ("BTC_up_200d", trend_map > 0.5),
        ("BTC_down_200d", trend_map < 0.5),
        ("vol_low", vol_map == 0),
        ("vol_mid", vol_map == 1),
        ("vol_high", vol_map == 2),
    ]:
        grp = r[mask.reindex(r.index).fillna(False).values]
        if len(grp) == 0:
            out.append({"regime": label, "bars": 0, "ann_return": np.nan,
                        "ann_vol": np.nan, "sharpe": np.nan, "mdd": np.nan})
            continue
        eq = (1.0 + grp).cumprod()
        vol = grp.std() * math.sqrt(bpy)
        out.append({
            "regime": label, "bars": len(grp),
            "ann_return": float(grp.mean() * bpy),
            "ann_vol": float(vol),
            "sharpe": float(grp.mean() / grp.std() * math.sqrt(bpy)) if grp.std() > 0 else np.nan,
            "mdd": float((eq / eq.cummax() - 1.0).min()),
        })
    return pd.DataFrame(out)


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    all_results = {}
    store = {}   # (family, tf, cost) -> dict with returns, folds, etc.
    all_configs = {}
    panels = {}
    fold_store = []
    yearly_store = []
    regime_store = []
    for tf in TFS:
        print(f"\n=== loading {tf} ===")
        panel = load_panel(tf)
        panels[tf] = panel
        idx = panel["close"].index
        print(f"bars={len(idx)}  {idx[0]} -> {idx[-1]}  symbols={len(SYMBOLS)}")
        configs = build_configs(panel, tf)
        all_configs[tf] = configs
        folds = quarter_starts(idx)
        print(f"walk-forward folds: {len(folds)}  "
              f"{folds[0][2].date()} .. {folds[-1][3].date()}")
        trend_map, vol_map, q33, q67 = regime_series(tf, idx)
        print(f"BTC rv30 terciles: {q33:.3f} / {q67:.3f}")

        for fam in ["A", "B", "C"]:
            gross, turn, activity, rebalance = configs[fam]
            min_activity = 30 if fam in ("A", "B") else 8
            for cost_name, rate in COSTS.items():
                r, g, act, selected, fold_rows = select_walk_forward(
                    idx, gross, turn, activity, folds, tf, rate, min_activity)
                met = aggregate_metrics(r, g, act, tf, rate)
                n_pos, pct_pos, folds_ok = fold_positivity(fold_rows, len(folds))
                trades_ok = met["activity"] >= (30 if fam in ("A", "B") else 20)
                net_ok = met["net_total"] > 0
                mdd_ok = met["mdd"] > -0.25
                passed = bool(trades_ok and folds_ok and net_ok and mdd_ok)
                sel_counts = pd.Series(selected).value_counts()
                sel_str = ";".join(f"{k}:{v}" for k, v in sel_counts.items())
                row = {
                    "mode": "walk_forward", "family": fam, "tf": tf,
                    "cost": cost_name, "n_folds": len(folds),
                    **met,
                    **extra_metrics(r, g, act, fold_rows, tf, rate),
                    "pos_folds": n_pos, "pct_pos_folds": pct_pos,
                    "trades_ok": trades_ok, "folds_ok": folds_ok,
                    "net_ok": net_ok, "mdd_ok": mdd_ok, "passed": passed,
                    "selected_configs": sel_str,
                }
                all_results[(fam, tf, cost_name)] = row
                for fr in fold_rows:
                    fold_store.append({"family": fam, "tf": tf, "cost": cost_name,
                                       **fr})
                yr = yearly_stats(r, tf)
                rg = regime_stats(r, tf, trend_map, vol_map)
                for _, yrow in yr.iterrows():
                    yearly_store.append({"family": fam, "tf": tf, "cost": cost_name,
                                         **yrow.to_dict()})
                for _, rrow in rg.iterrows():
                    regime_store.append({"family": fam, "tf": tf, "cost": cost_name,
                                         **rrow.to_dict()})
                store[(fam, tf, cost_name)] = {
                    "r": r, "gross": g, "activity": act,
                    "folds": fold_rows, "selected": selected,
                    "yearly": yr,
                    "regime": rg,
                    "configs": list(gross.columns),
                }
                print(f"{fam} {tf} {cost_name:5s} net={met['net_total']*100:7.1f}% "
                      f"vol={met['ann_vol']*100:5.1f}% sh={met['sharpe']:5.2f} "
                      f"tNW={met['t_nw']:5.2f} mdd={met['mdd']*100:6.1f}% "
                      f"pos={n_pos}/{len(folds)} act={met['activity']:.0f} "
                      f"pass={passed}")

        # D: equal-risk A+B+C combination on 1d
        if tf == "1d":
            for cost_name, rate in COSTS.items():
                parts = []
                gross_parts = []
                acts = []
                fold_rows_d = []
                for f_i, (tr_s, tr_e, te_s, te_e) in enumerate(folds):
                    trm = (idx >= tr_s) & (idx < tr_e)
                    tem = (idx >= te_s) & (idx < te_e)
                    sleeves = []
                    for fam in ["A", "B", "C"]:
                        sel = store[(fam, tf, cost_name)]["selected"][f_i]
                        # recompute train/test net slice for the selected config
                        gross, turn, activity, _ = configs[fam]
                        tr_net = gross.loc[trm, sel] - turn.loc[trm, sel] * rate
                        te_net = gross.loc[tem, sel] - turn.loc[tem, sel] * rate
                        sleeves.append((tr_net, te_net,
                                        gross.loc[trm, sel], gross.loc[tem, sel],
                                        activity.loc[tem, sel]))
                    vols = []
                    for tr_net, _, _, _, _ in sleeves:
                        sd = tr_net.std()
                        vols.append(sd if np.isfinite(sd) and sd > 1e-12 else np.nan)
                    inv = np.array([1.0 / v if np.isfinite(v) else 0.0 for v in vols])
                    if inv.sum() <= 0:
                        inv = np.ones(len(sleeves))
                    wts = inv / inv.sum()
                    combo_tr = sum(w * s[0] for w, s in zip(wts, sleeves))
                    combo_te = sum(w * s[1] for w, s in zip(wts, sleeves))
                    combo_gross = sum(w * s[3] for w, s in zip(wts, sleeves))
                    vol_tr = combo_tr.std() * math.sqrt(BARS_PER_YEAR[tf])
                    scale = min(0.20 / vol_tr, 2.0) if vol_tr > 1e-12 else 1.0
                    parts.append(combo_te * scale)
                    gross_parts.append(combo_gross * scale)
                    acts.append(sum(s[4].sum() for s in sleeves))
                    fold_rows_d.append({
                        "train_start": tr_s, "test_start": te_s, "test_end": te_e,
                        "config": "D20", "train_score": np.nan,
                        "train_activity": np.nan, "fallback": False,
                        "test_net": float((1.0 + combo_te * scale).prod() - 1.0),
                        "test_activity": acts[-1],
                    })
                r_d = pd.concat(parts)
                g_d = pd.concat(gross_parts)
                act_d = pd.Series(0.0, index=r_d.index)
                met = aggregate_metrics(r_d, g_d, act_d, tf, rate)
                met["activity"] = float(sum(acts))
                n_pos, pct_pos, folds_ok = fold_positivity(fold_rows_d, len(folds))
                trades_ok = met["activity"] >= 30
                net_ok = met["net_total"] > 0
                mdd_ok = met["mdd"] > -0.25
                passed = bool(trades_ok and folds_ok and net_ok and mdd_ok)
                row = {
                    "mode": "walk_forward", "family": "D", "tf": tf,
                    "cost": cost_name, "n_folds": len(folds), **met,
                    **extra_metrics(r_d, g_d, act_d, fold_rows_d, tf, rate),
                    "pos_folds": n_pos, "pct_pos_folds": pct_pos,
                    "trades_ok": trades_ok, "folds_ok": folds_ok,
                    "net_ok": net_ok, "mdd_ok": mdd_ok, "passed": passed,
                    "selected_configs": "A+B+C equal-risk, 20% vol target",
                }
                all_results[("D", tf, cost_name)] = row
                for fr in fold_rows_d:
                    fold_store.append({"family": "D", "tf": tf, "cost": cost_name,
                                       **fr})
                yr = yearly_stats(r_d, tf)
                rg = regime_stats(r_d, tf, trend_map, vol_map)
                for _, yrow in yr.iterrows():
                    yearly_store.append({"family": "D", "tf": tf, "cost": cost_name,
                                         **yrow.to_dict()})
                for _, rrow in rg.iterrows():
                    regime_store.append({"family": "D", "tf": tf, "cost": cost_name,
                                         **rrow.to_dict()})
                store[("D", tf, cost_name)] = {
                    "r": r_d, "gross": g_d, "activity": act_d,
                    "folds": fold_rows_d, "selected": ["D20"] * len(folds),
                    "yearly": yr,
                    "regime": rg,
                    "configs": ["D20"],
                }
                print(f"D {tf} {cost_name:5s} net={met['net_total']*100:7.1f}% "
                      f"vol={met['ann_vol']*100:5.1f}% sh={met['sharpe']:5.2f} "
                      f"tNW={met['t_nw']:5.2f} mdd={met['mdd']*100:6.1f}% "
                      f"pos={n_pos}/{len(folds)} act={met['activity']:.0f} pass={passed}")

    # ------------------------------------------------------------------
    # results.csv
    # ------------------------------------------------------------------
    res = pd.DataFrame(list(all_results.values()))
    n_primary = len(res)
    z_bonf = 2.69  # one-sided 0.05 / 14
    res["bonferroni_z"] = z_bonf
    res["significant_bonf"] = res["t_nw"] > z_bonf
    res["strict_pass"] = res["passed"] & res["significant_bonf"]
    # sensitivity: litteral "4 of the last 5 folds" reading of the criterion
    res["folds_ok_last5"] = res["pos_last5"] >= 4
    res["passed_last5_base"] = (res["trades_ok"] & res["folds_ok_last5"]
                                & res["net_ok"] & res["mdd_ok"])
    res["passed_last5_sig"] = res["passed_last5_base"] & res["significant_bonf"]
    col_order = [
        "mode", "family", "tf", "cost", "n_folds", "n_bars", "activity",
        "net_total", "gross_total", "cost_drag", "ann_return", "ann_vol",
        "sharpe", "t_naive", "t_nw", "mdd",
        "net_total_2022on", "ann_return_2022on", "sharpe_2022on", "mdd_2022on",
        "best_fold_net", "top_fold_share", "pos_last5",
        "pos_folds", "pct_pos_folds",
        "trades_ok", "folds_ok", "net_ok", "mdd_ok", "passed",
        "bonferroni_z", "significant_bonf", "strict_pass",
        "folds_ok_last5", "passed_last5_base", "passed_last5_sig",
        "selected_configs",
    ]
    res = res[col_order].sort_values(["tf", "family", "cost"]).reset_index(drop=True)
    res.to_csv(OUT_CSV, index=False)
    print(f"\nsaved {OUT_CSV}  ({len(res)} primary tests)")
    folds_df = pd.DataFrame(fold_store)
    folds_df.to_csv(os.path.join(HERE, "folds.csv"), index=False)
    print(f"saved {os.path.join(HERE, 'folds.csv')}  ({len(folds_df)} rows)")
    pd.DataFrame(yearly_store).to_csv(os.path.join(HERE, "yearly.csv"), index=False)
    pd.DataFrame(regime_store).to_csv(os.path.join(HERE, "regime.csv"), index=False)
    print(f"saved yearly.csv / regime.csv")

    # ------------------------------------------------------------------
    # console detail: 1d taker tables
    # ------------------------------------------------------------------
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 50)
    show_cols = ["family", "tf", "cost", "n_bars", "activity", "net_total",
                 "ann_return", "ann_vol", "sharpe", "t_nw", "mdd",
                 "pos_folds", "n_folds", "passed", "significant_bonf"]
    print("\n=== primary tests ===")
    print(res[show_cols].to_string(index=False,
          formatters={c: (lambda x: f"{x*100:.1f}%") for c in
                      ["net_total", "ann_return", "ann_vol", "mdd"]}))

    for key in [("A", "1d", "taker"), ("B", "1d", "taker"),
                ("C", "1d", "taker"), ("D", "1d", "taker"),
                ("A", "4h", "taker"), ("B", "4h", "taker"),
                ("C", "4h", "taker")]:
        if key not in store:
            continue
        st = store[key]
        print(f"\n--- {key[0]} {key[1]} {key[2]} yearly ---")
        print(st["yearly"].to_string(index=False,
              formatters={"net_return": "{:.1%}".format,
                          "ann_vol": "{:.1%}".format,
                          "sharpe": "{:.2f}".format,
                          "mdd": "{:.1%}".format}))
        print(f"--- {key[0]} {key[1]} {key[2]} regime ---")
        print(st["regime"].to_string(index=False,
              formatters={"ann_return": "{:.1%}".format,
                          "ann_vol": "{:.1%}".format,
                          "sharpe": "{:.2f}".format,
                          "mdd": "{:.1%}".format}))
        if key[0] in ("A", "B", "C"):
            print("selected:", pd.Series(st["selected"]).value_counts().to_dict())

    # ------------------------------------------------------------------
    # canonical fixed configs (pre-specified, full OOS, both costs)
    # ------------------------------------------------------------------
    print("\n=== canonical fixed configs, 2021-01 -> end ===")
    canon = {
        ("A", "L50_vt20_rW"),
        ("B", "price200_k3_vt20_rW"),
        ("C", "L50_invvol_rW_buf1"),
    }
    canon_rows = []
    for tf in TFS:
        idx = panels[tf]["close"].index
        configs = all_configs[tf]
        oos = idx >= OOS_START
        for fam in ["A", "B", "C"]:
            gross, turn, activity, _ = configs[fam]
            for key in [k for f, k in canon if f == fam]:
                if key not in gross.columns:
                    continue
                for cost_name, rate in COSTS.items():
                    r = (gross.loc[oos, key] - turn.loc[oos, key] * rate).fillna(0.0)
                    met = aggregate_metrics(r, gross.loc[oos, key],
                                            activity.loc[oos, key], tf, rate)
                    yr = yearly_stats(r, tf)
                    canon_rows.append({"family": fam, "tf": tf, "cost": cost_name,
                                       "config": key, **met,
                                       "yearly": "; ".join(
                                           f"{int(x)}:{y*100:.1f}%"
                                           for x, y in zip(yr.year, yr.net_return))})
                    print(f"{fam} {tf} {cost_name:5s} {key:24s} "
                          f"net={met['net_total']*100:7.1f}% vol={met['ann_vol']*100:5.1f}% "
                          f"sh={met['sharpe']:5.2f} tNW={met['t_nw']:5.2f} "
                          f"mdd={met['mdd']*100:6.1f}% years=[{canon_rows[-1]['yearly']}]")
    pd.DataFrame(canon_rows).to_csv(os.path.join(HERE, "canonical.csv"), index=False)

    return res, store


if __name__ == "__main__":
    main()
