"""文案生成与合规过滤。

原则：
  · 只写事实与自己的交易记录，不写价格预测、目标价、收益承诺。
  · 提到持仓时必须带免责声明。
  · 命中禁用词直接拒绝生成，不发布。
  · 单条长度控制在 1800 字符以内（广场接口对长度有限制）。
"""

from __future__ import annotations

import re


class ComplianceError(Exception):
    pass


def base_asset(symbol: str) -> str:
    return symbol[:-4] if symbol.upper().endswith("USDT") else symbol.upper()


def fmt_price(v: float) -> str:
    if v >= 1000:
        return f"{v:,.0f}"
    if v >= 1:
        return f"{v:,.2f}"
    return f"{v:.6f}".rstrip("0").rstrip(".")


def fmt_pct(v: float, digits: int = 2) -> str:
    return f"{v:+.{digits}f}%"


def fmt_rate(v: float) -> str:
    return f"{v * 100:+.4f}%/8h"


def compliance_hits(text: str, banned: list[str]) -> list[str]:
    return [p for p in banned if p and p in text]


def enforce(text: str, banned: list[str], disclosure: str, max_len: int = 1800) -> str:
    hits = compliance_hits(text, banned)
    if hits:
        raise ComplianceError(f"命中禁用词: {', '.join(hits)}")
    if disclosure and disclosure not in text:
        raise ComplianceError("缺少免责声明")
    if len(text) > max_len:
        raise ComplianceError(f"文案过长: {len(text)} > {max_len}")
    # 粗查明显的“价格目标”句式（我们自己生成时不应出现，兜底）
    if re.search(r"(目标价|看到|涨到|跌到)\s*[$¥]?\s*\d", text):
        raise ComplianceError("疑似价格目标表述")
    return text


def daily_text(markets: list[dict], news: list[dict], positions: list[dict],
               config: dict, date_str: str) -> str:
    banned = config.get("banned_phrases", [])
    disclosure = config.get("disclosure", "")

    lines = [f"【{date_str} 市场简报】", ""]
    if markets:
        quotes = []
        for m in markets:
            quotes.append(f"{base_asset(m['symbol'])} ${fmt_price(m['price'])}（{fmt_pct(m['change_24h_pct'])}）")
        lines.append("｜".join(quotes))
        lines.append("")

        m = markets[0]
        lines.append(
            f"{base_asset(m['symbol'])} {m['interval']}："
            f"EMA20 {fmt_price(m['ema20'])} / EMA50 {fmt_price(m['ema50'])} / "
            f"EMA200 {fmt_price(m['ema200'])}，RSI {m['rsi14']:.1f}，ATR {m['atr_pct']:.2f}%。"
        )
        rates = "，".join(
            f"{base_asset(x['symbol'])} {fmt_rate(x['funding_rate'])}" for x in markets
        )
        lines.append(f"资金费率：{rates}。")
        lines.append("")

    if news:
        top = news[0]
        lines.append(f"今日关注：{top['title']}（{top['source']}）")
        lines.append("")

    if positions:
        lines.append("个人持仓记录：")
        for p in positions:
            side = "多" if p.get("side") == "long" else "空"
            line = (
                f"{p.get('symbol')} {side} {p.get('qty')} @ {fmt_price(float(p.get('entryPrice', 0)))}，"
                f"现价 {fmt_price(float(p.get('markPrice', 0)))}，"
                f"浮盈亏 {float(p.get('unrealizedPnl', 0)):+.2f} USDT"
            )
            if p.get("stopPrice"):
                line += f"，止损 {fmt_price(float(p['stopPrice']))}"
            if p.get("takeProfitPrice"):
                line += f"，止盈 {fmt_price(float(p['takeProfitPrice']))}"
            lines.append(line + "。")
        lines.append("")

    lines.append(disclosure)
    lines.append("")
    tags = " ".join(f"${base_asset(m['symbol'])}" for m in markets)
    if tags:
        lines.append(tags)

    text = "\n".join(lines).strip()
    return enforce(text, banned, disclosure)


def news_text(item: dict, market: dict | None, config: dict) -> str:
    banned = config.get("banned_phrases", [])
    disclosure = config.get("disclosure", "")

    lines = [f"【{item['title']}】", ""]
    lines.append(f"来源：{item['source']}")
    lines.append("")
    if market:
        lines.append(
            f"市场背景：{base_asset(market['symbol'])} ${fmt_price(market['price'])}"
            f"（24h {fmt_pct(market['change_24h_pct'])}），"
            f"1h 价格{'低于' if market['price'] < market['ema20'] else '高于'} EMA20"
            f"（{fmt_price(market['ema20'])}），RSI {market['rsi14']:.1f}。"
        )
        lines.append("")
    lines.append("以上为公开信息摘要，具体规则与影响以官方公告和后续披露为准。")
    lines.append("")
    lines.append(disclosure)
    if market:
        lines.append("")
        lines.append(f"${base_asset(market['symbol'])}")

    text = "\n".join(lines).strip()
    return enforce(text, banned, disclosure)
