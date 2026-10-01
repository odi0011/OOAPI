from decimal import Decimal
from app.binance import BinanceClient, BinanceError
from app.db import SessionLocal
from app.models import Order
from app.services import signal_from_closes


def order(client, **overrides):
    payload = {"account_id": 1, "symbol": "BTCUSDT", "side": "BUY", "quantity": "1", "mode": "demo", "client_order_id": "order-a"}
    payload.update(overrides)
    return client.post("/api/orders", json=payload)


def test_auth_required_and_setup_once(client):
    assert client.get("/api/accounts").status_code == 401
    assert client.post("/api/auth/setup", json={"username": "admin", "password": "good-test-password"}).status_code == 200
    assert client.post("/api/auth/setup", json={"username": "new-admin", "password": "good-test-password"}).status_code == 409


def test_csrf_enforced(logged_in):
    del logged_in.headers["X-CSRF-Token"]
    assert logged_in.post("/api/accounts", json={"name": "Demo", "environment": "demo"}).status_code == 403


def test_account_keys_not_exposed(logged_in, exchange):
    response = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"})
    assert response.status_code == 200
    text = logged_in.get("/api/accounts").text
    assert "private-secret" not in text and "test-key" not in text and "ciphertext" not in text


def test_order_idempotency_and_paper_fill(logged_in, exchange):
    first = order(logged_in); second = order(logged_in)
    assert first.status_code == 200, first.text
    assert second.json()["id"] == first.json()["id"]
    assert len(logged_in.get("/api/orders").json()) == 1
    positions = logged_in.get("/api/positions").json()
    assert len(positions) == 1 and positions[0]["quantity"] == 1
    assert first.json()["status"] == "filled"
    assert logged_in.get("/api/dashboard?account_id=1").json()["totalEquity"] == 9999.95


def test_reused_order_id_with_different_quantity_rejected(logged_in, exchange):
    assert order(logged_in).status_code == 200
    assert order(logged_in, quantity="2").status_code == 400


def test_mode_cannot_select_real_account_accidentally(logged_in, exchange):
    assert order(logged_in, mode="live").status_code == 400
    assert order(logged_in, mode="testnet").status_code == 400


def test_notional_and_margin_limits(logged_in, exchange):
    assert order(logged_in, quantity="11").status_code == 400
    risk = logged_in.get("/api/risk/1").json()
    risk.update(max_order_notional="10000", max_margin_ratio="0.001")
    assert logged_in.put("/api/risk/1", json=risk).status_code == 200
    assert order(logged_in).status_code == 400


def test_halt_allows_reduce_only(logged_in, exchange):
    assert order(logged_in).status_code == 200
    risk = logged_in.get("/api/risk/1").json(); risk["trading_halted"] = True
    assert logged_in.put("/api/risk/1", json=risk).status_code == 200
    assert order(logged_in, client_order_id="open-b").status_code == 400
    assert order(logged_in, side="SELL", reduce_only=True, client_order_id="close-a").status_code == 200
    assert not logged_in.get("/api/positions").json()


def test_close_partial_and_profit_accounting(logged_in, exchange):
    assert order(logged_in, quantity="2").status_code == 200
    exchange["value"] = Decimal("110")
    result = order(logged_in, side="SELL", quantity="1", reduce_only=True, client_order_id="close-half")
    assert result.status_code == 200, result.text
    positions = logged_in.get("/api/positions").json()
    assert positions[0]["quantity"] == 1 and positions[0]["pnl"] == 10
    equity = logged_in.get("/api/dashboard?account_id=1").json()["totalEquity"]
    assert abs(equity - 10019.845) < 0.00001


def test_reduce_cannot_open_or_oversize(logged_in, exchange):
    assert order(logged_in, reduce_only=True).status_code == 400
    assert order(logged_in).status_code == 200
    assert order(logged_in, side="SELL", quantity="2", reduce_only=True, client_order_id="oversize").status_code == 400


def test_daily_loss_blocks_opening(logged_in, exchange):
    assert order(logged_in, quantity="10").status_code == 200
    exchange["value"] = Decimal("40")
    assert logged_in.post("/api/accounts/1/sync").status_code == 200
    assert order(logged_in, client_order_id="after-loss").status_code == 400


def test_timeout_reserves_unknown_order_and_never_reposts(logged_in, exchange, monkeypatch):
    response = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"})
    account_id = response.json()["id"]
    calls = []
    def timed_out(self, **kwargs):
        calls.append(kwargs)
        raise BinanceError("Execution uncertain", uncertain=True)
    monkeypatch.setattr(BinanceClient, "order", timed_out)
    first = order(logged_in, account_id=account_id, mode="testnet")
    assert first.status_code == 200 and first.json()["status"] == "unknown", first.text
    second = order(logged_in, account_id=account_id, mode="testnet")
    assert second.json()["id"] == first.json()["id"] and len(calls) == 1


def test_strategy_period_validation(logged_in):
    response = logged_in.post("/api/strategies", json={"account_id": 1, "name": "bad", "symbol": "BTCUSDT", "fast_period": 40, "slow_period": 20})
    assert response.status_code == 422


def test_rsi_flat_prices_hold():
    assert signal_from_closes([100] * 20, {"fast_period": 14}, "rsi") == "HOLD"


def test_ma_crosses_only_use_known_closes():
    cfg = {"fast_period": 2, "slow_period": 3}
    assert signal_from_closes([3, 2, 1, 5], cfg, "moving_average") == "BUY"
    assert signal_from_closes([1, 2, 3, 0], cfg, "moving_average") == "SELL"


def test_quantity_precision_and_minimum(monkeypatch):
    client = BinanceClient()
    monkeypatch.setattr(client, "exchange_info", lambda: {"symbols": [{"symbol": "BTCUSDT", "status": "TRADING", "filters": [{"filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001", "maxQty": "100"}, {"filterType": "MIN_NOTIONAL", "notional": "5"}]}]})
    assert client.normalize_quantity("BTCUSDT", Decimal("0.01"), Decimal("1000"), reduce_only=False) == Decimal("0.01")
    import pytest
    with pytest.raises(ValueError): client.normalize_quantity("BTCUSDT", Decimal("0.0011"), Decimal("1000"), reduce_only=False)
    with pytest.raises(ValueError): client.normalize_quantity("BTCUSDT", Decimal("0.001"), Decimal("1000"), reduce_only=False)


def test_strategy_run_once_per_candle(logged_in, exchange, monkeypatch):
    candles = [[i * 1000, "100", "101", "99", str(100 + i), "1", (i + 1) * 1000] for i in range(100)]
    monkeypatch.setattr(BinanceClient, "klines", lambda self, *args: candles)
    response = logged_in.post("/api/strategies", json={"account_id": 1, "name": "MA", "symbol": "BTCUSDT"})
    strategy_id = response.json()["id"]
    assert logged_in.post(f"/api/strategies/{strategy_id}/run").status_code == 200
    assert logged_in.post(f"/api/strategies/{strategy_id}/run").json()["skipped"]


def test_backtest_no_signal_same_bar_fill(logged_in, exchange, monkeypatch):
    candles = [[i * 1000, "100", "110", "90", str([100, 95, 90, 120, 125, 80][i % 6]), "1", (i + 1) * 1000] for i in range(120)]
    monkeypatch.setattr(BinanceClient, "klines", lambda self, *args: candles)
    strategy = logged_in.post("/api/strategies", json={"account_id": 1, "name": "MA", "symbol": "BTCUSDT", "fast_period": 2, "slow_period": 3}).json()
    response = logged_in.post("/api/backtests", json={"strategy_id": strategy["id"], "limit": 120})
    assert response.status_code == 200, response.text
    result = response.json(); assert len(result["curve"]) == 119 and result["tradeCount"] > 0
    assert result["trades"][0]["time"] >= 5000  # Crossover on bar 3 can only execute starting bar 4, exit later.


def test_partial_close_endpoint_idempotent(logged_in, exchange):
    assert order(logged_in, quantity="2").status_code == 200
    pos_id = logged_in.get("/api/positions").json()[0]["id"]
    payload = {"percentage": "0.5", "client_order_id": "partial-endpoint"}
    first = logged_in.post(f"/api/positions/{pos_id}/close", json=payload)
    second = logged_in.post(f"/api/positions/{pos_id}/close", json=payload)
    assert first.status_code == 200 and second.json()["id"] == first.json()["id"]
    assert logged_in.get("/api/positions").json()[0]["quantity"] == 1
    payload = {"percentage": "1", "client_order_id": "full-endpoint"}
    first = logged_in.post(f"/api/positions/{pos_id}/close", json=payload)
    assert not logged_in.get("/api/positions").json()
    assert logged_in.post(f"/api/positions/{pos_id}/close", json=payload).json()["id"] == first.json()["id"]


def test_viewer_can_read_but_cannot_trade(logged_in):
    from fastapi.testclient import TestClient
    from app.main import app
    assert logged_in.post("/api/users", json={"username": "reader", "password": "reader-password-123", "role": "viewer"}).status_code == 200
    with TestClient(app) as viewer:
        response = viewer.post("/api/auth/login", json={"username": "reader", "password": "reader-password-123"})
        viewer.headers["X-CSRF-Token"] = response.json()["csrfToken"]
        assert viewer.get("/api/positions").status_code == 200
        assert order(viewer).status_code == 403
        assert viewer.put("/api/platform", json={}).status_code == 403
        assert viewer.post("/api/auth/logout").status_code == 200


def test_password_change_expires_old_sessions(logged_in):
    response = logged_in.post("/api/auth/password", json={"current_password": "strong-test-password-123", "new_password": "updated-password-123"})
    assert response.status_code == 200
    assert logged_in.get("/api/auth/me").status_code == 401
    assert logged_in.post("/api/auth/login", json={"username": "test-admin", "password": "updated-password-123"}).status_code == 200


def test_fills_are_deduplicated(logged_in, exchange):
    from app.services import apply_fill
    assert order(logged_in).status_code == 200
    with SessionLocal() as db:
        recorded = db.get(Order, 1)
        for _ in range(2):
            apply_fill(db, recorded, trade_id="trade-1", realized_pnl=Decimal("5"), commission=Decimal("0.1"), commission_asset="USDT")
            db.commit()
        assert recorded.realized_pnl == Decimal("5") and recorded.commission == Decimal("0.15")


def test_exchange_leverage_checked_before_first_order(logged_in, exchange, monkeypatch):
    monkeypatch.setattr(BinanceClient, "symbol_configuration", lambda self, symbol: {"symbol": symbol, "leverage": 20})
    account_id = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"}).json()["id"]
    response = order(logged_in, account_id=account_id, mode="testnet")
    assert response.status_code == 400 and "杠杆" in response.json()["detail"]
    assert not logged_in.get("/api/orders").json()


def test_native_protection_uses_close_all_without_quantity(monkeypatch):
    calls = []
    def request(self, method, path, params=None, **kwargs):
        calls.append((method, path, params))
        return {"serverTime": 1} if path.endswith("/time") else {"algoId": 1}
    monkeypatch.setattr(BinanceClient, "request", request)
    BinanceClient().protection_order(symbol="BTCUSDT", side="SELL", position_side="LONG", kind="STOP_MARKET", trigger_price=Decimal("95"), client_algo_id="stop-a")
    payload = calls[-1][2]
    assert calls[-1][1] == "/fapi/v1/algoOrder"
    assert payload["closePosition"] == "true" and payload["positionSide"] == "LONG"
    assert "quantity" not in payload and "reduceOnly" not in payload


def test_backtest_history_persists_results(logged_in, exchange, monkeypatch):
    monkeypatch.setattr(BinanceClient, "klines", lambda self, *args: [[i * 1000, "100", "101", "99", str(100 + i % 5), "1", (i + 1) * 1000] for i in range(100)])
    strategy_id = logged_in.post("/api/strategies", json={"account_id": 1, "name": "history", "symbol": "BTCUSDT"}).json()["id"]
    first = logged_in.post("/api/backtests", json={"strategy_id": strategy_id}).json()
    history = logged_in.get(f"/api/backtests?strategy_id={strategy_id}").json()
    assert history[0]["id"] == first["id"] and history[0]["result"]["curve"] == first["curve"]


def test_strategy_parameters_require_pause(logged_in):
    p = {"account_id": 1, "name": "parameters", "symbol": "BTCUSDT"}
    strategy_id = logged_in.post("/api/strategies", json=p).json()["id"]
    assert logged_in.patch(f"/api/strategies/{strategy_id}", json={"status": "running"}).status_code == 200
    p["quantity"] = "0.01"
    assert logged_in.patch(f"/api/strategies/{strategy_id}", json={"parameters": p}).status_code == 409
    logged_in.patch(f"/api/strategies/{strategy_id}", json={"status": "paused"})
    assert logged_in.patch(f"/api/strategies/{strategy_id}", json={"parameters": p}).status_code == 200


def test_canceled_partial_order_keeps_reconciling_fills(logged_in, exchange, monkeypatch):
    from app.scheduler import reconcile_orders
    from app.models import OrderFill
    from sqlalchemy import select
    account_id = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"}).json()["id"]
    with SessionLocal() as db:
        pending = Order(account_id=account_id, symbol="BTCUSDT", side="SELL", quantity=2, filled_quantity=1, price=110, mode="testnet", status="canceled", client_order_id="partial-cancel", exchange_order_id="777")
        db.add(pending); db.commit(); order_id = pending.id
    monkeypatch.setattr(BinanceClient, "query_order_by_id", lambda *args: {"orderId": 777, "status": "CANCELED", "executedQty": "1", "avgPrice": "110"})
    monkeypatch.setattr(BinanceClient, "user_trades", lambda *args: [{"id": 55, "qty": "1", "realizedPnl": "10", "commission": "0.055", "commissionAsset": "USDT"}])
    reconcile_orders(); reconcile_orders()
    with SessionLocal() as db:
        result = db.get(Order, order_id)
        assert result.reconciled_quantity == 1 and result.status == "canceled"
        assert result.realized_pnl == 10 and result.commission == Decimal("0.055")
        assert len(db.scalars(select(OrderFill)).all()) == 1


def test_native_execution_link_and_stream_rest_deduplication(logged_in, exchange, monkeypatch):
    from app.scheduler import reconcile_orders
    from app.streams import process_user_message
    from app.models import ProtectionOrder, OrderFill
    from sqlalchemy import select
    account_id = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"}).json()["id"]
    with SessionLocal() as db:
        native = ProtectionOrder(account_id=account_id, symbol="BTCUSDT", position_side="LONG", kind="STOP_MARKET", client_algo_id="native-stop", status="new")
        db.add(native); db.commit(); native_id = native.id
    event = {"e": "ORDER_TRADE_UPDATE", "o": {"c": "autoclose-native", "i": 888, "s": "BTCUSDT", "S": "SELL", "ps": "LONG", "q": "1", "X": "FILLED", "x": "TRADE", "z": "1", "l": "1", "ap": "95", "t": 56, "rp": "-5", "n": "0.0475", "N": "USDT", "cp": True}}
    process_user_message(account_id, event)
    process_user_message(account_id, event)
    monkeypatch.setattr(BinanceClient, "query_protection", lambda *args: {"algoId": 99, "algoStatus": "FINISHED", "actualOrderId": "888"})
    monkeypatch.setattr(BinanceClient, "query_order_by_id", lambda *args: {"orderId": 888, "symbol": "BTCUSDT", "side": "SELL", "positionSide": "LONG", "origQty": "1", "executedQty": "1", "avgPrice": "95", "status": "FILLED", "closePosition": True})
    monkeypatch.setattr(BinanceClient, "user_trades", lambda *args: [{"id": 56, "qty": "1", "realizedPnl": "-5", "commission": "0.0475", "commissionAsset": "USDT"}])
    reconcile_orders(); reconcile_orders()
    with SessionLocal() as db:
        orders = db.scalars(select(Order)).all()
        assert len(orders) == 1
        result = orders[0]
        assert result.reduce_only and result.reconciled_quantity == 1
        assert result.realized_pnl == -5 and result.commission == Decimal("0.0475")
        assert db.get(ProtectionOrder, native_id).executed_order_id == result.id
        assert len(db.scalars(select(OrderFill)).all()) == 1


def test_native_execution_recovered_without_stream(logged_in, exchange, monkeypatch):
    from app.scheduler import reconcile_orders
    from app.streams import process_user_message
    from app.models import ProtectionOrder
    from sqlalchemy import select
    account_id = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"}).json()["id"]
    with SessionLocal() as db:
        db.add(ProtectionOrder(account_id=account_id, symbol="BTCUSDT", position_side="BOTH", kind="TAKE_PROFIT_MARKET", client_algo_id="offline-take", status="finished")); db.commit()
    monkeypatch.setattr(BinanceClient, "query_protection", lambda *args: {"algoId": 100, "algoStatus": "FINISHED", "actualOrderId": "889"})
    monkeypatch.setattr(BinanceClient, "query_order_by_id", lambda *args: {"orderId": 889, "symbol": "BTCUSDT", "side": "SELL", "origQty": "0", "executedQty": "1", "avgPrice": "110", "status": "FILLED", "closePosition": True})
    monkeypatch.setattr(BinanceClient, "user_trades", lambda *args: [{"id": 57, "qty": "1", "realizedPnl": "10", "commission": "0.055", "commissionAsset": "USDT"}])
    reconcile_orders()
    process_user_message(account_id, {"e": "ORDER_TRADE_UPDATE", "o": {"c": "autoclose-offline", "i": 889, "s": "BTCUSDT", "S": "SELL", "q": "1", "X": "FILLED", "x": "TRADE", "z": "1", "l": "1", "ap": "110", "t": 57, "rp": "10", "n": "0.055", "N": "USDT", "cp": True}})
    with SessionLocal() as db:
        result = db.scalar(select(Order))
        assert result.quantity == 1 and result.reconciled_quantity == 1 and result.realized_pnl == 10
        assert result.commission == Decimal("0.055") and len(db.scalars(select(Order)).all()) == 1


def test_duplicate_fills_in_one_transaction_and_old_order_event(logged_in, exchange):
    from app.services import apply_fill, apply_order_result
    assert order(logged_in).status_code == 200
    with SessionLocal() as db:
        result = db.get(Order, 1)
        for _ in range(2):
            apply_fill(db, result, trade_id="same-trade", realized_pnl=Decimal("5"), commission=Decimal("0.1"), commission_asset="USDT", quantity=Decimal("1"))
        apply_order_result(result, {"orderId": 1, "status": "NEW", "executedQty": "0", "avgPrice": "200"})
        db.commit()
        assert result.status == "filled" and result.price == 100 and result.filled_quantity == 1
        assert result.realized_pnl == 5 and result.commission == Decimal("0.15")


def test_malformed_exchange_response_retains_unknown_order(logged_in, exchange, monkeypatch):
    account_id = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"}).json()["id"]
    calls = []
    def malformed(self, **kwargs):
        calls.append(kwargs)
        return {}
    monkeypatch.setattr(BinanceClient, "order", malformed)
    assert order(logged_in, account_id=account_id, mode="testnet").status_code == 400
    second = order(logged_in, account_id=account_id, mode="testnet")
    assert second.json()["status"] == "unknown" and len(calls) == 1


def test_reverse_position_clears_previous_protection(logged_in, exchange):
    assert order(logged_in).status_code == 200
    pos_id = logged_in.get("/api/positions").json()[0]["id"]
    assert logged_in.put(f"/api/positions/{pos_id}/protection", json={"stop_loss": "90", "take_profit": "110", "trailing_pct": "0.02"}).status_code == 200
    assert order(logged_in, side="SELL", quantity="2", client_order_id="reverse-paper").status_code == 200
    position = logged_in.get("/api/positions").json()[0]
    assert position["side"] == "SHORT" and position["quantity"] == 1
    assert position["stopLoss"] is None and position["takeProfit"] is None and position["trailingPct"] is None


def test_cancel_imported_order_uses_exchange_identifier(logged_in, exchange, monkeypatch):
    from app.streams import process_user_message
    account_id = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"}).json()["id"]
    process_user_message(account_id, {"e": "ORDER_TRADE_UPDATE", "o": {"c": "external-123", "i": 900, "s": "BTCUSDT", "S": "BUY", "q": "2", "X": "PARTIALLY_FILLED", "x": "TRADE", "z": "1", "l": "1", "ap": "100", "t": 60, "rp": "0", "n": "0.05", "N": "USDT"}})
    row = logged_in.get("/api/orders").json()[0]
    calls = []
    def cancel(self, method, path, params=None, **kwargs):
        calls.append((method, path, params))
        return {"orderId": 900, "status": "CANCELED", "executedQty": "1", "avgPrice": "100"}
    monkeypatch.setattr(BinanceClient, "request", cancel)
    assert logged_in.post(f'/api/orders/{row["id"]}/cancel').json()["status"] == "canceled"
    assert calls[-1] == ("DELETE", "/fapi/v1/order", {"symbol": "BTCUSDT", "orderId": "900"})


def test_close_all_order_quantity_updates_after_trade(logged_in, exchange):
    from app.streams import process_user_message
    account_id = logged_in.post("/api/accounts", json={"name": "Testnet", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"}).json()["id"]
    payload = {"c": "autoclose-quantity", "i": 901, "s": "BTCUSDT", "S": "SELL", "q": "0", "X": "NEW", "x": "NEW", "z": "0", "ap": "0", "cp": True}
    process_user_message(account_id, {"e": "ORDER_TRADE_UPDATE", "o": payload})
    payload.update(X="FILLED", x="TRADE", z="2", l="2", ap="110", t=61, rp="20", n="0.11", N="USDT")
    process_user_message(account_id, {"e": "ORDER_TRADE_UPDATE", "o": payload})
    row = logged_in.get("/api/orders").json()[0]
    assert row["quantity"] == 2 and row["filledQuantity"] == 2 and row["ledgerComplete"]


def test_hedged_positions_are_managed_separately(logged_in, exchange):
    assert order(logged_in, position_side="LONG", client_order_id="hedge-long").status_code == 200
    assert order(logged_in, side="SELL", position_side="SHORT", client_order_id="hedge-short").status_code == 200
    rows = logged_in.get("/api/positions").json()
    assert {(p["positionSide"], p["side"], p["quantity"]) for p in rows} == {("LONG", "LONG", 1), ("SHORT", "SHORT", 1)}
    long_id = next(p["id"] for p in rows if p["positionSide"] == "LONG")
    response = logged_in.post(f"/api/positions/{long_id}/close", json={"percentage": "1", "client_order_id": "close-only-long"})
    assert response.status_code == 200
    rows = logged_in.get("/api/positions").json()
    assert len(rows) == 1 and rows[0]["positionSide"] == "SHORT" and rows[0]["quantity"] == 1


def test_strategy_targets_quantity_without_repeated_adds(logged_in, exchange, monkeypatch):
    candles = {"rows": [[i * 1000, "100", "110", "90", str(200 - i), "1", (i + 1) * 1000] for i in range(100)]}
    monkeypatch.setattr(BinanceClient, "klines", lambda *args: candles["rows"])
    sid = logged_in.post("/api/strategies", json={"account_id": 1, "name": "target", "symbol": "BTCUSDT", "strategy_type": "rsi", "quantity": "1", "auto_execute": True}).json()["id"]
    assert logged_in.post(f"/api/strategies/{sid}/run").status_code == 200
    candles["rows"].append([100000, "100", "110", "90", "100", "1", 101000])
    assert logged_in.post(f"/api/strategies/{sid}/run").status_code == 200
    rows = logged_in.get("/api/orders").json()
    assert len(rows) == 1 and rows[0]["quantity"] == 1
    assert logged_in.get("/api/positions").json()[0]["quantity"] == 1


def test_scheduled_strategy_observes_pause_after_selection(logged_in, monkeypatch):
    from app.models import Strategy
    from app.services import run_strategy
    sid = logged_in.post("/api/strategies", json={"account_id": 1, "name": "pause-race", "symbol": "BTCUSDT"}).json()["id"]
    logged_in.patch(f"/api/strategies/{sid}", json={"status": "running"})
    with SessionLocal() as db:
        queued = db.get(Strategy, sid)
        assert queued.status == "running"
        logged_in.patch(f"/api/strategies/{sid}", json={"status": "paused"})
        def unexpected(*args): raise AssertionError("Paused strategy must not request market data")
        monkeypatch.setattr(BinanceClient, "klines", unexpected)
        assert run_strategy(db, queued, scheduled=True) == {"skipped": True, "reason": "paused"}


def test_waiting_trade_session_reads_committed_position(logged_in, exchange):
    from app.models import ExchangeAccount
    from app.services import submit_order
    with SessionLocal() as waiting:
        account = waiting.get(ExchangeAccount, 1)
        assert order(logged_in).status_code == 200
        closed = submit_order(waiting, account=account, symbol="BTCUSDT", side="SELL", quantity=Decimal("1"), mode="demo", client_order_id="after-wait", reduce_only=True)
        assert closed.status == "filled"
    assert not logged_in.get("/api/positions").json()


def test_automation_recovers_after_temporary_database_failure(monkeypatch):
    import asyncio
    import app.scheduler as scheduler
    calls = {"sync": 0, "orders": 0, "sleep": 0}
    def sync():
        calls["sync"] += 1
        if calls["sync"] == 1: raise ConnectionError("temporary database failure")
    def reconcile(): calls["orders"] += 1
    async def sleep(_):
        calls["sleep"] += 1
        if calls["sleep"] >= 2: raise asyncio.CancelledError()
    monkeypatch.setattr(scheduler, "sync_all_accounts", sync)
    monkeypatch.setattr(scheduler, "reconcile_orders", reconcile)
    monkeypatch.setattr(scheduler, "monitor_protection", lambda: None)
    monkeypatch.setattr(scheduler.asyncio, "sleep", sleep)
    async def run():
        try: await scheduler.background_loop()
        except asyncio.CancelledError: pass
    asyncio.run(run())
    assert calls["sync"] == 2 and calls["orders"] == 1
    assert scheduler.automation_status["lastCycleAt"] and scheduler.automation_status["error"] is None
    assert not scheduler.automation_status["running"]


def test_market_updates_ignore_acknowledgments_and_other_contracts(monkeypatch):
    import app.streams as streams
    monkeypatch.setattr(streams, "quotes", {})
    monkeypatch.setattr(streams, "market_status", {"connected": False, "lastMessageAt": None, "error": None})
    assert not streams.process_market_message({"result": None, "id": 1})
    assert not streams.market_status["connected"]
    assert streams.process_market_message({"data": [
        {"e": "markPriceUpdate", "s": "BTCUSDT", "p": "84200.50", "st": 1},
        {"e": "markPriceUpdate", "s": "BTCUSD_PERP", "p": "84201", "st": 2},
        {"e": "markPriceUpdate", "s": "INVALID", "p": "NaN"},
    ]})
    assert set(streams.quotes) == {"BTCUSDT"}
    assert streams.quotes["BTCUSDT"]["markPrice"] == "84200.50"
    assert streams.market_status["connected"] and streams.market_status["lastMessageAt"]


def test_market_stream_retries_when_handshake_has_no_prices(monkeypatch):
    import asyncio
    import app.streams as streams
    monkeypatch.setattr(streams, "market_status", {"connected": False, "lastMessageAt": None, "error": None})
    class EmptyStream:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def recv(self):
            assert not streams.market_status["connected"]
            raise TimeoutError("No data")
    monkeypatch.setattr(streams.websockets, "connect", lambda *args, **kwargs: EmptyStream())
    async def stop(_):
        assert streams.market_status["error"] == "TimeoutError"
        raise asyncio.CancelledError()
    monkeypatch.setattr(streams.asyncio, "sleep", stop)
    async def run():
        try: await streams.market_loop()
        except asyncio.CancelledError: pass
    asyncio.run(run())
    assert not streams.market_status["connected"]


def test_external_reversal_clears_protection_and_cancels_old_side(logged_in, exchange, monkeypatch):
    from sqlalchemy import select
    from app.models import Position, ProtectionOrder
    from app.scheduler import reconcile_orders
    amount = {"value": "1"}
    monkeypatch.setattr(BinanceClient, "positions", lambda _: [{"symbol": "BTCUSDT", "positionSide": "BOTH", "positionAmt": amount["value"], "entryPrice": "100", "markPrice": "100", "positionInitialMargin": "100"}])
    account_id = logged_in.post("/api/accounts", json={"name": "reversal", "environment": "testnet", "api_key": "test-key-123", "secret_key": "private-secret-123"}).json()["id"]
    assert logged_in.post(f"/api/accounts/{account_id}/sync").status_code == 200
    pos_id = logged_in.get(f"/api/positions?account_id={account_id}").json()[0]["id"]
    with SessionLocal() as db:
        pos = db.get(Position, pos_id)
        pos.stop_loss, pos.take_profit, pos.trailing_pct, pos.peak_price = 90, 110, Decimal("0.02"), 105
        db.add(ProtectionOrder(account_id=account_id, symbol="BTCUSDT", position_side="BOTH", kind="STOP_MARKET", client_algo_id="old-long-guard", status="new"))
        db.commit()
    amount["value"] = "-1"
    assert logged_in.post(f"/api/accounts/{account_id}/sync").status_code == 200
    pos = logged_in.get(f"/api/positions?account_id={account_id}").json()[0]
    assert pos["side"] == "SHORT" and pos["stopLoss"] is None and pos["trailingPct"] is None
    canceled = []
    monkeypatch.setattr(BinanceClient, "query_protection", lambda *args: {"algoStatus": "NEW", "algoId": 55, "side": "SELL"})
    monkeypatch.setattr(BinanceClient, "cancel_protection", lambda _, key: canceled.append(key))
    reconcile_orders()
    assert canceled == ["old-long-guard"]
    with SessionLocal() as db:
        assert db.scalar(select(ProtectionOrder)).status == "canceled"


def test_protection_rechecks_settings_after_waiting_for_account(logged_in, exchange, monkeypatch):
    import threading
    from app.models import Position
    from app.scheduler import monitor_protection
    from app.services import account_locks
    assert order(logged_in).status_code == 200
    position_id = logged_in.get("/api/positions").json()[0]["id"]
    with SessionLocal() as db:
        position = db.get(Position, position_id)
        position.stop_loss, position.mark_price = 90, 80
        db.commit()
    waiting = threading.Event()
    lock = threading.RLock()
    class AccountGate:
        def __enter__(self):
            waiting.set()
            lock.acquire()
        def __exit__(self, *args): lock.release()
    monkeypatch.setitem(account_locks, 1, AccountGate())
    with lock:
        worker = threading.Thread(target=monitor_protection)
        worker.start()
        assert waiting.wait(5), "Protection job did not reach the account lock"
        with SessionLocal() as db:
            db.get(Position, position_id).stop_loss = None
            db.commit()
    worker.join(5)
    assert not worker.is_alive()
    assert len(logged_in.get("/api/orders").json()) == 1
    assert logged_in.get("/api/positions").json()[0]["quantity"] == 1
