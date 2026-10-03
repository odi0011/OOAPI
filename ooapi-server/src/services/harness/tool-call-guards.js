// 同一轮内完全相同的工具调用只保留第一次。
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function callFingerprint(call = {}) {
  return `${String(call.tool || "")}\u0000${stable(call.args || {})}`;
}
