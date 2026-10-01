"""USD-M Futures REST client. Never retry a POST with uncertain execution status."""
import hashlib
import hmac
import time
from decimal import Decimal, ROUND_DOWN
from urllib.parse import urlencode
import httpx
from .config import settings


class BinanceError(RuntimeError):
    def __init__(self, message: str, *, uncertain: bool = False):
        super().__init__(message)
        self.uncertain = uncertain


class BinanceClient:
    _info_cache: dict[str, tuple[float, dict]] = {}

    def __init__(self, api_key: str = "", secret_key: str = "", *, testnet: bool = False, proxy_url: str | None = None):
        self.api_key, self.secret_key = api_key, secret_key.encode()
        self.base_url = settings.testnet_base_url if testnet else settings.live_base_url
        self.time_offset = 0
        self.proxy_url = settings.proxy_url if proxy_url is None else proxy_url

    def request(self, method: str, path: str, params: dict | None = None, *, signed: bool = False):
        attempts = 3 if method == "GET" else 1
        for attempt in range(attempts):
            payload = dict(params or {})
            if signed:
                payload.update(timestamp=int(time.time() * 1000) + self.time_offset, recvWindow=5000)
                payload["signature"] = hmac.new(self.secret_key, urlencode(payload).encode(), hashlib.sha256).hexdigest()
            try:
                with httpx.Client(timeout=10, proxy=self.proxy_url or None) as client:
                    response = client.request(method, f"{self.base_url}{path}", params=payload, headers={"X-MBX-APIKEY": self.api_key})
            except httpx.TransportError as exc:
                if attempt + 1 < attempts:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise BinanceError("Binance 网络连接失败", uncertain=method == "POST") from exc
            if response.status_code == 200:
                try: return response.json()
                except ValueError as exc: raise BinanceError("Binance 返回了无法解析的响应", uncertain=method == "POST") from exc
            if response.status_code == 451:
                raise BinanceError("币安不接受当前服务器地区的请求（HTTP 451），请检查服务区域与连接配置。")
            try:
                error = response.json()
            except ValueError:
                error = {"msg": f"HTTP {response.status_code}"}
            if method == "GET" and error.get("code") == -1021 and attempt + 1 < attempts:
                self.time_offset = int(self.request("GET", "/fapi/v1/time")["serverTime"]) - int(time.time() * 1000)
                continue
            if method == "GET" and response.status_code in (429, 502, 503) and attempt + 1 < attempts:
                time.sleep(min(float(response.headers.get("Retry-After", "1")), 3))
                continue
            message = str(error.get("msg", "Binance 请求失败"))
            # 上游错误可能回显请求参数；真实交易凭据不得进入账户错误、订单记录或日志。
            for private in (self.api_key, self.secret_key.decode()):
                if private: message = message.replace(private, "[隐藏凭据]")
            raise BinanceError(message, uncertain=method == "POST" and response.status_code >= 500)

    def account(self):
        return self.request("GET", "/fapi/v3/account", signed=True)

    def symbol_configuration(self, symbol: str):
        rows = self.request("GET", "/fapi/v1/symbolConfig", {"symbol": symbol}, signed=True)
        return next((r for r in rows if r["symbol"] == symbol), None)

    def positions(self):
        return self.request("GET", "/fapi/v3/positionRisk", signed=True)

    def klines(self, symbol: str, interval: str = "15m", limit: int = 300):
        return self.request("GET", "/fapi/v1/klines", {"symbol": symbol, "interval": interval, "limit": min(limit, 1500)})

    def ticker_price(self, symbol: str) -> Decimal:
        return Decimal(self.request("GET", "/fapi/v1/premiumIndex", {"symbol": symbol})["markPrice"])

    def exchange_info(self):
        cached = self._info_cache.get(self.base_url)
        if cached and time.time() - cached[0] < 3600:
            return cached[1]
        info = self.request("GET", "/fapi/v1/exchangeInfo")
        self._info_cache[self.base_url] = (time.time(), info)
        return info

    def normalize_quantity(self, symbol: str, quantity: Decimal, price: Decimal, *, reduce_only: bool) -> Decimal:
        info = next((s for s in self.exchange_info()["symbols"] if s["symbol"] == symbol and s["status"] == "TRADING"), None)
        if not info:
            raise ValueError("交易对不可用")
        filters = {f["filterType"]: f for f in info["filters"]}
        lot = filters.get("MARKET_LOT_SIZE", filters["LOT_SIZE"])
        step = Decimal(lot["stepSize"])
        if step == 0:
            step = Decimal(filters["LOT_SIZE"]["stepSize"])
        normalized = (quantity / step).to_integral_value(rounding=ROUND_DOWN) * step
        if normalized != quantity:
            raise ValueError(f"数量必须是 {step} 的整数倍")
        if quantity < Decimal(lot["minQty"]) or quantity > Decimal(lot["maxQty"]):
            raise ValueError("数量不符合 Binance 最小或最大数量要求")
        minimum = Decimal(filters.get("MIN_NOTIONAL", {}).get("notional", "0"))
        if not reduce_only and quantity * price < minimum:
            raise ValueError(f"订单金额小于 {minimum} USDT")
        return quantity

    def validate_trigger_price(self, symbol: str, price: Decimal):
        info = next((s for s in self.exchange_info()["symbols"] if s["symbol"] == symbol and s["status"] == "TRADING"), None)
        if not info: raise ValueError("交易对不可用")
        rule = next(f for f in info["filters"] if f["filterType"] == "PRICE_FILTER")
        step = Decimal(rule["tickSize"])
        if step and price % step: raise ValueError(f"触发价格必须是 {step} 的整数倍")
        if price < Decimal(rule["minPrice"]) or (Decimal(rule["maxPrice"]) and price > Decimal(rule["maxPrice"])): raise ValueError("触发价格超出合约价格范围")

    def order(self, *, symbol: str, side: str, quantity: Decimal, client_order_id: str, reduce_only: bool = False, position_side: str = "BOTH"):
        self.time_offset = int(self.request("GET", "/fapi/v1/time")["serverTime"]) - int(time.time() * 1000)
        params = {"symbol": symbol, "side": side, "type": "MARKET", "quantity": format(quantity, "f"), "positionSide": position_side, "newClientOrderId": client_order_id, "newOrderRespType": "RESULT"}
        if position_side == "BOTH":
            params["reduceOnly"] = "true" if reduce_only else "false"
        return self.request("POST", "/fapi/v1/order", params, signed=True)

    def query_order(self, symbol: str, client_order_id: str):
        return self.request("GET", "/fapi/v1/order", {"symbol": symbol, "origClientOrderId": client_order_id}, signed=True)

    def query_order_by_id(self, symbol: str, order_id: str):
        return self.request("GET", "/fapi/v1/order", {"symbol": symbol, "orderId": order_id}, signed=True)

    def cancel_order(self, symbol: str, client_order_id: str, *, order_id: str | None = None):
        identifier = {"orderId": order_id} if order_id else {"origClientOrderId": client_order_id}
        return self.request("DELETE", "/fapi/v1/order", {"symbol": symbol, **identifier}, signed=True)

    def listen_key(self):
        return self.request("POST", "/fapi/v1/listenKey")["listenKey"]

    def keepalive(self, key: str):
        return self.request("PUT", "/fapi/v1/listenKey", {"listenKey": key})

    def user_trades(self, symbol: str, order_id: str):
        return self.request("GET", "/fapi/v1/userTrades", {"symbol": symbol, "orderId": order_id, "limit": 1000}, signed=True)

    def protection_order(self, *, symbol: str, side: str, position_side: str, kind: str, trigger_price: Decimal, client_algo_id: str):
        self.time_offset = int(self.request("GET", "/fapi/v1/time")["serverTime"]) - int(time.time() * 1000)
        return self.request("POST", "/fapi/v1/algoOrder", {"algoType": "CONDITIONAL", "symbol": symbol, "side": side, "positionSide": position_side, "type": kind, "triggerPrice": format(trigger_price, "f"), "workingType": "MARK_PRICE", "closePosition": "true", "clientAlgoId": client_algo_id}, signed=True)

    def query_protection(self, client_algo_id: str):
        return self.request("GET", "/fapi/v1/algoOrder", {"clientAlgoId": client_algo_id}, signed=True)

    def cancel_protection(self, client_algo_id: str):
        return self.request("DELETE", "/fapi/v1/algoOrder", {"clientAlgoId": client_algo_id}, signed=True)
