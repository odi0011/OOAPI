// 网关对外协议适配：把同一份「内部结果」渲染成三种客户端协议
// ===========================================================================
// 支持三种（都是官方 SDK 直连时用的协议）：
//   · /v1/chat/completions  OpenAI Chat Completions（最常见）
//   · /v1/messages          Anthropic Messages（Claude Code / Anthropic SDK）
//   · /v1/responses         OpenAI Responses（Codex / 新版 OpenAI SDK）
//
// 为什么要三套而不是一套：调用方拿到的 SDK 决定了协议 —— 用 Anthropic SDK
// 的客户端只会发 /v1/messages，用 Codex 的只会发 /v1/responses。
// 只提供 chat/completions 时，这两类客户端必须额外装转换层才能接入。
//
// 设计原则：**协议差异只体现在「请求怎么读」与「响应怎么写」两处**，
// 中间的渠道选择、计费、日志、限流全部共用一份实现（在 routes/gateway.js）。
// 绝不能为每个协议复制一份主流程 —— 那是重复扣费/漏记日志的温床。
//
// 每个协议对象提供：
//   parse(body)             → { model, messages, stream, thinking, search } 或抛错
//   done(res, state)        → 流结束时收尾（写终止事件）
//   error(res, status, err) → 出错时按协议格式输出
//   finish(res, data)       → 非流式成功响应
// state 由 openStream(res, id, model) 创建并随请求传递。
import crypto from "node:crypto";

const now = () => Math.floor(Date.now() / 1000);
const newId = (prefix) => `${prefix}-${crypto.randomBytes(12).toString("hex")}`;

/**
 * 解析「输出上限」参数。三种协议各有字段名：
 *   · OpenAI Chat   max_tokens / max_completion_tokens
 *   · Anthropic     max_tokens（官方规范里是**必填**）
 *   · Responses     max_output_tokens
 *
 * 非法值一律当作「没给」（返回 0）而不是抛错 —— 这是**刻意的宽容**：
 * 官方会为 `max_tokens: -1` 回 400，但那会让一批「参数写错但意图明确」的
 * 客户端直接失败；而静默忽略又会让调用方以为生效了（黑盒测试实测吐槽的
 * 正是这一点 —— `max_tokens: 8` 却返回 88 个 token）。
 * 折中：合法值**严格生效**（见 gateway 里的截断实现），
 * 非法值当没给（并在网关日志里留一条 warn）。
 */
function pickMaxTokens(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 把 Anthropic 的 content（string | [{type,text}]）压成纯文本。
 *
 * ⚠️ 图片块在这里只留 `[图片]` 占位（base64 塞进 prompt 会撑爆上下文），
 * 但**真正的图片数据必须另行取出**交给适配器 —— 见
 * `extractImagesFromAnthropicContent`。早先只拍平、没有取出，
 * 造成两个真实缺陷（黑盒测试实测）：
 *   ① 图片被静默丢弃：Anthropic SDK 传图 → 200 + 一个凭空编的回答，
 *      调用方完全不知道图没送到（实测模型回答「我目前看不到你发的图片」）；
 *   ② 图片数量防护被绕过：网关的 MAX_REMOTE_IMAGES（防外链抓取的 SSRF/DoS）
 *      是按 `part.type === "image_url"` 数的，拍平后一个都数不到 ——
 *      10 张外链图在 /v1/messages 上照常放行，而 /v1/chat/completions 会正确拒绝。
 */
function anthropicText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b?.type === "text") return b.text || "";
        // 图片不再留文本占位：数据已作为独立分片保留（见 extractImagesFromAnthropicContent），
        // 再写 [图片] 会让模型在同一处看到"占位符 + 真实图片"两份语义（实测出现过
        // 模型回答「你发了 30 次 [object Object] 这样的文本，以及 30 张相同的图片」）。
        if (b?.type === "image") return "";
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * 从 Anthropic 的 content 取出图片 → 转成网关统一的 OpenAI `image_url` 片。
 * 支持 base64（内嵌）与 url（外链）两种 source。
 * 这样 `/v1/messages` 的图片与 `/v1/chat/completions` 走**完全同一条**处理链：
 * 同样计数、同样抓取、同样受限。
 */
export function extractImagesFromAnthropicContent(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || typeof b !== "object" || b.type !== "image") continue;
    const src = b.source || {};
    if (src.type === "base64" && src.data) {
      out.push({
        type: "image_url",
        image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` },
      });
    } else if (src.type === "url" && src.url) {
      out.push({ type: "image_url", image_url: { url: String(src.url) } });
    }
  }
  return out;
}

/** 同上，供 Responses 协议的 input_image 用 */
export function extractImagesFromResponsesInput(input) {
  const out = [];
  if (typeof input === "string") return out;
  for (const it of Array.isArray(input) ? input : []) {
    if (!it || typeof it !== "object" || !Array.isArray(it.content)) continue;
    for (const c of it.content) {
      if (!c || typeof c !== "object") continue;
      if (c.type !== "input_image" && c.type !== "image_url") continue;
      const url = c.image_url ?? c.url ?? "";
      if (typeof url === "string" && url) out.push({ type: "image_url", image_url: { url } });
      else if (url && typeof url === "object" && url.url) {
        out.push({ type: "image_url", image_url: { url: String(url.url) } });
      }
    }
  }
  return out;
}

/** 把 Responses 的 input（string | [{role,content}]）转成标准 messages */
function responsesInput(body) {
  const out = [];
  // Responses 协议的**顶层 instructions 等价于 system 提示词**（官方文档：
  // "instructions: A system (or developer) message inserted into the model's context"）。
  // 它不在 input 里。早先只解析 input，等于把系统约束整段丢掉 —— 用 Responses SDK
  // 的调用方看到的是「模型不遵守系统指令」，而且不报任何错，极难归因。
  const instructions = body?.instructions;
  if (typeof instructions === "string" && instructions.trim()) {
    out.push({ role: "system", content: instructions });
  } else if (Array.isArray(instructions)) {
    const t = instructions
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .join("")
      .trim();
    if (t) out.push({ role: "system", content: t });
  }
  const input = body?.input;
  if (typeof input === "string") {
    out.push({ role: "user", content: input });
    return out;
  }
  if (!Array.isArray(input)) return out;
  for (const it of input) {
    if (typeof it === "string") {
      out.push({ role: "user", content: it });
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const role = String(it.role || "user");
    // Responses 的 content 可能是 string 或 [{type:"input_text",text}] 等
    let text = "";
    if (typeof it.content === "string") text = it.content;
    else if (Array.isArray(it.content)) {
      text = it.content
        .map((c) => (typeof c === "string" ? c : c?.type === "input_image" ? "" : c?.text || ""))
        .join("");
    }
    // 图片同样要作为标准分片保留（否则被静默丢弃 + 绕过数量防护）
    const imgs = extractImagesFromResponsesInput([it]);
    if (!text && !imgs.length) continue;
    out.push({
      role,
      content: imgs.length ? [{ type: "text", text }, ...imgs] : text,
    });
  }
  return out;
}

/* ============================ ① Chat Completions ============================ */
const chatCompletions = {
  name: "chat.completions",
  parse(body) {
    const model = String(body?.model || "");
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    // 输出上限：官方两个字段都认（max_completion_tokens 是较新的名字）
    const maxTokens = pickMaxTokens(
      body?.max_tokens !== undefined ? body.max_tokens : body?.max_completion_tokens
    );
    return { model, messages, stream: body?.stream === true, maxTokens };
  },
  openStream(res, id, model) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    const send = (delta, finishReason = null, extra = null, emptyChoices = false) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: now(),
          model,
          // usage 帧按 OpenAI 规范要求 `choices: []`（空数组，不是含空 delta 的一项）——
          // 客户端据此区分「这是结尾的用量帧」而不是「一个空的正文增量」。
          choices: emptyChoices ? [] : [{ index: 0, delta, finish_reason: finishReason }],
          ...(extra || {}),
        })}\n\n`
      );
    };
    send({ role: "assistant" });
    return { send };
  },
  delta(state, text) {
    state.send({ content: text });
  },
  reasoning(state, text) {
    state.send({ reasoning_content: text });
  },
  done(res, state, { settled } = {}) {
    // 被输出上限截断时必须回 "length"，这是 OpenAI 协议里客户端判断
    // 「回答没写完」的唯一信号（原先永远是 "stop"）。
    state.send({}, settled?.truncated ? "length" : "stop");
    // **usage 帧**：OpenAI 流式协议里，量在最后一个 chunk 上（`choices` 为空数组），
    // 且仅在请求带 `stream_options.include_usage` 时才有。
    //
    // 为什么必须补（两个独立人格都实测报过，其中一个是专业开发者）：
    //   老王：「流式响应完全没有 usage / 计费字段。逐 chunk 数过：
    //          data 行 102 | 含 usage: 0 | 含 x_od_cost: 0。非流式有完整字段。
    //          **流式是推荐用法，却最不透明** —— 写多用户工具时账单延迟出现，
    //          用户端用量和后端记录对不上，没法解释。」
    //   Alex 的原始报告同源：`stream_options.include_usage` 接受但从不返回 usage 帧，
    //   导致流式下无法做 token 记账，只能再补一次非流式调用 —— 而数据本来就有。
    //
    // 这里**无条件发**（不判断 include_usage）：多一帧 usage 不会破坏任何客户端
    //（官方 SDK 遇到末尾空 choices 的 usage 帧是标准处理路径），
    // 而按需发会让「忘了加参数」的调用方继续拿不到数 —— 他们当初就是这么丢的。
    if (settled) {
      state.send([], null, {
        usage: {
          prompt_tokens: settled.promptTokens || 0,
          completion_tokens: settled.completionTokens || 0,
          total_tokens: (settled.promptTokens || 0) + (settled.completionTokens || 0),
          ...(settled.cacheTokens ? { prompt_tokens_details: { cached_tokens: settled.cacheTokens } } : {}),
        },
        // 本平台的扩展字段：与非流式响应保持同名同义（便于统一记账）
        x_od_cost: settled.od,
        x_currency: settled.currency,
        x_channel: settled.channel,
        x_latency_ms: settled.elapsed,
      }, true); // ← 第 4 个参数：空 choices（usage 帧的规范形状）
    }
    res.write("data: [DONE]\n\n");
    res.end();
  },
  finish(res, { id, model, content, reasoning, settled }) {
    res.json({
      id,
      object: "chat.completion",
      created: now(),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          // 截断时回 "length"（OpenAI 规范），否则 "stop"
          finish_reason: settled?.truncated ? "length" : "stop",
        },
      ],
      usage: {
        prompt_tokens: settled.promptTokens,
        completion_tokens: settled.completionTokens,
        total_tokens: settled.promptTokens + settled.completionTokens,
        ...(settled.cacheTokens ? { prompt_tokens_details: { cached_tokens: settled.cacheTokens } } : {}),
      },
      x_od_cost: settled.od,
      x_currency: settled.currency,
      x_channel: settled.channel,
      x_latency_ms: settled.elapsed,
    });
  },
  error(res, status, err, { id } = {}) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: err.code, code: err.code } })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.status(status).json({ error: { message: err.message, type: err.code, code: err.code } });
  },
  /** 已经开流但因错结束：补一个终止事件 */
  errorInStream(res, state, err) {
    state.send({}, null);
    res.write(`data: ${JSON.stringify({ error: { message: err.message, type: err.code } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  },
};

/* ============================= ② Anthropic Messages ============================= */
const anthropicMessages = {
  name: "messages",
  parse(body) {
    const model = String(body?.model || "");
    const msgs = [];
    // Anthropic 把 system 放在**顶层**，不是 messages 里的一条 —— 必须单独处理，
    // 否则 system 提示词会整段丢失（表现是「模型不遵守系统指令」）。
    if (body?.system) {
      const sys = typeof body.system === "string" ? body.system : anthropicText(body.system);
      if (sys) msgs.push({ role: "system", content: sys });
    }
    for (const m of Array.isArray(body?.messages) ? body.messages : []) {
      if (!m || typeof m !== "object") continue;
      const text = anthropicText(m.content);
      // **图片要作为标准 content 分片保留下来**（而不是只留 "[图片]" 占位）。
      // 网关的图片计数/抓取/限额全靠 `type === "image_url"` 的分片 ——
      // 只给纯文本的话图片会被静默丢弃、防护也一并失效（见 anthropicText 的说明）。
      const imgs = extractImagesFromAnthropicContent(m.content);
      if (!text && !imgs.length) continue;
      msgs.push({
        role: String(m.role || "user"),
        content: imgs.length
          ? [{ type: "text", text }, ...imgs]
          : text,
      });
    }
    // Anthropic 的 max_tokens 在官方规范里是**必填**。这里不强制（宽容旧客户端），
    // 但给了就按它截断。
    return { model, messages: msgs, stream: body?.stream === true, maxTokens: pickMaxTokens(body?.max_tokens) };
  },
  openStream(res, id, model) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    // Anthropic 的 SSE 带 event: 行，且事件类型在 body 里也要有 type 字段
    const send = (type, payload) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    };
    send("message_start", {
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    // 这里**不**声明 content_block：块的类型要等第一段增量到达才知道是 thinking
    // 还是 text。原先先声明一个 text 块、随后往同一个块里塞 thinking_delta ——
    // 那不是合法协议（thinking_delta 只允许出现在 thinking 块内），Anthropic SDK
    // 会把它当坏消息丢掉，思考内容整段看不见。改为按需开块（见 openBlock）。
    return { send, started: true, blockCount: 0, cur: null };
  },
  /**
   * 按需开启内容块，返回块下标。
   * Anthropic 的流式协议要求每个块自成一段且块内类型单一：thinking 块只发
   * thinking_delta，文本块只发 text_delta。两类内容混进一个块 = 非法协议。
   */
  openBlock(state, type) {
    if (state.cur === type) return state.blockCount - 1;
    if (state.cur) state.send("content_block_stop", { index: state.blockCount - 1 });
    const index = state.blockCount++;
    state.cur = type;
    state.send("content_block_start", {
      index,
      content_block:
        type === "thinking"
          ? // 与官方流式一致：起始块带空 thinking / 空 signature，内容随后增量补
            { type: "thinking", thinking: "", signature: "" }
          : { type: "text", text: "" },
    });
    return index;
  },
  delta(state, text) {
    const i = anthropicMessages.openBlock(state, "text");
    state.send("content_block_delta", { index: i, delta: { type: "text_delta", text } });
  },
  reasoning(state, text) {
    const i = anthropicMessages.openBlock(state, "thinking");
    state.send("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: text } });
  },
  done(res, state, { settled } = {}) {
    // 空回复也要有一个块：客户端拿到「一个 content block 都没有的 message」
    // 时部分 SDK 会判为解析失败。
    if (!state.cur) anthropicMessages.openBlock(state, "text");
    state.send("content_block_stop", { index: state.blockCount - 1 });
    state.send("message_delta", {
      // 截断时回 "max_tokens"（Anthropic 规范），否则 "end_turn"
      delta: { stop_reason: settled?.truncated ? "max_tokens" : "end_turn", stop_sequence: null },
      usage: {
        input_tokens: settled?.promptTokens || 0,
        output_tokens: settled?.completionTokens || 0,
      },
    });
    state.send("message_stop", {});
    res.end();
  },
  finish(res, { id, model, content, reasoning, settled }) {
    res.json({
      id,
      type: "message",
      role: "assistant",
      model,
      content: [
        // 思考内容作为独立的 thinking 块返回。原先非流式**完全丢弃** reasoning ——
        // 用 Anthropic SDK 的调用方（Claude Code 等）开了思考却什么都看不到，
        // 也不报错，属于静默丢数据。
        ...(reasoning ? [{ type: "thinking", thinking: reasoning, signature: "" }] : []),
        { type: "text", text: content },
      ],
      // 截断时回 "max_tokens"（Anthropic 规范）
      stop_reason: settled?.truncated ? "max_tokens" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: settled.promptTokens,
        output_tokens: settled.completionTokens,
        ...(settled.cacheTokens
          ? { cache_read_input_tokens: settled.cacheTokens }
          : {}),
      },
      x_od_cost: settled.od,
      x_currency: settled.currency,
      x_channel: settled.channel,
      x_latency_ms: settled.elapsed,
    });
  },
  error(res, status, err) {
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: err.code, message: err.message } })}\n\n`);
      return res.end();
    }
    // Anthropic 的错误体是 {type:"error", error:{type,message}}
    res.status(status).json({
      type: "error",
      error: { type: err.code || "api_error", message: err.message },
    });
  },
  errorInStream(res, state, err) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: err.code, message: err.message } })}\n\n`);
    res.end();
  },
};

/* ============================= ③ OpenAI Responses ============================= */
const openaiResponses = {
  name: "responses",
  parse(body) {
    const model = String(body?.model || "");
    const messages = responsesInput(body);
    // Responses 的流式开关是 stream；部分客户端不传则视为非流式
    return {
      model,
      messages,
      stream: body?.stream === true,
      maxTokens: pickMaxTokens(body?.max_output_tokens),
    };
  },
  openStream(res, id, model) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    const itemId = newId("msg");
    const createdAt = now();
    const send = (type, payload) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    };
    // 一个 response 对象的形状只在这里定义一次：created 与 completed 必须给出
    // 同一组字段（id/object/created_at/model/output/...）。官方 SDK（如 Codex 用
    // 的 openai-node）在 response.completed 时用事件里的对象**替换**本地累积的
    // response；若完成事件只有 status/usage，替换后 id、model、output 全变成
    // undefined —— 表现为「流式跑完了但拿不到文本/模型名」。
    const respBase = () => ({ id, object: "response", created_at: createdAt, model });
    send("response.created", {
      response: { ...respBase(), status: "in_progress", output: [] },
    });
    send("response.output_item.added", {
      output_index: 0,
      item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    send("response.content_part.added", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return { send, itemId, id, text: "", reasoning: "", createdAt, model };
  },
  delta(state, text) {
    state.text += text;
    state.send("response.output_text.delta", {
      item_id: state.itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
  },
  reasoning(state, text) {
    // Responses 把思考放在 reasoning summary 事件里
    state.reasoning = (state.reasoning || "") + text;
    state.send("response.reasoning_summary_text.delta", {
      item_id: state.itemId,
      output_index: 0,
      summary_index: 0,
      delta: text,
    });
  },
  done(res, state, { settled } = {}) {
    const text = state.text || "";
    const reasoning = state.reasoning || "";
    state.send("response.output_text.done", {
      item_id: state.itemId,
      output_index: 0,
      content_index: 0,
      text,
    });
    state.send("response.content_part.done", {
      item_id: state.itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    const messageItem = {
      id: state.itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    state.send("response.output_item.done", { output_index: 0, item: messageItem });
    // 与 openStream 的 respBase 保持同一组字段；output 为最终产物列表
    // （有思考时先放 reasoning 项，与 finish 的非流式形状一致）
    // 截断时走 response.incomplete（Responses 协议里没有 finish_reason，
    // 状态从 completed 变成 incomplete 就是「没写完」的信号）
    state.send(settled?.truncated ? "response.incomplete" : "response.completed", {
      response: {
        id: state.id,
        object: "response",
        created_at: state.createdAt,
        status: settled?.truncated ? "incomplete" : "completed",
        ...(settled?.truncated
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
        model: state.model,
        output: [
          ...(reasoning ? [{ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] }] : []),
          messageItem,
        ],
        usage: {
          input_tokens: settled?.promptTokens || 0,
          output_tokens: settled?.completionTokens || 0,
          total_tokens: (settled?.promptTokens || 0) + (settled?.completionTokens || 0),
        },
      },
    });
    res.end();
  },
  finish(res, { id, model, content, reasoning, settled }) {
    res.json({
      id,
      object: "response",
      created_at: now(),
      status: settled?.truncated ? "incomplete" : "completed",
      ...(settled?.truncated
        ? { incomplete_details: { reason: "max_output_tokens" } }
        : {}),
      model,
      output: [
        ...(reasoning
          ? [{ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] }]
          : []),
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: content, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: settled.promptTokens,
        output_tokens: settled.completionTokens,
        total_tokens: settled.promptTokens + settled.completionTokens,
        ...(settled.cacheTokens ? { input_tokens_details: { cached_tokens: settled.cacheTokens } } : {}),
      },
      x_od_cost: settled.od,
      x_currency: settled.currency,
      x_channel: settled.channel,
      x_latency_ms: settled.elapsed,
    });
  },
  error(res, status, err) {
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", code: err.code, message: err.message })}\n\n`);
      return res.end();
    }
    res.status(status).json({ error: { message: err.message, type: err.code, code: err.code } });
  },
  errorInStream(res, state, err) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: "error", code: err.code, message: err.message })}\n\n`);
    res.end();
  },
};

export const PROTOCOLS = {
  chat: chatCompletions,
  messages: anthropicMessages,
  responses: openaiResponses,
};

export const PROTOCOL_LIST = Object.values(PROTOCOLS).map((p) => p.name);
