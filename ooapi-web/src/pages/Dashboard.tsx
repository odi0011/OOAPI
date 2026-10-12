import { Link, useNavigate } from "react-router-dom";

import Badge from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Card } from "@/components/arc/card/card";
import RequireAuth from "@/components/RequireAuth";
import { useAuth } from "@/contexts/AuthContext";
import { Perm } from "@/lib/permissions";

import styles from "./Dashboard.module.css";

/**
 * 控制台首页。
 *
 * 演示权限的两种用法：
 *   - 页面级：整页要求登录（由 RequireAuth 承担）
 *   - 元素级：按能力点决定某块内容是否渲染
 *
 * 元素级判断只是体验优化 —— 每个对应接口在后端都另有拦截。
 */
export default function Dashboard() {
  return (
    <RequireAuth>
      <DashboardInner />
    </RequireAuth>
  );
}

function DashboardInner() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} to="/">
            <img className={styles.mark} src="/logo.jpg" alt="" />
            <span className={styles.wordmark}>OOAPI</span>
          </Link>

          <div className={styles.headerRight}>
            <Badge tone="neutral">{user.role_name}</Badge>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void logout().then(() => navigate("/", { replace: true }));
              }}
            >
              退出登录
            </Button>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <h1 className={styles.title}>你好，{user.display_name || user.username}</h1>
        <p className={styles.lead}>
          当前身份 {user.role_name} · 分组 {user.group_name || "default"}
        </p>

        <div className={styles.grid}>
          <div className={styles.factCard}>
            <dl className={styles.facts}>
              <dt>用户名</dt>
              <dd>{user.username}</dd>
              <dt>邮箱</dt>
              <dd>{user.email || "未绑定"}</dd>
              <dt>可用额度</dt>
              <dd>{formatQuota(user.quota - user.used_quota)}</dd>
            </dl>
          </div>

          <Card
            title="我的令牌"
            description="签发独立密钥，可限制额度上限、模型白名单与有效期。"
            action={
              <Link className={styles.link} to="/tokens">
                管理令牌 →
              </Link>
            }
          />

          {/* 仅拥有对应能力点的人能看到这些入口 */}
          {can(Perm.UserView) && (
            <Card
              title="用户管理"
              description="查看用户列表，调整角色、状态与额度。"
              action={
                <Link className={styles.link} to="/admin/users">
                  进入管理 →
                </Link>
              }
            />
          )}

          {can(Perm.OptionEdit) && (
            <Card
              title="登录与注册设置"
              description="配置 Google、GitHub 等第三方登录密钥与邮件服务；配好后登录页自动出现对应入口。"
              action={
                <Link className={styles.link} to="/admin/settings">
                  打开设置 →
                </Link>
              }
            />
          )}
        </div>

        <section className={styles.permSection}>
          <h2 className={styles.permTitle}>我的权限点</h2>
          <p className={styles.permLead}>
            后端按这些能力点逐接口校验。前端据此隐藏入口，真正的拦截在服务端。
          </p>
          <ul className={styles.permList}>
            {user.permissions.map((p) => (
              <li key={p}>
                <Badge tone="info" size="sm">
                  {p}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

/** 额度以「单位」存储，1 OD = 10000 单位；展示时换算成 OD。 */
function formatQuota(units: number): string {
  return `${(units / 10000).toFixed(4)} OD`;
}
