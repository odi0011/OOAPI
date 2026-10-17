#!/usr/bin/env python
"""Walk-forward validation of the OOAPI trend signal.

Signal source of truth (read-only):
  ooapi-server/internal/trading/signals.go
  ooapi-server/internal/trading/ema.go
  ooapi-server/internal/trading/config.go
  ooapi-server/internal/trading/backtest.go
  ooapi-server/internal/trading/risk.go

Replicated signal
-----------------
  EMA(fast)/EMA(slow) direction, with a minimum gap of 0.05% of price.
  Trend score (max 4): EMA direction + RSI(14) in band + volume above prior
  20-bar average + 15m EMA agreement.  entryMode=trend enters when score >=
  minScore.  entryMode=cross enters only on the EMA golden/death cross bar
  (RSI/volume/15m/minScore are inert in cross mode, exactly as in entrySide).
  Reverse exit is always the opposite EMA cross.

Execution (deliberately stricter than the in-repo close-only Backtest)
----------------------------------------------------------------------
  signal confirmed at bar close -> entry at NEXT bar open
  stop/take are intrabar high/low triggers; if both touch in one bar, stop wins
  reverse cross -> exit at next bar open
  taker 0.05% per side + slippage 0.02% per side (entry and exit)
  one position per market; flat at every walk-forward window boundary
  no future data used for signal generation or parameter selection

Walk-forward
------------
  180 days, 45-day train / 15-day test, step 15 days => 9 folds.
  Primary protocol = first 5 folds (test days 45-120); the remaining 4 folds
  are reported as an extended check.  Selection uses only trades opened in the
  training window and force-closes any open trade at the training boundary.
  Test windows are never used by the selector.

Outputs (all under research/trend/):
  results.csv               all 1152 grid rows x folds (train + test stats)
  selected_walkforward.csv  one row per market/fold selection + aggregates
  market_summary.csv        aggregate primary/extended result per market
  null_test.json            permutation test and train/test rank diagnostics
  report.md                 methodology, tables, conclusion, risks

Run:
  python research/trend/backtest.py
  python research/trend/backtest.py --quick        # BTC 5m, 2 folds
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd
from scipy.signal import lfilter
from scipy.stats import spearmanr

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA_DIR = os.path.join(ROOT, "research", "data", "klines")
OUT_DIR = HERE

# KORUUSDT is deliberately excluded from the scan universe.  Its raw klines
# contain a 21.2x contract adjustment on 2026-07-15 (zero-volume halt
# 00:20-09:35 UTC; last close 481.11 -> resumption open 22.68), which is a fake
# -95% jump for any price-based indicator.  It also has only ~117 days of
# history, so it cannot support the 5-fold protocol.
SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "LINKUSDT",
]
EXCLUDED_SYMBOLS = ["KORUUSDT"]
TIMEFRAMES = ["5m", "15m", "1h"]
TF_MS = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000}
DAY_MS = 86_400_000
HIGHER_TF_MS = TF_MS["15m"]

EMA_PAIRS = [(5, 13), (9, 21), (12, 26), (20, 50)]
R_FRACTIONS = [0.004, 0.008, 0.012]
TAKE_PROFITS = [1.0, 1.5, 2.0, 3.0]
MIN_SCORES = [2, 3, 4]
# The four RSI bands used by ooapi-server/cmd/trendsweep.
RSI_BANDS = [
    (50.0, 70.0, 30.0, 50.0),
    (45.0, 65.0, 35.0, 55.0),
    (55.0, 75.0, 25.0, 45.0),
    (40.0, 80.0, 20.0, 60.0),
]
RSI_BAND_LABELS = [
    "50-70/30-50", "45-65/35-55", "55-75/25-45", "40-80/20-60",
]
ENTRY_MODES = ["cross", "trend"]

RSI_PERIOD = 14
VOLUME_LOOKBACK = 20
TREND_GAP_FRACTION = 0.0005
STOP_R = 1.0
TAKER_FEE = 0.0005
SLIPPAGE = 0.0002
ONE_WAY_COST = TAKER_FEE + SLIPPAGE

TRAIN_DAYS = 45
TEST_DAYS = 15
STEP_DAYS = 15
N_FOLDS = 9
PRIMARY_FOLDS = 5
MIN_TRAIN_TRADES = 20
MIN_TEST_TRADES = 30
LIVE_MIN_WIN_RATE = 0.38

# ---------------------------------------------------------------------------
# Basic indicators
# ---------------------------------------------------------------------------


def ema(values: np.ndarray, period: int) -> np.ndarray:
    """SMA-seeded EMA, identical to trading.EMA (out[period-1] is the seed)."""
    n = values.size
    out = np.full(n, np.nan, dtype=np.float64)
    if n < period:
        return out
    seed = float(values[:period].mean())
    out[period - 1] = seed
    k = 2.0 / (period + 1.0)
    # y[t] = k*x[t] + (1-k)*y[t-1], with y[-1] = seed
    y, _ = lfilter([k], [1.0, -(1.0 - k)], values[period:],
                   zi=[(1.0 - k) * seed])
    out[period:] = y
    return out


def rsi_wilder(closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder RSI, matching trading.LastRSI exactly (SMA seed, then smoothing)."""
    n = closes.size
    out = np.full(n, np.nan, dtype=np.float64)
    if n < period + 1:
        return out
    delta = np.diff(closes)
    gains = np.maximum(delta, 0.0)
    losses = np.maximum(-delta, 0.0)
    avg_gain = float(gains[:period].mean())
    avg_loss = float(losses[:period].mean())

    def value(g: float, l: float) -> float:
        if l == 0.0:
            return 50.0 if g == 0.0 else 100.0
        rs = g / l
        return 100.0 - 100.0 / (1.0 + rs)

    out[period] = value(avg_gain, avg_loss)
    alpha = 1.0 - 1.0 / period
    beta = 1.0 / period
    for i in range(period + 1, n):
        avg_gain = alpha * avg_gain + beta * gains[i - 1]
        avg_loss = alpha * avg_loss + beta * losses[i - 1]
        out[i] = value(avg_gain, avg_loss)
    return out


def volume_above(volume: np.ndarray, lookback: int = 20) -> np.ndarray:
    """last volume > mean of the previous `lookback` volumes (current excluded)."""
    n = volume.size
    flag = np.zeros(n, dtype=bool)
    if n <= lookback:
        return flag
    csum = np.concatenate(([0.0], np.cumsum(volume, dtype=np.float64)))
    # i = lookback .. n-1 ; sum(volume[i-lookback:i]) = csum[i]-csum[i-lookback]
    prev_sum = csum[lookback:n] - csum[: n - lookback]
    avg = prev_sum / float(lookback)
    flag[lookback:] = avg > 0.0
    flag[lookback:] &= volume[lookback:] > avg
    return flag


def next_equal_index(cross_side: np.ndarray, value: int) -> np.ndarray:
    """For every bar i, first j >= i with cross_side[j] == value (n if none)."""
    n = cross_side.size
    out = np.full(n, n, dtype=np.int32)
    nxt = n
    for i in range(n - 1, -1, -1):
        if cross_side[i] == value:
            nxt = i
        out[i] = nxt
    return out


# ---------------------------------------------------------------------------
# First-passage queries: first j >= start with arr[j] >= threshold.
# A next-greater chain + binary lifting gives O(log n) per batched query.
# ---------------------------------------------------------------------------


def build_chain(arr: np.ndarray):
    n = arr.size
    nxt = np.full(n + 1, n, dtype=np.int32)
    stack: list[int] = []
    for i in range(n):
        ai = arr[i]
        while stack and arr[stack[-1]] < ai:  # strict greater
            nxt[stack.pop()] = i
        stack.append(i)
    k = max(1, int(math.ceil(math.log2(max(n, 2)))) + 1)
    up = np.empty((k, n + 1), dtype=np.int32)
    mx = np.empty((k, n + 1), dtype=np.float64)
    up[0] = nxt
    clipped = np.minimum(nxt[:n], max(n - 1, 0))
    mx[0, :n] = np.where(nxt[:n] < n, arr[clipped], -np.inf)
    mx[0, n] = -np.inf
    for level in range(1, k):
        prev = up[level - 1]
        up[level] = prev[prev]
        pm = mx[level - 1]
        mx[level] = np.maximum(pm, pm[prev])
    return up, mx


def first_hit_ge(up: np.ndarray, mx: np.ndarray, arr: np.ndarray,
                 starts: np.ndarray, thresholds: np.ndarray, n: int) -> np.ndarray:
    """First j >= starts[q] with arr[j] >= thresholds[q]; n if none."""
    starts = np.asarray(starts, dtype=np.int32)
    thresholds = np.asarray(thresholds, dtype=np.float64)
    start_ok = starts < n
    cur = np.minimum(starts, max(n - 1, 0))
    immediate = start_ok & (arr[cur] >= thresholds)
    active = start_ok & (~immediate)
    k = up.shape[0]
    for level in range(k - 1, -1, -1):
        nxt = up[level][cur]
        m = mx[level][cur]
        jump = active & (nxt < n) & (m < thresholds)
        if jump.any():
            cur[jump] = nxt[jump]
    ans = up[0][cur]
    ans_clip = np.minimum(ans, max(n - 1, 0))
    ok = active & (ans < n) & (arr[ans_clip] >= thresholds)
    out = np.where(immediate, starts, np.where(ok, ans, n))
    return out.astype(np.int32)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class PairArrays:
    fast: np.ndarray
    slow: np.ndarray
    diff: np.ndarray
    cross_side: np.ndarray      # +1 golden, -1 death, 0 none (int8)
    next_death: np.ndarray      # int32
    next_golden: np.ndarray     # int32


@dataclass
class Variant:
    entry_mode: str
    pair_idx: int
    band_idx: int               # -1 for cross
    min_score: int              # -1 for cross
    side: np.ndarray            # int8, +1 long / -1 short / 0 none
    sig_bars: np.ndarray        # int32 sorted


@dataclass
class Market:
    symbol: str
    tf: str
    n: int
    open_time: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    quote_volume: np.ndarray
    tf_ms: int
    anchor: int
    pairs: list[PairArrays] = field(default_factory=list)
    rsi: np.ndarray = field(default_factory=lambda: np.array([]))
    vol_flag: np.ndarray = field(default_factory=lambda: np.array([], dtype=bool))
    htf_dir: list[np.ndarray] = field(default_factory=list)
    sl_long: list[np.ndarray] = field(default_factory=list)
    tp_long: list[np.ndarray] = field(default_factory=list)
    sl_short: list[np.ndarray] = field(default_factory=list)
    tp_short: list[np.ndarray] = field(default_factory=list)
    variants: list[Variant] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Loading / signal construction
# ---------------------------------------------------------------------------


def load_klines(symbol: str, tf: str) -> pd.DataFrame:
    path = os.path.join(DATA_DIR, f"{symbol}_{tf}.csv")
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    df = pd.read_csv(path)
    required = ["open_time", "open", "high", "low", "close", "volume",
                "quote_volume", "trades"]
    for col in required:
        if col not in df.columns:
            raise ValueError(f"{path}: missing column {col}")
    df = df.sort_values("open_time").drop_duplicates("open_time")
    df = df[(df[["open", "high", "low", "close"]] > 0).all(axis=1)]
    if df.empty:
        raise ValueError(f"{path}: no usable rows")
    df = df.reset_index(drop=True)
    for col in required:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=required).reset_index(drop=True)
    return df


def make_pair(closes: np.ndarray, fast_p: int, slow_p: int) -> PairArrays:
    fast = ema(closes, fast_p)
    slow = ema(closes, slow_p)
    diff = fast - slow
    n = closes.size
    golden = np.zeros(n, dtype=bool)
    death = np.zeros(n, dtype=bool)
    valid = np.isfinite(diff)
    both = valid[1:] & valid[:-1]
    golden[1:] = both & (diff[:-1] <= 0.0) & (diff[1:] > 0.0)
    death[1:] = both & (diff[:-1] >= 0.0) & (diff[1:] < 0.0)
    side = np.zeros(n, dtype=np.int8)
    side[golden] = 1
    side[death] = -1
    return PairArrays(
        fast=fast, slow=slow, diff=diff, cross_side=side,
        next_death=next_equal_index(side, -1),
        next_golden=next_equal_index(side, 1),
    )


def htf_direction(higher: pd.DataFrame, bar_open_time: np.ndarray,
                  tf_ms: int, fast_p: int, slow_p: int) -> np.ndarray:
    """15m EMA direction of the last 15m bar closed at each strategy bar close."""
    h_open = higher["open_time"].to_numpy(dtype=np.int64)
    h_close = higher["close"].to_numpy(dtype=np.float64)
    hf = ema(h_close, fast_p)
    hs = ema(h_close, slow_p)
    hdiff = hf - hs
    cutoff = bar_open_time + tf_ms - HIGHER_TF_MS
    idx = np.searchsorted(h_open, cutoff, side="right") - 1
    n_h = h_open.size
    idx_clip = np.clip(idx, 0, n_h - 1)
    ok = idx >= 0
    ok &= np.isfinite(hdiff[idx_clip])
    out = np.zeros(bar_open_time.size, dtype=np.int8)
    out[ok] = np.sign(hdiff[idx_clip[ok]]).astype(np.int8)
    return out


def build_exit_events(m: Market) -> None:
    """Precompute first SL/TP bar for a hypothetical entry at every bar.

    The event depends only on direction, rFraction, TP multiple and the
    entry-bar open (with entry slippage), not on which signal selected it.
    This is why the full 52 variants x 12 exit configs can share it.
    """
    n = m.n
    up_hi, mx_hi = build_chain(m.high)
    up_nl, mx_nl = build_chain(-m.low)
    starts = np.arange(n, dtype=np.int32)
    tps = np.asarray(TAKE_PROFITS, dtype=np.float64)

    for r in R_FRACTIONS:
        fill_long = m.open * (1.0 + SLIPPAGE)
        stop_long = fill_long * (1.0 - r)
        sl_l = first_hit_ge(up_nl, mx_nl, -m.low, starts, -stop_long, n)

        takes_l = fill_long[:, None] * (1.0 + tps[None, :] * r)
        tp_l = first_hit_ge(
            up_hi, mx_hi, m.high,
            np.repeat(starts, tps.size), takes_l.ravel(), n,
        ).reshape(n, tps.size)

        fill_short = m.open * (1.0 - SLIPPAGE)
        stop_short = fill_short * (1.0 + r)
        sl_s = first_hit_ge(up_hi, mx_hi, m.high, starts, stop_short, n)

        takes_s = fill_short[:, None] * (1.0 - tps[None, :] * r)
        tp_s = first_hit_ge(
            up_nl, mx_nl, -m.low,
            np.repeat(starts, tps.size), (-takes_s).ravel(), n,
        ).reshape(n, tps.size)

        m.sl_long.append(sl_l)
        m.tp_long.append(tp_l)
        m.sl_short.append(sl_s)
        m.tp_short.append(tp_s)


def build_variants(m: Market) -> None:
    variants: list[Variant] = []
    # cross mode: one variant per EMA pair, independent of RSI band / minScore
    for pi, pair in enumerate(m.pairs):
        variants.append(Variant("cross", pi, -1, -1, pair.cross_side,
                                np.flatnonzero(pair.cross_side != 0).astype(np.int32)))
    # trend mode: 4 EMA pairs x 4 RSI bands x 3 minScores
    gap = TREND_GAP_FRACTION * m.close
    for pi, pair in enumerate(m.pairs):
        valid = np.isfinite(pair.diff)
        long_base = valid & (pair.diff >= gap)
        short_base = valid & (-pair.diff >= gap)
        htf = m.htf_dir[pi]
        for bi, (lmin, lmax, smin, smax) in enumerate(RSI_BANDS):
            rsi_long = np.isfinite(m.rsi) & (m.rsi >= lmin) & (m.rsi <= lmax)
            rsi_short = np.isfinite(m.rsi) & (m.rsi >= smin) & (m.rsi <= smax)
            score_long = (1 + rsi_long.astype(np.int8)
                          + m.vol_flag.astype(np.int8) + (htf == 1).astype(np.int8))
            score_short = (1 + rsi_short.astype(np.int8)
                           + m.vol_flag.astype(np.int8) + (htf == -1).astype(np.int8))
            for ms in MIN_SCORES:
                side = np.zeros(m.n, dtype=np.int8)
                side[long_base & (score_long >= ms)] = 1
                side[short_base & (score_short >= ms)] = -1
                variants.append(Variant("trend", pi, bi, ms, side,
                                        np.flatnonzero(side != 0).astype(np.int32)))
    m.variants = variants


def build_market(symbol: str, tf: str) -> Market:
    df = load_klines(symbol, tf)
    higher = load_klines(symbol, "15m")
    tf_ms = TF_MS[tf]
    open_time = df["open_time"].to_numpy(dtype=np.int64)
    m = Market(
        symbol=symbol, tf=tf, n=len(df), open_time=open_time,
        open=df["open"].to_numpy(dtype=np.float64),
        high=df["high"].to_numpy(dtype=np.float64),
        low=df["low"].to_numpy(dtype=np.float64),
        close=df["close"].to_numpy(dtype=np.float64),
        volume=df["volume"].to_numpy(dtype=np.float64),
        quote_volume=df["quote_volume"].to_numpy(dtype=np.float64),
        tf_ms=tf_ms, anchor=int(open_time[0]),
    )
    m.pairs = [make_pair(m.close, ef, es) for ef, es in EMA_PAIRS]
    m.rsi = rsi_wilder(m.close, RSI_PERIOD)
    m.vol_flag = volume_above(m.volume, VOLUME_LOOKBACK)
    m.htf_dir = [htf_direction(higher, m.open_time, tf_ms, ef, es)
                 for ef, es in EMA_PAIRS]
    build_exit_events(m)
    build_variants(m)
    return m


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------


def simulate(m: Market, v: Variant, ri: int, ti: int,
             start_idx: int, end_idx: int, detail: bool = False):
    """Simulate one market/variant/exit config on [start_idx, end_idx).

    Returns aggregate stats and, if detail, the trade list.
    """
    sig_bars = v.sig_bars
    nsig = sig_bars.size
    if nsig == 0 or end_idx <= start_idx:
        return (0, 0, 0.0, 0.0, 0.0, 0.0, 0, []) if detail else \
               (0, 0, 0.0, 0.0, 0.0, 0.0, 0)

    side_arr = v.side
    open_ = m.open
    close_ = m.close
    n = m.n
    sl_l = m.sl_long[ri]
    tp_l = m.tp_long[ri]
    sl_s = m.sl_short[ri]
    tp_s = m.tp_short[ri]
    pair = m.pairs[v.pair_idx]
    next_death = pair.next_death
    next_golden = pair.next_golden
    tp_mult = TAKE_PROFITS[ti]
    r = R_FRACTIONS[ri]
    force_bar = end_idx - 1

    trades = 0
    wins = 0
    net_r = 0.0
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    gross_win = 0.0
    gross_loss = 0.0
    sum_hold = 0
    details: list[tuple] = [] if detail else None

    pos = int(np.searchsorted(sig_bars, start_idx, side="left"))
    while pos < nsig:
        s = int(sig_bars[pos])
        e = s + 1
        if e >= end_idx:
            break
        side = int(side_arr[s])
        if side > 0:
            sl = int(sl_l[e])
            tp = int(tp_l[e, ti])
            rev_sig = int(next_death[e])
        else:
            sl = int(sl_s[e])
            tp = int(tp_s[e, ti])
            rev_sig = int(next_golden[e])

        # Reverse cross at bar j exits at j+1 open.  If SL/TP trigger on the
        # reverse-signal bar itself, they happen before that close and win.
        # If SL/TP trigger on the exit bar, the open exit has already happened.
        rev_exec = rev_sig + 1 if rev_sig < n - 1 else n
        if rev_exec < n:
            if sl < rev_exec and sl <= tp:
                exit_bar, reason = sl, "stop"
            elif tp < rev_exec:
                exit_bar, reason = tp, "tp"
            else:
                exit_bar, reason = rev_exec, "reverse"
        else:
            if sl <= tp and sl < n:
                exit_bar, reason = sl, "stop"
            elif tp < n:
                exit_bar, reason = tp, "tp"
            else:
                exit_bar, reason = n, "none"

        if exit_bar > force_bar:
            exit_bar, reason = force_bar, "force"

        o = open_[e]
        if side > 0:
            entry = o * (1.0 + SLIPPAGE)
            if reason == "stop":
                level = entry * (1.0 - r)
                raw = min(open_[exit_bar], level)
            elif reason == "tp":
                raw = entry * (1.0 + tp_mult * r)
            elif reason == "reverse":
                raw = open_[exit_bar]
            else:
                raw = close_[exit_bar]
            exit_px = raw * (1.0 - SLIPPAGE)
            gross = exit_px - entry
        else:
            entry = o * (1.0 - SLIPPAGE)
            if reason == "stop":
                level = entry * (1.0 + r)
                raw = max(open_[exit_bar], level)
            elif reason == "tp":
                raw = entry * (1.0 - tp_mult * r)
            elif reason == "reverse":
                raw = open_[exit_bar]
            else:
                raw = close_[exit_bar]
            exit_px = raw * (1.0 + SLIPPAGE)
            gross = entry - exit_px

        fees = TAKER_FEE * (entry + exit_px)
        net = gross - fees
        one_r = entry * r * STOP_R
        r_mult = net / one_r if one_r > 0 else 0.0

        trades += 1
        sum_hold += exit_bar - e + 1
        if r_mult > 0:
            wins += 1
            gross_win += r_mult
        else:
            gross_loss += r_mult
        net_r += r_mult
        cum += r_mult
        if cum > peak:
            peak = cum
        dd = peak - cum
        if dd > max_dd:
            max_dd = dd
        if detail:
            details.append((
                int(m.open_time[e]), int(m.open_time[exit_bar]), side, reason,
                float(r_mult), float(entry), float(exit_px), int(exit_bar - e + 1),
            ))

        pos = int(np.searchsorted(sig_bars, exit_bar, side="left"))

    if detail:
        return (trades, wins, net_r, max_dd, gross_win, gross_loss, sum_hold,
                details)
    return (trades, wins, net_r, max_dd, gross_win, gross_loss, sum_hold)


# ---------------------------------------------------------------------------
# Grid mapping
# ---------------------------------------------------------------------------


@dataclass
class GridRow:
    symbol: str
    timeframe: str
    entry_mode: str
    ema_fast: int
    ema_slow: int
    rsi_band: str
    rsi_long_min: float
    rsi_long_max: float
    rsi_short_min: float
    rsi_short_max: float
    min_score: int
    r_fraction: float
    tp_r: float
    variant_idx: int
    r_idx: int
    tp_idx: int


def make_grid(symbol: str, tf: str) -> list[GridRow]:
    # unique variant ordering must match build_variants
    keys: list[tuple] = []
    for pi in range(len(EMA_PAIRS)):
        keys.append(("cross", pi, -1, -1))
    for pi in range(len(EMA_PAIRS)):
        for bi in range(len(RSI_BANDS)):
            for ms in MIN_SCORES:
                keys.append(("trend", pi, bi, ms))
    vindex = {k: i for i, k in enumerate(keys)}

    rows: list[GridRow] = []
    for mode in ENTRY_MODES:
        for pi, (ef, es) in enumerate(EMA_PAIRS):
            for bi, band in enumerate(RSI_BANDS):
                for ms in MIN_SCORES:
                    for ri, r in enumerate(R_FRACTIONS):
                        for ti, tp in enumerate(TAKE_PROFITS):
                            key = (("cross", pi, -1, -1) if mode == "cross"
                                   else ("trend", pi, bi, ms))
                            rows.append(GridRow(
                                symbol=symbol, timeframe=tf, entry_mode=mode,
                                ema_fast=ef, ema_slow=es,
                                rsi_band=RSI_BAND_LABELS[bi],
                                rsi_long_min=band[0], rsi_long_max=band[1],
                                rsi_short_min=band[2], rsi_short_max=band[3],
                                min_score=ms, r_fraction=r, tp_r=tp,
                                variant_idx=vindex[key], r_idx=ri, tp_idx=ti,
                            ))
    return rows


def sim_key_index(n_variants: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n_sims = n_variants * len(R_FRACTIONS) * len(TAKE_PROFITS)
    ui = np.repeat(np.arange(n_variants), len(R_FRACTIONS) * len(TAKE_PROFITS))
    ri = np.tile(np.repeat(np.arange(len(R_FRACTIONS)), len(TAKE_PROFITS)),
                 n_variants)
    ti = np.tile(np.arange(len(TAKE_PROFITS)),
                 n_variants * len(R_FRACTIONS))
    assert ui.size == n_sims
    return ui, ri, ti


# ---------------------------------------------------------------------------
# Walk-forward per market
# ---------------------------------------------------------------------------


@dataclass
class MarketRun:
    market: Market
    grid: list[GridRow]
    n_folds: int
    fold_meta: list[dict]
    tr_trades: np.ndarray
    tr_wins: np.ndarray
    tr_net: np.ndarray
    tr_dd: np.ndarray
    tr_gw: np.ndarray
    tr_gl: np.ndarray
    te_trades: np.ndarray
    te_wins: np.ndarray
    te_net: np.ndarray
    te_dd: np.ndarray
    te_gw: np.ndarray
    te_gl: np.ndarray
    sim_variant: np.ndarray

    @property
    def n_sims(self) -> int:
        return self.tr_trades.shape[1]

    def exp(self, net: np.ndarray, trades: np.ndarray) -> np.ndarray:
        out = np.zeros_like(net, dtype=np.float64)
        np.divide(net, trades, out=out, where=trades > 0)
        return out

    def winrate(self, wins: np.ndarray, trades: np.ndarray) -> np.ndarray:
        out = np.zeros_like(wins, dtype=np.float64)
        np.divide(wins, trades, out=out, where=trades > 0)
        return out


def run_market(m: Market, fold_limit: Optional[int] = None) -> MarketRun:
    tf_ms = m.tf_ms
    span_ms = int(m.open_time[-1] - m.open_time[0] + tf_ms)
    n_folds = int((span_ms - TRAIN_DAYS * DAY_MS) // (STEP_DAYS * DAY_MS))
    n_folds = max(0, min(N_FOLDS, n_folds))
    if fold_limit is not None:
        n_folds = min(n_folds, fold_limit)
    if n_folds <= 0:
        raise ValueError(f"{m.symbol} {m.tf}: not enough history for one fold")

    grid = make_grid(m.symbol, m.tf)
    n_variants = len(m.variants)
    ui, ri_arr, ti_arr = sim_key_index(n_variants)
    n_sims = ui.size
    shape = (n_folds, n_sims)

    tr_trades = np.zeros(shape, dtype=np.int32)
    tr_wins = np.zeros(shape, dtype=np.int32)
    tr_net = np.zeros(shape, dtype=np.float64)
    tr_dd = np.zeros(shape, dtype=np.float64)
    tr_gw = np.zeros(shape, dtype=np.float64)
    tr_gl = np.zeros(shape, dtype=np.float64)
    te_trades = np.zeros(shape, dtype=np.int32)
    te_wins = np.zeros(shape, dtype=np.int32)
    te_net = np.zeros(shape, dtype=np.float64)
    te_dd = np.zeros(shape, dtype=np.float64)
    te_gw = np.zeros(shape, dtype=np.float64)
    te_gl = np.zeros(shape, dtype=np.float64)

    fold_meta: list[dict] = []
    t0 = time.time()
    for k in range(n_folds):
        fold_start = m.anchor + k * STEP_DAYS * DAY_MS
        train_end = fold_start + TRAIN_DAYS * DAY_MS
        test_end = train_end + TEST_DAYS * DAY_MS
        ts = int(np.searchsorted(m.open_time, fold_start, side="left"))
        tmid = int(np.searchsorted(m.open_time, train_end, side="left"))
        tend = int(np.searchsorted(m.open_time, test_end, side="left"))
        ts = max(0, min(ts, m.n))
        tmid = max(ts, min(tmid, m.n))
        tend = max(tmid, min(tend, m.n))
        fold_meta.append({
            "fold": k,
            "train_start_ms": int(m.open_time[ts]) if ts < m.n else fold_start,
            "train_end_ms": int(m.open_time[tmid - 1] + tf_ms) if tmid > ts else train_end,
            "test_start_ms": int(m.open_time[tmid]) if tmid < m.n else train_end,
            "test_end_ms": int(m.open_time[tend - 1] + tf_ms) if tend > tmid else test_end,
            "train_bars": tmid - ts,
            "test_bars": tend - tmid,
            "ts": ts, "tmid": tmid, "tend": tend,
        })
        for si in range(n_sims):
            v = m.variants[int(ui[si])]
            r_idx = int(ri_arr[si])
            tp_idx = int(ti_arr[si])
            tr = simulate(m, v, r_idx, tp_idx, ts, tmid)
            te = simulate(m, v, r_idx, tp_idx, tmid, tend)
            tr_trades[k, si], tr_wins[k, si], tr_net[k, si], tr_dd[k, si], \
                tr_gw[k, si], tr_gl[k, si] = tr[0], tr[1], tr[2], tr[3], tr[4], tr[5]
            te_trades[k, si], te_wins[k, si], te_net[k, si], te_dd[k, si], \
                te_gw[k, si], te_gl[k, si] = te[0], te[1], te[2], te[3], te[4], te[5]
        print(f"  {m.symbol:9s} {m.tf:3s} fold {k+1}/{n_folds} "
              f"train_bars={tmid-ts} test_bars={tend-tmid} "
              f"({time.time()-t0:.1f}s)", flush=True)

    return MarketRun(
        market=m, grid=grid, n_folds=n_folds, fold_meta=fold_meta,
        tr_trades=tr_trades, tr_wins=tr_wins, tr_net=tr_net, tr_dd=tr_dd,
        tr_gw=tr_gw, tr_gl=tr_gl,
        te_trades=te_trades, te_wins=te_wins, te_net=te_net, te_dd=te_dd,
        te_gw=te_gw, te_gl=te_gl, sim_variant=ui,
    )


# ---------------------------------------------------------------------------
# Selection / evaluation
# ---------------------------------------------------------------------------


def select_sim(run: MarketRun, fold: int, rule: str) -> int:
    """Select one simulation using TRAINING data only.

    exp  : at least MIN_TRAIN_TRADES, highest training expectancy R (primary;
           it always selects, so the OOS test measures whether the training
           winner generalises).
    netr : at least MIN_TRAIN_TRADES, highest training net R (trendsweep-style).
    live : training net R > 0, expectancy > 0, win rate >= 38% and at least
           MIN_TRAIN_TRADES (the real live BacktestGate, as a sensitivity).
    """
    tr_trades = run.tr_trades[fold]
    tr_net = run.tr_net[fold]
    tr_exp = run.exp(tr_net, tr_trades)
    tr_wr = run.winrate(run.tr_wins[fold], tr_trades)
    eligible = tr_trades >= MIN_TRAIN_TRADES
    if rule == "live":
        eligible &= (tr_net > 0) & (tr_exp > 0) & (tr_wr >= LIVE_MIN_WIN_RATE)
    elif rule == "netr":
        pass
    elif rule != "exp":
        raise ValueError(rule)
    if not eligible.any():
        return -1
    if rule == "netr":
        key = tr_net + 1e-9 * tr_exp + 1e-12 * tr_trades
    else:
        key = tr_exp + 1e-9 * tr_net + 1e-12 * tr_trades
    key = np.where(eligible, key, -np.inf)
    return int(np.argmax(key))


def evaluate_selection(run: MarketRun, selected: list[int],
                       folds: Optional[list[int]] = None) -> dict:
    if folds is None:
        folds = list(range(run.n_folds))
    ttr, tnet, texp = [], [], []
    for k in folds:
        si = selected[k]
        if si < 0:
            ttr.append(0)
            tnet.append(0.0)
            texp.append(0.0)
        else:
            ttr.append(int(run.te_trades[k, si]))
            tnet.append(float(run.te_net[k, si]))
            texp.append(float(run.exp(run.te_net[k], run.te_trades[k])[si]))
    total_trades = int(sum(ttr))
    total_net = float(sum(tnet))
    pos_folds = int(sum(1 for x in texp if x > 0))
    required = int(round(0.8 * len(folds)))
    passed = (total_trades >= MIN_TEST_TRADES and pos_folds >= required
              and total_net > 0)
    return {
        "folds": folds, "trades": ttr, "net": tnet, "exp": texp,
        "total_trades": total_trades, "total_net": total_net,
        "pos_folds": pos_folds, "required_pos": required, "pass": passed,
    }


def detail_selected(run: MarketRun, selected: list[int]) -> dict:
    """Re-run selected configs with trade details, per fold and aggregate."""
    m = run.market
    per_fold = []
    all_trades = []
    for k in range(run.n_folds):
        si = selected[k]
        meta = run.fold_meta[k]
        if si < 0:
            per_fold.append({"fold": k, "trades": [], "stats": None})
            continue
        v = m.variants[int(run.sim_variant[si])]
        # recover r/tp from sim index
        rem = si % (len(R_FRACTIONS) * len(TAKE_PROFITS))
        r_idx = rem // len(TAKE_PROFITS)
        tp_idx = rem % len(TAKE_PROFITS)
        res = simulate(m, v, r_idx, tp_idx, meta["tmid"], meta["tend"], detail=True)
        trades = res[7]
        per_fold.append({"fold": k, "trades": trades, "stats": res[:7],
                         "r_idx": r_idx, "tp_idx": tp_idx})
        all_trades.extend(trades)
    # aggregate stats from the concatenated trade sequence
    net = np.array([t[4] for t in all_trades], dtype=np.float64)
    if net.size:
        cum = np.cumsum(net)
        peak = np.maximum.accumulate(np.concatenate(([0.0], cum)))[1:]
        dd = peak - cum
        maxdd = float(np.max(dd))
        gw = float(net[net > 0].sum())
        gl = float(net[net < 0].sum())
        wins = int((net > 0).sum())
    else:
        maxdd = 0.0
        gw = gl = 0.0
        wins = 0
    return {"per_fold": per_fold, "trades": all_trades,
            "net": net, "maxdd": maxdd, "gross_win": gw, "gross_loss": gl,
            "wins": wins}


# ---------------------------------------------------------------------------
# Full run / outputs
# ---------------------------------------------------------------------------


def run_all(symbols: list[str], timeframes: list[str],
            fold_limit: Optional[int] = None) -> list[MarketRun]:
    runs: list[MarketRun] = []
    for symbol in symbols:
        for tf in timeframes:
            print(f"building {symbol} {tf}", flush=True)
            m = build_market(symbol, tf)
            run = run_market(m, fold_limit=fold_limit)
            runs.append(run)
    return runs


def results_dataframe(runs: list[MarketRun], selected_by_rule: dict,
                      rule: str) -> pd.DataFrame:
    rows = []
    for run in runs:
        selected = selected_by_rule[rule]
        for k in range(run.n_folds):
            meta = run.fold_meta[k]
            sel_si = selected[id(run)][k]
            tr_exp = run.exp(run.tr_net[k], run.tr_trades[k])
            tr_wr = run.winrate(run.tr_wins[k], run.tr_trades[k])
            te_exp = run.exp(run.te_net[k], run.te_trades[k])
            te_wr = run.winrate(run.te_wins[k], run.te_trades[k])
            tr_pf = np.where(
                run.tr_trades[k] > 0,
                np.where(run.tr_gl[k] < 0,
                         run.tr_gw[k] / -run.tr_gl[k], np.inf),
                0.0)
            te_pf = np.where(
                run.te_trades[k] > 0,
                np.where(run.te_gl[k] < 0,
                         run.te_gw[k] / -run.te_gl[k], np.inf),
                0.0)
            for g in run.grid:
                si = ((g.variant_idx * len(R_FRACTIONS) + g.r_idx)
                      * len(TAKE_PROFITS) + g.tp_idx)
                rows.append((
                    run.market.symbol, run.market.tf, k,
                    meta["train_start_ms"], meta["train_end_ms"],
                    meta["test_start_ms"], meta["test_end_ms"],
                    g.entry_mode, g.ema_fast, g.ema_slow, g.rsi_band,
                    g.rsi_long_min, g.rsi_long_max, g.rsi_short_min, g.rsi_short_max,
                    g.min_score, g.r_fraction, g.tp_r,
                    int(run.tr_trades[k, si]), float(tr_wr[si]), float(tr_exp[si]),
                    float(run.tr_net[k, si]), float(run.tr_dd[k, si]), float(tr_pf[si]),
                    int(run.te_trades[k, si]), float(te_wr[si]), float(te_exp[si]),
                    float(run.te_net[k, si]), float(run.te_dd[k, si]), float(te_pf[si]),
                    bool(si == sel_si),
                ))
    cols = [
        "symbol", "timeframe", "fold", "train_start_ms", "train_end_ms",
        "test_start_ms", "test_end_ms", "entry_mode", "ema_fast", "ema_slow",
        "rsi_band", "rsi_long_min", "rsi_long_max", "rsi_short_min",
        "rsi_short_max", "min_score", "r_fraction", "tp_r",
        "train_trades", "train_win_rate", "train_expectancy_r", "train_net_r",
        "train_max_dd_r", "train_profit_factor",
        "test_trades", "test_win_rate", "test_expectancy_r", "test_net_r",
        "test_max_dd_r", "test_profit_factor", "selected",
    ]
    df = pd.DataFrame(rows, columns=cols)
    for col in ("train_start_ms", "train_end_ms", "test_start_ms", "test_end_ms"):
        df[col] = pd.to_datetime(df[col], unit="ms", utc=True)
    return df


def market_summary_table(runs: list[MarketRun], selected_by_rule: dict,
                         rule: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    summary_rows = []
    sel_rows = []
    for run in runs:
        m = run.market
        sel = selected_by_rule[rule][id(run)]
        primary_folds = list(range(min(PRIMARY_FOLDS, run.n_folds)))
        all_folds = list(range(run.n_folds))
        ev_primary = evaluate_selection(run, sel, primary_folds)
        ev_all = evaluate_selection(run, sel, all_folds)
        detail = detail_selected(run, sel)

        # per-fold selected rows
        for k in range(run.n_folds):
            si = sel[k]
            meta = run.fold_meta[k]
            if si >= 0:
                v = m.variants[int(run.sim_variant[si])]
                rem = si % (len(R_FRACTIONS) * len(TAKE_PROFITS))
                r_idx = rem // len(TAKE_PROFITS)
                tp_idx = rem % len(TAKE_PROFITS)
                te_tr = int(run.te_trades[k, si])
                te_exp = float(run.exp(run.te_net[k], run.te_trades[k])[si])
                te_net = float(run.te_net[k, si])
                te_wr = float(run.winrate(run.te_wins[k], run.te_trades[k])[si])
                te_dd = float(run.te_dd[k, si])
                gl = run.te_gl[k, si]
                pf = float(run.te_gw[k, si] / -gl) if gl < 0 else float("inf")
                sel_rows.append({
                    "symbol": m.symbol, "timeframe": m.tf, "fold": k,
                    "entry_mode": v.entry_mode,
                    "ema_fast": EMA_PAIRS[v.pair_idx][0],
                    "ema_slow": EMA_PAIRS[v.pair_idx][1],
                    "rsi_band": (RSI_BAND_LABELS[v.band_idx]
                                 if v.entry_mode == "trend" else "inert"),
                    "min_score": (v.min_score if v.entry_mode == "trend"
                                  else "inert"),
                    "r_fraction": R_FRACTIONS[r_idx],
                    "tp_r": TAKE_PROFITS[tp_idx],
                    "train_trades": int(run.tr_trades[k, si]),
                    "train_win_rate": float(run.winrate(
                        run.tr_wins[k], run.tr_trades[k])[si]),
                    "train_expectancy_r": float(run.exp(
                        run.tr_net[k], run.tr_trades[k])[si]),
                    "train_net_r": float(run.tr_net[k, si]),
                    "test_trades": te_tr, "test_win_rate": te_wr,
                    "test_expectancy_r": te_exp, "test_net_r": te_net,
                    "test_max_dd_r": te_dd, "test_profit_factor": pf,
                    "test_start": pd.to_datetime(meta["test_start_ms"], unit="ms", utc=True),
                    "test_end": pd.to_datetime(meta["test_end_ms"], unit="ms", utc=True),
                })
            else:
                sel_rows.append({
                    "symbol": m.symbol, "timeframe": m.tf, "fold": k,
                    "entry_mode": "none", "ema_fast": np.nan, "ema_slow": np.nan,
                    "rsi_band": "none", "min_score": np.nan,
                    "r_fraction": np.nan, "tp_r": np.nan,
                    "train_trades": 0, "train_win_rate": 0.0,
                    "train_expectancy_r": 0.0, "train_net_r": 0.0,
                    "test_trades": 0, "test_win_rate": 0.0,
                    "test_expectancy_r": 0.0, "test_net_r": 0.0,
                    "test_max_dd_r": 0.0, "test_profit_factor": 0.0,
                    "test_start": pd.to_datetime(meta["test_start_ms"], unit="ms", utc=True),
                    "test_end": pd.to_datetime(meta["test_end_ms"], unit="ms", utc=True),
                })

        # parameter stability: distinct selected keys (normalized)
        keys = []
        for k in range(run.n_folds):
            si = sel[k]
            if si < 0:
                keys.append(("none",))
                continue
            v = m.variants[int(run.sim_variant[si])]
            rem = si % (len(R_FRACTIONS) * len(TAKE_PROFITS))
            r_idx = rem // len(TAKE_PROFITS)
            tp_idx = rem % len(TAKE_PROFITS)
            if v.entry_mode == "cross":
                keys.append(("cross", v.pair_idx, r_idx, tp_idx))
            else:
                keys.append(("trend", v.pair_idx, v.band_idx, v.min_score,
                             r_idx, tp_idx))
        from collections import Counter
        counts = Counter(keys)
        mode_key, mode_count = counts.most_common(1)[0]

        summary_rows.append({
            "symbol": m.symbol, "timeframe": m.tf,
            "n_folds": run.n_folds,
            "primary_folds": len(primary_folds),
            "primary_test_trades": ev_primary["total_trades"],
            "primary_pos_folds": ev_primary["pos_folds"],
            "primary_required_pos": ev_primary["required_pos"],
            "primary_test_net_r": ev_primary["total_net"],
            "primary_pass": ev_primary["pass"],
            "primary_insufficient_folds": run.n_folds < PRIMARY_FOLDS,
            "extended_test_trades": ev_all["total_trades"],
            "extended_pos_folds": ev_all["pos_folds"],
            "extended_required_pos": ev_all["required_pos"],
            "extended_test_net_r": ev_all["total_net"],
            "extended_pass": ev_all["pass"],
            "all_test_trades": int(len(detail["trades"])),
            "all_win_rate": (detail["wins"] / len(detail["trades"])
                             if detail["trades"] else 0.0),
            "all_expectancy_r": (float(detail["net"].mean())
                                 if detail["net"].size else 0.0),
            "all_net_r": float(detail["net"].sum()) if detail["net"].size else 0.0,
            "all_max_dd_r": detail["maxdd"],
            "all_profit_factor": (detail["gross_win"] / -detail["gross_loss"]
                                  if detail["gross_loss"] < 0 else float("inf")),
            "distinct_selected_params": len([k for k in counts if k != ("none",)]),
            "modal_param_count": mode_count,
            "modal_param_share": mode_count / run.n_folds,
            "selected_keys": keys,
        })
    return pd.DataFrame(summary_rows), pd.DataFrame(sel_rows)


def rank_diagnostics(runs: list[MarketRun], rule: str = "exp") -> dict:
    cors = []
    percentiles = []
    for run in runs:
        for k in range(run.n_folds):
            tr_trades = run.tr_trades[k]
            te_trades = run.te_trades[k]
            mask = (tr_trades >= MIN_TRAIN_TRADES) & (te_trades >= 5)
            if mask.sum() < 10:
                continue
            tr_exp = run.exp(run.tr_net[k], tr_trades)[mask]
            te_exp = run.exp(run.te_net[k], te_trades)[mask]
            if np.std(tr_exp) == 0 or np.std(te_exp) == 0:
                continue
            cor = spearmanr(tr_exp, te_exp).statistic
            if np.isfinite(cor):
                cors.append(float(cor))
            # selected percentile, if a selection exists
            si = select_sim(run, k, rule)
            if si >= 0 and mask[si]:
                all_te = run.exp(run.te_net[k], run.te_trades[k])[mask]
                sel_te = run.exp(run.te_net[k], run.te_trades[k])[si]
                pct = float((all_te < sel_te).mean())
                percentiles.append(pct)
    return {"spearman": cors, "selected_test_percentile": percentiles}


def permutation_test(runs: list[MarketRun], observed_pass: int,
                     observed_max_net: float, rule: str = "exp",
                     n_perm: int = 500, seed: int = 20261017) -> dict:
    """Permutation test of the selection procedure.

    Within each market/fold, shuffle which test-metric vector is attached to
    each training row.  The selector still sees the real training stats.  This
    breaks any train->test link while preserving both marginal distributions.
    """
    rng = np.random.default_rng(seed)
    eligible_markets = [r for r in runs if r.n_folds >= PRIMARY_FOLDS]
    if not eligible_markets:
        return {"n_perm": n_perm, "note": "no market with >=5 folds"}
    folds = list(range(PRIMARY_FOLDS))

    # Precompute real selections and test arrays.
    prep = []
    for run in eligible_markets:
        sel = [select_sim(run, k, rule) for k in folds]
        te_tr = run.te_trades[:PRIMARY_FOLDS]
        te_net = run.te_net[:PRIMARY_FOLDS]
        te_exp = run.exp(te_net, te_tr)
        prep.append((run, sel, te_tr, te_net, te_exp))

    null_counts = np.zeros(n_perm, dtype=np.int32)
    null_max_net = np.full(n_perm, -np.inf, dtype=np.float64)
    for b in range(n_perm):
        count = 0
        best_net = -np.inf
        for run, sel, te_tr, te_net, te_exp in prep:
            ttr = []
            tnet = []
            texp = []
            for k in folds:
                si = sel[k]
                if si < 0:
                    ttr.append(0)
                    tnet.append(0.0)
                    texp.append(0.0)
                    continue
                perm = rng.permutation(run.n_sims)
                j = int(perm[si])
                ttr.append(int(te_tr[k, j]))
                tnet.append(float(te_net[k, j]))
                texp.append(float(te_exp[k, j]))
            total_trades = int(sum(ttr))
            total_net = float(sum(tnet))
            pos = int(sum(1 for x in texp if x > 0))
            if total_trades >= MIN_TEST_TRADES and pos >= 4 and total_net > 0:
                count += 1
            if total_net > best_net:
                best_net = total_net
        null_counts[b] = count
        null_max_net[b] = best_net

    p_count = (1 + int((null_counts >= observed_pass).sum())) / (n_perm + 1)
    p_max = (1 + int((null_max_net >= observed_max_net).sum())) / (n_perm + 1)
    return {
        "n_perm": n_perm,
        "seed": seed,
        "n_markets": len(eligible_markets),
        "observed_pass": int(observed_pass),
        "observed_max_net_r": float(observed_max_net),
        "null_pass_mean": float(null_counts.mean()),
        "null_pass_p50": float(np.percentile(null_counts, 50)),
        "null_pass_p95": float(np.percentile(null_counts, 95)),
        "null_pass_max": int(null_counts.max()),
        "p_value_pass_count": float(p_count),
        "null_max_net_mean": float(null_max_net.mean()),
        "null_max_net_p95": float(np.percentile(null_max_net, 95)),
        "p_value_max_net": float(p_max),
    }


# ---------------------------------------------------------------------------
# Supplementary diagnostics
# ---------------------------------------------------------------------------


def funding_summary(symbols: list[str]) -> pd.DataFrame:
    rows = []
    for sym in symbols:
        path = os.path.join(ROOT, "research", "data", "funding", f"{sym}.csv")
        if not os.path.exists(path):
            continue
        df = pd.read_csv(path)
        if df.empty:
            continue
        rate = df["funding_rate"].to_numpy(dtype=np.float64)
        t = df["funding_time"].to_numpy(dtype=np.int64)
        med = float(np.median(rate))
        rows.append({
            "symbol": sym,
            "n_payments": int(rate.size),
            "first_funding": pd.to_datetime(t[0], unit="ms", utc=True),
            "last_funding": pd.to_datetime(t[-1], unit="ms", utc=True),
            "median_rate": med,
            "mean_rate": float(rate.mean()),
            "annualized_median": med * 3 * 365,
            "long_cost_r_at_0.4pct": med / 0.004,
            "long_cost_r_at_0.8pct": med / 0.008,
            "long_cost_r_at_1.2pct": med / 0.012,
        })
    return pd.DataFrame(rows)


def cost_diagnostic(symbol: str = "BTCUSDT", tf: str = "5m",
                    max_folds: int = PRIMARY_FOLDS) -> pd.DataFrame:
    """Decompose costs on one market: zero / fees only / slippage only / both.

    This rebuilds the market for each scenario because stop/take levels depend
    on entry slippage.  It is a diagnostic, not part of the pass/fail protocol.
    """
    global TAKER_FEE, SLIPPAGE
    orig = (TAKER_FEE, SLIPPAGE)
    scenarios = [
        ("zero_cost", 0.0, 0.0),
        ("fees_only", 0.0005, 0.0),
        ("slippage_only", 0.0, 0.0002),
        ("fees_and_slippage", 0.0005, 0.0002),
    ]
    rows = []
    try:
        for label, fee, slip in scenarios:
            TAKER_FEE, SLIPPAGE = fee, slip
            m = build_market(symbol, tf)
            span = int(m.open_time[-1] - m.open_time[0] + m.tf_ms)
            nf = int((span - TRAIN_DAYS * DAY_MS) // (STEP_DAYS * DAY_MS))
            nf = max(1, min(N_FOLDS, nf, max_folds))
            for k in range(nf):
                fs = m.anchor + k * STEP_DAYS * DAY_MS
                te = fs + TRAIN_DAYS * DAY_MS
                xe = te + TEST_DAYS * DAY_MS
                ts = int(np.searchsorted(m.open_time, fs, side="left"))
                tm = int(np.searchsorted(m.open_time, te, side="left"))
                tn = int(np.searchsorted(m.open_time, xe, side="left"))
                tr_net = []
                te_net = []
                for v in m.variants:
                    for ri in range(len(R_FRACTIONS)):
                        for ti in range(len(TAKE_PROFITS)):
                            a = simulate(m, v, ri, ti, ts, tm)
                            b = simulate(m, v, ri, ti, tm, tn)
                            if a[0] >= MIN_TRAIN_TRADES:
                                tr_net.append(a[2])
                            if b[0] >= MIN_TRAIN_TRADES:
                                te_net.append(b[2])
                tr_net = np.asarray(tr_net)
                te_net = np.asarray(te_net)
                rows.append({
                    "symbol": symbol, "timeframe": tf, "scenario": label,
                    "fold": k,
                    "train_combos_ge20": int(tr_net.size),
                    "train_positive": int((tr_net > 0).sum()),
                    "train_median_net_r": float(np.median(tr_net)) if tr_net.size else 0.0,
                    "train_best_net_r": float(tr_net.max()) if tr_net.size else 0.0,
                    "test_combos_ge20": int(te_net.size),
                    "test_positive": int((te_net > 0).sum()),
                    "test_median_net_r": float(np.median(te_net)) if te_net.size else 0.0,
                    "test_best_net_r": float(te_net.max()) if te_net.size else 0.0,
                })
    finally:
        TAKER_FEE, SLIPPAGE = orig
    return pd.DataFrame(rows)


def parameter_distribution(results: pd.DataFrame, path: str) -> pd.DataFrame:
    """Per market/fold median-vs-oracle stats over unique parameter sets.

    Cross-mode RSI band and minScore are inert, so they are deduplicated away.
    """
    cross_u = results[results["entry_mode"] == "cross"].drop_duplicates(
        subset=["symbol", "timeframe", "fold", "ema_fast", "ema_slow",
                "r_fraction", "tp_r"])
    trend_u = results[results["entry_mode"] == "trend"].drop_duplicates(
        subset=["symbol", "timeframe", "fold", "ema_fast", "ema_slow",
                "rsi_band", "min_score", "r_fraction", "tp_r"])
    u = pd.concat([cross_u, trend_u], ignore_index=True)
    cost_r = 0.0014 / u["r_fraction"]
    u = u.assign(
        gross_test_net=u["test_net_r"] + np.where(
            u["test_trades"] > 0, u["test_trades"] * cost_r, 0.0),
        gross_test_exp=np.where(
            u["test_trades"] > 0, u["test_expectancy_r"] + cost_r, np.nan),
    )
    grp = u.groupby(["symbol", "timeframe", "fold"])
    out = pd.DataFrame({
        "n_combos": grp.size(),
        "test_pos_share": grp["test_net_r"].apply(
            lambda x: float((x > 0).mean())),
        "test_median_net_r": grp["test_net_r"].median(),
        "test_median_expectancy_r": grp["test_expectancy_r"].median(),
        "test_oracle_net_r": grp["test_net_r"].max(),
        "test_oracle_expectancy_r": grp["test_expectancy_r"].max(),
        "gross_pos_share": grp["gross_test_net"].apply(
            lambda x: float((x > 0).mean())),
        "gross_median_net_r": grp["gross_test_net"].median(),
        "gross_oracle_net_r": grp["gross_test_net"].max(),
    }).reset_index()
    out.to_csv(path, index=False, float_format="%.6f")
    return out


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def fmt(x, nd=2):
    if x is None:
        return "-"
    if isinstance(x, (float, np.floating)):
        if not np.isfinite(x):
            return "inf" if x > 0 else "-inf"
        return f"{x:.{nd}f}"
    return str(x)


def write_report(rule: str, summary: pd.DataFrame,
                 selected: pd.DataFrame, results: pd.DataFrame,
                 rank: dict, perm: dict, elapsed: float,
                 funding_df: Optional[pd.DataFrame] = None,
                 cost_df: Optional[pd.DataFrame] = None) -> None:
    lines: list[str] = []
    ap = lines.append

    headline = summary[(~summary["primary_insufficient_folds"])
                       & (summary["primary_pass"])]
    ext_headline = summary[(~summary["primary_insufficient_folds"])
                           & (summary["extended_pass"])]
    insufficient = summary[summary["primary_insufficient_folds"]]
    n_complete_markets = int((~summary["primary_insufficient_folds"]).sum())
    n_complete_symbols = int(summary.loc[
        ~summary["primary_insufficient_folds"], "symbol"].nunique())

    # Unique-parameter out-of-sample distribution.  Cross-mode RSI band and
    # minScore are inert, so they are deduplicated away.  This is the
    # median-vs-oracle diagnostic that exposes the 1152-combo overfitting trap.
    cross_u = results[results["entry_mode"] == "cross"].drop_duplicates(
        subset=["symbol", "timeframe", "fold", "ema_fast", "ema_slow",
                "r_fraction", "tp_r"])
    trend_u = results[results["entry_mode"] == "trend"].drop_duplicates(
        subset=["symbol", "timeframe", "fold", "ema_fast", "ema_slow",
                "rsi_band", "min_score", "r_fraction", "tp_r"])
    u = pd.concat([cross_u, trend_u], ignore_index=True)
    test_pos_share = float((u["test_net_r"] > 0).mean())
    med_test_exp = float(u["test_expectancy_r"].median())
    cost_r = 0.0014 / u["r_fraction"]
    gross_net = u["test_net_r"] + np.where(
        u["test_trades"] > 0, u["test_trades"] * cost_r, 0.0)
    gross_pos_share = float((gross_net > 0).mean())
    gross_exp = np.where(u["test_trades"] > 0,
                         u["test_expectancy_r"] + cost_r, np.nan)
    gross_med_exp = float(np.nanmedian(gross_exp))
    grp = u.groupby(["symbol", "timeframe", "fold"])
    med_net = grp["test_net_r"].median()
    oracle_net = grp["test_net_r"].max()
    n_mf = int(len(med_net))
    median_pos_folds = int((med_net > 0).sum())
    oracle_pos_folds = int((oracle_net > 0).sum())
    oracle_by_tf = {}
    for tf in TIMEFRAMES:
        mask = oracle_net.index.get_level_values(1) == tf
        oracle_by_tf[tf] = (float((oracle_net[mask] > 0).mean())
                            if mask.any() else 0.0)

    # Rank-persistence decomposition: is the train/test rank correlation real
    # alpha, or just the cost structure (larger rFraction = smaller cost drag)?
    rank_sample = u[(u["train_trades"] >= MIN_TRAIN_TRADES)
                    & (u["test_trades"] >= 5)]
    net_within, gross_within, gross_overall, rho_r = [], [], [], []
    for _, g in rank_sample.groupby(["symbol", "timeframe", "fold"]):
        if len(g) < 10:
            continue
        a = spearmanr(g["r_fraction"], g["test_expectancy_r"]).statistic
        if np.isfinite(a):
            rho_r.append(float(a))
        a = spearmanr(g["train_expectancy_r"] + 0.0014 / g["r_fraction"],
                      g["test_expectancy_r"] + 0.0014 / g["r_fraction"]).statistic
        if np.isfinite(a):
            gross_overall.append(float(a))
        for _, h in g.groupby("r_fraction"):
            if len(h) < 10:
                continue
            a = spearmanr(h["train_expectancy_r"],
                          h["test_expectancy_r"]).statistic
            if np.isfinite(a):
                net_within.append(float(a))
            a = spearmanr(h["train_expectancy_r"] + 0.0014 / h["r_fraction"],
                          h["test_expectancy_r"] + 0.0014 / h["r_fraction"]).statistic
            if np.isfinite(a):
                gross_within.append(float(a))
    net_within_med = float(np.median(net_within)) if net_within else float("nan")
    gross_overall_med = float(np.median(gross_overall)) if gross_overall else float("nan")
    gross_within_med = float(np.median(gross_within)) if gross_within else float("nan")
    rho_r_med = float(np.median(rho_r)) if rho_r else float("nan")

    # Rank diagnostics: raw lists on a fresh run, summary stats on report-only.
    if rank.get("spearman"):
        cors = np.array(rank["spearman"])
        rank_n = int(cors.size)
        rank_med = float(np.median(cors))
        rank_mean = float(cors.mean())
        rank_pos_share = float((cors > 0).mean())
    else:
        rank_n = int(rank.get("spearman_n", 0))
        rank_med = float(rank.get("spearman_median", np.nan))
        rank_mean = float(rank.get("spearman_mean", np.nan))
        rank_pos_share = float(rank.get("spearman_positive_share", np.nan))
    if rank.get("selected_test_percentile"):
        pct = np.array(rank["selected_test_percentile"])
        pct_med = float(np.median(pct))
        pct_top25 = float((pct >= 0.75).mean())
    else:
        pct_med = float(rank.get("selected_percentile_median", np.nan))
        pct_top25 = float(rank.get("selected_percentile_top25_share", np.nan))

    eligible_summary = summary[~summary["primary_insufficient_folds"]]
    if len(eligible_summary):
        best_row = eligible_summary.loc[
            eligible_summary["primary_test_net_r"].idxmax()]
        best_name = f"{best_row['symbol']} {best_row['timeframe']}"
    else:
        best_row = None
        best_name = "—"
    pos_counts = eligible_summary["primary_pos_folds"].value_counts().to_dict()
    n_ge4 = int(pos_counts.get(4, 0) + pos_counts.get(5, 0))
    total_all_net = float(eligible_summary["all_net_r"].sum())
    median_all_exp = float(eligible_summary["all_expectancy_r"].median())
    median_all_wr = float(eligible_summary["all_win_rate"].median())
    median_all_pf = float(eligible_summary["all_profit_factor"].median())
    n_pos_all = int((eligible_summary["all_net_r"] > 0).sum())

    ap("# 趋势策略 walk-forward 验证报告")
    ap("")
    ap(f"生成时间：{pd.Timestamp.utcnow():%Y-%m-%d %H:%M UTC}　"
       f"运行耗时：{elapsed/60:.1f} 分钟")
    ap("")
    ap("## 结论（TL;DR）")
    ap("")
    if len(headline) == 0:
        ap(f"**通过数为 0。** 在 {n_complete_symbols} 个拥有完整 180 天数据的"
           f"币种 × 3 个周期（{n_complete_markets} 个市场）上，严格 45 天选参 / "
           "15 天测试的 5 折 walk-forward 没有任何一个市场同时满足："
           "测试段总交易数 ≥ 30、至少 4/5 折测试期望值 > 0、"
           "测试段合计 netR > 0。")
    else:
        ap(f"**通过数为 {len(headline)}。** 通过的市场见下表。")
    if len(ext_headline):
        ap("")
        ap(f"扩展到全部 9 折后，通过的市场为 {len(ext_headline)} 个"
           "（判定阈值按 80% 折为正，即 9 折中至少 7 折）。")
    else:
        ap("")
        ap("扩展到全部 9 折后，仍然没有市场通过（9 折至少 7 折为正、"
           "总交易数 ≥ 30、合计 netR > 0）。")
    ap("")
    ap(f"{n_complete_markets} 个市场的主 5 折正收益折数分布："
       f"0/5 {int(pos_counts.get(0, 0))} 个、"
       f"1/5 {int(pos_counts.get(1, 0))} 个、"
       f"2/5 {int(pos_counts.get(2, 0))} 个、"
       f"3/5 {int(pos_counts.get(3, 0))} 个、"
       f"4/5 {int(pos_counts.get(4, 0))} 个、"
       f"5/5 {int(pos_counts.get(5, 0))} 个；达到 4/5 及以上的市场 "
       f"{n_ge4} 个。")
    ap(f"全部 9 折等权 R 合计 {total_all_net:+.1f}R（非组合复利），"
       f"期望中位 {median_all_exp:+.3f}R，胜率中位 {median_all_wr:.1%}，"
       f"PF 中位 {median_all_pf:.2f}；只有 {n_pos_all} 个市场全折净 R 为正。")
    ap("")
    ap("KORUUSDT 已排除在扫描宇宙之外：2026-07-15 00:20–09:35 UTC 零成交"
       "停牌后，价格从 481.11 跳到 22.68（21.21 倍），这是合约折算而非市场"
       "下跌；原始 K 线会出现假的 −95% 跳变，且它只有约 117 天历史，无法"
       "执行完整 5 折。它不进入任何主结果。详见 2.1。")
    ap("")
    ap("关键诊断：")
    ap("")
    if best_row is not None:
        best_tail = (
            "它满足主 5 折标准；仍需结合置换检验和成本判断是否稳定。"
            if bool(best_row["primary_pass"]) else
            "但它不满足 4/5 折一致性，参数在折间漂移，正收益集中在少数折；"
            "按预注册标准不通过。"
        )
        ap(f"- **最接近通过的是 {best_name}**：前 5 折合计 "
           f"{best_row['primary_test_net_r']:+.2f}R、"
           f"{int(best_row['primary_pos_folds'])}/"
           f"{int(best_row['primary_folds'])} 折为正、"
           f"{int(best_row['primary_test_trades'])} 笔；9 折 "
           f"{best_row['all_net_r']:+.2f}R、{int(best_row['all_test_trades'])} 笔、"
           f"期望 {best_row['all_expectancy_r']:+.3f}R、"
           f"PF {best_row['all_profit_factor']:.2f}。{best_tail}")
    ap(f"- **典型组合全面为负**：{n_complete_markets} 个市场 × 9 折 × 624 个"
       f"唯一模拟 = {len(u):,} 个样本外组合中，只有 {test_pos_share:.1%} "
       f"测试净 R > 0，中位期望 {med_test_exp:+.3f}R；按每笔加回 14bp 往返"
       f"成本近似，也只有 {gross_pos_share:.1%} 为正、中位期望 "
       f"{gross_med_exp:+.3f}R，说明毛 edge 本身也不为正，不只是成本问题。")
    ap(f"- **选参有排名持续性，但没有正的绝对水平**：训练/测试期望 R 的 "
       f"Spearman 秩相关中位 {rank_med:+.3f}（{rank_n} 个市场-折，"
       f"正值占比 {rank_pos_share:.1%}）；但把 rFraction 分层后，这一相关"
       f"降到中位 {net_within_med:+.3f}；毛期望（加回 14bp）的整体相关中位"
       f"仅 {gross_overall_med:+.3f}；rFraction 与测试期望的相关中位 "
       f"{rho_r_med:+.3f}。也就是说，排名持续性几乎全部来自“rFraction 越大、"
       "成本拖累越小”，而不是可预测的方向性 alpha。被选中参数在测试段的"
       f"期望值百分位中位 {pct_med:.1%}，进入前 25% 的比例 {pct_top25:.1%}，"
       "但绝对水平仍为负。")
    ap(f"- **oracle 幻觉**：事后看测试段最佳参数，1h 有 "
       f"{oracle_by_tf['1h']:.1%} 的市场-折为正、15m "
       f"{oracle_by_tf['15m']:.1%}、5m {oracle_by_tf['5m']:.1%}；但事前 "
       f"walk-forward 选出的典型组合在 {n_mf} 个市场-折中有 "
       f"{median_pos_folds} 个中位为正。事后最优不能当成可交易 edge。")
    ap(f"- **置换检验**：{perm.get('n_perm', 0)} 次打乱每折训练行与测试行的"
       f"对应关系。通过市场数的零分布退化为 "
       f"{perm.get('null_pass_mean', float('nan')):.0f}（随机配对下几乎没有"
       f"市场能满足 4/5 折为正），实际 {perm.get('observed_pass', 0)}，"
       f"p = {perm.get('p_value_pass_count', float('nan')):.3f}；该统计量对"
       "“0 通过”不敏感。更有区分度的“最佳市场合计净 R”：零假设均值 "
       f"{perm.get('null_max_net_mean', float('nan')):.1f}R、95 分位 "
       f"{perm.get('null_max_net_p95', float('nan')):.1f}R；实际最佳 "
       f"{perm.get('observed_max_net_r', float('nan')):+.2f}R，"
       f"p = {perm.get('p_value_max_net', float('nan')):.3f}。这是一个弱信号"
       "候选，但未通过一致性门槛、效应量很小、参数不稳定，不能据此降低标准。")
    ap("")
    if len(headline) == 0:
        near = (f"唯一接近通过的 {best_name} 也" if best_row is not None else "")
        ap(f"因此，**没有可验证的、能穿越样本外成本的趋势 edge**。{near}"
           "不满足预注册的 4/5 折一致性，且效应量在真实资金费/执行摩擦下"
           "几乎没有安全边际。")
    else:
        ap(f"因此，按预注册标准只有 {len(headline)} 个市场通过；"
           "但结合置换检验、参数稳定性和成本分解，不能把这些结果当成稳定 edge。")
    ap("")
    ap("这与同批突破/动量组的独立结论一致：14 个主检验 0 通过，日内毛 "
       "edge≈0，14bp 往返成本使其必负；1d 正收益由极值主导、样本薄。")
    ap("")

    ap("## 1. 复现的信号与执行假设")
    ap("")
    ap("以仓库代码为准（只读核对）：")
    ap("")
    ap("| 项目 | 代码位置 | 本回测的处理 |")
    ap("|---|---|---|")
    ap("| EMA 方向 | `signals.go: ScoreTrend` | `diff = EMA(fast)-EMA(slow)`；"
       "`diff >= 0.05%*price` 做多，`-diff >= 0.05%*price` 做空 |")
    ap("| RSI | `signals.go: LastRSI` | Wilder RSI(14)，SMA 种子 |")
    ap("| 放量 | `signals.go: volumeAbove` | 当根成交量 > 前 20 根均量 |")
    ap("| 15m 共振 | `signals.go: higherAgrees` | 信号 K 收盘时最后一根已收盘"
       " 15m K 的 EMA 方向 |")
    ap("| 打分 | `signals.go: ScoreTrend` | 方向 1 分 + RSI + 放量 + 15m，"
       "满分 4；方向未拉开时 0 分 |")
    ap("| cross 入场 | `backtest.go: entrySide` | 只看当根金叉/死叉；"
       "RSI/放量/15m/minScore **不参与** |")
    ap("| trend 入场 | `backtest.go: entrySide` | `score >= minScore` 即可 |")
    ap("| 止损/止盈 | `risk.go: ProtectionPrices` | `stop=entry*(1±rFraction)`，"
       "`take=entry*(1±k*rFraction)` |")
    ap("| 反向平仓 | `backtest.go: backtestExit` | 始终用相反 EMA 交叉 |")
    ap("")
    ap("执行与成本（比仓库内 `Backtest` 更保守）：")
    ap("")
    ap("- 信号在当根收盘确认，**下一根开盘成交**；仓库内 `Backtest` 是当根收盘成交。")
    ap("- 止损/止盈用下一根及之后的高/低点触发；同一根同时触及止损和止盈时按**止损**计。")
    ap("- 反向交叉在信号根收盘确认，**下一根开盘**平仓。")
    ap("- 每边 taker 0.05% + 滑点 0.02%；开平各一次，共 0.14%。")
    ap("- 同一市场一次只持一仓；跳过持仓期间的新信号。")
    ap("- 每个训练/测试窗口开始时空仓；窗口结束时强制按最后一根收盘价平仓"
       "（扣平仓成本），避免使用窗口外数据。")
    ap("- 不使用未来数据生成信号：EMA/RSI/成交量/15m 共振都是因果的。")
    ap("")
    ap("## 2. Walk-forward 协议")
    ap("")
    ap("- 数据：`research/data/klines/<SYMBOL>_<TF>.csv`，180 天；"
       "8 个币种完整；KORUUSDT 排除（见 2.1）。")
    ap("")
    ap("### 2.1 数据质量与 KORUUSDT")
    ap("")
    ap("KORUUSDT 的原始 K 线在 2026-07-15 发生了一次合约折算，不是市场价格：")
    ap("")
    ap("- 2026-07-15 00:20–09:35 UTC（5m）为零成交量停牌，价格固定在 481.11；")
    ap("- 09:35 UTC 恢复时开盘 22.68，停牌前最后收盘 481.11，比值 "
       "**481.11 / 22.68 = 21.21x**；按整数合约折算 21.2x 计算，折算后停牌前"
       "收盘约 22.69，与恢复开盘几乎一致；")
    ap("- 1d 的 2026-07-15 K 线把两个价格体系混在一根里（open 497.30、"
       "high 498.64、low 19.55、close 21.36），无法直接使用；")
    ap("- 任何基于原始价格的 EMA/RSI 都会看到假的 −95% 暴跌、错误的死叉和"
       "错误的趋势方向，足以污染整段结果；")
    ap("- KORUUSDT 只有约 117 天历史（2026-06-22 上线），本身也无法完成 "
       "45+5×15 天的 5 折协议。")
    ap("")
    ap("因此本报告把 KORUUSDT **整体剔除**，不做“调整后硬凑”的二次分析，"
       "也不降低任何通过门槛。其余 8 个币种 × 3 个周期 = 24 个市场均覆盖"
       "完整 180 天；数据已检查无缺口、无重复、无非正价格。")
    ap("")
    ap("- 折：每折 45 天训练 + 15 天测试，步长 15 天；完整数据可做 9 折。")
    ap(f"- 主判定只用前 {PRIMARY_FOLDS} 折（测试段覆盖第 45–120 天），"
       "与要求的 5 折协议一致；后 4 折作为扩展样本外检查。")
    ap(f"- 主选参规则 `exp`：训练段交易数 ≥ {MIN_TRAIN_TRADES}，"
       "取训练期望 R 最高的一组。**不要求训练净 R 为正**——否则在成本很高的"
       "样本里会频繁选不出参数，walk-forward 退化成“不交易”。样本外是否为正"
       "由通过标准判定。")
    ap(f"- 敏感性规则 `live`：在 `exp` 基础上加训练净 R > 0、训练期望 R > 0、"
       f"训练胜率 ≥ {LIVE_MIN_WIN_RATE:.2f}（对齐实盘 BacktestGate 的胜率下限）。"
       "`netr`：取训练净 R 最高者（trendsweep 的口径）。三条规则都只使用训练段。")
    ap(f"- 通过标准：测试段总交易数 ≥ {MIN_TEST_TRADES}；"
       f"至少 {int(round(0.8*PRIMARY_FOLDS))}/{PRIMARY_FOLDS} 折测试期望 R > 0；"
       "测试段合计净 R > 0（已扣成本）。")
    ap("- 搜索空间：4 组 EMA × 3 个 rFraction × 4 个 TP × 3 个 minScore × "
       "4 组 RSI 带 × 2 种 entryMode = **1152 组/市场/折**。"
       "cross 模式下 RSI 带与 minScore 不参与信号，因此 1152 组里有大量"
       "等价重复；去重后每个市场每折 624 个唯一模拟。")
    ap("")
    ap("### 多重检验")
    ap("")
    ap(f"每个市场每折从 1152 组中挑训练段最好的一组；{n_complete_markets} 个"
       f"完整市场 × 5 折 = {n_complete_markets*5} 次选参，等价于约 "
       f"{n_complete_markets*1152:,} 个“市场×参数”假设。"
       "即使完全没有 edge，仅靠 5 折中 4 折为正（二项概率 6/32=18.75%）"
       "再叠加合计净 R > 0，也会有可观数量的市场偶然通过。"
       "本报告用置换检验直接模拟这一选择过程：在每个市场/折内打乱训练行与"
       "测试行的对应关系，保持两边边际分布不变，重复 500 次，得到“零假设下"
       "通过市场数”的分布。")
    ap("")

    ap("## 3. 逐市场结果")
    ap("")
    ap("下表为每个市场的样本外汇总。`主5折` 列只用于通过判定（前 5 折；"
       "通过要求 pos ≥ 4/5，表中分母为实际参与判定的折数）；其余统计使用"
       "全部 9 折。`pos` 为测试期望 R > 0 的折数；`netR` 为测试段合计净 R；"
       "`DD` 为逐笔 R 序列的最大回撤；`PF` 为盈亏比。")
    ap("")
    ap("| 市场 | 全部折数 | 主5折笔数 | 主5折 pos | 主5折净R | 全部折笔数 | "
       "全部折净R | 全部折期望R | 胜率 | 最大回撤R | PF | 主5折通过 |")
    ap("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|")
    for _, row in summary.iterrows():
        name = f"{row['symbol']} {row['timeframe']}"
        flag = "是" if row["primary_pass"] else "否"
        if row["primary_insufficient_folds"]:
            flag = "样本不足"
        ap(f"| {name} | {int(row['n_folds'])} | {int(row['primary_test_trades'])} | "
           f"{int(row['primary_pos_folds'])}/{int(row['primary_folds'])} | "
           f"{fmt(row['primary_test_net_r'])} | {int(row['all_test_trades'])} | "
           f"{fmt(row['all_net_r'])} | {fmt(row['all_expectancy_r'],3)} | "
           f"{row['all_win_rate']:.1%} | {fmt(row['all_max_dd_r'])} | "
           f"{fmt(row['all_profit_factor'])} | {flag} |")
    ap("")
    ap("注：所有纳入市场都有 9 个完整折。KORUUSDT 已因 21.2x 合约折算和"
       "历史不足被剔除（见 2.1），不在表中。")
    ap("")

    ap("### 3.1 参数分布：中位组合 vs oracle")
    ap("")
    ap(f"- 全部 {len(u):,} 个唯一“市场×折×参数”样本外结果：测试净 R > 0 仅 "
       f"{test_pos_share:.1%}，中位测试期望 {med_test_exp:+.3f}R。")
    ap(f"- 近似加回每笔 14bp 往返成本后：毛净 R > 0 为 {gross_pos_share:.1%}，"
       f"中位毛期望 {gross_med_exp:+.3f}R；毛 edge 也不为正。")
    ap(f"- 按市场-折看：{n_mf} 个市场-折中，中位组合为正的次数为 "
       f"{median_pos_folds}；但事后最佳组合（oracle）有 {oracle_pos_folds} 个"
       f"为正（{oracle_pos_folds/n_mf:.1%}；5m {oracle_by_tf['5m']:.1%}、"
       f"15m {oracle_by_tf['15m']:.1%}、1h {oracle_by_tf['1h']:.1%}）。")
    ap("- 含义：任何一段测试期里几乎总能事后找到一组赚钱的参数，尤其是 1h；"
       "但事前选择无法稳定捕获，典型参数在每个市场-折都亏。这正是 1152 组搜索"
       "的过拟合陷阱。")
    ap("")

    ap("### 逐折明细（所有市场）")
    ap("")
    ap("每一行是当折在训练段选出的参数及其测试段表现。折 1–5 为主判定折，"
       "折 6–9 为扩展样本外折。`mode` 为 cross 时 RSI 带/minScore 记为 "
       "inert（不参与信号）。")
    ap("")
    ap("| 市场 | 折 | 模式 | EMA | RSI带 | minScore | rFrac | TP | 训练笔数 | "
       "训练期望R | 测试笔数 | 测试胜率 | 测试期望R | 测试净R | 测试回撤R | PF |")
    ap("|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for _, row in selected.iterrows():
        name = f"{row['symbol']} {row['timeframe']}"
        if row["entry_mode"] == "none":
            ap(f"| {name} | {int(row['fold'])+1} | none | - | - | - | - | - | "
               f"0 | - | 0 | - | - | - | - | - |")
            continue
        ap(f"| {name} | {int(row['fold'])+1} | {row['entry_mode']} | "
           f"{int(row['ema_fast'])}/{int(row['ema_slow'])} | {row['rsi_band']} | "
           f"{row['min_score']} | {row['r_fraction']:.3f} | {row['tp_r']:g} | "
           f"{int(row['train_trades'])} | {fmt(row['train_expectancy_r'],3)} | "
           f"{int(row['test_trades'])} | {row['test_win_rate']:.1%} | "
           f"{fmt(row['test_expectancy_r'],3)} | {fmt(row['test_net_r'])} | "
           f"{fmt(row['test_max_dd_r'])} | {fmt(row['test_profit_factor'])} |")
    ap("")

    ap("### 参数稳定性")
    ap("")
    ap("下表统计每个市场在全部 9 折中选出的不同参数组数量，以及众数参数出现的"
       "折数（主判定只用前 5 折）。如果选参稳定，众数占比应较高；如果接近随机，"
       "说明训练段最优只是噪声。")
    ap("")
    ap("| 市场 | 折数 | 不同参数组数 | 众数出现折数 | 众数占比 |")
    ap("|---|---:|---:|---:|---:|")
    for _, row in summary.iterrows():
        ap(f"| {row['symbol']} {row['timeframe']} | {int(row['n_folds'])} | "
           f"{int(row['distinct_selected_params'])} | {int(row['modal_param_count'])} | "
           f"{row['modal_param_share']:.0%} |")
    ap("")

    ap("## 4. 多重检验与选择偏差")
    ap("")
    ap(f"- 训练/测试期望 R 的秩相关中位数 **{rank_med:+.3f}**"
       f"（均值 {rank_mean:+.3f}，正值占比 {rank_pos_share:.1%}，"
       f"样本 {rank_n}）。排名有持续性，但整体水平为负。")
    ap(f"- 分层诊断：把 rFraction 分层后，训练/测试期望 R 的秩相关中位从 "
       f"{rank_med:+.3f} 降到 **{net_within_med:+.3f}**；毛期望整体相关中位 "
       f"{gross_overall_med:+.3f}、分层后 {gross_within_med:+.3f}；"
       f"rFraction 与测试期望的秩相关中位 **{rho_r_med:+.3f}**。"
       "这证明整体排名持续性主要是成本结构（rFraction 越大、成本拖累越小），"
       "而不是可预测的方向性 alpha。")
    ap(f"- 置换检验的通过市场数零分布退化为 "
       f"**{perm.get('null_pass_mean', float('nan')):.0f}**：随机配对下几乎"
       f"没有市场能满足 4/5 折为正；实际 "
       f"**{perm.get('observed_pass', 0)}**，p = "
       f"**{perm.get('p_value_pass_count', float('nan')):.3f}**。该统计量对"
       "“0 通过”不敏感，不能单独作为 edge 证据。")
    if best_row is not None:
        best_extra = (
            f"但未通过 4/5 折一致性，9 折只有 "
            f"{int(best_row['extended_pos_folds'])}/{int(best_row['n_folds'])} "
            f"折为正，参数不稳定，效应量仅 "
            f"{best_row['all_expectancy_r']:+.3f}R/笔"
        )
    else:
        best_extra = "但未通过一致性门槛，效应量很小"
    ap(f"- 更有区分度的“最佳市场合计净 R”：零假设均值 "
       f"{perm.get('null_max_net_mean', float('nan')):.1f}R、95 分位 "
       f"{perm.get('null_max_net_p95', float('nan')):.1f}R；实际最佳 "
       f"**{perm.get('observed_max_net_r', float('nan')):+.2f}R**，"
       f"p = **{perm.get('p_value_max_net', float('nan')):.3f}**。"
       f"这是一个弱信号候选，{best_extra}，不能据此宣称可交易 edge。")
    ap(f"- {n_complete_markets} 个市场 × 9 折的 {len(u):,} 个唯一组合中，"
       f"测试净 R > 0 仅 {test_pos_share:.1%}；事后 oracle 在 1h 的 "
       f"{oracle_by_tf['1h']:.1%} 市场-折为正，但典型组合在每个市场-折的"
       f"中位数都为负（{median_pos_folds}/{n_mf} 为正）。选参能改善相对排名，"
       "但没有把绝对水平推过成本线。")
    ap("")
    ap("解释：通过市场数的零分布退化为 0，说明在当前成本结构下，即使随机配对"
       "也没有市场能满足 4/5 折为正；实际 0 通过并不意外。真正有信息量的是"
       "“最佳市场合计净 R”的 p=0.004，但它对应的市场未通过一致性门槛，且"
       "效应量只有 +0.03R/笔。不要用单市场的最佳统计量替代预注册的通过标准。")
    ap("")

    ap("## 5. 成本分解（BTCUSDT 5m 诊断）")
    ap("")
    ap("为区分“信号本身没 edge”与“信号有边缘但被成本吃掉”，在 BTCUSDT 5m 上"
       "用同一套执行逻辑分别跑四种成本口径（其余参数、窗口、选参规则不变）。"
       "`positive` 是 624 个唯一模拟中训练/测试净 R > 0 的数量（训练笔数 ≥20）。")
    ap("")
    if cost_df is not None and len(cost_df):
        ap("| 成本口径 | 折数 | 训练正netR组合/总 | 测试正netR组合/总 | 训练中位netR | 训练最佳netR | 测试中位netR | 测试最佳netR |")
        ap("|---|---:|---:|---:|---:|---:|---:|---:|")
        for scen, g in cost_df.groupby("scenario", sort=False):
            ap(f"| {scen} | {len(g)} | {int(g.train_positive.sum())}/{int(g.train_combos_ge20.sum()):,} | "
               f"{int(g.test_positive.sum())}/{int(g.test_combos_ge20.sum()):,} | "
               f"{fmt(g.train_median_net_r.median())} | {fmt(g.train_best_net_r.max())} | "
               f"{fmt(g.test_median_net_r.median())} | {fmt(g.test_best_net_r.max())} |")
        ap("")
        zero = cost_df[cost_df["scenario"] == "zero_cost"]
        fees = cost_df[cost_df["scenario"] == "fees_only"]
        slip = cost_df[cost_df["scenario"] == "slippage_only"]
        both = cost_df[cost_df["scenario"] == "fees_and_slippage"]

        def _pos(d, key):
            total = max(1, int(d[key].sum()))
            pos = int(d["train_positive"].sum()) if key == "train_combos_ge20" \
                else int(d["test_positive"].sum())
            return pos, total, pos / total

        ztr, ztrn, ztrp = _pos(zero, "train_combos_ge20")
        zte, zten, ztep = _pos(zero, "test_combos_ge20")
        ftr, ftrn, _ = _pos(fees, "train_combos_ge20")
        str_, strn, _ = _pos(slip, "train_combos_ge20")
        ste, sten, _ = _pos(slip, "test_combos_ge20")
        btr, btrn, _ = _pos(both, "train_combos_ge20")
        bte, bten, _ = _pos(both, "test_combos_ge20")
        ap(f"解读：零成本下也只有 {ztr:,}/{ztrn:,}（{ztrp:.1%}）训练组合和 "
           f"{zte:,}/{zten:,}（{ztep:.1%}）测试组合为正，中位净 R 仍为负"
           f"（训练 {fmt(zero.train_median_net_r.median())}R、"
           f"测试 {fmt(zero.test_median_net_r.median())}R）。也就是说，"
           "**毛 edge 本身就不为正**，并非只是成本问题。只加 taker 费后训练段 "
           f"{ftr:,}/{ftrn:,} 为正；滑点单独也只有 {str_:,}/{strn:,} 训练、"
           f"{ste:,}/{sten:,} 测试为正；两者同时只有 {btr:,}/{btrn:,} 训练、"
           f"{bte:,}/{bten:,} 测试为正。对 0.4%–1.2% 的止损，0.10% 往返"
           " taker 费分别相当于 0.25R–0.083R/笔，进一步放大了负期望。")
    else:
        ap("（未运行成本诊断。）")
    ap("")

    ap("## 6. 资金费（未计入主口径）")
    ap("")
    ap("用户指定成本只含 taker + 滑点，主通过标准不含资金费。下表给出各币种"
       "历史资金费的中位数，以及一次 8 小时资金费折算成 R 的大致成本"
       "（多头支付正费率时；空头方向相反）。")
    ap("")
    if funding_df is not None and len(funding_df):
        ap("| 币种 | 资金费样本 | 中位费率/8h | 年化中位 | 折算R@0.4% | 折算R@0.8% | 折算R@1.2% |")
        ap("|---|---:|---:|---:|---:|---:|---:|")
        for _, row in funding_df.iterrows():
            ap(f"| {row['symbol']} | {int(row['n_payments'])} | {row['median_rate']*100:.4f}% | "
               f"{row['annualized_median']*100:.1f}% | {row['long_cost_r_at_0.4pct']:.3f} | "
               f"{row['long_cost_r_at_0.8pct']:.3f} | {row['long_cost_r_at_1.2pct']:.3f} |")
        ap("")
        ap("一笔持仓跨越 1–3 个资金费点时，成本量级约 0.01R–0.1R；这通常不足以"
           "把本报告里 −0.2R/笔左右的样本外结果翻正，但会进一步压低边缘。"
           "若策略长期偏多且费率为正，资金费是额外逆风。")
    else:
        ap("（未找到资金费文件。）")
    ap("")

    ap("## 7. 风险与局限")
    ap("")
    ap(f"- **多重检验/选择偏差**：每个市场每折 1152 组，"
       f"{n_complete_markets} 个市场共约 {n_complete_markets*1152:,} 个"
       "市场×参数假设；训练段最优极易是噪声。报告用置换检验量化了这一点。")
    ap(f"- **参数不稳定**：9 折中典型市场选出 5–9 组不同参数，众数只出现"
       " 1–4 折（见参数稳定性表）；"
       f"{best_name} 也选出多组不同参数。训练段最优随折漂移，说明选参对噪声"
       "敏感。")
    ap(f"- **oracle 幻觉**：事后最佳参数在 1h 有 {oracle_by_tf['1h']:.1%} 的"
       f"市场-折为正，但事前选出的典型组合在每个市场-折中位为负。不要把 "
       "oracle 结果当成可实现收益。")
    ap("- **成本**：每边 0.05% taker + 0.02% 滑点。对 0.4% 止损，往返成本约 "
       "0.35R；对 0.8% 止损约 0.175R。高频/小止损组合对成本极其敏感。"
       "第 5 节给出了 BTCUSDT 5m 的成本分解。")
    ap("- **资金费未计入主口径**：见第 6 节；180 天永续合约资金费会进一步"
       "侵蚀或增厚收益，方向取决于多空和费率符号。")
    ap("- **窗口边界强制平仓**：每个训练/测试窗口结束时按最后收盘价平仓。"
       "这避免了跨窗口泄漏，但会给边界交易带来额外成本；对 15 天测试段，"
       "边界效应不可忽略。")
    ap("- **执行假设**：止损/止盈按 bar 高/低触发，同根双触按止损计；"
       "未模拟盘口深度、部分成交、交易所条件单延迟、跳空以外的流动性冲击。")
    ap("- **杠杆/强平**：策略配置可能使用 3–100 倍杠杆；0.4% 止损在 100 倍"
       "逐仓下可能落在强平价之外，实盘会被 `StopWithinLiquidation` 拒绝。"
       "本回测按固定名义本金和 R 计，未模拟杠杆与强平。")
    ap("- **样本期**：只有 180 天（2026-04-20 至 2026-10-17），覆盖的市场状态"
       "有限；结论不能外推到其他年份或极端行情。")
    ap("- **KORUUSDT**：2026-07-15 的 21.2x 合约折算会在原始价格上制造假的"
       "−95% 跳变，且只有约 117 天历史；已整体剔除，不用调整后的数据硬凑结果"
       "（见 2.1）。")
    ap("- **数据质量**：数据来自币安 USDT-M 公开 K 线，已检查无缺口/重复/"
       "非正价格；但未与交易所逐笔成交或标记价格交叉验证。")
    ap("")
    ap("## 8. 复现")
    ap("")
    ap("```bash")
    ap("python research/trend/backtest.py")
    ap("```")
    ap("")
    ap("输出：`research/trend/results.csv`（全部 1152 组逐折训练/测试结果）、"
       "`selected_walkforward.csv`、`market_summary.csv`、`null_test.json`、"
       "`funding_summary.csv`、`cost_diagnostic.csv`、"
       "`parameter_distribution.csv`（逐市场-折的中位/oracle 统计，由 "
       "results.csv 派生）、本报告。")
    ap("")

    with open(os.path.join(OUT_DIR, "report.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="*", default=SYMBOLS)
    ap.add_argument("--timeframes", nargs="*", default=TIMEFRAMES)
    ap.add_argument("--folds", type=int, default=None,
                    help="limit folds (debug)")
    ap.add_argument("--quick", action="store_true",
                    help="BTCUSDT 5m, 2 folds")
    ap.add_argument("--perm", type=int, default=500,
                    help="permutation repetitions")
    ap.add_argument("--allow-koru", action="store_true",
                    help="DANGEROUS: include raw KORUUSDT (21.2x contract "
                         "adjustment contaminates the series)")
    ap.add_argument("--report-only", action="store_true",
                    help="regenerate report.md from existing CSV/JSON outputs")
    args = ap.parse_args()

    if args.report_only:
        summary = pd.read_csv(os.path.join(OUT_DIR, "market_summary.csv"))
        selected = pd.read_csv(os.path.join(OUT_DIR, "selected_walkforward.csv"))
        results = pd.read_csv(os.path.join(OUT_DIR, "results.csv"))
        funding_path = os.path.join(OUT_DIR, "funding_summary.csv")
        cost_path = os.path.join(OUT_DIR, "cost_diagnostic.csv")
        funding_df = (pd.read_csv(funding_path)
                      if os.path.exists(funding_path) else pd.DataFrame())
        cost_df = (pd.read_csv(cost_path)
                   if os.path.exists(cost_path) else pd.DataFrame())
        with open(os.path.join(OUT_DIR, "null_test.json"), encoding="utf-8") as fh:
            diag = json.load(fh)
        write_report("exp", summary, selected, results,
                     diag.get("rank", {}), diag.get("permutation", {}),
                     float(diag.get("elapsed_sec", 0.0)),
                     funding_df=funding_df, cost_df=cost_df)
        print("report regenerated from existing outputs")
        return

    symbols = args.symbols
    tfs = args.timeframes
    fold_limit = args.folds
    if args.quick:
        symbols = ["BTCUSDT"]
        tfs = ["5m"]
        fold_limit = 2
    if "KORUUSDT" in symbols and not args.allow_koru:
        print("WARNING: KORUUSDT excluded: 2026-07-15 contract adjustment "
              "(~21.2x) and only ~117 days of history; pass --allow-koru only "
              "if you know the raw series is unusable.", flush=True)
        symbols = [s for s in symbols if s != "KORUUSDT"]

    t0 = time.time()
    print("loading and precomputing markets", flush=True)
    runs = run_all(symbols, tfs, fold_limit=fold_limit)
    print(f"all markets done in {time.time()-t0:.1f}s", flush=True)

    # Primary rule: pure training-expectancy selection (always selects a
    # config with >= MIN_TRAIN_TRADES).  Live-gated and netR-ranked selection
    # are sensitivities computed from the same stored stats (no re-simulation).
    selected_by_rule: dict[str, dict[int, list[int]]] = {}
    for rule in ("exp", "live", "netr"):
        selected_by_rule[rule] = {}
        for run in runs:
            selected_by_rule[rule][id(run)] = [
                select_sim(run, k, rule) for k in range(run.n_folds)
            ]

    rule = "exp"
    results = results_dataframe(runs, selected_by_rule, rule)
    summary, selected = market_summary_table(runs, selected_by_rule, rule)

    # Sensitivity: pass counts under the other selection rules.
    sens = []
    for r in ("live", "exp", "netr"):
        prim = ext = insufficient = 0
        for run in runs:
            sel = selected_by_rule[r][id(run)]
            evp = evaluate_selection(run, sel, list(range(min(PRIMARY_FOLDS, run.n_folds))))
            eva = evaluate_selection(run, sel, list(range(run.n_folds)))
            if run.n_folds < PRIMARY_FOLDS:
                insufficient += 1
                continue
            prim += int(evp["pass"])
            ext += int(eva["pass"])
        sens.append({"rule": r, "primary_pass": prim, "extended_pass": ext,
                     "insufficient": insufficient})

    rank = rank_diagnostics(runs, rule)
    # Observed primary pass count and max selected netR (for permutation).
    observed_pass = int(((~summary["primary_insufficient_folds"])
                         & summary["primary_pass"]).sum())
    eligible_summary = summary[~summary["primary_insufficient_folds"]]
    observed_max_net = (float(eligible_summary["primary_test_net_r"].max())
                        if len(eligible_summary) else float("nan"))
    perm = permutation_test(runs, observed_pass, observed_max_net,
                            rule=rule, n_perm=args.perm)
    elapsed = time.time() - t0

    results_path = os.path.join(OUT_DIR, "results.csv")
    results.to_csv(results_path, index=False, float_format="%.6f")
    param_path = os.path.join(OUT_DIR, "parameter_distribution.csv")
    parameter_distribution(results, param_path)
    selected_path = os.path.join(OUT_DIR, "selected_walkforward.csv")
    selected.to_csv(selected_path, index=False, float_format="%.6f")
    summary_path = os.path.join(OUT_DIR, "market_summary.csv")
    summary.drop(columns=["selected_keys"]).to_csv(
        summary_path, index=False, float_format="%.6f")
    funding_df = funding_summary(sorted({run.market.symbol for run in runs}))
    funding_path = os.path.join(OUT_DIR, "funding_summary.csv")
    funding_df.to_csv(funding_path, index=False, float_format="%.8f")
    if args.quick:
        cost_df = pd.DataFrame()
    else:
        print("running cost diagnostic (BTCUSDT 5m, primary folds)", flush=True)
        cost_df = cost_diagnostic()
    cost_path = os.path.join(OUT_DIR, "cost_diagnostic.csv")
    cost_df.to_csv(cost_path, index=False, float_format="%.6f")
    null_path = os.path.join(OUT_DIR, "null_test.json")
    with open(null_path, "w", encoding="utf-8") as fh:
        json.dump({
            "permutation": perm,
            "rank": {
                "spearman_n": len(rank.get("spearman") or []),
                "spearman_median": (float(np.median(rank["spearman"]))
                                    if rank.get("spearman") else None),
                "spearman_mean": (float(np.mean(rank["spearman"]))
                                  if rank.get("spearman") else None),
                "spearman_positive_share": (float(np.mean(
                    np.array(rank["spearman"]) > 0))
                    if rank.get("spearman") else None),
                "selected_percentile_median": (float(np.median(
                    rank["selected_test_percentile"]))
                    if rank.get("selected_test_percentile") else None),
                "selected_percentile_top25_share": (float(np.mean(
                    np.array(rank["selected_test_percentile"]) >= 0.75))
                    if rank.get("selected_test_percentile") else None),
                "spearman": rank.get("spearman", []),
                "selected_test_percentile": rank.get(
                    "selected_test_percentile", []),
            },
            "selection_rule_sensitivity": sens,
            "elapsed_sec": elapsed,
        }, fh, ensure_ascii=False, indent=2)

    write_report(rule, summary, selected, results, rank, perm, elapsed,
                 funding_df=funding_df, cost_df=cost_df)
    print(f"wrote {results_path} ({os.path.getsize(results_path)/1e6:.1f} MB)")
    print(f"wrote {selected_path}")
    print(f"wrote {summary_path}")
    print(f"wrote {null_path}")
    print(f"wrote {funding_path}")
    print(f"wrote {cost_path}")
    print(f"wrote {param_path}")
    print(f"wrote {os.path.join(OUT_DIR, 'report.md')}")
    print(f"done in {elapsed/60:.1f} min")


if __name__ == "__main__":
    main()
