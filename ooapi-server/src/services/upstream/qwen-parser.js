// 通义千问 SSE 解析器（兼容国际版与 CN 版两种格式）
// ---------------------------------------------------------------------------
// 国际版（chat.qwen.ai）：/api/v2/chat/completions
//   data: {"choices":[{"delta":{"content":"...","reasoning_content":"...","phase":"think|answer"}}]}
//   结束：finish_reason 非空，或 delta.status === "finished"，或 data: [DONE]
//   → 原生增量，直接透传
//
// CN 版（qianwen.com）：/dialog/conversation
//   data: {"sessionId":..,"msgId":..,"contents":[{"contentType":"text","role":"assistant","content":"..."}]}
//   → **content 是全量累积文本，必须自行差分**
//   结束：data: [DONE]
//   错误：errorCode（如 NOT_LOGIN）
export function createQwenParser() {
  const state = {
    content: "",
    reasoning: "",
    finished: false,
    error: null,
    usage: null, // 结构化 usage（对象），交给 normalizeUsage 精确计费
    mode: null, // "intl" | "cn"
    _summaryLen: 0, // 思考摘要已发送长度（初值必须是 0，undefined 比较恒 false 会吞掉整段思考）
  };

  return {
    push(raw) {
      const t = String(raw || "").trim();
      if (!t) return null;
      if (t === "[DONE]") {
        state.finished = true;
        return null;
      }

      let j;
      try {
        j = JSON.parse(t);
      } catch {
        return null;
      }
      if (!j || typeof j !== "object") return null;

      // ---------- 国际版 ----------
      if (Array.isArray(j.choices)) {
        state.mode = "intl";
        const ch = j.choices[0] || {};
        const d = ch.delta || {};

        if (d.status === "finished") state.finished = true;
        if (ch.finish_reason) state.finished = true;
        if (j.usage) {
          // 必须上报结构化 usage：只上报 output_tokens 会被当成 total_tokens，
          // 输入侧只能用估算值兜底，系统性少计费
          const u = j.usage;
          state.usage = {
            prompt_tokens: Number(u.input_tokens ?? u.prompt_tokens) || 0,
            completion_tokens: Number(u.output_tokens ?? u.completion_tokens) || 0,
            total_tokens: Number(u.total_tokens) || 0,
          };
        }

        let reasoning = "";
        let content = "";

        // 思考链：phase=think/thinking_summary 或 reasoning_content 字段
        const isThinkPhase = /think|thinking_summary/i.test(d.phase || "");
        if (typeof d.reasoning_content === "string" && d.reasoning_content) {
          reasoning += d.reasoning_content;
        }
        const summary = d.extra?.summary_thought;
        if (Array.isArray(summary) && summary.length) {
          // 增长数组：取新增段（按长度差）
          const last = summary[summary.length - 1];
          const txt = last?.content || "";
          if (txt.length > state._summaryLen) {
            reasoning += txt.slice(state._summaryLen);
            state._summaryLen = txt.length;
          }
        }

        if (typeof d.content === "string" && d.content) {
          if (isThinkPhase) reasoning += d.content;
          else content += d.content;
        }

        // 丢弃内部 function 帧
        if (d.role === "function") return null;

        if (!reasoning && !content) return null;
        state.reasoning += reasoning;
        state.content += content;
        return { reasoning, content };
      }

      // ---------- CN 版 ----------
      if (j.errorCode) {
        state.error = String(j.errorCode);
        return null;
      }
      if (Array.isArray(j.contents)) {
        state.mode = "cn";
        // 全量快照 → 差分
        const full = j.contents
          .filter((p) => p && (p.contentType === "text" || p.contentType === "text2image"))
          .filter((p) => p.role === "assistant" || typeof p.content === "string")
          .map((p) => p.content || "")
          .join("");

        if (full.length > state.content.length) {
          const delta = full.slice(state.content.length);
          state.content = full;
          return { reasoning: "", content: delta };
        }
        return null;
      }

      // 会话信息帧（含 sessionId/msgId）
      return null;
    },
    get content() { return state.content; },
    get reasoning() { return state.reasoning; },
    get finished() { return state.finished; },
    get error() { return state.error; },
    get usage() { return state.usage; },
    get mode() { return state.mode; },
  };
}

export function extractQwenSseData(line) {
  const t = String(line || "").replace(/\r$/, "").trim();
  if (!t.startsWith("data:")) return null;
  return t.slice(5).trim();
}
