// 对话工作台客户端
// ---------------------------------------------------------------------------
// 会话/设定走 services/api.js 的 API（统一鉴权与错误处理），
// 运行一轮对话走 services/stream.js（POST + SSE，EventSource 不支持自定义头）。
import { API } from "./api";
import { streamPost } from "./stream";

export const chatApi = {
  meta: () => API.get("/chat/meta"),
  listSessions: (q) => API.get("/chat/sessions", { params: { q } }),
  createSession: (body) => API.post("/chat/sessions", body),
  getSession: (id) => API.get(`/chat/sessions/${encodeURIComponent(id)}`),
  patchSession: (id, body) => API.put(`/chat/sessions/${encodeURIComponent(id)}`, body),
  deleteSession: (id) => API.del(`/chat/sessions/${encodeURIComponent(id)}`),
  // 重新生成前回退到该消息之前（服务端会删掉这轮问答并重算统计）
  rewind: (id, fromSeq) => API.post(`/chat/sessions/${encodeURIComponent(id)}/rewind`, { fromSeq }),
};

/**
 * 运行一轮对话。
 * 服务端事件：
 *   {type:"start", message}        本轮开始
 *   {type:"part", part}            新增一个 part（text/reasoning/tool/todo/error）
 *   {type:"part_update", id, patch} 更新已有 part（工具状态/输出/待办）
 *   {type:"delta", id, field, delta} 追加文本（正文或思考链）
 *   {type:"todo", todo}            待办清单更新
 *   {type:"done", message, todo, session}
 *   {type:"error", message}
 */
export function runChatStream(body, { token, onEvent, onDone, onError }) {
  return streamPost("/api/chat/run", body, { token, onEvent, onDone, onError });
}
