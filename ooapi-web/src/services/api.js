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

async function request(method, path, { body, params, silent } = {}) {
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

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(`请求失败（HTTP ${res.status}）`, res.status);
  }

  if (!res.ok || json?.success === false) {
    // 401：清理登录态，交由 App 处理跳转
    throw new ApiError(json?.message || `请求失败（HTTP ${res.status}）`, res.status, json?.data);
  }
  return json?.data;
}

export const API = {
  get: (p, opts) => request("GET", p, opts),
  post: (p, body, opts) => request("POST", p, { ...opts, body }),
  put: (p, body, opts) => request("PUT", p, { ...opts, body }),
  del: (p, opts) => request("DELETE", p, opts),
};

export const API_USER = {
  login: (username, password) => API.post("/user/login", { username, password }),
  register: (username, password) => API.post("/user/register", { username, password }),
  self: () => API.get("/user/self"),
  logout: () => API.post("/user/logout"),
};
