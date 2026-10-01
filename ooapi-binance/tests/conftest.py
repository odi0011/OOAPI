import os
from pathlib import Path
import pytest
from dotenv import dotenv_values

test_env = dotenv_values(Path(__file__).resolve().parents[1] / ".env.test")
os.environ.update({k: v for k, v in test_env.items() if v is not None})
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["MARKET_STREAM_ENABLED"] = "false"
from app.db import Base, engine
from app.main import app
from fastapi.testclient import TestClient
from sqlalchemy import text


@pytest.fixture
def client():
    assert engine.url.database == "quantpilot_test", "Tests must never modify application database"
    # Only the explicitly created test database is reset.
    Base.metadata.drop_all(engine)
    with engine.begin() as connection:
        connection.execute(text("DROP TABLE IF EXISTS alembic_version"))
    with TestClient(app) as client:
        yield client


@pytest.fixture
def logged_in(client):
    response = client.post("/api/auth/setup", json={"username": "test-admin", "password": "strong-test-password-123"})
    assert response.status_code == 200, response.text
    client.headers["X-CSRF-Token"] = response.json()["csrfToken"]
    return client


@pytest.fixture
def exchange(monkeypatch):
    from decimal import Decimal
    from app.binance import BinanceClient
    price = {"value": Decimal("100")}
    monkeypatch.setattr(BinanceClient, "ticker_price", lambda self, symbol: price["value"])
    monkeypatch.setattr(BinanceClient, "normalize_quantity", lambda self, symbol, quantity, price, reduce_only: quantity)
    monkeypatch.setattr(BinanceClient, "account", lambda self: {"totalWalletBalance": "10000", "availableBalance": "10000", "totalUnrealizedProfit": "0", "totalInitialMargin": "0"})
    monkeypatch.setattr(BinanceClient, "positions", lambda self: [])
    monkeypatch.setattr(BinanceClient, "symbol_configuration", lambda self, symbol: {"symbol": symbol, "leverage": 1})
    return price
