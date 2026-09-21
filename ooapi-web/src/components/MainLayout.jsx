import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Layout, Avatar, Dropdown, Grid, Drawer, Button, Alert } from "antd";
import {
  HomeOutlined,
  DashboardOutlined,
  KeyOutlined,
  FileTextOutlined,
  UserOutlined,
  TeamOutlined,
  SettingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MenuOutlined,
  ApiOutlined,
  MessageOutlined,
  DollarOutlined,
  GroupOutlined,
  HistoryOutlined,
  MonitorOutlined,
  FolderOpenOutlined,
  ReadOutlined,
  CommentOutlined,
  ThunderboltOutlined,
  BellOutlined,
  BgColorsOutlined,
} from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { API } from "../services/api";
import { useTheme } from "../theme/ThemeContext";
import ThemeSwitch from "./ThemeSwitch";

const { Header, Sider, Content } = Layout;
const { useBreakpoint } = Grid;

/**
 * 当前页面加载的是哪个 bundle —— 从自己的 script 标签读。
 * 与 /api/status 的 build_id 比对，不一致就说明这个标签页是发版前打开的旧包。
 * 这不只是提示：**旧包会真的渲染出旧行为**（历史事故：图标/滚动已修好并部署，
 * 用户在旧页面里看到旧样子，据此判断「没改」）。
 */
function loadedBuildId() {
  const el = document.querySelector('script[type="module"][src*="/assets/index-"]');
  const m = el?.getAttribute("src")?.match(/index-[A-Za-z0-9_-]+\.js/);
  return m ? m[0] : "";
}

// 导航：工作台（对话/社区） → 开发 → 账户 → 平台管理
const NAV_USER = [
  {
    title: "工作台",
    items: [
      { key: "/chat", icon: <MessageOutlined />, label: "对话" },
      { key: "/console", icon: <DashboardOutlined />, label: "数据看板" },
      { key: "/community", icon: <ReadOutlined />, label: "社区" },
      { key: "/messages", icon: <CommentOutlined />, label: "消息", badge: "messages" },
      { key: "/notifications", icon: <BellOutlined />, label: "通知", badge: "notifications" },
    ],
  },
  {
    title: "开发",
    items: [
      { key: "/token", icon: <KeyOutlined />, label: "令牌管理" },
      { key: "/log", icon: <FileTextOutlined />, label: "使用记录" },
      { key: "/operation-log", icon: <HistoryOutlined />, label: "操作日志" },
    ],
  },
  {
    title: "账户",
    items: [
      { key: "/media", icon: <FolderOpenOutlined />, label: "媒体库" },
      { key: "/settings/appearance", icon: <BgColorsOutlined />, label: "外观设置" },
      { key: "/profile", icon: <UserOutlined />, label: "个人设置" },
    ],
  },
];

const NAV_ADMIN = [
  {
    title: "平台管理",
    items: [
      { key: "/admin/dashboard", icon: <DashboardOutlined />, label: "平台看板" },
      { key: "/admin/channel", icon: <ApiOutlined />, label: "渠道管理" },
      { key: "/admin/groups", icon: <GroupOutlined />, label: "分组管理" },
      { key: "/admin/pricing", icon: <DollarOutlined />, label: "模型定价" },
      { key: "/admin/users", icon: <TeamOutlined />, label: "用户管理" },
      { key: "/admin/community", icon: <ReadOutlined />, label: "社区管理" },
      { key: "/admin/monitor", icon: <MonitorOutlined />, label: "运维监控" },
      { key: "/admin/settings", icon: <SettingOutlined />, label: "系统设置" },
    ],
  },
];

const CRUMB = {
  "/chat": ["工作台", "对话"],
  "/agent": ["工作台", "智能体"],
  "/console": ["工作台", "数据看板"],
  "/community": ["工作台", "社区"],
  "/messages": ["工作台", "消息"],
  "/notifications": ["工作台", "通知"],
  "/games": ["工作台", "社区", "小游戏"],
  "/token": ["开发", "令牌管理"],
  "/log": ["开发", "使用记录"],
  "/operation-log": ["开发", "操作日志"],
  "/media": ["账户", "媒体库"],
  "/settings/appearance": ["账户", "外观设置"],
  "/profile": ["账户", "个人设置"],
  "/home": ["首页"],
  "/admin/dashboard": ["平台管理", "平台看板"],
  "/admin/channel": ["平台管理", "渠道管理"],
  "/admin/groups": ["平台管理", "分组管理"],
  "/admin/pricing": ["平台管理", "模型定价"],
  "/admin/users": ["平台管理", "用户管理"],
  "/admin/community": ["平台管理", "社区管理"],
  "/admin/monitor": ["平台管理", "运维监控"],
  "/admin/settings": ["平台管理", "系统设置"],
};

/**
 * 内容区宽度：**全站全宽**。
 *
 * 曾经按「表格页铺满 / 卡片图表页限宽 1320px 居中」二分过，
 * 用户明确要求**所有页面全宽** —— 已取消限宽。
 * 窄屏适配交给各页面自身的栅格（.oo-stats-cards / .oo-chart-grid 都是
 * auto-fit 自适应列数），不靠外层容器限宽。
 *
 * 聊天页单独处理（高度锁定，不能有外层滚动）。
 */
function contentClass(pathname) {
  return pathname === "/chat" ? " ui-chat-content" : "";
}

export default function MainLayout() {
  const { user, status, logout, refreshStatus } = useApp();
  const { resolved } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  // 导航红点：消息未读 + 通知未读。
  // 用 60s 轮询而不是只靠 SSE：SSE 断开（换网络/休眠唤醒）时不刷新会红点残留，
  // 轮询是兜底；SSE 事件到达时也会立刻更新（见下面的 effect）。
  const [badges, setBadges] = useState({ messages: 0, notifications: 0 });

  const refreshBadges = useCallback(async () => {
    // 两个接口都可能因权限/网络失败，任一失败都不该影响导航渲染
    const [m, n] = await Promise.all([
      API.get("/chatroom/unread").catch(() => null),
      API.get("/community/notifications/unread").catch(() => null),
    ]);
    setBadges({
      messages: Number(m?.total) || 0,
      notifications: Number(n?.total) || 0,
    });
  }, []);

  useEffect(() => {
    refreshBadges();
    const timer = setInterval(refreshBadges, 60_000);
    const onFocus = () => refreshBadges(); // 切回标签页立刻刷新（用户最可能此刻在看）
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshBadges]);

  // 正在看消息/通知页时，红点应该立刻消失（切换页面即重算）
  useEffect(() => {
    if (["/messages", "/notifications"].some((p) => location.pathname.startsWith(p))) refreshBadges();
  }, [location.pathname, refreshBadges]);

  // 发版检测：页面加载的 bundle 与服务器当前部署的不一致 → 提示刷新。
  // 只在焦点时检查（用户回到标签页那一刻最该知道）而不是纯定时器，
  // 发版是低频事件，没必要为此长期轮询。
  const [staleBuild, setStaleBuild] = useState("");
  useEffect(() => {
    const mine = loadedBuildId();
    if (!mine) return undefined;
    if (status?.build_id && status.build_id !== mine) setStaleBuild(status.build_id);
    // status 只在应用挂载时取过一次，发版后它自己也是旧的 ——
    // 所以切回标签页要重新拉一次，否则对比永远发生在两个旧值之间。
    const onFocus = () => refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [status?.build_id, refreshStatus]);

  const isAdmin = user?.role >= 100;
  const selectedKey = location.pathname;
  const crumb = CRUMB[location.pathname] || [];

  const doLogout = async () => {
    await logout();
    navigate("/login");
  };

  const userMenu = {
    items: [
      {
        key: "ident",
        disabled: true,
        label: (
          <div style={{ padding: "2px 0", lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, color: "var(--ink)" }}>{user?.display_name || user?.username}</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {isAdmin ? "管理员" : "普通用户"} · {user?.username}
            </div>
          </div>
        ),
      },
      { type: "divider" },
      { key: "profile", icon: <UserOutlined />, label: "个人设置", onClick: () => navigate("/profile") },
      { key: "home", icon: <HomeOutlined />, label: "返回首页", onClick: () => navigate("/home") },
      { type: "divider" },
      { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true, onClick: doLogout },
    ],
  };

  const nav = useMemo(() => {
    const renderGroup = (group) => (
      <div className="oo-nav-group" key={group.title}>
        {!collapsed && <div className="oo-nav-label">{group.title}</div>}
        {group.items.map((it) => (
          <div
            key={it.key}
            className={`oo-nav-item${selectedKey === it.key ? " is-active" : ""}`}
            role="button"
            tabIndex={0}
            aria-current={selectedKey === it.key ? "page" : undefined}
            onClick={() => {
              navigate(it.key);
              if (isMobile) setDrawer(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                navigate(it.key);
                if (isMobile) setDrawer(false);
              }
            }}
            title={collapsed ? it.label : undefined}
          >
            {it.icon}
            {!collapsed && <span className="oo-truncate">{it.label}</span>}
            {/* 未读数：折叠态也显示（只显示数字，省空间） */}
            {badges[it.badge] ? (
              <span className="oo-nav-badge" title={`${badges[it.badge]} 条未读`}>
                {badges[it.badge] > 99 ? "99+" : badges[it.badge]}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    );

    return (
      <nav className="oo-nav">
        {NAV_USER.map(renderGroup)}
        {isAdmin && (
          <>
            <div style={{ height: 1, background: "var(--line)", margin: "14px 8px" }} />
            {NAV_ADMIN.map(renderGroup)}
          </>
        )}
      </nav>
    );
  }, [collapsed, selectedKey, isAdmin, isMobile, navigate, badges]);

  const brand = (
    <div className="oo-brand">
      <img src={status?.logo || "/logo.jpg"} alt="logo" />
      {!collapsed && <span className="oo-brand-name">{status?.system_name || "OOAPI"}</span>}
    </div>
  );

  return (
    <Layout className="oo-shell">
      {!isMobile && (
        <Sider
          width={232}
          collapsedWidth={56}
          collapsed={collapsed}
          trigger={null}
          className="oo-sider"
          theme={resolved === "dark" ? "dark" : "light"}
          style={{ position: "sticky", top: 0, height: "100vh" }}
        >
          {brand}
          {nav}
          <div className="oo-sider-foot">
            {/* 收起/展开在内容区顶部已有按钮，这里放「返回首页」更合适 */}
            <div
              className="oo-nav-item"
              role="button"
              tabIndex={0}
              aria-label="返回首页"
              title={collapsed ? "返回首页" : undefined}
              onClick={() => navigate("/home")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate("/home");
                }
              }}
              style={{ margin: 0 }}
            >
              <HomeOutlined />
              {!collapsed && <span>返回首页</span>}
            </div>
          </div>
        </Sider>
      )}

      {isMobile && (
        <Drawer
          placement="left"
          width={250}
          open={drawer}
          onClose={() => setDrawer(false)}
          closable={false}
          styles={{ body: { padding: 0, background: "var(--page)" }, header: { display: "none" } }}
        >
          {brand}
          {nav}
        </Drawer>
      )}

      <Layout style={{ background: "var(--page)" }}>
        <Header className="oo-header">
          <div className="oo-header-left">
            <Button
              type="text"
              size="small"
              icon={isMobile ? <MenuOutlined /> : collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              aria-label={isMobile ? "打开导航" : collapsed ? "展开侧边栏" : "收起侧边栏"}
              title={isMobile ? "打开导航" : collapsed ? "展开侧边栏" : "收起侧边栏"}
              onClick={() => (isMobile ? setDrawer(true) : setCollapsed(!collapsed))}
            />
            <div className="oo-crumb">
              {crumb.slice(0, -1).map((t) => (
                <React.Fragment key={t}>
                  <span>{t}</span>
                  <span className="oo-crumb-sep">/</span>
                </React.Fragment>
              ))}
              <span className="oo-crumb-current">{crumb[crumb.length - 1] || ""}</span>
            </div>
          </div>

          <div className="oo-header-right">
            <ThemeSwitch size="small" />
            <Dropdown menu={userMenu} placement="bottomRight" trigger={["click"]}>
              <div className="oo-user-chip">
                <Avatar size={24} icon={<UserOutlined />} style={{ background: "var(--accent)", fontSize: 12 }} />
                <span className="oo-user-name">{user?.display_name || user?.username}</span>
              </div>
            </Dropdown>
          </div>
        </Header>

        <Content className={`oo-content${contentClass(location.pathname)}`}>
          {staleBuild ? (
            <Alert
              className="oo-stale-build"
              type="warning"
              showIcon
              banner
              closable
              onClose={() => setStaleSince("")}
              message="页面版本已更新"
              description="你当前打开的是旧版本页面，部分新改动不会生效（例如图标、布局）。刷新即可加载最新版本。"
              action={
                <Button size="small" type="primary" onClick={() => window.location.reload()}>
                  立即刷新
                </Button>
              }
            />
          ) : null}
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
