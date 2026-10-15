/** 后端统一错误结构：所有失败响应都是这个形状。 */
export interface ApiError {
  message: string;
  code: string;
}

export class ApiRequestError extends Error {
  code: string;
  status: number;
  /**
   * 失败响应里附带的数据。
   * 例如删除媒体文件被拒时（409），这里就是「还被哪些内容引用」的清单 ——
   * 只报一句「删除失败」没法指导用户先处理什么。
   */
  data?: unknown;

  constructor(message: string, code: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

// ---------- 会话失效回调 ----------

/**
 * 这些接口的 401 不是「会话中途失效」，不能触发全局登出跳转：
 *
 *   - `/api/auth/me`  —— 启动时未登录访客必然 401，这是正常状态；
 *   - 登录 / 注册 / 邮箱验证码 —— 401 表示「这次凭据不对」，
 *     要在表单里就地报错，而不是把人踢去登录页。
 */
const SESSION_EXEMPT_PREFIXES = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/providers",
  "/api/auth/email/",
  "/api/auth/oauth/",
];

function isSessionExempt(path: string): boolean {
  return SESSION_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * 会话失效的处理入口。
 *
 * 只有最底层的请求封装知道「这次失败是 401」，但清登录态、弹提示、
 * 跳登录页都要用到 React 树里的路由与 AuthContext —— 这里拿不到。
 * 所以只留一个注册点，由 AuthProvider 挂载时接上。
 */
type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/** 传 null 注销。AuthProvider 卸载时调用，避免持有旧组件的闭包。 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/**
 * 触发一次会话失效处理。
 *
 * 走 apiRequest 的调用点不用管 —— 它自己会调。这个出口是给
 * 绕过 apiRequest 的请求用的：流式响应要自己读 body，没法套那一层，
 * 于是 401 也得自己报上来，否则同一个失效在不同页面表现不一致。
 */
export function reportUnauthorized(): void {
  unauthorizedHandler?.();
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 普通对象会序列化为 JSON；FormData 原样发送（文件上传）。 */
  body?: unknown;
  /** 带上登录 cookie；默认开启，同源请求无需关心。 */
  withCredentials?: boolean;
  /** 注册开关等不能沿用浏览器缓存的请求传 no-store。 */
  cache?: RequestCache;
}

/**
 * 统一请求封装。
 *
 * 登录态只走 HttpOnly cookie（credentials: include）。
 * 不再把 JWT 放进 localStorage，也不再附带 Authorization，
 * 避免脚本能读到令牌、退出或改密后旧 Bearer 仍被发出去。
 * 任何非 2xx 都抛出 ApiRequestError，调用方只需 try/catch，不用判断状态码。
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, withCredentials = true, cache } = options;

  const headers: Record<string, string> = {};
  // FormData 必须让浏览器自己带 boundary 的 Content-Type；
  // 手写 application/json 会让后端解析不出 multipart。
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isFormData) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      cache,
      credentials: withCredentials ? "include" : "same-origin",
      body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError("网络连接失败，请检查网络后重试", "network_error", 0);
  }

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 后端异常时可能返回 HTML（例如反代错误页），统一按服务器错误处理。
      if (!res.ok) {
        throw new ApiRequestError("服务器返回了异常响应", "bad_response", res.status);
      }
      throw new ApiRequestError("响应解析失败", "parse_error", res.status);
    }
  }

  if (!res.ok) {
    const err = (payload as { error?: ApiError } | null)?.error;
    const data = (payload as { data?: unknown } | null)?.data;
    // 先通知会话失效，再抛异常：
    // 调用方各自 catch 后可能只把 message 渲染成一行小字，
    // 光靠它们没人会把用户送回登录页。
    // 回调是同步的、且自身有一次性闸门 —— 轮询并发出的
    // 多个 401 只会触发一次跳转。
    if (res.status === 401 && !isSessionExempt(path)) {
      reportUnauthorized();
    }
    throw new ApiRequestError(
      err?.message ?? `请求失败（${res.status}）`,
      err?.code ?? "unknown",
      res.status,
      data,
    );
  }

  // 后端成功响应统一包一层 { success, data }，这里直接把 data 交给调用方。
  const data = (payload as { data?: T } | null)?.data;
  return (data ?? (payload as T)) as T;
}

// ---------- 令牌本地存储 ----------

const TOKEN_KEY = "ooapi_token";

// 启动时清掉历史页面留下的 JWT。会话改由 cookie 承担，留着会被旧逻辑继续使用。
clearStoredToken();

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 可能不可用，此时依赖 cookie。
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 忽略：cookie 仍然有效 */
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 忽略 */
  }
}
