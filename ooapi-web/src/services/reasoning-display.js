const labels = { default: "模型默认", enabled: "开启", disabled: "关闭", off: "关闭", none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
// 与网关同一口径；历史记录里的空白/省略号占位也不展示为思考。
export const hasReasoningText = value => typeof value === "string" && /[^\s.\u2026\u200B-\u200D\u2060\uFEFF]/u.test(value);
export const reasoningLabel = value => String(value || "").split(",").map(level => level === "unsupported_qa" || level === "invalid" ? "未应用" : labels[level] || level).filter(Boolean).join(" / ") || "未记录";
export const requestedReasoningLabel = value => ["unsupported_qa", "invalid"].includes(value) ? "未支持的档位" : value || "未传";
