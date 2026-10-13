# 交易对账

占位说明。这里只记录核对口径，不放密钥，也不放可执行脚本。

## 保护单

- 止盈（TP）是普通未成交委托：`GTX` `LIMIT` `reduceOnly`。
- 止损（SL）是条件单（algo order）：`STOP_MARKET` `closePosition`。

## 核对

每次对账检查：

1. 持仓（positions）
2. 当前委托（open orders）——止盈在这里
3. 条件单（algo orders）——止损在这里
4. 强平价（liquidation price）——止损必须在强平价之前
5. 账单（income）——已实现盈亏、手续费、资金费
