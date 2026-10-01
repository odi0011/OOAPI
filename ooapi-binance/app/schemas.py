from decimal import Decimal
from typing import Literal
from pydantic import BaseModel, Field, model_validator


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=128)


class UserCreate(Login):
    role: Literal["admin", "viewer"] = "viewer"


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=128)


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    environment: Literal["demo", "testnet", "live"] = "demo"
    api_key: str = Field(default="", max_length=256)
    secret_key: str = Field(default="", max_length=256)
    allow_live_trading: bool = False

    @model_validator(mode="after")
    def keys(self):
        if self.environment != "demo" and (len(self.api_key.strip()) < 8 or len(self.secret_key.strip()) < 8):
            raise ValueError("请输入 API Key 和 Secret Key")
        return self


class AccountUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    api_key: str | None = Field(default=None, min_length=8, max_length=256)
    secret_key: str | None = Field(default=None, min_length=8, max_length=256)
    allow_live_trading: bool | None = None
    active: bool | None = None


class OrderCreate(BaseModel):
    account_id: int
    symbol: str = Field(pattern=r"^[A-Z0-9]{5,20}$")
    side: Literal["BUY", "SELL"]
    quantity: Decimal = Field(gt=0, max_digits=24, decimal_places=8)
    reduce_only: bool = False
    position_side: Literal["BOTH", "LONG", "SHORT"] = "BOTH"
    mode: Literal["demo", "testnet", "live"]
    client_order_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,36}$")


class StrategyCreate(BaseModel):
    account_id: int
    name: str = Field(min_length=1, max_length=80)
    symbol: str = Field(pattern=r"^[A-Z0-9]{5,20}$")
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"] = "15m"
    strategy_type: Literal["moving_average", "rsi"] = "moving_average"
    fast_period: int = Field(default=10, ge=2, le=100)
    slow_period: int = Field(default=30, ge=3, le=200)
    quantity: Decimal = Field(default=Decimal("0.001"), gt=0, max_digits=24, decimal_places=8)
    auto_execute: bool = False
    position_side: Literal["BOTH", "LONG", "SHORT"] = "BOTH"

    @model_validator(mode="after")
    def periods(self):
        if self.strategy_type == "moving_average" and self.fast_period >= self.slow_period:
            raise ValueError("快周期必须小于慢周期")
        return self


class StrategyToggle(BaseModel):
    status: Literal["running", "paused"]


class StrategyUpdate(BaseModel):
    status: Literal["running", "paused"] | None = None
    parameters: StrategyCreate | None = None


class RiskUpdate(BaseModel):
    max_margin_ratio: Decimal = Field(default=Decimal("0.35"), gt=0, le=1)
    max_order_notional: Decimal = Field(default=1000, gt=0)
    max_daily_loss: Decimal = Field(default=500, gt=0)
    max_open_positions: int = Field(default=8, ge=1, le=100)
    max_leverage: int = Field(default=5, ge=1, le=125)
    liquidation_buffer_pct: Decimal = Field(default=Decimal("0.05"), ge=0, le=Decimal("0.5"))
    trading_halted: bool = False


class PositionProtection(BaseModel):
    stop_loss: Decimal | None = Field(default=None, gt=0)
    take_profit: Decimal | None = Field(default=None, gt=0)
    trailing_pct: Decimal | None = Field(default=None, gt=0, le=Decimal("0.5"))


class PositionClose(BaseModel):
    percentage: Decimal = Field(default=1, gt=0, le=1)
    client_order_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,36}$")


class PlatformSettings(BaseModel):
    allow_live_trading: bool = False
    proxy_url: str = Field(default="", max_length=300, pattern=r"^(|https?://[^\s]+)$")


class BacktestRequest(BaseModel):
    strategy_id: int
    limit: int = Field(default=500, ge=100, le=1500)
    initial_balance: Decimal = Field(default=Decimal("10000"), gt=0)
    fee_rate: Decimal = Field(default=Decimal("0.0005"), ge=0, le=Decimal("0.01"))
    slippage: Decimal = Field(default=Decimal("0.0002"), ge=0, le=Decimal("0.01"))
