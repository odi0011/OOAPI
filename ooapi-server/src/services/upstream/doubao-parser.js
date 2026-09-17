// 豆包 SSE 解析器
// ---------------------------------------------------------------------------
// 协议（2026-09 调研）：
//   端点 /samantha/chat/completion
//   帧：data: {"event_type":2001,"event_id":0,"event_data":"<JSON字符串>"}
//   三层嵌套：外层取 event_type/event_data → event_data 再 parse → message.content 再 parse
//
// event_type 枚举：
//   1    HEARTBEAT  心跳
//   2001 CMPL       文本补全（主载体）
//   2002 ACK        确认（含 conversation_id）
//   2003 FIN        流结束（**没有 [DONE]**）
//   2005 ERR        错误
//   2010 VERBOSE    元数据
//
// content_type：2001/10000 正文，2008 思考链，2002 推荐问题
// block_type：10040 思考链分隔符（第 1 次进入 thinking，第 2 次退出）
export function createDoubaoParser() {
  const state = {
    content: "",
    reasoning: "",
    conversationId: null,
    messageId: null,
    finished: false,
    error: null,
    usage: 0,
    // 思考链状态：遇到 10040 两次切换
    thinkDelimCount: 0,
    inThinking: false,
  };

  // 安全多级 parse
  function parseMaybe(v) {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  return {
    push(raw) {
      const t = String(raw || "").trim();
      if (!t || t === "[DONE]") {
        if (t === "[DONE]") state.finished = true;
        return null;
      }

      let outer;
      try {
        outer = JSON.parse(t);
      } catch {
        return null;
      }
      if (!outer || typeof outer !== "object") return null;

      const eventType = Number(outer.event_type ?? outer.eventType ?? 0);
      const inner = parseMaybe(outer.event_data ?? outer.eventData);

      if (eventType === 2003) {
        state.finished = true;
        return null;
      }
      if (eventType === 2005 || outer.error_code) {
        const msg =
          parseMaybe(inner)?.message ||
          parseMaybe(inner)?.msg ||
          outer.error_msg ||
          outer.message ||
          JSON.stringify(outer).slice(0, 160);
        state.error = String(msg);
        return null;
      }
      if (eventType === 2002) {
        // ACK：拿 conversation_id
        const d = parseMaybe(inner);
        const cid = d?.conversation_id || d?.ack_client_meta?.conversation_id || d?.message?.conversation_id;
        if (cid) state.conversationId = cid;
        return null;
      }

      // 2001 CMPL：提取 message
      const msg = inner?.message ?? inner;
      if (!msg || typeof msg !== "object") return null;

      if (msg.conversation_id) state.conversationId = msg.conversation_id;
      if (msg.message_id) state.messageId = msg.message_id;
      if (msg.ext) {
        const n = Number(msg.ext.output_tokens || msg.ext.total_tokens || 0);
        if (Number.isFinite(n) && n > 0) state.usage = n;
      }

      const contentType = Number(msg.content_type ?? 0);
      const content = parseMaybe(msg.content);

      let out = null;
      const emitText = (text) => {
        if (!text) return;
        if (!out) out = { reasoning: "", content: "" };
        if (state.inThinking) out.reasoning += text;
        else out.content += text;
        if (state.inThinking) state.reasoning += text;
        else state.content += text;
      };
      const emitThink = (text) => {
        if (!text) return;
        if (!out) out = { reasoning: "", content: "" };
        out.reasoning += text;
        state.reasoning += text;
      };

      // 文本类内容
      if (contentType === 2001 || contentType === 2071 || contentType === 10000) {
        const text = content?.text ?? content?.thinking ?? (typeof content === "string" ? content : "");
        if (content?.thinking && !content?.text) emitThink(content.thinking);
        else emitText(text);
      } else if (contentType === 2008) {
        // 思考链
        const text = content?.think ?? content?.text ?? (typeof content === "string" ? content : "");
        emitThink(text);
      } else if (contentType === 10040) {
        // 思考链分隔符：第 1 次进入思考，第 2 次退出
        state.thinkDelimCount++;
        state.inThinking = state.thinkDelimCount % 2 === 1;
      } else if (contentType === 2002) {
        // 推荐问题，忽略
      } else if (content && typeof content === "object" && typeof content.text === "string") {
        emitText(content.text);
      }

      return out;
    },
    get content() { return state.content; },
    get reasoning() { return state.reasoning; },
    get conversationId() { return state.conversationId; },
    get messageId() { return state.messageId; },
    get finished() { return state.finished; },
    get error() { return state.error; },
    get usage() { return state.usage; },
  };
}

/** 从 SSE 行里提取 data 内容 */
export function extractSseData(line) {
  const t = String(line || "").replace(/\r$/, "").trim();
  if (!t.startsWith("data:")) return null;
  return t.slice(5).trim();
}
