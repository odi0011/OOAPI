// 错误只接收服务端公开诊断字段；不能把任意异常对象（可能含请求配置）展开到界面。
const publicFields = ["code", "http_status", "upstream_error_code", "upstream_response"];

export function chatErrorPart(error) {
  const detail = error?.data?.data || error?.data || {};
  const part = { type: "error", message: error?.message || detail.message || "本轮生成失败，请重试" };
  for (const field of publicFields) {
    const value = error?.[field] ?? detail[field];
    if (value !== undefined && value !== null && value !== "") part[field] = value;
  }
  return part;
}

export function chatErrorDetails(part = {}) {
  const message = typeof part.message === "string" ? part.message : typeof part.text === "string" ? part.text : "本轮生成失败，请重试";
  const status = part.http_status || message.match(/HTTP\s+(\d{3})/i)?.[1];
  const metadata = [status ? `HTTP ${status}` : "", part.code, part.upstream_error_code]
    .map((value) => typeof value === "string" || typeof value === "number" ? String(value) : "")
    .filter((value, index, all) => value && all.indexOf(value) === index).join(" · ");
  let response = part.upstream_response;
  // JSON 使用缩进保留原始字段；其他返回保持纯文本，不能按 Markdown/HTML 执行。
  if (typeof response === "string") {
    try { response = JSON.parse(response); } catch { /* 上游也可能返回纯文本错误 */ }
  }
  return {
    message,
    metadata,
    response: response === undefined || response === null ? "" : typeof response === "string" ? response : JSON.stringify(response, null, 2),
  };
}
