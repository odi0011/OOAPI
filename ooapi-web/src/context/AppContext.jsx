import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";
import { API, getToken, setToken } from "../services/api";

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [status, setStatus] = useState(null); // 系统公开配置
  const [user, setUser] = useState(null); // 当前登录用户
  const [loading, setLoading] = useState(true);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await API.get("/status");
      setStatus(s);
      if (s?.system_name) document.title = s.system_name;
      if (s?.logo) {
        const link = document.querySelector("link[rel='icon']");
        if (link) link.href = s.logo;
      }
    } catch {
      /* 状态接口失败不阻塞 */
    }
  }, []);

  const refreshUser = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    try {
      const u = await API.get("/user/self");
      setUser(u);
    } catch (e) {
      // 明确判定登录失效时清除登录态：401（过期/撤销）；
      // 403 且消息是「账号已被禁用」时同样退出，否则页面会一直 403 却不跳登录。
      // 网络抖动、5xx 等临时错误保留当前用户，避免误退出。
      const disabled = e?.status === 403 && /禁用/.test(e?.message || "");
      if (e?.status === 401 || disabled) {
        setToken("");
        setUser(null);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([refreshStatus(), refreshUser()]);
      setLoading(false);
    })();
  }, [refreshStatus, refreshUser]);

  // 任意请求遇到 401（token 过期/被撤销）时，api.js 会广播事件，这里统一清空登录态，
  // RequireAuth 随即自动跳转登录页，无需刷新页面。
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener("ooapi:unauthorized", onUnauthorized);
    return () => window.removeEventListener("ooapi:unauthorized", onUnauthorized);
  }, []);

  // 登录成功后写入 token 并刷新用户
  const login = useCallback(async (username, password) => {
    const data = await API.post("/user/login", { username, password });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (username, password) => {
    const data = await API.post("/user/register", { username, password });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await API.post("/user/logout");
    } catch {
      /* ignore */
    }
    setToken("");
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ status, user, loading, refreshUser, refreshStatus, login, register, logout }),
    [status, user, loading, refreshUser, refreshStatus, login, register, logout]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp 必须在 AppProvider 内使用");
  return ctx;
}
