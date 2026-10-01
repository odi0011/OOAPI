import asyncio
import logging

from sqlalchemy import select, or_

from .config import settings
from .db import SessionLocal
from .models import ExchangeAccount, Strategy, Position, ProtectionOrder, Order, StrategyEvent
from .services import run_strategy, sync_account, utcnow, close_position, client_for, apply_order_result, apply_fill, record_exchange_order, risk_config, account_locks
from decimal import Decimal
import uuid

logger = logging.getLogger(__name__)
automation_status = {"running": False, "lastCycleAt": None, "error": None}


def sync_all_accounts():
    with SessionLocal() as db:
        for account in db.scalars(select(ExchangeAccount).where(ExchangeAccount.active.is_(True))).all():
            if settings.ooapi_mode and account.owner_id is None: continue
            try:
                sync_account(db, account)
            except Exception as exc:
                db.rollback()
                account.last_sync_at = utcnow()
                account.last_sync_error = str(exc)[:1000]
                db.commit()
                logger.warning("Account %s sync failed", account.id)


def run_all_strategies():
    with SessionLocal() as db:
        for strategy in db.scalars(select(Strategy).where(Strategy.status == "running")).all():
            try:
                account = db.get(ExchangeAccount, strategy.account_id)
                if settings.ooapi_mode and (not account or account.owner_id is None): continue
                run_strategy(db, strategy, scheduled=True)
            except Exception:
                db.rollback()
                logger.exception("Strategy %s failed", strategy.id)


def reconcile_orders():
    with SessionLocal() as db:
        # Watch unresolved orders regardless of how many later orders have completed.
        rows = db.scalars(select(Order).where(Order.mode != "demo", or_(Order.status.in_(["pending", "unknown", "new", "partially_filled"]), Order.filled_quantity > Order.reconciled_quantity)).order_by(Order.id)).all()
        for order in rows:
            try:
                reconcile_one_order(db, order)
            except Exception:
                db.rollback()  # Keep unknown state; never blindly resubmit an ambiguous order.
        for native in db.scalars(select(ProtectionOrder).where(or_(ProtectionOrder.status.in_(["new", "working", "pending", "unknown", "triggering", "triggered"]), (ProtectionOrder.status == "finished") & ProtectionOrder.executed_order_id.is_(None)))).all():
            try:
                account = db.get(ExchangeAccount, native.account_id)
                if settings.ooapi_mode and (not account or account.owner_id is None): continue
                with account_locks[account.id]:
                    client = client_for(account)
                    result = client.query_protection(native.client_algo_id)
                    native.status = result.get("algoStatus", "NEW").lower()
                    native.algo_id = str(result.get("algoId", native.algo_id or ""))
                    if result.get("actualOrderId") and str(result["actualOrderId"]) != "0":
                        executed = record_exchange_order(db, account, client.query_order_by_id(native.symbol, str(result["actualOrderId"])))
                        native.executed_order_id = executed.id
                        reconcile_fills(db, client, executed)
                    pos = db.scalar(select(Position).where(Position.account_id == account.id, Position.symbol == native.symbol, Position.position_side == native.position_side))
                    fresh = account.last_sync_at and not account.last_sync_error and (utcnow() - account.last_sync_at).total_seconds() <= 90
                    wrong_side = pos and result.get("side") and result["side"] != ("SELL" if pos.side == "LONG" else "BUY")
                    if fresh and (not pos or wrong_side) and native.status in ("new", "working"):
                        client.cancel_protection(native.client_algo_id)
                        native.status = "canceled"
                    db.commit()
            except Exception:
                db.rollback()


def reconcile_one_order(db, order):
    with account_locks[order.account_id]:
        db.refresh(order)
        account = db.get(ExchangeAccount, order.account_id)
        if settings.ooapi_mode and (not account or account.owner_id is None): return
        client = client_for(account)
        result = client.query_order_by_id(order.symbol, order.exchange_order_id) if order.exchange_order_id else client.query_order(order.symbol, order.client_order_id)
        apply_order_result(order, result)
        reconcile_fills(db, client, order)
        db.commit()


def reconcile_fills(db, client, order):
    if order.exchange_order_id and order.filled_quantity > order.reconciled_quantity:
        for trade in client.user_trades(order.symbol, order.exchange_order_id):
            apply_fill(db, order, trade_id=str(trade["id"]), quantity=Decimal(trade["qty"]), realized_pnl=Decimal(trade["realizedPnl"]), commission=Decimal(trade["commission"]), commission_asset=trade["commissionAsset"])


def monitor_protection():
    with SessionLocal() as db:
        for pos in db.scalars(select(Position)).all():
            try:
                with account_locks[pos.account_id]:
                    db.refresh(pos)
                    account = db.get(ExchangeAccount, pos.account_id)
                    db.refresh(account)
                    if settings.ooapi_mode and account.owner_id is None: continue
                    if not account.active: continue
                    if account.last_sync_error or not account.last_sync_at or (utcnow() - account.last_sync_at).total_seconds() > 90:
                        continue
                    price = pos.mark_price
                    long = pos.side == "LONG"
                    # Real TP/SL runs on Binance; only paper TP/SL and trailing stops run locally.
                    stop = account.environment == "demo" and pos.stop_loss and (price <= pos.stop_loss if long else price >= pos.stop_loss)
                    take = account.environment == "demo" and pos.take_profit and (price >= pos.take_profit if long else price <= pos.take_profit)
                    if pos.trailing_pct:
                        pos.peak_price = max(pos.peak_price or price, price) if long else min(pos.peak_price or price, price)
                        stop = stop or (price <= pos.peak_price * (1 - pos.trailing_pct) if long else price >= pos.peak_price * (1 + pos.trailing_pct))
                    risk = risk_config(db, account.id)
                    buffer = abs(price - pos.liquidation_price) / price if pos.liquidation_price and price else 1
                    danger = buffer < risk.liquidation_buffer_pct
                    pending = db.scalars(select(Order).where(Order.account_id == account.id, Order.symbol == pos.symbol, Order.position_side == pos.position_side, Order.reduce_only.is_(True), Order.status.in_(["pending", "unknown", "new", "partially_filled"]))).first()
                    db.commit()
                    if (stop or take or danger) and not pending:
                        close_position(db, pos, Decimal(1), f"guard-{uuid.uuid4().hex[:24]}")
            except Exception:
                db.rollback()
                logger.exception("Position protection failed for %s", pos.id)


async def background_loop():
    tick = 0
    automation_status["running"] = True
    try:
        while True:
            try:
                await asyncio.to_thread(sync_all_accounts)
                await asyncio.to_thread(reconcile_orders)
                await asyncio.to_thread(monitor_protection)
                tick += settings.sync_interval_seconds
                if tick >= settings.strategy_interval_seconds:
                    await asyncio.to_thread(run_all_strategies)
                    tick = 0
                automation_status.update(lastCycleAt=utcnow().isoformat() + "Z", error=None)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                automation_status["error"] = type(exc).__name__
                logger.exception("Automation cycle failed; retrying next cycle")
            await asyncio.sleep(settings.sync_interval_seconds)
    finally:
        automation_status["running"] = False
