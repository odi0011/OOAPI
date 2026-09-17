// DeepSeek 网页版 SSE 解析器（2026-09 协议，实测验证）
// ---------------------------------------------------------------------------
// 帧格式（实测样例）：
//   event: ready
//   data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}
//   event: update_session
//   data: {"updated_at":1789622153.0001929}
//   data: {"v":{"response":{"message_id":2,"status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"1"}],"conversation_mode":"DEFAULT"}}}
//   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"."}      ← -1 表示最后一个 fragment
//   data: {"v":" API"}                                                     ← 省略 p 时继承上一路径
//   data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":43},{"p":"quasi_status","v":"FINISHED"}]}
//   data: {"p":"response/status","o":"SET","v":"FINISHED"}
//   event: close
// ---------------------------------------------------------------------------
// 兼容性：同时支持旧格式（response/thinking_content、response/content、response/status）
export function createDeepSeekParser() {
  let path = "";
  let lastFragType = null;
  let finished = false;
  let error = null;
  let usage = 0;
  let modelType = null;
  let conversationMode = null;
  let searchStatus = null;
  let searchResults = null;
  let searchQueries = null;
  let processStatus = null;

  const isThink = (t) => t === "THINK";
  // fragment 类型语义：
  //   RESPONSE / ANSWER → 正文
  //   THINK             → 思考链
  //   SEARCH            → 联网检索过程（含"搜索到 N 个网页"等状态文本，不是正文）
  //   TOOL / others     → 工具调用过程，同样不计入正文
  const isBody = (t) => !t || t === "RESPONSE" || t === "ANSWER";
  const isProcess = (t) => t === "SEARCH" || t === "TOOL" || t === "TOOL_CALL";

  function handleFragments(frags, emit) {
    for (const f of frags) {
      if (!f || typeof f !== "object") continue;
      if (f.type) lastFragType = f.type;

      // 检索/工具类 fragment：只记录状态与引用来源，绝不混入正文
      if (isProcess(f.type)) {
        if (f.status) processStatus = f.status;
        if (Array.isArray(f.queries)) searchQueries = f.queries;
        if (Array.isArray(f.results)) searchResults = f.results;
        continue;
      }

      const c = f.content;
      if (typeof c !== "string" || !c) continue;
      if (isThink(f.type)) emit({ reasoning: c });
      else if (isBody(f.type)) emit({ content: c });
    }
  }

  function applyPatch(patch, base, emit) {
    if (!patch || typeof patch !== "object") return;

    // BATCH：v 是相对当前 p 的补丁数组；子补丁的基准路径 = 本级路径
    if (patch.o === "BATCH" && Array.isArray(patch.v)) {
      const b = typeof patch.p === "string" ? joinPath(base, patch.p) : base;
      for (const sub of patch.v) applyPatch(sub, b, emit);
      return;
    }

    // 计算本次生效路径：
    //  · 显式带 p → 基于 base 解析
    //  · 不带 p   → 继承 base（BATCH 场景）；顶层帧则继承全局 path
    let effective = path;
    if (typeof patch.p === "string") {
      effective = joinPath(base, patch.p);
    } else if (base) {
      effective = base;
    }
    // 仅在顶层（base 为空）时更新全局 path，避免 BATCH 内的相对路径污染后续帧
    if (!base) path = effective;

    const v = patch.v;
    if (v === undefined) return;

    // 全量响应快照
    if (v && typeof v === "object" && !Array.isArray(v) && v.response) {
      const r = v.response;
      if (r.model_type) modelType = r.model_type;
      if (r.conversation_mode) conversationMode = r.conversation_mode;
      if (Array.isArray(r.fragments)) handleFragments(r.fragments, emit);
      return;
    }

    // fragments 路径（增量）
    if (effective.startsWith("response/fragments")) {
      if (typeof v === "string") {
        // 增量文本归属由「上一个 fragment 类型」决定；
        // 检索/工具过程 fragment 的文本不进入正文
        if (isThink(lastFragType)) emit({ reasoning: v });
        else if (isBody(lastFragType)) emit({ content: v });
        return;
      }
      if (Array.isArray(v)) {
        const looksLikeFrag = v.length && typeof v[0] === "object" && v[0] && ("type" in v[0] || "content" in v[0]);
        if (looksLikeFrag) handleFragments(v, emit);
        else for (const sub of v) applyPatch(sub, "response/fragments", emit);
      }
      return;
    }

    // 经典路径（含旧协议兼容）
    if (effective === "response/thinking_content" || effective === "response/thinking") {
      emit({ reasoning: String(v) });
    } else if (effective === "response/content") {
      emit({ content: String(v) });
    } else if (effective === "response/accumulated_token_usage") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) usage = n;
    } else if (effective === "response/quasi_status" || effective === "response/status") {
      if (v === "FINISHED" || v === "STATUS_FINISHED" || v === "finished") finished = true;
    } else if (effective === "response/search_status") {
      // 联网搜索状态（SEARCHING / FINISHED / 搜索到 N 个网页）——非正文，不能混进回答
      searchStatus = typeof v === "string" ? v : JSON.stringify(v);
    } else if (effective === "response/search_results") {
      // 搜索结果引用来源——同样不计入正文
      searchResults = v;
    } else if (effective === "response/error") {
      error = typeof v === "string" ? v : JSON.stringify(v);
    }
  }

  function joinPath(base, p) {
    if (!p) return base || "";
    // 已经是绝对路径（以 response 开头）
    if (p.startsWith("response")) return p;
    return base ? `${base}/${p}` : p;
  }

  return {
    /** 喂入一行 data: 后的 JSON 文本；返回 {reasoning, content} 增量或 null */
    push(raw) {
      if (raw === "[DONE]") {
        finished = true;
        return null;
      }
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        return null;
      }

      let out = null;
      const emit = (d) => {
        if (!out) out = { reasoning: "", content: "" };
        if (d.reasoning) out.reasoning += d.reasoning;
        if (d.content) out.content += d.content;
      };

      if (Array.isArray(frame)) {
        for (const p of frame) applyPatch(p, "", emit);
      } else if (frame && typeof frame === "object") {
        // 元数据帧
        if ("response_message_id" in frame && "model_type" in frame) {
          modelType = frame.model_type;
        }
        // 错误帧
        if (frame.type === "error") {
          error = frame.content ?? JSON.stringify(frame);
        }
        // 补丁帧
        else if ("v" in frame || "p" in frame) {
          applyPatch(frame, "", emit);
        }
      }
      return out;
    },
    get finished() { return finished; },
    get error() { return error; },
    get usage() { return usage; },
    get modelType() { return modelType; },
    get conversationMode() { return conversationMode; },
    get searchStatus() { return searchStatus; },
  };
}
