import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import { clearStoredToken } from "@/lib/api";

import styles from "./OAuthCallback.module.css";

/**
 * 三方登录回调页。
 *
 * 后端在回调里完成账号匹配，并把会话写进 HttpOnly cookie。
 * 地址栏不再携带令牌。
 */
export default function OAuthCallback() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);

    const err = params.get("error");
    if (err) {
      setError(decodeURIComponent(err));
      return;
    }

    // 清掉地址栏（以及历史页面可能留下的 JWT）。会话在 cookie 里。
    window.history.replaceState(null, "", "/auth/callback");
    clearStoredToken();

    const next = params.get("next") || "/admin";
    const isNew = params.get("new") === "1";

    // 用令牌向后端换取完整用户信息，确保状态与数据库一致。
    void refresh().finally(() => {
      navigate(isNew ? "/admin" : next, { replace: true });
    });
  }, [navigate, refresh]);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        {error ? (
          <>
            <h1 className={styles.title}>登录失败</h1>
            <p className={styles.error}>{error}</p>
            <div className={styles.actions}>
              <Link className={styles.link} to="/login">
                返回登录
              </Link>
              <Link className={styles.link} to="/">
                返回首页
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className={styles.spinner} aria-hidden="true" />
            <p className={styles.lead} role="status">
              正在完成登录…
            </p>
          </>
        )}
      </div>
    </div>
  );
}
