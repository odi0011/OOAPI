"""调用币安官方 Square Post 脚本发布内容。

官方脚本在 content/vendor/square-post/scripts/，需要：
  · Node.js 18+
  · BINANCE_SQUARE_OPENAPI_KEY（或在创作者中心保存到
    ~/.config/binance-square/openapi-key）

本模块只负责调用与解析结果；不直接手写 HTTP 请求。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def script_dir(config: dict) -> Path:
    raw = (config.get("square") or {}).get("script_dir", "content/vendor/square-post/scripts")
    p = Path(raw)
    return p if p.is_absolute() else REPO_ROOT / p


def api_key_present() -> bool:
    if os.environ.get("BINANCE_SQUARE_OPENAPI_KEY", "").strip():
        return True
    return (Path.home() / ".config" / "binance-square" / "openapi-key").exists()


def _run(args: list[str], config: dict, dry_run: bool) -> dict:
    cwd = script_dir(config)
    if not (cwd / "post-text.mjs").exists():
        raise RuntimeError(f"找不到官方脚本目录: {cwd}")
    if dry_run:
        print("[dry-run] cwd =", cwd)
        print("[dry-run] node " + " ".join(args))
        return {"ok": True, "dry_run": True, "id": None, "link": None}
    if not api_key_present():
        raise RuntimeError(
            "缺少 BINANCE_SQUARE_OPENAPI_KEY。请在 "
            "https://www.binance.com/square/creator-center/home 创建 API Key，"
            "然后运行：node scripts/save-key.mjs"
        )
    node = shutil.which("node") or "node"
    proc = subprocess.run([node] + args, cwd=cwd, capture_output=True, text=True,
                          env=os.environ.copy(), timeout=180)
    out = (proc.stdout or "") + "\n" + (proc.stderr or "")
    if proc.returncode != 0:
        raise RuntimeError(f"发布失败（exit {proc.returncode}）:\n{out.strip()}")
    post_id = None
    link = None
    m = re.search(r"ID:\s*(\S+)", out)
    if m:
        post_id = m.group(1)
    m = re.search(r"Link:\s*(\S+)", out)
    if m:
        link = m.group(1)
    return {"ok": True, "id": post_id, "link": link, "output": out.strip()}


def publish_text(text: str, config: dict, title: str | None = None,
                 dry_run: bool = True) -> dict:
    args = ["post-text.mjs", "--text", text]
    if title:
        args += ["--title", title]
    return _run(args, config, dry_run)


def publish_image(text: str, config: dict, images: list[str],
                  title: str | None = None, cover: str | None = None,
                  dry_run: bool = True) -> dict:
    args = ["post-image.mjs", "--text", text]
    if title:
        if not cover:
            raise ValueError("文章模式需要 --cover")
        args += ["--title", title, "--cover", cover]
    else:
        if not images:
            raise ValueError("图片帖子需要至少一张图片")
        args += ["--images", ",".join(images)]
    return _run(args, config, dry_run)
