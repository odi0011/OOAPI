// 轻量 API 封装：统一 baseURL、token 注入、错误提示由调用方处理

const TOKEN_KEY = "ooapi-token";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

async function request(method, path, { body, params, silent, timeoutMs = 30000 } = {}) {
  let url = `/api${path}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, v);
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  // 默认 30s 超时：后端/代理半开连接时 fetch 可能永不落定，
  // 各页 finally 里的 setLoading(false) 就永远不执行（只能刷新整页）。
  // 长耗时接口（如在线更新 apply）传 timeoutMs: 0 关闭超时。
  const ctrl = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw new ApiError("请求超时，请稍后重试", 408);
    throw new ApiError("网络连接失败，请检查网络后重试", 0);
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(`请求失败（HTTP ${res.status}）`, res.status);
  }

  if (!res.ok || json?.success === false) {
    const errMsg = json?.message || `请求失败（HTTP ${res.status}）`;
    // 401：清理登录态并广播，App 层统一跳转登录页
    // 403 且账号被禁用：与 401 同等处理，否则被禁用户会停在页面反复报错
    const disabled = res.status === 403 && /禁用/.test(errMsg);
    if (res.status === 401 || disabled) {
      setToken("");
      try {
        window.dispatchEvent(new CustomEvent("ooapi:unauthorized"));
      } catch {
        /* ignore */
      }
    }
    throw new ApiError(errMsg, res.status, json?.data);
  }
  return json?.data;
}

export const API = {
  get: (p, opts) => request("GET", p, opts),
  post: (p, body, opts) => request("POST", p, { ...opts, body }),
  put: (p, body, opts) => request("PUT", p, { ...opts, body }),
  patch: (p, body, opts) => request("PATCH", p, { ...opts, body }),
  del: (p, opts) => request("DELETE", p, opts),
};

export const API_USER = {
  login: (username, password) => API.post("/user/login", { username, password }),
  register: (username, password) => API.post("/user/register", { username, password }),
  self: () => API.get("/user/self"),
  logout: () => API.post("/user/logout"),
};
