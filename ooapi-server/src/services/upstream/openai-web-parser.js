// ChatGPT 网页版（/backend-api/f/conversation）SSE 解析器
// ---------------------------------------------------------------------------
// 协议是**实测出来的**，不是照抄社区文档 —— 那条路踩过两次坑：
//   ① 社区文档描述的端点是 /backend-api/conversation，而当前网页版实际发的是
//      /backend-api/f/conversation（写成前者 hook 一帧都捕不到）；
//   ② 帧格式也不是文档里的 {message:{content:{parts}}} 直推，而是
//      **JSON Patch 操作流**（下面详述）。
// 判断入口与格式时，永远以页面上抓到的真实请求/响应为准。
//
// 实测帧序列（发一句「只回复两个字：收到」共 23 帧）：
//   [0]  "v1"                              协议版本标记（非 JSON）
//   [1]  {"type":"resume_conversation_token",...}
//   [2]  {"p":"","o":"add","v":{"message":{...}}}      ← 完整消息（含 user/system）
//   [17] {"o":"patch","v":[                            ← **正文增量在这里**
//          {"p":"/message/content/parts/0","o":"append","v":"收到"},
//          {"p":"/message/status","o":"replace","v":"finished_successfully"},
//          {"p":"/message/end_turn","o":"replace","v":true}]}
//   [20] {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-5-6",...}}
//   [21] {"type":"message_stream_complete",...}
//   [22] [DONE]
//
// 要点：
//   · 只有 author.role === "assistant" 且 content_type === "text" 的消息算正文。
//     流里有大量 role=system（rebase 系统提示、隐藏消息）与
//     content_type=reasoning_recap / model_editable_context，
//     混进正文会让用户收到一段自己没要过的文本。
//   · 正文可以以两种形态到达：整条 message 快照（parts）或 patch 的 append 增量。
//     两种都处理，并按「客户端已发出多少」diff，避免重复输出。
export function createOpenAiWebParser() {
  const state = {
    answer: "",             // 上游给出的完整正文
    emitted: "",            // 已转发给客户端的正文（只追加）
    /** 正在追踪的助手正文消息 id：patch 的路径不带 id，必须靠它认领 */
    activeTextId: null,
    finished: false,
    error: null,
    conversationId: null,
    modelSlug: null,
    upstreamError: null,
    /** 供排查：见过的帧类型 */
    seenTypes: [],
  };

  /** 以「已发出文本」为基准 diff 出真正的新增部分 */
  function emitDelta(next) {
    if (next === state.emitted) return "";
    if (next.startsWith(state.emitted)) return next.slice(state.emitted.length);
    // 上游回退/分叉：只发公共前缀之后的部分（协议只支持追加，无法撤回）
    let i = 0;
    const max = Math.min(next.length, state.emitted.length);
    while (i < max && next[i] === state.emitted[i]) i += 1;
    return next.slice(i);
  }

  /** 判断一个 message 对象是不是「要展示给用户的助手正文」 */
  function isAssistantText(msg) {
    if (!msg || msg.author?.role !== "assistant") return false;
    const ct = msg.content?.content_type;
    return ct === "text" || ct === undefined;
  }

  /** 处理完整消息快照 */
  function onMessage(msg) {
    if (!isAssistantText(msg)) return null;
    state.activeTextId = msg.id || state.activeTextId;
    const parts = msg.content?.parts;
    const text = Array.isArray(parts) ? parts.filter((p) => typeof p === "string").join("") : "";
    if (!text) return null; // 占位帧（parts:[""]），后面靠 patch 增量填
    state.answer = text;
    const delta = emitDelta(text);
    if (!delta) return null;
    state.emitted += delta;
    return { content: delta };
  }

  /**
   * 处理 patch 操作流。
   * 只关心 `content.parts` 上的 append —— 那才是正文增量；
   * status/end_turn/metadata 这些只用于判断结束。
   */
  function onPatch(ops) {
    if (!Array.isArray(ops)) return null;
    let delta = "";
    let done = false;
    for (const op of ops) {
      if (!op || typeof op !== "object") continue;
      const p = String(op.p || "");
      if (/^\/message\/content\/parts\/\d+$/.test(p)) {
        if (op.o === "append" && typeof op.v === "string") delta += op.v;
        else if (op.o === "replace" && typeof op.v === "string") delta = op.v;
      } else if (p === "/message/end_turn" && op.v === true) {
        done = true;
      } else if (p === "/message/status" && op.v === "finished_successfully") {
        done = true;
      }
    }
    if (!delta) return done ? { done: true } : null;
    state.answer += delta;
    state.emitted += delta;
    return { content: delta, ...(done ? { done: true } : {}) };
  }

  return {
    /** 吃一帧原始字符串（已去掉 "data:" 前缀），返回 {content, done} 或 null */
    push(raw) {
      const line = String(raw || "").trim();
      if (!line) return null;
      if (line === "[DONE]") {
        state.finished = true;
        return { done: true };
      }
      if (line === "v1" || /^v\d+$/.test(line)) {
        state.seenTypes.push(`version:${line}`);
        return null; // 协议版本标记，不是 JSON
      }
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        state.seenTypes.push("unparsed");
        return null;
      }
      if (j?.error) {
        state.upstreamError = j.error;
        return null;
      }
      const t = j?.type;
      if (t) state.seenTypes.push(t);

      // 元信息
      if (j.conversation_id) state.conversationId = j.conversation_id;
      if (j?.metadata?.model_slug) state.modelSlug = j.metadata.model_slug;
      if (j?.message?.metadata?.model_slug) state.modelSlug = j.message.metadata.model_slug;

      // 结束标记
      if (t === "message_stream_complete") {
        state.finished = true;
        return { done: true };
      }
      // 其余控制类帧（message_marker / title_generation / server_ste_metadata…）不产内容。
      // 注意要在**提取完元信息之后**才返回 —— model_slug 就藏在
      // server_ste_metadata.metadata 里（实测），提前 return 会丢掉它，
      // 导致计费拿不到真实档位。
      if (t && !j.v && !j.message) return null;

      // 形态一：完整消息快照（{"p":"","o":"add","v":{"message":…}} 或 {"v":{"message":…}}）
      const snap = j?.v?.message || (j?.message && !j.o ? j.message : null);
      if (snap && !j.o) return onMessage(snap);

      // 形态二：patch 操作流。
      // 有两种到达方式，**都要认**（实测同一账号两次请求就分别命中过）：
      //   a) 包装形态：{"o":"patch","v":[ {op}, {op}, … ]}
      //   b) 单操作形态：{"p":"/message/content/parts/0","o":"append","v":"收到"}
      //      —— 上游把 patch 数组拆成多个 data: 行发送，每行一个操作项。
      // 只认 a) 会漏掉正文：现象是帧数正常（20+）、钩子正常、页面也真回复了，
      // 但解析出来是空字符串（本轮实测踩到，且是间歇性的 —— 取决于上游怎么分帧）。
      if (j.o === "patch" && Array.isArray(j.v)) return onPatch(j.v);
      if (typeof j.p === "string" && typeof j.o === "string") return onPatch([j]);
      // {"p":"","o":"add","v":{"message":…}} —— add 带 message 时也当快照处理
      if (j.o === "add" && j.v?.message) return onMessage(j.v.message);

      return null;
    },

    /** 流结束后取完整结果 */
    result() {
      return {
        content: state.answer,
        conversationId: state.conversationId,
        modelSlug: state.modelSlug,
        finished: state.finished,
        upstreamError: state.upstreamError,
        seenTypes: state.seenTypes,
      };
    },
  };
}

/**
 * 从帧里识别上游错误（风控/限额/掉登录态），供适配器提前结束而不是干等到超时。
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
