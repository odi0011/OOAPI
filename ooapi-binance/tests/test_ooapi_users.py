import secrets
import uuid
import pytest
from app.config import settings


@pytest.fixture
def native(client, monkeypatch, tmp_path, exchange):
    key = secrets.token_urlsafe(48)
    key_file = tmp_path / "bridge.key"
    key_file.write_text(key)
    monkeypatch.setattr(settings, "ooapi_mode", True)
    monkeypatch.setattr(settings, "ooapi_bridge_key_file", str(key_file))
    def call(user_id, method, path, **kwargs):
        return client.request(method, path, headers={"X-OOAPI-Bridge": key, "X-OOAPI-User": str(user_id)}, **kwargs)
    return call


def account(native, owner, name):
    response = native(owner, "POST", "/api/accounts", json={"name": name, "environment": "demo"})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_native_auth_has_no_cookie_or_identity_fallback(client, native):
    assert client.get("/api/accounts").status_code == 401
    assert native(0, "GET", "/api/accounts").status_code == 401
    assert client.post("/api/auth/setup", json={"username": "probe", "password": "test-only-placeholder"}).status_code == 404
    assert client.get("/api/users").status_code == 404


def test_accounts_and_settings_are_owned_by_each_user(native):
    first, second = account(native, 11, "first"), account(native, 22, "second")
    assert [row["id"] for row in native(11, "GET", "/api/accounts").json()] == [first]
    assert [row["id"] for row in native(22, "GET", "/api/accounts").json()] == [second]
    for method, suffix, payload in [
        ("PATCH", "", {"name": "stolen"}), ("POST", "/sync", {}), ("POST", "/validate", {}), ("DELETE", "", {}),
    ]:
        assert native(22, method, f"/api/accounts/{first}{suffix}", json=payload).status_code == 404
    assert native(22, "GET", f"/api/risk/{first}").status_code == 404
    assert native(22, "GET", f"/api/equity?account_id={first}").json() == []
    assert native(22, "GET", f"/api/dashboard?account_id={first}").json()["totalEquity"] == 0
    assert native(11, "PUT", "/api/platform", json={"proxy_url": "http://127.0.0.1:7892", "allow_live_trading": True}).status_code == 200
    assert native(11, "GET", "/api/platform").json()["allow_live_trading"] is True
    assert native(22, "GET", "/api/platform").json() == {"proxy_url": "", "allow_live_trading": False}


def test_position_order_and_strategy_idor_is_blocked(native):
    first, second = account(native, 11, "first"), account(native, 22, "second")
    payload = {"account_id": first, "symbol": "BTCUSDT", "side": "BUY", "quantity": "1", "mode": "demo", "client_order_id": str(uuid.uuid4())}
    assert native(22, "POST", "/api/orders", json=payload).status_code == 404
    response = native(11, "POST", "/api/orders", json=payload)
    assert response.status_code == 200, response.text
    order_id = response.json()["id"]
    position_id = native(11, "GET", "/api/positions").json()[0]["id"]
    assert native(22, "GET", "/api/positions").json() == []
    assert native(22, "GET", f"/api/orders?account_id={first}").json() == []
    assert native(22, "POST", f"/api/orders/{order_id}/refresh").status_code == 404
    assert native(22, "POST", f"/api/orders/{order_id}/cancel").status_code == 404
    assert native(22, "PUT", f"/api/positions/{position_id}/protection", json={"stop_loss": "90"}).status_code == 404
    assert native(22, "POST", f"/api/positions/{position_id}/close", json={"percentage": 1, "client_order_id": str(uuid.uuid4())}).status_code == 404
    strategy = {"account_id": first, "name": "private", "symbol": "BTCUSDT"}
    assert native(22, "POST", "/api/strategies", json=strategy).status_code == 404
    sid = native(11, "POST", "/api/strategies", json=strategy).json()["id"]
    assert native(22, "GET", "/api/strategies").json() == []
    assert native(22, "PATCH", f"/api/strategies/{sid}", json={"status": "running"}).status_code == 404
    assert native(22, "POST", f"/api/strategies/{sid}/run").status_code == 404
    assert native(22, "POST", "/api/backtests", json={"strategy_id": sid}).status_code == 404
    assert native(22, "GET", f"/api/strategies/{sid}/events").json() == []
    assert native(22, "GET", f"/api/protection-orders?account_id={first}").json() == []
    assert native(11, "GET", "/api/positions").json()[0]["quantity"] == 1
    assert len(native(11, "GET", "/api/orders").json()) == 1


def test_keys_and_unclaimed_legacy_accounts_never_leak(native):
    from app.db import SessionLocal
    from app.models import ExchangeAccount
    from app.security import encrypt
    with SessionLocal() as db:
        db.add(ExchangeAccount(name="unclaimed", environment="demo", api_key_ciphertext=encrypt("test-key-value"), secret_key_ciphertext=encrypt("test-secret-value")))
        db.commit()
    assert native(11, "GET", "/api/accounts").json() == []
    assert native(22, "GET", "/api/accounts").json() == []
    account(native, 11, "owned")
    row = native(11, "GET", "/api/accounts").json()[0]
    assert "api_key" not in row and "secret_key" not in row and "api_key_ciphertext" not in row


def test_connection_failure_keeps_http_reason_without_request_details(native, monkeypatch):
    import httpx
    class RestrictedClient:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, url): return httpx.Response(451, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "Client", RestrictedClient)
    response = native(11, "POST", "/api/platform/network")
    assert response.status_code == 200
    for result in response.json().values():
        assert result["connected"] is False and "HTTP 451" in result["error"]


def test_exchange_errors_cannot_echo_api_credentials(monkeypatch):
    import httpx
    from app.binance import BinanceClient, BinanceError
    key, secret = "test-only-api-key", "test-only-api-secret"
    class RejectedClient:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def request(self, method, url, **kwargs):
            return httpx.Response(400, json={"msg": f"Rejected {key} and {secret}"}, request=httpx.Request(method, url))
    monkeypatch.setattr(httpx, "Client", RejectedClient)
    with pytest.raises(BinanceError) as captured:
        BinanceClient(key, secret).account()
    assert key not in str(captured.value) and secret not in str(captured.value)
    assert "隐藏凭据" in str(captured.value)
