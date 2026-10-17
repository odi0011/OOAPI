#!/usr/bin/env python
"""网格策略离线研究：多头 / 空头，几何网格，因果区间选择，保守成交模型。

设计要点
--------
1. 时间切分：数据共 180 天。前 30 天只做指标预热，不交易；随后 10 个
   15 天「网格周期」(campaign)。campaign 0..5 = 研究期（90 天），
   campaign 6..9 = 留出期（60 天）。另外给 3 折滚动验证：
      fold1 = campaign 0..2 (45d)
      fold2 = campaign 3..5 (45d)
      fold3 = campaign 6..9 (60d, 与留出期重合)
   每个 campaign 开始时用**此前**的数据决定 lower/upper，周期内不再改；
   周期末按收盘价强制平掉剩余库存（taker + 滑点），使各周期独立、可做统计。

2. 区间规则（全部因果，只用 t0 之前的数据）：
      q7   : 过去 7 天 5m 收盘的 5% / 95% 分位
      q30  : 过去 30 天 5m 收盘的 5% / 95% 分位
      atr  : 日线 ATR14，中心=最近日收盘，上下 = center*exp(±2.5*ATR/center)
      bb   : 日线对数收盘 30 日，mean ± 2*std（对数空间）
   t0 时若价格已在区间外，真实引擎会拒绝启动，本模拟记为 skipped。

3. 成交模型（5m bar；exec_tf 可换成 15m/1h 做稳健性）：
   - 几何网格，档数 8/12/20/30；相邻线比例相同，价格对齐 tickSize。
   - 多头：在 p_i 买，在 p_{i+1} 卖；最后一条线永不买。
     空头镜像：在 p_i 卖，在 p_{i-1} 买；最下面一条线永不卖。
   - bar 内 low<=买线 / high>=卖线即视为触及；若 open 已跳空穿过，
     按 open 成交（保守：跳空按实际开盘价，而不是更有利的挂单价）。
   - 每档每根 bar 最多一个动作；同 bar 不允许买+卖（不虚构 bar 内往返）。
   - 只有价格曾经在买线之上（多头）/ 卖线之下（空头）时该档才激活，
     避免建网瞬间把远高于现价的线全部当作已挂买单。
   - maker 0.02%（USDT-M 合约）/ 0.1%（现货）；周期末强平 taker
     0.05%（合约）/0.1%（现货）+ 0.05% 滑点。
   - 合约资金费按 funding 历史逐个结算点计入（多付空收，正费率时）。
     现货多头不计资金费。多空都用合约口径做主要对比（5x）。

4. 收益口径：
   - 每格名义预算 B=100,000 USDT（满网格）；qty = B/sum(lines)，按 step 向下取整。
   - 保证金占用 = B/leverage（合约）或 B（现货）。
   - 已实现 = 完成往返的价差 - 手续费 + 平仓部分的资金费；
     浮动/未实现 = 周期末仍持仓的 mark-to-market - 入场费 - 强平成本 + 资金费。
   - 另做「去漂移」反事实：把同一 campaign 的 OHLC 按 exp(-mu*j) 缩放，
     去掉区间内的线性对数漂移，再跑同一网格。total - detrended 即方向漂移贡献。

5. 压力测试（解析、满网格最坏情形）：多头假设价格从 upper 一路跌到
   lower*(1+x)，空头假设从 lower 一路涨到 upper*(1+x)，x=10/20/30%；
   同时给出 2% 交易所侧止损触发时的亏损。

输出：research/grid/results.csv（长表：campaign 行 + 各 scope 汇总行）。
"""

from __future__ import annotations

import argparse
import bisect
import csv
import json
import math
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import stats

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "research", "data")
OUTDIR = os.path.join(ROOT, "research", "grid")

SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "LINKUSDT", "KORUUSDT",
]
LEVELS = [8, 12, 20, 30]
RULES = ["q7", "q30", "atr", "bb"]
DIRECTIONS = ["long", "short"]

DAY_MS = 86_400_000
HOUR_MS = 3_600_000
WARMUP_DAYS = 30
CAMPAIGN_DAYS = 15
N_CAMPAIGNS = 10
RESEARCH_CAMPAIGNS = 6          # 0..5 = days 30..120
HOLDOUT_CAMPAIGNS = 4           # 6..9 = days 120..180

NOTIONAL_BUDGET = 100_000.0     # full-grid notional; returns are scale-free
FUT_LEVERAGE = 5.0
MAKER_FUT = 0.0002
MAKER_SPOT = 0.0010
TAKER_FUT = 0.0005
TAKER_SPOT = 0.0010
SLIPPAGE = 0.0005
MIN_NET_EDGE = 0.0005           # same as grid_plan.go GridFeeEdgePct
MAX_SPACING = 0.20              # same as GridMaxSpacingPct
EXCHANGE_INFO = os.path.join(DATA, "exchange_info.json")

# Tail / stop scenarios
TAIL_XS = [0.10, 0.20, 0.30]
STOP_BEYOND = 0.02


# ---------------------------------------------------------------------------
# data loading
# ---------------------------------------------------------------------------

def load_exchange_rules() -> dict[str, dict]:
    with open(EXCHANGE_INFO, "r", encoding="utf-8") as fh:
        info = json.load(fh)
    out = {}
    for s in info["symbols"]:
        if s["symbol"] not in SYMBOLS:
            continue
        flt = {f["filterType"]: f for f in s["filters"]}
        out[s["symbol"]] = {
            "tick": float(flt["PRICE_FILTER"]["tickSize"]),
            "step": float(flt["LOT_SIZE"]["stepSize"]),
            "min_qty": float(flt["LOT_SIZE"]["minQty"]),
            "min_notional": float(flt.get("MIN_NOTIONAL", {}).get("notional", 5.0)),
        }
    return out


@dataclass
class SymData:
    symbol: str
    t: np.ndarray
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    daily: pd.DataFrame          # open_time 00:00 UTC + OHLC, complete days
    h1: pd.DataFrame | None      # exchange-aligned 1h bars (for regime labels)
    funding_t: np.ndarray
    funding_r: np.ndarray
    tick: float
    step: float
    min_qty: float
    min_notional: float
    adjustment: dict


def build_daily_from_5m(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 5m bars to UTC days. The first/last day may be partial."""
    day = (df["open_time"].values // DAY_MS) * DAY_MS
    g = df.assign(day=day).groupby("day", sort=True)
    out = pd.DataFrame({
        "open_time": g["open"].first().index.astype(np.int64),
        "open": g["open"].first().values,
        "high": g["high"].max().values,
        "low": g["low"].min().values,
        "close": g["close"].last().values,
        "volume": g["volume"].sum().values,
    })
    return out


def adjust_contract_change(symbol: str, k: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Remove exchange-halt placeholder bars and adjust contract-size changes.

    KORUUSDT was halted 2026-07-15 00:20-09:35 UTC.  Binance returned 111
    flat, zero-volume 5m bars at the pre-halt price (481.11), then the first
    real bar opened at 22.68.  This is a ~21.2x contract/multiplier change,
    not a -95% price move.  We drop the placeholder bars and scale all
    pre-halt OHLC by first_open/last_close so the series is continuous.
    """
    if symbol != "KORUUSDT":
        return k, {}
    zero = (k["volume"].values == 0) & (k["quote_volume"].values == 0)
    best_start = best_len = 0
    cur_start = cur_len = 0
    for i, z in enumerate(zero):
        if z:
            if cur_len == 0:
                cur_start = i
            cur_len += 1
            if cur_len > best_len:
                best_len, best_start = cur_len, cur_start
        else:
            cur_len = 0
    if best_len < 50 or best_start == 0 or best_start + best_len >= len(k):
        return k, {}
    i0, i1 = best_start, best_start + best_len - 1
    last_close = float(k["close"].iloc[i0 - 1])
    first_open = float(k["open"].iloc[i1 + 1])
    if last_close <= 0 or first_open <= 0:
        return k, {}
    factor = last_close / first_open
    if not (1.5 < factor < 100.0):
        return k, {}
    k = k.copy()
    pre = k.index <= i0 - 1
    for col in ("open", "high", "low", "close"):
        k.loc[pre, col] = k.loc[pre, col].astype(float) / factor
    info = {
        "factor": factor,
        "halt_start_ms": int(k["open_time"].iloc[i0]),
        "halt_end_ms": int(k["open_time"].iloc[i1]),
        "last_close_raw": last_close,
        "first_open_raw": first_open,
        "dropped_bars": int(best_len),
    }
    k = k.drop(k.index[i0:i1 + 1]).reset_index(drop=True)
    return k, info


def load_symbol(symbol: str, rules: dict) -> SymData:
    k = pd.read_csv(os.path.join(DATA, "klines", f"{symbol}_5m.csv"))
    k = k.dropna(subset=["open_time", "open", "high", "low", "close"])
    k = k.sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)
    for col in ("open", "high", "low", "close"):
        k[col] = k[col].astype(float)
    k, adj_info = adjust_contract_change(symbol, k)

    daily_5m = build_daily_from_5m(k)
    if adj_info:
        # Contract-adjusted symbol: rebuild everything from the adjusted 5m.
        daily = daily_5m
        h1 = None
    else:
        d1_path = os.path.join(DATA, "klines", f"{symbol}_1d.csv")
        if os.path.exists(d1_path):
            d1 = pd.read_csv(d1_path)
            d1 = d1.dropna(subset=["open_time", "open", "high", "low", "close"])
            d1 = d1.sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)
            for col in ("open", "high", "low", "close"):
                d1[col] = d1[col].astype(float)
            # 1d 文件缺第一个不完整日（下载起点在日中），用 5m 聚合补上。
            first_1d = int(d1["open_time"].iloc[0])
            early = daily_5m[daily_5m["open_time"] < first_1d]
            daily = pd.concat([early, d1], ignore_index=True)
        else:
            daily = daily_5m
        daily = daily.sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)

        h1_path = os.path.join(DATA, "klines", f"{symbol}_1h.csv")
        h1 = None
        if os.path.exists(h1_path):
            h1 = pd.read_csv(h1_path)
            h1 = h1.dropna(subset=["open_time", "open", "high", "low", "close"])
            h1 = h1.sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)
            for col in ("open", "high", "low", "close"):
                h1[col] = h1[col].astype(float)

    fpath = os.path.join(DATA, "funding", f"{symbol}.csv")
    if os.path.exists(fpath):
        f = pd.read_csv(fpath)
        f = f.dropna().sort_values("funding_time").drop_duplicates("funding_time")
        ft = f["funding_time"].values.astype(np.int64)
        fr = f["funding_rate"].values.astype(float)
    else:
        ft = np.array([], dtype=np.int64)
        fr = np.array([], dtype=float)

    r = rules[symbol]
    return SymData(
        symbol=symbol,
        t=k["open_time"].values.astype(np.int64),
        o=k["open"].values, h=k["high"].values,
        l=k["low"].values, c=k["close"].values,
        daily=daily, h1=h1,
        funding_t=ft, funding_r=fr,
        tick=r["tick"], step=r["step"],
        min_qty=r["min_qty"], min_notional=r["min_notional"],
        adjustment=adj_info,
    )


# ---------------------------------------------------------------------------
# causal range rules
# ---------------------------------------------------------------------------

def daily_complete_upto(sd: SymData, t0: int) -> pd.DataFrame:
    d = sd.daily
    return d[(d["open_time"].values.astype(np.int64) + DAY_MS) <= t0]


def daily_closes_upto(sd: SymData, t0: int, n: int) -> np.ndarray | None:
    d = daily_complete_upto(sd, t0)
    if len(d) < n:
        return None
    return d["close"].values[-n:].astype(float)


def range_for_rule(sd: SymData, t0: int, rule: str) -> tuple[float, float] | None:
    """Return causal (lower, upper) using only bars strictly before t0."""
    if rule in ("q7", "q30"):
        days = 7 if rule == "q7" else 30
        lo_ms = t0 - days * DAY_MS
        # Require the full lookback window: a "30-day quantile" computed on
        # 12 days of a newly listed symbol is not the same rule.  Allow 1h of
        # tolerance for the download start being a few minutes after a boundary.
        if len(sd.t) == 0 or int(sd.t[0]) > lo_ms + HOUR_MS:
            return None
        m = (sd.t >= lo_ms) & (sd.t < t0)
        x = sd.c[m]
        if len(x) < 50:
            return None
        lo, hi = np.quantile(x, [0.05, 0.95])
        if not (np.isfinite(lo) and np.isfinite(hi) and lo > 0 and hi > lo):
            return None
        return float(lo), float(hi)

    if rule == "atr":
        d = daily_complete_upto(sd, t0)
        if len(d) < 15:
            return None
        h = d["high"].values.astype(float)
        l = d["low"].values.astype(float)
        c = d["close"].values.astype(float)
        prev_c = np.concatenate([[c[0]], c[:-1]])
        tr = np.maximum(h - l, np.maximum(np.abs(h - prev_c), np.abs(l - prev_c)))
        atr = float(np.mean(tr[-14:]))
        center = float(c[-1])
        if not (center > 0 and atr > 0 and np.isfinite(atr)):
            return None
        atr_pct = atr / center
        # log-space band keeps lower > 0
        return float(center * math.exp(-2.5 * atr_pct)), float(center * math.exp(2.5 * atr_pct))

    if rule == "bb":
        c = daily_closes_upto(sd, t0, 30)
        if c is None or np.any(c <= 0):
            return None
        lc = np.log(c)
        mu = float(np.mean(lc))
        sd_ = float(np.std(lc, ddof=0))
        if not (sd_ > 0 and np.isfinite(sd_)):
            return None
        return float(math.exp(mu - 2.0 * sd_)), float(math.exp(mu + 2.0 * sd_))

    raise ValueError(rule)


# ---------------------------------------------------------------------------
# grid construction
# ---------------------------------------------------------------------------

def align_down(x: float, tick: float) -> float:
    if tick <= 0:
        return float(x)
    return float(math.floor(round(x / tick, 9)) * tick)


def build_grid(sd: SymData, lower: float, upper: float, levels: int,
               fee_rate: float) -> dict:
    """Geometric lines + constant base qty per level (matches grid_plan.go)."""
    res = {
        "ok": False, "reason": "", "lines": None, "qty": 0.0,
        "spacing_pct": float("nan"), "range_width_pct": (upper / lower - 1.0) * 100
        if lower > 0 else float("nan"),
    }
    if not (lower > 0 and upper > lower and np.isfinite(lower) and np.isfinite(upper)):
        res["reason"] = "invalid_range"
        return res
    if levels < 3:
        res["reason"] = "invalid_levels"
        return res

    ratio = (upper / lower) ** (1.0 / (levels - 1))
    lines = [align_down(lower * ratio ** i, sd.tick) for i in range(levels)]
    lines[-1] = align_down(upper, sd.tick)
    for i in range(1, len(lines)):
        if lines[i] <= lines[i - 1]:
            res["reason"] = "duplicate_lines"
            return res
    spacing = min(lines[i] / lines[i - 1] - 1.0 for i in range(1, len(lines)))
    res["spacing_pct"] = spacing * 100
    if spacing < 2 * fee_rate + MIN_NET_EDGE:
        res["reason"] = "spacing_too_tight"
        return res
    if spacing > MAX_SPACING:
        res["reason"] = "spacing_too_wide"
        return res

    total = float(sum(lines))
    qty = math.floor((NOTIONAL_BUDGET / total) / sd.step + 1e-9) * sd.step
    qty = round(qty, 10)
    if qty <= 0 or qty < sd.min_qty or qty * lines[0] < sd.min_notional:
        res["reason"] = "budget_too_small"
        return res

    res.update(ok=True, lines=np.array(lines, dtype=float), qty=float(qty))
    return res


# ---------------------------------------------------------------------------
# hit / activation precomputation
# ---------------------------------------------------------------------------

@dataclass
class Hits:
    low: list[list[int]]
    high: list[list[int]]
    first_above: np.ndarray
    first_below: np.ndarray


def first_true(mask: np.ndarray) -> int:
    idx = np.flatnonzero(mask)
    return int(idx[0]) if len(idx) else -1


def precompute_hits(o: np.ndarray, h: np.ndarray, l: np.ndarray,
                    c: np.ndarray, lines: np.ndarray, start_price: float) -> Hits:
    low = [np.flatnonzero(l <= p).tolist() for p in lines]
    high = [np.flatnonzero(h >= p).tolist() for p in lines]
    fa = np.empty(len(lines), dtype=np.int64)
    fb = np.empty(len(lines), dtype=np.int64)
    for i, p in enumerate(lines):
        if start_price > p:
            fa[i] = -1
        else:
            fa[i] = first_true(c > p)
        if start_price < p:
            fb[i] = -1
        else:
            fb[i] = first_true(c < p)
    return Hits(low=low, high=high, first_above=fa, first_below=fb)


# ---------------------------------------------------------------------------
# campaign simulation
# ---------------------------------------------------------------------------

def _stress_loss(lines: np.ndarray, qty: float, direction: str,
                 x: float, fee: float, taker: float,
                 slip: float = SLIPPAGE) -> float:
    """Worst-case full-grid loss when price breaches the far edge by x.

    Long: price starts at upper, falls through every line to lower*(1-x).
    Short: price starts at lower, rises through every line to upper*(1+x).
    No funding; entry maker fee + forced taker exit with slippage.
    """
    if direction == "long":
        p_t = lines[0] * (1.0 - x)
        cost = qty * float(np.sum(lines[:-1]))
        q_out = qty * (len(lines) - 1)
        proceeds = q_out * p_t * (1.0 - slip)
        return proceeds - cost - cost * fee - proceeds * taker
    else:
        p_t = lines[-1] * (1.0 + x)
        proceeds_in = qty * float(np.sum(lines[1:]))
        q_in = qty * (len(lines) - 1)
        buyback = q_in * p_t * (1.0 + slip)
        return proceeds_in - buyback - proceeds_in * fee - buyback * taker


def simulate_campaign(sd: SymData, bars: dict, lines: np.ndarray, qty: float,
                      direction: str, market: str, fee: float, taker: float,
                      hits: Hits, start_ms: int, end_ms: int,
                      stop_pct: float | None = None,
                      compute_daily: bool = True) -> dict:
    """Run one grid campaign. Returns a dict of metrics.

    stop_pct: if >0, exchange-side stop at lower*(1-stop_pct) for long /
    upper*(1+stop_pct) for short.  First bar whose low/high crosses the stop
    closes every open level at the worse of open and stop, plus slippage and
    taker fee; the campaign then stays flat.
    """
    o, h, l, c, t = bars["o"], bars["h"], bars["l"], bars["c"], bars["t"]
    n = len(c)
    long_ = direction == "long"
    sign = 1.0 if long_ else -1.0
    L = len(lines)

    dq = np.zeros(n, dtype=float)
    dcash = np.zeros(n, dtype=float)

    cycles: list[tuple[int, int, float, float]] = []   # entry_bar, exit_bar, entry_px, exit_px
    open_positions: list[tuple[int, float]] = []       # entry_bar, entry_px

    # exchange-side stop
    stop_px = None
    stop_bar = None
    if stop_pct and stop_pct > 0:
        if long_:
            stop_px = float(lines[0]) * (1.0 - stop_pct)
            hit = np.flatnonzero(l <= stop_px)
        else:
            stop_px = float(lines[-1]) * (1.0 + stop_pct)
            hit = np.flatnonzero(h >= stop_px)
        if len(hit):
            stop_bar = int(hit[0])
    end_bar = stop_bar if stop_bar is not None else n - 1

    start_price = float(o[0])
    if long_:
        # level i: buy p_i, sell p_{i+1}; last line never buys
        for i in range(L - 1):
            p, sp = lines[i], lines[i + 1]
            if start_price > p:
                start_from = 0          # order is resting at t0
            else:
                fa = hits.first_above[i]
                if fa < 0:              # never traded above the line
                    continue
                start_from = fa + 1     # activation happens at that bar's close
            buys, sells = hits.low[i], hits.high[i + 1]
            buy_limit = bisect.bisect_right(buys, end_bar)
            sell_limit = bisect.bisect_right(sells, end_bar)
            pos = bisect.bisect_left(buys, start_from)
            while pos < buy_limit:
                b = buys[pos]
                pb = o[b] if o[b] <= p else p
                spos = bisect.bisect_right(sells, b)
                if spos >= sell_limit:
                    open_positions.append((b, pb))
                    break
                s = sells[spos]
                ps = o[s] if o[s] >= sp else sp
                cycles.append((b, s, pb, ps))
                pos = bisect.bisect_right(buys, s)
    else:
        # level i: sell p_i, buy p_{i-1}; first line never sells
        start_price = o[0]
        for i in range(1, L):
            p, bp = lines[i], lines[i - 1]
            if start_price < p:
                start_from = 0
            else:
                fb = hits.first_below[i]
                if fb < 0:
                    continue
                start_from = fb + 1
            sells, buys = hits.high[i], hits.low[i - 1]
            sell_limit = bisect.bisect_right(sells, end_bar)
            buy_limit = bisect.bisect_right(buys, end_bar)
            pos = bisect.bisect_left(sells, start_from)
            while pos < sell_limit:
                s = sells[pos]
                ps = o[s] if o[s] >= p else p
                bpos = bisect.bisect_right(buys, s)
                if bpos >= buy_limit:
                    open_positions.append((s, ps))
                    break
                b = buys[bpos]
                pb = o[b] if o[b] <= bp else bp
                cycles.append((s, b, ps, pb))
                pos = bisect.bisect_right(sells, b)

    # ---- trade cash flows -------------------------------------------------
    cycle_gross = 0.0
    cycle_fees = 0.0
    fill_events: list[tuple[int, float, float]] = []   # bar, signed qty delta, fill price
    for eb, xb, ep, xp in cycles:
        dq[eb] += sign * qty
        dcash[eb] -= sign * qty * ep + qty * ep * fee
        dq[xb] -= sign * qty
        dcash[xb] += sign * qty * xp - qty * xp * fee
        cycle_gross += qty * sign * (xp - ep)
        cycle_fees += qty * (ep + xp) * fee
        fill_events.append((eb, sign * qty, ep))
        fill_events.append((xb, -sign * qty, xp))

    open_gross = 0.0
    open_entry_fee = 0.0
    liquidation_cost = 0.0
    liq_px_out = float("nan")
    if open_positions:
        close_bar = n - 1
        if stop_bar is not None:
            # market stop: worse of the bar open and the stop trigger, then slippage
            close_bar = stop_bar
            if long_:
                mark = min(float(o[close_bar]), float(stop_px))
                liq_px = mark * (1.0 - SLIPPAGE)
            else:
                mark = max(float(o[close_bar]), float(stop_px))
                liq_px = mark * (1.0 + SLIPPAGE)
        else:
            mark = float(c[close_bar])
            liq_px = mark * (1.0 - SLIPPAGE) if long_ else mark * (1.0 + SLIPPAGE)
        liq_px_out = float(liq_px)
        for eb, ep in open_positions:
            dq[eb] += sign * qty
            dcash[eb] -= sign * qty * ep + qty * ep * fee
            open_gross += qty * sign * (mark - ep)
            open_entry_fee += qty * ep * fee
            fill_events.append((eb, sign * qty, ep))
            fill_events.append((close_bar, -sign * qty, liq_px))
        q_open = qty * len(open_positions)
        if long_:
            dq[close_bar] -= q_open
            dcash[close_bar] += q_open * liq_px - q_open * liq_px * taker
        else:
            dq[close_bar] += q_open
            dcash[close_bar] -= q_open * liq_px + q_open * liq_px * taker
        liquidation_cost = q_open * mark * SLIPPAGE + q_open * liq_px * taker

    # ---- funding ----------------------------------------------------------
    funding_closed = 0.0
    funding_open = 0.0
    funding_pnl = 0.0
    if market == "futures" and len(sd.funding_t):
        fsel = (sd.funding_t >= start_ms) & (sd.funding_t < end_ms)
        fts = sd.funding_t[fsel]
        frs = sd.funding_r[fsel]
        if len(fts):
            fidx = np.searchsorted(t, fts, side="right") - 1
            good = (fidx >= 0) & (fidx < n)
            fts, frs, fidx = fts[good], frs[good], fidx[good]
            funding_end = float(t[stop_bar]) if stop_bar is not None else float(end_ms)
            for ft, fr, fi in zip(fts, frs, fidx):
                mark = c[fi]
                # closed cycles
                for eb, xb, ep, xp in cycles:
                    if t[eb] < ft <= t[xb]:
                        pnl = -sign * qty * fr * mark
                        dcash[fi] += pnl
                        funding_closed += pnl
                        funding_pnl += pnl
                # open positions (stopped earlier if a stop triggered)
                for eb, ep in open_positions:
                    if t[eb] < ft < funding_end:
                        pnl = -sign * qty * fr * mark
                        dcash[fi] += pnl
                        funding_open += pnl
                        funding_pnl += pnl

    # ---- equity path ------------------------------------------------------
    pos = np.cumsum(dq)
    cash = np.cumsum(dcash)
    equity = cash + pos * c
    total_pnl = float(equity[-1])
    realized_pnl = cycle_gross - cycle_fees + funding_closed
    unrealized_pnl = open_gross - open_entry_fee - liquidation_cost + funding_open
    check = realized_pnl + unrealized_pnl

    runmax = np.maximum.accumulate(np.concatenate(([0.0], equity)))
    dd = runmax[1:] - equity
    max_dd = float(np.max(dd)) if n else 0.0
    max_floating_loss = float(max(0.0, -np.min(equity))) if n else 0.0
    idle_share = float(np.mean(np.abs(pos) < qty * 1e-9)) if n else 1.0
    max_concurrent = int(round(float(np.max(np.abs(pos))) / qty)) if n and qty > 0 else 0
    avg_inv_notional = float(np.mean(np.abs(pos) * c)) if n else 0.0
    peak_inv_notional = float(np.max(np.abs(pos) * c)) if n else 0.0

    out = {
        "total_pnl": total_pnl,
        "realized_pnl": realized_pnl,
        "unrealized_pnl": unrealized_pnl,
        "funding_pnl": funding_pnl,
        "cycle_gross": cycle_gross,
        "cycle_fees": cycle_fees,
        "open_gross": open_gross,
        "open_entry_fee": open_entry_fee,
        "liquidation_cost": liquidation_cost,
        "cycles": len(cycles),
        "fills": 2 * len(cycles) + 2 * len(open_positions),
        "open_positions": len(open_positions),
        "max_concurrent": max_concurrent,
        "max_dd_usdt": max_dd,
        "max_floating_loss": max_floating_loss,
        "idle_share": idle_share,
        "avg_inventory_notional": avg_inv_notional,
        "peak_inventory_notional": peak_inv_notional,
        "price_ret": float(c[-1] / o[0] - 1.0),
        "check_diff": float(abs(total_pnl - check)),
        "stopped": int(stop_bar is not None),
        "stop_px": float(stop_px) if stop_px is not None else float("nan"),
        "stop_bar": int(stop_bar) if stop_bar is not None else -1,
        "_equity": equity,
        "_pos": pos,
        "_dq": dq,
        "_fill_events": sorted(fill_events, key=lambda x: x[0]),
        "_liq_px": liq_px_out,
    }

    # ---- daily PnL + causal regime labels --------------------------------
    if compute_daily:
        day_start = ((start_ms + DAY_MS - 1) // DAY_MS) * DAY_MS
        bounds = []
        if day_start > start_ms:
            bounds.append(day_start)
        elif day_start == start_ms:
            pass
        b = day_start if day_start > start_ms else start_ms + DAY_MS
        while b < end_ms:
            bounds.append(b)
            b += DAY_MS

        def eq_at(ts: int) -> float:
            if ts <= start_ms:
                return 0.0
            j = int(np.searchsorted(t, ts, side="left")) - 1
            if j < 0:
                return 0.0
            if j >= n:
                j = n - 1
            return float(equity[j])

        def px_at(ts: int) -> float:
            if ts <= start_ms:
                return float(o[0])
            j = int(np.searchsorted(t, ts, side="left")) - 1
            if j < 0:
                return float(o[0])
            if j >= n:
                j = n - 1
            return float(c[j])

        edges = [start_ms] + bounds + [end_ms]
        daily = []
        for a, bb in zip(edges[:-1], edges[1:]):
            if bb <= a:
                continue
            pnl = eq_at(bb) - eq_at(a)
            pa, pb = px_at(a), px_at(bb)
            day_ret = (pb / pa - 1.0) if pa > 0 else 0.0
            date = time.strftime("%Y-%m-%d", time.gmtime(a / 1000))
            daily.append((date, pnl, day_ret))
        out["_daily"] = daily
        out["_daily_sum"] = float(sum(x[1] for x in daily))

    return out


# ---------------------------------------------------------------------------
# regime labels (daily ADX14, causal)
# ---------------------------------------------------------------------------

def wilder_ewm(x: np.ndarray, period: int) -> np.ndarray:
    return pd.Series(x, dtype=float).ewm(alpha=1.0 / period, adjust=False).mean().values


def daily_adx(daily: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    d = daily.sort_values("open_time").reset_index(drop=True)
    h = d["high"].values.astype(float)
    l = d["low"].values.astype(float)
    c = d["close"].values.astype(float)
    prev_c = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev_c), np.abs(l - prev_c)))
    up = np.concatenate([[0.0], np.diff(h)])
    dn = np.concatenate([[0.0], -np.diff(l)])
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    atr = wilder_ewm(tr, period)
    pdi = 100.0 * wilder_ewm(plus_dm, period) / np.where(atr > 0, atr, np.nan)
    mdi = 100.0 * wilder_ewm(minus_dm, period) / np.where(atr > 0, atr, np.nan)
    dx = 100.0 * np.abs(pdi - mdi) / np.where((pdi + mdi) > 0, pdi + mdi, np.nan)
    adx = wilder_ewm(dx, period)
    return pd.DataFrame({"open_time": d["open_time"].values.astype(np.int64),
                         "adx": adx})


def build_regime_map(sd: SymData) -> dict[str, str]:
    """date string -> trend/range/unknown, decided at 00:00 UTC of that date.

    Uses ADX14 on 1h bars (resampled from 5m), fully closed before the date.
    Threshold 30: this dataset's daily ADX is structurally high (median ~35),
    so a daily ADX>=25 label would call ~75% of days "trend" and leave too few
    range days to compare against. 1h ADX>=30 gives a ~30/70 trend/range split.
    Labels are causal: only bars whose close is <= 00:00 of the labelled day.
    """
    if sd.h1 is not None and len(sd.h1) > 20:
        df = sd.h1[["open_time", "open", "high", "low", "close"]].copy()
    else:
        b = resample_bars(sd.o, sd.h, sd.l, sd.c, sd.t, HOUR_MS)
        df = pd.DataFrame({"open_time": b["t"], "open": b["o"], "high": b["h"],
                           "low": b["l"], "close": b["c"]})
    a = daily_adx(df)
    times = a["open_time"].values.astype(np.int64)
    adx = a["adx"].values
    known_time = times + HOUR_MS
    out = {}
    first = int(times[0]) if len(times) else 0
    last = int(times[-1]) + HOUR_MS if len(times) else 0
    d = (first // DAY_MS) * DAY_MS
    while d <= last:
        j = int(np.searchsorted(known_time, d, side="right")) - 1
        if j < 0 or not np.isfinite(adx[j]):
            out[time.strftime("%Y-%m-%d", time.gmtime(d / 1000))] = "unknown"
        else:
            out[time.strftime("%Y-%m-%d", time.gmtime(d / 1000))] = (
                "trend" if adx[j] >= 30.0 else "range")
        d += DAY_MS
    return out


# ---------------------------------------------------------------------------
# resampling for execution-timeframe robustness
# ---------------------------------------------------------------------------

def resample_bars(o, h, l, c, t, tf_ms: int) -> dict:
    if tf_ms == 300_000:
        return {"o": o, "h": h, "l": l, "c": c, "t": t}
    # Exchange-aligned buckets (15m/1h start on :00/:15/:30/:45).
    # Edge buckets may be partial; only the first/last bar of a campaign is affected.
    bucket = (t // tf_ms) * tf_ms
    change = np.flatnonzero(np.diff(bucket)) + 1
    starts = np.concatenate(([0], change))
    ends = np.concatenate((change, [len(t)]))
    bo = o[starts]
    bh = np.maximum.reduceat(h, starts)
    bl = np.minimum.reduceat(l, starts)
    bc = c[ends - 1]
    bt = bucket[starts]
    return {"o": bo, "h": bh, "l": bl, "c": bc, "t": bt}


# ---------------------------------------------------------------------------
# one config across campaigns
# ---------------------------------------------------------------------------

SCOPE_DEFS = {
    "research": list(range(0, RESEARCH_CAMPAIGNS)),
    "holdout": list(range(RESEARCH_CAMPAIGNS, N_CAMPAIGNS)),
    "fold1": [0, 1, 2],
    "fold2": [3, 4, 5],
    "fold3": [6, 7, 8, 9],
    "all": list(range(N_CAMPAIGNS)),
}


def campaign_bars(sd: SymData, start_ms: int, end_ms: int, tf_ms: int) -> dict | None:
    i0 = int(np.searchsorted(sd.t, start_ms, side="left"))
    i1 = int(np.searchsorted(sd.t, end_ms, side="left"))
    if i1 - i0 < 10:
        return None
    bars = {
        "o": sd.o[i0:i1], "h": sd.h[i0:i1],
        "l": sd.l[i0:i1], "c": sd.c[i0:i1],
        "t": sd.t[i0:i1],
    }
    return resample_bars(bars["o"], bars["h"], bars["l"], bars["c"], bars["t"], tf_ms)


def detrend_bars(bars: dict) -> dict:
    c = bars["c"]
    n = len(c)
    if n < 2 or c[-1] <= 0 or bars["o"][0] <= 0:
        return bars
    mu = (math.log(c[-1]) - math.log(bars["o"][0])) / (n - 1)
    scale = np.exp(-mu * np.arange(n, dtype=float))
    return {k: (v * scale if k in ("o", "h", "l", "c") else v)
            for k, v in bars.items()}


def run_config(sd: SymData, direction: str, market: str, levels: int, rule: str,
               tf_ms: int, global_start: int, regime_map: dict[str, str],
               stop_pct: float = 0.0, do_detrend: bool = True,
               verbose: bool = False) -> tuple[list[dict], list[dict]]:
    leverage = FUT_LEVERAGE if market == "futures" else 1.0
    fee = MAKER_FUT if market == "futures" else MAKER_SPOT
    taker = TAKER_FUT if market == "futures" else TAKER_SPOT
    margin_cap = NOTIONAL_BUDGET / leverage

    campaign_rows = []
    cfg_cache = {}

    for k in range(N_CAMPAIGNS):
        start_ms = global_start + (WARMUP_DAYS + CAMPAIGN_DAYS * k) * DAY_MS
        end_ms = start_ms + CAMPAIGN_DAYS * DAY_MS
        key = (k, levels, rule)
        if key in cfg_cache:
            built = cfg_cache[key]
        else:
            rng = range_for_rule(sd, start_ms, rule)
            if rng is None:
                built = {"ok": False, "reason": "insufficient_history",
                         "lines": None, "qty": 0.0, "spacing_pct": float("nan"),
                         "range_width_pct": float("nan"), "lower": float("nan"),
                         "upper": float("nan")}
            else:
                lower, upper = rng
                g = build_grid(sd, lower, upper, levels, fee)
                g["lower"], g["upper"] = lower, upper
                built = g
            cfg_cache[key] = built

        base = {
            "symbol": sd.symbol, "direction": direction, "market": market,
            "leverage": leverage, "exec_tf": {300_000: "5m", 900_000: "15m",
                                              3_600_000: "1h"}.get(tf_ms, str(tf_ms)),
            "levels": levels, "rule": rule, "scope": "campaign", "campaign_id": k,
            "start_time": time.strftime("%Y-%m-%d %H:%M", time.gmtime(start_ms / 1000)),
            "calendar_days": CAMPAIGN_DAYS, "notional_budget": NOTIONAL_BUDGET,
            "margin_capacity": margin_cap, "fee": fee, "stop_pct": stop_pct,
            "stopped": 0, "stop_px": float("nan"),
        }

        if not built["ok"]:
            row = dict(base)
            row.update({
                "runnable": 0, "skip_reason": built["reason"],
                "range_lower": built.get("lower", float("nan")),
                "range_upper": built.get("upper", float("nan")),
                "range_width_pct": built.get("range_width_pct", float("nan")),
                "spacing_pct": built.get("spacing_pct", float("nan")),
                "qty": 0.0,
                "total_pnl": 0.0, "realized_pnl": 0.0, "unrealized_pnl": 0.0,
                "funding_pnl": 0.0, "cycle_gross": 0.0, "cycle_fees": 0.0,
                "open_gross": 0.0, "open_entry_fee": 0.0, "liquidation_cost": 0.0,
                "cycles": 0, "fills": 0, "open_positions": 0,
                "cycles_per_day": 0.0, "max_concurrent": 0,
                "max_dd_usdt": 0.0, "max_dd_pct_margin": 0.0,
                "max_floating_loss": 0.0, "idle_share": 1.0,
                "avg_inventory_notional": 0.0, "peak_inventory_notional": 0.0,
                "price_ret": float("nan"), "detrended_pnl": 0.0,
                "drift_contrib": 0.0,
                "trend_pnl": 0.0, "range_pnl": 0.0, "unknown_pnl": 0.0,
                "trend_days": 0, "range_days": 0,
                "trend_up_pnl": 0.0, "trend_down_pnl": 0.0,
                "range_up_pnl": 0.0, "range_down_pnl": 0.0,
                "trend_up_days": 0, "trend_down_days": 0,
                "range_up_days": 0, "range_down_days": 0,
                "tail_loss_10": float("nan"), "tail_loss_20": float("nan"),
                "tail_loss_30": float("nan"), "stop_loss_2pct": float("nan"),
            })
            campaign_rows.append(row)
            continue

        bars = campaign_bars(sd, start_ms, end_ms, tf_ms)
        if bars is None:
            row = dict(base)
            row.update({"runnable": 0, "skip_reason": "no_bars",
                        "range_lower": built["lower"], "range_upper": built["upper"],
                        "range_width_pct": built["range_width_pct"],
                        "spacing_pct": built["spacing_pct"], "qty": built["qty"]})
            for kk in ("total_pnl", "realized_pnl", "unrealized_pnl", "funding_pnl",
                       "cycle_gross", "cycle_fees", "open_gross", "open_entry_fee",
                       "liquidation_cost", "cycles", "fills", "open_positions",
                       "cycles_per_day", "max_concurrent", "max_dd_usdt",
                       "max_dd_pct_margin", "max_floating_loss", "avg_inventory_notional",
                       "peak_inventory_notional", "detrended_pnl", "drift_contrib",
                       "trend_pnl", "range_pnl", "unknown_pnl", "trend_days",
                       "range_days", "trend_up_pnl", "trend_down_pnl",
                       "range_up_pnl", "range_down_pnl", "trend_up_days",
                       "trend_down_days", "range_up_days", "range_down_days",
                       "tail_loss_10", "tail_loss_20", "tail_loss_30",
                       "stop_loss_2pct"):
                row[kk] = 0.0
            row["idle_share"] = 1.0
            row["price_ret"] = float("nan")
            campaign_rows.append(row)
            continue

        start_price = float(bars["o"][0])
        lower, upper = built["lower"], built["upper"]
        if start_price < lower or start_price > upper:
            row = dict(base)
            row.update({
                "runnable": 0, "skip_reason": "price_out_of_range",
                "range_lower": lower, "range_upper": upper,
                "range_width_pct": built["range_width_pct"],
                "spacing_pct": built["spacing_pct"], "qty": built["qty"],
                "total_pnl": 0.0, "realized_pnl": 0.0, "unrealized_pnl": 0.0,
                "funding_pnl": 0.0, "cycle_gross": 0.0, "cycle_fees": 0.0,
                "open_gross": 0.0, "open_entry_fee": 0.0, "liquidation_cost": 0.0,
                "cycles": 0, "fills": 0, "open_positions": 0,
                "cycles_per_day": 0.0, "max_concurrent": 0,
                "max_dd_usdt": 0.0, "max_dd_pct_margin": 0.0,
                "max_floating_loss": 0.0, "idle_share": 1.0,
                "avg_inventory_notional": 0.0, "peak_inventory_notional": 0.0,
                "price_ret": float(bars["c"][-1] / start_price - 1.0),
                "detrended_pnl": 0.0, "drift_contrib": 0.0,
                "trend_pnl": 0.0, "range_pnl": 0.0, "unknown_pnl": 0.0,
                "trend_days": 0, "range_days": 0,
                "trend_up_pnl": 0.0, "trend_down_pnl": 0.0,
                "range_up_pnl": 0.0, "range_down_pnl": 0.0,
                "trend_up_days": 0, "trend_down_days": 0,
                "range_up_days": 0, "range_down_days": 0,
                "tail_loss_10": float("nan"), "tail_loss_20": float("nan"),
                "tail_loss_30": float("nan"), "stop_loss_2pct": float("nan"),
            })
            campaign_rows.append(row)
            continue

        hits = precompute_hits(bars["o"], bars["h"], bars["l"], bars["c"],
                               built["lines"], start_price)
        sim = simulate_campaign(sd, bars, built["lines"], built["qty"],
                                direction, market, fee, taker, hits,
                                start_ms, end_ms, stop_pct=stop_pct,
                                compute_daily=True)

        # detrended counterfactual
        if do_detrend:
            dbars = detrend_bars(bars)
            dhits = precompute_hits(dbars["o"], dbars["h"], dbars["l"], dbars["c"],
                                    built["lines"], float(dbars["o"][0]))
            dsim = simulate_campaign(sd, dbars, built["lines"], built["qty"],
                                     direction, market, fee, taker, dhits,
                                     start_ms, end_ms, stop_pct=stop_pct,
                                     compute_daily=False)
            detrended_pnl = dsim["total_pnl"]
        else:
            detrended_pnl = float("nan")

        # daily regime attribution
        trend_pnl = range_pnl = unknown_pnl = 0.0
        trend_days = range_days = 0
        trend_up_pnl = trend_down_pnl = range_up_pnl = range_down_pnl = 0.0
        trend_up_days = trend_down_days = range_up_days = range_down_days = 0
        for date, pnl, day_ret in sim.get("_daily", []):
            lab = regime_map.get(date, "unknown")
            if lab == "trend":
                trend_pnl += pnl
                trend_days += 1
                if day_ret >= 0:
                    trend_up_pnl += pnl
                    trend_up_days += 1
                else:
                    trend_down_pnl += pnl
                    trend_down_days += 1
            elif lab == "range":
                range_pnl += pnl
                range_days += 1
                if day_ret >= 0:
                    range_up_pnl += pnl
                    range_up_days += 1
                else:
                    range_down_pnl += pnl
                    range_down_days += 1
            else:
                unknown_pnl += pnl

        tail = {f"tail_loss_{int(x*100)}": _stress_loss(
            built["lines"], built["qty"], direction, x, fee, taker)
            for x in TAIL_XS}
        stop_loss = _stress_loss(built["lines"], built["qty"], direction,
                                 STOP_BEYOND, fee, taker)

        row = dict(base)
        row.update({
            "runnable": 1, "skip_reason": "",
            "range_lower": lower, "range_upper": upper,
            "range_width_pct": built["range_width_pct"],
            "spacing_pct": built["spacing_pct"], "qty": built["qty"],
            "total_pnl": sim["total_pnl"],
            "check_diff": sim["check_diff"],
            "stopped": sim["stopped"], "stop_px": sim["stop_px"],
            "realized_pnl": sim["realized_pnl"],
            "unrealized_pnl": sim["unrealized_pnl"],
            "funding_pnl": sim["funding_pnl"],
            "cycle_gross": sim["cycle_gross"],
            "cycle_fees": sim["cycle_fees"],
            "open_gross": sim["open_gross"],
            "open_entry_fee": sim["open_entry_fee"],
            "liquidation_cost": sim["liquidation_cost"],
            "cycles": sim["cycles"],
            "fills": sim["fills"],
            "open_positions": sim["open_positions"],
            "cycles_per_day": sim["cycles"] / CAMPAIGN_DAYS,
            "max_concurrent": sim["max_concurrent"],
            "max_dd_usdt": sim["max_dd_usdt"],
            "max_dd_pct_margin": sim["max_dd_usdt"] / margin_cap,
            "max_floating_loss": sim["max_floating_loss"],
            "idle_share": sim["idle_share"],
            "avg_inventory_notional": sim["avg_inventory_notional"],
            "peak_inventory_notional": sim["peak_inventory_notional"],
            "price_ret": sim["price_ret"],
            "detrended_pnl": detrended_pnl,
            "drift_contrib": sim["total_pnl"] - detrended_pnl
            if do_detrend else float("nan"),
            "trend_pnl": trend_pnl, "range_pnl": range_pnl,
            "unknown_pnl": unknown_pnl,
            "trend_days": trend_days, "range_days": range_days,
            "trend_up_pnl": trend_up_pnl, "trend_down_pnl": trend_down_pnl,
            "range_up_pnl": range_up_pnl, "range_down_pnl": range_down_pnl,
            "trend_up_days": trend_up_days, "trend_down_days": trend_down_days,
            "range_up_days": range_up_days, "range_down_days": range_down_days,
            "tail_loss_10": tail["tail_loss_10"],
            "tail_loss_20": tail["tail_loss_20"],
            "tail_loss_30": tail["tail_loss_30"],
            "stop_loss_2pct": stop_loss,
        })
        campaign_rows.append(row)

    return campaign_rows, aggregate_rows(campaign_rows, sd.symbol, direction,
                                          market, leverage, levels, rule, tf_ms,
                                          margin_cap)


def aggregate_rows(campaign_rows: list[dict], symbol: str, direction: str,
                   market: str, leverage: float, levels: int, rule: str,
                   tf_ms: int, margin_cap: float) -> list[dict]:
    out = []
    for scope, ks in SCOPE_DEFS.items():
        rows = [campaign_rows[k] for k in ks]
        n = len(rows)
        run = [r for r in rows if r.get("runnable", 0) == 1]
        nr = len(run)
        base = {
            "symbol": symbol, "direction": direction, "market": market,
            "leverage": leverage,
            "exec_tf": {300_000: "5m", 900_000: "15m",
                        3_600_000: "1h"}.get(tf_ms, str(tf_ms)),
            "levels": levels, "rule": rule, "scope": scope, "campaign_id": "",
            "start_time": "", "calendar_days": CAMPAIGN_DAYS * n,
            "notional_budget": NOTIONAL_BUDGET, "margin_capacity": margin_cap,
            "fee": rows[0]["fee"] if rows else float("nan"),
            "stop_pct": rows[0].get("stop_pct", 0.0) if rows else float("nan"),
            "stopped": float("nan"),
            "stopped_share": float(np.mean([r.get("stopped", 0) for r in rows])) if rows else float("nan"),
            "stop_px": float("nan"),
            "runnable": float("nan"), "skip_reason": "",
            "range_width_pct": float(np.mean([r["range_width_pct"] for r in run])) if run else float("nan"),
            "spacing_pct": float(np.mean([r["spacing_pct"] for r in run])) if run else float("nan"),
            "qty": float(np.mean([r["qty"] for r in run])) if run else float("nan"),
        }

        def s(key):
            return float(sum(r.get(key, 0.0) or 0.0 for r in rows))

        total = s("total_pnl")
        realized = s("realized_pnl")
        unrealized = s("unrealized_pnl")
        funding = s("funding_pnl")
        cycles = float(sum(r["cycles"] for r in rows))
        fills = float(sum(r["fills"] for r in rows))
        trading_days = CAMPAIGN_DAYS * nr
        pnls = [r["total_pnl"] for r in run]
        mean_run = float(np.mean(pnls)) if nr else float("nan")
        std_run = float(np.std(pnls, ddof=1)) if nr >= 2 else float("nan")
        if nr >= 2 and std_run > 1e-12:
            tstat = mean_run / (std_run / math.sqrt(nr))
            pval = float(2 * stats.t.sf(abs(tstat), df=nr - 1))
        else:
            tstat = float("nan")
            pval = float("nan")
        tail10 = [r["tail_loss_10"] for r in run if np.isfinite(r["tail_loss_10"])]
        tail20 = [r["tail_loss_20"] for r in run if np.isfinite(r["tail_loss_20"])]
        tail30 = [r["tail_loss_30"] for r in run if np.isfinite(r["tail_loss_30"])]
        stops = [r["stop_loss_2pct"] for r in run if np.isfinite(r["stop_loss_2pct"])]

        # compounded price return over the scope's campaigns
        price_ret = 1.0
        for r in rows:
            if np.isfinite(r.get("price_ret", float("nan"))):
                price_ret *= (1.0 + r["price_ret"])
        price_ret -= 1.0

        row = dict(base)
        row.update({
            "run_rate": nr / n if n else 0.0,
            "n_campaigns": n, "n_runnable": nr,
            "trading_days": trading_days,
            "total_pnl": total,
            "mean_pnl_all": total / n if n else float("nan"),
            "mean_pnl_run": mean_run,
            "std_pnl_run": std_run,
            "t_stat": tstat, "p_value": pval,
            "positive_share_run": (sum(1 for x in pnls if x > 0) / nr) if nr else float("nan"),
            "realized_pnl": realized,
            "unrealized_pnl": unrealized,
            "funding_pnl": funding,
            "cycle_gross": s("cycle_gross"),
            "cycle_fees": s("cycle_fees"),
            "open_gross": s("open_gross"),
            "open_entry_fee": s("open_entry_fee"),
            "liquidation_cost": s("liquidation_cost"),
            "cycles": cycles, "fills": fills,
            "open_positions": s("open_positions"),
            "cycles_per_day": cycles / trading_days if trading_days else float("nan"),
            "max_concurrent": max((r["max_concurrent"] for r in rows), default=0),
            "max_dd_usdt": max((r["max_dd_usdt"] for r in rows), default=0.0),
            "max_dd_pct_margin": (max((r["max_dd_usdt"] for r in rows), default=0.0)
                                  / margin_cap),
            "max_floating_loss": max((r["max_floating_loss"] for r in rows), default=0.0),
            "idle_share": float(np.mean([r["idle_share"] for r in rows])) if n else float("nan"),
            "avg_inventory_notional": float(np.mean([r["avg_inventory_notional"] for r in run])) if run else float("nan"),
            "peak_inventory_notional": max((r["peak_inventory_notional"] for r in run), default=0.0),
            "price_ret": price_ret,
            "ret_margin": total / margin_cap,
            "ret_notional": total / NOTIONAL_BUDGET,
            "ret_margin_pa": (total / margin_cap) * 365.0 / (CAMPAIGN_DAYS * n) if n else float("nan"),
            "realized_ret_margin": realized / margin_cap,
            "realized_ret_notional": realized / NOTIONAL_BUDGET,
            "detrended_pnl": s("detrended_pnl"),
            "drift_contrib": s("drift_contrib"),
            "detrended_ret_margin": s("detrended_pnl") / margin_cap,
            "trend_pnl": s("trend_pnl"), "range_pnl": s("range_pnl"),
            "unknown_pnl": s("unknown_pnl"),
            "trend_days": int(sum(r["trend_days"] for r in rows)),
            "range_days": int(sum(r["range_days"] for r in rows)),
            "trend_up_pnl": s("trend_up_pnl"), "trend_down_pnl": s("trend_down_pnl"),
            "range_up_pnl": s("range_up_pnl"), "range_down_pnl": s("range_down_pnl"),
            "trend_up_days": int(sum(r["trend_up_days"] for r in rows)),
            "trend_down_days": int(sum(r["trend_down_days"] for r in rows)),
            "range_up_days": int(sum(r["range_up_days"] for r in rows)),
            "range_down_days": int(sum(r["range_down_days"] for r in rows)),
            "pnl_per_day_trend": (s("trend_pnl") / sum(r["trend_days"] for r in rows))
            if sum(r["trend_days"] for r in rows) else float("nan"),
            "pnl_per_day_range": (s("range_pnl") / sum(r["range_days"] for r in rows))
            if sum(r["range_days"] for r in rows) else float("nan"),
            "pnl_per_day_trend_up": (s("trend_up_pnl") / sum(r["trend_up_days"] for r in rows))
            if sum(r["trend_up_days"] for r in rows) else float("nan"),
            "pnl_per_day_trend_down": (s("trend_down_pnl") / sum(r["trend_down_days"] for r in rows))
            if sum(r["trend_down_days"] for r in rows) else float("nan"),
            "pnl_per_day_range_up": (s("range_up_pnl") / sum(r["range_up_days"] for r in rows))
            if sum(r["range_up_days"] for r in rows) else float("nan"),
            "pnl_per_day_range_down": (s("range_down_pnl") / sum(r["range_down_days"] for r in rows))
            if sum(r["range_down_days"] for r in rows) else float("nan"),
            "tail_loss_10": min(tail10) if tail10 else float("nan"),
            "tail_loss_20": min(tail20) if tail20 else float("nan"),
            "tail_loss_30": min(tail30) if tail30 else float("nan"),
            "stop_loss_2pct": min(stops) if stops else float("nan"),
            "bh_long_pnl": NOTIONAL_BUDGET * price_ret,
            "bh_short_pnl": -NOTIONAL_BUDGET * price_ret,
        })
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default=",".join(SYMBOLS))
    ap.add_argument("--levels", default=",".join(map(str, LEVELS)))
    ap.add_argument("--rules", default=",".join(RULES))
    ap.add_argument("--directions", default=",".join(DIRECTIONS))
    ap.add_argument("--markets", default="futures,spot",
                    help="futures,spot; spot only supports long")
    ap.add_argument("--exec-tfs", default="5m,15m,1h")
    ap.add_argument("--stops", default="0,0.02",
                    help="comma list of stop distances beyond the range edge; 0 = no stop")
    ap.add_argument("--no-detrend", action="store_true")
    ap.add_argument("--out", default=os.path.join(OUTDIR, "results.csv"))
    ap.add_argument("--max-symbols", type=int, default=0)
    args = ap.parse_args()

    symbols = [x.strip().upper() for x in args.symbols.split(",") if x.strip()]
    levels = [int(x) for x in args.levels.split(",") if x.strip()]
    rules = [x.strip() for x in args.rules.split(",") if x.strip()]
    directions = [x.strip() for x in args.directions.split(",") if x.strip()]
    markets = [x.strip() for x in args.markets.split(",") if x.strip()]
    tf_map = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000}
    tfs = [tf_map[x.strip()] for x in args.exec_tfs.split(",") if x.strip()]
    stops = [float(x) for x in args.stops.split(",") if x.strip()]
    if args.max_symbols:
        symbols = symbols[:args.max_symbols]

    rules_ex = load_exchange_rules()
    data = {}
    for sym in symbols:
        t0 = time.time()
        data[sym] = load_symbol(sym, rules_ex)
        adj = data[sym].adjustment
        adj_msg = ""
        if adj:
            adj_msg = (f" [contract change x{adj['factor']:.4f}, dropped "
                       f"{adj['dropped_bars']} halt bars]")
        print(f"loaded {sym}: 5m={len(data[sym].t)} daily={len(data[sym].daily)} "
              f"funding={len(data[sym].funding_t)} ({time.time()-t0:.1f}s){adj_msg}",
              file=sys.stderr)

    global_start = min(int(d.t[0]) for d in data.values())
    global_end = global_start + (WARMUP_DAYS + N_CAMPAIGNS * CAMPAIGN_DAYS) * DAY_MS
    print(f"global_start={time.strftime('%Y-%m-%d %H:%M', time.gmtime(global_start/1000))} "
          f"global_end={time.strftime('%Y-%m-%d %H:%M', time.gmtime(global_end/1000))}",
          file=sys.stderr)

    regime = {sym: build_regime_map(data[sym]) for sym in symbols}
    for sym in symbols:
        vals = [v for v in regime[sym].values() if v != "unknown"]
        tr = sum(1 for v in vals if v == "trend")
        print(f"regime {sym}: trend_days={tr}/{len(vals)}", file=sys.stderr)

    all_campaign = []
    all_agg = []
    t_start = time.time()
    total_cfgs = 0
    for sym in symbols:
        sd = data[sym]
        for market in markets:
            dirs = directions if market == "futures" else ["long"]
            for direction in dirs:
                for levels_ in levels:
                    for rule in rules:
                        for tf_ms in tfs:
                            # spot only for 5m execution (fees/leverage sensitivity)
                            if market == "spot" and tf_ms != 300_000:
                                continue
                            for stop_pct in stops:
                                total_cfgs += 1
                                cr, ar = run_config(
                                    sd, direction, market, levels_, rule, tf_ms,
                                    global_start, regime[sym],
                                    stop_pct=stop_pct,
                                    do_detrend=not args.no_detrend,
                                )
                                all_campaign.extend(cr)
                                all_agg.extend(ar)
        print(f"done {sym} ({time.time()-t_start:.0f}s)", file=sys.stderr)

    # write
    cols_preferred = [
        "symbol", "direction", "market", "leverage", "exec_tf", "levels", "rule",
        "scope", "campaign_id", "start_time", "calendar_days", "trading_days",
        "runnable", "run_rate", "skip_reason",
        "range_lower", "range_upper", "range_width_pct", "spacing_pct", "qty",
        "notional_budget", "margin_capacity", "fee", "stop_pct",
        "stopped", "stopped_share", "stop_px",
        "total_pnl", "check_diff", "realized_pnl", "unrealized_pnl", "funding_pnl",
        "cycle_gross", "cycle_fees", "open_gross", "open_entry_fee",
        "liquidation_cost",
        "ret_margin", "ret_notional", "ret_margin_pa",
        "realized_ret_margin", "realized_ret_notional",
        "cycles", "fills", "open_positions", "cycles_per_day",
        "max_concurrent", "max_dd_usdt", "max_dd_pct_margin", "max_floating_loss",
        "idle_share", "avg_inventory_notional", "peak_inventory_notional",
        "price_ret", "detrended_pnl", "drift_contrib", "detrended_ret_margin",
        "trend_pnl", "range_pnl", "unknown_pnl", "trend_days", "range_days",
        "trend_up_pnl", "trend_down_pnl", "range_up_pnl", "range_down_pnl",
        "trend_up_days", "trend_down_days", "range_up_days", "range_down_days",
        "pnl_per_day_trend", "pnl_per_day_range",
        "pnl_per_day_trend_up", "pnl_per_day_trend_down",
        "pnl_per_day_range_up", "pnl_per_day_range_down",
        "tail_loss_10", "tail_loss_20", "tail_loss_30", "stop_loss_2pct",
        "bh_long_pnl", "bh_short_pnl",
        "n_campaigns", "n_runnable", "mean_pnl_all", "mean_pnl_run",
        "std_pnl_run", "t_stat", "p_value", "positive_share_run",
    ]
    rows = all_campaign + all_agg
    extra = sorted({k for r in rows for k in r} - set(cols_preferred))
    cols = cols_preferred + extra
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"wrote {len(rows)} rows -> {args.out} "
          f"({total_cfgs} configs, {time.time()-t_start:.0f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
