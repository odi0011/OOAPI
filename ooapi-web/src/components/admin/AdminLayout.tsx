import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { PanelLeft, Search } from "lucide-react";

import { Breadcrumb, type BreadcrumbItem } from "@/components/arc/breadcrumb/breadcrumb";
import { CommandPalette, type CommandItem } from "@/components/arc/command-palette/command-palette";
import { NotificationCenter } from "@/components/arc/notification-center/notification-center";
import ThemeSwitch from "@/components/arc/theme-switch/theme-switch";
import Tooltip from "@/components/arc/tooltip/tooltip";
import UserMenu from "@/components/arc/user-menu/user-menu";
import { AdminSidebar, ADMIN_NAV } from "@/components/admin/AdminSidebar";
import { useNotifications } from "@/components/admin/useNotifications";
import { useAppearance } from "@/contexts/AppearanceContext";
import { useAuth } from "@/contexts/AuthContext";

import styles from "./AdminLayout.module.css";

export interface Crumb {
  label: string;
  href?: string;
}

const COLLAPSE_KEY = "ooapi_admin_sidebar_collapsed";

interface AdminLayoutProps {
  /** 面包屑路径。最后一项自动作为当前页（不可点）。 */
  crumbs: Crumb[];
  /** 顶栏右侧除快捷操作之外的自定义操作区。 */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * 后台页面外壳。
 *
 * 侧边栏、面包屑、用户菜单都按当前用户的权限点渲染 ——
 * 无权限的入口直接不显示。这只是体验层过滤，
 * 每个接口在后端还有独立的权限校验。
 */
export default function AdminLayout({ crumbs, actions, children }: AdminLayoutProps) {
  const { user, can, logout } = useAuth();
  const appearance = useAppearance();
  const navigate = useNavigate();

  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // 折叠状态持久化：管理员的选择不该每次刷新都丢。
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* 隐私模式下不可用，保持默认展开 */
    }
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }, []);

  // ⌘K / Ctrl+K 打开命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 命令面板的条目：由侧边栏栏目生成，天然与导航一致。 */
  const commands = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = [];
    for (const group of ADMIN_NAV) {
      for (const item of group.items) {
        if (item.requiredPermission && !can(item.requiredPermission as never)) continue;
        out.push({
          id: item.key,
          label: item.label,
          group: group.label ?? "导航",
          keywords: [item.href],
        });
      }
    }
    return out;
  }, [can]);

  const { notifications, unreadCount, markRead } = useNotifications(can);

  if (!user) return null;

  const items: BreadcrumbItem[] = crumbs.map((crumb, index) => ({
    label: crumb.label,
    href: index === crumbs.length - 1 ? undefined : crumb.href,
  }));

  const unread = unreadCount;

  return (
    <div className={collapsed ? `${styles.shell} ${styles.shellCollapsed}` : styles.shell}>
      <AdminSidebar collapsed={collapsed} can={(p) => can(p as never)} />

      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.topbarLeft}>
            {/* 折叠按钮放在顶栏：侧边栏顶部要留给品牌与版本号 */}
            <Tooltip content={collapsed ? "展开侧边栏" : "折叠侧边栏"} side="bottom">
              <button
                type="button"
                className={styles.iconBtn}
                aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
                aria-expanded={!collapsed}
                onClick={toggleCollapse}
              >
                <PanelLeft size={16} strokeWidth={1.75} />
              </button>
            </Tooltip>

            <Breadcrumb items={items} />
          </div>

          <div className={styles.topbarRight}>
            {actions}

            {/* 搜索：打开命令面板，⌘K 也可唤起 */}
            <Tooltip content="搜索（⌘K）" side="bottom">
              <button
                type="button"
                className={styles.searchBtn}
                onClick={() => setPaletteOpen(true)}
                aria-label="搜索"
              >
                <Search size={15} aria-hidden="true" />
                <span className={styles.searchText}>搜索</span>
                <kbd className={styles.kbd}>⌘K</kbd>
              </button>
            </Tooltip>

            {/* 明暗模式：只影响本机预览，全站外观在系统设置里改 */}
            <Tooltip content="本机明暗预览" side="bottom">
              <span className={styles.themeSlot}>
                <ThemeSwitch
                  theme={appearance.resolvedTheme}
                  iconOnly
                  variant="eclipse"
                  label="切换明暗预览"
                  onThemeChange={(next) => appearance.setLocalTheme(next)}
                />
              </span>
            </Tooltip>

            <NotificationCenter
              notifications={notifications}
              label={`通知${unread > 0 ? `（${unread} 条未读）` : ""}`}
              onReadChange={(n, read) => markRead(n.id, read)}
            />

            <UserMenu
              user={{
                name: user.display_name || user.username,
                email: user.email || `${user.username}@ooapi`,
                // 这里只显示权限；版本号已经在侧边栏品牌区，不重复占位置。
                plan: user.role_name,
                avatarSrc: user.avatar_url || undefined,
              }}
              showTheme={false}
              items={[
                { label: "个人中心", onSelect: () => navigate("/admin/profile") },
                { label: "系统设置", onSelect: () => navigate("/admin/system") },
                { label: "返回前台", onSelect: () => { window.location.href = "/"; } },
              ]}
              onSignOut={() => void logout().then(() => { window.location.href = "/"; })}
            />
          </div>
        </header>

        <main className={styles.content}>{children}</main>
      </div>

      {/* 命令面板：整页模态，点条目直接跳转 */}
      {paletteOpen && (
        <div className={styles.paletteOverlay} role="dialog" aria-modal="true" aria-label="搜索">
          <div className={styles.paletteBox}>
            <CommandPalette
              items={commands}
              placeholder="搜索页面与设置…"
              autoFocus
              onSelect={(item) => {
                setPaletteOpen(false);
                const target = ADMIN_NAV.flatMap((g) => g.items).find((i) => i.key === item.id);
                if (target) navigate(target.href);
              }}
              onClose={() => setPaletteOpen(false)}
            />
          </div>
          {/* 点遮罩关闭 */}
          <button
            type="button"
            className={styles.paletteBackdrop}
            aria-label="关闭搜索"
            onClick={() => setPaletteOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
