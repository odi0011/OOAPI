/**
 * 网格页展示逻辑的测试。
 *
 * 直接跑：`node --experimental-strip-types src/pages/admin/gridView.test.ts`
 * 与 tradingDeskView.test.ts 同一个做法 —— 不引入测试框架，断言失败就抛错。
 */

import {
  formatPrice,
  formatPct,
  formatQty,
  gridReasonLabel,
  gridStateLabel,
  lineStateLabel,
  requirementHint,
} from "./gridView.ts";
import { describe, expect, it } from "vitest";

function assertEqual<T>(actual: T, expected: T, message: string) {
  expect(actual, message).toBe(expected);
}

/*
价格的小数位必须**按量级自适应**。

这一条是网格页上最容易出错、也最容易看出来是错的显示：
同一个固定位数下，SHIB（0.0000051）和 BTC（六万）不可能都显示对。
位数太少，相邻的两条网格线会显示成同一个数 —— 用户会以为
"这个网格画错了，两条线重合了"。
*/
describe("gridView", () => {
  it("既有断言全部通过", () => {
assertEqual(formatPrice(0.08), "0.08000", "DOGE 量级");
assertEqual(formatPrice(2.1), "2.1000", "XRP 量级");
assertEqual(formatPrice(65000), "65000.00", "BTC 量级");
assertEqual(formatPrice(0.0000051), "0.0000051", "SHIB 量级要足够多位");
// 相邻的两条网格线必须**显示得出来是两个价**，否则用户以为画重了。
const shib1 = formatPrice(0.00000510);
const shib2 = formatPrice(0.00000515);
if (shib1 === shib2) {
  throw new Error(`SHIB 相邻网格线显示成了同一个价：${shib1}`);
}
assertEqual(formatPrice(0), "—", "零价格不是 0");
assertEqual(formatPrice(Number.NaN), "—", "NaN 不该显示成 NaN");

// 比例入参是小数：0.0025 是 0.250%。
assertEqual(formatPct(0.025238), "2.524%", "比例按百分数显示");
assertEqual(formatPct(0), "0.000%", "零比例是真实的零");

/*
数量：整数币不该显示成一串零。

DOGE 的每格数量是 44，显示成 "44.00" 会让人以为它可以买半个 ——
而 DOGE 的数量步长是 1，半个根本挂不出去。
*/
assertEqual(formatQty(44), "44", "整数币不带小数");
// 用 44.956 而不是 44.955：后者在 IEEE754 里略小于 .955，
// 四舍五入到 44.95 —— 拿它当断言等于在测浮点表示，而不是在测格式化。
assertEqual(formatQty(44.956), "44.96", "小数币保留两位");
assertEqual(formatQty(0.000051), "0.000051", "极小数量不显示成 0");

/*
停机原因只在**已经停机**时才翻译成句子。

同一条 reason 在运行中出现的含义完全不同 —— "止损价"在运行中只是
一个参数，停机时才是结果。运行中把它显示成"跌破止损，已清仓停机"
是彻头彻尾的误导。
*/
assertEqual(gridReasonLabel("grid_stop_loss", "Running"), "", "运行中不解释停机原因");
assertEqual(gridReasonLabel("grid_stop_loss", "Stopped"), "跌破止损，已清仓停机", "止损停机");
assertEqual(gridReasonLabel("grid_take_profit", "Stopped"), "涨过上沿，已止盈停机", "止盈停机");
assertEqual(gridReasonLabel("grid_stopped_by_user", "Stopped"), "手动停止", "手动停止");
// 认不出来的原因原样显示，不吞掉 —— 一个没见过的原因比含糊的"已停止"有用。
assertEqual(gridReasonLabel("who_knows", "Error"), "who_knows", "未知原因原样显示");
assertEqual(gridReasonLabel(undefined, "Stopped"), "", "没有原因就是空");

assertEqual(gridStateLabel("Running", true), "运行中", "运行中");
assertEqual(gridStateLabel("Stopped", false), "已停止", "已停止");
assertEqual(gridStateLabel("Error", false), "出错", "出错");
// 引擎还没在内存里建起来（进程重启后还没推进过）：如实说"未运行"，
// 不编一个看起来在跑的状态。
assertEqual(gridStateLabel(undefined, false), "未运行", "没有快照时不假装在跑");
assertEqual(gridStateLabel(undefined, true), "待推进", "库里标了运行但引擎还没起来");

assertEqual(lineStateLabel("buy"), "挂着买单", "买单格");
assertEqual(lineStateLabel("sell"), "挂着卖单", "卖单格");
assertEqual(lineStateLabel("holding"), "已买到，等卖", "持仓格");
assertEqual(lineStateLabel("empty"), "空着", "空格");
assertEqual(lineStateLabel("???"), "空着", "认不出来的状态按空处理");

/*
资金门槛的说明必须**分开说**两件事。

门槛被"交易所最小名义"顶起来，解法是加钱；被"价格精度"顶起来，
解法是换交易对。混成一句"资金不够"，用户会一直往一个错误的数字上加钱。
*/
const dustHint = requirementHint("dust");
const notionalHint = requirementHint("notional");
if (dustHint === notionalHint) {
  throw new Error("两种门槛的说明不能是同一句");
}
if (!dustHint.includes("精度")) {
  throw new Error(`零头门槛的说明要点名"精度"：${dustHint}`);
}
if (!notionalHint.includes("最小名义")) {
  throw new Error(`名义门槛的说明要点名"最小名义"：${notionalHint}`);
}

  });
});
