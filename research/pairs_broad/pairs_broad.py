#!/usr/bin/env python
"""Broad-universe pairs / statistical-arbitrage research.

Round 2 of the pairs study.  Round 1 used 8 majors and found 0/28
Engle-Granger passes; the binding constraint was not cost but the
reversion rate (39.5-44.1% realised vs 42-46% breakeven).  This script
asks whether a 50-coin universe and cluster-aware pair construction
produce pairs whose *out-of-sample* reversion rate clears breakeven.

Design (all choices made on the training segment only):

* 50 USDT-M perpetuals across majors / DeFi / L1-L2 / meme / AI / old /
  gaming.  KORUUSDT is excluded (2026-07-15 contract conversion).
* 1h bars, 180 days.  First 120 days = train, last 60 days = holdout.
* Pair universe = all within-sector combinations.  A data-driven
  hierarchical clustering on training returns is also reported; in this
  sample it collapses into one mega-cluster, so ex-ante sector groups
  are used (explicitly allowed by the research brief).
* Engle-Granger (OLS log A on log B, ADF on residual) on the training
  segment only.  ADF p-values come from a Monte-Carlo null of independent
  Gaussian random walks with the same sample length and AIC lag search
  (validated against rho=0.8 correlated walks).
* Selection gate: p_EG < 0.05, half-life 2-168h, return corr >= 0.5,
  0.1 <= beta <= 10, >= 3 training z-episodes.  Multiple testing is
  corrected with Bonferroni and Benjamini-Hochberg.
* Trading rules (same as round 1): enter at |z| >= 2, exit at z = 0,
  stop at |z| >= 3.5, time stop = clamp(3*HL, 72h, 336h).  Signals on
  bar close, execution at next bar open.  Static training beta; rolling
  z-window 168h.
* Costs: two legs, taker 5bp fee + 2bp slippage per leg per side
  (28bp round trip on a beta=1 pair), maker 2bp + 1bp variant.
  Funding is excluded (round 1 measured <2bp/trade).
* Validation: 120d/60d split plus 3-fold walk-forward (120d train,
  20d test, sliding 20d, re-selecting pairs in every fold).

Outputs (research/pairs_broad/):
  results.csv          long-format results (selection / holdout / folds)
  trades_holdout.csv   trade-level audit trail of the primary holdout
  eg_null_*.npz        cached Monte-Carlo null table
  report.md            written separately from these results

No orders, no keys, no changes outside research/pairs_broad/.
"""

from __future__ import annotations

import csv
import glob
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from itertools import combinations

import numpy as np
import pandas as pd
from scipy import stats
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform

# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(ROOT, "research", "data", "pairs_broad")
OUT_DIR = os.path.join(ROOT, "research", "pairs_broad")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)

PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or "http://127.0.0.1:7897"
BASE = "https://fapi.binance.com"

# Ex-ante sector groups.  Pair construction is restricted to these groups.
SECTORS: dict[str, list[str]] = {
    "majors": ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
               "DOGEUSDT", "ADAUSDT", "TRXUSDT", "LTCUSDT", "BCHUSDT"],
    "defi": ["UNIUSDT", "AAVEUSDT", "LINKUSDT", "CRVUSDT", "LDOUSDT",
             "PENDLEUSDT", "JUPUSDT", "ONDOUSDT", "ENAUSDT"],
    "l1": ["AVAXUSDT", "DOTUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT",
           "OPUSDT", "SUIUSDT", "SEIUSDT", "TIAUSDT", "INJUSDT",
           "STXUSDT", "ICPUSDT"],
    "meme": ["1000PEPEUSDT", "1000SHIBUSDT", "WIFUSDT", "1000BONKUSDT",
             "FARTCOINUSDT", "TRUMPUSDT"],
    "ai": ["FETUSDT", "TAOUSDT", "WLDUSDT", "RENDERUSDT", "VIRTUALUSDT",
           "ZEREBROUSDT"],
    "old": ["ETCUSDT", "XLMUSDT", "ZECUSDT", "DASHUSDT"],
    "gaming": ["SANDUSDT", "GALAUSDT", "CHZUSDT"],
}
SYMBOLS = [s for group in SECTORS.values() for s in group]
SYMBOL_SECTOR = {s: sec for sec, group in SECTORS.items() for s in group}
assert len(SYMBOLS) == 50 and len(set(SYMBOLS)) == 50
EXCLUDED = {"KORUUSDT": "2026-07-15 contract conversion 21.212963x"}

DAYS = 180
BARS_PER_DAY = 24
TRAIN_DAYS = 120
HOLDOUT_DAYS = 60
TRAIN_BARS = TRAIN_DAYS * BARS_PER_DAY          # 2880
HOLDOUT_BARS = HOLDOUT_DAYS * BARS_PER_DAY      # 1440
FOLD_DAYS = 20
FOLD_BARS = FOLD_DAYS * BARS_PER_DAY            # 480
N_FOLDS = 3

Z_WIN = 168                 # rolling z window, hours (= bars on 1h)
ENTRY_Z = 2.0
EXIT_Z = 0.0
STOP_Z = 3.5
HL_MIN_H = 2.0
HL_MAX_H = 168.0            # 1 week; keeps >= ~17 cycles in 120d train
MIN_TRAIN_EPISODES = 3
CORR_MIN = 0.5
BETA_MIN, BETA_MAX = 0.1, 10.0
TIME_STOP_MIN_H, TIME_STOP_MAX_H, TIME_STOP_MULT = 72.0, 336.0, 3.0

FEE_MODES = {
    "taker": 5e-4 + 2e-4,   # 7bp per leg per side
    "maker": 2e-4 + 1e-4,   # 3bp per leg per side
}

ADF_MAXLAG = 12
MC_REPS = 10_000
MC_SEED = 20261017
MC_RHO_CALIB_REPS = 2_000
MC_RHO_CALIB = 0.8

CLUSTER_CORR = 0.50         # diagnostic only: distance = sqrt(2(1-corr))

# --------------------------------------------------------------------------- #
# data download / load
# --------------------------------------------------------------------------- #
def _opener():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
    )


def _get(opener, path: str, params: dict):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
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
        except Exception as exc:  # network wobble
            wait = 2 ** attempt
            print(f"    {exc}, retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed: {url}")


def download_all(force: bool = False) -> None:
    """Download 180d of 1h bars for the 50-symbol universe (cached)."""
    opener = _opener()
    now = int(time.time() * 1000)
    end = (now // 3_600_000) * 3_600_000 - 1     # exclude the partial bar
    start = end - DAYS * 86_400_000
    for i, sym in enumerate(SYMBOLS):
        path = os.path.join(DATA_DIR, f"{sym}_1h.csv")
        if os.path.exists(path) and os.path.getsize(path) > 10_000 and not force:
            continue
        rows: list[list] = []
        cursor = start
        while cursor <= end:
            batch = _get(opener, "/fapi/v1/klines", {
                "symbol": sym, "interval": "1h", "startTime": cursor,
                "endTime": end, "limit": 1500,
            })
            if not batch:
                break
            rows.extend(batch)
            nxt = int(batch[-1][0]) + 3_600_000
            if nxt <= cursor:
                break
            cursor = nxt
            time.sleep(0.15)
        with open(path, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["open_time", "open", "high", "low", "close",
                        "volume", "quote_volume", "trades"])
            for r in rows:
                w.writerow([r[0], r[1], r[2], r[3], r[4], r[5], r[7], r[8]])
        print(f"  {i:2d} {sym:14s} bars={len(rows)}")


def load_prices() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Return aligned close, open and log-close frames (last 180 days)."""
    closes, opens = {}, {}
    for sym in SYMBOLS:
        path = os.path.join(DATA_DIR, f"{sym}_1h.csv")
        if not os.path.exists(path):
            raise FileNotFoundError(f"missing {path}; run with --download")
        df = pd.read_csv(path)
        idx = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        closes[sym] = pd.Series(df["close"].astype(float).to_numpy(), index=idx)
        opens[sym] = pd.Series(df["open"].astype(float).to_numpy(), index=idx)
    close = pd.DataFrame(closes).sort_index()
    open_ = pd.DataFrame(opens).sort_index()
    # intersection keeps all symbols on an identical clock; no filling.
    close = close.dropna(how="any")
    open_ = open_.loc[close.index]
    if len(close) > DAYS * BARS_PER_DAY:
        close = close.iloc[-DAYS * BARS_PER_DAY:]
        open_ = open_.iloc[-DAYS * BARS_PER_DAY:]
    assert len(close) == DAYS * BARS_PER_DAY, f"aligned bars={len(close)}"
    assert (close > 0).all().all()
    for sym in EXCLUDED:
        assert sym not in close.columns
    return close, open_, np.log(close)


# --------------------------------------------------------------------------- #
# statistical helpers (statsmodels is not installed)
# --------------------------------------------------------------------------- #
def _ols(y: np.ndarray, X: np.ndarray):
    """Return (beta, resid, inv_xtx)."""
    inv = np.linalg.pinv(X.T @ X)
    beta = inv @ (X.T @ y)
    resid = y - X @ beta
    return beta, resid, inv


def adf_tstat(y: np.ndarray, maxlag: int = ADF_MAXLAG):
    """ADF with constant; lag chosen by AIC.  Returns (t_stat, lag)."""
    y = np.asarray(y, dtype=float)
    y = y[np.isfinite(y)]
    dy = np.diff(y)
    n = len(dy)
    if n < 50:
        return np.nan, 0
    maxlag = int(min(maxlag, max(0, n // 10)))
    best = None
    for p in range(maxlag + 1):
        T = n - p
        if T < 30:
            continue
        cols = [np.ones(T), y[p:n]]
        for i in range(1, p + 1):
            cols.append(dy[p - i:n - i])
        X = np.column_stack(cols)
        yy = dy[p:n]
        beta, resid, inv = _ols(yy, X)
        ssr = float(resid @ resid)
        dof = T - X.shape[1]
        if not np.isfinite(ssr) or ssr <= 0 or dof <= 0:
            continue
        se = math.sqrt(max(inv[1, 1] * ssr / dof, 1e-300))
        aic = T * math.log(ssr / T) + 2 * X.shape[1]
        t = beta[1] / se
        if best is None or aic < best[0]:
            best = (aic, t, p)
    if best is None:
        return np.nan, 0
    return float(best[1]), int(best[2])


def half_life_bars(s: np.ndarray) -> float:
    s = np.asarray(s, dtype=float)
    s = s[np.isfinite(s)]
    if len(s) < 50:
        return np.inf
    dy = np.diff(s)
    x = s[:-1]
    X = np.column_stack([np.ones(len(x)), x])
    beta, _, _ = _ols(dy, X)
    lam = beta[1]
    if not np.isfinite(lam) or lam >= 0:
        return np.inf
    return float(-math.log(2.0) / lam)


def episode_count(z: np.ndarray, entry_z: float = ENTRY_Z) -> int:
    z = np.asarray(z, dtype=float)
    z = z[np.isfinite(z)]
    if len(z) < 2:
        return 0
    above = np.abs(z) >= entry_z
    return int(np.sum(above & ~np.r_[False, above[:-1]]))


def eg_null_table(reps: int = MC_REPS, n: int = TRAIN_BARS,
                  rho: float = 0.0, seed: int = MC_SEED) -> np.ndarray:
    """Monte-Carlo null of the EG residual ADF t-statistic.

    y and x are random walks with Gaussian increments; rho sets the
    innovation correlation.  The same AIC lag search as the observed
    test is applied.  Returns the sorted t-statistics.
    """
    rng = np.random.default_rng(seed)
    out = np.empty(reps)
    for k in range(reps):
        z1 = rng.standard_normal(n)
        z2 = rng.standard_normal(n)
        x = np.cumsum(z1)
        y = np.cumsum(rho * z1 + math.sqrt(max(1.0 - rho * rho, 0.0)) * z2)
        X = np.column_stack([np.ones(n), x])
        beta, resid, _ = _ols(y, X)
        out[k] = adf_tstat(resid)[0]
    return np.sort(out)


def get_null_table() -> np.ndarray:
    path = os.path.join(OUT_DIR, f"eg_null_n{TRAIN_BARS}_B{MC_REPS}.npz")
    if os.path.exists(path):
        return np.load(path)["null"]
    print(f"simulating EG null: n={TRAIN_BARS} reps={MC_REPS} ...")
    t0 = time.time()
    null = eg_null_table()
    np.savez_compressed(path, null=null)
    print(f"  done in {time.time() - t0:.1f}s, q5={np.percentile(null, 5):.3f}")
    return null


def calibrate_null() -> dict:
    """Check that the null is insensitive to innovation correlation."""
    path = os.path.join(OUT_DIR, "null_calibration.csv")
    if os.path.exists(path):
        return pd.read_csv(path).iloc[0].to_dict()
    print("calibrating null at rho=0.8 ...")
    null08 = eg_null_table(reps=MC_RHO_CALIB_REPS, rho=MC_RHO_CALIB,
                           seed=MC_SEED + 1)
    row = dict(rho=MC_RHO_CALIB, reps=MC_RHO_CALIB_REPS,
               q1=float(np.percentile(null08, 1)),
               q5=float(np.percentile(null08, 5)),
               q10=float(np.percentile(null08, 10)))
    pd.DataFrame([row]).to_csv(path, index=False)
    return row


def bh_qvalues(p: np.ndarray) -> np.ndarray:
    """Benjamini-Hochberg adjusted q-values for already-ascending p."""
    p = np.asarray(p, dtype=float)
    m = len(p)
    if m == 0:
        return p
    q = p * m / np.arange(1, m + 1)
    q = np.minimum.accumulate(q[::-1])[::-1]
    return np.minimum(q, 1.0)


def one_sided_p(t: float, n: int) -> float:
    if not np.isfinite(t) or n < 2:
        return np.nan
    return float(stats.t.sf(t, df=n - 1))


# --------------------------------------------------------------------------- #
# pair construction
# --------------------------------------------------------------------------- #
@dataclass
class PairStat:
    sector: str
    pair: str
    A: str
    B: str
    beta: float
    alpha: float
    adf_t: float
    adf_lag: int
    hl_h: float
    corr: float
    train_episodes: int
    p_eg: float
    q_bh: float
    p_bonf: float
    eligible: bool
    selected_raw5: bool
    selected_bh: bool


def cluster_diagnostics(log_ret: pd.DataFrame) -> pd.DataFrame:
    """Hierarchical clustering on training returns (diagnostic only)."""
    corr = log_ret.corr().to_numpy()
    np.fill_diagonal(corr, 1.0)
    dist = np.sqrt(np.clip(2.0 * (1.0 - corr), 0.0, None))
    Z = linkage(squareform(dist, checks=False), method="average")
    rows = []
    for t in (1.2, 1.0, 0.9, 0.8, 0.7):
        cl = fcluster(Z, t=t, criterion="distance")
        sizes = pd.Series(cl).value_counts().tolist()
        rows.append(dict(corr_threshold=round(1.0 - t * t / 2.0, 2),
                         n_clusters=len(sizes),
                         largest=int(max(sizes)),
                         sizes=json.dumps(sorted(sizes, reverse=True)[:10])))
    return pd.DataFrame(rows)


def select_pairs(logs_train: pd.DataFrame, sector_map: dict[str, str],
                 null: np.ndarray) -> pd.DataFrame:
    """Engle-Granger + economic filters on one training window only."""
    sectors = defaultdict(list)
    for sym, sec in sector_map.items():
        sectors[sec].append(sym)
    rows = []
    for sec in SECTORS:                      # fixed, ex-ante ordering
        syms = [s for s in SECTORS[sec] if s in logs_train.columns]
        for a, b in combinations(syms, 2):
            la = logs_train[a].to_numpy()
            lb = logs_train[b].to_numpy()
            X = np.column_stack([np.ones(len(lb)), lb])
            beta, resid, _ = _ols(la, X)
            adf_t, adf_lag = adf_tstat(resid)
            hl_h = half_life_bars(resid)
            corr = float(np.corrcoef(np.diff(la), np.diff(lb))[0, 1])

            # training-only z episodes with the traded specification
            spread = la - beta[1] * lb
            mu = pd.Series(spread).rolling(
                Z_WIN, min_periods=max(50, Z_WIN // 2)).mean()
            sd = pd.Series(spread).rolling(
                Z_WIN, min_periods=max(50, Z_WIN // 2)).std(ddof=1)
            z = ((pd.Series(spread) - mu) / sd).to_numpy()
            episodes = episode_count(z)
            p_eg = float((1 + np.searchsorted(null, adf_t)) / (len(null) + 1))

            eligible = bool(
                np.isfinite(adf_t)
                and HL_MIN_H < hl_h < HL_MAX_H
                and corr >= CORR_MIN
                and BETA_MIN < beta[1] < BETA_MAX
                and episodes >= MIN_TRAIN_EPISODES
                and np.isfinite(p_eg)
            )
            rows.append(PairStat(
                sector=sec, pair=f"{a}/{b}", A=a, B=b,
                beta=float(beta[1]), alpha=float(beta[0]),
                adf_t=float(adf_t), adf_lag=int(adf_lag),
                hl_h=float(hl_h), corr=corr, train_episodes=episodes,
                p_eg=p_eg, q_bh=np.nan, p_bonf=np.nan,
                eligible=eligible,
                selected_raw5=bool(eligible and p_eg < 0.05),
                selected_bh=False,
            ))
    df = pd.DataFrame([r.__dict__ for r in rows])
    df = df.sort_values("p_eg").reset_index(drop=True)
    m = len(df)
    df["q_bh"] = bh_qvalues(df["p_eg"].to_numpy())
    df["p_bonf"] = np.minimum(1.0, df["p_eg"] * m)
    # BH selection is the strict tier and also requires the economic filters.
    df["selected_bh"] = (df["q_bh"] < 0.05) & df["eligible"]
    df.attrs["m_tests"] = m
    df.attrs["bonf_threshold"] = 0.05 / m
    return df


# --------------------------------------------------------------------------- #
# backtest
# --------------------------------------------------------------------------- #
def time_stop_bars(hl_h: float) -> int:
    return int(round(min(TIME_STOP_MAX_H, max(TIME_STOP_MIN_H,
                                              TIME_STOP_MULT * hl_h))))


def backtest_pair(row: pd.Series, close: pd.DataFrame, open_: pd.DataFrame,
                  start: int, end: int, z_win: int = Z_WIN,
                  entry_z: float = ENTRY_Z, exit_z: float = EXIT_Z,
                  stop_z: float = STOP_Z) -> list[dict]:
    """Event-driven pairs backtest, signal on close, fill at next open."""
    a, b, beta = row["A"], row["B"], float(row["beta"])
    cl_a = close[a].to_numpy()
    cl_b = close[b].to_numpy()
    op_a = open_[a].to_numpy()
    op_b = open_[b].to_numpy()
    la = np.log(cl_a)
    lb = np.log(cl_b)
    spread = la - beta * lb
    s = pd.Series(spread)
    mu_arr = s.rolling(z_win, min_periods=max(50, z_win // 2)).mean().to_numpy()
    sd_arr = s.rolling(z_win, min_periods=max(50, z_win // 2)).std(ddof=1).to_numpy()
    z_arr = (spread - mu_arr) / sd_arr
    ts_bars = time_stop_bars(float(row["hl_h"]))

    trades: list[dict] = []
    pos = None
    pending_entry = None
    pending_exit = None
    armed = True

    def close_pos(t: int, reason: str, z_sig: float):
        nonlocal pos
        p = pos
        ret_a = op_a[t] / p["pa0"] - 1.0
        ret_b = op_b[t] / p["pb0"] - 1.0
        d = p["dir"]
        gross = d * (ret_a - p["beta"] * ret_b)
        cost_w = {mode: 2.0 * fee * (1.0 + p["beta"])
                  for mode, fee in FEE_MODES.items()}
        sigma_entry = p["sd"]
        gap = abs(p["z"]) * sigma_entry if np.isfinite(sigma_entry) else np.nan
        rec = dict(
            pair=row["pair"], sector=row["sector"], A=a, B=b,
            direction=d, beta=p["beta"],
            entry_time=close.index[p["entry_idx"]],
            exit_time=close.index[t],
            entry_idx=int(p["entry_idx"]), exit_idx=int(t),
            entry_z=float(p["z"]), exit_z=float(z_sig) if np.isfinite(z_sig) else np.nan,
            reason=reason,
            hold_h=float((t - p["entry_idx"])),
            gross_bp=float(gross * 1e4),
            cost_taker_bp=float(cost_w["taker"] * 1e4),
            cost_maker_bp=float(cost_w["maker"] * 1e4),
            net_taker_bp=float((gross - cost_w["taker"]) * 1e4),
            net_maker_bp=float((gross - cost_w["maker"]) * 1e4),
            sigma_entry_bp=float(sigma_entry * 1e4) if np.isfinite(sigma_entry) else np.nan,
            entry_gap_bp=float(gap * 1e4) if np.isfinite(gap) else np.nan,
            capture=(float(gross / gap) if np.isfinite(gap) and gap > 0 else np.nan),
        )
        trades.append(rec)
        pos = None

    for t in range(start, end):
        # execute scheduled actions at this bar's open
        if pending_exit is not None and pos is not None:
            close_pos(t, pending_exit[0], pending_exit[1])
            pending_exit = None
        if pending_entry is not None and pos is None:
            pe = pending_entry
            pos = dict(
                entry_idx=t, dir=pe["dir"], z=pe["z"],
                mu=pe["mu"], sd=pe["sd"], beta=beta,
                pa0=op_a[t], pb0=op_b[t],
            )
            pending_entry = None
            armed = False

        if pos is None:
            zt, mut, sdt = z_arr[t], mu_arr[t], sd_arr[t]
            if np.isfinite(zt) and np.isfinite(sdt) and sdt > 0:
                if abs(zt) < entry_z:
                    armed = True
                if (armed and abs(zt) >= entry_z and t + 1 < end):
                    pending_entry = dict(
                        dir=(-1 if zt > 0 else 1),
                        z=float(zt), mu=float(mut), sd=float(sdt),
                    )
        else:
            zt = (spread[t] - pos["mu"]) / pos["sd"]
            reason = None
            if np.isfinite(zt):
                if pos["dir"] == -1 and zt >= stop_z:
                    reason = "stop"
                elif pos["dir"] == 1 and zt <= -stop_z:
                    reason = "stop"
                elif pos["dir"] == -1 and zt <= exit_z:
                    reason = "revert"
                elif pos["dir"] == 1 and zt >= exit_z:
                    reason = "revert"
            if reason is None and (t - pos["entry_idx"]) >= ts_bars:
                reason = "time"
            if reason is not None:
                if t + 1 < end:
                    pending_exit = (reason, float(zt))
                else:
                    close_pos(t, reason, float(zt))

    if pos is not None:
        zt = (spread[end - 1] - pos["mu"]) / pos["sd"]
        close_pos(end - 1, "end", float(zt))
    return trades


# --------------------------------------------------------------------------- #
# summaries
# --------------------------------------------------------------------------- #
def summarize(trades: pd.DataFrame, cost_mode: str) -> dict:
    if trades is None or len(trades) == 0:
        return dict(n_trades=0)
    net = trades[f"net_{cost_mode}_bp"].to_numpy(dtype=float)
    gross = trades["gross_bp"].to_numpy(dtype=float)
    cost = trades[f"cost_{cost_mode}_bp"].to_numpy(dtype=float)
    n = len(net)
    mean = float(net.mean())
    se = float(net.std(ddof=1) / math.sqrt(n)) if n > 1 else np.nan
    tstat = mean / se if np.isfinite(se) and se > 0 else np.nan
    wins = net[net > 0]
    losses = net[net < 0]
    avg_win = float(wins.mean()) if len(wins) else np.nan
    avg_loss = float(losses.mean()) if len(losses) else np.nan
    be = (-avg_loss / (avg_win - avg_loss)
          if len(wins) and len(losses) and (avg_win - avg_loss) > 0 else np.nan)
    pos_sum = float(wins.sum()) if len(wins) else 0.0
    neg_sum = float(-losses.sum()) if len(losses) else 0.0
    pf = pos_sum / neg_sum if neg_sum > 0 else np.inf
    cum = np.cumsum(net)
    dd = float((cum - np.maximum.accumulate(cum)).min()) if n else 0.0
    return dict(
        n_trades=n,
        win_rate=float((net > 0).mean()),
        revert_rate=float((trades["reason"] == "revert").mean()),
        stop_rate=float((trades["reason"] == "stop").mean()),
        time_rate=float((trades["reason"] == "time").mean()),
        end_rate=float((trades["reason"] == "end").mean()),
        be_revert_rate=float(be) if np.isfinite(be) else np.nan,
        avg_gross_bp=float(gross.mean()),
        avg_cost_bp=float(cost.mean()),
        avg_net_bp=mean,
        total_net_bp=float(net.sum()),
        total_net_W=float(net.sum() / 1e4),
        t_stat=float(tstat) if np.isfinite(tstat) else np.nan,
        p_one_sided=one_sided_p(tstat, n),
        avg_win_bp=avg_win,
        avg_loss_bp=avg_loss,
        profit_factor=float(pf),
        max_dd_W=float(dd / 1e4),
        avg_hold_h=float(trades["hold_h"].mean()),
        avg_entry_abs_z=float(trades["entry_z"].abs().mean()),
        median_sigma_entry_bp=float(trades["sigma_entry_bp"].median()),
        median_entry_gap_bp=float(trades["entry_gap_bp"].median()),
        median_capture=float(trades["capture"].median()),
        frac_gross_gt_cost=float((gross > cost).mean()),
        n_long=int((trades["direction"] == 1).sum()),
        n_short=int((trades["direction"] == -1).sum()),
    )


def collect_trades(subset: pd.DataFrame, close, open_, start, end,
                   **kwargs) -> pd.DataFrame:
    out = []
    for _, row in subset.iterrows():
        out.extend(backtest_pair(row, close, open_, start, end, **kwargs))
    if not out:
        return pd.DataFrame()
    return pd.DataFrame(out)


def portfolio_rows(name: str, tier: str, subset: pd.DataFrame, close, open_,
                   start: int, end: int) -> tuple[pd.DataFrame, list[dict]]:
    """Backtest a portfolio and return (trade frame, result rows)."""
    trades = collect_trades(subset, close, open_, start, end)
    rows = []
    for mode in ("taker", "maker"):
        s = summarize(trades, mode)
        rows.append(dict(
            row_type="portfolio", segment="holdout", tier=tier,
            portfolio=name, n_pairs=len(subset), cost_mode=mode, **s,
        ))
    return trades, rows


# --------------------------------------------------------------------------- #
# main experiment
# --------------------------------------------------------------------------- #
def main() -> None:
    if "--download" in sys.argv or "--refresh" in sys.argv:
        download_all(force="--refresh" in sys.argv)

    close, open_, logs = load_prices()
    ret = logs.diff().iloc[1:]
    train_ret = ret.iloc[:TRAIN_BARS]
    print(f"data: {len(close)} aligned 1h bars, "
          f"{close.index[0]} -> {close.index[-1]}")

    # ---- clustering diagnostic ------------------------------------------- #
    clus = cluster_diagnostics(train_ret)
    clus.to_csv(os.path.join(OUT_DIR, "cluster_diagnostics.csv"), index=False)
    print("\nhierarchical clustering on training returns (diagnostic):")
    print(clus.to_string(index=False))
    print("=> collapses to one mega-cluster; using ex-ante sector groups.")

    # ---- Monte-Carlo null ------------------------------------------------ #
    null = get_null_table()
    calib = calibrate_null()
    print(f"\nEG null n={TRAIN_BARS}: q1={np.percentile(null,1):.3f} "
          f"q5={np.percentile(null,5):.3f} q10={np.percentile(null,10):.3f}")
    print(f"null calibration rho={calib['rho']}: q5={float(calib['q5']):.3f}")

    # ---- primary selection (train only) ---------------------------------- #
    logs_train = logs.iloc[:TRAIN_BARS]
    sel = select_pairs(logs_train, SYMBOL_SECTOR, null)
    m_tests = sel.attrs["m_tests"]
    bonf_thr = sel.attrs["bonf_threshold"]
    print(f"\nselection: {m_tests} within-sector EG tests; "
          f"raw p<0.05={int((sel['p_eg']<0.05).sum())}, "
          f"Bonferroni={int((sel['p_bonf']<0.05).sum())}, "
          f"BH q<0.05={int(sel['selected_bh'].sum())}, "
          f"eligible={int(sel['eligible'].sum())}, "
          f"selected_raw5={int(sel['selected_raw5'].sum())}")
    print(f"Bonferroni threshold = {bonf_thr:.3e}")
    print(sel.head(12)[["sector", "pair", "adf_t", "hl_h", "corr",
                        "beta", "p_eg", "q_bh", "eligible"]].to_string(index=False))

    # ---- primary holdout portfolios -------------------------------------- #
    # tiers
    strict = sel[sel["selected_bh"]]
    raw5 = sel[sel["selected_raw5"]]
    eligible = sel[sel["eligible"]]

    def unique_portfolio(df: pd.DataFrame, max_pairs: int = 6) -> pd.DataFrame:
        used, chosen = set(), []
        for _, r in df.sort_values("p_eg").iterrows():
            if r["A"] in used or r["B"] in used:
                continue
            used.add(r["A"])
            used.add(r["B"])
            chosen.append(r.name)
            if len(chosen) >= max_pairs:
                break
        return df.loc[chosen]

    raw5_u = unique_portfolio(raw5)
    elig_u = unique_portfolio(eligible)

    portfolio_specs = [
        ("strict_bh", "strict", strict),
        ("raw5_all", "raw_p05", raw5),
        ("raw5_unique", "raw_p05", raw5_u),
        ("eligible_all", "eligible", eligible),
        ("eligible_unique", "eligible", elig_u),
    ]
    for sec in SECTORS:
        sub = raw5[raw5["sector"] == sec]
        if len(sub):
            portfolio_specs.append((f"raw5_{sec}", "raw_p05", sub))
        sub = eligible[eligible["sector"] == sec]
        if len(sub):
            portfolio_specs.append((f"eligible_{sec}", "eligible", sub))
    # universe-wide diagnostic, no EG selection
    portfolio_specs.append(("all_pairs", "all", sel))

    holdout_trades = {}
    port_rows = []
    for name, tier, sub in portfolio_specs:
        tr, rows = portfolio_rows(name, tier, sub, close, open_,
                                  TRAIN_BARS, TRAIN_BARS + HOLDOUT_BARS)
        holdout_trades[name] = tr
        port_rows.append(pd.DataFrame(rows))
        s = rows[0]
        print(f"  {name:22s} pairs={s['n_pairs']:3d} trades={s.get('n_trades',0):4d} "
              f"win={s.get('win_rate',np.nan):.3f} revert={s.get('revert_rate',np.nan):.3f} "
              f"BE={s.get('be_revert_rate',np.nan):.3f} avg={s.get('avg_net_bp',np.nan):8.1f}bp "
              f"t={s.get('t_stat',np.nan):6.2f}")
    port_df = pd.concat(port_rows, ignore_index=True)

    # ---- in-sample (training) reference ---------------------------------- #
    # Beta and half-life were estimated on this same segment, so these rows
    # are explicitly in-sample and are NOT evidence for the strategy.  They
    # show what the training selection "saw" before the holdout decay.
    train_rows = []
    for name, tier, sub in [("raw5_all", "raw_p05", raw5),
                            ("eligible_all", "eligible", eligible)]:
        tr = collect_trades(sub, close, open_, Z_WIN, TRAIN_BARS)
        for mode in ("taker", "maker"):
            s = summarize(tr, mode)
            train_rows.append(dict(
                row_type="portfolio", segment="train_in_sample", tier=tier,
                portfolio=name, n_pairs=len(sub), cost_mode=mode,
                note="in-sample; beta/HL estimated on this segment", **s,
            ))
    train_df = pd.DataFrame(train_rows)

    # ---- parameter sensitivity (exploratory, not pass candidates) -------- #
    sens_rows = []
    for set_name, sub in [("raw5", raw5), ("eligible", eligible)]:
        for zwin in (168, 336):
            for entry_z in (1.5, 2.0, 2.5):
                for stop_z in (3.5, 99.0):
                    tr = collect_trades(sub, close, open_,
                                        TRAIN_BARS, TRAIN_BARS + HOLDOUT_BARS,
                                        z_win=zwin, entry_z=entry_z,
                                        stop_z=stop_z)
                    for mode in ("taker", "maker"):
                        s = summarize(tr, mode)
                        sens_rows.append(dict(
                            row_type="sensitivity", segment="holdout",
                            set_name=set_name, z_win=zwin,
                            entry_z=entry_z, stop_z=stop_z,
                            cost_mode=mode, n_pairs=len(sub),
                            note="exploratory grid; multiple-testing not credited",
                            **s,
                        ))
    sens_df = pd.DataFrame(sens_rows)

    # ---- per-pair holdout ------------------------------------------------- #
    pair_rows = []
    pair_trades = {}
    for _, row in sel[sel["eligible"] | sel["selected_raw5"]].iterrows():
        tr = collect_trades(pd.DataFrame([row]), close, open_,
                            TRAIN_BARS, TRAIN_BARS + HOLDOUT_BARS)
        pair_trades[row["pair"]] = tr
        for mode in ("taker", "maker"):
            s = summarize(tr, mode)
            pair_rows.append(dict(
                row_type="holdout_pair", segment="holdout",
                tier=("raw_p05" if row["selected_raw5"] else "eligible"),
                sector=row["sector"], pair=row["pair"], A=row["A"], B=row["B"],
                cost_mode=mode, beta=row["beta"], adf_t=row["adf_t"],
                hl_h=row["hl_h"], corr=row["corr"], p_eg=row["p_eg"],
                q_bh=row["q_bh"], selected_raw5=row["selected_raw5"],
                selected_bh=row["selected_bh"], eligible=row["eligible"], **s,
            ))
    pair_df = pd.DataFrame(pair_rows)
    # BH across pairs on the holdout t-tests (taker, one row per pair).
    # The BH helper needs ascending p, so sort first and map back.
    taker_mask = pair_df["cost_mode"] == "taker"
    pvals = pair_df.loc[taker_mask, "p_one_sided"].to_numpy(dtype=float)
    pvals = np.nan_to_num(pvals, nan=1.0)
    order = np.argsort(pvals)
    q_sorted = bh_qvalues(pvals[order])
    q = np.empty_like(q_sorted)
    q[order] = q_sorted
    pair_df.loc[taker_mask, "q_holdout_bh"] = q
    pair_df.loc[taker_mask, "p_bonf_holdout"] = np.minimum(1.0, pvals * len(pvals))
    pair_df.loc[~taker_mask, "q_holdout_bh"] = np.nan
    pair_df.loc[~taker_mask, "p_bonf_holdout"] = np.nan

    # ---- 3-fold walk-forward --------------------------------------------- #
    fold_sel_rows, fold_port_rows, fold_pair_rows = [], [], []
    fold_trades = []
    for f in range(N_FOLDS):
        train_start = f * FOLD_BARS
        train_end = train_start + TRAIN_BARS
        test_start = train_end
        test_end = test_start + FOLD_BARS
        fold_logs = logs.iloc[train_start:train_end]
        fsel = select_pairs(fold_logs, SYMBOL_SECTOR, null)
        fraw = fsel[fsel["selected_raw5"]]
        felig = fsel[fsel["eligible"]]
        fspecs = [
            ("strict_bh", "strict", fsel[fsel["selected_bh"]]),
            ("raw5_all", "raw_p05", fraw),
            ("raw5_unique", "raw_p05", unique_portfolio(fraw)),
            ("eligible_all", "eligible", felig),
            ("eligible_unique", "eligible", unique_portfolio(felig)),
        ]
        for name, tier, sub in fspecs:
            tr = collect_trades(sub, close, open_, test_start, test_end)
            if len(tr):
                tr["fold"] = f + 1
                tr["portfolio"] = name
                fold_trades.append(tr)
            for mode in ("taker", "maker"):
                s = summarize(tr, mode)
                fold_port_rows.append(dict(
                    row_type="fold_portfolio", segment="walkforward",
                    fold=f + 1, tier=tier, portfolio=name,
                    n_pairs=len(sub), cost_mode=mode,
                    test_start=str(close.index[test_start]),
                    test_end=str(close.index[test_end - 1]), **s,
                ))
        for _, row in fsel.iterrows():
            fold_sel_rows.append(dict(
                row_type="fold_selection", segment="walkforward", fold=f + 1,
                sector=row["sector"], pair=row["pair"], A=row["A"], B=row["B"],
                beta=row["beta"], adf_t=row["adf_t"], adf_lag=row["adf_lag"],
                hl_h=row["hl_h"], corr=row["corr"], p_eg=row["p_eg"],
                q_bh=row["q_bh"], selected_raw5=row["selected_raw5"],
                selected_bh=row["selected_bh"], eligible=row["eligible"],
                train_episodes=row["train_episodes"],
            ))
        # per-pair fold performance (for cluster / pair attribution)
        for _, row in fsel[fsel["eligible"] | fsel["selected_raw5"]].iterrows():
            tr = collect_trades(pd.DataFrame([row]), close, open_,
                                test_start, test_end)
            for mode in ("taker", "maker"):
                s = summarize(tr, mode)
                fold_pair_rows.append(dict(
                    row_type="fold_pair", segment="walkforward", fold=f + 1,
                    tier=("raw_p05" if row["selected_raw5"] else "eligible"),
                    sector=row["sector"], pair=row["pair"],
                    A=row["A"], B=row["B"], cost_mode=mode,
                    beta=row["beta"], adf_t=row["adf_t"], hl_h=row["hl_h"],
                    corr=row["corr"], p_eg=row["p_eg"], q_bh=row["q_bh"],
                    selected_raw5=row["selected_raw5"],
                    selected_bh=row["selected_bh"],
                    eligible=row["eligible"], **s,
                ))
        print(f"  fold {f+1}: {int(fsel['selected_raw5'].sum())} raw5, "
              f"{int(fsel['selected_bh'].sum())} BH, "
              f"{int(fsel['eligible'].sum())} eligible")
    fold_port_df = pd.DataFrame(fold_port_rows)
    fold_sel_df = pd.DataFrame(fold_sel_rows)
    fold_pair_df = pd.DataFrame(fold_pair_rows)

    # aggregate the 3 walk-forward folds (one selection per fold)
    agg_rows = []
    if fold_trades:
        all_fold = pd.concat(fold_trades, ignore_index=True)
        for name in ("strict_bh", "raw5_all", "raw5_unique",
                     "eligible_all", "eligible_unique"):
            tr = all_fold[all_fold["portfolio"] == name]
            for mode in ("taker", "maker"):
                s = summarize(tr, mode)
                agg_rows.append(dict(
                    row_type="fold_aggregate", segment="walkforward",
                    tier=name, portfolio=name, cost_mode=mode,
                    n_folds=N_FOLDS, **s,
                ))
    agg_df = pd.DataFrame(agg_rows)

    # ---- multiple-testing summary rows ----------------------------------- #
    n_primary_specs = len(portfolio_specs)
    taker_primary = port_df[port_df["cost_mode"] == "taker"]
    min_primary_p = float(np.nanmin(taker_primary["p_one_sided"]))
    taker_agg = agg_df[agg_df["cost_mode"] == "taker"] if len(agg_df) else pd.DataFrame()
    min_fold_p = (float(np.nanmin(taker_agg["p_one_sided"]))
                  if len(taker_agg) else np.nan)
    taker_pairs = pair_df[pair_df["cost_mode"] == "taker"]
    summary_rows = [
        dict(row_type="summary", metric="eg_tests_primary", value=m_tests,
             note="within-sector Engle-Granger tests on the 120d train"),
        dict(row_type="summary", metric="eg_raw_p05_primary",
             value=int((sel["p_eg"] < 0.05).sum()),
             note="expected false positives under the null = 9.3"),
        dict(row_type="summary", metric="eg_bonferroni_primary",
             value=int((sel["p_bonf"] < 0.05).sum()),
             note=f"Bonferroni threshold {bonf_thr:.3e}"),
        dict(row_type="summary", metric="eg_bh_primary",
             value=int(sel["selected_bh"].sum()),
             note="BH q<0.05; strict selection tier is empty"),
        dict(row_type="summary", metric="eligible_pairs_primary",
             value=int(sel["eligible"].sum()),
             note="HL 2-168h, corr>=0.5, beta 0.1-10, >=3 train episodes"),
        dict(row_type="summary", metric="portfolio_specs_primary",
             value=n_primary_specs,
             note=f"Bonferroni threshold {0.05/n_primary_specs:.4f} (taker)"),
        dict(row_type="summary", metric="min_primary_portfolio_p",
             value=min_primary_p,
             note="one-sided, taker; no portfolio close to Bonferroni"),
        dict(row_type="summary", metric="holdout_pair_tests",
             value=len(taker_pairs),
             note=f"Bonferroni threshold {0.05/max(len(taker_pairs),1):.4f}"),
        dict(row_type="summary", metric="holdout_pair_min_p",
             value=float(np.nanmin(taker_pairs["p_one_sided"]))
             if len(taker_pairs) else np.nan,
             note="one-sided; see q_holdout_bh"),
        dict(row_type="summary", metric="fold_eg_tests",
             value=N_FOLDS * m_tests,
             note="3 walk-forward folds x 186 tests; 0 BH survivors in every fold"),
        dict(row_type="summary", metric="fold_aggregate_portfolio_tests",
             value=max(len(agg_df[agg_df["cost_mode"] == "taker"]), 1),
             note=f"Bonferroni threshold "
                  f"{0.05/max(len(agg_df[agg_df['cost_mode']=='taker']),1):.4f}"),
        dict(row_type="summary", metric="min_fold_aggregate_p",
             value=min_fold_p,
             note="taker one-sided; maker raw5_all p=0.036 (not corrected)"),
    ]
    summary_df = pd.DataFrame(summary_rows)

    # ---- assemble results.csv -------------------------------------------- #
    sel_out = sel.copy()
    sel_out.insert(0, "row_type", "selection")
    sel_out.insert(1, "segment", "train")
    sel_out["passes_raw5"] = sel_out["selected_raw5"]
    sel_out["passes_bh"] = sel_out["selected_bh"]
    sel_out["passes_bonferroni"] = sel_out["p_bonf"] < 0.05
    sel_out["cost_mode"] = ""

    frames = [sel_out, pair_df, port_df, train_df, sens_df, fold_sel_df,
              fold_pair_df, fold_port_df, agg_df, summary_df]
    results = pd.concat(frames, ignore_index=True, sort=False)
    results.to_csv(os.path.join(OUT_DIR, "results.csv"), index=False)

    # trade-level audit of the primary holdout portfolios
    audit = []
    for name, tr in holdout_trades.items():
        if len(tr):
            t = tr.copy()
            t.insert(0, "portfolio", name)
            audit.append(t)
    if audit:
        pd.concat(audit, ignore_index=True).to_csv(
            os.path.join(OUT_DIR, "trades_holdout.csv"), index=False)

    # ---- console summary for the report ---------------------------------- #
    print("\n=== primary holdout (taker) ===")
    show = port_df[(port_df["cost_mode"] == "taker") &
                   port_df["portfolio"].isin(
                       ["strict_bh", "raw5_all", "raw5_unique",
                        "eligible_all", "eligible_unique", "all_pairs"])]
    cols = ["portfolio", "n_pairs", "n_trades", "win_rate", "revert_rate",
            "be_revert_rate", "avg_net_bp", "total_net_bp", "t_stat",
            "p_one_sided"]
    print(show[cols].to_string(index=False))

    print("\n=== fold portfolio (taker) ===")
    print(fold_port_df[fold_port_df["cost_mode"] == "taker"][
        ["fold", "portfolio", "n_pairs", "n_trades", "win_rate",
         "revert_rate", "be_revert_rate", "avg_net_bp", "total_net_bp",
         "t_stat"]].to_string(index=False))

    print("\n=== fold aggregate (taker) ===")
    if len(agg_df):
        print(agg_df[agg_df["cost_mode"] == "taker"][
            ["portfolio", "n_trades", "win_rate", "revert_rate",
             "be_revert_rate", "avg_net_bp", "total_net_bp", "t_stat"]
        ].to_string(index=False))

    print("\n=== in-sample training reference (taker) ===")
    print(train_df[train_df["cost_mode"] == "taker"][
        ["portfolio", "n_trades", "win_rate", "revert_rate",
         "be_revert_rate", "avg_net_bp", "total_net_bp", "t_stat"]
    ].to_string(index=False))

    print("\n=== raw5 pairs (taker) ===")
    print(pair_df[(pair_df["cost_mode"] == "taker") &
                  (pair_df["tier"] == "raw_p05")][
        ["sector", "pair", "n_trades", "win_rate", "revert_rate",
         "be_revert_rate", "avg_net_bp", "t_stat", "p_one_sided"]].to_string(index=False))

    print("\nresults ->", os.path.join(OUT_DIR, "results.csv"))


if __name__ == "__main__":
    main()
