"""币安广场内容管线 CLI。

用法：
  python content/run.py daily                 # 生成日报草稿到 outbox
  python content/run.py daily --publish       # 生成并发布（review_mode 开启时需 --force）
  python content/run.py news                  # 抓新闻、挑一条生成草稿
  python content/run.py news --publish
  python content/run.py approve <草稿目录>     # 人工审核后发布
  python content/run.py status                # 今日已发数量与配置摘要

默认只写草稿，不联网发布。发布需要 BINANCE_SQUARE_OPENAPI_KEY。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import compose  # noqa: E402
import market  # noqa: E402
import news as news_mod  # noqa: E402
import positions as positions_mod  # noqa: E402
import publish  # noqa: E402

CONFIG_PATH = HERE / "config.json"
STATE_PATH = HERE / "state.json"
OUTBOX = HERE / "outbox"


def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {"daily": {}, "posted": {}}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8")


def today() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")


def allowed_today(state: dict, config: dict) -> bool:
    return state.get("daily", {}).get(today(), 0) < int(config.get("max_posts_per_day", 2))


def mark_posted(state: dict, key: str, link: str | None = None) -> None:
    day = today()
    state.setdefault("daily", {})[day] = state.get("daily", {}).get(day, 0) + 1
    state.setdefault("posted", {})[key] = {"at": time.time(), "link": link}
    save_state(state)


def safe_news(config: dict) -> list[dict]:
    """过滤掉标题里含禁用词的新闻，避免摘要本身触发合规检查。"""
    banned = config.get("banned_phrases", [])
    items = news_mod.candidates(config["news"]["min_score"], config["news"]["max_items"])
    return [it for it in items if not any(p in it["title"] for p in banned)]


def write_draft(kind: str, text: str, chart_path: str | None, meta: dict) -> Path:
    stamp = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d-%H%M%S")
    folder = OUTBOX / f"{stamp}-{kind}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "post.txt").write_text(text, encoding="utf-8")
    if chart_path:
        target = folder / Path(chart_path).name
        target.write_bytes(Path(chart_path).read_bytes())
        meta["images"] = [target.name]
    meta["text"] = text
    (folder / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False),
                                     encoding="utf-8")
    return folder


def maybe_publish(folder: Path, meta: dict, config: dict, publish_now: bool,
                  force: bool, dry_run: bool) -> None:
    if not publish_now:
        print(f"草稿已写入: {folder}")
        print("审核后用 `python content/run.py approve <目录>` 发布。")
        return
    if config.get("review_mode", True) and not force:
        print("review_mode 开启：不自动发布。确认内容后用 approve 发布，或加 --force。")
        print(f"草稿: {folder}")
        return
    images = meta.get("images") or []
    abs_images = [str(folder / name) for name in images]
    if images:
        result = publish.publish_image(meta["text"], config, abs_images,
                                       title=None, dry_run=dry_run)
    else:
        result = publish.publish_text(meta["text"], config, dry_run=dry_run)
    print("发布结果:", json.dumps(result, ensure_ascii=False))
    if result.get("ok") and not dry_run:
        state = load_state()
        key = meta.get("key") or folder.name
        mark_posted(state, key, result.get("link"))
        print(f"已记录: {key} link={result.get('link')}")


def cmd_daily(args: argparse.Namespace) -> None:
    config = load_config()
    state = load_state()
    if not allowed_today(state, config):
        print(f"今天已达发布上限 {config.get('max_posts_per_day')} 条，跳过。")
        return
    symbols = config.get("symbols", ["BTCUSDT"])
    markets = [market.snapshot(s) for s in symbols]
    items = safe_news(config)[:3]
    pos = positions_mod.fetch_positions(config) if config.get("include_positions") else []
    date_cn = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%m月%d日")
    text = compose.daily_text(markets, items, pos, config, date_cn)

    chart_path = HERE / "outbox" / "_chart.png"
    chart_path.parent.mkdir(parents=True, exist_ok=True)
    market.chart(symbols[0], str(chart_path))

    meta = {"kind": "daily", "symbols": symbols, "key": f"daily:{today()}",
            "positions": pos, "news": [i["title"] for i in items]}
    folder = write_draft("daily", text, str(chart_path), meta)
    try:
        chart_path.unlink()
    except OSError:
        pass
    print(text)
    print()
    maybe_publish(folder, meta, config, args.publish, args.force, args.dry_run)


def cmd_news(args: argparse.Namespace) -> None:
    config = load_config()
    state = load_state()
    if not allowed_today(state, config):
        print(f"今天已达发布上限 {config.get('max_posts_per_day')} 条，跳过。")
        return
    dedupe_s = float(config["news"]["dedupe_hours"]) * 3600
    now = time.time()
    picked = None
    for item in safe_news(config):
        prev = state.get("posted", {}).get(item["key"])
        if prev and now - float(prev.get("at", 0)) < dedupe_s:
            continue
        picked = item
        break
    if not picked:
        print("没有新的、分数达标且未发过的新闻。")
        return

    symbols = config.get("symbols", ["BTCUSDT"])
    title_l = picked["title"].lower()
    symbol = symbols[0]
    for s in symbols:
        base = compose.base_asset(s).lower()
        if base in title_l:
            symbol = s
            break
    m = market.snapshot(symbol)
    text = compose.news_text(picked, m, config)

    chart_path = HERE / "outbox" / "_chart.png"
    chart_path.parent.mkdir(parents=True, exist_ok=True)
    market.chart(symbol, str(chart_path))

    meta = {"kind": "news", "key": picked["key"], "title": picked["title"],
            "source": picked["source"], "url": picked["url"], "symbol": symbol}
    folder = write_draft("news", text, str(chart_path), meta)
    try:
        chart_path.unlink()
    except OSError:
        pass
    print(text)
    print()
    maybe_publish(folder, meta, config, args.publish, args.force, args.dry_run)


def cmd_approve(args: argparse.Namespace) -> None:
    folder = Path(args.dir).resolve()
    meta_path = folder / "meta.json"
    text_path = folder / "post.txt"
    if not meta_path.exists() or not text_path.exists():
        print("目录里缺少 meta.json / post.txt")
        sys.exit(1)
    config = load_config()
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["text"] = text_path.read_text(encoding="utf-8")
    images = meta.get("images") or []
    abs_images = [str(folder / name) for name in images]
    if images:
        result = publish.publish_image(meta["text"], config, abs_images,
                                       title=None, dry_run=args.dry_run)
    else:
        result = publish.publish_text(meta["text"], config, dry_run=args.dry_run)
    print(json.dumps(result, ensure_ascii=False))
    if result.get("ok") and not args.dry_run:
        state = load_state()
        mark_posted(state, meta.get("key") or folder.name, result.get("link"))


def cmd_status(args: argparse.Namespace) -> None:
    config = load_config()
    state = load_state()
    print(json.dumps({
        "review_mode": config.get("review_mode"),
        "max_posts_per_day": config.get("max_posts_per_day"),
        "today": today(),
        "today_posts": state.get("daily", {}).get(today(), 0),
        "total_posted": len(state.get("posted", {})),
        "api_key_present": publish.api_key_present(),
        "script_dir": str(publish.script_dir(config)),
    }, indent=1, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description="Binance Square content pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_daily = sub.add_parser("daily", help="生成每日市场简报")
    p_daily.add_argument("--publish", action="store_true")
    p_daily.add_argument("--force", action="store_true")
    p_daily.add_argument("--dry-run", action="store_true")
    p_daily.set_defaults(func=cmd_daily)

    p_news = sub.add_parser("news", help="抓取新闻并生成一条草稿")
    p_news.add_argument("--publish", action="store_true")
    p_news.add_argument("--force", action="store_true")
    p_news.add_argument("--dry-run", action="store_true")
    p_news.set_defaults(func=cmd_news)

    p_approve = sub.add_parser("approve", help="发布 outbox 里的草稿")
    p_approve.add_argument("dir")
    p_approve.add_argument("--dry-run", action="store_true")
    p_approve.set_defaults(func=cmd_approve)

    p_status = sub.add_parser("status", help="显示状态")
    p_status.set_defaults(func=cmd_status)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
