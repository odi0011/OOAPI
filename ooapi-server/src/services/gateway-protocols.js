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

/** 把 Anthropic 的 content（string | [{type,text}]）压成纯文本 */
function anthropicText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b?.type === "text") return b.text || "";
        // 图片块在这里只保留占位说明：网关的多模态支持在各适配器里，
        // 这里不该把 base64 塞进 prompt（会撑爆上下文且适配器不认）。
        if (b?.type === "image") return "[图片]";
        return "";
      })
      .join("");
  }
  return "";
}

/** 把 Responses 的 input（string | [{role,content}]）转成标准 messages */
function responsesInput(body) {
  const input = body?.input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const out = [];
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
        .map((c) => (typeof c === "string" ? c : c?.text || ""))
        .join("");
    }
    if (text) out.push({ role, content: text });
  }
  return out;
}

/* ============================ ① Chat Completions ============================ */
const chatCompletions = {
  name: "chat.completions",
  parse(body) {
    const model = String(body?.model || "");
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    return { model, messages, stream: body?.stream === true };
  },
  openStream(res, id, model) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    const send = (delta, finishReason = null) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: now(),
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
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
  done(res, state) {
    state.send({}, "stop");
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
          finish_reason: "stop",
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
      if (!text) continue;
      msgs.push({ role: String(m.role || "user"), content: text });
    }
    return { model, messages: msgs, stream: body?.stream === true };
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
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    return { send, started: true };
  },
  delta(state, text) {
    state.send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  },
  reasoning(state, text) {
    // Anthropic 协议里思考内容走 thinking block；这里用 text_delta 表达会污染正文，
    // 所以显式发出 thinking_delta（客户端不认识时会忽略，正文仍正确）。
    state.send("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: text } });
  },
  done(res, state, { settled } = {}) {
    state.send("content_block_stop", { index: 0 });
    state.send("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens: settled?.promptTokens || 0,
        output_tokens: settled?.completionTokens || 0,
      },
    });
    state.send("message_stop", {});
    res.end();
  },
  finish(res, { id, model, content, settled }) {
    res.json({
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
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
    return { model, messages, stream: body?.stream === true };
  },
  openStream(res, id, model) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    const itemId = newId("msg");
    const send = (type, payload) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    };
    send("response.created", {
      response: { id, object: "response", status: "in_progress", model, output: [] },
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
    return { send, itemId, text: "" };
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
    state.send("response.reasoning_summary_text.delta", {
      item_id: state.itemId,
      output_index: 0,
      summary_index: 0,
      delta: text,
    });
  },
  done(res, state, { settled } = {}) {
    const text = state.text || "";
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
    state.send("response.output_item.done", {
      output_index: 0,
      item: { id: state.itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] },
    });
    state.send("response.completed", {
      response: {
        status: "completed",
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
      status: "completed",
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
