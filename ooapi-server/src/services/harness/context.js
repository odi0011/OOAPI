
export function contextBudget(caps = {}, config = {}) {
  const window = Number(caps.contextWindow) || 65536;
  const reserve = Math.min(Number(caps.maxOutputTokens) || 8192, Math.max(1024, Math.floor(window * .2)), 16384);
  return Math.max(1024, Math.floor((window - reserve) * (Number(config.threshold) || .7)));
}
export function messageTokens(messages) {
  // 上下文防溢出使用保守估算，独立于 pricing 的用量计费估算。
  const count = text => { const s = String(text || ""), wide = (s.match(/[^\x00-\x7f]/g) || []).length; return Math.ceil((s.length - wide) / 3 + wide); };
  return messages.reduce((n, m) => n + count(typeof m.content === "string" ? m.content : JSON.stringify(m.content)) + count(JSON.stringify(m.tool_calls || [])) + 8, 0);
}
// 工具调用与结果必须一起留在尾部，不能产生没有 tool_call 的 role:tool。
export function compressionSplit(messages, keepRecent = 6) {
  let cut = Math.max(0, messages.length - keepRecent);
  while (cut > 0 && (messages[cut]?.role === "tool" || messages[cut - 1]?.tool_calls?.length)) cut--;
  const pairedCut = cut;
  while (cut > 0 && messages[cut]?.role !== "user") cut--;
  // 单轮探索也会累积很长的工具结果；没有用户轮次边界时按完整调用组压缩。
  // 摘要承担此前问题与已完成工具结果，尾部仍保留成对的调用和响应。
  if (!cut && pairedCut > 0) cut = pairedCut;
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
}
export function latestMemory(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i].parts?.findLast(p => p.type === "compaction" && p.status === "done" && p.summary && Number.isFinite(p.throughSeq));
    if (p) return p;
  }
  return null;
}
