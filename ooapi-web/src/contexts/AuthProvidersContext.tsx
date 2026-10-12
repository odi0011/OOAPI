import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { apiRequest } from "@/lib/api";
import { isRegisterExplicitlyEnabled } from "@/lib/registerGate";

/** 已启用（管理员配好了密钥）的三方平台。 */
export interface OAuthProvider {
  key: string;
  display_name: string;
}

export interface AuthProviders {
  oauth: OAuthProvider[];
  email_code_enabled: boolean;
  password_enabled: boolean;
  /**
   * 是否开放注册。
   * 只在 /api/settings/public 成功返回且 register_enabled === true 时为真。
   * 加载中、失败、字段缺失，以及仅有 password_register_enabled，都保持关闭。
   */
  register_enabled: boolean;
}

// 默认全部关闭。后端未就绪或请求失败时，
// 登录页只显示账号密码 —— 宁可不显示，也不显示一个点不通的按钮。
const DEFAULT: AuthProviders = {
  oauth: [],
  email_code_enabled: false,
  password_enabled: true,
  register_enabled: false,
};

const AuthProvidersContext = createContext<AuthProviders>(DEFAULT);

/**
 * 拉取「当前有哪些登录方式可用」。
 *
 * 这些开关完全由管理端的配置决定：
 *   - 没配 OAuth 密钥 → oauth 为空数组 → 不显示任何三方按钮
 *   - 没配 SMTP → email_code_enabled 为 false → 不显示邮箱验证码入口
 *
 * 前端只做显示控制，后端每个入口都会再校验一次。
 */
export function AuthProvidersProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<AuthProviders>(DEFAULT);

  useEffect(() => {
    let alive = true;
    apiRequest<AuthProviders>("/api/auth/providers", { cache: "no-store" })
      .then((data) => {
        if (!alive) return;
        // 不读取这里的 register_enabled。它只是 password_register_enabled 的别名，
        // 不能单独把注册入口打开，也不能在 public settings 还没到时先闪出表单。
        setProviders((prev) => ({
          ...prev,
          oauth: Array.isArray(data.oauth) ? data.oauth : [],
          email_code_enabled: !!data.email_code_enabled,
          password_enabled: data.password_enabled !== false,
        }));
      })
      .catch(() => {
        /* 登录方式拉不到就保持默认。注册开关不在这个请求上决定。 */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    apiRequest<unknown>("/api/settings/public", { cache: "no-store" })
      .then((data) => {
        if (!alive) return;
        setProviders((prev) => ({
          ...prev,
          register_enabled: isRegisterExplicitlyEnabled(data),
        }));
      })
      .catch(() => {
        if (!alive) return;
        setProviders((prev) => ({ ...prev, register_enabled: false }));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <AuthProvidersContext.Provider value={providers}>
      {children}
    </AuthProvidersContext.Provider>
  );
}

export function useAuthProviders(): AuthProviders {
  return useContext(AuthProvidersContext);
}

/** 三方登录是整页跳转（不是 fetch）：需要浏览器地址栏真正离开本站。 */
export function gotoOAuth(providerKey: string, redirectTo?: string): void {
  const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : "";
  window.location.href = `/api/auth/oauth/${providerKey}/start${q}`;
}
