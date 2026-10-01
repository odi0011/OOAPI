// SSE 流式客户端：POST + 鉴权头 + 逐行解析（EventSource 不支持自定义头）
// 返回 { abort() }，通过 handlers 回调派发事件。
import { getToken, setToken } from "./api";

export function streamPost(url, body, handlers = {}) {
  return streamRequest(url, { method: "POST", body }, handlers);
}

// GET 版：用于「重新接上进行中的生成」（服务端回放缓冲后继续推）
export function streamGet(url, handlers = {}) {
  return streamRequest(url, { method: "GET" }, handlers);
}

function streamRequest(url, { method, body }, { onEvent, onDone, onError, token } = {}) {
  const ctrl = new AbortController();

  (async () => {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...((token ?? getToken()) ? { Authorization: `Bearer ${token ?? getToken()}` } : {}),
        },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        // 401 与 api.js 行为对齐：清理登录态并广播，App 层统一跳登录页。
        // 否则流式请求过期后只会停在错误态，不会退出。
        if (res.status === 401) {
          setToken("");
          try {
            window.dispatchEvent(new CustomEvent("ooapi:unauthorized"));
          } catch {
            /* ignore */
          }
        }
        let msg = `请求失败（HTTP ${res.status}）`;
        let data = null;
        try {
          const j = await res.json();
          data = j;
          msg = j?.message || j?.error?.message || msg;
        } catch { /* ignore */ }
        // 403 且账号被禁用：与 401 同等处理（清登录态 + 广播），否则界面只会反复报错
        if (res.status === 403 && /禁用/.test(msg)) {
          setToken("");
          try {
            window.dispatchEvent(new CustomEvent("ooapi:unauthorized"));
          } catch {
            /* ignore */
          }
        }
        const err = new Error(msg);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        let message = "服务器未返回对话事件流，请重试";
        try { const data = await res.json(); message = data?.message || data?.error?.message || message; } catch { /* 非 JSON 响应 */ }
        throw Object.assign(new Error(message), { code: "STREAM_FORMAT" });
      }
      if (!res.body) throw new Error("响应无可读内容流");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let dataLines = [];
      let terminal = false;

      const dispatch = () => {
        if (!dataLines.length) return;
        const payload = dataLines.join("\n").trim();
        dataLines = [];
        if (payload === "[DONE]") { terminal = true; return; }
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          throw Object.assign(new Error("对话事件格式异常，正在确认生成状态"), { code: "STREAM_FORMAT" });
        }
        if (["done", "error", "stopped"].includes(ev.type)) terminal = true;
        // 回调异常走 onError，不能吞掉后再把这轮标成成功。
        onEvent?.(ev);
      };
      const handle = (line) => {
        const t = line.replace(/\r$/, "");
        if (!t) return dispatch();
        if (t.startsWith("data:")) dataLines.push(t.slice(5).replace(/^ /, ""));
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            handle(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
          }
        }
        buf += decoder.decode();
        if (buf.trim()) handle(buf);
        dispatch();
      } finally {
        // 客户端 abort / 回调抛错时归还连接
        reader.cancel().catch(() => {});
      }
      if (!terminal) throw Object.assign(new Error("连接在生成完成前中断，正在确认生成状态"), { code: "STREAM_INTERRUPTED" });
      onDone?.();
    } catch (e) {
      if (e.name === "AbortError") {
        // 切页/刷新只断开订阅，显式停止由 /stop 收尾；abort 不能当成功。
        return;
      }
      onError?.(e);
    }
  })();

  return { abort: () => ctrl.abort() };
}
