// Kimi Connect RPC 帧解析器
// ---------------------------------------------------------------------------
// 帧格式：[1B flags][4B big-endian length][payload(JSON)]
// 响应事件结构（实测确认）：
//   { mask: "block.text" | "block.think", block: { text: {content}, think: {content} }, ... }
//   { chat: {id} }                       → 会话 id
//   { message: {id, role: "assistant"} } → 下一轮 parent_id
//   { heartbeat: {} }                    → 心跳，忽略
//   { done: {} }                         → 结束
//   { error: {message} }
//
// 增量规则：按 mask 判断落在思考还是正文。
// 注意：Kimi 的 text/think.content 是**增量片段**（非全量），直接拼接。
import { gunzipSync } from "node:zlib";

export function createKimiParser() {
  const state = {
    reasoning: "",
    content: "",
    chatId: null,
    messageId: null,
    finished: false,
    error: null,
    usage: 0,
    stage: null,
  };

  return {
    /** 处理单个事件对象 */
    handle(ev) {
      if (!ev || typeof ev !== "object") return null;

      if (ev.chat?.id) state.chatId = ev.chat.id;
      if (ev.message?.id && ev.message.role === "assistant") state.messageId = ev.message.id;
      // 只有 done === true 才算结束。历史 bug：`!== undefined` 会让任何带 done:false 的
      // 阶段帧/心跳帧直接结束流，回答被截断却按成功计费。
      if (ev.done === true) state.finished = true;
      if (ev.error) {
        state.error = ev.error.message || ev.error.msg || JSON.stringify(ev.error).slice(0, 200);
      }
      if (ev.usage) {
        const n = Number(ev.usage.total_tokens ?? ev.usage.completion_tokens ?? 0);
        if (Number.isFinite(n) && n > 0) state.usage = n;
      }

      // 阶段标记：multiStage.stages[0].name === "STAGE_NAME_THINKING"
      const stages = ev.block?.multiStage?.stages;
      if (Array.isArray(stages) && stages[0]) {
        state.stage = stages[0].name;
        if (stages[0].status === "completed" && /THINKING/i.test(stages[0].name || "")) {
          state.stage = "ANSWER";
        }
      }

      let reasoning = "";
      let content = "";

      // 优先按 mask 判断
      const mask = String(ev.mask || "");
      const block = ev.block || {};

      const thinkText = block.think?.content;
      const bodyText = block.text?.content;

      if (typeof thinkText === "string" && thinkText) {
        reasoning += thinkText;
      }
      if (typeof bodyText === "string" && bodyText) {
        // block.text.flags === "thinking" 时也算思考（双信号）
        if (block.text?.flags === "thinking" || /STAGE_NAME_THINKING/i.test(state.stage || "")) {
          reasoning += bodyText;
        } else {
          content += bodyText;
        }
      }

      // mask 兜底：只有 mask 明确指向某一侧且上面没抓到内容时
      if (!reasoning && !content && mask) {
        if (/block\.think/.test(mask) && typeof thinkText === "string") reasoning += thinkText;
        if (/block\.text/.test(mask) && typeof bodyText === "string") content += bodyText;
      }

      if (reasoning) state.reasoning += reasoning;
      if (content) state.content += content;
      if (!reasoning && !content) return null;
      return { reasoning, content };
    },
    get reasoning() { return state.reasoning; },
    get content() { return state.content; },
    get chatId() { return state.chatId; },
    get messageId() { return state.messageId; },
    get finished() { return state.finished; },
    get error() { return state.error; },
    get usage() { return state.usage; },
  };
}

/**
 * 帧解码器：把字节流切成事件对象
 * 用法：const dec = createFrameDecoder(); for (chunk of chunks) dec.push(chunk) → 事件数组
 */
export function createFrameDecoder() {
  let buf = Buffer.alloc(0);
  // 帧长度上限：损坏/恶意流不能让缓冲区无限增长（内存 DoS）
  const MAX_FRAME = 16 * 1024 * 1024;

  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      const events = [];
      while (buf.length >= 5) {
        const flags = buf[0];
        const len = buf.readUInt32BE(1);
        if (len > MAX_FRAME) {
          // 长度明显非法：丢弃已缓冲数据，避免越等越坏
          buf = Buffer.alloc(0);
          throw Object.assign(new Error(`上游帧长度异常（${len} 字节）`), { code: "CHANNEL_BAD_RESPONSE" });
        }
        if (buf.length < 5 + len) break;
        const payload = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);

        // Connect 协议信封：flags 位 0x01 = 压缩（gzip），0x02 = 结束 trailer。
        // 历史 bug：这里判的是 0x80（并非 Connect 规范里的位），命中后直接丢弃 ——
        // 上游一旦启用压缩就是静默丢内容，表现为「上游有输出但网关报空」。
        // 正确做法是按规范解压；解压失败才跳过该帧，不中断整条流。
        if (flags & 0x02) continue; // Connect end-of-stream trailer
        let body = payload;
        if (flags & 0x01) {
          try {
            body = gunzipSync(payload);
          } catch {
            continue;
          }
        }
        const text = body.toString("utf8").trim();
        if (!text) continue;
        try {
          events.push(JSON.parse(text));
        } catch {
          // 非 JSON（如 trailer 元数据）忽略
        }
      }
      return events;
    },
    /** 流结束后清理残留 */
    flush() {
      const rest = buf.toString("utf8").trim();
      buf = Buffer.alloc(0);
      if (!rest) return [];
      try {
        return [JSON.parse(rest)];
      } catch {
        return [];
      }
    },
  };
}
