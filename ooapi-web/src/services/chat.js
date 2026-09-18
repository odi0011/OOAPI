// 对话工作台客户端
// ---------------------------------------------------------------------------
// 会话/设定走 services/api.js 的 API（统一鉴权与错误处理），
// 运行一轮对话走 services/stream.js（POST + SSE，EventSource 不支持自定义头）。
import { API } from "./api";
import { streamPost, streamGet } from "./stream";

export const chatApi = {
  // keyId：按某个密钥的能力算可用模型（分组模型 ∩ 密钥白名单）；0 = 账户默认分组
  meta: (keyId) => API.get("/chat/meta", { params: keyId ? { keyId } : {} }),
  listSessions: ({ q, archived, projectId } = {}) => API.get("/chat/sessions", { params: { q, archived, projectId } }),
  createSession: (body) => API.post("/chat/sessions", body),
  getSession: (id) => API.get(`/chat/sessions/${encodeURIComponent(id)}`),
  patchSession: (id, body) => API.put(`/chat/sessions/${encodeURIComponent(id)}`, body),
  deleteSession: (id) => API.del(`/chat/sessions/${encodeURIComponent(id)}`),
  // 重新生成前回退到该消息之前（服务端会删掉这轮问答并重算统计）
  rewind: (id, fromSeq) => API.post(`/chat/sessions/${encodeURIComponent(id)}/rewind`, { fromSeq }),
  // 显式停止（只有用户点停止才真的中止上游；切页/刷新不会）
  stop: (id) => API.post(`/chat/sessions/${encodeURIComponent(id)}/stop`),
  // 这个会话是否正在生成（刷新后据此决定要不要接回事件流）
  running: (id) => API.get(`/chat/sessions/${encodeURIComponent(id)}/running`),
  // 项目
  listProjects: () => API.get("/chat/projects"),
  createProject: (body) => API.post("/chat/projects", body),
  updateProject: (id, body) => API.put(`/chat/projects/${encodeURIComponent(id)}`, body),
  deleteProject: (id) => API.del(`/chat/projects/${encodeURIComponent(id)}`),
  // 批量：archive/unarchive/pin/unpin/delete/move
  batch: (ids, action, projectId) => API.post("/chat/sessions/batch", { ids, action, projectId }),
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

/**
 * 重新接上进行中的生成（刷新 / 切页回来时用）。
 * 服务端会先回放已缓冲的事件，再续播实时事件，所以界面能无缝恢复；
 * 事件类型多了 {type:"resumed"}（回放开始）与 {type:"stopped"}（用户点了停止）。
 */
export function resumeChatStream(sessionId, { token, onEvent, onDone, onError }) {
  return streamGet(`/api/chat/sessions/${encodeURIComponent(sessionId)}/stream`, { token, onEvent, onDone, onError });
}
