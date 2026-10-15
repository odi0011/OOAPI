import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

import {
  apiRequest,
  clearStoredToken,
  setUnauthorizedHandler,
} from "@/lib/api";
import { useNotify } from "@/lib/useNotify";
import { can as canFn, type AuthUser, type Permission } from "@/lib/permissions";

interface AuthContextValue {
  user: AuthUser | null;
  /** 首次校验登录态是否还在进行中，用于避免闪一下未登录界面。 */
  loading: boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  register: (input: {
    username: string;
    email: string;
    password: string;
  }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** 能力点判断，用法：can(Perm.UserView) */
  can: (permission: Permission | Permission[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthResponse {
  user: AuthUser;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const notify = useNotify();

  /**
   * 会话失效只处理一次。
   *
   * 看板每 5 秒轮询一批接口，cookie 一过期就是好几个 401 同时回来 ——
   * 没有这道闸门会叠一屏「登录已失效」，跳转也会被反复触发。
   * 重新登录（user 变回非空）时复位，以便下次失效还能正常处理。
   */
  const expired = useRef(false);

  // 回调里要的是「此刻在哪一页」，用 ref 取最新值，
  // 免得把 location 塞进 effect 依赖后每次跳转都重新注册一遍。
  const locationRef = useRef(location);
  locationRef.current = location;

  // 同理：只在「本来有会话」时才提示失效 ——
  // 未登录访客撞上受限接口，说「登录已失效」会莫名其妙。
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    if (user) expired.current = false;
  }, [user]);

  // 把「请求撞上 401」接到路由与提示上。
  // 这一层不做任何判断，只负责收尾，是否该触发由 api.ts 决定。
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (expired.current || !userRef.current) return;
      expired.current = true;
      setUser(null);
      clearStoredToken();
      notify.error("登录已失效", "请重新登录后继续操作");
      // 记住来路，登录后跳回原页面。
      const { pathname, search } = locationRef.current;
      navigate(`/login?next=${encodeURIComponent(pathname + search)}`, { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate, notify]);

  // 启动时用 cookie/token 向后端确认登录态。
  // 不能只信本地缓存 —— 账号可能已被禁用或降级。
  const refresh = useCallback(async () => {
    try {
      const me = await apiRequest<AuthUser>("/api/auth/me");
      setUser(me);
    } catch {
      setUser(null);
      clearStoredToken();
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await apiRequest<AuthUser>("/api/auth/me");
        if (alive) setUser(me);
      } catch {
        if (alive) setUser(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiRequest<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    clearStoredToken();
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(
    async (input: { username: string; email: string; password: string }) => {
      const res = await apiRequest<AuthResponse>("/api/auth/register", {
        method: "POST",
        body: input,
      });
      clearStoredToken();
      setUser(res.user);
      return res.user;
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } finally {
      // 无论后端是否成功，本地状态都要清掉，避免界面卡在已登录。
      clearStoredToken();
      setUser(null);
    }
  }, []);

  const can = useCallback(
    (permission: Permission | Permission[]) => canFn(user, permission),
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, register, logout, refresh, can }),
    [user, loading, login, register, logout, refresh, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth 必须在 AuthProvider 内使用");
  }
  return ctx;
}
