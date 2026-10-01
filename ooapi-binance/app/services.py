import json
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.orm import Session
from .binance import BinanceClient, BinanceError
from .config import settings
from .models import AccountSnapshot, ExchangeAccount, Order, OrderFill, Position, ProtectionOrder, RiskConfig, Strategy, StrategyEvent
from .security import decrypt
from .profiles import profile_for, live_allowed

account_locks = defaultdict(threading.RLock)
D = Decimal


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def client_for(account: ExchangeAccount) -> BinanceClient:
    return BinanceClient(decrypt(account.api_key_ciphertext), decrypt(account.secret_key_ciphertext), testnet=account.environment == "testnet", proxy_url=profile_for(account.owner_id).proxy_url)


def latest_snapshot(db: Session, account_id: int) -> AccountSnapshot | None:
    return db.scalars(select(AccountSnapshot).where(AccountSnapshot.account_id == account_id).order_by(AccountSnapshot.id.desc()).limit(1)).first()


def risk_config(db: Session, account_id: int) -> RiskConfig:
    risk = db.scalars(select(RiskConfig).where(RiskConfig.account_id == account_id)).first()
    if not risk:
        risk = RiskConfig(account_id=account_id)
        db.add(risk)
        db.flush()
    return risk


def sync_account(db: Session, account: ExchangeAccount) -> dict:
    with account_locks[account.id]:
        client = client_for(account)
        positions = db.scalars(select(Position).where(Position.account_id == account.id)).all()
        if account.environment == "demo":
            previous = latest_snapshot(db, account.id)
            wallet = previous.total_wallet_balance if previous else D("10000")
            for pos in positions:
                pos.mark_price = client.ticker_price(pos.symbol)
                pos.unrealized_pnl = (pos.mark_price - pos.entry_price) * pos.quantity * (1 if pos.side == "LONG" else -1)
                pos.margin = pos.quantity * pos.mark_price / pos.leverage
            snapshot = AccountSnapshot(account_id=account.id, total_wallet_balance=wallet, total_unrealized_pnl=sum((p.unrealized_pnl for p in positions), D(0)), margin_used=sum((p.margin for p in positions), D(0)), available_balance=wallet - sum((p.margin for p in positions), D(0)))
        else:
            result, rows = client.account(), client.positions()
            snapshot = AccountSnapshot(account_id=account.id, total_wallet_balance=D(result.get("totalWalletBalance", "0")), available_balance=D(result.get("availableBalance", "0")), total_unrealized_pnl=D(result.get("totalUnrealizedProfit", "0")), margin_used=D(result.get("totalInitialMargin", "0")))
            current = {(p.symbol, p.position_side): p for p in positions}
            seen = set()
            for row in rows:
                qty = D(row.get("positionAmt", "0"))
                if not qty:
                    continue
                key = (row["symbol"], row.get("positionSide", "BOTH"))
                seen.add(key)
                pos = current.get(key)
                if not pos:
                    pos = Position(account_id=account.id, symbol=key[0], position_side=key[1])
                    db.add(pos)
                elif pos.side != ("LONG" if qty > 0 else "SHORT"):
                    pos.stop_loss = pos.take_profit = pos.trailing_pct = pos.peak_price = None
                pos.side, pos.quantity = ("LONG" if qty > 0 else "SHORT"), abs(qty)
                pos.entry_price, pos.mark_price = D(row["entryPrice"]), D(row["markPrice"])
                pos.unrealized_pnl = D(row.get("unRealizedProfit", "0"))
                pos.margin = D(row.get("positionInitialMargin", "0"))
                pos.leverage = int(row.get("leverage", round(abs(qty * pos.mark_price) / pos.margin) if pos.margin else 1))
                pos.liquidation_price = D(row.get("liquidationPrice", "0"))
                pos.updated_at = utcnow()
            for key, pos in current.items():
                if key not in seen:
                    db.delete(pos)
        db.add(snapshot)
        account.last_sync_at, account.last_sync_error = utcnow(), None
        db.commit()
        return {"status": "ok", "environment": account.environment}


def check_risk(db: Session, account: ExchangeAccount, symbol: str, quantity: Decimal, price: Decimal, *, reduce_only: bool, position_side: str = "BOTH"):
    if reduce_only:
        return
    risk = risk_config(db, account.id)
    if risk.trading_halted:
        raise ValueError("风控已停止开仓")
    if quantity * price > risk.max_order_notional:
        raise ValueError("订单超过单笔金额限制")
    snapshot = latest_snapshot(db, account.id)
    if not snapshot or (utcnow() - snapshot.captured_at).total_seconds() > 90:
        raise ValueError("账户快照缺失或过期，请先同步账户")
    equity = snapshot.total_wallet_balance + snapshot.total_unrealized_pnl
    if equity <= 0:
        raise ValueError("账户权益不足")
    # Reserve pending/unknown orders too, so a timed-out order cannot free its risk budget.
    pending = db.scalars(select(Order).where(Order.account_id == account.id, Order.status.in_(["pending", "new", "unknown", "partially_filled"]), Order.reduce_only.is_(False))).all()
    reserved = sum((o.quantity * (o.price or price) for o in pending), D(0))
    if (snapshot.margin_used + reserved + quantity * price) / equity > risk.max_margin_ratio:
        raise ValueError("预计保证金占用超过限制")
    if quantity * price + reserved > snapshot.available_balance:
        raise ValueError("可用余额不足")
    day_start = (utcnow() + timedelta(hours=8)).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(hours=8)
    first = db.scalars(select(AccountSnapshot).where(AccountSnapshot.account_id == account.id, AccountSnapshot.captured_at >= day_start).order_by(AccountSnapshot.id).limit(1)).first()
    if first and equity - (first.total_wallet_balance + first.total_unrealized_pnl) <= -risk.max_daily_loss:
        raise ValueError("已达到每日亏损限制")
    positions = db.scalars(select(Position).where(Position.account_id == account.id)).all()
    if any(p.leverage > risk.max_leverage for p in positions if p.symbol == symbol):
        raise ValueError("当前合约杠杆超过限制")
    occupied = {(p.symbol, p.position_side) for p in positions} | {(o.symbol, o.position_side) for o in pending}
    if (symbol, position_side) not in occupied and len(occupied) >= risk.max_open_positions:
        raise ValueError("已达到最大仓位数量")


def _paper_fill(db: Session, account: ExchangeAccount, order: Order):
    pos = db.scalars(select(Position).where(Position.account_id == account.id, Position.symbol == order.symbol, Position.position_side == order.position_side)).first()
    incoming = 1 if order.side == "BUY" else -1
    if order.reduce_only:
        if not pos or incoming == (1 if pos.side == "LONG" else -1) or order.quantity > pos.quantity:
            raise ValueError("平仓方向或数量无效")
    wallet = latest_snapshot(db, account.id).total_wallet_balance
    fee = order.quantity * order.price * D("0.0005")
    realized = D(0)
    if not pos:
        pos = Position(account_id=account.id, symbol=order.symbol, position_side=order.position_side, side="LONG" if incoming == 1 else "SHORT", quantity=order.quantity, entry_price=order.price, mark_price=order.price, leverage=1, margin=order.quantity * order.price)
        db.add(pos)
    elif incoming == (1 if pos.side == "LONG" else -1):
        pos.entry_price = (pos.entry_price * pos.quantity + order.price * order.quantity) / (pos.quantity + order.quantity)
        pos.quantity += order.quantity
    else:
        closed = min(order.quantity, pos.quantity)
        realized = closed * (order.price - pos.entry_price) * (1 if pos.side == "LONG" else -1)
        remaining = pos.quantity - order.quantity
        if remaining == 0:
            db.delete(pos)
        elif remaining > 0:
            pos.quantity = remaining
        else:
            pos.side, pos.quantity, pos.entry_price = ("LONG" if incoming == 1 else "SHORT"), -remaining, order.price
            pos.stop_loss = pos.take_profit = pos.trailing_pct = pos.peak_price = None
    db.flush()
    positions = db.scalars(select(Position).where(Position.account_id == account.id)).all()
    for p in positions:
        if p.symbol == order.symbol:
            p.mark_price = order.price
        p.unrealized_pnl = (p.mark_price - p.entry_price) * p.quantity * (1 if p.side == "LONG" else -1)
        p.margin = p.quantity * p.mark_price / p.leverage
    margin = sum((p.margin for p in positions), D(0))
    unrealized = sum((p.unrealized_pnl for p in positions), D(0))
    wallet += realized - fee
    db.add(AccountSnapshot(account_id=account.id, total_wallet_balance=wallet, total_unrealized_pnl=unrealized, margin_used=margin, available_balance=wallet - margin))
    order.realized_pnl, order.commission, order.filled_quantity, order.status = realized, fee, order.quantity, "filled"
    order.reconciled_quantity = order.quantity


def submit_order(db: Session, *, account: ExchangeAccount, symbol: str, side: str, quantity: Decimal, mode: str, client_order_id: str, reduce_only: bool = False, strategy_id: int | None = None, position_side: str = "BOTH") -> Order:
    with account_locks[account.id]:
        existing = db.scalars(select(Order).where(Order.client_order_id == client_order_id)).first()
        if existing:
            if (existing.account_id, existing.symbol, existing.side, existing.reduce_only, existing.position_side, existing.mode) != (account.id, symbol, side, reduce_only, position_side, mode):
                raise ValueError("订单请求编号已用于其他订单")
            if existing.quantity != quantity:
                raise ValueError("订单请求编号对应的数量不同")
            return existing
        if mode != account.environment:
            raise ValueError("订单环境与账户不一致")
        if not account.active:
            raise ValueError("账户已停用")
        if not reduce_only and ((position_side == "LONG" and side == "SELL") or (position_side == "SHORT" and side == "BUY")):
            raise ValueError("双向模式平仓请使用仓位页的平仓操作")
        if mode == "live" and not live_allowed(account):
            raise ValueError("实盘交易未启用")
        client = client_for(account)
        sync_account(db, account)
        if mode != "demo":
            if not reduce_only:
                config = client.symbol_configuration(symbol)
                if not config or int(config["leverage"]) > risk_config(db, account.id).max_leverage:
                    raise ValueError("交易所当前杠杆超过风控限制，请先调整 Binance 合约杠杆")
        price = client.ticker_price(symbol)
        quantity = client.normalize_quantity(symbol, quantity, price, reduce_only=reduce_only)
        pos = db.scalars(select(Position).where(Position.account_id == account.id, Position.symbol == symbol, Position.position_side == position_side)).first()
        if reduce_only and (not pos or quantity > pos.quantity or side == ("BUY" if pos.side == "LONG" else "SELL")):
            raise ValueError("平仓数量或方向与当前仓位不一致")
        check_risk(db, account, symbol, quantity, price, reduce_only=reduce_only, position_side=position_side)
        order = Order(account_id=account.id, strategy_id=strategy_id, symbol=symbol, side=side, quantity=quantity, price=price, reduce_only=reduce_only, mode=mode, position_side=position_side, client_order_id=client_order_id, status="pending")
        db.add(order)
        db.commit()  # Persist idempotency and risk reservation BEFORE the network request.
        try:
            if mode == "demo":
                _paper_fill(db, account, order)
            else:
                result = client.order(symbol=symbol, side=side, quantity=quantity, client_order_id=client_order_id, reduce_only=reduce_only, position_side=position_side)
                apply_order_result(order, result)
            db.commit()
        except BinanceError as exc:
            order.status = "unknown" if exc.uncertain else "rejected"
            order.error_message = str(exc)
            db.commit()
            if not exc.uncertain:
                raise
        except Exception as exc:
            db.rollback()
            order = db.scalars(select(Order).where(Order.client_order_id == client_order_id)).one()
            order.status = "rejected" if mode == "demo" else "unknown"
            order.error_message = "订单响应待确认" if mode != "demo" else str(exc)
            db.commit()
            raise
        db.refresh(order)
        return order


def apply_order_result(order: Order, result: dict):
    if not isinstance(result, dict) or not result.get("orderId") or not result.get("status"):
        raise ValueError("Binance 订单响应不完整，执行状态待确认")
    order.exchange_order_id = str(result.get("orderId", order.exchange_order_id or ""))
    incoming = result["status"].lower()
    terminal = {"filled", "canceled", "expired", "expired_in_match", "rejected"}
    incoming_quantity = D(str(result.get("executedQty", "0")))
    old_quantity = order.filled_quantity or D(0)
    if order.status != "filled" and (order.status not in terminal or incoming in terminal):
        order.status = incoming
    order.filled_quantity = max(old_quantity, incoming_quantity)
    if incoming_quantity >= old_quantity and D(str(result.get("avgPrice", "0"))) > 0:
        order.price = D(str(result["avgPrice"]))
    order.error_message = None


def apply_fill(db: Session, order: Order, *, trade_id: str, realized_pnl: Decimal, commission: Decimal, commission_asset: str, quantity: Decimal = D(0)):
    db.flush()  # A repeated event in the same transaction must see the first fill.
    existing = db.scalars(select(OrderFill).where(OrderFill.order_id == order.id, OrderFill.trade_id == trade_id)).first()
    if existing:
        # A pre-upgrade fill can acquire its quantity without counting PnL or fees twice.
        if not existing.quantity and quantity:
            existing.quantity = quantity
            order.reconciled_quantity = (order.reconciled_quantity or D(0)) + quantity
        return
    db.add(OrderFill(order_id=order.id, trade_id=trade_id, quantity=quantity, realized_pnl=realized_pnl, commission=commission, commission_asset=commission_asset))
    order.reconciled_quantity = (order.reconciled_quantity or D(0)) + quantity
    order.realized_pnl += realized_pnl
    if commission_asset == "USDT": order.commission += commission


def record_exchange_order(db: Session, account: ExchangeAccount, result: dict) -> Order:
    exchange_id = str(result["orderId"])
    order = db.scalar(select(Order).where(Order.account_id == account.id, Order.exchange_order_id == exchange_id))
    if not order and result.get("clientOrderId"):
        order = db.scalar(select(Order).where(Order.account_id == account.id, Order.client_order_id == result["clientOrderId"]))
    if not order:
        order = Order(account_id=account.id, symbol=result["symbol"], side=result["side"], position_side=result.get("positionSide", "BOTH"), quantity=max(D(str(result["origQty"])), D(str(result.get("executedQty", "0")))), price=D(str(result.get("avgPrice", "0"))), order_type=result.get("type", "MARKET"), reduce_only=bool(result.get("reduceOnly") or result.get("closePosition")), mode=account.environment, client_order_id=f"ex-{account.id}-{exchange_id}", status="new")
        if result.get("time"):
            order.created_at = datetime.fromtimestamp(int(result["time"]) / 1000, timezone.utc).replace(tzinfo=None)
        db.add(order); db.flush()
    apply_order_result(order, result)
    order.quantity = max(order.quantity, D(str(result.get("origQty", "0"))), order.filled_quantity)
    return order


def signal_from_closes(closes: list[float], config: dict, strategy_type: str) -> str:
    fast, slow = int(config.get("fast_period", 10)), int(config.get("slow_period", 30))
    if strategy_type == "rsi":
        if len(closes) <= fast:
            return "HOLD"
        changes = [b - a for a, b in zip(closes[-fast - 1:-1], closes[-fast:])]
        gain, loss = sum(max(d, 0) for d in changes), sum(max(-d, 0) for d in changes)
        if gain == loss == 0:
            return "HOLD"
        rsi = 100 if loss == 0 else 100 - 100 / (1 + gain / loss)
        return "BUY" if rsi < 30 else "SELL" if rsi > 70 else "HOLD"
    if len(closes) < slow + 1:
        return "HOLD"
    now = sum(closes[-fast:]) / fast - sum(closes[-slow:]) / slow
    before = sum(closes[-fast - 1:-1]) / fast - sum(closes[-slow - 1:-1]) / slow
    return "BUY" if now > 0 and before <= 0 else "SELL" if now < 0 and before >= 0 else "HOLD"


def run_strategy(db: Session, strategy: Strategy, *, scheduled: bool = False) -> dict:
    with account_locks[strategy.account_id]:
        db.refresh(strategy)
        if scheduled and strategy.status != "running":
            db.commit()
            return {"skipped": True, "reason": "paused"}
        return _run_strategy(db, strategy)


def _run_strategy(db: Session, strategy: Strategy) -> dict:
    config = json.loads(strategy.config_json)
    account = db.get(ExchangeAccount, strategy.account_id)
    if not account or not account.active:
        raise ValueError("策略账户不可用")
    rows = client_for(account).klines(strategy.symbol, strategy.timeframe, max(int(config.get("slow_period", 30)) + 3, 100))
    closed = [r for r in rows if int(r[6]) < int(datetime.now(timezone.utc).timestamp() * 1000)]
    if not closed:
        raise ValueError("没有已收盘 K 线")
    candle_id = int(closed[-1][0])
    if config.get("last_candle_id") == candle_id:
        return {"signal": strategy.last_signal or "HOLD", "skipped": True}
    closes = [float(r[4]) for r in closed]
    signal = signal_from_closes(closes, config, strategy.strategy_type)
    previous_signal = strategy.last_signal
    config["last_candle_id"] = candle_id
    strategy.config_json = json.dumps(config)
    strategy.last_run_at, strategy.last_signal = utcnow(), signal
    db.add(StrategyEvent(strategy_id=strategy.id, signal=signal, price=closes[-1], message="K线信号"))
    db.commit()
    if signal != "HOLD" and config.get("auto_execute", False):
        order_id = f"s{strategy.id}-{candle_id}"
        try:
            if account.environment != "demo": sync_account(db, account)
            position_side = config.get("position_side", "BOTH")
            pos = db.scalar(select(Position).where(Position.account_id == account.id, Position.symbol == strategy.symbol, Position.position_side == position_side))
            current = pos.quantity * (1 if pos.side == "LONG" else -1) if pos else D(0)
            target = D(str(config["quantity"])) * (1 if signal == "BUY" else -1)
            if (position_side == "LONG" and signal == "SELL") or (position_side == "SHORT" and signal == "BUY"):
                target = D(0)
            if current and target and current * target < 0:
                closed_order = submit_order(db, account=account, symbol=strategy.symbol, side="SELL" if current > 0 else "BUY", quantity=abs(current), mode=account.environment, strategy_id=strategy.id, position_side=position_side, reduce_only=True, client_order_id=order_id + "-c")
                if closed_order.status != "filled": raise ValueError("反向平仓尚未确认，暂不开新仓")
                current = D(0)
            delta = target - current
            if delta:
                reducing = bool(current and (not target or abs(target) < abs(current)))
                submit_order(db, account=account, symbol=strategy.symbol, side="BUY" if delta > 0 else "SELL", quantity=abs(delta), mode=account.environment, strategy_id=strategy.id, position_side=position_side, reduce_only=reducing, client_order_id=order_id + "-a")
        except (ValueError, BinanceError) as exc:
            db.add(StrategyEvent(strategy_id=strategy.id, signal=signal, price=closes[-1], message=str(exc)[:255]))
            db.commit()
            raise
    return {"signal": signal, "price": closes[-1], "auto_execute": bool(config.get("auto_execute", False))}


def close_position(db: Session, pos: Position, pct: Decimal, client_order_id: str):
    with account_locks[pos.account_id]:
        db.refresh(pos)
        return submit_order(db, account=db.get(ExchangeAccount, pos.account_id), symbol=pos.symbol, side="SELL" if pos.side == "LONG" else "BUY", quantity=pos.quantity * pct, mode=db.get(ExchangeAccount, pos.account_id).environment, position_side=pos.position_side, reduce_only=True, client_order_id=client_order_id)


def set_protection(db: Session, pos: Position, *, stop_loss: Decimal | None, take_profit: Decimal | None, trailing_pct: Decimal | None):
    account = db.get(ExchangeAccount, pos.account_id)
    with account_locks[account.id]:
        if not account.active:
            raise ValueError("账户已停用")
        if account.environment != "demo":
            if account.environment == "live" and not live_allowed(account):
                raise ValueError("实盘交易未启用")
            position_id = pos.id
            sync_account(db, account)
            pos = db.get(Position, position_id)
            if not pos:
                raise ValueError("仓位已变化，请刷新后重新设置")
            client = client_for(account)
            price = client.ticker_price(pos.symbol)
            for trigger in (stop_loss, take_profit):
                if trigger: client.validate_trigger_price(pos.symbol, trigger)
        else:
            price = pos.mark_price
        if stop_loss and ((pos.side == "LONG" and stop_loss >= price) or (pos.side == "SHORT" and stop_loss <= price)):
            raise ValueError("止损价方向错误")
        if take_profit and ((pos.side == "LONG" and take_profit <= price) or (pos.side == "SHORT" and take_profit >= price)):
            raise ValueError("止盈价方向错误")
        if account.environment != "demo":
            active = db.scalars(select(ProtectionOrder).where(ProtectionOrder.account_id == account.id, ProtectionOrder.symbol == pos.symbol, ProtectionOrder.position_side == pos.position_side, ProtectionOrder.status.in_(["new", "working", "pending", "unknown"]))).all()
            for previous in active:
                # An ambiguous placement must be resolved before any replacement is submitted.
                state = client.query_protection(previous.client_algo_id)
                previous.status = state.get("algoStatus", "NEW").lower()
                if previous.status in ("new", "working"):
                    client.cancel_protection(previous.client_algo_id)
                    previous.status = "canceled"
                db.commit()
            pos.stop_loss, pos.take_profit = None, None
            db.commit()
            for kind, trigger in (("STOP_MARKET", stop_loss), ("TAKE_PROFIT_MARKET", take_profit)):
                if not trigger:
                    continue
                native = ProtectionOrder(account_id=account.id, symbol=pos.symbol, position_side=pos.position_side, kind=kind, client_algo_id=f"protect-{uuid.uuid4().hex[:24]}", status="pending")
                db.add(native); db.commit()
                try:
                    result = client.protection_order(symbol=pos.symbol, side="SELL" if pos.side == "LONG" else "BUY", position_side=pos.position_side, kind=kind, trigger_price=trigger, client_algo_id=native.client_algo_id)
                    native.algo_id = str(result["algoId"])
                    native.status = result.get("algoStatus", "NEW").lower()
                    if kind == "STOP_MARKET": pos.stop_loss = trigger
                    else: pos.take_profit = trigger
                    db.commit()
                except BinanceError as exc:
                    native.status = "unknown" if exc.uncertain else "rejected"
                    native.error_message = str(exc)
                    db.commit()
                    raise ValueError("条件单状态待确认，请查看订单页" if exc.uncertain else str(exc)) from exc
                except Exception as exc:
                    db.rollback()
                    native = db.get(ProtectionOrder, native.id)
                    native.status, native.error_message = "unknown", "条件单响应待确认"
                    db.commit()
                    raise ValueError("条件单状态待确认，请查看订单页") from exc
        pos.stop_loss, pos.take_profit, pos.trailing_pct = stop_loss, take_profit, trailing_pct
        pos.peak_price = price if trailing_pct else None
        db.commit()
