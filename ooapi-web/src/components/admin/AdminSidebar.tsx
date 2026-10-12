import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Activity,
  BarChart3,
  FileText,
  FolderOpen,
  History,
  KeyRound,
  Layers,
  LayoutDashboard,
  Route,
  Settings,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";

import Tooltip from "@/components/arc/tooltip/tooltip";

import styles from "./AdminSidebar.module.css";

/**
 * 后台侧边栏。
 *
 * 组件库免费版没有侧边栏（Dock / Morph nav 属于 Pro），
 * 因此这里用组件的设计令牌自行搭建。
 *
 * 配色一律使用主题色的衍生色（--accent / --accent-subtle / --accent-strong），
 * 而不是灰白 —— 站点有主题系统，管理界面同样要跟着变。
 */

/** 展示在品牌名后的版本号。上线新版本时改这里。 */
export const APP_VERSION = "v0.2.0";

export interface AdminNavItem {
  key: string;
  label: string;
  icon: ReactNode;
  href: string;
  /** 有权限才显示；留空表示所有登录用户可见。 */
  requiredPermission?: string;
}

export interface AdminNavGroup {
  key: string;
  label?: string;
  items: AdminNavItem[];
}

/** 侧边栏栏目。图标统一 18px 细线条，与组件库的图标风格一致。 */
export const ADMIN_NAV: AdminNavGroup[] = [
  {
    key: "overview",
    items: [
      { key: "dashboard", label: "数据看板", icon: <LayoutDashboard size={18} strokeWidth={1.75} />, href: "/admin" },
    ],
  },
  {
    key: "gateway",
    label: "网关",
    items: [
      { key: "channels", label: "账号管理", icon: <Route size={18} strokeWidth={1.75} />, href: "/admin/channels", requiredPermission: "channel:view" },
      { key: "models", label: "模型定价", icon: <Wallet size={18} strokeWidth={1.75} />, href: "/admin/models", requiredPermission: "pricing:view" },
    ],
  },
  {
    key: "people",
    label: "用户",
    items: [
      { key: "users", label: "用户管理", icon: <Users size={18} strokeWidth={1.75} />, href: "/admin/users", requiredPermission: "user:view" },
      { key: "groups", label: "用户分组", icon: <Layers size={18} strokeWidth={1.75} />, href: "/admin/groups", requiredPermission: "user:view" },
    ],
  },
  {
    key: "insight",
    label: "数据",
    items: [
      // 使用记录与操作日志对所有登录用户开放：
      // 服务端按 log:view_all 收口数据范围，普通用户看到的是自己的记录。
      { key: "logs", label: "使用记录", icon: <FileText size={18} strokeWidth={1.75} />, href: "/admin/logs" },
      { key: "operation-logs", label: "操作日志", icon: <History size={18} strokeWidth={1.75} />, href: "/admin/operation-logs" },
      // 媒体库对所有登录用户可见：普通用户管理自己的文件，服务端强制数据范围。
      { key: "media", label: "媒体库", icon: <FolderOpen size={18} strokeWidth={1.75} />, href: "/admin/media" },
      { key: "analytics", label: "消费分析", icon: <BarChart3 size={18} strokeWidth={1.75} />, href: "/admin/analytics" },
      { key: "status", label: "运行状态", icon: <Activity size={18} strokeWidth={1.75} />, href: "/admin/status", requiredPermission: "option:view" },
    ],
  },
  {
    key: "me",
    label: "个人",
    // 个人相关的入口是一个普通分组，不再单独吊在侧边栏底部 ——
    // 那会让它看起来像另一个层级的东西，其实它和上面的栏目同级。
    items: [
      { key: "profile", label: "个人中心", icon: <UserRound size={18} strokeWidth={1.75} />, href: "/admin/profile" },
      { key: "my-tokens", label: "密钥管理", icon: <KeyRound size={18} strokeWidth={1.75} />, href: "/admin/tokens" },
    ],
  },
  {
    key: "system",
    label: "系统",
    // 登录与注册是系统设置里的一个分区，不单独占入口。
    items: [
      { key: "system", label: "系统设置", icon: <Settings size={18} strokeWidth={1.75} />, href: "/admin/system", requiredPermission: "option:edit" },
    ],
  },
];

interface AdminSidebarProps {
  /** 折叠状态由外层布局持有，按钮已移到顶栏。 */
  collapsed: boolean;
  /** 判断是否有权显示某项；不传则全部显示。 */
  can?: (permission: string) => boolean;
}

export function AdminSidebar({ collapsed, can }: AdminSidebarProps) {
  const location = useLocation();

  return (
    <aside className={collapsed ? `${styles.sidebar} ${styles.collapsed}` : styles.sidebar}>
      {/* 品牌区：logo 与站名是一体（靠左），版本徽标独立贴最右边（两端对齐） */}
      <Link className={styles.brand} to="/admin">
        <span className={styles.brandIdentity}>
          <img className={styles.brandMark} src="/logo.jpg" alt="" />
          {!collapsed && <span className={styles.brandTitle}>OOAPI</span>}
        </span>
        {!collapsed && (
          <span className={styles.brandVersion}>
            {APP_VERSION}
            {/* 装饰性十字光点，悬停时旋转放大；纯样式，不参与语义 */}
            <span className={styles.brandSpark} aria-hidden="true" />
          </span>
        )}
      </Link>

      <nav className={styles.nav} aria-label="后台导航">
        {ADMIN_NAV.map((group) => {
          // 按权限过滤；整组都没权限时连标题一起隐藏，避免空标题。
          const visible = group.items.filter(
            (item) => !item.requiredPermission || !can || can(item.requiredPermission),
          );
          if (visible.length === 0) return null;

          return (
            <div key={group.key} className={styles.group}>
              {group.label && !collapsed && <p className={styles.groupLabel}>{group.label}</p>}

              <ul className={styles.list}>
                {visible.map((item) => {
                  const [itemPath, itemHash] = item.href.split("#");
                  const currentHash = location.hash.replace("#", "");

                  let active: boolean;
                  if (itemHash) {
                    active = location.pathname === itemPath && currentHash === itemHash;
                  } else if (itemPath === "/admin/system") {
                    active = location.pathname === itemPath && !currentHash;
                  } else {
                    active =
                      location.pathname === itemPath ||
                      (itemPath !== "/admin" && location.pathname.startsWith(itemPath));
                  }

                  const link = (
                    <Link
                      className={active ? `${styles.item} ${styles.itemActive}` : styles.item}
                      to={item.href}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className={styles.itemIcon}>{item.icon}</span>
                      {!collapsed && <span className={styles.itemLabel}>{item.label}</span>}
                    </Link>
                  );

                  // 折叠后没有文字，必须靠 tooltip 让图标可辨认。
                  return (
                    <li key={item.key}>
                      {collapsed ? (
                        <Tooltip content={item.label} side="right">
                          {link}
                        </Tooltip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
