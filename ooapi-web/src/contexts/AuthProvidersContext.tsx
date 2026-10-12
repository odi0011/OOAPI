import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { apiRequest } from "@/lib/api";

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
   * 后端只有一个选项 password_register_enabled：
   * 这个接口把它叫 register_enabled，/api/status 叫 password_register_enabled。
   * 入口和 /register 门禁只认这里，不再另读 status 字段，避免两套开关各说各话。
   */
  register_enabled: boolean;
  /** providers 接口已结束（成功或失败）。未结束前按关闭处理，避免注册入口先闪出来。 */
  ready: boolean;
}

// 默认全部关闭。后端未就绪或请求失败时，
// 登录页只显示账号密码 —— 宁可不显示，也不显示一个点不通的按钮。
const DEFAULT: AuthProviders = {
  oauth: [],
  email_code_enabled: false,
  password_enabled: true,
  register_enabled: false,
  ready: false,
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
    apiRequest<AuthProviders>("/api/auth/providers")
      .then((data) => {
        if (!alive) return;
        setProviders({
          oauth: Array.isArray(data.oauth) ? data.oauth : [],
          email_code_enabled: !!data.email_code_enabled,
          password_enabled: data.password_enabled !== false,
          register_enabled: !!data.register_enabled,
          ready: true,
        });
      })
      .catch(() => {
        if (!alive) return;
        // 拉不到开关时保持关闭，但要结束等待，否则 /register 会一直停在加载。
        setProviders((prev) => ({ ...prev, ready: true }));
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
