import { useNavigate, useSearchParams } from "react-router-dom";

import { LoginCentered } from "@/components/arc/blocks/login-centered/login-centered";
import { useAuth } from "@/contexts/AuthContext";
import { gotoOAuth, useAuthProviders } from "@/contexts/AuthProvidersContext";
import { apiRequest } from "@/lib/api";

/**
 * 登录页，使用 Arc UI 的 login-centered 块。
 *
 * 显示哪些登录方式完全由管理端配置决定：
 *   - 未配 OAuth 密钥 → 不显示任何三方按钮（不是显示后报错）
 *   - 未配 SMTP → 不显示邮箱验证码入口
 *   - 账号密码登录由后台开关控制
 */
export default function Login() {
  const { login, refresh } = useAuth();
  const providers = useAuthProviders();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // 登录后回到来路页面；没有来路则进控制台。
  const next = params.get("next") || "/admin";

  return (
    <LoginCentered
      fullScreen
      passwordEnabled={providers.password_enabled}
      emailCodeEnabled={providers.email_code_enabled}
      oauthProviders={providers.oauth}
      onPasswordLogin={async (username, password) => {
        await login(username, password);
      }}
      onSendEmailCode={async (email) => {
        await apiRequest("/api/auth/email/send", {
          method: "POST",
          body: { email },
        });
      }}
      onEmailCodeLogin={async (email, code) => {
        const res = await apiRequest<{ token: string; is_new: boolean }>(
          "/api/auth/email/login",
          { method: "POST", body: { email, code } },
        );
        // 后端已经种下 cookie，这里同步一次登录态，让导航栏立即更新。
        void res;
        await refresh();
      }}
      onOAuth={(providerKey) => gotoOAuth(providerKey, next)}
      onSignUp={providers.register_enabled === true ? () => navigate("/register") : undefined}
      onSignedIn={() => navigate(next, { replace: true })}
    />
  );
}
