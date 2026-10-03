const labels = { default: "模型默认", enabled: "开启", disabled: "关闭", off: "关闭", none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
export const reasoningLabel = value => String(value || "").split(",").map(level => level === "unsupported_qa" || level === "invalid" ? "未应用" : labels[level] || level).filter(Boolean).join(" / ") || "未记录";
export const requestedReasoningLabel = value => ["unsupported_qa", "invalid"].includes(value) ? "未支持的档位" : value || "未传";
