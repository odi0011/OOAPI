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
        const err = new Error(msg);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      if (!res.body) throw new Error("响应无可读内容流");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const handle = (line) => {
        const t = line.replace(/\r$/, "");
        if (!t.startsWith("data:")) return;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") return;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          return; // 非 JSON 行（心跳/注释）直接忽略
        }
        try {
          onEvent?.(ev);
        } catch (e) {
          // 业务回调异常不能被当成"非 JSON 行"静默吞掉
          console.error("[stream] onEvent 处理失败：", e);
        }
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
        if (buf.trim()) handle(buf.trim());
      } finally {
        // 客户端 abort / 回调抛错时归还连接
        reader.cancel().catch(() => {});
      }
      onDone?.();
    } catch (e) {
      if (e.name === "AbortError") {
        onDone?.();
        return;
      }
      onError?.(e);
    }
  })();

  return { abort: () => ctrl.abort() };
}
