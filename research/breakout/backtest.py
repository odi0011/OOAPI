#!/usr/bin/env python
"""Walk-forward test of breakout / volatility / cross-sectional momentum edges.

Research only. Reads local Binance USDT-M futures klines, never touches the
trading server or credentials.

Strategies
----------
A. Donchian breakout: close beyond the prior N-bar high/low (N=20/55/100),
   optional EMA200 regime filter.  Exit on the channel midline, or on an ATR
   stop (1.5/2/3 ATR) tested both as a fixed initial stop ("fx") and as a
   trailing Chandelier stop ("tr").
B. ATR volatility breakout: close beyond previous close +/- k*ATR(14),
   k=0.5/1/1.5, same fixed/trailing ATR-stop grid.
C. Cross-sectional momentum: rank by 7/14/30-day return, long top 2 / short
   bottom 2, equal or inverse-vol weights, rebalance every 4h or 1d.
D. Optional Bollinger(20, 2.0/2.5 sigma) extreme mean-reversion.

Protocol
--------
* Signal is confirmed on bar close t; execution happens at open t+1.
* 45-day rolling train window selects one parameter set per fold; the next
  15 days are out-of-sample. Step = 15 days -> 9 folds over 180 days.
* Costs: taker 0.05% + slippage 0.02% per side (0.07% one way, 0.14% round
  trip). Stops fill at the stop price with adverse slippage; gaps fill at open.
* One position per symbol at a time. The cross-sectional book is standalone
  per fold (starts flat, force-closes at fold end). Trades entered in a window
  and still open at its end are force-closed there.
* netR = net return / ex-ante risk of the position.  Directional risk is the
  actual stop distance; mid-channel exits (no live stop) use a nominal 2*ATR.
  Cross-sectional risk is the zero-correlation portfolio sigma.
* Pass: out-of-sample trades >= 30 (cross-sectional rebalances >= 20),
  >= 80% of folds with positive mean netR, and total netR > 0.

Data note: KORUUSDT is excluded from the default universe.  Trading halted
2026-07-15 00:20-09:35 UTC and the contract resumed at ~22.68 vs 481.11 (a
~21.2x redenomination), so raw klines contain a fake -95% bar.  Include it
explicitly with --symbols ... KORUUSDT for the sensitivity run.

Outputs: results.csv next to this file.
"""

from __future__ import annotations

import argparse
import math
import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA_DIR = os.path.join(ROOT, "research", "data", "klines")
OUT_CSV = os.path.join(HERE, "results.csv")

ALL_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "LINKUSDT", "KORUUSDT",
]
# KORUUSDT is excluded from the default universe: trading halted 2026-07-15
# 00:20-09:35 UTC and the contract resumed at ~22.68 vs 481.11 (a ~21.2x
# redenomination).  Raw klines therefore contain a fake -95% bar that would
# contaminate ATR, momentum and any position held through the halt.  The
# 9-symbol sensitivity is reproducible with
#   --symbols BTCUSDT ETHUSDT ... KORUUSDT
SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "LINKUSDT",
]
TFS = ["5m", "15m", "1h", "1d"]

TAKER = 0.0005
SLIP = 0.0002
COST_SIDE = TAKER + SLIP          # 7 bps per side
COST_ROUND_TRIP = 2 * COST_SIDE   # 14 bps

TRAIN_DAYS = 45
TEST_DAYS = 15
STEP_DAYS = 15
DAY_MS = 86_400_000

MIN_TRAIN_TRADES = 10     # directional candidates need this many train trades
MIN_TRAIN_REBALS = 20     # cross-sectional candidates
PASS_TRADES_DIR = 30
PASS_REBALS_XS = 20
PASS_FOLD_FRAC = 0.80

# Directional grids
DONCHIAN_N = [20, 55, 100]
STOP_MULTS = [1.5, 2.0, 3.0]
BREAK_K = [0.5, 1.0, 1.5]
BB_BANDS = [2.0, 2.5]

# Cross-sectional grids
XS_LOOKBACK_DAYS = [7, 14, 30]
XS_FREQS = ["4h", "1d"]


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

def wait_for_data(deadline_s: int = 180) -> None:
    expected = [
        os.path.join(DATA_DIR, f"{s}_{tf}.csv") for s in SYMBOLS for tf in TFS
    ]
    t0 = time.time()
    while True:
        missing = [p for p in expected if (not os.path.exists(p)) or os.path.getsize(p) < 1000]
        if not missing:
            return
        if time.time() - t0 > deadline_s:
            print(f"[warn] still missing {len(missing)} files after {deadline_s}s; "
                  f"continuing with available data")
            for p in missing:
                print("   missing:", p)
            return
        print(f"[wait] {len(missing)} data files missing, sleep 10s ...")
        time.sleep(10)


def load_klines(symbol: str, tf: str) -> pd.DataFrame:
    path = os.path.join(DATA_DIR, f"{symbol}_{tf}.csv")
    df = pd.read_csv(path)
    df = df.sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)
    for col in ["open", "high", "low", "close", "volume", "quote_volume", "trades"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["open_time"] = df["open_time"].astype("int64")
    df = df.dropna(subset=["open", "high", "low", "close"]).reset_index(drop=True)
    df["dt"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    return df


def resample_4h(df: pd.DataFrame) -> pd.DataFrame:
    s = df.set_index("dt")
    agg = {
        "open": "first", "high": "max", "low": "min", "close": "last",
        "volume": "sum", "quote_volume": "sum", "trades": "sum",
    }
    r = s.resample("4h", label="left", closed="left").agg(agg)
    r = r.dropna(subset=["open", "close"]).reset_index()
    r["open_time"] = (r["dt"].astype("int64") // 1_000_000).astype("int64")
    return r


def wilder_atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int = 14) -> np.ndarray:
    prev_close = np.roll(close, 1)
    prev_close[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)))
    return pd.Series(tr).ewm(alpha=1.0 / n, adjust=False).mean().to_numpy()


@dataclass
class Features:
    atr: np.ndarray
    ema200: np.ndarray
    ema_ok: np.ndarray
    donchian: Dict[int, Tuple[np.ndarray, np.ndarray, np.ndarray]]
    bb: Dict[float, Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]


def build_features(df: pd.DataFrame) -> Features:
    o = df["open"].to_numpy(float)
    h = df["high"].to_numpy(float)
    l = df["low"].to_numpy(float)
    c = df["close"].to_numpy(float)
    n = len(df)

    atr = wilder_atr(h, l, c, 14)
    ema200 = pd.Series(c).ewm(span=200, adjust=False).mean().to_numpy()
    # EMA200 is only trusted after 200 bars of history.  On 1d (180 bars) the
    # trend-filtered variants therefore never trade; selection will avoid them.
    ema_ok = np.arange(n) >= 200

    donchian: Dict[int, Tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
    hs = pd.Series(h)
    ls = pd.Series(l)
    for N in DONCHIAN_N:
        upper = hs.rolling(N).max().shift(1).to_numpy()
        lower = ls.rolling(N).min().shift(1).to_numpy()
        mid = (upper + lower) / 2.0
        donchian[N] = (upper, lower, mid)

    cs = pd.Series(c)
    ma20 = cs.rolling(20).mean()
    sd20 = cs.rolling(20).std(ddof=0)
    bb: Dict[float, Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = {}
    for k in BB_BANDS:
        bb[k] = (
            (ma20 + k * sd20).to_numpy(),
            (ma20 - k * sd20).to_numpy(),
            ma20.to_numpy(),
            sd20.to_numpy(),
        )
    return Features(atr=atr, ema200=ema200, ema_ok=ema_ok, donchian=donchian, bb=bb)


# ---------------------------------------------------------------------------
# Directional trade simulation
# ---------------------------------------------------------------------------

@dataclass
class Trade:
    symbol: str
    direction: int                 # +1 long, -1 short
    entry_time: int
    exit_time: int
    entry_idx: int
    exit_idx: int
    entry_raw: float
    exit_raw: float
    entry_fill: float
    exit_fill: float
    gross_ret: float               # raw price return, before costs
    net_ret: float                 # after fees + slippage
    risk_pct: float
    R: float
    reason: str

    def as_dict(self) -> dict:
        return {
            "symbol": self.symbol, "direction": self.direction,
            "entry_time": self.entry_time, "exit_time": self.exit_time,
            "entry_idx": self.entry_idx, "exit_idx": self.exit_idx,
            "entry_raw": self.entry_raw, "exit_raw": self.exit_raw,
            "entry_fill": self.entry_fill, "exit_fill": self.exit_fill,
            "gross_ret": self.gross_ret, "net_ret": self.net_ret,
            "risk_pct": self.risk_pct, "R": self.R,
            "reason": self.reason,
        }


def _make_trade(symbol: str, direction: int, entry_idx: int, exit_idx: int,
                entry_raw: float, exit_raw: float, atr_entry: float,
                stop_mult: Optional[float], risk_atr_mult: float,
                times: np.ndarray, reason: str) -> Trade:
    if direction == 1:
        entry_fill = entry_raw * (1.0 + SLIP)
        exit_fill = exit_raw * (1.0 - SLIP)
        gross_ret = exit_raw / entry_raw - 1.0
        net_ret = exit_fill / entry_fill - 1.0 - 2.0 * TAKER
    else:
        entry_fill = entry_raw * (1.0 - SLIP)
        exit_fill = exit_raw * (1.0 + SLIP)
        gross_ret = 1.0 - exit_raw / entry_raw
        net_ret = 1.0 - exit_fill / entry_fill - 2.0 * TAKER

    # R denominator: the stop distance actually used.  Mid-exit variants have
    # no live stop, so they use a nominal 2*ATR risk unit.
    atr_risk = atr_entry * risk_atr_mult
    risk_pct = max(atr_risk / entry_fill, 1e-8)
    return Trade(
        symbol=symbol, direction=direction,
        entry_time=int(times[entry_idx]), exit_time=int(times[exit_idx]),
        entry_idx=entry_idx, exit_idx=exit_idx,
        entry_raw=float(entry_raw), exit_raw=float(exit_raw),
        entry_fill=entry_fill, exit_fill=exit_fill,
        gross_ret=float(gross_ret), net_ret=float(net_ret),
        risk_pct=float(risk_pct), R=float(net_ret / risk_pct), reason=reason,
    )


def simulate_directional(symbol: str, df: pd.DataFrame, feats: Features,
                         long_sig: np.ndarray, short_sig: np.ndarray,
                         mid: Optional[np.ndarray], stop_mult: Optional[float],
                         risk_atr_mult: float, trailing: bool = False) -> List[Trade]:
    """Vectorised signals, event-driven execution. One position at a time."""
    o = df["open"].to_numpy(float)
    h = df["high"].to_numpy(float)
    l = df["low"].to_numpy(float)
    c = df["close"].to_numpy(float)
    times = df["open_time"].to_numpy(np.int64)
    atr = feats.atr
    n = len(df)
    if n < 3:
        return []

    long_sig = long_sig.copy()
    short_sig = short_sig.copy()
    long_sig[-1] = False
    short_sig[-1] = False

    trades: List[Trade] = []
    i = 0
    while i < n - 1:
        direction = 0
        if long_sig[i]:
            direction = 1
        elif short_sig[i]:
            direction = -1

        if direction == 0:
            i += 1
            continue

        entry_idx = i + 1
        entry_raw = o[entry_idx]
        atr_entry = atr[i]
        if not np.isfinite(atr_entry) or atr_entry <= 0 or not np.isfinite(entry_raw):
            i += 1
            continue

        if direction == 1:
            stop = entry_raw * (1.0 + SLIP) - stop_mult * atr_entry if stop_mult else None
        else:
            stop = entry_raw * (1.0 - SLIP) + stop_mult * atr_entry if stop_mult else None

        j = entry_idx
        exit_idx = n - 1
        exit_raw = c[n - 1]
        reason = "eod"
        while j < n:
            if stop is not None:
                if direction == 1:
                    if o[j] <= stop:
                        exit_idx, exit_raw, reason = j, o[j], "stop_gap"
                        break
                    if l[j] <= stop:
                        exit_idx, exit_raw, reason = j, stop, "stop"
                        break
                else:
                    if o[j] >= stop:
                        exit_idx, exit_raw, reason = j, o[j], "stop_gap"
                        break
                    if h[j] >= stop:
                        exit_idx, exit_raw, reason = j, stop, "stop"
                        break

            if mid is not None:
                if direction == 1 and np.isfinite(mid[j]) and c[j] < mid[j]:
                    if j + 1 < n:
                        exit_idx, exit_raw, reason = j + 1, o[j + 1], "mid"
                    else:
                        exit_idx, exit_raw, reason = j, c[j], "eod"
                    break
                if direction == -1 and np.isfinite(mid[j]) and c[j] > mid[j]:
                    if j + 1 < n:
                        exit_idx, exit_raw, reason = j + 1, o[j + 1], "mid"
                    else:
                        exit_idx, exit_raw, reason = j, c[j], "eod"
                    break

            if trailing and stop is not None:
                # Ratchet only, using information known at this bar's close.
                if direction == 1:
                    stop = max(stop, h[j] - stop_mult * atr[j])
                else:
                    stop = min(stop, l[j] + stop_mult * atr[j])
            j += 1

        trades.append(_make_trade(
            symbol, direction, entry_idx, exit_idx, entry_raw, exit_raw,
            atr_entry, stop_mult, risk_atr_mult, times, reason,
        ))
        i = exit_idx  # allow a fresh signal on the exit bar's close

    return trades


def truncate_trade(tr: Trade, boundary_ms: int, df: pd.DataFrame) -> Optional[Trade]:
    """Force-close a trade at the fold boundary (last bar closing before it)."""
    if tr.entry_time >= boundary_ms:
        return None
    if tr.exit_time <= boundary_ms:
        return tr

    times = df["open_time"].to_numpy(np.int64)
    closes = df["close"].to_numpy(float)
    idx = int(np.searchsorted(times, boundary_ms, side="left")) - 1
    if idx < tr.entry_idx:
        return None
    exit_raw = closes[idx]

    if tr.direction == 1:
        exit_fill = exit_raw * (1.0 - SLIP)
        gross_ret = exit_raw / tr.entry_raw - 1.0
        net_ret = exit_fill / tr.entry_fill - 1.0 - 2.0 * TAKER
    else:
        exit_fill = exit_raw * (1.0 + SLIP)
        gross_ret = 1.0 - exit_raw / tr.entry_raw
        net_ret = 1.0 - exit_fill / tr.entry_fill - 2.0 * TAKER
    return Trade(
        symbol=tr.symbol, direction=tr.direction,
        entry_time=tr.entry_time, exit_time=int(times[idx]),
        entry_idx=tr.entry_idx, exit_idx=idx,
        entry_raw=tr.entry_raw, exit_raw=float(exit_raw),
        entry_fill=tr.entry_fill, exit_fill=float(exit_fill),
        gross_ret=float(gross_ret), net_ret=float(net_ret),
        risk_pct=tr.risk_pct, R=float(net_ret / tr.risk_pct),
        reason="fold_end",
    )


# ---------------------------------------------------------------------------
# Directional strategies / grids
# ---------------------------------------------------------------------------

def make_directional_combos() -> List[dict]:
    combos: List[dict] = []
    # A. Donchian breakout.  "ATR stop" is tested both as a fixed initial stop
    # and as a trailing (Chandelier) stop; walk-forward selection chooses.
    for N in DONCHIAN_N:
        for trend in (0, 1):
            combos.append(dict(family="A", name=f"A_N{N}_trend{trend}_mid",
                               N=N, trend=trend, exit="mid", stop=None, trail=False))
            for s in STOP_MULTS:
                for mode, trail in (("fx", False), ("tr", True)):
                    combos.append(dict(
                        family="A", name=f"A_N{N}_trend{trend}_atr{s}_{mode}",
                        N=N, trend=trend, exit="atr", stop=s, trail=trail))
    # B. ATR breakout
    for k in BREAK_K:
        for s in STOP_MULTS:
            for mode, trail in (("fx", False), ("tr", True)):
                combos.append(dict(family="B", name=f"B_k{k}_atr{s}_{mode}",
                                   k=k, stop=s, trail=trail))
    # D. Bollinger extreme reversion (optional, exploratory)
    for band in BB_BANDS:
        combos.append(dict(family="D", name=f"D_bb{band}_atr2",
                           band=band, stop=2.0, trail=False))
    return combos


def run_directional_symbol(symbol: str, df: pd.DataFrame, feats: Features,
                           combos: Sequence[dict]) -> Dict[str, List[Trade]]:
    c = df["close"].to_numpy(float)
    prev_c = np.roll(c, 1)
    prev_c[0] = c[0]
    atr = feats.atr
    ema = feats.ema200
    ema_ok = feats.ema_ok
    out: Dict[str, List[Trade]] = {}

    for combo in combos:
        fam = combo["family"]
        if fam == "A":
            N = combo["N"]
            upper, lower, mid = feats.donchian[N]
            valid = np.isfinite(upper) & np.isfinite(lower)
            long_sig = valid & (c > upper)
            short_sig = valid & (c < lower)
            if combo["trend"]:
                long_sig &= ema_ok & (c > ema)
                short_sig &= ema_ok & (c < ema)
            exit_mid = mid if combo["exit"] == "mid" else None
            stop_mult = combo["stop"]
            risk_mult = 2.0 if stop_mult is None else stop_mult
        elif fam == "B":
            k = combo["k"]
            valid = np.isfinite(atr) & (atr > 0)
            long_sig = valid & (c > prev_c + k * atr)
            short_sig = valid & (c < prev_c - k * atr)
            exit_mid = None
            stop_mult = combo["stop"]
            risk_mult = stop_mult
        elif fam == "D":
            band = combo["band"]
            up, lo, ma, sd = feats.bb[band]
            valid = np.isfinite(up) & np.isfinite(lo) & (sd > 0)
            long_sig = valid & (c < lo)
            short_sig = valid & (c > up)
            exit_mid = ma
            stop_mult = combo["stop"]
            risk_mult = stop_mult
        else:
            raise ValueError(fam)

        out[combo["name"]] = simulate_directional(
            symbol, df, feats, long_sig, short_sig, exit_mid, stop_mult,
            risk_mult, trailing=bool(combo.get("trail", False)),
        )
    return out


# ---------------------------------------------------------------------------
# Cross-sectional momentum
# ---------------------------------------------------------------------------

@dataclass
class XSPanel:
    freq: str
    times: np.ndarray               # ms
    open: np.ndarray                # [T, S]
    close: np.ndarray               # [T, S]
    sigma: np.ndarray               # [T, S] per-bar volatility
    symbols: List[str]
    step: int
    lookback_bars: Dict[int, int]
    vol_window: int


def build_xs_panel(freq: str, data: Dict[str, pd.DataFrame]) -> XSPanel:
    frames: Dict[str, pd.DataFrame] = {}
    for sym, df in data.items():
        d = resample_4h(df) if freq == "4h" else df.copy()
        frames[sym] = d.set_index("dt")

    all_idx = sorted(set().union(*[set(f.index) for f in frames.values()]))
    idx = pd.DatetimeIndex(all_idx)
    syms = list(frames.keys())
    op = pd.DataFrame({s: frames[s]["open"].reindex(idx) for s in syms}, index=idx)
    cl = pd.DataFrame({s: frames[s]["close"].reindex(idx) for s in syms}, index=idx)
    ret = cl.pct_change()
    vol_window = 30 if freq == "1d" else 30 * 6
    sigma = ret.rolling(vol_window, min_periods=vol_window).std(ddof=0)
    step = 1
    lookback_bars = {L: (L if freq == "1d" else L * 6) for L in XS_LOOKBACK_DAYS}
    times = (idx.astype("int64") // 1_000_000).to_numpy(np.int64)
    return XSPanel(
        freq=freq, times=times,
        open=op.to_numpy(float), close=cl.to_numpy(float),
        sigma=sigma.to_numpy(float), symbols=syms,
        step=step, lookback_bars=lookback_bars, vol_window=vol_window,
    )


def _xs_weights(panel: XSPanel, decision_idx: int, lookback: int,
                volnorm: int, exec_idx: int) -> Tuple[np.ndarray, float]:
    """Target weights from data up to decision bar close; execute next open."""
    S = len(panel.symbols)
    w = np.zeros(S)
    mom_den = panel.close[decision_idx - lookback] if decision_idx >= lookback else None
    if mom_den is None:
        return w, 0.0
    with np.errstate(invalid="ignore", divide="ignore"):
        mom = panel.close[decision_idx] / mom_den - 1.0
        sig = panel.sigma[decision_idx]
    valid = np.isfinite(mom) & np.isfinite(sig) & (sig > 0) & np.isfinite(panel.open[exec_idx])
    if valid.sum() < 4:
        return w, 0.0

    score = mom / sig if volnorm else mom
    idxs = np.where(valid)[0]
    # deterministic tie-break by symbol order
    order = idxs[np.lexsort((idxs, -score[idxs]))]
    longs = order[:2]
    shorts = order[-2:]

    if volnorm:
        inv_l = 1.0 / sig[longs]
        w[longs] = 0.5 * inv_l / inv_l.sum()
        inv_s = 1.0 / sig[shorts]
        w[shorts] = -0.5 * inv_s / inv_s.sum()
    else:
        w[longs] = 0.25
        w[shorts] = -0.25

    held = w != 0.0
    risk = math.sqrt(float(np.sum((w[held] * sig[held]) ** 2))) if held.any() else 0.0
    return w, max(risk, 1e-8)


@dataclass
class XSPeriod:
    time: int
    gross: float
    cost: float
    net_ret: float
    risk_pct: float
    R: float
    gross_exposure: float
    n_long: int
    n_short: int

    def as_dict(self) -> dict:
        return {
            "time": self.time, "gross": self.gross, "cost": self.cost,
            "gross_ret": self.gross, "net_ret": self.net_ret,
            "risk_pct": self.risk_pct, "R": self.R,
            "gross_exposure": self.gross_exposure,
            "n_long": self.n_long, "n_short": self.n_short,
        }


def run_xs_window(panel: XSPanel, start_ms: int, end_ms: int,
                  lookback_days: int, volnorm: int) -> List[XSPeriod]:
    """Standalone cross-sectional book inside [start_ms, end_ms)."""
    times = panel.times
    T = len(times)
    i0 = int(np.searchsorted(times, start_ms, side="left"))
    i1 = int(np.searchsorted(times, end_ms, side="left")) - 1  # last bar opening before end
    if i0 >= T or i1 <= i0:
        return []

    lookback = panel.lookback_bars[lookback_days]
    periods: List[XSPeriod] = []
    w_prev = np.zeros(len(panel.symbols))
    exec_idx = i0

    while exec_idx < i1:
        # For every execution bar, the decision is the close of the previous bar.
        decision_idx = exec_idx - 1
        if decision_idx < 0:
            exec_idx += panel.step
            continue
        w, risk = _xs_weights(panel, decision_idx, lookback, volnorm, exec_idx)

        turnover = float(np.sum(np.abs(w - w_prev)))
        cost_open = turnover * COST_SIDE

        next_exec = exec_idx + panel.step
        if next_exec < i1:
            exit_prices = panel.open[next_exec]
            held = (w != 0.0) & np.isfinite(exit_prices)
            if held.any():
                gross = float(np.sum(w[held] * (exit_prices[held] / panel.open[exec_idx][held] - 1.0)))
            else:
                gross = 0.0
            net = gross - cost_open
            active = bool(np.any(w != 0.0) or np.any(w_prev != 0.0))
            if active:
                periods.append(XSPeriod(
                    time=int(times[exec_idx]), gross=gross, cost=cost_open,
                    net_ret=net, risk_pct=risk, R=net / risk,
                    gross_exposure=float(np.sum(np.abs(w))),
                    n_long=int(np.sum(w > 0)), n_short=int(np.sum(w < 0)),
                ))
            w_prev = w
            exec_idx = next_exec
            continue

        # Last period: exit at the fold boundary.
        exit_prices = panel.open[i1] if next_exec == i1 else panel.close[i1]
        held = (w != 0.0) & np.isfinite(exit_prices)
        if held.any():
            gross = float(np.sum(w[held] * (exit_prices[held] / panel.open[exec_idx][held] - 1.0)))
        else:
            gross = 0.0
        cost_close = float(np.sum(np.abs(w))) * COST_SIDE
        net = gross - cost_open - cost_close
        active = bool(np.any(w != 0.0) or np.any(w_prev != 0.0))
        if active:
            periods.append(XSPeriod(
                time=int(times[exec_idx]), gross=gross,
                cost=cost_open + cost_close, net_ret=net,
                risk_pct=risk, R=net / risk,
                gross_exposure=float(np.sum(np.abs(w))),
                n_long=int(np.sum(w > 0)), n_short=int(np.sum(w < 0)),
            ))
        break

    return periods


# ---------------------------------------------------------------------------
# Stats / walk-forward
# ---------------------------------------------------------------------------

def trade_stats(items: Sequence[dict]) -> dict:
    n = len(items)
    if n == 0:
        return dict(n=0, mean_R=0.0, sum_R=0.0, mean_ret=0.0,
                    mean_gross_ret=0.0, mean_cost_ret=0.0,
                    median_R=0.0, median_ret=0.0, t_R=0.0,
                    win_rate=0.0, profit_factor=0.0, payoff=0.0, max_dd_R=0.0)
    R = np.array([x["R"] for x in items], float)
    ret = np.array([x["net_ret"] for x in items], float)
    gross = np.array([x.get("gross_ret", x["net_ret"]) for x in items], float)
    wins = ret[ret > 0]
    losses = ret[ret < 0]
    pf = float(wins.sum() / abs(losses.sum())) if losses.sum() != 0 else float("inf")
    payoff = float(wins.mean() / abs(losses.mean())) if len(wins) and len(losses) else float("inf")
    order = np.argsort([x.get("entry_time", x.get("time", 0)) for x in items])
    cum = np.cumsum(R[order])
    peak = np.maximum.accumulate(cum)
    max_dd = float(np.max(peak - cum)) if len(cum) else 0.0
    sd = float(R.std(ddof=1)) if n > 1 else 0.0
    t = float(R.mean() / (sd / math.sqrt(n))) if sd > 0 else 0.0
    return dict(
        n=n, mean_R=float(R.mean()), sum_R=float(R.sum()),
        mean_ret=float(ret.mean()), mean_gross_ret=float(gross.mean()),
        mean_cost_ret=float(gross.mean() - ret.mean()),
        median_R=float(np.median(R)), median_ret=float(np.median(ret)),
        t_R=t, win_rate=float((ret > 0).mean()),
        profit_factor=pf, payoff=payoff, max_dd_R=max_dd,
    )


def fold_windows(t0_ms: int, n_folds: int) -> List[dict]:
    out = []
    for k in range(n_folds):
        train_start = t0_ms + k * STEP_DAYS * DAY_MS
        train_end = train_start + TRAIN_DAYS * DAY_MS
        test_start = train_end
        test_end = test_start + TEST_DAYS * DAY_MS
        out.append(dict(fold=k + 1, train_start=train_start,
                        train_end=train_end, test_start=test_start,
                        test_end=test_end))
    return out


def _train_items(by_sym: Dict[str, List[Trade]], dfs: Dict[str, pd.DataFrame],
                 win: dict) -> List[dict]:
    items: List[dict] = []
    for sym, trades in by_sym.items():
        df = dfs[sym]
        for tr in trades:
            if win["train_start"] <= tr.entry_time < win["train_end"]:
                tt = truncate_trade(tr, win["train_end"], df)
                if tt is not None:
                    items.append(tt.as_dict())
    return items


def _test_items(by_sym: Dict[str, List[Trade]], dfs: Dict[str, pd.DataFrame],
                win: dict) -> List[dict]:
    items: List[dict] = []
    for sym, trades in by_sym.items():
        df = dfs[sym]
        for tr in trades:
            if win["test_start"] <= tr.entry_time < win["test_end"]:
                tt = truncate_trade(tr, win["test_end"], df)
                if tt is not None:
                    items.append(tt.as_dict())
    return items


def select_directional(combo_trades: Dict[str, Dict[str, List[Trade]]],
                       dfs: Dict[str, pd.DataFrame], win: dict) -> Tuple[str, dict]:
    best_name = None
    best_score = -1e18
    best_stats = None
    fallback_name = None
    fallback_n = -1
    fallback_stats = None

    for name, by_sym in combo_trades.items():
        st = trade_stats(_train_items(by_sym, dfs, win))
        if fallback_stats is None or st["n"] > fallback_n or (
                st["n"] == fallback_n and st["mean_R"] > fallback_stats["mean_R"]):
            fallback_name, fallback_n, fallback_stats = name, st["n"], st
        if st["n"] >= MIN_TRAIN_TRADES and st["mean_R"] > best_score:
            best_score = st["mean_R"]
            best_name = name
            best_stats = st
    if best_name is None:
        return fallback_name, fallback_stats
    return best_name, best_stats


def walk_forward_directional(family_combos: Sequence[dict],
                             combo_trades: Dict[str, Dict[str, List[Trade]]],
                             dfs: Dict[str, pd.DataFrame], folds: Sequence[dict]) -> List[dict]:
    """One parameter set selected per fold, then tested on the next 15 days."""
    grid = {c["name"]: combo_trades[c["name"]] for c in family_combos}
    results = []
    for win in folds:
        name, train_st = select_directional(grid, dfs, win)
        items = _test_items(grid[name], dfs, win) if name is not None else []
        results.append(dict(
            params=name, train_n=train_st["n"],
            train_mean_R=train_st["mean_R"], train_sum_R=train_st["sum_R"],
            test_items=items, test_st=trade_stats(items),
        ))
    return results


def xs_combo_name(lookback: int, volnorm: int, freq: str) -> str:
    return f"C_lb{lookback}_vol{volnorm}_{freq}"


def select_xs(panel: XSPanel, win: dict, freq: str) -> Tuple[str, dict]:
    best = None
    best_mean = -1e18
    best_st = None
    fallback = None
    fallback_n = -1
    fallback_st = None
    for lookback in XS_LOOKBACK_DAYS:
        for volnorm in (0, 1):
            name = xs_combo_name(lookback, volnorm, freq)
            periods = run_xs_window(panel, win["train_start"], win["train_end"], lookback, volnorm)
            st = trade_stats([p.as_dict() for p in periods])
            if fallback_st is None or st["n"] > fallback_n or (
                    st["n"] == fallback_n and st["mean_R"] > fallback_st["mean_R"]):
                fallback, fallback_n, fallback_st = name, st["n"], st
            if st["n"] >= MIN_TRAIN_REBALS and st["mean_R"] > best_mean:
                best_mean = st["mean_R"]
                best = name
                best_st = st
    if best is None:
        return fallback, fallback_st
    return best, best_st


def walk_forward_xs(panel: XSPanel, folds: Sequence[dict], freq: str) -> List[dict]:
    results = []
    for win in folds:
        name, train_st = select_xs(panel, win, freq)
        lookback = int(name.split("_")[1][2:])
        volnorm = int(name.split("_")[2][3:])
        periods = run_xs_window(panel, win["test_start"], win["test_end"], lookback, volnorm)
        items = [p.as_dict() for p in periods]
        results.append(dict(
            params=name, train_n=train_st["n"],
            train_mean_R=train_st["mean_R"], train_sum_R=train_st["sum_R"],
            test_items=items, test_st=trade_stats(items),
        ))
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def fmt_ms(ms: int) -> str:
    return pd.to_datetime(int(ms), unit="ms", utc=True).strftime("%Y-%m-%d %H:%M")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tfs", nargs="*", default=TFS, choices=TFS)
    ap.add_argument("--symbols", nargs="*", default=SYMBOLS)
    ap.add_argument("--families", nargs="*", default=["A", "B", "C", "D"],
                    choices=["A", "B", "C", "D"])
    ap.add_argument("--out", default=OUT_CSV)
    ap.add_argument("--stop-filter", choices=["all", "fx", "tr"], default="all",
                    help="restrict A/B ATR-stop variants to fixed (fx) or trailing (tr)")
    ap.add_argument("--no-wait", action="store_true")
    args = ap.parse_args()

    if not args.no_wait:
        wait_for_data()

    symbols = [s for s in args.symbols if os.path.exists(os.path.join(DATA_DIR, f"{s}_5m.csv"))]
    print(f"symbols ({len(symbols)}): {symbols}")

    # Common calendar anchor: floor of the earliest bar, in UTC days.
    first_times = []
    for s in symbols:
        p = os.path.join(DATA_DIR, f"{s}_5m.csv")
        if os.path.exists(p):
            first_times.append(int(pd.read_csv(p, nrows=1)["open_time"].iloc[0]))
    first_bar = min(first_times)
    t0_ms = (first_bar // DAY_MS) * DAY_MS
    span_days = 180
    n_folds = int(math.floor((span_days - TRAIN_DAYS) / STEP_DAYS))
    folds = fold_windows(t0_ms, n_folds)
    print(f"anchor={fmt_ms(t0_ms)}  folds={n_folds}")

    rows: List[dict] = []

    data_by_tf: Dict[str, Dict[str, pd.DataFrame]] = {}
    feats_by_tf: Dict[str, Dict[str, Features]] = {}

    # ---------------- Directional families ----------------
    dir_families = [f for f in args.families if f in ("A", "B", "D")]
    if dir_families:
        all_combos = make_directional_combos()
        if args.stop_filter != "all":
            want_trail = args.stop_filter == "tr"
            all_combos = [
                c for c in all_combos
                if c["family"] not in ("A", "B")
                or c.get("exit") == "mid"
                or bool(c.get("trail", False)) == want_trail
            ]
        print(f"directional combos: {len(all_combos)}")

        for tf in args.tfs:
            data = {s: load_klines(s, tf) for s in symbols}
            data_by_tf[tf] = data
            feats = {s: build_features(data[s]) for s in symbols}
            feats_by_tf[tf] = feats

            combo_trades: Dict[str, Dict[str, List[Trade]]] = {c["name"]: {} for c in all_combos}
            for sym in symbols:
                per_combo = run_directional_symbol(sym, data[sym], feats[sym], all_combos)
                for name, trades in per_combo.items():
                    combo_trades[name][sym] = trades
            n_raw = sum(len(v) for c in combo_trades.values() for v in c.values())
            print(f"  [{tf}] simulated {n_raw} raw trades")

            for fam in dir_families:
                fam_combos = [c for c in all_combos if c["family"] == fam]
                fold_results = walk_forward_directional(fam_combos, combo_trades, data, folds)
                _append_directional_rows(rows, fam, tf, fam_combos[0]["name"], folds, fold_results)
                agg = [x for r in fold_results for x in r["test_items"]]
                st = trade_stats(agg)
                pos = sum(1 for r in fold_results if r["test_st"]["n"] > 0 and r["test_st"]["mean_R"] > 0)
                passed, note = _pass_check(fam, st, pos, len(folds))
                selected = ",".join(str(r["params"]) for r in fold_results)
                rows.append(_agg_row(fam, tf, selected, folds, fold_results, st, pos, passed, note))

    # ---------------- Cross-sectional ----------------
    if "C" in args.families:
        for freq in XS_FREQS:
            base_tf = "1h" if freq == "4h" else "1d"
            if base_tf not in args.tfs:
                print(f"  [C/{freq}] skipped (need {base_tf} data in --tfs)")
                continue
            data = {s: load_klines(s, base_tf) for s in symbols}
            panel = build_xs_panel(freq, data)
            print(f"  [C/{freq}] panel {panel.close.shape}, symbols={panel.symbols}")

            fold_results = walk_forward_xs(panel, folds, freq)
            _append_xs_rows(rows, freq, f"C_grid_{freq}", folds, fold_results)
            agg = [x for r in fold_results for x in r["test_items"]]
            st = trade_stats(agg)
            pos = sum(1 for r in fold_results if r["test_st"]["n"] > 0 and r["test_st"]["mean_R"] > 0)
            passed, note = _pass_check("C", st, pos, len(folds))
            selected = ",".join(str(r["params"]) for r in fold_results)
            rows.append(_agg_row("C", freq, selected, folds, fold_results, st, pos, passed, note))

    df_out = pd.DataFrame(rows)
    df_out.to_csv(args.out, index=False, encoding="utf-8-sig")
    print(f"\nwrote {args.out} ({len(df_out)} rows)")

    # Console summary
    agg = df_out[df_out["row_type"] == "aggregate"].copy()
    if len(agg):
        cols = ["family", "tf", "total_n", "total_mean_R", "total_t_R",
                "total_mean_ret_pct", "total_cost_pct", "total_median_ret_pct",
                "positive_folds", "n_folds", "passed"]
        cols = [c for c in cols if c in agg.columns]
        with pd.option_context("display.max_rows", 200, "display.width", 220,
                               "display.max_colwidth", 32):
            print(agg[cols].to_string(index=False))


def _append_directional_rows(rows, fam, tf, name, folds, fold_results):
    for win, r in zip(folds, fold_results):
        st = r["test_st"]
        rows.append(dict(
            row_type="fold", family=fam, tf=tf, fold=win["fold"],
            train_start=fmt_ms(win["train_start"]), train_end=fmt_ms(win["train_end"]),
            test_start=fmt_ms(win["test_start"]), test_end=fmt_ms(win["test_end"]),
            params=r["params"], train_n=r["train_n"],
            train_mean_R=r["train_mean_R"], train_sum_R=r["train_sum_R"],
            n_test=st["n"], test_mean_R=st["mean_R"], test_sum_R=st["sum_R"],
            test_mean_ret_pct=100.0 * st["mean_ret"],
            test_mean_gross_ret_pct=100.0 * st["mean_gross_ret"],
            test_cost_pct=100.0 * st["mean_cost_ret"],
            test_median_ret_pct=100.0 * st["median_ret"],
            test_median_R=st["median_R"], test_t_R=st["t_R"],
            test_win_rate=st["win_rate"],
            test_profit_factor=st["profit_factor"], test_payoff=st["payoff"],
            test_max_dd_R=st["max_dd_R"],
        ))


def _append_xs_rows(rows, freq, name, folds, fold_results):
    for win, r in zip(folds, fold_results):
        st = r["test_st"]
        rows.append(dict(
            row_type="fold", family="C", tf=freq, fold=win["fold"],
            train_start=fmt_ms(win["train_start"]), train_end=fmt_ms(win["train_end"]),
            test_start=fmt_ms(win["test_start"]), test_end=fmt_ms(win["test_end"]),
            params=r["params"], train_n=r["train_n"],
            train_mean_R=r["train_mean_R"], train_sum_R=r["train_sum_R"],
            n_test=st["n"], test_mean_R=st["mean_R"], test_sum_R=st["sum_R"],
            test_mean_ret_pct=100.0 * st["mean_ret"],
            test_mean_gross_ret_pct=100.0 * st["mean_gross_ret"],
            test_cost_pct=100.0 * st["mean_cost_ret"],
            test_median_ret_pct=100.0 * st["median_ret"],
            test_median_R=st["median_R"], test_t_R=st["t_R"],
            test_win_rate=st["win_rate"],
            test_profit_factor=st["profit_factor"], test_payoff=st["payoff"],
            test_max_dd_R=st["max_dd_R"],
        ))


def _pass_check(fam: str, st: dict, pos_folds: int, n_folds: int) -> Tuple[bool, str]:
    need_n = PASS_REBALS_XS if fam == "C" else PASS_TRADES_DIR
    need_folds = int(math.ceil(PASS_FOLD_FRAC * n_folds))
    enough = st["n"] >= need_n
    fold_ok = pos_folds >= need_folds
    passed = enough and fold_ok and st["sum_R"] > 0
    bits = []
    if not enough:
        bits.append(f"n={st['n']}<{need_n}")
    if not fold_ok:
        bits.append(f"pos_folds={pos_folds}<{need_folds}")
    if st["sum_R"] <= 0:
        bits.append(f"sum_R={st['sum_R']:.2f}<=0")
    if st["mean_R"] > 0 and st["mean_ret"] <= 0:
        bits.append("warn:mean_ret<=0")
    return passed, "PASS" if passed else "; ".join(bits)


def _agg_row(fam, tf, name, folds, fold_results, st, pos_folds, passed, note):
    fold_means = np.array([r["test_st"]["mean_R"] for r in fold_results], float)
    fold_sd = fold_means.std(ddof=1) if len(fold_means) > 1 else 0.0
    fold_t = float(fold_means.mean() / (fold_sd / math.sqrt(len(fold_means)))) if fold_sd > 0 else 0.0
    return dict(
        row_type="aggregate", family=fam, tf=tf, fold="ALL",
        train_start=fmt_ms(folds[0]["train_start"]),
        train_end=fmt_ms(folds[-1]["train_end"]),
        test_start=fmt_ms(folds[0]["test_start"]),
        test_end=fmt_ms(folds[-1]["test_end"]),
        params=name, train_n=int(sum(r["train_n"] for r in fold_results)),
        train_mean_R=float(np.mean([r["train_mean_R"] for r in fold_results])),
        train_sum_R=float(sum(r["train_sum_R"] for r in fold_results)),
        n_test=st["n"], test_mean_R=st["mean_R"], test_sum_R=st["sum_R"],
        test_mean_ret_pct=100.0 * st["mean_ret"],
        test_mean_gross_ret_pct=100.0 * st["mean_gross_ret"],
        test_cost_pct=100.0 * st["mean_cost_ret"],
        test_median_ret_pct=100.0 * st["median_ret"],
        test_median_R=st["median_R"], test_t_R=st["t_R"],
        test_win_rate=st["win_rate"],
        test_profit_factor=st["profit_factor"], test_payoff=st["payoff"],
        test_max_dd_R=st["max_dd_R"], positive_folds=pos_folds, n_folds=len(folds),
        total_n=st["n"], total_mean_R=st["mean_R"], total_sum_R=st["sum_R"],
        total_mean_ret_pct=100.0 * st["mean_ret"],
        total_mean_gross_ret_pct=100.0 * st["mean_gross_ret"],
        total_cost_pct=100.0 * st["mean_cost_ret"],
        total_median_ret_pct=100.0 * st["median_ret"],
        total_median_R=st["median_R"], total_t_R=st["t_R"],
        fold_t_R=fold_t,
        total_win_rate=st["win_rate"],
        total_profit_factor=st["profit_factor"], total_payoff=st["payoff"],
        total_max_dd_R=st["max_dd_R"], passed=passed, pass_reason=note,
    )


if __name__ == "__main__":
    main()
