import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import type { Permission } from "@/lib/permissions";

interface RequireAuthProps {
  children: ReactNode;
  /** 需要的能力点，缺省表示只要求登录。 */
  permission?: Permission | Permission[];
  /** 无权限时的落地页，默认回首页。 */
  fallback?: string;
}

/**
 * 路由守卫：未登录跳登录页，无权限跳回退页。
 *
 * 这只是体验层的一道门 —— 用户可以直接改前端代码绕过。
 * 所以每个受限接口在后端都另有 RequirePermission 拦截，二者缺一不可。
 */
export default function RequireAuth({
  children,
  permission,
  fallback = "/",
}: RequireAuthProps) {
  const { user, loading, can } = useAuth();
  const location = useLocation();

  // 登录态校验期间不渲染，避免先闪未登录再跳转。
  if (loading) {
    return (
      <div
        style={{
          minHeight: "60vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        正在校验登录状态…
      </div>
    );
  }

  if (!user) {
    // 记住来路，登录后跳回原页面。
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  if (permission && !can(permission)) {
    return <Navigate to={fallback} replace />;
  }

  return <>{children}</>;
}
