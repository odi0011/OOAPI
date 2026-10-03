import { hasReasoningText } from "../services/reasoning-display.js";

const names = { account: "我的账号", binance: "币安分析", search: "联网检索", fetch: "读取网页", github: "GitHub", task: "子任务", todowrite: "任务清单" };
const phrases = {
  account: ["账号信息查到咯～", "账号的小账本翻好啦", "你的账号信息准备好啦"],
  recent: ["最近的调用找到咯～", "调用记录整理好啦", "小账本里有答案啦～"],
  search: ["线索找到咯～", "新鲜资料带回来啦", "搜索有收获啦～"],
  fetch: ["网页读完咯～", "网页里的重点找到啦", "这页资料收好啦～"],
  github: ["仓库看过咯～", "代码里的线索找到啦", "仓库资料带回来啦"],
  binance: ["账户数据查到咯～", "分析资料备好啦", "数据整理好啦～"],
  task: ["这件小事办好啦～", "子任务交卷咯", "又完成了一小步～"],
  todowrite: ["小清单更新好啦", "接下来做什么记住啦", "计划安排好咯～"],
  reasoning: ["思考完成啦～", "想明白咯～", "思路理顺啦～"],
  text: ["想法记下啦～", "这一步想好啦～"],
  compaction: ["记忆收好啦～", "小脑袋又轻快啦", "重点都记住咯～"],
  other: ["这一步完成咯～", "事情办好啦～", "又前进了一小步～"],
};
export const failedPart = p => ["failed", "stopped", "cancelled", "denied", "expired"].includes(p.status);
export const toolName = p => p.name || names[p.tool] || p.tool || "执行任务";
export function capsuleGesture(part = {}) {
  const tool = part.tool || "";
  if (part.type === "reasoning" || part.type === "text") return "capsule-think";
  if (part.type === "compaction") return "capsule-pack";
  if (tool === "account") return `capsule-${({ recent:"notebook", errors:"inspect", tokens:"key", usage:"chart", balance:"coin", profile:"wave" })[part.args?.action] || "wave"}`;
  if (tool === "community") return `capsule-${["publish", "comment", "edit"].includes(part.args?.action) ? "type" : ["like", "favorite", "follow"].includes(part.args?.action) ? "reach" : "read"}`;
  const platformGestures = { platform:"list", models:"inspect", notifications:"notebook", people:"wave", messages:"type", workspace:"pack", tokens:"key", media:"read", usage:"chart", trading:"coin", channels:"reach", pricing:"coin", users:"wave", monitor:"inspect", system:"list" };
  if (platformGestures[tool]) return `capsule-${platformGestures[tool]}`;
  return `capsule-${({ search:"search", fetch:"read", github:"type", task:"reach", todowrite:"list", binance:"chart" })[tool] || "wave"}`;
}
export function executionEntries(parts = [], streaming = false, finalTextId) {
  parts = parts.filter(p => p.type !== "reasoning" || hasReasoningText(p.text));
  const lastTool = parts.findLastIndex(p => p.type === "tool");
  const latest = parts.findLast(p => ["reasoning", "text", "tool", "compaction"].includes(p.type));
  return parts.flatMap((p, i) => {
    if (!["tool", "reasoning", "compaction"].includes(p.type) && !(p.type === "approval" && ["denied", "expired"].includes(p.status)) && !(p.type === "text" && i < lastTool && p.id !== finalTextId)) return [];
    return [{ part: p, active: Boolean(streaming && (["running", "pending", "awaiting_approval"].includes(p.status) || (p.type === "reasoning" && !p.status && p === latest))) }];
  });
}
export function presentation(part, active) {
  if (part.type === "waiting") return { thought: false, failed: false, label: "正在等待模型响应…", state: "loading" };
  const thought = ["reasoning", "text"].includes(part.type), failed = failedPart(part);
  const waiting = part.status === "awaiting_approval" || part.type === "approval" && part.status === "pending";
  const tool = part.tool || Object.keys(names).find(k => names[k] === part.name) || "other";
  const kind = thought || part.type === "compaction" ? part.type : tool === "account" && part.args?.action === "recent" ? "recent" : tool;
  const configured = part.presentation?.capsulePhrases?.filter(p => typeof p === "string" && p);
  const choices = configured?.length ? configured : phrases[kind] || phrases.other;
  // 同一条执行记录固定文案；流式片段、刷新和主题切换都不会重新抽签。
  const seed = Array.from(String(part.id || part.type)).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  const label = failed ? ({ denied: "这次先不查啦", expired: "确认时间到啦", stopped: "这一步停下啦", cancelled: "这一步取消啦" }[part.status] || "这一步遇到问题啦")
    : waiting ? "等你点点头～" : !active ? choices[seed % choices.length]
    : part.type === "compaction" ? "乐乐在整理记忆…" : thought ? "乐乐正在想…" : `${toolName(part)} · 正在忙啦`;
  return { thought, failed, label, state: failed ? "sad" : !active ? "success" : waiting ? "waiting" : part.type === "compaction" ? "compressing" : thought ? "thinking" : "working" };
}
export function taskSummary(part) {
  if (part.presentation?.title) return part.presentation.title;
  const a = part.args || {};
  if (part.tool === "account" || part.name === "我的账号") {
    return ({ recent: `查看最近${a.limit ? ` ${a.limit} 条` : ""}调用`, profile: "查看个人信息", balance: "查看账户余额", usage: "查看账户用量", tokens: "查看令牌概况" })[a.action] || "查看你的账号情况";
  }
  return a.query || a.url || a.repo || a.prompt || a.description || "";
}
