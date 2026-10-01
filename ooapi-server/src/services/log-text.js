// 日志列是 TEXT：一轮多步对话也只能保存有限原文，不能让长上下文挤掉整条账单。
const LIMIT = 4000;

function clipped(text, { tail = false } = {}) {
  const s = String(text || "");
  if (s.length <= LIMIT) return { text: s, truncated: false };
  // 输入末尾通常是本轮用户的问题，保留首尾可同时看到系统设定和实际提问。
  const marker = "\n…（中间内容已截断）…\n";
  return { text: tail ? `${s.slice(0, 1000)}${marker}${s.slice(-(LIMIT - 1000 - marker.length))}` : s.slice(0, LIMIT), truncated: true };
}

export function logTexts({ prompt = "", output = "", calls = null } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  // 多步/子代理每次上游调用都有独立输入和输出，按实际调用顺序保留，不拿最终正文替代。
  const combine = (key, fallback) => list.length
    ? list.map((c, i) => list.length > 1 ? `【调用 ${i + 1}】\n${String(c[key] || "")}` : String(c[key] || "")).join("\n\n")
    : String(fallback || "");
  const input = clipped(combine("prompt", prompt), { tail: true });
  const result = clipped(combine("output", output));
  return {
    prompt_text: input.text,
    output_text: result.text,
    prompt_truncated: input.truncated,
    output_truncated: result.truncated,
    text_truncated: input.truncated || result.truncated,
    ...(list.length ? { call_count: list.length } : {}),
  };
}
