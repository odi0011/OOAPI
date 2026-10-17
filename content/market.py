"""行情快照、技术指标与配图。

只使用币安公开接口，不需要密钥。若设置了 HTTPS_PROXY / HTTP_PROXY，
所有请求走代理。
"""

from __future__ import annotations

import json
import os
import urllib.request

FAPI = "https://fapi.binance.com"


def _opener() -> urllib.request.OpenerDirector:
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    if proxy:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        )
    return urllib.request.build_opener()


def _get(path: str):
    with _opener().open(FAPI + path, timeout=20) as resp:
        return json.loads(resp.read().decode())


def ema(values: list[float], n: int) -> float:
    k = 2 / (n + 1)
    e = values[0]
    for v in values[1:]:
        e = v * k + e * (1 - k)
    return e


def rsi(values: list[float], n: int = 14) -> float:
    gains = losses = 0.0
    for i in range(len(values) - n, len(values)):
        change = values[i] - values[i - 1]
        gains += max(change, 0)
        losses += max(-change, 0)
    gains /= n
    losses /= n
    if losses == 0:
        return 100.0
    return 100 - 100 / (1 + gains / losses)


def atr(highs: list[float], lows: list[float], closes: list[float], n: int = 14) -> float:
    tr = []
    for i in range(1, len(closes)):
        tr.append(max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        ))
    return sum(tr[-n:]) / n


def snapshot(symbol: str, interval: str = "1h", limit: int = 200) -> dict:
    """返回一个币的行情/指标快照。"""
    klines = _get(f"/fapi/v1/klines?symbol={symbol}&interval={interval}&limit={limit}")
    closes = [float(k[4]) for k in klines]
    highs = [float(k[2]) for k in klines]
    lows = [float(k[3]) for k in klines]
    volumes = [float(k[5]) for k in klines]

    ticker = _get(f"/fapi/v1/ticker/24hr?symbol={symbol}")
    premium = _get(f"/fapi/v1/premiumIndex?symbol={symbol}")

    last = closes[-1]
    change_24h = (last / closes[-24] - 1) * 100 if len(closes) > 24 else 0.0
    e20, e50, e200 = ema(closes, 20), ema(closes, 50), ema(closes, 200)
    a14 = atr(highs, lows, closes, 14)
    return {
        "symbol": symbol,
        "interval": interval,
        "price": last,
        "change_24h_pct": change_24h,
        "high_24h": float(ticker["highPrice"]),
        "low_24h": float(ticker["lowPrice"]),
        "quote_volume_24h": float(ticker["quoteVolume"]),
        "ema20": e20,
        "ema50": e50,
        "ema200": e200,
        "rsi14": rsi(closes, 14),
        "atr14": a14,
        "atr_pct": a14 / last * 100,
        "funding_rate": float(premium.get("lastFundingRate", 0)),
        "mark_price": float(premium.get("markPrice", last)),
        "recent_high": max(highs[-30:]),
        "recent_low": min(lows[-30:]),
        "trend": "down" if last < e20 and e20 < e50 else ("up" if last > e20 and e20 > e50 else "mixed"),
        "volume_ratio": volumes[-1] / (sum(volumes[-21:-1]) / 20) if sum(volumes[-21:-1]) > 0 else 1.0,
    }


def _fmt_price(v: float) -> str:
    if v >= 1000:
        return f"{v:,.0f}"
    if v >= 1:
        return f"{v:,.2f}"
    return f"{v:.6f}".rstrip("0").rstrip(".")


def chart(symbol: str, out_path: str, interval: str = "1h", bars: int = 120) -> str:
    """画一张 K 线 + EMA + 成交量的图，返回文件路径。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle

    klines = _get(f"/fapi/v1/klines?symbol={symbol}&interval={interval}&limit={bars + 200}")
    klines = klines[-bars:]
    closes = [float(k[4]) for k in klines]
    highs = [float(k[2]) for k in klines]
    lows = [float(k[3]) for k in klines]
    opens = [float(k[1]) for k in klines]
    volumes = [float(k[5]) for k in klines]

    # EMA 用更长窗口预热后再截断
    full_closes = [float(k[4]) for k in _get(
        f"/fapi/v1/klines?symbol={symbol}&interval={interval}&limit={bars + 200}")]
    e20_full = [ema(full_closes[:i + 1], 20) for i in range(len(full_closes))]
    e50_full = [ema(full_closes[:i + 1], 50) for i in range(len(full_closes))]
    e20 = e20_full[-bars:]
    e50 = e50_full[-bars:]

    fig, (ax, axv) = plt.subplots(
        2, 1, figsize=(12, 6), sharex=True,
        gridspec_kw={"height_ratios": [4, 1], "hspace": 0.05},
    )
    for i in range(len(klines)):
        color = "#26a69a" if closes[i] >= opens[i] else "#ef5350"
        ax.plot([i, i], [lows[i], highs[i]], color=color, linewidth=0.8)
        body_bottom = min(opens[i], closes[i])
        body_height = abs(closes[i] - opens[i]) or max(highs[i] - lows[i], 1e-9) * 0.02
        ax.add_patch(Rectangle((i - 0.3, body_bottom), 0.6, body_height,
                               facecolor=color, edgecolor=color))
        axv.bar(i, volumes[i], color=color, width=0.6)

    ax.plot(range(len(klines)), e20, color="#f6c343", linewidth=1.2, label="EMA20")
    ax.plot(range(len(klines)), e50, color="#5b8def", linewidth=1.2, label="EMA50")
    ax.set_title(f"{symbol} · {interval} · Binance USDT-M", fontsize=13, loc="left")
    ax.legend(loc="upper left", fontsize=9, frameon=False)
    ax.grid(alpha=0.15)
    ax.tick_params(axis="x", labelbottom=False)
    axv.grid(alpha=0.15)
    axv.set_ylabel("Vol", fontsize=9)
    fig.text(0.99, 0.01, "Data: Binance · auto-generated", ha="right", fontsize=8, color="#888")
    fig.subplots_adjust(left=0.07, right=0.98, top=0.92, bottom=0.07, hspace=0.05)
    fig.savefig(out_path, dpi=140)
    plt.close(fig)
    return out_path


if __name__ == "__main__":
    import sys
    sym = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
    s = snapshot(sym)
    print(json.dumps(s, indent=2, ensure_ascii=False))
    out = sys.argv[2] if len(sys.argv) > 2 else f"{sym}.png"
    print("chart:", chart(sym, out))
