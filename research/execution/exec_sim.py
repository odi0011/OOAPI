#!/usr/bin/env python
"""Execution-cost study: market entry vs post-only maker entry.

Question
--------
Every strategy tested so far died on the 14bp round-trip cost
(taker 5bp + 2bp slippage per side).  This script keeps the signal and the
exit rule fixed and varies ONLY the entry execution:

  A  market at next bar open, taker 5bp + adverse slippage 2bp per side
  B  post-only limit at the signal-bar close, filled only if a future bar
     trades through the limit, cancelled after N bars (N = 1/3/6)
  C  post-only limit 10bp away from the signal close (more conservative),
     cancelled after N bars
  D  market entry + BNB fee discount / VIP rebate (sensitivity only;
     assumptions are printed in the report)

Exits are identical across variants: every exit is taker 5bp + 2bp adverse
slippage.  Signals are the existing defaults, NOT re-tuned:

  ema_cross_9_21_1h   EMA(9/21) cross, 1h, reverse-cross exit, 1R stop
                      (R = 0.8%, server DefaultRFraction), 1.5R take profit
  donchian55_1h       close beyond prior 55-bar high/low, 1h, exit when the
                      close crosses the channel midline (existing
                      A_N55_trend0_mid combo), no stop
  donchian55_atr2_1h  same signal, fixed 2*ATR(14) stop instead of mid exit
                      (existing A_N55_trend0_atr2_fx combo) -- robustness
  ema_rsi_12_26_15m   EMA(12/26) + RSI(14) trend score, 15m, server defaults
                      (RSI 50-70 / 30-50, minScore 3, 0.05% EMA gap,
                      volume > prior-20 average, 15m agreement),
                      reverse-cross exit, 1R stop, 1.5R take profit

Adverse selection
-----------------
A limit fill is not the same trade as a market entry.  For every signal we
measure (a) the directional move from the fill price to the fill-bar close
and (b) the directional move of the next bar.  Filled limit signals are
compared with the market counterfactual on the same signals and with all
market signals.  The P&L of a filled limit trade is also compared with the
market counterfactual on the same signal (paired, same exit rule), so the
net improvement is not assumed.

Validation
----------
180 days, split 120 days calibration / 60 days holdout.  Nothing is tuned:
the same fixed signal and exit parameters are run on both segments.  Flat
at every segment boundary; the holdout is never used for selection.

Outputs (research/execution/):
  exec_sim.py
  results.csv
  report.md

Run:
  python research/execution/exec_sim.py
"""
from __future__ import annotations

import bisect
import math
import os
from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA_DIR = os.path.join(ROOT, "research", "data", "klines")
OUT_DIR = HERE

# Clean universe: KORUUSDT is excluded (21.2x contract adjustment on
# 2026-07-15 in the raw klines is a fake -95% move, and it has < 120 days).
SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "LINKUSDT",
]
TF_MS = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000}

# Cost model (USDT-M futures, as used by the previous studies).
TAKER_FEE = 0.0005
MAKER_FEE = 0.0002
SLIPPAGE = 0.0002
EXIT_COST_BP = (TAKER_FEE + SLIPPAGE) * 1e4  # 7bp, always

# Server / previous-study defaults.  Fixed; no search.
R_FRACTION = 0.008
STOP_R = 1.0
TP_R = 1.5
EMA_GAP_FRACTION = 0.0005
RSI_PERIOD = 14
VOLUME_LOOKBACK = 20
RSI_LONG_MIN, RSI_LONG_MAX = 50.0, 70.0
RSI_SHORT_MIN, RSI_SHORT_MAX = 30.0, 50.0
MIN_SCORE = 3

DONCHIAN_N = 55
ATR_PERIOD = 14
DONCHIAN_STOP_ATR = 2.0

# 180 days: 120-day calibration / 60-day holdout.  Fixed UTC boundary.
SPLIT_MS = int(pd.Timestamp("2026-08-18 00:00:00", tz="UTC").value // 1_000_000)
SEGMENTS = ["calib", "holdout"]

# Limit variants.  penetration = extra adverse move (in price fraction)
# required beyond the limit before we assume a fill, a crude queue-position
# proxy.  It is a robustness check, not the headline assumption.
VARIANTS = [
    dict(key="A_market", label="A market (taker 5bp + 2bp slip)",
         kind="market", taker=TAKER_FEE, slip=SLIPPAGE, maker=0.0),
    dict(key="D_market_bnb10", label="D market, BNB 10% fee discount (assumption)",
         kind="market", taker=TAKER_FEE * 0.9, slip=SLIPPAGE, maker=0.0),
    dict(key="D_market_vip20", label="D market, 20% fee rebate (assumption)",
         kind="market", taker=TAKER_FEE * 0.8, slip=SLIPPAGE, maker=0.0),
    dict(key="B_postonly_N1", label="B post-only at close, N=1",
         kind="limit", n_bars=1, offset=0.0, penetration=0.0,
         maker=MAKER_FEE, taker=TAKER_FEE, slip=SLIPPAGE),
    dict(key="B_postonly_N3", label="B post-only at close, N=3",
         kind="limit", n_bars=3, offset=0.0, penetration=0.0,
         maker=MAKER_FEE, taker=TAKER_FEE, slip=SLIPPAGE),
    dict(key="B_postonly_N6", label="B post-only at close, N=6",
         kind="limit", n_bars=6, offset=0.0, penetration=0.0,
         maker=MAKER_FEE, taker=TAKER_FEE, slip=SLIPPAGE),
    dict(key="B_postonly_pen1bp_N3",
         label="B post-only at close, N=3, 1bp penetration required",
         kind="limit", n_bars=3, offset=0.0, penetration=0.0001,
         maker=MAKER_FEE, taker=TAKER_FEE, slip=SLIPPAGE),
    dict(key="C_limit10bp_N1", label="C limit 10bp away, N=1",
         kind="limit", n_bars=1, offset=0.001, penetration=0.0,
         maker=MAKER_FEE, taker=TAKER_FEE, slip=SLIPPAGE),
    dict(key="C_limit10bp_N3", label="C limit 10bp away, N=3",
         kind="limit", n_bars=3, offset=0.001, penetration=0.0,
         maker=MAKER_FEE, taker=TAKER_FEE, slip=SLIPPAGE),
    dict(key="C_limit10bp_N6", label="C limit 10bp away, N=6",
         kind="limit", n_bars=6, offset=0.001, penetration=0.0,
         maker=MAKER_FEE, taker=TAKER_FEE, slip=SLIPPAGE),
    dict(key="B_postonly_N3_maker0",
         label="sensitivity: B N=3 with 0bp maker fee (rebate assumption)",
         kind="limit", n_bars=3, offset=0.0, penetration=0.0,
         maker=0.0, taker=TAKER_FEE, slip=SLIPPAGE),
]
VAR_BY_KEY = {v["key"]: v for v in VARIANTS}
PRIMARY_VARIANTS = [
    "A_market", "B_postonly_N1", "B_postonly_N3", "B_postonly_N6",
    "C_limit10bp_N1", "C_limit10bp_N3", "C_limit10bp_N6",
]


# ---------------------------------------------------------------------------
# Indicators (same implementations as research/trend and research/breakout)
# ---------------------------------------------------------------------------


def ema(values: np.ndarray, period: int) -> np.ndarray:
    """SMA-seeded EMA, identical to trading.EMA."""
    n = values.size
    out = np.full(n, np.nan, dtype=np.float64)
    if n < period:
        return out
    seed = float(values[:period].mean())
    out[period - 1] = seed
    k = 2.0 / (period + 1.0)
    prev = seed
    for i in range(period, n):
        prev = k * values[i] + (1.0 - k) * prev
        out[i] = prev
    return out


def rsi_wilder(closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder RSI, SMA seed then smoothing, matching trading.LastRSI."""
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
        return 100.0 - 100.0 / (1.0 + g / l)

    out[period] = value(avg_gain, avg_loss)
    alpha = 1.0 - 1.0 / period
    beta = 1.0 / period
    for i in range(period + 1, n):
        avg_gain = alpha * avg_gain + beta * gains[i - 1]
        avg_loss = alpha * avg_loss + beta * losses[i - 1]
        out[i] = value(avg_gain, avg_loss)
    return out


def volume_above(volume: np.ndarray, lookback: int = 20) -> np.ndarray:
    """last volume > mean of the previous `lookback` volumes."""
    n = volume.size
    flag = np.zeros(n, dtype=bool)
    if n <= lookback:
        return flag
    csum = np.concatenate(([0.0], np.cumsum(volume, dtype=np.float64)))
    prev_sum = csum[lookback:n] - csum[: n - lookback]
    avg = prev_sum / float(lookback)
    flag[lookback:] = (avg > 0.0) & (volume[lookback:] > avg)
    return flag


def wilder_atr(high: np.ndarray, low: np.ndarray, close: np.ndarray,
               n: int = 14) -> np.ndarray:
    prev_close = np.roll(close, 1)
    prev_close[0] = close[0]
    tr = np.maximum(high - low,
                    np.maximum(np.abs(high - prev_close),
                               np.abs(low - prev_close)))
    return pd.Series(tr).ewm(alpha=1.0 / n, adjust=False).mean().to_numpy()


def next_true(cond: np.ndarray) -> np.ndarray:
    """For every i, first j >= i with cond[j]; n if none."""
    n = cond.size
    out = np.full(n, n, dtype=np.int32)
    nxt = n
    for i in range(n - 1, -1, -1):
        if cond[i]:
            nxt = i
        out[i] = nxt
    return out


# ---------------------------------------------------------------------------
# Data and strategies
# ---------------------------------------------------------------------------


def load_klines(symbol: str, tf: str) -> pd.DataFrame:
    path = os.path.join(DATA_DIR, f"{symbol}_{tf}.csv")
    df = pd.read_csv(path)
    required = ["open_time", "open", "high", "low", "close", "volume"]
    df = df.sort_values("open_time").drop_duplicates("open_time")
    for col in required:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=required)
    df = df[(df[["open", "high", "low", "close"]] > 0).all(axis=1)]
    return df.reset_index(drop=True)


@dataclass
class Bars:
    symbol: str
    tf: str
    open_time: np.ndarray
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    v: np.ndarray
    n: int


def make_bars(symbol: str, tf: str) -> Bars:
    df = load_klines(symbol, tf)
    return Bars(
        symbol=symbol, tf=tf,
        open_time=df["open_time"].to_numpy(np.int64),
        o=df["open"].to_numpy(np.float64),
        h=df["high"].to_numpy(np.float64),
        l=df["low"].to_numpy(np.float64),
        c=df["close"].to_numpy(np.float64),
        v=df["volume"].to_numpy(np.float64),
        n=len(df),
    )


@dataclass
class SymStrat:
    """One strategy on one symbol: signals plus everything needed to exit."""
    key: str
    label: str
    symbol: str
    tf: str
    b: Bars
    sig_bars: np.ndarray
    sig_dirs: np.ndarray
    exit_long: np.ndarray     # first j >= i with an exit signal for a long
    exit_short: np.ndarray
    exit_kind: str            # "reverse" or "mid"
    stop_kind: str            # "r" or "atr"
    atr: Optional[np.ndarray] = None
    stop_atr_mult: float = DONCHIAN_STOP_ATR
    tp_mult: Optional[float] = TP_R

    def segment_bounds(self) -> list[tuple[str, int, int]]:
        split = int(np.searchsorted(self.b.open_time, SPLIT_MS, side="left"))
        return [("calib", 0, split), ("holdout", split, self.b.n)]


def build_ema_cross(symbol: str, tf: str, fast: int, slow: int) -> SymStrat:
    b = make_bars(symbol, tf)
    f = ema(b.c, fast)
    s = ema(b.c, slow)
    diff = f - s
    n = b.n
    golden = np.zeros(n, dtype=bool)
    death = np.zeros(n, dtype=bool)
    valid = np.isfinite(diff)
    both = valid[1:] & valid[:-1]
    golden[1:] = both & (diff[:-1] <= 0.0) & (diff[1:] > 0.0)
    death[1:] = both & (diff[:-1] >= 0.0) & (diff[1:] < 0.0)
    side = np.zeros(n, dtype=np.int8)
    side[golden] = 1
    side[death] = -1
    sig = np.flatnonzero(side != 0)
    return SymStrat(
        key=f"ema_cross_{fast}_{slow}_{tf}",
        label=f"EMA({fast}/{slow}) cross, {tf}",
        symbol=symbol, tf=tf, b=b,
        sig_bars=sig.astype(np.int32), sig_dirs=side[sig].astype(np.int8),
        exit_long=next_true(death), exit_short=next_true(golden),
        exit_kind="reverse", stop_kind="r",
        atr=None, tp_mult=TP_R,
    )


def build_donchian(symbol: str, tf: str, n_don: int,
                   atr_stop: bool) -> SymStrat:
    b = make_bars(symbol, tf)
    hs = pd.Series(b.h)
    ls = pd.Series(b.l)
    upper = hs.rolling(n_don).max().shift(1).to_numpy()
    lower = ls.rolling(n_don).min().shift(1).to_numpy()
    mid = (upper + lower) / 2.0
    long_sig = np.isfinite(upper) & (b.c > upper)
    short_sig = np.isfinite(lower) & (b.c < lower)
    dirs = np.zeros(b.n, dtype=np.int8)
    dirs[long_sig] = 1
    dirs[short_sig & ~long_sig] = -1
    sig = np.flatnonzero(dirs != 0)
    atr = wilder_atr(b.h, b.l, b.c, ATR_PERIOD)
    exit_long = next_true(np.isfinite(mid) & (b.c < mid))
    exit_short = next_true(np.isfinite(mid) & (b.c > mid))
    if atr_stop:
        key = f"donchian{n_don}_atr2_{tf}"
        label = f"Donchian {n_don} breakout, {tf}, 2xATR stop"
        stop_kind = "atr"
        exit_kind = "stop_only"
        # stop_only: no signal exit.  Use a never-true exit array.
        exit_long = np.full(b.n, b.n, dtype=np.int32)
        exit_short = np.full(b.n, b.n, dtype=np.int32)
        tp_mult = None
    else:
        key = f"donchian{n_don}_mid_{tf}"
        label = f"Donchian {n_don} breakout, {tf}, mid-channel exit"
        stop_kind = "none"
        exit_kind = "mid"
        tp_mult = None
    return SymStrat(
        key=key, label=label, symbol=symbol, tf=tf, b=b,
        sig_bars=sig.astype(np.int32), sig_dirs=dirs[sig].astype(np.int8),
        exit_long=exit_long, exit_short=exit_short,
        exit_kind=exit_kind, stop_kind=stop_kind,
        atr=atr, stop_atr_mult=DONCHIAN_STOP_ATR, tp_mult=tp_mult,
    )


def build_ema_rsi(symbol: str, fast: int, slow: int, tf: str) -> SymStrat:
    """EMA direction + RSI band + volume + 15m agreement, server defaults."""
    b = make_bars(symbol, tf)
    f = ema(b.c, fast)
    s = ema(b.c, slow)
    diff = f - s
    n = b.n
    rsi = rsi_wilder(b.c, RSI_PERIOD)
    vol = volume_above(b.v, VOLUME_LOOKBACK)
    # For a 15m strategy the higher-timeframe feed is the same 15m series;
    # the last closed bar at each strategy close is the current bar.
    htf = np.sign(diff)
    gap = EMA_GAP_FRACTION * b.c
    valid = np.isfinite(diff)
    long_base = valid & (diff >= gap)
    short_base = valid & (-diff >= gap)
    rsi_long = np.isfinite(rsi) & (rsi >= RSI_LONG_MIN) & (rsi <= RSI_LONG_MAX)
    rsi_short = np.isfinite(rsi) & (rsi >= RSI_SHORT_MIN) & (rsi <= RSI_SHORT_MAX)
    score_long = 1 + rsi_long.astype(np.int8) + vol.astype(np.int8) + (htf == 1).astype(np.int8)
    score_short = 1 + rsi_short.astype(np.int8) + vol.astype(np.int8) + (htf == -1).astype(np.int8)
    side = np.zeros(n, dtype=np.int8)
    side[long_base & (score_long >= MIN_SCORE)] = 1
    side[short_base & (score_short >= MIN_SCORE)] = -1
    sig = np.flatnonzero(side != 0)
    golden = np.zeros(n, dtype=bool)
    death = np.zeros(n, dtype=bool)
    both = valid[1:] & valid[:-1]
    golden[1:] = both & (diff[:-1] <= 0.0) & (diff[1:] > 0.0)
    death[1:] = both & (diff[:-1] >= 0.0) & (diff[1:] < 0.0)
    return SymStrat(
        key=f"ema_rsi_{fast}_{slow}_{tf}",
        label=f"EMA({fast}/{slow})+RSI trend, {tf}",
        symbol=symbol, tf=tf, b=b,
        sig_bars=sig.astype(np.int32), sig_dirs=side[sig].astype(np.int8),
        exit_long=next_true(death), exit_short=next_true(golden),
        exit_kind="reverse", stop_kind="r",
        atr=None, tp_mult=TP_R,
    )


# ---------------------------------------------------------------------------
# Entry / exit simulation
# ---------------------------------------------------------------------------


@dataclass
class Entry:
    bar: int
    price: float
    fee: float
    cost_bp: float
    fill_lag: int
    market_raw: float   # raw price of the market counterfactual at s+1


def try_entry(st: SymStrat, signal_idx: int, direction: int,
              var: dict, seg_end: int) -> Optional[Entry]:
    b = st.b
    s = signal_idx
    if var["kind"] == "market":
        e = s + 1
        if e >= seg_end:
            return None
        raw = b.o[e]
        slip = var["slip"]
        px = raw * (1.0 + slip) if direction > 0 else raw * (1.0 - slip)
        return Entry(e, float(px), var["taker"],
                     (var["taker"] + slip) * 1e4, 0, float(raw))

    # post-only limit
    limit = b.c[s]
    if var["offset"]:
        limit = limit * (1.0 - var["offset"]) if direction > 0 else \
            limit * (1.0 + var["offset"])
    last = min(s + var["n_bars"], seg_end - 1)
    pen = var["penetration"]
    for k in range(s + 1, last + 1):
        if direction > 0:
            if b.l[k] <= limit * (1.0 - pen):
                return Entry(k, float(limit), var["maker"],
                             var["maker"] * 1e4, k - s, float(b.o[s + 1]))
        else:
            if b.h[k] >= limit * (1.0 + pen):
                return Entry(k, float(limit), var["maker"],
                             var["maker"] * 1e4, k - s, float(b.o[s + 1]))
    return None


def resolve_check_from(st: SymStrat, entry_kind: str, entry_bar: int) -> int:
    return entry_bar if entry_kind == "market" else entry_bar + 1


def exit_trade(st: SymStrat, direction: int, entry_bar: int, entry_px: float,
               signal_idx: int, seg_end: int, check_from: int):
    b = st.b
    force = seg_end - 1
    nxt = st.exit_long if direction > 0 else st.exit_short
    rev_sig = int(nxt[entry_bar])
    rev_exec = rev_sig + 1 if rev_sig < b.n else b.n

    stop = None
    tp = None
    if st.stop_kind == "r":
        risk = entry_px * R_FRACTION * STOP_R
        stop = entry_px - risk if direction > 0 else entry_px + risk
        if st.tp_mult is not None:
            tp = entry_px + st.tp_mult * risk if direction > 0 else \
                entry_px - st.tp_mult * risk
    elif st.stop_kind == "atr":
        risk = st.atr[signal_idx] * st.stop_atr_mult
        stop = entry_px - risk if direction > 0 else entry_px + risk
        if st.tp_mult is not None:
            tp = entry_px + st.tp_mult * risk if direction > 0 else \
                entry_px - st.tp_mult * risk

    j_end = min(force, rev_exec - 1)
    if check_from <= j_end:
        o, h, l = b.o, b.h, b.l
        for j in range(check_from, j_end + 1):
            if direction > 0:
                if stop is not None:
                    if o[j] <= stop:
                        return j, float(o[j]), "stop_gap"
                    if l[j] <= stop:
                        return j, float(stop), "stop"
                if tp is not None:
                    # take-profit fills at the take level even on a favorable
                    # gap, matching research/trend/backtest.py
                    if h[j] >= tp:
                        return j, float(tp), "tp"
            else:
                if stop is not None:
                    if o[j] >= stop:
                        return j, float(o[j]), "stop_gap"
                    if h[j] >= stop:
                        return j, float(stop), "stop"
                if tp is not None:
                    if l[j] <= tp:
                        return j, float(tp), "tp"

    if rev_exec <= force:
        return rev_exec, float(b.o[rev_exec]), st.exit_kind
    return force, float(b.c[force]), "force"


def net_bp(direction: int, entry_px: float, entry_fee: float,
           exit_px: float, exit_fee: float) -> float:
    if direction > 0:
        net = exit_px * (1.0 - exit_fee) / entry_px - (1.0 + entry_fee)
    else:
        net = (1.0 - entry_fee) - exit_px * (1.0 + exit_fee) / entry_px
    return float(net * 1e4)


def run_variant(st: SymStrat, var: dict, seg_start: int, seg_end: int):
    """Sequential one-position engine.  Returns (trades, actionable)."""
    b = st.b
    sig_bars = st.sig_bars
    trades = []
    actionable = 0
    pos = int(np.searchsorted(sig_bars, seg_start, side="left"))
    nsig = sig_bars.size
    while pos < nsig:
        s = int(sig_bars[pos])
        if s + 1 >= seg_end:
            break
        direction = int(st.sig_dirs[pos])
        actionable += 1
        ent = try_entry(st, s, direction, var, seg_end)
        if ent is None:
            pos += 1
            continue

        check_from = resolve_check_from(st, var["kind"], ent.bar)
        exit_bar, exit_raw, reason = exit_trade(
            st, direction, ent.bar, ent.price, s, seg_end, check_from)
        exit_px = exit_raw * (1.0 - SLIPPAGE) if direction > 0 else \
            exit_raw * (1.0 + SLIPPAGE)
        nb = net_bp(direction, ent.price, ent.fee, exit_px, TAKER_FEE)

        # Paired market counterfactual for limit entries: same signal, same
        # exit rule, market entry at the next open.
        cf_net = np.nan
        cf_entry_px_gain = np.nan
        if var["kind"] == "limit":
            mkt = try_entry(st, s, direction, VAR_BY_KEY["A_market"], seg_end)
            if mkt is not None:
                cf_check = resolve_check_from(st, "market", mkt.bar)
                cf_xbar, cf_xraw, _ = exit_trade(
                    st, direction, mkt.bar, mkt.price, s, seg_end, cf_check)
                cf_xpx = cf_xraw * (1.0 - SLIPPAGE) if direction > 0 else \
                    cf_xraw * (1.0 + SLIPPAGE)
                cf_net = net_bp(direction, mkt.price, mkt.fee, cf_xpx, TAKER_FEE)
                if direction > 0:
                    cf_entry_px_gain = (mkt.market_raw / ent.price - 1.0) * 1e4
                else:
                    cf_entry_px_gain = (ent.price / mkt.market_raw - 1.0) * 1e4

        gross = (exit_px / ent.price - 1.0) if direction > 0 else \
            (1.0 - exit_px / ent.price)
        trades.append(dict(
            strategy=st.key, variant=var["key"], segment="",
            symbol=st.symbol, signal_bar=s, entry_bar=ent.bar,
            exit_bar=exit_bar, direction=direction,
            net_bp=nb, gross_bp=gross * 1e4,
            entry_cost_bp=ent.cost_bp, exit_cost_bp=EXIT_COST_BP,
            roundtrip_cost_bp=ent.cost_bp + EXIT_COST_BP,
            hold_bars=exit_bar - ent.bar + 1,
            fill_lag=ent.fill_lag, reason=reason,
            cf_market_net_bp=cf_net,
            cf_entry_px_gain_bp=cf_entry_px_gain,
            maker_entry=1 if var["kind"] == "limit" else 0,
        ))
        pos = int(np.searchsorted(sig_bars, exit_bar, side="left"))
        if pos < nsig and sig_bars[pos] < s:
            pos += 1
    return trades, actionable


# ---------------------------------------------------------------------------
# Signal-level adverse-selection metrics
# ---------------------------------------------------------------------------


def signal_metrics(st: SymStrat, var: dict, seg_start: int, seg_end: int) -> dict:
    """Directional price moves after market entry and after limit fill.

    For every raw signal (not path-dependent) we compute:
      market: entry at s+1 open; move from entry to the entry-bar close and
              the next bar's close-to-close move.
      limit : if the order fills within N bars, the same two moves from the
              fill price / fill bar.
    """
    b = st.b
    n = b.n
    out = dict(
        n_signals=0, n_fill_indep=0, n_next=0, n_next_win=0,
        sum_fillbar=0.0, sum_nextbar=0.0, sum_fill_lag=0.0,
        sum_limit_entry_next=0.0, n_limit_entry_next=0,
        n_mkt_fill_next=0, n_mkt_fill_win=0,
        sum_mkt_fill_fillbar=0.0, sum_mkt_fill_nextbar=0.0,
        sum_mkt_fill_entry_next=0.0, n_mkt_fill_entry_next=0,
        n_mkt_all_next=0, n_mkt_all_win=0,
        sum_mkt_all_fillbar=0.0, sum_mkt_all_nextbar=0.0,
        sum_mkt_all_entry_next=0.0, n_mkt_all_entry_next=0,
    )
    sigs = st.sig_bars
    lo = int(np.searchsorted(sigs, seg_start, side="left"))
    hi = int(np.searchsorted(sigs, seg_end - 1, side="left"))
    for idx in range(lo, hi):
        s = int(sigs[idx])
        d = int(st.sig_dirs[idx])
        e = s + 1
        if e >= seg_end:
            continue
        out["n_signals"] += 1
        mkt_fillbar = d * (b.c[e] / b.o[e] - 1.0) * 1e4
        mkt_nextbar = np.nan
        if e + 1 < n:
            mkt_nextbar = d * (b.c[e + 1] / b.c[e] - 1.0) * 1e4
        out["sum_mkt_all_fillbar"] += mkt_fillbar
        if np.isfinite(mkt_nextbar):
            out["n_mkt_all_next"] += 1
            out["sum_mkt_all_nextbar"] += mkt_nextbar
            if mkt_nextbar > 0:
                out["n_mkt_all_win"] += 1
        if e + 1 < n:
            out["n_mkt_all_entry_next"] += 1
            out["sum_mkt_all_entry_next"] += d * (b.c[e + 1] / b.o[e] - 1.0) * 1e4

        ent = try_entry(st, s, d, var, seg_end)
        if ent is None:
            continue
        out["n_fill_indep"] += 1
        out["sum_fill_lag"] += ent.fill_lag
        lim_fillbar = d * (b.c[ent.bar] / ent.price - 1.0) * 1e4
        lim_nextbar = np.nan
        if ent.bar + 1 < n:
            lim_nextbar = d * (b.c[ent.bar + 1] / b.c[ent.bar] - 1.0) * 1e4
        out["sum_fillbar"] += lim_fillbar
        if np.isfinite(lim_nextbar):
            out["n_next"] += 1
            out["sum_nextbar"] += lim_nextbar
            if lim_nextbar > 0:
                out["n_next_win"] += 1
        if ent.bar + 1 < n:
            out["n_limit_entry_next"] += 1
            out["sum_limit_entry_next"] += d * (b.c[ent.bar + 1] / ent.price - 1.0) * 1e4
        # market counterfactual on the same filled signals
        out["sum_mkt_fill_fillbar"] += mkt_fillbar
        if np.isfinite(mkt_nextbar):
            out["n_mkt_fill_next"] += 1
            out["sum_mkt_fill_nextbar"] += mkt_nextbar
            if mkt_nextbar > 0:
                out["n_mkt_fill_win"] += 1
        if e + 1 < n:
            out["n_mkt_fill_entry_next"] += 1
            out["sum_mkt_fill_entry_next"] += d * (b.c[e + 1] / b.o[e] - 1.0) * 1e4
    return out


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def _pf(net: np.ndarray) -> float:
    pos = net[net > 0].sum()
    neg = -net[net < 0].sum()
    if neg <= 0:
        return float("inf") if pos > 0 else float("nan")
    return float(pos / neg)


def _tstat(net: np.ndarray) -> float:
    n = net.size
    if n < 2:
        return float("nan")
    sd = net.std(ddof=1)
    if sd <= 0:
        return float("nan")
    return float(net.mean() / (sd / math.sqrt(n)))


def agg_trades(g: pd.DataFrame) -> dict:
    net = g["net_bp"].to_numpy(float)
    cf = g["cf_market_net_bp"].to_numpy(float)
    paired = np.isfinite(cf)
    diff = net[paired] - cf[paired]
    return dict(
        trades=len(g),
        mean_net_bp=float(net.mean()) if net.size else float("nan"),
        median_net_bp=float(np.median(net)) if net.size else float("nan"),
        std_net_bp=float(net.std(ddof=1)) if net.size > 1 else float("nan"),
        t_stat=_tstat(net),
        win_rate=float((net > 0).mean()) if net.size else float("nan"),
        pf=_pf(net),
        total_net_bp=float(net.sum()),
        avg_hold_bars=float(g["hold_bars"].mean()) if len(g) else float("nan"),
        avg_roundtrip_cost_bp=float(g["roundtrip_cost_bp"].mean()) if len(g) else float("nan"),
        avg_entry_cost_bp=float(g["entry_cost_bp"].mean()) if len(g) else float("nan"),
        avg_exit_cost_bp=EXIT_COST_BP if len(g) else float("nan"),
        avg_gross_bp=float(g["gross_bp"].mean()) if len(g) else float("nan"),
        avg_fill_lag=float(g["fill_lag"].mean()) if len(g) else float("nan"),
        stop_rate=float(g["reason"].isin(["stop", "stop_gap"]).mean()) if len(g) else float("nan"),
        tp_rate=float(g["reason"].isin(["tp", "tp_gap"]).mean()) if len(g) else float("nan"),
        reverse_rate=float(g["reason"].isin(["reverse", "mid"]).mean()) if len(g) else float("nan"),
        force_rate=float((g["reason"] == "force").mean()) if len(g) else float("nan"),
        cf_trades=int(paired.sum()),
        mean_cf_market_net_bp=float(cf[paired].mean()) if paired.any() else float("nan"),
        matched_exec_gain_bp=float(diff.mean()) if diff.size else float("nan"),
        matched_exec_gain_t=_tstat(diff),
        mean_cf_entry_px_gain_bp=float(g["cf_entry_px_gain_bp"].dropna().mean())
        if g["cf_entry_px_gain_bp"].notna().any() else float("nan"),
    )


def aggregate(trades: pd.DataFrame, attempts: pd.DataFrame,
              sigmetrics: pd.DataFrame) -> pd.DataFrame:
    rows = []
    keys = ["strategy", "variant", "segment", "symbol"]
    for key, g in trades.groupby(keys, sort=True):
        row = dict(zip(keys, key))
        row.update(agg_trades(g))
        rows.append(row)
    df = pd.DataFrame(rows)

    # pooled rows across symbols
    pooled = []
    for key, g in trades.groupby(["strategy", "variant", "segment"], sort=True):
        row = dict(zip(["strategy", "variant", "segment"], key))
        row["symbol"] = "ALL"
        row.update(agg_trades(g))
        pooled.append(row)
    df = pd.concat([df, pd.DataFrame(pooled)], ignore_index=True)

    # attempts / fill rates
    att = attempts.groupby(keys, sort=True).sum().reset_index()
    att_pool = attempts.groupby(["strategy", "variant", "segment"], sort=True).sum().reset_index()
    att_pool["symbol"] = "ALL"
    att = pd.concat([att, att_pool], ignore_index=True)
    df = df.merge(att, on=keys, how="left")
    df["fill_rate"] = df["trades"] / df["actionable"].replace(0, np.nan)

    # signal-level metrics: derive means, then merge
    sm = sigmetrics.copy()
    sm["limit_fillbar_bp"] = sm["sum_fillbar"] / sm["n_fill_indep"].replace(0, np.nan)
    sm["limit_nextbar_bp"] = sm["sum_nextbar"] / sm["n_next"].replace(0, np.nan)
    sm["limit_next_win"] = sm["n_next_win"] / sm["n_next"].replace(0, np.nan)
    sm["mkt_on_filled_fillbar_bp"] = sm["sum_mkt_fill_fillbar"] / sm["n_fill_indep"].replace(0, np.nan)
    sm["mkt_on_filled_nextbar_bp"] = sm["sum_mkt_fill_nextbar"] / sm["n_mkt_fill_next"].replace(0, np.nan)
    sm["mkt_on_filled_next_win"] = sm["n_mkt_fill_win"] / sm["n_mkt_fill_next"].replace(0, np.nan)
    sm["mkt_all_fillbar_bp"] = sm["sum_mkt_all_fillbar"] / sm["n_signals"].replace(0, np.nan)
    sm["mkt_all_nextbar_bp"] = sm["sum_mkt_all_nextbar"] / sm["n_mkt_all_next"].replace(0, np.nan)
    sm["mkt_all_next_win"] = sm["n_mkt_all_win"] / sm["n_mkt_all_next"].replace(0, np.nan)
    sm["limit_entry_next_bp"] = sm["sum_limit_entry_next"] / sm["n_limit_entry_next"].replace(0, np.nan)
    sm["mkt_on_filled_entry_next_bp"] = sm["sum_mkt_fill_entry_next"] / sm["n_mkt_fill_entry_next"].replace(0, np.nan)
    sm["mkt_all_entry_next_bp"] = sm["sum_mkt_all_entry_next"] / sm["n_mkt_all_entry_next"].replace(0, np.nan)
    sm["indep_fill_rate"] = sm["n_fill_indep"] / sm["n_signals"].replace(0, np.nan)
    sm["adv_fillbar_bp"] = sm["limit_fillbar_bp"] - sm["mkt_on_filled_fillbar_bp"]
    sm["adv_nextbar_bp"] = sm["limit_nextbar_bp"] - sm["mkt_on_filled_nextbar_bp"]
    sm["adv_entry_next_bp"] = sm["limit_entry_next_bp"] - sm["mkt_on_filled_entry_next_bp"]
    sm["sample_sel_nextbar_bp"] = sm["mkt_on_filled_nextbar_bp"] - sm["mkt_all_nextbar_bp"]
    sm["sig_avg_fill_lag"] = sm["sum_fill_lag"] / sm["n_fill_indep"].replace(0, np.nan)
    keep = ["strategy", "variant", "segment", "symbol", "n_signals",
            "n_fill_indep", "indep_fill_rate", "limit_fillbar_bp",
            "limit_nextbar_bp", "limit_next_win", "mkt_on_filled_fillbar_bp",
            "mkt_on_filled_nextbar_bp", "mkt_on_filled_next_win",
            "mkt_all_fillbar_bp", "mkt_all_nextbar_bp", "mkt_all_next_win",
            "limit_entry_next_bp", "mkt_on_filled_entry_next_bp",
            "mkt_all_entry_next_bp", "adv_fillbar_bp", "adv_nextbar_bp",
            "adv_entry_next_bp", "sample_sel_nextbar_bp",
            "sig_avg_fill_lag"]
    sm = sm[keep]
    df = df.merge(sm, on=keys, how="left")

    # Decomposition: market baseline for the same strategy/segment/symbol.
    base = df[df["variant"] == "A_market"][
        ["strategy", "segment", "symbol", "mean_net_bp"]
    ].rename(columns={"mean_net_bp": "market_mean_net_bp"})
    df = df.merge(base, on=["strategy", "segment", "symbol"], how="left")
    df["net_improvement_bp"] = df["mean_net_bp"] - df["market_mean_net_bp"]
    df["designed_bp"] = df["variant"].map(
        lambda v: ((TAKER_FEE + SLIPPAGE - VAR_BY_KEY[v]["maker"]) * 1e4
                   + VAR_BY_KEY[v].get("offset", 0.0) * 1e4)
        if v in VAR_BY_KEY else np.nan)
    df["adverse_vs_design_bp"] = df["designed_bp"] - df["matched_exec_gain_bp"]
    df["selection_effect_bp"] = df["net_improvement_bp"] - df["matched_exec_gain_bp"]
    return df


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def build_all() -> list[SymStrat]:
    out: list[SymStrat] = []
    for sym in SYMBOLS:
        out.append(build_ema_cross(sym, "1h", 9, 21))
        out.append(build_donchian(sym, "1h", DONCHIAN_N, atr_stop=False))
        out.append(build_donchian(sym, "1h", DONCHIAN_N, atr_stop=True))
        out.append(build_ema_rsi(sym, 12, 26, "15m"))
    return out


def fmt(x, nd=2):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "—"
    return f"{x:,.{nd}f}"


def pct(x, nd=1):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "—"
    return f"{x*100:.{nd}f}%"


def write_report(df: pd.DataFrame, path: str) -> None:
    strategies = [
        ("ema_cross_9_21_1h", "EMA(9/21) 交叉，1h"),
        ("donchian55_mid_1h", "唐奇安 N=55 突破，1h（中轨出场）"),
        ("ema_rsi_12_26_15m", "EMA(12/26)+RSI，15m"),
    ]
    primary_strats = strategies
    primary = [
        "A_market",
        "B_postonly_N1", "B_postonly_N3", "B_postonly_N6",
        "C_limit10bp_N1", "C_limit10bp_N3", "C_limit10bp_N6",
    ]

    def get(strategy, variant, segment):
        r = df[(df.strategy == strategy) & (df.variant == variant) &
               (df.segment == segment) & (df.symbol == "ALL")]
        return r.iloc[0] if len(r) else None

    lines = []
    ap = lines.append
    ap("# 执行成本研究：市价 vs post-only maker 入场")
    ap("")
    ap("生成：`python research/execution/exec_sim.py`。"
       "数据：Binance USDT-M 180 天（2026-04-20 → 2026-10-17），"
       "8 币（KORU 剔除）。120 天校准 / 60 天留出，参数固定不搜索。")
    ap("")

    # ---------------- headline numbers ----------------
    ap("## 0. 结论")
    ap("")
    ap("**maker 入场把往返成本从 14bp 降到 9bp（省 5bp），但不够翻正。**")
    ap("")
    ap("把三类信号、8 个币、两个验证段合在一起看：")
    ap("")
    pool = []
    for strat_key, _ in primary_strats:
        for seg in SEGMENTS:
            m = get(strat_key, "A_market", seg)
            b3 = get(strat_key, "B_postonly_N3", seg)
            if m is not None and b3 is not None:
                pool.append((strat_key, seg, m, b3))
    if pool:
        tot_mk = sum(r["total_net_bp"] for _, _, r, _ in pool)
        tot_b3 = sum(r["total_net_bp"] for _, _, _, r in pool)
        n_mk = sum(r["trades"] for _, _, r, _ in pool)
        n_b3 = sum(r["trades"] for _, _, _, r in pool)
        per_strat_mk = [r["mean_net_bp"] for _, _, r, _ in pool]
        per_strat_b3 = [r["mean_net_bp"] for _, _, _, r in pool]
        ap(f"- 市价基准（按笔加权，EMA+RSI 15m 笔数占多数）：{n_mk} 笔，"
           f"均值 {tot_mk/n_mk:+.2f}bp/笔；三个策略等权平均 "
           f"{np.mean(per_strat_mk):+.2f}bp/笔。")
        ap(f"- B（post-only 挂 close，N=3）：{n_b3} 笔，"
           f"均值 {tot_b3/n_b3:+.2f}bp/笔；三个策略等权平均 "
           f"{np.mean(per_strat_b3):+.2f}bp/笔。")
        ap(f"- B 相对市价：按笔加权 {(tot_b3/n_b3)-(tot_mk/n_mk):+.2f}bp/笔，"
           f"等权 {np.mean(per_strat_b3)-np.mean(per_strat_mk):+.2f}bp/笔。"
           f"机械成本节省是 +5bp，但只实现约 +4bp：EMA 两个策略约 89% 的交易"
           f"以固定百分比 TP/止损出场，更好的入场价同时把 TP/止损位也挪动，"
           f"百分比收益不变，滑点节省和价格改善被抵消，只有 3bp 的费率差直接落地；"
           f"唐奇安中轨出场是价格信号出场，退出价与入场价无关，拿满 +5bp。"
           f"B 的成交率接近 100%，所以差额不是成交样本选择，而是出场路径。")
        # average excluding the single positive Donchian holdout cell
        excl = [r["mean_net_bp"] for (k, seg, _, r) in pool
                if not (k == "donchian55_mid_1h" and seg == "holdout")]
        ap(f"- 但 B 的等权净期望仍是 {np.mean(per_strat_b3):+.2f}bp/笔"
           f"（市价 {np.mean(per_strat_mk):+.2f}bp/笔）；"
           f"这个等权值被唐奇安留出段的 +29.4bp 拉高，"
           f"剔除该单元后其余 5 个策略-段单元平均 {np.mean(excl):+.2f}bp/笔。"
           f"成本改善是真实的，只是毛 edge 太负。")
    ap("")
    ap("分策略的结论见第 2 节；关键诊断（成交率、逆向选择、配对改善）见第 3 节。")
    ap("")

    # ---------------- methodology ----------------
    ap("## 1. 方法")
    ap("")
    ap("### 1.1 信号（固定默认值，不重新调参）")
    ap("")
    ap("| 策略 | 信号 | 出场 | 止损/止盈 |")
    ap("|---|---|---|---|")
    ap("| EMA 交叉 | EMA(9/21) 金叉/死叉，1h | 反向交叉下一根开盘 | 1R=0.8%，TP=1.5R |")
    ap("| 唐奇安 | 收盘突破前 55 根高/低，1h | 收盘穿越中轨后下一根开盘 | 主口径无止损；稳健性口径 2×ATR(14) |")
    ap("| EMA+RSI | EMA(12/26) 方向 + RSI 带（50-70/30-50）+ 放量 + 15m 同向，score≥3，15m | 反向交叉下一根开盘 | 1R=0.8%，TP=1.5R |")
    ap("")
    ap("默认值来自 `ooapi-server/internal/trading/config.go`："
       "`DefaultRFraction=0.008`、`DefaultStopR=1.0`、"
       "`DefaultTakeProfitR=1.5`、`DefaultMinScore=3`、"
       "RSI 50-70/30-50；EMA 间隔 0.05%。唐奇安 N=55 与两种出场"
       "对应 `research/breakout` 网格里已有的 `A_N55_trend0_mid` 和 "
       "`A_N55_trend0_atr2_fx` 组合。主表用中轨出场；"
       "2×ATR 止损口径也在 `results.csv` 里（`donchian55_atr2_1h`），"
       "但留出段只有 11–12 笔、由极端趋势主导（均值被拉到 1,000bp 以上），"
       "不进入主表，只作为“换出场规则不改变入场结论”的旁证。"
       "注意：这里用服务器默认 R=0.8%/TP=1.5R，而不是 trend 走查里逐折选出的"
       "R=1.2% 等参数；因此交易频率比 trend 报告的选中组合高，但信号定义相同。"
       "这是刻意的——不重新调参，只比较执行。")
    ap("")
    ap("### 1.2 四种入场执行")
    ap("")
    ap("| 代号 | 入场 | 入场成本 | 出场成本 |")
    ap("|---|---|---|---|")
    ap("| A 市价 | 信号下一根开盘 | taker 5bp + 滑点 2bp | taker 5bp + 滑点 2bp |")
    ap("| B post-only | 挂在信号收盘价（多=close，空=close），未来 N 根 low/high 触及才成交，N 根未成交撤单 | maker 2bp，无滑点 | 同上 |")
    ap("| C 更保守限价 | 挂在 close∓0.1%，未来 N 根触及才成交 | maker 2bp，无滑点 | 同上 |")
    ap("| D 市价+BNB/VIP | 同 A，仅费用敏感性 | taker 4.5bp（BNB 9 折）或 4bp（VIP 8 折） | 同上 |")
    ap("")
    ap("所有出场（含止损）一律 taker 5bp + 2bp 滑点，因此：")
    ap("")
    ap("- 市价往返 = 5 + 2 + 5 + 2 = **14bp**")
    ap("- maker 入场往返 = 2 + 5 + 2 = **9bp**（省 5bp）")
    ap("- maker 0 费敏感性 = 0 + 5 + 2 = **7bp**")
    ap("- BNB 9 折市价往返 = 4.5 + 2 + 4.5 + 2 = **13bp**")
    ap("")
    ap("限价成交价按挂单价计（不假设价格改善）；跳空穿过挂单价也按挂单价成交。"
       "`pen1bp` 变体要求价格再穿透 1bp 才算成交，作为排队位置假设的稳健性检查。"
       "限价在成交当根不使用该根 high/low 判止损（无法知道极值在成交前还是后），"
       "信号类出场仍可在成交当根收盘触发、下一根开盘执行。")
    ap("")
    ap("### 1.3 逆向选择")
    ap("")
    ap("对每一笔成交记录两个方向调整后的价格变动：")
    ap("")
    ap("- `成交当根`: 从成交价到成交当根收盘的方向收益；")
    ap("- `成交后下一根`: 成交后下一根的 close-to-close 方向收益。")
    ap("")
    ap("把限价成交样本与“同一批信号的市价反事实”比较（相同信号、相同出场规则），"
       "再与全部市价信号比较，分离：")
    ap("")
    ap("- `adv_*`: 同一信号下，限价成交时点与市价入场时点的差异（逆向选择/价格路径）；")
    ap("- `sample_sel_*`: 能成交的信号本身与全部信号的质量差异（成交样本选择）。")
    ap("")
    ap("P&L 上，每笔限价成交都与同一信号的市价反事实做配对，"
       "`matched_exec_gain_bp = net(limit) − net(market cf)`，"
       "直接给出扣掉逆向选择后的真实改善。")
    ap("")

    # ---------------- main results ----------------
    ap("## 2. 主结果（8 币汇总，按笔等权）")
    ap("")
    for seg, seg_label in [("calib", "120 天校准段"), ("holdout", "60 天留出段")]:
        ap(f"### 2.{1 if seg == 'calib' else 2} {seg_label}")
        ap("")
        ap("| 策略 | 执行 | 笔数 | 成交率 | 往返成本bp | 净期望bp | t | 胜率 | 合计bp |")
        ap("|---|---|---:|---:|---:|---:|---:|---:|---:|")
        for strat_key, strat_label in strategies:
            for var in primary:
                r = get(strat_key, var, seg)
                if r is None:
                    continue
                vshort = var.replace("B_postonly_", "B_").replace("C_limit10bp_", "C_")
                ap(f"| {strat_label} | {vshort} | {int(r['trades'])} | "
                   f"{pct(r['fill_rate'])} | {fmt(r['avg_roundtrip_cost_bp'])} | "
                   f"{fmt(r['mean_net_bp'])} | {fmt(r['t_stat'])} | "
                   f"{pct(r['win_rate'])} | {fmt(r['total_net_bp'], 0)} |")
        ap("")

    # ---------------- per-symbol robustness ----------------
    ap("### 2.3 逐币稳健性（8 币中有几个净期望为正）")
    ap("")
    ap("| 策略 | 段 | 市价 | B N=3 | C N=3 |")
    ap("|---|---|---|---|---|")
    for strat_key, strat_label in strategies:
        for seg in SEGMENTS:
            cells = []
            for var in ["A_market", "B_postonly_N3", "C_limit10bp_N3"]:
                sub = df[(df.strategy == strat_key) & (df.variant == var) &
                         (df.segment == seg) & (df.symbol != "ALL")]
                if len(sub):
                    pos = int((sub["mean_net_bp"] > 0).sum())
                    med = float(sub["mean_net_bp"].median())
                    cells.append(f"{pos}/{len(sub)} (中位 {med:+.1f}bp)")
                else:
                    cells.append("—")
            ap(f"| {strat_label} | {'校准' if seg=='calib' else '留出'} | "
               + " | ".join(cells) + " |")
    ap("")
    ap("逐币结果离散度很大（同一策略同一段，不同币的净期望可差 100bp 以上），"
       "所以“汇总为正”不等于可交易；表中为正的币数比汇总均值更能说明稳健性。")
    ap("")
    ap("统计口径注意：t 值按逐笔独立计算，未做跨币/时间聚类。"
       "加密资产高度相关、同一时段多币同时交易，真实标准误更大；"
       "因此判定不依赖单个 t 值，而看校准/留出两段方向是否一致、"
       "以及逐币为正的数量。没有任何参数在留出段上选择或调整。"
       "未计资金费：1h 策略平均持仓约 5–32 小时，跨 8 小时资金费边界的交易"
       "还会有额外成本，只会让净期望更差。")
    ap("")

    # ---------------- adverse selection ----------------
    ap("## 3. 成交率、逆向选择与配对改善")
    ap("")
    ap("### 3.1 成交率与成交当根的逆向选择（8 币汇总）")
    ap("")
    ap("| 策略 | 执行 | 段 | 独立成交率 | 组合成交率 | 成交延迟(根) | 限价成交当根bp | 同信号市价当根bp | 首根逆向bp |")
    ap("|---|---|---|---:|---:|---:|---:|---:|---:|")
    for strat_key, strat_label in strategies:
        for var in ["B_postonly_N1", "B_postonly_N3", "B_postonly_N6",
                    "C_limit10bp_N1", "C_limit10bp_N3", "C_limit10bp_N6"]:
            for seg in SEGMENTS:
                r = get(strat_key, var, seg)
                if r is None:
                    continue
                vshort = var.replace("B_postonly_", "B_").replace("C_limit10bp_", "C_")
                ap(f"| {strat_label} | {vshort} | {'校准' if seg=='calib' else '留出'} | "
                   f"{pct(r['indep_fill_rate'])} | {pct(r['fill_rate'])} | "
                   f"{fmt(r['avg_fill_lag'], 2)} | {fmt(r['limit_fillbar_bp'])} | "
                   f"{fmt(r['mkt_on_filled_fillbar_bp'])} | {fmt(r['adv_fillbar_bp'])} |")
    ap("")
    ap("`成交当根` = 从成交价到成交当根收盘的方向收益（多头为正表示收盘高于成交价）。"
       "对 B 它平均为负（-0.6 到 -5.8bp），说明成交后价格倾向于继续朝不利方向走；"
       "但同一批信号的市价入场当根也经历同样的走势（市价买在下一根开盘，"
       "与上一根收盘价接近），所以 `首根逆向bp` ≈ 0。"
       "C 的 `首根逆向bp` 为正，是因为入场价本来就比市价优 10bp（多低空高），"
       "不是逆向选择不存在；C 的逆向选择体现在成交样本选择（表 3.3 的负值）。"
       "`独立成交率` 按每个原始信号单独判断（不受持仓影响），"
       "`组合成交率` 是实际单仓引擎里“可入场信号被成交”的比例。")
    ap("")
    ap("### 3.2 成交后下一根的方向统计（8 币汇总）")
    ap("")
    ap("| 策略 | 执行 | 段 | 限价成交后下一根bp | 同信号市价下一根bp | 下一根逆向bp | 限价胜率 | 同信号市价胜率 | 全部市价胜率 | 全样本市价下一根bp |")
    ap("|---|---|---|---:|---:|---:|---:|---:|---:|---:|")
    for strat_key, strat_label in strategies:
        for var in ["B_postonly_N1", "B_postonly_N3", "B_postonly_N6",
                    "C_limit10bp_N1", "C_limit10bp_N3", "C_limit10bp_N6"]:
            for seg in SEGMENTS:
                r = get(strat_key, var, seg)
                if r is None:
                    continue
                vshort = var.replace("B_postonly_", "B_").replace("C_limit10bp_", "C_")
                ap(f"| {strat_label} | {vshort} | {'校准' if seg=='calib' else '留出'} | "
                   f"{fmt(r['limit_nextbar_bp'])} | {fmt(r['mkt_on_filled_nextbar_bp'])} | "
                   f"{fmt(r['adv_nextbar_bp'])} | {pct(r['limit_next_win'])} | "
                   f"{pct(r['mkt_on_filled_next_win'])} | {pct(r['mkt_all_next_win'])} | "
                   f"{fmt(r['mkt_all_nextbar_bp'])} |")
    ap("")
    ap("注：B 的成交几乎都发生在信号后第 1 根，此时“限价成交后下一根”与“同信号市价下一根”"
       "是同一根 K 线的 close-to-close 收益，两者相等，`下一根逆向bp≈0`。"
       "这并不表示没有逆向选择：逆向选择发生在成交当根（表 3.1 的负值），"
       "以及 C 的成交样本选择（表 3.3 的 selection effect）。")
    ap("")
    ap("### 3.3 配对改善与分解（每笔限价 vs 同一信号市价，8 币汇总）")
    ap("")
    ap("| 策略 | 执行 | 段 | 配对笔数 | 市价反事实净bp | 限价实际净bp | 配对改善bp | t(配对) | 设计优势bp | 同信号未实现bp | 净改善(vs全市场)bp | 成交样本选择bp |")
    ap("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for strat_key, strat_label in strategies:
        for var in ["B_postonly_N1", "B_postonly_N3", "B_postonly_N6",
                    "C_limit10bp_N1", "C_limit10bp_N3", "C_limit10bp_N6"]:
            for seg in SEGMENTS:
                r = get(strat_key, var, seg)
                if r is None or not np.isfinite(r.get("matched_exec_gain_bp", np.nan)):
                    continue
                vshort = var.replace("B_postonly_", "B_").replace("C_limit10bp_", "C_")
                ap(f"| {strat_label} | {vshort} | {'校准' if seg=='calib' else '留出'} | "
                   f"{int(r['cf_trades'])} | {fmt(r['mean_cf_market_net_bp'])} | "
                   f"{fmt(r['mean_net_bp'])} | {fmt(r['matched_exec_gain_bp'])} | "
                   f"{fmt(r['matched_exec_gain_t'])} | {fmt(r['designed_bp'])} | "
                   f"{fmt(r['adverse_vs_design_bp'])} | {fmt(r['net_improvement_bp'])} | "
                   f"{fmt(r['selection_effect_bp'])} |")
    ap("")
    ap("`设计优势bp` = 机械费用/滑点节省（5bp）+ 挂单偏移（B 为 0，C 为 +10bp）。"
       "`同信号未实现bp` = 设计优势 − 配对改善；正值表示即使在能成交的同一信号上，"
       "挂单也没有拿到设计中的全部价格优势。"
       "`净改善(vs全市场)bp` = 限价策略净期望 − 同一策略全市场基准净期望。"
       "`成交样本选择bp` = 净改善 − 配对改善；负值表示限价只成交了更差的信号（或路径不同），"
       "这就是逆向选择在策略层面的代价。B 的成交率接近 100%，所以这一项接近 0；"
       "C 的成交率低，这一项明显为负。"
       "B 的配对改善几乎恒等于费用/滑点差（EMA 约 4bp，唐奇安中轨约 5bp），"
       "所以它的 `t(配对)` 很大，只反映这个机械差，"
       "不应解读为方向性 alpha 的显著性。")
    ap("")
    ap("**固定百分比 TP/止损会抵消一部分入场价优势。** "
       "如果多头以低 10bp 的价格成交，TP 和止损位也随之下移 10bp；"
       "当退出由 TP/止损触发时，百分比收益不变，滑点节省和价格改善都被抵消，"
       "只有 3bp 的费率差（taker 5bp → maker 2bp）直接落地。"
       "只有退出由市场信号决定（反向交叉、中轨）时，更好的入场价才会全额转化为 P&L。"
       "更好的入场价还会改变 TP/止损的触发概率（可能避免一次止损），"
       "这部分路径效应方向不定，是 B/C 实测配对改善偏离 5bp/15bp 的主要原因。"
       "这解释了为什么 C 在唐奇安中轨出场上的配对改善约 +15bp，"
       "而在 EMA 的 TP/止损出场组合上只有约 +10 到 +15bp、净改善只剩 5–9bp。")
    ap("")
    ap("**排队位置稳健性：** 要求价格再穿透 1bp 才成交（`B_postonly_pen1bp_N3`），"
       "B 的成交率仍有 96.8–98.8%，配对改善仍有 +3.9 到 +5.0bp，"
       "但成交样本选择变为 -0.2 到 -2.8bp，净期望比 B_N3 差约 0.5–1.5bp。"
       "结论不变：maker 的 4–5bp 优势在更保守的成交假设下仍然存在，"
       "但仍不足以翻正。")
    ap("")

    # ---------------- D sensitivity ----------------
    ap("## 4. 费用敏感性（D，仅假设）")
    ap("")
    ap("| 策略 | 执行 | 段 | 笔数 | 往返成本bp | 净期望bp | t | 胜率 |")
    ap("|---|---|---|---:|---:|---:|---:|---:|")
    for strat_key, strat_label in strategies:
        for var in ["D_market_bnb10", "D_market_vip20", "B_postonly_N3_maker0"]:
            for seg in SEGMENTS:
                r = get(strat_key, var, seg)
                if r is None:
                    continue
                vshort = {"D_market_bnb10": "D BNB9折",
                          "D_market_vip20": "D VIP8折",
                          "B_postonly_N3_maker0": "B N3 maker0"}[var]
                ap(f"| {strat_label} | {vshort} | {'校准' if seg=='calib' else '留出'} | "
                   f"{int(r['trades'])} | {fmt(r['avg_roundtrip_cost_bp'])} | "
                   f"{fmt(r['mean_net_bp'])} | {fmt(r['t_stat'])} | {pct(r['win_rate'])} |")
    ap("")
    ap("D 是敏感性，不是可交易结论：BNB 9 折假设合约 taker 4.5bp；"
       "VIP 8 折假设 4bp；maker0 假设返佣后 maker 费为 0。滑点仍按 2bp/边。")
    ap("")

    # ---------------- conclusion ----------------
    ap("## 5. 回答与判定")
    ap("")
    ap("### 5.1 四个直接问题")
    ap("")
    ap("1. **往返成本从 14bp 降到多少？** "
       "maker 2bp 入场 + taker 5bp 出场 + 2bp 出场滑点 = **9bp**，"
       "机械节省 **5bp/笔**。若 maker 费为 0（返佣假设）则为 **7bp**；"
       "市价 + BNB 9 折为 **13bp**，市价 + VIP 8 折为 **12bp**。")
    # fill rates
    b3 = get(primary_strats[0][0], "B_postonly_N3", "holdout")
    c3 = get(primary_strats[0][0], "C_limit10bp_N3", "holdout")
    rsi_c3 = get("ema_rsi_12_26_15m", "C_limit10bp_N3", "holdout")
    if b3 is not None:
        ap(f"2. **成交率多少？** post-only 挂信号收盘价（B）："
           f"独立成交率约 {pct(df[(df.variant=='B_postonly_N3') & (df.symbol=='ALL')]['indep_fill_rate'].min())}"
           f"–{pct(df[(df.variant=='B_postonly_N3') & (df.symbol=='ALL')]['indep_fill_rate'].max())}"
           f"（N=3；N=1/6 几乎相同，因为绝大多数成交发生在信号后第 1 根）。"
           f"挂 close∓0.1%（C）的成交率随策略和 N 变化："
           f"EMA 交叉 N=3 约 {pct(c3['indep_fill_rate']) if c3 is not None else '—'}，"
           f"EMA+RSI 15m N=3 约 {pct(rsi_c3['indep_fill_rate']) if rsi_c3 is not None else '—'}。"
           "完整数字见表 3.1。")
    ap("3. **逆向选择吃掉多少？** 分两种："
       "(a) 成交后的价格继续朝不利方向走——B 的成交当根平均 -0.6 到 -5.8bp，"
       "但市价反事实在同一根也经历同样走势，所以相对逆向选择≈0；"
       "(b) 只成交更差的信号——C 的 `成交样本选择bp` 为 **-5 到 -8bp**，"
       "即 10bp 挂单价格优势中有 5–8bp 被“成交的都是坏信号”吃掉。"
       "B 的成交率接近 100%，这一项≈0；C 的成交率 61–95%，"
       "样本选择是主要代价。")
    sel = df[(df.symbol == "ALL") & (df.variant.isin(["B_postonly_N3", "C_limit10bp_N3"])) &
             (df.strategy.isin([s for s, _ in primary_strats]))]
    bimp = sel[sel.variant == "B_postonly_N3"]["net_improvement_bp"].mean()
    cimp = sel[sel.variant == "C_limit10bp_N3"]["net_improvement_bp"].mean()
    bgain = sel[sel.variant == "B_postonly_N3"]["matched_exec_gain_bp"].mean()
    cgain = sel[sel.variant == "C_limit10bp_N3"]["matched_exec_gain_bp"].mean()
    bsel = sel[sel.variant == "B_postonly_N3"]["selection_effect_bp"].mean()
    csel = sel[sel.variant == "C_limit10bp_N3"]["selection_effect_bp"].mean()
    ap(f"4. **净期望改善多少？** B 平均 **{bimp:+.2f}bp/笔**"
       f"（同信号配对改善 {bgain:+.2f}bp，成交样本选择 {bsel:+.2f}bp）；"
       f"C 平均 **{cimp:+.2f}bp/笔**"
       f"（同信号配对改善 {cgain:+.2f}bp，成交样本选择 {csel:+.2f}bp）。"
       "C 的设计优势是 15bp（10bp 挂单偏移 + 5bp 费用/滑点），"
       "但固定百分比 TP/止损出场只能直接兑现 3bp 费率差，价格偏移主要靠信号类出场兑现；"
       "再叠加成交样本选择，最终只剩约 7bp。完整分解见表 3.3。")
    ap("")
    ap("### 5.2 判定")
    ap("")

    # explicit verdict from pooled B_N3 and C_N3 numbers
    for seg in ["calib", "holdout"]:
        for var, vlabel in [("B_postonly_N3", "B N=3"), ("C_limit10bp_N3", "C N=3")]:
            rows = []
            for strat_key, _ in primary_strats:
                r = get(strat_key, var, seg)
                m = get(strat_key, "A_market", seg)
                if r is not None and m is not None:
                    rows.append((strat_key, r["mean_net_bp"], m["mean_net_bp"],
                                 r["matched_exec_gain_bp"], r["fill_rate"]))
            if rows:
                n_pos = sum(1 for _, b, _, _, _ in rows if b > 0)
                n_flip = sum(1 for _, b, a, _, _ in rows if b > 0 and a <= 0)
                avg_imp = np.mean([b - a for _, b, a, _, _ in rows])
                avg_gain = np.nanmean([g for _, _, _, g, _ in rows])
                names = "; ".join(
                    f"{k.replace('_1h','').replace('_15m','')}: "
                    f"{a:+.1f}→{b:+.1f}bp" for k, b, a, _, _ in rows)
                ap(f"- {('校准' if seg=='calib' else '留出')}段 {vlabel}："
                   f"净期望为正 {n_pos}/{len(rows)} 个策略，"
                   f"由负翻正 {n_flip}/{len(rows)} 个；"
                   f"平均改善 {avg_imp:+.2f}bp/笔（配对 {avg_gain:+.2f}bp）。"
                   f"逐策略：{names}。")
    ap("")
    ap(f"**结论：不够。** maker 入场把 14bp 往返压到 9bp，"
       f"实测净期望改善 B 约 {bimp:+.1f}bp/笔、C 约 {cimp:+.1f}bp/笔；"
       "但三个主信号里，EMA(9/21) 1h 和 EMA(12/26)+RSI 15m 在 120 天校准段和 "
       "60 天留出段都没有翻正。"
       "唐奇安 N=55 1h 的留出段为正，但市价基准本来就为正（+25.8bp），"
       "maker 只是把它推到 +29.4bp；154 笔、t≈0.57、8 个币里 2 个为负，"
       "这是 regime 暴露而不是执行改善，不能当成 maker 的功劳。"
       "\n\n"
       "根本原因没有变：把 14bp 市价成本加回去，"
       "EMA 交叉和 EMA+RSI 的毛 edge 只有约 **-3 到 +3bp/笔**"
       "（市价净期望 -11 到 -17bp + 14bp）。"
       "maker 入场后往返成本是 9bp，所以要翻正，毛 edge 必须超过 9bp/笔；"
       "当前差 6–12bp。maker 省下的 4–5bp 是真的，但补不上这个缺口。")
    ap("")
    ap("两个附带发现：")
    ap("")
    ap("1. post-only 挂在信号收盘价（B）的成交率高得惊人"
       "（N=1 就约 99%），因为下一根 K 线的 low/high 几乎总会碰到上一根收盘价。"
       "这意味着 B 更像“用 maker 费率在上一根收盘价入场”，而不是“等一个更好的价格”。"
       "它的 4–5bp 改善几乎全部来自费率/滑点，而不是价格改善。"
       "真正想拿价格优势必须挂得更远（C），但挂得越远，成交样本的逆向选择越重。")
    ap("2. 固定百分比 TP/止损会把 maker 的价格优势抵掉一部分："
       "更好的入场价同时也移动了 TP/止损位，触发时百分比收益不变，"
       "滑点和价格改善被抵消，只有 3bp 费率差直接落地；"
       "但更好的入场价会改变触发概率（可能避免一次止损），这部分路径效应方向不定。"
       "因此 maker 入场对“信号出场”策略（唐奇安中轨、反向交叉）比"
       "对“固定 TP/止损”策略更可预测：前者能全额兑现价格改善，后者只能兑现一部分。"
       "当前 EMA 策略 89% 的交易走 TP/止损，所以 C 的 10bp 价格优势只有一部分兑现。")
    ap("")
    ap("## 6. 文件")
    ap("")
    ap("- `research/execution/exec_sim.py` — 本脚本")
    ap("- `research/execution/results.csv` — 全部策略×执行×段×币的逐行结果")
    ap("- `research/execution/report.md` — 本报告")
    ap("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main() -> None:
    print("building signals ...", flush=True)
    strats = build_all()
    print(f"  {len(strats)} symbol-strategies", flush=True)

    trade_rows = []
    attempt_rows = []
    signal_rows = []
    for st in strats:
        for seg_name, seg_start, seg_end in st.segment_bounds():
            for var in VARIANTS:
                trades, actionable = run_variant(st, var, seg_start, seg_end)
                for t in trades:
                    t["segment"] = seg_name
                trade_rows.extend(trades)
                attempt_rows.append(dict(
                    strategy=st.key, variant=var["key"], segment=seg_name,
                    symbol=st.symbol, actionable=actionable,
                    raw_signals=int(
                        np.searchsorted(st.sig_bars, seg_end - 1, "left")
                        - np.searchsorted(st.sig_bars, seg_start, "left")),
                ))
                if var["kind"] == "limit":
                    sm = signal_metrics(st, var, seg_start, seg_end)
                    sm.update(strategy=st.key, variant=var["key"],
                              segment=seg_name, symbol=st.symbol)
                    signal_rows.append(sm)

    trades = pd.DataFrame(trade_rows)
    attempts = pd.DataFrame(attempt_rows)
    sigmetrics = pd.DataFrame(signal_rows)

    # pooled signal metrics across symbols (sum counters, then derive means)
    sum_cols = [c for c in sigmetrics.columns
                if c.startswith("sum_") or c.startswith("n_")]
    pooled_sm = sigmetrics.groupby(
        ["strategy", "variant", "segment"], sort=True)[sum_cols].sum().reset_index()
    pooled_sm["symbol"] = "ALL"
    sigmetrics = pd.concat([sigmetrics, pooled_sm], ignore_index=True)

    print(f"  {len(trades)} trades, aggregating ...", flush=True)
    df = aggregate(trades, attempts, sigmetrics)

    # order columns
    front = ["strategy", "variant", "segment", "symbol", "trades",
             "actionable", "raw_signals", "fill_rate", "mean_net_bp",
             "median_net_bp", "std_net_bp", "t_stat", "win_rate", "pf",
             "total_net_bp", "avg_gross_bp", "avg_roundtrip_cost_bp",
             "avg_entry_cost_bp", "avg_exit_cost_bp", "avg_hold_bars",
             "stop_rate", "tp_rate", "reverse_rate", "force_rate",
             "avg_fill_lag", "cf_trades", "mean_cf_market_net_bp",
             "matched_exec_gain_bp", "matched_exec_gain_t",
             "mean_cf_entry_px_gain_bp", "market_mean_net_bp",
             "net_improvement_bp", "designed_bp", "adverse_vs_design_bp",
             "selection_effect_bp", "n_signals", "n_fill_indep",
             "indep_fill_rate", "limit_fillbar_bp", "limit_nextbar_bp",
             "limit_next_win", "mkt_on_filled_fillbar_bp",
             "mkt_on_filled_nextbar_bp", "mkt_on_filled_next_win",
             "mkt_all_fillbar_bp", "mkt_all_nextbar_bp", "mkt_all_next_win",
             "limit_entry_next_bp", "mkt_on_filled_entry_next_bp",
             "mkt_all_entry_next_bp", "adv_fillbar_bp", "adv_nextbar_bp",
             "adv_entry_next_bp", "sample_sel_nextbar_bp"]
    cols = [c for c in front if c in df.columns] + \
           [c for c in df.columns if c not in front]
    df = df[cols]
    df = df.sort_values(["strategy", "segment", "variant", "symbol"])

    res_path = os.path.join(OUT_DIR, "results.csv")
    df.to_csv(res_path, index=False, encoding="utf-8")
    print(f"  wrote {res_path}", flush=True)

    report_path = os.path.join(OUT_DIR, "report.md")
    write_report(df, report_path)
    print(f"  wrote {report_path}", flush=True)

    # console summary
    for strat_key in ["ema_cross_9_21_1h", "donchian55_mid_1h",
                      "ema_rsi_12_26_15m"]:
        for seg in SEGMENTS:
            m = df[(df.strategy == strat_key) & (df.variant == "A_market") &
                   (df.segment == seg) & (df.symbol == "ALL")]
            b = df[(df.strategy == strat_key) & (df.variant == "B_postonly_N3") &
                   (df.segment == seg) & (df.symbol == "ALL")]
            c = df[(df.strategy == strat_key) & (df.variant == "C_limit10bp_N3") &
                   (df.segment == seg) & (df.symbol == "ALL")]
            if len(m) and len(b) and len(c):
                m, b, c = m.iloc[0], b.iloc[0], c.iloc[0]
                print(f"{strat_key:22s} {seg:7s} market {m.mean_net_bp:+7.2f}bp "
                      f"({int(m.trades)}t)  B_N3 {b.mean_net_bp:+7.2f}bp "
                      f"({int(b.trades)}t, fill {b.fill_rate:.0%}, "
                      f"gain {b.matched_exec_gain_bp:+.2f}bp)  "
                      f"C_N3 {c.mean_net_bp:+7.2f}bp "
                      f"(fill {c.fill_rate:.0%}, gain {c.matched_exec_gain_bp:+.2f}bp)",
                      flush=True)


if __name__ == "__main__":
    main()
