import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import { setStoredToken } from "@/lib/api";

import styles from "./OAuthCallback.module.css";

/**
 * 三方登录回调页。
 *
 * 后端在回调里完成账号匹配与令牌签发，然后用 fragment 把令牌带到这里。
 * 令牌放 fragment（#）而不是 query 的理由：fragment 不会进服务端日志、
 * 不会出现在 Referer 头里，泄露面明显更小。
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

    const token = params.get("token");
    if (!token) {
      setError("登录回调缺少令牌，请重新登录");
      return;
    }

    // 立即清掉地址栏里的令牌，避免它留在浏览器历史里。
    window.history.replaceState(null, "", "/auth/callback");

    setStoredToken(token);

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
