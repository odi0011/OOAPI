// 北京时间年历的边界、星期矩阵与月份标签；不使用真实数据库或浏览器时区。
import assert from "node:assert/strict";
import { channelActivityCalendar } from "../../ooapi-web/src/services/channel-activity.js";

const sec = (iso) => Date.parse(iso) / 1000;
const now = sec("2026-10-05T05:30:00Z"); // 北京 13:30。
let checks = 0;
const check = (label, run) => { run(); checks++; console.log("  ok " + label); };
const rows = [
  { day: "2025-10-05", tokens: 90000, calls: 1 },
  { day: "2025-10-06", tokens: 10, calls: 1 },
  { day: "2026-02-28", tokens: 30, calls: 3 },
  { day: "2026-10-05", tokens: 60, calls: 2 },
  { day: "2026-10-05", tokens: 40, calls: 1 },
  { day: "2026-10-06", tokens: 80000, calls: 1 },
];
const calendar = channelActivityCalendar(rows, now);
check("近一年包含今日、恰好365个连续北京日期", () => {
  assert.equal(calendar.cells.length, 365);
  assert.equal(calendar.cells[0].date, "2025-10-06");
  assert.equal(calendar.cells.at(-1).date, "2026-10-05");
  assert.equal(calendar.rangeLabel, "2025-10-06 — 2026-10-05");
  assert.equal(calendar.tokens, 140);
  assert.equal(calendar.calls, 7);
});
check("七行星期矩阵按列向下，周一位于第一行", () => {
  assert.equal(calendar.leading, 0);
  assert.equal(calendar.cells[0].row, 1);
  assert.equal(calendar.cells[0].column, 1);
  assert.equal(calendar.cells[0].weekday, "周一");
  assert.equal(calendar.cells[6].row, 7);
  assert.equal(calendar.cells[6].column, 1);
  assert.equal(calendar.cells[7].row, 1);
  assert.equal(calendar.cells[7].column, 2);
  assert.equal(calendar.cells.at(-1).row, 1);
  assert.equal(calendar.cells.at(-1).column, 53);
});
check("首末不完整周用null占位，不冒充范围外调用", () => {
  const sunday = channelActivityCalendar([], sec("2026-10-04T05:30:00Z"));
  assert.equal(sunday.leading, 6);
  assert.equal(sunday.trailing, 0);
  assert.equal(sunday.slots.slice(0, 6).filter((cell) => cell === null).length, 6);
  assert.equal(sunday.cells[0].row, 7);
  assert.equal(calendar.trailing, 6);
  assert.equal(calendar.slots.slice(-6).filter((cell) => cell === null).length, 6);
  assert.equal(calendar.slots.length, calendar.columns * 7);
  assert.deepEqual(calendar.slots.filter(Boolean), calendar.cells);
  for (let day = 4; day <= 10; day++) {
    const varied = channelActivityCalendar([], sec(`2026-10-${String(day).padStart(2, "0")}T05:30:00Z`));
    assert.equal(varied.leading + varied.cells.length + varied.trailing, varied.columns * 7);
    assert.deepEqual(varied.slots.filter(Boolean), varied.cells);
    assert.ok(varied.cells.every((cell) => cell.row === (new Date(cell.date + "T00:00:00Z").getUTCDay() + 6) % 7 + 1));
  }
});
check("重复日桶累加，范围外与未来日期不进入汇总或色阶", () => {
  assert.equal(calendar.cells.at(-1).tokens, 100);
  assert.equal(calendar.cells.at(-1).calls, 3);
  assert.equal(calendar.cells.at(-1).level, 4);
  assert.equal(calendar.cells[0].level, 1);
  assert.equal(calendar.cells[1].level, 0);
});
check("月份标签按日历所在列定位，并避免拥挤的边缘月份", () => {
  const october = calendar.months[0], november = calendar.months[1];
  assert.equal(october.label, "10月");
  assert.equal(october.column, 1);
  assert.equal(october.year, 2025);
  assert.equal(november.label, "11月");
  assert.equal(november.column, calendar.cells.find((cell) => cell.date === "2025-11-01").column);
  assert.equal(calendar.months.length, 13); // 窗口跨同一个月份，首尾两段均有足够标签空间。
  assert.ok(calendar.months.every((month, index) => (calendar.months[index + 1]?.column || calendar.columns + 1) - month.column >= 2));
  const boundary = channelActivityCalendar([], sec("2026-10-29T05:30:00Z"));
  assert.equal(boundary.cells[0].date, "2025-10-30");
  assert.equal(boundary.months[0].label, "11月"); // 首日与11月1日同列，只保留可读的月份。
});
check("北京时间午夜切日与执行主机时区无关", () => {
  const midnight = sec("2026-10-04T16:00:00Z");
  assert.equal(channelActivityCalendar([], midnight - 1).cells.at(-1).date, "2026-10-04");
  assert.equal(channelActivityCalendar([], midnight).cells.at(-1).date, "2026-10-05");
});
check("闰日属于真实日历，不按月长度猜测或丢失一天", () => {
  const leap = channelActivityCalendar([{ day: "2024-02-29", tokens: 55, calls: 1 }], sec("2024-03-01T05:00:00Z"));
  assert.equal(leap.cells.length, 365);
  assert.equal(leap.cells[0].date, "2023-03-03");
  assert.equal(leap.cells.at(-2).date, "2024-02-29");
  assert.equal(leap.cells.at(-2).tokens, 55);
  assert.equal(new Set(leap.cells.map((cell) => cell.key)).size, 365);
});
check("空数据保留完整年历且所有格子为零级", () => {
  const empty = channelActivityCalendar([], now);
  assert.equal(empty.cells.length, 365);
  assert.equal(empty.tokens, 0);
  assert.equal(empty.calls, 0);
  assert.ok(empty.cells.every((cell) => cell.level === 0));
});
check("无效日期与非有限计数不会产生NaN、错月或无限色阶", () => {
  const invalid = channelActivityCalendar([null, { day: "2026-02-31", tokens: 500, calls: 5 }, { day: "2026-2-28", tokens: 500, calls: 5 }, { day: "2026-10-05", tokens: Infinity, calls: "bad" }, { day: "2026-10-05", tokens: -10, calls: -1 }], now);
  assert.equal(invalid.tokens, 0);
  assert.equal(invalid.calls, 0);
  assert.ok(invalid.cells.every((cell) => cell.level === 0));
  assert.doesNotThrow(() => channelActivityCalendar([], Infinity));
});
console.log(`渠道活动年度日历回归 ${checks} 项通过`);
