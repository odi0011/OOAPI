// 日历使用北京时间的绝对日界，避免浏览器/服务器时区把同一次调用画到不同日期。
const DAY = 86400;
const OFFSET = 8 * 3600;
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const dayOf = (time) => new Date((time + OFFSET) * 1000).toISOString().slice(0, 10);
const countOf = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function channelActivityCalendar(byDay = [], generatedAt = Math.floor(Date.now() / 1000)) {
  const suppliedTime = Number(generatedAt);
  const now = Number.isFinite(suppliedTime) && suppliedTime > 0 ? suppliedTime : Math.floor(Date.now() / 1000);
  const today = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET;
  const start = today - 364 * DAY;
  const startDate = dayOf(start), endDate = dayOf(today);
  const daily = new Map();
  for (const record of byDay) {
    const date = record?.day;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDate || date > endDate) continue;
    const parsed = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) continue;
    const previous = daily.get(date) || { tokens: 0, calls: 0 };
    daily.set(date, { tokens: previous.tokens + countOf(record.tokens), calls: previous.calls + countOf(record.calls) });
  }

  // 日期按列向下排列，星期固定在七行；范围外占位不显示为“零用量”。
  const leading = (new Date((start + OFFSET) * 1000).getUTCDay() + 6) % 7;
  const columns = Math.ceil((365 + leading) / 7);
  const trailing = columns * 7 - leading - 365;
  const slots = Array(columns * 7).fill(null);
  const cells = Array.from({ length: 365 }, (_, index) => {
    const date = dayOf(start + index * DAY);
    const position = leading + index;
    const row = position % 7 + 1, column = Math.floor(position / 7) + 1;
    const cell = { key: date, date, period: date, weekday: WEEKDAYS[row - 1], row, column, ...(daily.get(date) || { tokens: 0, calls: 0 }) };
    slots[position] = cell;
    return cell;
  });
  const max = Math.max(1, ...cells.map((cell) => cell.tokens));
  for (const cell of cells) cell.level = cell.tokens > 0 ? Math.max(1, Math.ceil(cell.tokens / max * 4)) : 0;

  // 极短的边缘月份无法放下文字；不挤占相邻月份，完整年月日仍保留在悬浮明细里。
  const monthStarts = new Map();
  for (const [index, cell] of cells.entries()) {
    if (index && !cell.date.endsWith("-01")) continue;
    monthStarts.set(cell.column, { key: cell.date.slice(0, 7), label: `${Number(cell.date.slice(5, 7))}月`, column: cell.column, year: Number(cell.date.slice(0, 4)) });
  }
  const candidates = [...monthStarts.values()];
  const months = candidates.filter((month, index) => (candidates[index + 1]?.column || columns + 1) - month.column >= 2);
  return {
    cells, slots, columns, leading, trailing, months,
    rangeLabel: `${startDate} — ${endDate}`,
    tokens: cells.reduce((sum, cell) => sum + cell.tokens, 0),
    calls: cells.reduce((sum, cell) => sum + cell.calls, 0),
  };
}
