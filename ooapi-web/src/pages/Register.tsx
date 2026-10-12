import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { SignupForm, type SignupDetails } from "@/components/arc/blocks/signup-form/signup-form";
import { useAuth } from "@/contexts/AuthContext";
import { gotoOAuth, useAuthProviders } from "@/contexts/AuthProvidersContext";
import { ApiRequestError } from "@/lib/api";

import styles from "./Auth.module.css";

/**
 * 注册页，使用 Arc UI 的 SignupForm 组件。
 *
 * 三方按钮按管理端配置动态显示 —— 没配的平台不出现，
 * 而不是出现一个点了报「尚未接入」的按钮。
 */
export default function Register() {
  const { user, register } = useAuth();
  const providers = useAuthProviders();
  const navigate = useNavigate();

  const [serverError, setServerError] = useState<string | null>(null);

  async function handleSubmit(details: SignupDetails) {
    setServerError(null);

    // 用户名规则与后端 authz.ValidateUsername 保持一致：
    // 小写、3–32 位、仅字母数字下划线连字符。
    const username = details.name.trim().toLowerCase().replace(/\s+/g, "");

    if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
      setServerError("用户名需为 3–32 位字母、数字、下划线或连字符（不能含空格）");
      return;
    }

    try {
      await register({
        username,
        email: details.email.trim(),
        password: details.password,
      });
      navigate("/admin", { replace: true });
    } catch (err) {
      setServerError(
        err instanceof ApiRequestError ? err.message : "注册失败，请稍后重试",
      );
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.signupWrap}>
        <SignupForm
          onSubmit={handleSubmit}
          serverError={serverError}
          providers={providers.oauth}
          onProvider={(providerKey) => gotoOAuth(providerKey, "/admin")}
        />

        <p className={styles.footer}>
          {user ? (
            <Link to="/admin">进入后台</Link>
          ) : (
            <>
              <Link to="/login">去登录</Link> · <Link to="/">返回首页</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
