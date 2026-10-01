from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class ExchangeAccount(Base):
    __tablename__ = "exchange_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    # OOAPI 用户 ID；与网关用户库物理分开，不能关联交易引擎原来的 users 表。
    owner_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(80), default="Binance account")
    environment: Mapped[str] = mapped_column(String(20), default="testnet")
    api_key_ciphertext: Mapped[str] = mapped_column(Text)
    secret_key_ciphertext: Mapped[str] = mapped_column(Text)
    allow_live_trading: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(20), default="admin")


class TradingProfile(Base):
    __tablename__ = "trading_profiles"
    owner_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    allow_live_trading: Mapped[bool] = mapped_column(Boolean, default=False)
    proxy_url: Mapped[str] = mapped_column(String(300), default="")


class LoginSession(Base):
    __tablename__ = "login_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class AccountSnapshot(Base):
    __tablename__ = "account_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("exchange_accounts.id"), index=True)
    total_wallet_balance: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    available_balance: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    total_unrealized_pnl: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    margin_used: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    captured_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("exchange_accounts.id"), index=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    side: Mapped[str] = mapped_column(String(10))
    position_side: Mapped[str] = mapped_column(String(10), default="BOTH")
    quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    entry_price: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    mark_price: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    unrealized_pnl: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    leverage: Mapped[int] = mapped_column(Integer, default=1)
    margin: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    liquidation_price: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    stop_loss: Mapped[Decimal | None] = mapped_column(Numeric(24, 8), nullable=True)
    take_profit: Mapped[Decimal | None] = mapped_column(Numeric(24, 8), nullable=True)
    trailing_pct: Mapped[Decimal | None] = mapped_column(Numeric(8, 5), nullable=True)
    peak_price: Mapped[Decimal | None] = mapped_column(Numeric(24, 8), nullable=True)
    __table_args__ = (UniqueConstraint("account_id", "symbol", "position_side"),)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class RiskConfig(Base):
    __tablename__ = "risk_configs"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("exchange_accounts.id"), unique=True, index=True)
    max_margin_ratio: Mapped[Decimal] = mapped_column(Numeric(8, 5), default=Decimal("0.35"))
    max_order_notional: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=Decimal("1000"))
    max_daily_loss: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=Decimal("500"))
    max_open_positions: Mapped[int] = mapped_column(Integer, default=8)
    max_leverage: Mapped[int] = mapped_column(Integer, default=5)
    liquidation_buffer_pct: Mapped[Decimal] = mapped_column(Numeric(8, 5), default=Decimal("0.05"))
    trading_halted: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class Strategy(Base):
    __tablename__ = "strategies"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("exchange_accounts.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    symbol: Mapped[str] = mapped_column(String(20))
    timeframe: Mapped[str] = mapped_column(String(10), default="15m")
    status: Mapped[str] = mapped_column(String(20), default="paused")
    strategy_type: Mapped[str] = mapped_column(String(40), default="moving_average")
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    last_signal: Mapped[str | None] = mapped_column(String(10), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("exchange_accounts.id"), nullable=True)
    strategy_id: Mapped[int | None] = mapped_column(ForeignKey("strategies.id"), nullable=True)
    symbol: Mapped[str] = mapped_column(String(20))
    side: Mapped[str] = mapped_column(String(10))
    quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8))
    price: Mapped[Decimal | None] = mapped_column(Numeric(24, 8), nullable=True)
    order_type: Mapped[str] = mapped_column(String(20), default="MARKET")
    reduce_only: Mapped[bool] = mapped_column(Boolean, default=False)
    position_side: Mapped[str] = mapped_column(String(10), default="BOTH")
    client_order_id: Mapped[str] = mapped_column(String(36), unique=True)
    filled_quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    reconciled_quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0, server_default="0")
    realized_pnl: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    commission: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0)
    mode: Mapped[str] = mapped_column(String(20), default="demo")
    status: Mapped[str] = mapped_column(String(20), default="simulated")
    exchange_order_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class StrategyEvent(Base):
    __tablename__ = "strategy_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    strategy_id: Mapped[int] = mapped_column(ForeignKey("strategies.id"), index=True)
    signal: Mapped[str] = mapped_column(String(10))
    price: Mapped[Decimal] = mapped_column(Numeric(24, 8))
    message: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class OrderFill(Base):
    __tablename__ = "order_fills"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    trade_id: Mapped[str] = mapped_column(String(80))
    quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=0, server_default="0")
    realized_pnl: Mapped[Decimal] = mapped_column(Numeric(24, 8))
    commission: Mapped[Decimal] = mapped_column(Numeric(24, 8))
    commission_asset: Mapped[str] = mapped_column(String(20))
    __table_args__ = (UniqueConstraint("order_id", "trade_id"),)


class BacktestRun(Base):
    __tablename__ = "backtest_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    strategy_id: Mapped[int] = mapped_column(ForeignKey("strategies.id"), index=True)
    config_json: Mapped[str] = mapped_column(Text)
    result_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ProtectionOrder(Base):
    __tablename__ = "protection_orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("exchange_accounts.id"), index=True)
    symbol: Mapped[str] = mapped_column(String(20))
    position_side: Mapped[str] = mapped_column(String(10))
    kind: Mapped[str] = mapped_column(String(30))
    client_algo_id: Mapped[str] = mapped_column(String(36), unique=True)
    algo_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    executed_order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
