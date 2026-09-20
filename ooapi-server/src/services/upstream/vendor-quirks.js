// OpenAI 兼容厂商的特化处理（请求注入 / 响应归一）
// ===========================================================================
// 为什么单独一个文件：openai-compat.js 是所有 API 渠道的公共路径，
// 把各厂商的怪癖塞进去会让它越来越难读。这里按「厂商一批差异」组织，
// 主流程只在两处调用：
//   · applyVendorRequest(body, { channelType, model })  —— 发请求前
//   · normalizeVendorStream/Response(...)               —— 收响应后
//
// 只收录**有真实协议差异且会影响正确性**的项。像「某些参数被忽略」这类
// 不影响结果的不处理（免得变成一堆无用分支）。
//
// 依据（各厂商官方文档，2026-09 核对）：
//   ① MiniMax：`reasoning_split` 默认关闭时思维链以 <think> 标签**混在 content 里**。
//      不开启的话，下游会把思考内容当正文渲染 —— 这是会影响用户体验的实质差异。
//   ② 火山方舟：响应 `service_status.model_fallback` 会告知实际生效的模型。
//      方舟在容量紧张时自动降级到别的模型跑；不读它就会「按 A 的价收 B 的钱」。
//   ③ 阶跃星辰：同时返回 `reasoning` 与 `reasoning_content` 两个字段，
//      且 `step-3.5-flash-2603` 只接受 reasoning_effort = low/high（传 medium 报错）。
//   ④ 小米 MiMo：思考模式下忽略 temperature/top_p（传了不生效，无害，不处理）。
//      但响应里可能同时给 tool_calls 与 reasoning_content，基座已能处理。
//
// 注意：**判据是 channel.type（渠道类型），不是 base_url**。
// 用户可能把官方的 base_url 换到自建中转上，按 URL 判断会误伤。
// 所以下面按渠道类型分发；同时提供按 base_url 的兜底探测（用于「自定义」渠道
// 直接填了某家官方地址的情况）。

/** 从 base_url 推测厂商（仅用于「自定义」渠道） */
export function guessVendorFromUrl(baseUrl) {
  const u = String(baseUrl || "").toLowerCase();
  if (u.includes("minimax")) return "minimax";
  if (u.includes("volces.com") || u.includes("ark.cn-beijing")) return "ark";
  if (u.includes("stepfun")) return "stepfun";
  if (u.includes("xiaomimimo") || u.includes("mimo.mi.com")) return "mimo";
  return "";
}

/** 解析出「这批请求应该按哪个厂商的差异处理」 */
export function vendorKindOf(channel) {
  const t = String(channel?.type || "").toLowerCase();
  // 渠道类型直接对应（内置厂商渠道）
  const direct = {
    minimax: "minimax",
    ark: "ark",
    doubao: "ark", // 豆包的 API 方式就是火山方舟
    stepfun: "stepfun",
    mimo: "mimo",
  };
  if (direct[t]) return direct[t];
  // 自定义/其它兼容渠道：按 base_url 兜底识别（用户在「自定义」里填了官方地址）
  if (t === "custom" || t === "opencode-zen" || !t) return guessVendorFromUrl(channel?.base_url);
  return "";
}

/**
 * 请求侧注入（在 buildMessages 之后、fetch 之前调用）。
 * 只改 body，不改其它状态；无法识别的厂商原样返回。
 */
export function applyVendorRequest(body, { channel, model } = {}) {
  const kind = vendorKindOf(channel);
  const m = String(model || "").toLowerCase();

  if (kind === "minimax") {
    // ① 强制拆分思维链：不开的话 <think> 会混进正文
    body.reasoning_split = true;
    // ② 参数裁剪：MiniMax 对 temperature 越界**直接报错**（不是忽略），
    //    而平台上游可能传入超出 [0,2] 的值 → 裁到合法区间，避免 400
    if (body.temperature !== undefined) {
      const t = Number(body.temperature);
      if (Number.isFinite(t)) body.temperature = Math.min(2, Math.max(0, t));
    }
    // ③ 官方明确忽略这几个参数（静默），删掉以免被将来的严格校验拒绝
    delete body.presence_penalty;
    delete body.frequency_penalty;
    delete body.logit_bias;
    return body;
  }

  if (kind === "stepfun") {
    // step-3.5-flash-2603 只接受 low/high，传 medium 会 400
    if (m.includes("2603")) {
      const eff = String(body.reasoning_effort || "").toLowerCase();
      if (eff === "medium") body.reasoning_effort = "high";
    }
    // 官方参数表未列出 tool_choice。OpenAI 客户端默认会带它，
    // 为避免不确定行为先剥离（等实测确认被接受后再放开）
    if (body.tool_choice !== undefined && !body.tools) delete body.tool_choice;
    return body;
  }

  if (kind === "ark") {
    // 方舟的思考开关走自己的格式（`thinking: {type}`），
    // 与 OpenAI 的 chat_template_kwargs 不同。基座只在渠道声明 thinking_mode 时注入，
    // 这里把平台统一的 thinking 语义翻译成方舟格式。
    if (body.thinking !== undefined && typeof body.thinking === "boolean") {
      body.thinking = { type: body.thinking ? "enabled" : "disabled" };
    }
    // max_completion_tokens 与 max_tokens 不可同时设置（会 400）
    if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined) {
      delete body.max_tokens;
    }
    return body;
  }

  return body;
}

/**
 * 从响应对象里取出「实际生效的模型名」。
 *
 * 火山方舟会在容量紧张时**自动降级到别的模型**，并在
 * `service_status.model_fallback` 里说明。计费必须以实际模型为准 ——
 * 否则用户请求 pro 被降级到 lite 跑，却按 pro 收费（多收），
 * 或反过来少收。两者都是账目错误。
 *
 * @returns {string} 实际模型名（无法判断时返回空串，调用方沿用请求的 model）
 */
export function effectiveModelOf(ev) {
  if (!ev || typeof ev !== "object") return "";
  const fb = ev.service_status?.model_fallback;
  if (fb && fb.fallback_triggered) {
    // original_model 是「原本想用的」，实际生效的是 ev.model
    return String(ev.model || fb.original_model || "");
  }
  return "";
}

/**
 * 把厂商方言的思维链字段归一成平台口径（reasoning_content / reasoning）。
 * 基座已处理 reasoning_content 与 reasoning，这里补 MiniMax 拆分后的 reasoning_details。
 */
export function reasoningDeltaOf(delta) {
  if (!delta || typeof delta !== "object") return "";
  // MiniMax 开了 reasoning_split 后放在 reasoning_details（数组，元素含 text）
  const rd = delta.reasoning_details;
  if (Array.isArray(rd)) {
    return rd.map((x) => (typeof x === "string" ? x : x?.text || "")).join("");
  }
  if (typeof rd === "string") return rd;
  return "";
}

/**
 * 粘性正文里的 <think> 块（兜底）。
 * 即使开了 reasoning_split=true，个别版本仍可能漏出（或用户用的是中转）。
 * 把 `...` 从正文里剥出来归到思维链，避免思考内容被当正文展示。
 * @returns {{content:string, reasoning:string}}
 */
export function splitThinkTags(text) {
  const s = String(text || "");
  if (!s) return { content: "", reasoning: "" };
  if (!/<\/?think>/i.test(s)) return { content: s, reasoning: "" };
  let content = "";
  let reasoning = "";
  let rest = s;
  // 逐段剥离 <think>...</think>；未闭合的开标签后面的内容全算思考
  for (;;) {
    const open = rest.search(/<think>/i);
    if (open === -1) {
      content += rest;
      break;
    }
    content += rest.slice(0, open);
    const after = rest.slice(open + "<think>".length);
    const close = after.search(/<\/think>/i);
    if (close === -1) {
      reasoning += after; // 未闭合：后面全是思考
      break;
    }
    reasoning += after.slice(0, close);
    rest = after.slice(close + "</think>".length);
  }
  return { content, reasoning };
}
