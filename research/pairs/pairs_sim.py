#!/usr/bin/env python
"""Pairs / statistical-arbitrage (mean-reversion) backtest on Binance USDT perps.

Pre-registered primary specification (written before looking at holdout results)
--------------------------------------------------------------------------------
- Universe: 8 USDT perps (BTC ETH SOL XRP DOGE BNB ADA LINK). KORU is excluded
  because its 2026-07-15 contract conversion (21.212963x) is not handled.
- Timeframe: 1h. 180 days = 4320 bars; calibration = first 120 days (2880 bars),
  holdout = last 60 days (1440 bars). 15m is a secondary robustness timeframe,
  not used for the primary pass/fail.
- Pair construction (calibration only):
    * static Engle-Granger OLS  logA = alpha + beta*logB  over the 120d train;
    * ADF (constant, lags by AIC) on the static residual, 5% EG critical value
      -3.34 (MacKinnon, 2 variables, constant);
    * half-life from AR(1) of the static residual, in hours;
    * rolling-OLS spread half-life, in hours;
    * return correlation over train.
  A pair passes if: ADF t < -3.34, 1h < HL_static < 720h (= train/4),
  HL_rolling < 720h, 0.1 < beta < 10, train corr > 0.20, and at least 3
  |z|>=2 episodes in train.
  In this sample 0/28 pairs pass at 5% (best BNB/ADA, t=-3.06, 10% level).
  The pre-registered fallback, used only because the strict tier is empty,
  trades the top 4 eligible pairs ranked by ADF t ("best available"); this
  is NOT a claim of cointegration. A second, de-duplicated portfolio takes
  the best eligible pairs with no shared symbol.
- Spread / z (trading): rolling OLS with a 168h window (1h TF).  The beta
  and intercept estimated through t-1 define the z used at close t; at
  entry the then-current beta, spread mean and spread std are frozen for
  the life of the trade, so "z returns to 0" means the traded spread
  returns to its entry-time mean (the old rolling-beta z could cross zero
  merely because the rolling mean moved, while the position lost money).
  No future data are used: signal at close t, execution at open t+1.
- Rules: enter at |z|>=2 (short spread if z>+2, long if z<-2), exit on z
  crossing 0, stop if |z|>=3.5, time stop = clip(3*HL_static, 7d, 30d).
  After any exit, a new entry is armed only once |z|<2 again.
- Costs per leg per side: taker 5bp fee + 2bp slippage; maker 2bp + 1bp.
  Both legs pay entry and exit. Funding is charged on both legs at each 8h
  event inside (entry, exit], using research/data/funding (missing before
  2026-05-03 treated as 0; coverage reported).
- Position: W=1 USDT on leg A, beta*W on leg B (delta-neutral at entry).
  Gross capital = (1+beta)W. Trade PnL is reported in bp of W and in bp of
  gross capital.
- Pass criteria (holdout, taker primary): >=30 trades, mean net > 0,
  total net > 0. Statistical significance and multiple-testing corrections
  are reported but do not replace the pre-registered criteria.
- 3-fold rolling: 120d train / 20d test, step 20d, pairs re-selected in each
  fold (test days 120-180 covered by three non-overlapping folds).

Question 7 (is the gross spread big enough?) is answered from the per-trade
diagnostics: entry gap = |z_entry| * sigma_entry (full-reversion gross in bp
of W), cost, funding, empirical capture, and the breakeven z
z_min = (cost + funding) / (capture * sigma).
"""
from __future__ import annotations

import argparse
import glob
import math
import os
from dataclasses import dataclass, asdict, field
from itertools import combinations

import numpy as np
import pandas as pd
from scipy import stats

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_KLINES = os.path.join(ROOT, "research", "data", "klines")
DATA_FUNDING = os.path.join(ROOT, "research", "data", "funding")
OUT_DIR = os.path.join(ROOT, "research", "pairs")

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT",
           "DOGEUSDT", "BNBUSDT", "ADAUSDT", "LINKUSDT"]
EXCLUDED = {"KORUUSDT": "2026-07-15 contract conversion 21.212963x"}

TF_CFG = {
    "1h": dict(hours_per_bar=1.0, bars_per_day=24, beta_win=168, z_win=336,
               train_bars=2880, test_bars=1440, maxlag=24),
    "15m": dict(hours_per_bar=0.25, bars_per_day=96, beta_win=672, z_win=1344,
                train_bars=11520, test_bars=5760, maxlag=40),
}

# Engle-Granger (2 variables, constant) asymptotic critical values, MacKinnon.
EG_CRIT = {"1%": -3.90, "5%": -3.34, "10%": -3.04}

FEE_MODES = {
    "taker": dict(fee=5e-4, slip=2e-4),
    "maker": dict(fee=2e-4, slip=1e-4),
}

ENTRY_Z = 2.0
EXIT_Z = 0.0
STOP_Z = 3.5
TIME_STOP_MIN_H = 168.0     # 7 days
TIME_STOP_MAX_H = 720.0     # 30 days
TIME_STOP_MULT = 3.0
MIN_TRAIN_EPISODES = 3
MAX_PORTFOLIO_PAIRS = 6


# --------------------------------------------------------------------------- #
# statistics helpers (no statsmodels available)
# --------------------------------------------------------------------------- #
def _ols(y: np.ndarray, X: np.ndarray):
    """Return (beta, se, resid, ssr, dof). X must include a constant column."""
    XtX = X.T @ X
    try:
        inv = np.linalg.inv(XtX)
    except np.linalg.LinAlgError:
        inv = np.linalg.pinv(XtX)
    beta = inv @ (X.T @ y)
    resid = y - X @ beta
    dof = len(y) - X.shape[1]
    ssr = float(resid @ resid)
    if dof <= 0:
        return beta, np.full_like(beta, np.nan), resid, ssr, dof
    sigma2 = ssr / dof
    se = np.sqrt(np.maximum(np.diag(inv) * sigma2, 0.0))
    return beta, se, resid, ssr, dof


def ols_alpha_beta(y: np.ndarray, x: np.ndarray):
    X = np.column_stack([np.ones(len(x)), x])
    beta, _, _, _, _ = _ols(y, X)
    return float(beta[0]), float(beta[1])


def adf_tstat(y: np.ndarray, maxlag: int):
    """ADF with constant; lag chosen by AIC. Returns (t_stat, lag)."""
    y = np.asarray(y, dtype=float)
    y = y[np.isfinite(y)]
    dy = np.diff(y)
    n = len(dy)
    if n < 50:
        return np.nan, 0
    maxlag = int(min(maxlag, max(0, n // 10)))
    best = None
    for p in range(0, maxlag + 1):
        start = p
        T = n - start
        if T < 30:
            continue
        cols = [np.ones(T), y[start:n]]
        for i in range(1, p + 1):
            cols.append(dy[start - i:n - i])
        X = np.column_stack(cols)
        yy = dy[start:n]
        beta, se, resid, ssr, dof = _ols(yy, X)
        if not np.isfinite(ssr) or ssr <= 0:
            continue
        aic = T * math.log(ssr / T) + 2 * X.shape[1]
        t = beta[1] / se[1] if se[1] > 0 else np.nan
        if best is None or aic < best[0]:
            best = (aic, t, p)
    if best is None:
        return np.nan, 0
    return float(best[1]), int(best[2])


def half_life_bars(s: pd.Series) -> float:
    """AR(1) half-life in bars: dy = a + lam*y_{t-1}. inf if no reversion."""
    s = pd.Series(s, dtype=float).dropna()
    if len(s) < 50:
        return np.inf
    dy = s.diff().iloc[1:].to_numpy()
    x = s.shift(1).iloc[1:].to_numpy()
    X = np.column_stack([np.ones(len(x)), x])
    beta, _, _, _, _ = _ols(dy, X)
    lam = beta[1]
    if not np.isfinite(lam) or lam >= 0:
        return np.inf
    return float(-math.log(2.0) / lam)


def ann_sharpe(returns: pd.Series, periods_per_year: float) -> float:
    r = returns.dropna()
    if len(r) < 3 or r.std(ddof=1) == 0:
        return np.nan
    return float(r.mean() / r.std(ddof=1) * math.sqrt(periods_per_year))


# --------------------------------------------------------------------------- #
# data
# --------------------------------------------------------------------------- #
def load_closes(tf: str) -> pd.DataFrame:
    out = {}
    for sym in SYMBOLS:
        path = os.path.join(DATA_KLINES, f"{sym}_{tf}.csv")
        df = pd.read_csv(path, usecols=["open_time", "open", "close"])
        t = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        out[sym] = df.set_index(t)["close"].astype(float)
    px = pd.DataFrame(out).sort_index()
    # 15m LINK starts/ends one bar off the other symbols; keep common stamps.
    px = px.dropna()
    assert len(px) > 1000, "too few aligned bars"
    return px


def load_opens(tf: str) -> pd.DataFrame:
    out = {}
    for sym in SYMBOLS:
        path = os.path.join(DATA_KLINES, f"{sym}_{tf}.csv")
        df = pd.read_csv(path, usecols=["open_time", "open"])
        t = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        out[sym] = df.set_index(t)["open"].astype(float)
    px = pd.DataFrame(out).sort_index()
    px = px.dropna()
    assert len(px) > 1000, "too few aligned bars"
    return px


def load_funding() -> dict[str, pd.Series]:
    out = {}
    for sym in SYMBOLS:
        path = os.path.join(DATA_FUNDING, f"{sym}.csv")
        df = pd.read_csv(path)
        t = pd.to_datetime(df["funding_time"], unit="ms", utc=True).dt.round("8h")
        s = pd.Series(df["funding_rate"].astype(float).to_numpy(), index=t)
        s = s[~s.index.duplicated(keep="last")].sort_index()
        out[sym] = s
    return out


# --------------------------------------------------------------------------- #
# pair construction
# --------------------------------------------------------------------------- #
def rolling_spread(log_a: pd.Series, log_b: pd.Series, beta_win: int,
                   z_win: int) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
    """One-step-ahead rolling-OLS spread.

    beta_t / alpha_t are estimated on the window ending at t-1 and applied to
    prices at t.  z uses a trailing mean/std of the spread ending at t.
    Returns (spread, z, sigma, beta_for_hedge) where beta_for_hedge_t is the
    beta estimated through t (available at the close of t, used at open t+1).
    """
    w = beta_win
    minp = max(20, w // 2)
    cov = log_a.rolling(w, min_periods=minp).cov(log_b)
    var = log_b.rolling(w, min_periods=minp).var()
    beta_t = cov / var
    alpha_t = log_a.rolling(w, min_periods=minp).mean() - beta_t * log_b.rolling(w, min_periods=minp).mean()

    beta_lag = beta_t.shift(1)
    alpha_lag = alpha_t.shift(1)
    spread = log_a - alpha_lag - beta_lag * log_b

    mu = spread.rolling(z_win, min_periods=max(50, z_win // 2)).mean()
    sd = spread.rolling(z_win, min_periods=max(50, z_win // 2)).std(ddof=1)
    z = (spread - mu) / sd
    return spread, z, sd, beta_t


def static_spread_z(log_a, log_b, alpha, beta, z_win):
    spread = log_a - alpha - beta * log_b
    mu = spread.rolling(z_win, min_periods=max(50, z_win // 2)).mean()
    sd = spread.rolling(z_win, min_periods=max(50, z_win // 2)).std(ddof=1)
    z = (spread - mu) / sd
    return spread, z, sd


def pair_selection(logs: pd.DataFrame, tf: str, train_end: int,
                   entry_z: float = ENTRY_Z) -> pd.DataFrame:
    cfg = TF_CFG[tf]
    hpb = cfg["hours_per_bar"]
    beta_win, z_win, maxlag = cfg["beta_win"], cfg["z_win"], cfg["maxlag"]
    train_hours = train_end * hpb
    max_hl_h = train_hours / 4.0
    rows = []

    for a, b in combinations(SYMBOLS, 2):
        la = logs[a]
        lb = logs[b]
        la_tr = la.iloc[:train_end]
        lb_tr = lb.iloc[:train_end]
        # static Engle-Granger on the training segment only
        alpha, beta = ols_alpha_beta(la_tr.to_numpy(), lb_tr.to_numpy())
        spread_static = la_tr - alpha - beta * lb_tr
        adf_t, adf_lag = adf_tstat(spread_static.to_numpy(), maxlag)
        hl_static_bars = half_life_bars(spread_static)
        hl_static_h = hl_static_bars * hpb
        corr = float(np.corrcoef(la_tr.diff().iloc[1:].to_numpy(),
                                 lb_tr.diff().iloc[1:].to_numpy())[0, 1])

        # rolling spread (traded series), computed on full history (past only)
        sp_roll, z_roll, sd_roll, _ = rolling_spread(la, lb, beta_win, z_win)
        warm = max(beta_win, z_win) + 5
        sp_tr = sp_roll.iloc[warm:train_end]
        hl_roll_h = half_life_bars(sp_tr) * hpb

        z_tr = z_roll.iloc[warm:train_end].dropna()
        if len(z_tr) > 2:
            above = (z_tr.abs() >= entry_z).to_numpy()
            episodes = int(np.sum(above & ~np.r_[False, above[:-1]]))
        else:
            episodes = 0

        passes = (
            np.isfinite(adf_t) and adf_t < EG_CRIT["5%"]
            and 1.0 < hl_static_h < max_hl_h
            and np.isfinite(hl_roll_h) and hl_roll_h < max_hl_h
            and 0.1 < beta < 10.0
            and np.isfinite(corr) and corr > 0.20
            and episodes >= MIN_TRAIN_EPISODES
        )
        rows.append(dict(
            tf=tf, pair=f"{a}/{b}", A=a, B=b,
            beta_static=beta, alpha_static=alpha,
            adf_t=adf_t, adf_lag=adf_lag,
            adf_crit_5pct=EG_CRIT["5%"],
            hl_static_h=hl_static_h, hl_roll_h=hl_roll_h,
            max_hl_h=max_hl_h, corr=corr,
            train_episodes=episodes, passes=bool(passes),
        ))
    df = pd.DataFrame(rows).sort_values("adf_t").reset_index(drop=True)

    # Eligibility without the cointegration p-value: economic filters only.
    df["eligible"] = (
        np.isfinite(df["adf_t"]) & (df["adf_t"] < -1.0)
        & (df["hl_static_h"] > 1.0) & (df["hl_static_h"] < df["max_hl_h"])
        & np.isfinite(df["hl_roll_h"]) & (df["hl_roll_h"] < df["max_hl_h"])
        & (df["beta_static"] > 0.1) & (df["beta_static"] < 10.0)
        & (df["corr"] > 0.20) & (df["train_episodes"] >= MIN_TRAIN_EPISODES)
    )

    # Pre-registered selection:
    #   strict tier = all pairs passing the 5% Engle-Granger test.
    #   If fewer than 3 pass (as in this sample), use the best available:
    #   top 4 eligible pairs by ADF t.  This is explicitly NOT a claim of
    #   cointegration; it is a best-effort economic test with the holdout
    #   left untouched.
    n_strict = int(df["passes"].sum())
    if n_strict >= 3:
        df["selected_all"] = df["passes"]
        tier = "strict_5pct"
    else:
        chosen_all = set(df.loc[df["eligible"]].sort_values("adf_t")
                         .head(4)["pair"])
        df["selected_all"] = df["pair"].isin(chosen_all)
        tier = "best_available_no_coint"

    # De-duplicated portfolio: greedy over eligible pairs ranked by ADF,
    # no shared symbol, max 6 pairs.
    used = set()
    chosen = []
    for _, r in df[df["eligible"]].iterrows():
        if r["A"] in used or r["B"] in used:
            continue
        used.add(r["A"]); used.add(r["B"])
        chosen.append(r["pair"])
        if len(chosen) >= MAX_PORTFOLIO_PAIRS:
            break
    df["selected_unique"] = df["pair"].isin(chosen)
    df.attrs["selection_tier"] = tier
    df.attrs["n_strict"] = n_strict
    df.attrs["n_eligible"] = int(df["eligible"].sum())
    return df


def time_stop_bars(hl_static_h: float, tf: str) -> int:
    hpb = TF_CFG[tf]["hours_per_bar"]
    n_h = min(TIME_STOP_MAX_H, max(TIME_STOP_MIN_H, TIME_STOP_MULT * hl_static_h))
    return int(round(n_h / hpb))


# --------------------------------------------------------------------------- #
# backtest
# --------------------------------------------------------------------------- #
@dataclass
class Trade:
    tf: str
    pair: str
    A: str
    B: str
    direction: int              # +1 long spread (long A / short B), -1 short spread
    entry_idx: int
    exit_idx: int
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    beta: float
    z_entry: float
    z_exit: float
    exit_reason: str
    sigma_entry: float          # rolling spread std at entry, log units
    hold_bars: int
    hold_hours: float
    gross_W: float              # PnL in units of leg-A notional W
    cost_W: float
    funding_W: float            # cost (positive = drag)
    net_W: float
    gross_cap_W: float
    gross_bp: float             # bp of W
    cost_bp: float
    funding_bp: float
    net_bp: float               # bp of W
    net_gross_bp: float         # bp of gross capital (1+beta)
    entry_gap_bp: float         # |z_entry| * sigma_entry, bp of W
    capture: float              # gross / entry_gap
    legA_net_W: float
    legB_net_W: float


def _sum_funding(fund: pd.Series, t0: pd.Timestamp, t1: pd.Timestamp) -> float:
    if len(fund) == 0:
        return 0.0
    i0 = fund.index.searchsorted(t0, side="right")
    i1 = fund.index.searchsorted(t1, side="right")
    if i1 <= i0:
        return 0.0
    vals = fund.iloc[i0:i1].to_numpy()
    return float(np.nansum(vals))


def _fixed_beta_z(log_a: np.ndarray, log_b: np.ndarray, t: int,
                  beta: float, z_win: int):
    """Spread z using a frozen beta and the trailing z_win window ending at t.

    Returns (z, mean, std).  The same beta/mean/std are frozen for the life of
    the trade, so 'z returns to 0' means the traded spread returns to the
    entry-time mean, not that a rolling mean moved.
    """
    lo = max(0, t - z_win + 1)
    s = log_a[lo:t + 1] - beta * log_b[lo:t + 1]
    mu = float(np.mean(s))
    sd = float(np.std(s, ddof=1))
    if not np.isfinite(sd) or sd <= 0:
        return np.nan, np.nan, np.nan
    return float((s[-1] - mu) / sd), mu, sd


def run_pair_backtest(pair: str, A: str, B: str,
                      beta_hedge: pd.Series,
                      open_px: pd.DataFrame, close_px: pd.DataFrame,
                      funding: dict[str, pd.Series],
                      start: int, end: int, tf: str,
                      cost_mode: str, n_time_stop: int,
                      entry_z: float = ENTRY_Z, exit_z: float = EXIT_Z,
                      stop_z: float = STOP_Z) -> list[Trade]:
    fee = FEE_MODES[cost_mode]["fee"] + FEE_MODES[cost_mode]["slip"]
    opA = open_px[A].to_numpy(); opB = open_px[B].to_numpy()
    clA = close_px[A].to_numpy(); clB = close_px[B].to_numpy()
    log_a = np.log(clA); log_b = np.log(clB)
    b_arr = beta_hedge.to_numpy()
    z_win = TF_CFG[tf]["z_win"]
    idx = close_px.index
    fA = funding.get(A, pd.Series(dtype=float))
    fB = funding.get(B, pd.Series(dtype=float))
    hpb = TF_CFG[tf]["hours_per_bar"]

    trades: list[Trade] = []
    pos = None
    pending_entry = None
    pending_exit = None
    armed = True

    def close_pos(exit_idx, pa1, pb1, reason, z_sig):
        nonlocal pos
        p = pos
        ret_a = pa1 / p["pa0"] - 1.0
        ret_b = pb1 / p["pb0"] - 1.0
        d = p["dir"]; beta = p["beta"]
        gross = d * (ret_a - beta * ret_b)
        cost = 2.0 * fee * (1.0 + beta)
        sum_a = _sum_funding(fA, p["entry_time"], idx[exit_idx])
        sum_b = _sum_funding(fB, p["entry_time"], idx[exit_idx])
        funding_pnl = d * (beta * sum_b - sum_a)
        net = gross + funding_pnl - cost
        leg_a = d * ret_a - 2.0 * fee - d * sum_a
        leg_b = -d * beta * ret_b - 2.0 * fee * beta + d * beta * sum_b
        gap = abs(p["z_entry"]) * p["sigma_entry"] if np.isfinite(p["sigma_entry"]) else np.nan
        tr = Trade(
            tf=tf, pair=pair, A=A, B=B, direction=d,
            entry_idx=p["entry_idx"], exit_idx=exit_idx,
            entry_time=p["entry_time"], exit_time=idx[exit_idx],
            beta=beta, z_entry=p["z_entry"], z_exit=float(z_sig) if np.isfinite(z_sig) else np.nan,
            exit_reason=reason, sigma_entry=p["sigma_entry"],
            hold_bars=int(exit_idx - p["entry_idx"]),
            hold_hours=float((exit_idx - p["entry_idx"]) * hpb),
            gross_W=float(gross), cost_W=float(cost),
            funding_W=float(-funding_pnl), net_W=float(net),
            gross_cap_W=float(1.0 + beta),
            gross_bp=float(gross * 1e4), cost_bp=float(cost * 1e4),
            funding_bp=float(-funding_pnl * 1e4), net_bp=float(net * 1e4),
            net_gross_bp=float(net / (1.0 + beta) * 1e4),
            entry_gap_bp=float(gap * 1e4),
            capture=float(gross / gap) if gap and np.isfinite(gap) and gap > 0 else np.nan,
            legA_net_W=float(leg_a), legB_net_W=float(leg_b),
        )
        trades.append(tr)
        pos = None

    for t in range(start, end):
        # execute scheduled actions at the open of bar t
        if pending_exit is not None and pos is not None:
            close_pos(t, opA[t], opB[t], pending_exit[0], pending_exit[1])
            pending_exit = None
        if pending_entry is not None and pos is None:
            pe = pending_entry
            pos = dict(
                entry_idx=t, entry_time=idx[t], dir=pe["dir"], beta=pe["beta"],
                z_entry=pe["z_entry"], sigma_entry=pe["sigma"],
                mu=pe["mu"], pa0=opA[t], pb0=opB[t],
            )
            pending_entry = None
            armed = False

        if pos is None:
            beta_t = b_arr[t]
            if np.isfinite(beta_t) and beta_t > 0:
                zt, mu, sd = _fixed_beta_z(log_a, log_b, t, float(beta_t), z_win)
            else:
                zt, mu, sd = np.nan, np.nan, np.nan
            z_ok = np.isfinite(zt)
            if z_ok and abs(zt) < entry_z:
                armed = True
            if (armed and z_ok and abs(zt) >= entry_z
                    and t + 1 < end and np.isfinite(sd) and sd > 0):
                pending_entry = dict(dir=(-1 if zt > 0 else 1), z_entry=float(zt),
                                     sigma=float(sd), mu=float(mu),
                                     beta=float(beta_t))
        else:
            raw = log_a[t] - pos["beta"] * log_b[t]
            zt = (raw - pos["mu"]) / pos["sigma_entry"]
            z_ok = np.isfinite(zt)
            reason = None
            if z_ok:
                if pos["dir"] == -1 and zt >= stop_z:
                    reason = "stop"
                elif pos["dir"] == 1 and zt <= -stop_z:
                    reason = "stop"
                elif pos["dir"] == -1 and zt <= exit_z:
                    reason = "revert"
                elif pos["dir"] == 1 and zt >= exit_z:
                    reason = "revert"
            if reason is None and (t - pos["entry_idx"]) >= n_time_stop:
                reason = "time"
                # z at the time-stop decision, for diagnostics
            if reason is not None:
                if t + 1 < end:
                    pending_exit = (reason, float(zt))
                else:
                    close_pos(t, clA[t], clB[t], reason, float(zt))

    if pos is not None:
        raw = log_a[end - 1] - pos["beta"] * log_b[end - 1]
        z_end = (raw - pos["mu"]) / pos["sigma_entry"]
        close_pos(end - 1, clA[end - 1], clB[end - 1], "end", float(z_end))
    return trades


# --------------------------------------------------------------------------- #
# summarise
# --------------------------------------------------------------------------- #
def summarize(trades: list[Trade]) -> dict:
    if not trades:
        return dict(n_trades=0)
    net = np.array([tr.net_W for tr in trades], dtype=float)
    gross = np.array([tr.gross_W for tr in trades], dtype=float)
    cost = np.array([tr.cost_W for tr in trades], dtype=float)
    fund = np.array([tr.funding_W for tr in trades], dtype=float)
    net_gross = np.array([tr.net_gross_bp for tr in trades], dtype=float)
    gaps = np.array([tr.entry_gap_bp for tr in trades], dtype=float)
    caps = np.array([tr.gross_cap_W for tr in trades], dtype=float)
    zs = np.array([tr.z_entry for tr in trades], dtype=float)
    sig = np.array([tr.sigma_entry for tr in trades], dtype=float)
    holds = np.array([tr.hold_hours for tr in trades], dtype=float)
    reasons = pd.Series([tr.exit_reason for tr in trades]).value_counts()
    n = len(trades)
    mean_net = float(net.mean())
    se = float(net.std(ddof=1) / math.sqrt(n)) if n > 1 else np.nan
    tstat = mean_net / se if se and np.isfinite(se) and se > 0 else np.nan
    p_one = float(stats.t.sf(tstat, df=n - 1)) if np.isfinite(tstat) else np.nan
    pos_sum = float(net[net > 0].sum())
    neg_sum = float(-net[net < 0].sum())
    pf = pos_sum / neg_sum if neg_sum > 0 else np.inf
    cum = np.cumsum(net)
    dd = float((cum - np.maximum.accumulate(cum)).min()) if n else 0.0
    return dict(
        n_trades=n,
        win_rate=float((net > 0).mean()),
        avg_gross_bp=float(gross.mean() * 1e4),
        avg_cost_bp=float(cost.mean() * 1e4),
        avg_funding_bp=float(fund.mean() * 1e4),
        avg_net_bp=float(net.mean() * 1e4),
        avg_net_gross_bp=float(net_gross.mean()),
        total_net_W=float(net.sum()),
        total_net_pct_gross=float(net.sum() / caps.sum() * 100.0) if caps.sum() else np.nan,
        t_stat=float(tstat) if np.isfinite(tstat) else np.nan,
        p_one_sided=p_one,
        profit_factor=float(pf),
        max_dd_W=dd,
        avg_hold_h=float(holds.mean()),
        median_hold_h=float(np.median(holds)),
        avg_entry_abs_z=float(np.abs(zs).mean()),
        avg_sigma_entry_bp=float(np.nanmean(sig) * 1e4),
        median_sigma_entry_bp=float(np.nanmedian(sig) * 1e4),
        avg_entry_gap_bp=float(np.nanmean(gaps)),
        median_entry_gap_bp=float(np.nanmedian(gaps)),
        avg_capture=float(np.nanmean([tr.capture for tr in trades])),
        frac_gross_gt_cost=float((gross > cost).mean()),
        exit_revert=int(reasons.get("revert", 0)),
        exit_stop=int(reasons.get("stop", 0)),
        exit_time=int(reasons.get("time", 0)),
        exit_end=int(reasons.get("end", 0)),
    )


def _trade_rows(trades, tf, cost_mode, row_type, scope, segment):
    rows = []
    if not trades:
        return rows
    df = pd.DataFrame([asdict(t) for t in trades])
    for pair, g in df.groupby("pair"):
        s = summarize([t for t in trades if t.pair == pair])
        rows.append(dict(row_type=row_type, segment=segment, tf=tf, pair=pair,
                         scope=scope, cost_mode=cost_mode, **s))
    return rows


def _portfolio_row(trades, tf, cost_mode, scope, segment):
    s = summarize(trades)
    row = dict(row_type="portfolio", segment=segment, tf=tf, pair="PORTFOLIO",
               scope=scope, cost_mode=cost_mode)
    row.update(s)
    return row


# --------------------------------------------------------------------------- #
# main experiment
# --------------------------------------------------------------------------- #
def run_experiment(tf: str, cost_mode: str, verbose: bool = True,
                   diag_eligible: bool = False):
    cfg = TF_CFG[tf]
    train_end = cfg["train_bars"]
    close_px = load_closes(tf)
    open_px = load_opens(tf)
    funding = load_funding()
    n_bars = len(close_px)
    test_end = min(train_end + cfg["test_bars"], n_bars)
    assert n_bars > train_end + 100, (n_bars, train_end)
    logs = np.log(close_px)

    sel = pair_selection(logs, tf, train_end)
    hpb = cfg["hours_per_bar"]

    # precompute rolling features for every pair once
    feats = {}
    for a, b in combinations(SYMBOLS, 2):
        sp, z, sd, beta_h = rolling_spread(logs[a], logs[b], cfg["beta_win"], cfg["z_win"])
        feats[(a, b)] = dict(spread=sp, z=z, sigma=sd, beta_hedge=beta_h)

    trades_by_pair = {}
    pair_meta = {}
    for _, r in sel[sel["selected_all"] | sel["selected_unique"]].iterrows():
        key = (r["A"], r["B"])
        f = feats[key]
        n_ts = time_stop_bars(r["hl_static_h"], tf)
        trades = run_pair_backtest(
            r["pair"], r["A"], r["B"], f["beta_hedge"],
            open_px, close_px, funding, train_end, test_end, tf, cost_mode, n_ts)
        pair_meta[r["pair"]] = dict(hl_static_h=r["hl_static_h"], adf_t=r["adf_t"],
                                    beta=r["beta_static"], time_stop_bars=n_ts)
        trades_by_pair[r["pair"]] = trades

    all_pairs = set(sel.loc[sel["selected_all"], "pair"])
    unique_pairs = set(sel.loc[sel["selected_unique"], "pair"])
    all_trades = [t for p, tl in trades_by_pair.items() if p in all_pairs for t in tl]
    unique_trades = [t for p, tl in trades_by_pair.items() if p in unique_pairs for t in tl]

    # Diagnostic: run every eligible pair on the holdout (not used for the
    # portfolio or pass/fail).  Shows the full cross-section and the
    # multiple-testing problem.
    diag_trades = []
    if diag_eligible:
        already = set(sel.loc[sel["selected_all"] | sel["selected_unique"], "pair"])
        for _, r in sel[sel["eligible"]].iterrows():
            if r["pair"] in already:
                continue
            f = feats[(r["A"], r["B"])]
            n_ts = time_stop_bars(r["hl_static_h"], tf)
            diag_trades.extend(run_pair_backtest(
                r["pair"], r["A"], r["B"], f["beta_hedge"],
                open_px, close_px, funding, train_end, test_end, tf,
                cost_mode, n_ts))

    all_eligible_trades = (
        all_trades
        + [t for t in unique_trades if t.pair not in all_pairs]
        + diag_trades
    )

    return dict(tf=tf, cost_mode=cost_mode, sel=sel, feats=feats, logs=logs,
                close_px=close_px, open_px=open_px, funding=funding,
                train_end=train_end, test_end=test_end,
                all_trades=all_trades, unique_trades=unique_trades,
                diag_trades=diag_trades,
                all_eligible_trades=all_eligible_trades,
                diag_eligible_ran=bool(diag_eligible),
                pair_meta=pair_meta,
                selection_tier=sel.attrs.get("selection_tier", "?"),
                n_strict=sel.attrs.get("n_strict", 0),
                n_eligible=sel.attrs.get("n_eligible", 0))


def sensitivity_run(base, tf, cost_mode, entry_z=ENTRY_Z, static_beta=False,
                    time_stop_override=None, stop_z=STOP_Z, scope="all"):
    """Rerun selected pairs with one parameter changed (exploratory only)."""
    cfg = TF_CFG[tf]
    sel = base["sel"]; logs = base["logs"]
    close_px, open_px, funding = base["close_px"], base["open_px"], base["funding"]
    subset = sel[sel["selected_unique"]] if scope == "unique" else sel[sel["selected_all"]]
    trades_all = []
    for _, r in subset.iterrows():
        a, b = r["A"], r["B"]
        if static_beta:
            beta_h = pd.Series(r["beta_static"], index=logs.index)
        else:
            beta_h = base["feats"][(a, b)]["beta_hedge"]
        n_ts = time_stop_override or time_stop_bars(r["hl_static_h"], tf)
        trades_all.extend(run_pair_backtest(
            r["pair"], a, b, beta_h, open_px, close_px, funding,
            base["train_end"], base["test_end"], tf, cost_mode, n_ts,
            entry_z=entry_z, stop_z=stop_z))
    return trades_all


def rolling_folds(base, n_folds=3, fold_days=20):
    """3 x (120d train / 20d test) rolling walk-forward, re-selecting pairs."""
    tf = base["tf"]; cfg = TF_CFG[tf]; hpb = cfg["hours_per_bar"]
    logs = base["logs"]; close_px = base["close_px"]; open_px = base["open_px"]
    funding = base["funding"]
    train_bars = cfg["train_bars"]
    fold_bars = int(fold_days * cfg["bars_per_day"])
    out = []
    for f in range(n_folds):
        test_start = train_bars + f * fold_bars
        test_end = min(len(logs), test_start + fold_bars)
        train_start = test_start - train_bars
        # re-select on the fold's own 120d training window (all data are past)
        logs_win = logs.iloc[train_start:test_start].copy()
        sel = pair_selection(logs_win, tf, train_bars)
        trades_by_pair = {}
        for _, r in sel[sel["selected_all"] | sel["selected_unique"]].iterrows():
            a, b = r["A"], r["B"]
            beta_h = rolling_spread(logs[a], logs[b],
                                    cfg["beta_win"], cfg["z_win"])[3]
            n_ts = time_stop_bars(r["hl_static_h"], tf)
            trades_by_pair[r["pair"]] = run_pair_backtest(
                r["pair"], a, b, beta_h, open_px, close_px, funding,
                test_start, test_end, tf, base["cost_mode"], n_ts)
        all_pairs = set(sel.loc[sel["selected_all"], "pair"])
        unique_pairs = set(sel.loc[sel["selected_unique"], "pair"])
        trades_all = [t for p, tl in trades_by_pair.items() if p in all_pairs for t in tl]
        unique_tr = [t for p, tl in trades_by_pair.items() if p in unique_pairs for t in tl]
        out.append(dict(fold=f + 1, train_start_idx=train_start,
                        test_start_idx=test_start, test_end_idx=test_end,
                        sel=sel, trades_all=trades_all, unique_trades=unique_tr))
    return out


def consolidate_results():
    """Concatenate every results_<tf>_<cost>.csv into the deliverable results.csv."""
    frames = []
    for path in sorted(glob.glob(os.path.join(OUT_DIR, "results_*.csv"))):
        if os.path.basename(path) == "results.csv":
            continue
        frames.append(pd.read_csv(path))
    if frames:
        out = pd.concat(frames, ignore_index=True, sort=False)
        # selection / symbol attribution are cost-independent, and breakeven
        # rows are written by both the taker and maker runs; drop duplicates.
        key_map = {
            "selection": ["tf", "pair"],
            "breakeven": ["tf", "pair", "cost_mode"],
            "symbol_attribution": ["tf", "pair"],
        }
        parts = []
        for rt, keys in key_map.items():
            mask = out["row_type"] == rt
            parts.append(out[mask].drop_duplicates(keys))
        parts.append(out[~out["row_type"].isin(key_map)])
        out = pd.concat(parts, ignore_index=True, sort=False)
        out.to_csv(os.path.join(OUT_DIR, "results.csv"), index=False)
        return out
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", default="1h", choices=list(TF_CFG))
    ap.add_argument("--cost", default="taker", choices=list(FEE_MODES))
    ap.add_argument("--skip-folds", action="store_true")
    ap.add_argument("--skip-sensitivity", action="store_true")
    ap.add_argument("--diag-eligible", action="store_true",
                    help="also backtest every eligible pair on the holdout")
    args = ap.parse_args()

    tf = args.tf
    base = run_experiment(tf, args.cost, diag_eligible=args.diag_eligible)
    sel = base["sel"]
    rows = []

    # ---- selection table ----
    for _, r in sel.iterrows():
        d = dict(row_type="selection", segment="train", tf=tf, pair=r["pair"],
                 A=r["A"], B=r["B"], beta=round(r["beta_static"], 6),
                 adf_t=round(r["adf_t"], 4), adf_lag=r["adf_lag"],
                 hl_static_h=round(r["hl_static_h"], 2),
                 hl_roll_h=round(r["hl_roll_h"], 2),
                 max_hl_h=r["max_hl_h"], corr=round(r["corr"], 4),
                 train_episodes=r["train_episodes"],
                 passes=r["passes"], eligible=r["eligible"],
                 selected_all=r["selected_all"],
                 selected_unique=r["selected_unique"],
                 selection_tier=base["selection_tier"],
                 time_stop_bars=time_stop_bars(r["hl_static_h"], tf)
                 if r["selected_all"] else np.nan,
                 scope="selection")
        rows.append(d)

    # ---- holdout ----
    rows.extend(_trade_rows(base["all_trades"], tf, args.cost,
                            "holdout_pair", "all_passing", "holdout"))
    rows.append(_portfolio_row(base["all_trades"], tf, args.cost,
                               "all_passing", "holdout"))
    if set(t.pair for t in base["unique_trades"]) != set(t.pair for t in base["all_trades"]):
        rows.extend(_trade_rows(base["unique_trades"], tf, args.cost,
                                "holdout_pair", "unique", "holdout"))
        rows.append(_portfolio_row(base["unique_trades"], tf, args.cost,
                                   "unique", "holdout"))
    if base["diag_trades"]:
        rows.extend(_trade_rows(base["diag_trades"], tf, args.cost,
                                "diag_pair", "other_eligible", "holdout"))
    if base["diag_eligible_ran"] and base["all_eligible_trades"]:
        rows.append(_portfolio_row(base["all_eligible_trades"], tf, args.cost,
                                   "all_eligible_equal_weight", "holdout"))

    # ---- per-symbol attribution (holdout, all passing, taker) ----
    if base["all_trades"]:
        attr = {}
        for t in base["all_trades"]:
            attr.setdefault(t.A, []).append(t.legA_net_W)
            attr.setdefault(t.B, []).append(t.legB_net_W)
        for sym, vals in sorted(attr.items()):
            rows.append(dict(row_type="symbol_attribution", segment="holdout",
                             tf=tf, pair=sym, scope="all_passing",
                             cost_mode=args.cost, n_trades=len(vals),
                             total_net_W=float(np.sum(vals)),
                             avg_net_W=float(np.mean(vals))))

    # ---- 3-fold rolling ----
    if not args.skip_folds:
        folds = rolling_folds(base)
        for fd in folds:
            fold_no = fd["fold"]
            t0 = base["close_px"].index[fd["test_start_idx"]]
            t1 = base["close_px"].index[fd["test_end_idx"] - 1]
            for _, r in fd["sel"][fd["sel"]["selected_all"]].iterrows():
                pass
            tr_all = fd["trades_all"]
            tdf = pd.DataFrame([asdict(t) for t in tr_all]) if tr_all else pd.DataFrame()
            for pair in sorted(set(t.pair for t in tr_all)) if tr_all else []:
                s = summarize([t for t in tr_all if t.pair == pair])
                rows.append(dict(row_type="fold_pair", segment=f"fold{fold_no}",
                                 tf=tf, pair=pair, scope="all_passing",
                                 cost_mode=args.cost, fold=fold_no,
                                 test_start=str(t0), test_end=str(t1), **s))
            tr_u = fd["unique_trades"]
            for pair in sorted(set(t.pair for t in tr_u) - set(t.pair for t in tr_all)) if tr_u else []:
                s = summarize([t for t in tr_u if t.pair == pair])
                rows.append(dict(row_type="fold_pair", segment=f"fold{fold_no}",
                                 tf=tf, pair=pair, scope="unique",
                                 cost_mode=args.cost, fold=fold_no,
                                 test_start=str(t0), test_end=str(t1), **s))
            s = summarize(tr_all)
            rows.append(dict(row_type="fold_portfolio", segment=f"fold{fold_no}",
                             tf=tf, pair="PORTFOLIO", scope="all_passing",
                             cost_mode=args.cost, fold=fold_no,
                             test_start=str(t0), test_end=str(t1),
                             n_selected=int(fd["sel"]["selected_all"].sum()),
                             selected_pairs=";".join(
                                 fd["sel"].loc[fd["sel"]["selected_all"], "pair"].tolist()),
                             **s))
            tr_u = fd["unique_trades"]
            if tr_u:
                s_u = summarize(tr_u)
                rows.append(dict(row_type="fold_portfolio", segment=f"fold{fold_no}",
                                 tf=tf, pair="PORTFOLIO", scope="unique",
                                 cost_mode=args.cost, fold=fold_no,
                                 test_start=str(t0), test_end=str(t1),
                                 n_selected=int(fd["sel"]["selected_unique"].sum()),
                                 selected_pairs=";".join(
                                     fd["sel"].loc[fd["sel"]["selected_unique"], "pair"].tolist()),
                                 **s_u))
        # aggregate folds (all trades across the three non-overlapping test windows)
        all_fold_tr = [t for fd in folds for t in fd["trades_all"]]
        s = summarize(all_fold_tr)
        rows.append(dict(row_type="fold_portfolio", segment="folds_all",
                         tf=tf, pair="PORTFOLIO", scope="all_passing",
                         cost_mode=args.cost, fold="1-3",
                         test_start=str(base["close_px"].index[base["train_end"]]),
                         test_end=str(base["close_px"].index[-1]),
                         n_selected=np.nan, selected_pairs="re-selected per fold", **s))
        all_fold_u = [t for fd in folds for t in fd["unique_trades"]]
        s_u = summarize(all_fold_u)
        rows.append(dict(row_type="fold_portfolio", segment="folds_all",
                         tf=tf, pair="PORTFOLIO", scope="unique",
                         cost_mode=args.cost, fold="1-3",
                         test_start=str(base["close_px"].index[base["train_end"]]),
                         test_end=str(base["close_px"].index[-1]),
                         n_selected=np.nan, selected_pairs="re-selected per fold",
                         **s_u))

    # ---- sensitivity (exploratory, not used for pass/fail) ----
    if not args.skip_sensitivity:
        for z in (1.5, 2.5, 3.0):
            tr = sensitivity_run(base, tf, args.cost, entry_z=z)
            s = summarize(tr)
            rows.append(dict(row_type="sensitivity", segment="holdout", tf=tf,
                             pair="PORTFOLIO", scope=f"entry_z={z}",
                             cost_mode=args.cost, entry_z=z, **s))
        tr = sensitivity_run(base, tf, args.cost, static_beta=True)
        s = summarize(tr)
        rows.append(dict(row_type="sensitivity", segment="holdout", tf=tf,
                         pair="PORTFOLIO", scope="static_beta",
                         cost_mode=args.cost, **s))
        for n_h in (168, 336, 720):
            tr = sensitivity_run(base, tf, args.cost,
                                 time_stop_override=int(round(n_h / TF_CFG[tf]["hours_per_bar"])))
            s = summarize(tr)
            rows.append(dict(row_type="sensitivity", segment="holdout", tf=tf,
                             pair="PORTFOLIO", scope=f"time_stop={n_h}h",
                             cost_mode=args.cost, **s))
        for sz in (5.0, 99.0):
            tr = sensitivity_run(base, tf, args.cost, stop_z=sz)
            s = summarize(tr)
            rows.append(dict(row_type="sensitivity", segment="holdout", tf=tf,
                             pair="PORTFOLIO", scope=f"stop_z={sz}",
                             cost_mode=args.cost, stop_z=sz, **s))
        tr = sensitivity_run(base, tf, args.cost, stop_z=99.0, scope="unique")
        s = summarize(tr)
        rows.append(dict(row_type="sensitivity", segment="holdout", tf=tf,
                         pair="PORTFOLIO", scope="unique_stop_z=99",
                         cost_mode=args.cost, stop_z=99.0, **s))
        tr = sensitivity_run(base, tf, args.cost, entry_z=3.0, scope="unique")
        s = summarize(tr)
        rows.append(dict(row_type="sensitivity", segment="holdout", tf=tf,
                         pair="PORTFOLIO", scope="unique_entry_z=3.0",
                         cost_mode=args.cost, entry_z=3.0, **s))

    # ---- cost-mode comparison on the same trades ----
    if args.cost == "taker":
        tr_maker = sensitivity_run(base, tf, "maker")
        s = summarize(tr_maker)
        rows.append(dict(row_type="sensitivity", segment="holdout", tf=tf,
                         pair="PORTFOLIO", scope="maker_costs_same_pairs",
                         cost_mode="maker", **s))

    # ---- question-7 diagnostics ----
    if base["all_trades"]:
        tr = pd.DataFrame([asdict(t) for t in base["all_trades"]])
        for pair, g in tr.groupby("pair"):
            for cm in ("taker", "maker"):
                fee = FEE_MODES[cm]["fee"] + FEE_MODES[cm]["slip"]
                # per-trade breakeven z against its own sigma and realised capture
                sig = g["sigma_entry"].to_numpy()
                caps = g["gross_cap_W"].to_numpy()
                fund_abs = np.abs(g["funding_W"].to_numpy())
                capture = g["capture"].to_numpy()
                zabs = np.abs(g["z_entry"].to_numpy())
                cost_bp = 2 * fee * caps * 1e4 + fund_abs * 1e4
                sig_bp = sig * 1e4
                gap_bp = g["entry_gap_bp"].to_numpy()
                cost_med = float(np.nanmedian(cost_bp))
                sig_med = float(np.nanmedian(sig_bp))
                gap_med = float(np.nanmedian(gap_bp))
                z_med = float(np.nanmedian(zabs))
                # Cost coverage: gap needed is cost; with z=2 the gross gap is
                # |z|*sigma, so only cost/gap of it must be captured.
                required_capture = cost_med / gap_med if gap_med > 0 else np.nan
                z_full = cost_med / sig_med if sig_med > 0 else np.nan
                stop_loss_sigma = max(0.0, STOP_Z - z_med)
                be_revert = ((stop_loss_sigma + (cost_med / sig_med if sig_med > 0 else np.nan))
                             / (z_med + stop_loss_sigma)) if (z_med + stop_loss_sigma) > 0 else np.nan
                rows.append(dict(
                    row_type="breakeven", segment="holdout", tf=tf, pair=pair,
                    scope="per_pair", cost_mode=cm,
                    n_trades=len(g),
                    median_sigma_entry_bp=sig_med,
                    median_entry_gap_bp=gap_med,
                    median_entry_abs_z=z_med,
                    median_cost_bp=cost_med,
                    median_funding_bp=float(np.nanmedian(fund_abs * 1e4)),
                    median_capture=float(np.nanmedian(capture)),
                    required_capture_pct=float(required_capture * 100.0),
                    z_min_full_reversion=float(z_full),
                    breakeven_revert_rate=float(be_revert),
                    realized_revert_rate=float((g["exit_reason"] == "revert").mean()),
                    stop_rate=float((g["exit_reason"] == "stop").mean()),
                    frac_sigma_covers_28bp=float(np.nanmean(sig > 0.0028)),
                ))

    out = pd.DataFrame(rows)
    # stable column order
    front = ["row_type", "segment", "tf", "pair", "scope", "cost_mode",
             "selection_tier", "fold", "test_start", "test_end",
             "n_trades", "win_rate",
             "avg_gross_bp", "avg_cost_bp", "avg_funding_bp", "avg_net_bp",
             "avg_net_gross_bp", "total_net_W", "total_net_pct_gross",
             "t_stat", "p_one_sided", "profit_factor", "max_dd_W",
             "avg_hold_h", "avg_entry_gap_bp", "avg_capture",
             "frac_gross_gt_cost", "median_sigma_entry_bp",
             "required_capture_pct", "z_min_full_reversion",
             "breakeven_revert_rate", "realized_revert_rate", "stop_rate",
             "passes", "eligible", "selected_all", "selected_unique"]
    cols = front + [c for c in out.columns if c not in front]
    out = out[[c for c in cols if c in out.columns]]
    path = os.path.join(OUT_DIR, f"results_{tf}_{args.cost}.csv")
    out.to_csv(path, index=False)

    # console summary
    print(f"=== {tf} / {args.cost} ===")
    print(f"pairs tested: {len(sel)}, strict 5% EG pass: {base['n_strict']}, "
          f"eligible: {base['n_eligible']}, tier: {base['selection_tier']}")
    print(f"selected_all: {int(sel['selected_all'].sum())}, "
          f"selected_unique: {int(sel['selected_unique'].sum())}")
    print(sel.loc[sel["selected_all"], ["pair", "adf_t", "hl_static_h", "hl_roll_h",
                                        "corr", "train_episodes", "beta_static"]]
          .to_string(index=False))
    s = summarize(base["all_trades"])
    print("\nHOLDOUT all passing:")
    for k, v in s.items():
        print(f"  {k}: {v}")
    s2 = summarize(base["unique_trades"])
    print("\nHOLDOUT unique:")
    for k, v in s2.items():
        print(f"  {k}: {v}")
    consolidate_results()
    return out


if __name__ == "__main__":
    main()
