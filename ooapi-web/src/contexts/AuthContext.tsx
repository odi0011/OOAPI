import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  apiRequest,
  clearStoredToken,
} from "@/lib/api";
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
