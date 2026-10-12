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
