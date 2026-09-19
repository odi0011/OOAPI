// GLM (chat.z.ai) SSE 解析器
// ---------------------------------------------------------------------------
// 帧结构：
//   data: {"data":{"phase":"thinking|answer|done","delta_content":"增量","content":"全量",
//                  "edit_content":"回退重写片段","edit_index":N,"done":false}}
//   data: [DONE]
//
// 语义（三种更新方式，优先级从高到低）：
//   edit_content + edit_index → 回退重写：新内容 = 旧内容.slice(0, edit_index) + edit_content
//   content                   → 全量替换
//   delta_content             → 纯增量追加
//
// 对外统一转成"增量"输出：内部维护完整文本 + 「客户端已收到文本」，
// 每帧按两者关系 diff 出新增部分（不靠游标回退，见 diffDelta 注释）。
// edit_index 是 UTF-16 码元偏移（JS slice 语义一致），Node 无需转换。
export function createGlmParser() {
  const state = {
    thinking: "",       // 思考链完整文本
    answer: "",         // 正文完整文本
    emittedThink: "",   // 客户端已收到的思考文本（只追加）
    emittedAnswer: "",  // 客户端已收到的正文文本（只追加）
    phase: null,
    finished: false,
    error: null,
    usage: null, // 结构化 usage（对象），交给 normalizeUsage 精确计费
    chatId: null,
    messageId: null,
  };

  // 按协议更新目标通道的完整文本
  function update(target, d) {
    if (typeof d.edit_content === "string") {
      const cut = Math.max(0, Math.min(Number(d.edit_index) || 0, target.length));
      return target.slice(0, cut) + d.edit_content;
    }
    if (typeof d.content === "string") return d.content;
    if (typeof d.delta_content === "string") return target + d.delta_content;
    return target;
  }

  // 计算增量。以「客户端已收到文本 emitted」为基准，而不是可回退的游标：
  //   1. next 以 emitted 开头 → 正常增长，delta = next 的尾巴；
  //   2. emitted 以 next 开头 → 上游回退（内容变短），客户端已多出的部分无法撤回，跳过；
  //   3. 两者都在中间分叉 → 只发公共前缀之后的修正内容（协议只支持追加，无法完美撤回）。
  // 旧实现把游标直接设成新长度：回退后再增长会把已经发过的内容整段重发（显示重复、计费重复）。
  function diffDelta(emitted, next) {
    if (next.startsWith(emitted)) return next.slice(emitted.length);
    if (emitted.startsWith(next)) return "";
    // 中间分叉（edit 回退重写）：客户端只能追加、无法撤回已显示内容，
    // 因此只补「净新增的尾巴」，绝不重发已发过的片段（否则输出膨胀错乱）
    return next.length > emitted.length ? next.slice(emitted.length) : "";
  }

  return {
    push(raw) {
      if (raw === "[DONE]") {
        state.finished = true;
        return null;
      }
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        return null;
      }
      const d = frame?.data ?? frame;
      if (!d || typeof d !== "object") return null;

      if (d.phase) state.phase = d.phase;
      if (d.chat_id) state.chatId = d.chat_id;
      if (d.message_id) state.messageId = d.message_id;
      if (d.done === true || d.phase === "done") state.finished = true;
      if (d.usage) {
        // 整体透传，只补一个缺失的 total_tokens。
        // 原先用白名单重建 usage 会把 cached_tokens / prompt_cache_hit_tokens /
        // prompt_tokens_details 等缓存字段全部丢掉 —— 缓存部分于是一律按全额输入价
        // 计费（多收），而缓存价通常只有输入价的 10%。normalizeUsage 已能识别各家别名。
        const u = d.usage;
        state.usage = { ...u };
        if (u.total_tokens === undefined) {
          state.usage.total_tokens =
            Number(u.prompt_tokens ?? u.input_tokens ?? 0) + Number(u.completion_tokens ?? u.output_tokens ?? 0);
        }
      }
      const errObj = d.error || (frame?.error ?? null);
      if (errObj) {
        state.error = typeof errObj === "string" ? errObj : errObj.message || JSON.stringify(errObj);
      }

      // phase=thinking 的内容进思考链，其余进正文
      const isThink = state.phase === "thinking";
      const hasContent =
        typeof d.edit_content === "string" || typeof d.content === "string" || typeof d.delta_content === "string";

      if (hasContent) {
        if (isThink) state.thinking = update(state.thinking, d);
        else state.answer = update(state.answer, d);
      }

      // diff 出增量，并把真正发出的部分计入「客户端已收到」
      const thinkDelta = diffDelta(state.emittedThink, state.thinking);
      const answerDelta = diffDelta(state.emittedAnswer, state.answer);
      state.emittedThink += thinkDelta;
      state.emittedAnswer += answerDelta;

      if (!thinkDelta && !answerDelta) return null;
      return { reasoning: thinkDelta, content: answerDelta };
    },
    get finished() { return state.finished; },
    get error() { return state.error; },
    get usage() { return state.usage; },
    get chatId() { return state.chatId; },
    get messageId() { return state.messageId; },
    get phase() { return state.phase; },
    get thinking() { return state.thinking; },
    get answer() { return state.answer; },
  };
}
