// 全站统计按北京时间分天；用绝对小时桶还原日界，不受浏览器/服务器时区影响。
const HOUR = 3600;
const DAY = 24 * HOUR;
const OFFSET = 8 * HOUR;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const dayOf = (time) => new Date((time + OFFSET) * 1000).toISOString().slice(0, 10);
const countOf = (value) => Math.max(0, Number(value) || 0);

export function channelActivityView(byHour = [], mode = "day", generatedAt = Math.floor(Date.now() / 1000)) {
  const now = Number(generatedAt) > 0 ? Number(generatedAt) : Math.floor(Date.now() / 1000);
  const today = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET;
  const perHour = new Map();
  const perDay = new Map();
  for (const record of byHour) {
    const time = Number(record.time);
    if (!Number.isFinite(time) || time > now) continue;
    const hour = Math.floor(time / HOUR) * HOUR;
    const date = dayOf(hour);
    const value = { tokens: countOf(record.tokens), calls: countOf(record.calls) };
    for (const [map, key] of [[perHour, hour], [perDay, date]]) {
      const prev = map.get(key) || { tokens: 0, calls: 0 };
      map.set(key, { tokens: prev.tokens + value.tokens, calls: prev.calls + value.calls });
    }
  }

  const hourly = mode === "day";
  const count = hourly ? 24 : mode === "week" ? 7 : 30;
  const start = hourly ? today : today - (count - 1) * DAY;
  const cells = Array.from({ length: count }, (_, index) => {
    const time = start + index * (hourly ? HOUR : DAY);
    const date = dayOf(time);
    const hour = String(index).padStart(2, "0");
    const future = time > now;
    const value = (hourly ? perHour.get(time) : perDay.get(date)) || { tokens: 0, calls: 0 };
    return {
      key: hourly ? `${date}T${hour}` : date,
      label: hourly ? `${hour}:00` : date.slice(5),
      weekday: WEEKDAYS[new Date((time + OFFSET) * 1000).getUTCDay()],
      period: hourly ? `${date} ${hour}:00–${String(index + 1).padStart(2, "0")}:00` : date,
      ...value,
      future,
    };
  });
  const max = Math.max(1, ...cells.map((cell) => cell.tokens));
  for (const cell of cells) cell.level = cell.tokens > 0 ? Math.max(1, Math.ceil(cell.tokens / max * 4)) : 0;

  // 月视图按周一到周日对齐；占位格不伪装成范围外的用量数据。
  const leading = mode === "month" ? (new Date((start + OFFSET) * 1000).getUTCDay() + 6) % 7 : 0;
  return {
    cells, leading, columns: hourly ? 6 : 7,
    rangeLabel: hourly ? `${dayOf(today)} · 今日时段` : `${dayOf(start)} — ${dayOf(today)}`,
    tokens: cells.reduce((sum, cell) => sum + cell.tokens, 0),
    calls: cells.reduce((sum, cell) => sum + cell.calls, 0),
  };
}
