// AWS EventStream 解析器（Kiro / CodeWhisperer 的 application/vnd.amazon.eventstream）
// ---------------------------------------------------------------------------
// 帧格式（AWS EventStream，与 SSE 完全不同）：
//   [4B total_len][4B headers_len][4B prelude_crc]
//   [headers...][payload...][4B message_crc]
// header: [1B name_len][name][1B type][value]（type=7 字符串为 [2B len][bytes]）
// 只做解析不做 CRC 校验（与各大开源网关一致：CRC 用于校验，不参与路由）。
const HEADER = {
  BOOL_TRUE: 0,
  BOOL_FALSE: 1,
  BYTE: 2,
  SHORT: 3,
  INT: 4,
  LONG: 5,
  BYTES: 6,
  STRING: 7,
  TIMESTAMP: 8,
  UUID: 9,
};

function parseHeaders(buf) {
  const headers = {};
  let i = 0;
  while (i < buf.length) {
    const nameLen = buf.readUInt8(i);
    i += 1;
    if (i + nameLen > buf.length) break;
    const name = buf.toString("utf8", i, i + nameLen);
    i += nameLen;
    if (i >= buf.length) break;
    const type = buf.readUInt8(i);
    i += 1;
    let value = "";
    switch (type) {
      case HEADER.BOOL_TRUE:
        value = true;
        break;
      case HEADER.BOOL_FALSE:
        value = false;
        break;
      case HEADER.BYTE:
        value = buf.readInt8(i);
        i += 1;
        break;
      case HEADER.SHORT:
        value = buf.readInt16BE(i);
        i += 2;
        break;
      case HEADER.INT:
        value = buf.readInt32BE(i);
        i += 4;
        break;
      case HEADER.LONG:
        value = Number(buf.readBigInt64BE(i));
        i += 8;
        break;
      case HEADER.TIMESTAMP:
        value = Number(buf.readBigInt64BE(i));
        i += 8;
        break;
      case HEADER.UUID:
        i += 16;
        break;
      case HEADER.BYTES: {
        const len = buf.readUInt16BE(i);
        i += 2 + len;
        break;
      }
      case HEADER.STRING: {
        const len = buf.readUInt16BE(i);
        i += 2;
        value = buf.toString("utf8", i, i + len);
        i += len;
        break;
      }
      default:
        // 未知类型：无法安全跳长度，直接结束本帧头解析
        return headers;
    }
    headers[name] = value;
  }
  return headers;
}

/**
 * 创建增量解析器。push(chunk) 返回本次解析出的完整事件数组：
 *   [{ type, payload, messageType }]（type 来自 :event-type；payload 为 JSON.parse 后的对象）
 */
export function createAwsEventStreamParser({ maxFrame = 16 * 1024 * 1024 } = {}) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      const out = [];
      for (;;) {
        if (buf.length < 12) break;
        const totalLen = buf.readUInt32BE(0);
        const headersLen = buf.readUInt32BE(4);
        if (totalLen < 16 || totalLen > maxFrame) {
          // 长度非法：丢弃缓冲，避免无限等待损坏数据
          buf = Buffer.alloc(0);
          throw Object.assign(new Error(`Kiro 事件帧长度异常（${totalLen}）`), { code: "CHANNEL_BAD_RESPONSE" });
        }
        if (buf.length < totalLen) break;
        const frame = buf.subarray(0, totalLen);
        buf = buf.subarray(totalLen);

        const headerStart = 12;
        const headerEnd = headerStart + headersLen;
        if (headerEnd > frame.length - 4) continue;
        const headers = parseHeaders(frame.subarray(headerStart, headerEnd));
        const payloadBuf = frame.subarray(headerEnd, frame.length - 4);
        let payload = null;
        if (payloadBuf.length) {
          try {
            payload = JSON.parse(payloadBuf.toString("utf8"));
          } catch {
            payload = { raw: payloadBuf.toString("utf8").slice(0, 500) };
          }
        }
        out.push({
          type: String(headers[":event-type"] || ""),
          messageType: String(headers[":message-type"] || "event"),
          payload,
        });
      }
      return out;
    },
    flush() {
      buf = Buffer.alloc(0);
    },
  };
}
