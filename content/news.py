"""新闻抓取、热度打分与去重。

来源：
  · 币安公告 CMS 接口（上币/下架/活动/API 更新）
  · Cointelegraph RSS

只做“事实型”选题：上币、下架、监管、ETF、安全事件、宏观。
输出按分数排序的候选列表，供 compose 使用。
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

BINANCE_CMS = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query"
BINANCE_ARTICLE = "https://www.binance.com/en/support/announcement/{code}"

# 关键词 → 分值。只影响“选题优先级”，不影响文案结论。
KEYWORDS: list[tuple[str, int]] = [
    ("listing", 3), ("list ", 3), ("delist", 3), ("launch", 3),
    ("etf", 3), ("sec", 3), ("regulation", 3), ("lawsuit", 2),
    ("hack", 3), ("exploit", 3), ("bankrupt", 3),
    ("federal reserve", 2), ("rate cut", 2), ("rate hike", 2),
    ("btc", 2), ("bitcoin", 2), ("eth", 2), ("ethereum", 2),
    ("sol", 2), ("solana", 2), ("xrp", 2), ("doge", 2), ("bnb", 2),
    ("funding", 1), ("liquidation", 1), ("whale", 1), ("upgrade", 1),
]


def _opener() -> urllib.request.OpenerDirector:
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    if proxy:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        )
    return urllib.request.build_opener()


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ooapi-content/1.0"})
    with _opener().open(req, timeout=25) as resp:
        return resp.read()


def topic_key(title: str) -> str:
    norm = re.sub(r"[^a-z0-9一-鿿]+", " ", title.lower()).strip()
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]


def score(title: str, published_ts: float) -> int:
    text = title.lower()
    s = 0
    for kw, weight in KEYWORDS:
        if kw in text:
            s += weight
    age_h = (time.time() - published_ts) / 3600
    if age_h < 2:
        s += 2
    elif age_h < 6:
        s += 1
    elif age_h > 48:
        s -= 2
    return s


def _binance_items(catalogs: list[int], limit: int) -> list[dict]:
    out = []
    for catalog_id in catalogs:
        url = f"{BINANCE_CMS}?type=1&pageNo=1&pageSize={limit}&catalogId={catalog_id}"
        try:
            payload = json.loads(_get(url).decode())
        except Exception:
            continue
        if payload.get("code") != "000000":
            continue
        for catalog in (payload.get("data") or {}).get("catalogs") or []:
            for art in catalog.get("articles") or []:
                title = html.unescape((art.get("title") or "").strip())
                if not title:
                    continue
                ts = (art.get("releaseDate") or 0) / 1000
                out.append({
                    "title": title,
                    "source": "Binance Announcement",
                    "url": BINANCE_ARTICLE.format(code=art.get("code", "")),
                    "published": ts,
                })
    return out


def _cointelegraph_items(limit: int) -> list[dict]:
    out = []
    try:
        root = ET.fromstring(_get("https://cointelegraph.com/rss"))
    except Exception:
        return out
    for item in root.iter("item"):
        title = html.unescape((item.findtext("title") or "").strip())
        link = (item.findtext("link") or "").strip()
        pub = item.findtext("pubDate") or ""
        try:
            ts = datetime.strptime(pub, "%a, %d %b %Y %H:%M:%S %z").timestamp()
        except Exception:
            ts = time.time()
        if title:
            out.append({
                "title": title,
                "source": "Cointelegraph",
                "url": link,
                "published": ts,
            })
        if len(out) >= limit:
            break
    return out


def fetch(limit: int = 30) -> list[dict]:
    items = _binance_items([48, 49, 161], limit) + _cointelegraph_items(limit)
    seen = set()
    unique = []
    for it in items:
        key = topic_key(it["title"])
        if key in seen:
            continue
        seen.add(key)
        it["key"] = key
        it["score"] = score(it["title"], it["published"])
        unique.append(it)
    unique.sort(key=lambda x: (x["score"], x["published"]), reverse=True)
    return unique


def candidates(min_score: int, max_items: int = 5) -> list[dict]:
    return [it for it in fetch() if it["score"] >= min_score][:max_items]


if __name__ == "__main__":
    for it in candidates(0, 10):
        age_h = (time.time() - it["published"]) / 3600
        print(f"[{it['score']:2d}] {age_h:5.1f}h  {it['source']:<20} {it['title'][:100]}")
