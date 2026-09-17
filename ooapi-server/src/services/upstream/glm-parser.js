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
// 对外统一转成"增量"输出：内部维护完整文本 + 已发送游标，每帧 diff 出新增部分。
// edit_index 是 UTF-16 码元偏移（JS slice 语义一致），Node 无需转换。
export function createGlmParser() {
  const state = {
    thinking: "",   // 思考链完整文本
    answer: "",     // 正文完整文本
    sentThink: 0,   // 已输出的思考字符数
    sentAnswer: 0,
    phase: null,
    finished: false,
    error: null,
    usage: 0,
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
        const n = Number(d.usage.total_tokens ?? d.usage.completion_tokens ?? 0);
        if (Number.isFinite(n) && n > 0) state.usage = n;
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

      // diff 出增量
      const newThink = state.thinking.slice(state.sentThink);
      const newAnswer = state.answer.slice(state.sentAnswer);
      state.sentThink = state.thinking.length;
      state.sentAnswer = state.answer.length;

      if (!newThink && !newAnswer) return null;
      return { reasoning: newThink, content: newAnswer };
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
