import json
from .services import signal_from_closes, client_for


def backtest(strategy, account, *, limit=500, initial_balance=10000, fee_rate=0.0005, slippage=0.0002):
    fee_rate, slippage = float(fee_rate), float(slippage)
    rows = client_for(account).klines(strategy.symbol, strategy.timeframe, limit)
    rows = rows[:-1]  # Current candle cannot be used to generate a historical signal.
    config = json.loads(strategy.config_json)
    closes, balance, quantity, entry = [], float(initial_balance), 0.0, 0.0
    trades, curve, peak, drawdown, wins, entry_fee = [], [], float(initial_balance), 0.0, 0, 0.0
    for index, row in enumerate(rows):
        open_price, close_price = float(row[1]), float(row[4])
        # Use only closes known BEFORE this bar; execution occurs at this bar's open.
        signal = signal_from_closes(closes, config, strategy.strategy_type)
        target = 1 if signal == "BUY" else -1 if signal == "SELL" else 0
        position_side = config.get("position_side", "BOTH")
        if (position_side == "LONG" and target == -1) or (position_side == "SHORT" and target == 1): target = 0
        if signal != "HOLD" and ((not target and quantity) or (target and (quantity == 0 or (quantity > 0) != (target > 0)))):
            if quantity:
                exit_price = open_price * (1 - slippage if quantity > 0 else 1 + slippage)
                pnl = quantity * (exit_price - entry) - abs(quantity) * exit_price * fee_rate
                balance += pnl
                wins += int(pnl - entry_fee > 0)
                trades.append({"time": row[0], "pnl": round(pnl - entry_fee, 6), "price": exit_price})
            quantity = 0.0
            if target:
                entry = open_price * (1 + slippage if target > 0 else 1 - slippage)
                qty = float(config.get("quantity", 0.001))
                quantity = target * qty
                entry_fee = qty * entry * fee_rate
                balance -= entry_fee
        closes.append(close_price)
        equity = balance + quantity * (close_price - entry)
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak - equity) / peak if peak else 0)
        curve.append({"time": row[0], "value": round(equity, 4)})
    if quantity and rows:
        exit_price = float(rows[-1][4]) * (1 - slippage if quantity > 0 else 1 + slippage)
        pnl = quantity * (exit_price - entry) - abs(quantity) * exit_price * fee_rate
        balance += pnl
        wins += int(pnl - entry_fee > 0)
        trades.append({"time": rows[-1][0], "pnl": round(pnl - entry_fee, 6), "price": exit_price})
        curve[-1]["value"] = round(balance, 4)
        drawdown = max(drawdown, (peak - balance) / peak if peak else 0)
    return {"initialBalance": float(initial_balance), "finalBalance": round(balance, 4), "returnPct": round((balance / float(initial_balance) - 1) * 100, 4), "maxDrawdownPct": round(drawdown * 100, 4), "winRate": round(wins / len(trades) * 100, 2) if trades else 0, "tradeCount": len(trades), "trades": trades, "curve": curve, "feeRate": float(fee_rate), "slippage": float(slippage)}
