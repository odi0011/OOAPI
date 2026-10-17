"""合规与文案的最小测试。

直接运行：python content/test_compliance.py
不依赖测试框架，断言失败就抛错。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compose  # noqa: E402
import news  # noqa: E402

CONFIG = {
    "banned_phrases": ["保证", "稳赚", "必涨", "喊单", "目标价"],
    "disclosure": "以上不构成投资建议。",
}
MARKETS = [{
    "symbol": "BTCUSDT", "interval": "1h", "price": 81500.0,
    "change_24h_pct": -0.8, "ema20": 81630.0, "ema50": 81820.0,
    "ema200": 82250.0, "rsi14": 56.0, "atr_pct": 0.4, "funding_rate": 0.00005,
}]
NEWS = [{"title": "Binance Will List XYZ", "source": "Binance Announcement"}]


def expect_error(fn, label):
    try:
        fn()
    except compose.ComplianceError:
        return
    raise AssertionError(f"{label}: 应该被拒绝但没有")


def main() -> None:
    # 禁用词
    expect_error(
        lambda: compose.enforce("保证收益 " + CONFIG["disclosure"], CONFIG["banned_phrases"],
                                CONFIG["disclosure"]),
        "banned phrase",
    )
    # 缺少免责声明
    expect_error(
        lambda: compose.enforce("今天市场下跌。", CONFIG["banned_phrases"], CONFIG["disclosure"]),
        "missing disclosure",
    )
    # 价格目标
    expect_error(
        lambda: compose.enforce("目标价 90000。" + CONFIG["disclosure"],
                                CONFIG["banned_phrases"], CONFIG["disclosure"]),
        "price target",
    )
    # 过长
    expect_error(
        lambda: compose.enforce("x" * 2000 + CONFIG["disclosure"],
                                CONFIG["banned_phrases"], CONFIG["disclosure"]),
        "too long",
    )

    daily = compose.daily_text(MARKETS, NEWS, [], CONFIG, "10月17日")
    assert CONFIG["disclosure"] in daily
    assert "$BTC" in daily
    assert "BTC $81,500（-0.80%）" in daily
    assert "Binance Will List XYZ" in daily

    single = compose.news_text(NEWS[0], MARKETS[0], CONFIG)
    assert CONFIG["disclosure"] in single
    assert NEWS[0]["title"] in single
    assert "$BTC" in single

    # topic key 稳定、不同标题不同 key
    assert news.topic_key("Hello World") == news.topic_key("hello   world!")
    assert news.topic_key("A") != news.topic_key("B")

    print("compliance tests: OK")


if __name__ == "__main__":
    main()
