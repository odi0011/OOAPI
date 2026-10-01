import os
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "mysql+pymysql://quantpilot:quantpilot@127.0.0.1:3307/quantpilot"
    app_env: str = "local"
    secret_key: str = "local-only-change-me"
    binance_testnet: bool = True
    allow_live_trading: bool = False
    scheduler_enabled: bool = True
    sync_interval_seconds: int = 15
    strategy_interval_seconds: int = 60
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    session_hours: int = 12
    market_stream_enabled: bool = True
    market_symbols: str = "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT"
    testnet_base_url: str = "https://demo-fapi.binance.com"
    live_base_url: str = "https://fapi.binance.com"
    proxy_url: str = ""
    ooapi_mode: bool = False
    ooapi_bridge_key_file: str = ""
    ooapi_legacy_owner_id: int = 0

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False, extra="ignore")


settings = Settings(_env_file=os.getenv("OD_BINANCE_ENV_FILE", ".env"))


def cors_origin_list() -> list[str]:
    return [item.strip() for item in settings.cors_origins.split(",") if item.strip()]
