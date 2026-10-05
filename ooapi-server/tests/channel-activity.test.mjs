// 确定的北京时间样本验证真实窗口语义，不使用真实数据库或浏览器时区。
import assert from "node:assert/strict";
import { channelActivityView } from "../../ooapi-web/src/services/channel-activity.js";

const sec = (iso) => Date.parse(iso) / 1000;
const now = sec("2026-10-05T05:30:00Z"); // 北京 13:30
const midnight = sec("2026-10-04T16:00:00Z");
const rows = [
  { time: midnight - 1, tokens: 11, calls: 1 },
  { time: midnight, tokens: 10, calls: 1 },
  { time: midnight + 3599, tokens: 20, calls: 2 },
  { time: midnight + 3600, tokens: 40, calls: 1 },
  { time: now - 1, tokens: 30, calls: 1 },
  { time: now + 1, tokens: 9000, calls: 1 },
  { time: midnight - 6 * 86400, tokens: 50, calls: 1 },
  { time: midnight - 7 * 86400, tokens: 60, calls: 1 },
  { time: midnight - 29 * 86400, tokens: 70, calls: 1 },
  { time: midnight - 30 * 86400, tokens: 80, calls: 1 },
];
let checks = 0;
const check = (label, run) => { run(); checks++; console.log("  ok " + label); };
const day = channelActivityView(rows, "day", now);
check("每日为北京时间今日的 24 个时段", () => {
  assert.equal(day.cells.length, 24);
  assert.equal(day.cells[0].key, "2026-10-05T00");
  assert.equal(day.cells.at(-1).label, "23:00");
  assert.equal(day.tokens, 100);
  assert.equal(day.calls, 5);
});
check("整点之前与之后归属正确小时，重复桶累加", () => {
  assert.equal(day.cells[0].tokens, 30);
  assert.equal(day.cells[0].calls, 3);
  assert.equal(day.cells[1].tokens, 40);
  assert.equal(day.cells[13].tokens, 30);
});
check("未来小时不伪装为已发生调用，当前小时不是未来", () => {
  assert.equal(day.cells[13].future, false);
  assert.equal(day.cells[14].future, true);
  assert.equal(day.cells[14].tokens, 0);
  assert.equal(day.cells.filter((c) => c.future).length, 10);
});
const week = channelActivityView(rows, "week", now);
check("每周恰为包含今日的七个北京日历日", () => {
  assert.equal(week.cells.length, 7);
  assert.equal(week.cells[0].key, "2026-09-29");
  assert.equal(week.cells.at(-1).key, "2026-10-05");
  assert.equal(week.tokens, 161);
  assert.equal(week.cells.at(-1).weekday, "周一");
});
const month = channelActivityView(rows, "month", now);
check("每月恰为近三十日，范围前一日不能进入总数", () => {
  assert.equal(month.cells.length, 30);
  assert.equal(month.cells[0].key, "2026-09-06");
  assert.equal(month.cells.at(-1).key, "2026-10-05");
  assert.equal(month.tokens, 291);
});
check("月视图星期从周一开始对齐", () => {
  assert.equal(month.leading, 6); // 9 月 6 日为周日。
  assert.equal(channelActivityView([], "month", sec("2026-10-06T05:30:00Z")).leading, 0);
});
check("午夜前后不受主机时区影响，切日后归零", () => {
  const before = channelActivityView(rows, "day", midnight - 1);
  assert.equal(before.cells[0].key, "2026-10-04T00");
  assert.equal(before.cells[23].tokens, 11);
  const after = channelActivityView(rows, "day", midnight);
  assert.equal(after.cells[0].key, "2026-10-05T00");
  assert.equal(after.cells[0].tokens, 10);
  assert.equal(after.cells[1].future, true);
});
check("空数据仍保留完整窗口与零级色阶", () => {
  for (const [mode, count] of [["day", 24], ["week", 7], ["month", 30]]) {
    const empty = channelActivityView([], mode, now);
    assert.equal(empty.cells.length, count);
    assert.equal(empty.tokens, 0);
    assert.equal(empty.calls, 0);
    assert.ok(empty.cells.every((cell) => cell.level === 0));
  }
});
check("色阶依据当前窗口，而不是窗口外历史最大值", () => {
  assert.equal(day.cells[1].level, 4);
  assert.equal(day.cells[0].level, 3);
  assert.equal(day.cells[2].level, 0);
});
console.log(`渠道活动窗口回归 ${checks} 项通过`);
