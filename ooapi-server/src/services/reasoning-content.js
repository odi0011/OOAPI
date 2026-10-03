// 空白、零宽字符与省略号只有占位意义，不能据此宣告模型返回了思考内容。
export const hasReasoningText = value => typeof value === "string" && /[^\s.\u2026\u200B-\u200D\u2060\uFEFF]/u.test(value);

/** 等首段可见内容再开放思考；保留真实文本中的空格、换行与省略号。 */
export function createReasoningFilter(emit) {
  let pending = "", received = "", text = "", active = false, closed = false;
  const publish = (chunk, notify) => { text += chunk; if (notify) emit?.(chunk); };
  const push = (chunk, notify = true) => {
    if (closed || typeof chunk !== "string" || !chunk) return;
    received += chunk;
    if (active) { publish(chunk, notify); return; }
    pending += chunk;
    if (!hasReasoningText(pending)) return;
    active = true;
    publish(pending, notify);
    pending = "";
  };
  // 正文或工具开始后，下次思考必须重新等到有效内容；否则正文后的 "..." 又会开空块。
  const boundary = () => { pending = ""; active = false; };
  return {
    push, boundary,
    finish(full, notify = true) {
      if (closed) return text;
      if (typeof full === "string" && full.startsWith(received)) push(full.slice(received.length), notify);
      boundary(); closed = true;
      return text;
    },
  };
}

const normalizedAdapters = new WeakMap();
/** 所有注册渠道及渠道探测共用出口，避免只修 Kiro 而遗漏其他协议/厂商。 */
export function normalizeReasoningAdapter(adapter) {
  if (!adapter?.chat) return adapter;
  if (normalizedAdapters.has(adapter)) return normalizedAdapters.get(adapter);
  const normalized = { ...adapter, async chat(args) {
    const filter = createReasoningFilter(args.onReasoning);
    let closed = false;
    try {
      const result = await adapter.chat({ ...args,
        onReasoning: chunk => { if (!closed) filter.push(chunk); },
        onDelta: chunk => { if (!closed) { if (chunk) filter.boundary(); args.onDelta?.(chunk); } },
        onToolCall: call => { if (!closed) { filter.boundary(); args.onToolCall?.(call); } },
      });
      return { ...result, reasoning: filter.finish(result.reasoning) };
    } catch (error) {
      // 失败仍保留真实思考和上游 usage；不凭占位内容推算或改写实际用量。
      error.reasoning = filter.finish(error.reasoning, false);
      throw error;
    } finally { closed = true; }
  } };
  normalizedAdapters.set(adapter, normalized);
  return normalized;
}
