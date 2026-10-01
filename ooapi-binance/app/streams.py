import asyncio
import json
import logging
import time
from decimal import Decimal, InvalidOperation
import websockets
from sqlalchemy import select
from .config import settings
from .db import SessionLocal
from .models import ExchangeAccount, Order
from .services import apply_fill, record_exchange_order, client_for, sync_account, account_locks

logger = logging.getLogger(__name__)
quotes: dict[str, dict] = {}
market_status = {"connected": False, "lastMessageAt": None, "error": None}


def process_market_message(data) -> bool:
    if isinstance(data, dict) and "data" in data:
        data = data["data"]
    updated = False
    for row in data if isinstance(data, list) else [data]:
        if not isinstance(row, dict) or row.get("e") != "markPriceUpdate" or row.get("st", 1) != 1:
            continue
        try:
            price = Decimal(row["p"])
            if not row["s"] or not price.is_finite() or price <= 0:
                continue
        except (KeyError, InvalidOperation, TypeError):
            continue
        quotes[row["s"]] = {"symbol": row["s"], "markPrice": str(price), "fundingRate": row.get("r", "0"), "updatedAt": time.time()}
        updated = True
    if updated:
        market_status.update(connected=True, lastMessageAt=time.time(), error=None)
    return updated


async def market_loop():
    delay = 1
    while True:
        try:
            proxy = settings.proxy_url or True
            async with websockets.connect("wss://fstream.binance.com/market/ws/!markPrice@arr@1s", proxy=proxy, ping_interval=20, ping_timeout=20, open_timeout=10) as stream:
                market_status.update(connected=False, error=None)
                received_at = time.monotonic()
                while True:
                    raw = await asyncio.wait_for(stream.recv(), timeout=20)
                    if process_market_message(json.loads(raw)):
                        delay = 1
                        received_at = time.monotonic()
                    if time.monotonic() - received_at > 20:
                        raise TimeoutError("No valid market updates")
                    if proxy != (settings.proxy_url or True):
                        raise ConnectionAbortedError("Proxy configuration changed")
        except asyncio.CancelledError:
            market_status["connected"] = False
            raise
        except Exception as exc:
            market_status.update(connected=False, error=type(exc).__name__)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)


def process_user_message(account_id: int, data: dict):
    with account_locks[account_id]:
        _process_user_message(account_id, data)


def _process_user_message(account_id: int, data: dict):
    with SessionLocal() as db:
        account = db.get(ExchangeAccount, account_id)
        if not account or not account.active:
            return
        if data.get("e") == "ORDER_TRADE_UPDATE":
            payload = data["o"]
            order = record_exchange_order(db, account, {"orderId": payload["i"], "clientOrderId": payload["c"], "symbol": payload["s"], "side": payload["S"], "positionSide": payload.get("ps", "BOTH"), "origQty": payload["q"], "type": payload.get("ot", payload.get("o", "MARKET")), "reduceOnly": payload.get("R", False), "closePosition": payload.get("cp", False), "status": payload["X"], "executedQty": payload["z"], "avgPrice": payload["ap"], "time": payload.get("T")})
            if payload.get("x") == "TRADE":
                apply_fill(db, order, trade_id=str(payload["t"]), quantity=Decimal(payload["l"]), realized_pnl=Decimal(payload.get("rp", "0")), commission=Decimal(payload.get("n") or "0"), commission_asset=payload.get("N") or "USDT")
            db.commit()
        if data.get("e") in ("ORDER_TRADE_UPDATE", "ACCOUNT_UPDATE"):
            sync_account(db, account)


async def user_loop(account_id: int):
    delay = 1
    while True:
        try:
            with SessionLocal() as db:
                account = db.get(ExchangeAccount, account_id)
                if not account or not account.active or (settings.ooapi_mode and account.owner_id is None):
                    return
                client = client_for(account)
                endpoint = "wss://fstream.binancefuture.com/private/ws/" if account.environment == "testnet" else "wss://fstream.binance.com/private/ws/"
            key = await asyncio.to_thread(client.listen_key)
            async with websockets.connect(endpoint + key, proxy=client.proxy_url or None, ping_interval=20, open_timeout=10) as stream:
                delay = 1
                refreshed = time.monotonic()
                while True:
                    try:
                        raw = await asyncio.wait_for(stream.recv(), timeout=30)
                        data = json.loads(raw)
                        if data.get("e") == "listenKeyExpired":
                            break
                        await asyncio.to_thread(process_user_message, account_id, data)
                    except asyncio.TimeoutError:
                        pass
                    if time.monotonic() - refreshed > 1500:
                        await asyncio.to_thread(client.keepalive, key)
                        refreshed = time.monotonic()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Account stream disconnected for %s", account_id)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)


async def user_stream_manager():
    tasks = {}
    try:
        while True:
            try:
                with SessionLocal() as db:
                    query = select(ExchangeAccount.id).where(ExchangeAccount.active.is_(True), ExchangeAccount.environment != "demo")
                    if settings.ooapi_mode: query = query.where(ExchangeAccount.owner_id.is_not(None))
                    ids = set(db.scalars(query).all())
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Account stream discovery failed; retrying")
                await asyncio.sleep(15)
                continue
            for account_id in ids:
                if account_id not in tasks or tasks[account_id].done():
                    tasks[account_id] = asyncio.create_task(user_loop(account_id))
            for account_id in list(tasks):
                if account_id not in ids:
                    task = tasks.pop(account_id)
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            await asyncio.sleep(15)
    finally:
        for task in tasks.values():
            task.cancel()
        await asyncio.gather(*tasks.values(), return_exceptions=True)
