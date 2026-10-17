"""从本地 OOAPI 管理接口读账户级持仓。

需要环境变量：
  OOAPI_BASE       默认 http://127.0.0.1:3001
  OOAPI_ADMIN_USER
  OOAPI_ADMIN_PASS
读不到就返回空列表 —— 内容管线不应因为持仓接口失败而中断。
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import urllib.error
import urllib.request


def fetch_positions(config: dict) -> list[dict]:
    base = (os.environ.get("OOAPI_BASE")
            or (config.get("positions_api") or {}).get("base")
            or "http://127.0.0.1:3001").rstrip("/")
    user = os.environ.get("OOAPI_ADMIN_USER", "")
    pwd = os.environ.get("OOAPI_ADMIN_PASS", "")
    if not user or not pwd:
        return []
    strategy_id = (config.get("positions_api") or {}).get("strategy_id", 2)

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    try:
        login = urllib.request.Request(
            base + "/api/auth/login",
            data=json.dumps({"username": user, "password": pwd}).encode(),
            headers={"Content-Type": "application/json"},
        )
        opener.open(login, timeout=10).read()
        with opener.open(f"{base}/api/trading/engine/balance?strategyId={strategy_id}",
                         timeout=10) as resp:
            payload = json.loads(resp.read().decode())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError):
        return []

    rows = (payload.get("data") or {}).get("positions") or []
    out = []
    for p in rows:
        if not p.get("open", True):
            continue
        out.append({
            "symbol": p.get("symbol"),
            "side": p.get("side"),
            "qty": p.get("qty"),
            "entryPrice": p.get("entryPrice"),
            "markPrice": p.get("markPrice"),
            "unrealizedPnl": p.get("unrealizedPnl"),
            "leverage": p.get("leverage"),
            "marginMode": p.get("marginMode"),
        })
    return out


if __name__ == "__main__":
    import sys
    cfg = json.load(open(os.path.join(os.path.dirname(__file__), "config.json")))
    print(json.dumps(fetch_positions(cfg), indent=2, ensure_ascii=False))
