// ChatGPT 网页版（chatgpt.com/backend-api/conversation）SSE 解析器
// ---------------------------------------------------------------------------
// 帧结构（实测 2026-09，免费档 + 网页版 UI 路径）：
//   data: {"message":{"id":...,"author":{"role":"assistant"},
//                     "content":{"content_type":"text","parts":["全量文本"]},
//                     "metadata":{...}},"conversation_id":"..."}
//   data: {"type":"..."}                     ← 控制类帧（无 message）
//   data: [DONE]
//
// 关键语义（决定了实现方式）：
//   · `parts` 是**全量文本**，不是增量 —— 每帧重复发送到目前为止的完整回复。
//     所以不能直接当增量转发（会把已发过的内容重发，显示重复且重复计费）。
//     这里按「客户端已收到多少」diff 出真正的新增部分。
//   · 上游可能**回退重写**（内容变短）：协议只支持追加，无法撤回已发出的文本，
//     因此取公共前缀之后的修正内容，而不是把整段重发一遍。
//   · `metadata.is_completion` / 流末尾的 [DONE] 都可作为结束信号；
//     真正的结束判定由 browser-driver 的 streamCapture 负责（它看的是流关闭），
//     这里只负责把帧翻译成增量。
export function createOpenAiWebParser() {
  const state = {
    answer: "",        // 上游给出的完整正文
    emitted: "",       // 客户端已收到的正文（只追加）
    finished: false,
    error: null,
    conversationId: null,
    messageId: null,
    modelSlug: null,
    /** 上游报错（如风控拦截）：解析出来交给适配器转成可读错误 */
    upstreamError: null,
  };

  /** 计算增量：以「已发出文本」为基准 diff，而不是简单取最新全量 */
  function diffDelta(next) {
    if (next === state.emitted) return "";
    if (next.startsWith(state.emitted)) return next.slice(state.emitted.length);
    // 上游回退或分叉：找公共前缀，把前缀之后的部分作为修正内容发出
    let i = 0;
    const max = Math.min(next.length, state.emitted.length);
    while (i < max && next[i] === state.emitted[i]) i += 1;
    return next.slice(i);
  }

  return {
    /** 吃一帧原始字符串（已去掉 "data:" 前缀），返回 {content, thinking, done} 或 null */
    push(raw) {
      const line = String(raw || "").trim();
      if (!line) return null;
      if (line === "[DONE]") {
        state.finished = true;
        return { done: true };
      }
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return null; // 非 JSON 帧（心跳等）直接忽略
      }

      if (j?.error) {
        state.upstreamError = j.error;
        return null;
      }
      if (j?.type === "conversation_detail_metadata" || j?.type === "message_stream_complete") {
        if (j.type === "message_stream_complete") state.finished = true;
        return null;
      }

      const msg = j?.message;
      if (!msg) return null;
      if (j.conversation_id) state.conversationId = j.conversation_id;
      if (msg.id) state.messageId = msg.id;
      if (msg.metadata?.model_slug) state.modelSlug = msg.metadata.model_slug;

      const role = msg.author?.role;
      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) return null;

      // 正文：只取字符串部件（图片等非文本部件跳过）
      const text = parts.filter((p) => typeof p === "string").join("");

      if (role === "assistant") {
        state.answer = text;
        const delta = diffDelta(text);
        if (!delta) return null;
        state.emitted += delta;
        return { content: delta, done: Boolean(msg.metadata?.is_completion) };
      }

      // 其他角色（tool / system）不进正文 —— 网页版的工具调用过程对用户不可见，
      // 混进正文会变成一段用户没要过的文本。
      return null;
    },

    /** 流结束后取完整结果（供适配器返回 content / model 用） */
    result() {
      return {
        content: state.answer,
        conversationId: state.conversationId,
        modelSlug: state.modelSlug,
        finished: state.finished,
        upstreamError: state.upstreamError,
      };
    },
  };
}

/**
 * 从帧里识别上游错误（风控/限额），供适配器提前结束而不是干等到超时。
 * 与 glm 的 detectError 同构：只看前几帧，命中就报错。
 */
export function detectOpenAiWebError(frames, httpStatus) {
  const text = Array.isArray(frames) ? frames.join(" ") : String(frames || "");
  if (/Unusual activity has been detected/i.test(text)) {
    return {
      code: "CHANNEL_WAF",
      message: "该 ChatGPT 账号触发网页版风控（设备异常检测），请在网页端完成一次人工验证后重试",
    };
  }
  if (/"detail"\s*:\s*"You've reached/i.test(text) || /reached your (current )?(plan )?limit/i.test(text)) {
    return { code: "CHANNEL_QUOTA_EXCEEDED", message: "该 ChatGPT 账号已达用量上限" };
  }
  if (/"detail"\s*:\s*"Unauthorized/i.test(text) || httpStatus === 401) {
    return { code: "CHANNEL_AUTH_EXPIRED", message: "ChatGPT 网页版登录态已失效，请重新登录" };
  }
  if (/verify you are human|challenge/i.test(text)) {
    return { code: "CHANNEL_WAF", message: "该 ChatGPT 账号需要人工人机验证，请在网页端完成验证后重试" };
  }
  return null;
}
