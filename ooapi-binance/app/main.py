from contextlib import asynccontextmanager
import asyncio
import hashlib
import json
import secrets
import uuid
import threading
from pathlib import Path
from datetime import timedelta, timezone
from decimal import Decimal
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .backtest import backtest
from .config import cors_origin_list, settings
from .db import Base, engine, get_db, SessionLocal
from .models import AccountSnapshot, BacktestRun, ExchangeAccount, LoginSession, Order, OrderFill, Position, ProtectionOrder, User, Strategy, StrategyEvent, TradingProfile
from .profiles import profile_for
from .scheduler import automation_status, background_loop, reconcile_one_order
from .schemas import AccountCreate, AccountUpdate, BacktestRequest, Login, OrderCreate, PositionClose, PositionProtection, PlatformSettings, RiskUpdate, StrategyCreate, StrategyUpdate, UserCreate, PasswordChange
from .security import encrypt, hash_password, new_session, require_user, verify_password
from .services import client_for, close_position, risk_config, run_strategy, set_protection, submit_order, sync_account, utcnow, account_locks, apply_order_result
from .streams import market_status, quotes, market_loop, user_stream_manager


setup_lock = threading.Lock()
login_failures = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.secret_key == "local-only-change-me" or len(settings.secret_key) < 32:
        raise RuntimeError("请先配置交易引擎的私有加密密钥")
    from alembic.config import Config
    from alembic import command
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    command.upgrade(config, "head")
    if settings.ooapi_mode and settings.ooapi_legacy_owner_id > 0:
        # 只认显式指定的旧数据归属，不让首次访问者自动认领已有真实资产。
        with SessionLocal() as db:
            db.query(ExchangeAccount).filter(ExchangeAccount.owner_id.is_(None)).update({ExchangeAccount.owner_id: settings.ooapi_legacy_owner_id})
            if not db.get(TradingProfile, settings.ooapi_legacy_owner_id):
                db.add(TradingProfile(owner_id=settings.ooapi_legacy_owner_id, proxy_url=settings.proxy_url, allow_live_trading=settings.allow_live_trading))
            db.commit()
    tasks = []
    if settings.scheduler_enabled:
        tasks.append(asyncio.create_task(background_loop()))
    if settings.market_stream_enabled:
        tasks += [asyncio.create_task(market_loop()), asyncio.create_task(user_stream_manager())]
    yield
    for task in tasks: task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="ODI API", version="0.2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=cors_origin_list(), allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def ooapi_auth_boundary(request: Request, call_next):
    # OOAPI 模式下只有统一用户管理；旧的登录/用户接口不能建立第二套平台身份。
    if settings.ooapi_mode and (request.url.path.startswith("/api/auth") or request.url.path.startswith("/api/users")):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=404, content={"detail": "用户管理由 OOAPI 提供"})
    return await call_next(request)


def user_guard(user: User = Depends(require_user)):
    return user


@app.get("/health")
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
        return {"service": "od-binance", "status": "ok", "database": "connected", "market": market_status, "automation": {"enabled": settings.scheduler_enabled, **automation_status}}
    except Exception as exc:
        return {"service": "od-binance", "status": "degraded", "database": "unavailable"}


@app.post("/api/auth/login")
def login(payload: Login, response: Response, request: Request, db: Session = Depends(get_db)):
    origin = request.headers.get("origin")
    if origin and origin not in cors_origin_list(): raise HTTPException(403, "来源不允许")
    ip = request.client.host if request.client else "local"
    failures = [t for t in login_failures.get(ip, []) if (utcnow() - t).total_seconds() < 300]
    if len(failures) >= 10: raise HTTPException(429, "登录失败过多，请稍后重试")
    user = db.scalars(select(User).where(User.username == payload.username)).first()
    if not user or not verify_password(payload.password, user.password_hash):
        login_failures[ip] = failures + [utcnow()]
        raise HTTPException(401, "用户名或密码错误")
    login_failures.pop(ip, None)
    return {"username": user.username, "role": user.role, "csrfToken": new_session(db, user, response)}


@app.get("/api/auth/status")
def auth_status(db: Session = Depends(get_db)):
    return {"configured": db.scalar(select(User.id).limit(1)) is not None}


@app.post("/api/auth/setup")
def setup(payload: Login, request: Request, response: Response, db: Session = Depends(get_db)):
    if request.headers.get("origin") and request.headers["origin"] not in cors_origin_list(): raise HTTPException(403, "来源不允许")
    with setup_lock:
        if db.scalar(select(User.id).limit(1)): raise HTTPException(409, "管理员已配置")
        user = User(username=payload.username, password_hash=hash_password(payload.password), role="admin")
        db.add(user)
        account = ExchangeAccount(name="模拟账户", environment="demo", api_key_ciphertext=encrypt(""), secret_key_ciphertext=encrypt(""))
        db.add(account); db.flush(); risk_config(db, account.id)
        db.add(AccountSnapshot(account_id=account.id, total_wallet_balance=10000, available_balance=10000, total_unrealized_pnl=0, margin_used=0))
        account.last_sync_at = utcnow(); db.commit(); db.refresh(user)
        return {"username": user.username, "role": user.role, "csrfToken": new_session(db, user, response)}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    token = request.cookies.get("qp_session", "")
    if token:
        db.query(LoginSession).filter(LoginSession.token_hash == hashlib.sha256(token.encode()).hexdigest()).delete(); db.commit()
    response.delete_cookie("qp_session"); return {"status": "ok"}


@app.get("/api/auth/me")
def me(request: Request, db: Session = Depends(get_db), user: User = Depends(user_guard)):
    token_hash = hashlib.sha256(request.cookies["qp_session"].encode()).hexdigest()
    session = db.scalars(select(LoginSession).where(LoginSession.token_hash == token_hash)).one()
    return {"username": user.username, "role": user.role, "csrfToken": session.csrf_token}


@app.post("/api/auth/password")
def change_password(payload: PasswordChange, db: Session = Depends(get_db), user: User = Depends(user_guard)):
    if not verify_password(payload.current_password, user.password_hash): raise HTTPException(400, "原密码错误")
    user.password_hash = hash_password(payload.new_password)
    db.query(LoginSession).filter(LoginSession.user_id == user.id).delete()
    db.commit()
    return {"status": "ok"}


@app.get("/api/users")
def users(db: Session = Depends(get_db), user: User = Depends(user_guard)):
    if user.role != "admin": raise HTTPException(403, "无权限")
    return [{"id": u.id, "username": u.username, "role": u.role} for u in db.scalars(select(User)).all()]


@app.post("/api/users")
def create_user(payload: UserCreate, db: Session = Depends(get_db), user: User = Depends(user_guard)):
    if db.scalar(select(User.id).where(User.username == payload.username)): raise HTTPException(409, "用户名已存在")
    db.add(User(username=payload.username, password_hash=hash_password(payload.password), role=payload.role)); db.commit()
    return {"status": "ok"}


@app.get("/api/dashboard")
def dashboard(account_id: int | None = None, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    query = select(ExchangeAccount).where(ExchangeAccount.active.is_(True))
    if account_id: query = query.where(ExchangeAccount.id == account_id)
    accounts = db.scalars(query).all()
    if not accounts: return {"totalEquity": 0, "dayPnl": 0, "dayPnlPct": 0, "marginUsed": 0, "marginTotal": 0, "positions": [], "strategies": [], "quotes": quotes, "market": market_status}
    equity = Decimal(0); pnl = Decimal(0); margin = Decimal(0)
    for account in accounts:
        snap = db.scalars(select(AccountSnapshot).where(AccountSnapshot.account_id == account.id).order_by(AccountSnapshot.id.desc()).limit(1)).first()
        if snap:
            current_equity = snap.total_wallet_balance + snap.total_unrealized_pnl
            equity += current_equity
            day_start = (utcnow() + timedelta(hours=8)).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(hours=8)
            first = db.scalars(select(AccountSnapshot).where(AccountSnapshot.account_id == account.id, AccountSnapshot.captured_at >= day_start).order_by(AccountSnapshot.id).limit(1)).first()
            pnl += current_equity - (first.total_wallet_balance + first.total_unrealized_pnl) if first else 0
            margin += snap.margin_used
    return {"totalEquity": float(equity), "dayPnl": float(pnl), "dayPnlPct": float(pnl / (equity - pnl) * 100) if equity - pnl else 0, "marginUsed": float(margin), "marginTotal": float(equity), "quotes": quotes, "market": market_status}


@app.get("/api/equity")
def equity(account_id: int | None = None, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    if not account_id: return []
    snapshots = db.scalars(select(AccountSnapshot).where(AccountSnapshot.account_id == account_id).order_by(AccountSnapshot.id.desc()).limit(500)).all()
    return [{"time": int(s.captured_at.replace(tzinfo=timezone.utc).timestamp() * 1000), "value": float(s.total_wallet_balance + s.total_unrealized_pnl)} for s in reversed(snapshots)]


@app.post("/api/accounts")
def create_account(payload: AccountCreate, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    if payload.allow_live_trading and not profile_for(db.info.get("owner_id")).allow_live_trading: raise HTTPException(403, "请先启用本用户的实盘交易")
    account = ExchangeAccount(owner_id=db.info.get("owner_id"), name=payload.name, environment=payload.environment, api_key_ciphertext=encrypt(payload.api_key), secret_key_ciphertext=encrypt(payload.secret_key), allow_live_trading=payload.allow_live_trading)
    db.add(account); db.flush(); risk_config(db, account.id); db.commit(); db.refresh(account)
    try: sync_account(db, account)
    except Exception as exc: account.last_sync_error = str(exc); db.commit()
    return account_payload(account)


def account_payload(a):
    return {"id": a.id, "name": a.name, "environment": a.environment, "allow_live_trading": a.allow_live_trading, "active": a.active, "last_sync_at": a.last_sync_at, "last_sync_error": a.last_sync_error}


@app.get("/api/accounts")
def list_accounts(db: Session = Depends(get_db), _: User = Depends(user_guard)):
    return [account_payload(a) for a in db.scalars(select(ExchangeAccount).order_by(ExchangeAccount.id.desc())).all()]


@app.patch("/api/accounts/{account_id}")
def update_account(account_id: int, payload: AccountUpdate, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    account = db.get(ExchangeAccount, account_id)
    if not account: raise HTTPException(404, "账户不存在")
    if payload.api_key is not None or payload.secret_key is not None:
        if db.scalar(select(Position.id).where(Position.account_id == account_id).limit(1)) or db.scalar(select(Order.id).where(Order.account_id == account_id, Order.status.in_(["pending", "unknown", "new", "partially_filled"])).limit(1)):
            raise HTTPException(409, "账户仍有仓位或待确认订单，不能更换密钥")
    if payload.name is not None: account.name = payload.name
    if payload.api_key is not None: account.api_key_ciphertext = encrypt(payload.api_key)
    if payload.secret_key is not None: account.secret_key_ciphertext = encrypt(payload.secret_key)
    if payload.allow_live_trading is not None:
        if payload.allow_live_trading and not profile_for(account.owner_id).allow_live_trading: raise HTTPException(403, "请先启用本用户的实盘交易")
        account.allow_live_trading = payload.allow_live_trading
    if payload.active is False: disable_account(account_id, db, _)
    if payload.active is True: account.active = True
    account.last_sync_error = None
    db.commit(); return account_payload(account)


@app.post("/api/accounts/{account_id}/sync")
def sync(account_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    account = db.get(ExchangeAccount, account_id)
    if not account: raise HTTPException(404, "账户不存在")
    try: return sync_account(db, account)
    except Exception as exc: account.last_sync_error = str(exc); db.commit(); raise HTTPException(502, str(exc)) from exc


@app.post("/api/accounts/{account_id}/validate")
def validate_account(account_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    account = db.get(ExchangeAccount, account_id)
    if not account: raise HTTPException(404, "账户不存在")
    try:
        summary = client_for(account).account() if account.environment != "demo" else {"totalWalletBalance": "10000", "availableBalance": "10000"}
        return {"status": "ok", "totalWalletBalance": summary.get("totalWalletBalance"), "availableBalance": summary.get("availableBalance")}
    except Exception as exc: raise HTTPException(502, str(exc)) from exc


@app.delete("/api/accounts/{account_id}")
def disable_account(account_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    account = db.get(ExchangeAccount, account_id)
    if not account: raise HTTPException(404, "账户不存在")
    if db.scalar(select(Position.id).where(Position.account_id == account.id).limit(1)): raise HTTPException(409, "账户仍有仓位，不能停用")
    if db.scalar(select(Order.id).where(Order.account_id == account.id, Order.status.in_(["pending", "unknown", "new", "partially_filled"])).limit(1)): raise HTTPException(409, "账户仍有待确认订单")
    account.active = False
    for strategy in db.scalars(select(Strategy).where(Strategy.account_id == account.id)).all(): strategy.status = "paused"
    db.commit(); return {"status": "ok"}


@app.get("/api/risk/{account_id}")
def get_risk(account_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    if not db.get(ExchangeAccount, account_id): raise HTTPException(404, "账户不存在")
    risk = risk_config(db, account_id); db.commit(); return {k: getattr(risk, k) for k in ("max_margin_ratio", "max_order_notional", "max_daily_loss", "max_open_positions", "max_leverage", "liquidation_buffer_pct", "trading_halted")}


@app.put("/api/risk/{account_id}")
def update_risk(account_id: int, payload: RiskUpdate, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    if not db.get(ExchangeAccount, account_id): raise HTTPException(404, "账户不存在")
    risk = risk_config(db, account_id)
    for k, v in payload.model_dump().items(): setattr(risk, k, v)
    db.commit(); return {k: getattr(risk, k) for k in payload.model_dump()}


@app.get("/api/positions")
def positions(account_id: int | None = None, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    query = select(Position).where(Position.quantity > 0)
    if account_id: query = query.where(Position.account_id == account_id)
    return [{"id": p.id, "accountId": p.account_id, "symbol": p.symbol, "side": p.side, "positionSide": p.position_side, "quantity": float(p.quantity), "entryPrice": float(p.entry_price), "markPrice": float(p.mark_price), "pnl": float(p.unrealized_pnl), "leverage": p.leverage, "margin": float(p.margin), "liquidationPrice": float(p.liquidation_price), "stopLoss": float(p.stop_loss) if p.stop_loss else None, "takeProfit": float(p.take_profit) if p.take_profit else None, "trailingPct": float(p.trailing_pct) if p.trailing_pct else None} for p in db.scalars(query).all()]


@app.put("/api/positions/{position_id}/protection")
def protection(position_id: int, payload: PositionProtection, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    pos = db.get(Position, position_id)
    if not pos: raise HTTPException(404, "仓位不存在")
    try: set_protection(db, pos, **payload.model_dump())
    except Exception as exc: raise HTTPException(400, str(exc)) from exc
    return {"status": "ok"}


@app.post("/api/positions/{position_id}/close")
def close_position_endpoint(position_id: int, payload: PositionClose, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    existing = db.scalar(select(Order).where(Order.client_order_id == payload.client_order_id))
    pos = db.get(Position, position_id)
    if existing:
        if not existing.reduce_only or (pos and (existing.account_id != pos.account_id or existing.symbol != pos.symbol)): raise HTTPException(409, "请求编号已使用")
        return {"id": existing.id, "status": existing.status, "clientOrderId": existing.client_order_id}
    if not pos: raise HTTPException(404, "仓位不存在")
    try: result = close_position(db, pos, payload.percentage, payload.client_order_id)
    except Exception as exc: raise HTTPException(400, str(exc)) from exc
    return {"id": result.id, "status": result.status, "clientOrderId": result.client_order_id}


@app.post("/api/orders")
def create_order(payload: OrderCreate, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    account = db.get(ExchangeAccount, payload.account_id)
    if not account: raise HTTPException(404, "账户不存在")
    try: result = submit_order(db, account=account, symbol=payload.symbol, side=payload.side, quantity=payload.quantity, mode=payload.mode, client_order_id=payload.client_order_id, reduce_only=payload.reduce_only, position_side=payload.position_side)
    except Exception as exc: raise HTTPException(400, str(exc)) from exc
    return {"id": result.id, "status": result.status, "exchangeOrderId": result.exchange_order_id, "clientOrderId": result.client_order_id, "filledQuantity": float(result.filled_quantity), "price": float(result.price)}


@app.get("/api/orders")
def orders(account_id: int | None = None, limit: int = 100, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    query = select(Order).order_by(Order.id.desc()).limit(min(limit, 500))
    if account_id: query = select(Order).where(Order.account_id == account_id).order_by(Order.id.desc()).limit(min(limit, 500))
    rows = db.scalars(query).all()
    fees = {}
    if rows:
        for fill in db.scalars(select(OrderFill).where(OrderFill.order_id.in_([o.id for o in rows]))).all():
            assets = fees.setdefault(fill.order_id, {})
            assets[fill.commission_asset] = assets.get(fill.commission_asset, Decimal(0)) + fill.commission
    return [{"id": o.id, "accountId": o.account_id, "symbol": o.symbol, "side": o.side, "quantity": float(o.quantity), "filledQuantity": float(o.filled_quantity), "ledgerComplete": o.mode == "demo" or o.reconciled_quantity >= o.filled_quantity, "price": float(o.price) if o.price else None, "realizedPnl": float(o.realized_pnl), "commission": float(o.commission), "commissionAssets": [{"asset": a, "amount": float(v)} for a, v in fees.get(o.id, ({"USDT": o.commission} if o.mode == "demo" else {})).items()], "error": o.error_message, "status": o.status, "mode": o.mode, "clientOrderId": o.client_order_id, "createdAt": o.created_at} for o in rows]


@app.post("/api/strategies")
def create_strategy(payload: StrategyCreate, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    if not db.get(ExchangeAccount, payload.account_id): raise HTTPException(404, "账户不存在")
    strategy = Strategy(account_id=payload.account_id, name=payload.name, symbol=payload.symbol, timeframe=payload.timeframe, strategy_type=payload.strategy_type, config_json=json.dumps({"fast_period": payload.fast_period, "slow_period": payload.slow_period, "quantity": str(payload.quantity), "auto_execute": payload.auto_execute, "position_side": payload.position_side}))
    db.add(strategy); db.commit(); db.refresh(strategy); return {"id": strategy.id, "status": strategy.status}


@app.get("/api/strategies")
def strategies(db: Session = Depends(get_db), _: User = Depends(user_guard)):
    result = []
    for s in db.scalars(select(Strategy).order_by(Strategy.id.desc())).all():
        rows = db.scalars(select(Order).where(Order.strategy_id == s.id, Order.status == "filled")).all()
        total = sum((o.realized_pnl for o in rows), Decimal(0))
        closes = [o for o in rows if o.reduce_only or o.realized_pnl]
        win = sum(1 for o in closes if o.realized_pnl > 0)
        result.append({"id": s.id, "accountId": s.account_id, "name": s.name, "symbol": s.symbol, "timeframe": s.timeframe, "strategyType": s.strategy_type, "config": json.loads(s.config_json), "status": s.status, "lastSignal": s.last_signal, "lastRunAt": s.last_run_at, "realizedPnl": float(total), "filledOrders": len(rows), "winRate": win / len(closes) * 100 if closes else None})
    return result


@app.delete("/api/strategies/{strategy_id}")
def disable_strategy(strategy_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    strategy = db.get(Strategy, strategy_id)
    if not strategy: raise HTTPException(404, "策略不存在")
    with account_locks[strategy.account_id]:
        db.refresh(strategy)
        strategy.status = "paused"; db.commit()
    return {"status": "ok"}


@app.patch("/api/strategies/{strategy_id}")
def toggle_strategy(strategy_id: int, payload: StrategyUpdate, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    strategy = db.get(Strategy, strategy_id)
    if not strategy: raise HTTPException(404, "策略不存在")
    with account_locks[strategy.account_id]:
        db.refresh(strategy)
        if payload.parameters:
            if strategy.status == "running": raise HTTPException(409, "请先暂停策略再修改参数")
            p = payload.parameters
            if p.account_id != strategy.account_id: raise HTTPException(400, "不能更换策略账户")
            strategy.name, strategy.symbol, strategy.timeframe, strategy.strategy_type = p.name, p.symbol, p.timeframe, p.strategy_type
            strategy.config_json = json.dumps({"fast_period": p.fast_period, "slow_period": p.slow_period, "quantity": str(p.quantity), "auto_execute": p.auto_execute, "position_side": p.position_side})
            strategy.last_signal, strategy.last_run_at = None, None
        if payload.status is not None: strategy.status = payload.status
        db.commit(); return {"id": strategy.id, "status": strategy.status}


@app.post("/api/strategies/{strategy_id}/run")
def run_strategy_now(strategy_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    strategy = db.get(Strategy, strategy_id)
    if not strategy: raise HTTPException(404, "策略不存在")
    try: return run_strategy(db, strategy)
    except Exception as exc: raise HTTPException(400, str(exc)) from exc


@app.post("/api/backtests")
def run_backtest(payload: BacktestRequest, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    strategy = db.get(Strategy, payload.strategy_id)
    if not strategy or not strategy.account_id: raise HTTPException(404, "策略不存在")
    try:
        result = backtest(strategy, db.get(ExchangeAccount, strategy.account_id), limit=payload.limit, initial_balance=payload.initial_balance, fee_rate=payload.fee_rate, slippage=payload.slippage)
        run = BacktestRun(strategy_id=strategy.id, config_json=payload.model_dump_json(), result_json=json.dumps(result))
        db.add(run); db.commit(); result["id"] = run.id; return result
    except Exception as exc: raise HTTPException(400, str(exc)) from exc


@app.get("/api/backtests")
def backtest_history(strategy_id: int | None = None, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    query = select(BacktestRun).order_by(BacktestRun.id.desc()).limit(50)
    if strategy_id: query = select(BacktestRun).where(BacktestRun.strategy_id == strategy_id).order_by(BacktestRun.id.desc()).limit(50)
    return [{"id": r.id, "strategyId": r.strategy_id, "createdAt": r.created_at, "result": json.loads(r.result_json)} for r in db.scalars(query).all()]


@app.get("/api/strategies/{strategy_id}/events")
def events(strategy_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    return [{"id": e.id, "signal": e.signal, "price": float(e.price), "message": e.message, "createdAt": e.created_at} for e in db.scalars(select(StrategyEvent).where(StrategyEvent.strategy_id == strategy_id).order_by(StrategyEvent.id.desc()).limit(100)).all()]


@app.get("/api/protection-orders")
def protection_orders(account_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    return [{"id": p.id, "symbol": p.symbol, "positionSide": p.position_side, "kind": p.kind, "status": p.status, "error": p.error_message, "createdAt": p.created_at} for p in db.scalars(select(ProtectionOrder).where(ProtectionOrder.account_id == account_id).order_by(ProtectionOrder.id.desc()).limit(100)).all()]


@app.post("/api/orders/{order_id}/cancel")
def cancel_order(order_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    order = db.get(Order, order_id)
    if not order: raise HTTPException(404, "订单不存在")
    if order.status not in ("new", "partially_filled"): raise HTTPException(409, "当前订单状态不能撤销")
    account = db.get(ExchangeAccount, order.account_id)
    with account_locks[account.id]:
        try: apply_order_result(order, client_for(account).cancel_order(order.symbol, order.client_order_id, order_id=order.exchange_order_id))
        except Exception as exc: raise HTTPException(400, str(exc)) from exc
        db.commit()
    return {"status": order.status}


@app.post("/api/orders/{order_id}/refresh")
def refresh_order(order_id: int, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    order = db.get(Order, order_id)
    if not order: raise HTTPException(404, "订单不存在")
    if order.mode != "demo":
        try: reconcile_one_order(db, order)
        except Exception as exc: raise HTTPException(502, str(exc)) from exc
    return {"status": order.status}


@app.get("/api/platform")
def platform_settings(db: Session = Depends(get_db), user: User = Depends(user_guard)):
    if user.role != "admin": raise HTTPException(403, "无权限")
    profile = profile_for(db.info.get("owner_id"))
    return {"allow_live_trading": profile.allow_live_trading, "proxy_url": profile.proxy_url}


@app.put("/api/platform")
def update_platform(payload: PlatformSettings, db: Session = Depends(get_db), _: User = Depends(user_guard)):
    if settings.ooapi_mode:
        owner_id = db.info["owner_id"]
        profile = db.get(TradingProfile, owner_id)
        if not profile:
            profile = TradingProfile(owner_id=owner_id)
            db.add(profile)
        profile.allow_live_trading, profile.proxy_url = payload.allow_live_trading, payload.proxy_url
        db.commit()
        return {"status": "ok"}
    from dotenv import set_key
    env_path = Path(__file__).resolve().parents[1] / ".env"
    # Tests have a separate environment file and must never rewrite the application's settings.
    if engine.url.database == "quantpilot_test": env_path = env_path.with_name(".env.test")
    with setup_lock:
        set_key(str(env_path), "ALLOW_LIVE_TRADING", str(payload.allow_live_trading).lower())
        set_key(str(env_path), "PROXY_URL", payload.proxy_url)
        settings.allow_live_trading = payload.allow_live_trading
        settings.proxy_url = payload.proxy_url
    return {"status": "ok"}


@app.post("/api/platform/network")
def test_network(db: Session = Depends(get_db), _: User = Depends(user_guard)):
    import httpx
    result = {}
    for name, base in (("live", settings.live_base_url), ("testnet", settings.testnet_base_url)):
        try:
            with httpx.Client(timeout=4, proxy=profile_for(db.info.get("owner_id")).proxy_url or None) as client:
                response = client.get(base + "/fapi/v1/time")
                response.raise_for_status()
                result[name] = {"connected": "serverTime" in response.json()}
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            result[name] = {"connected": False, "error": "币安不接受当前服务器地区的请求（HTTP 451）" if code == 451 else f"币安返回 HTTP {code}"}
        except Exception:
            result[name] = {"connected": False, "error": "无法连接币安，请检查服务网络与代理配置"}
    return result
