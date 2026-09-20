import React, { useMemo, useState } from "react";
import { Layout, Avatar, Dropdown, Grid, Drawer, Button } from "antd";
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
} from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { useTheme } from "../theme/ThemeContext";
import ThemeSwitch from "./ThemeSwitch";

const { Header, Sider, Content } = Layout;
const { useBreakpoint } = Grid;

// 导航：工作台（对话/智能体为核心） → 开发 → 账户 → 管理
const NAV_USER = [
  {
    title: "工作台",
    items: [
      { key: "/chat", icon: <MessageOutlined />, label: "对话" },
      { key: "/console", icon: <DashboardOutlined />, label: "数据看板" },
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
      { key: "/profile", icon: <UserOutlined />, label: "个人设置" },
    ],
  },
];

const NAV_ADMIN = [
  {
    title: "平台管理",
    items: [
      { key: "/admin/channel", icon: <ApiOutlined />, label: "渠道管理" },
      { key: "/admin/groups", icon: <GroupOutlined />, label: "分组管理" },
      { key: "/admin/pricing", icon: <DollarOutlined />, label: "模型定价" },
      { key: "/admin/users", icon: <TeamOutlined />, label: "用户管理" },
      { key: "/admin/monitor", icon: <MonitorOutlined />, label: "运维监控" },
      { key: "/admin/settings", icon: <SettingOutlined />, label: "系统设置" },
    ],
  },
];

const CRUMB = {
  "/chat": ["工作台", "对话"],
  "/agent": ["工作台", "智能体"],
  "/console": ["工作台", "数据看板"],
  "/token": ["开发", "令牌管理"],
  "/log": ["开发", "使用记录"],
  "/operation-log": ["开发", "操作日志"],
  "/media": ["账户", "媒体库"],
  "/profile": ["账户", "个人设置"],
  "/home": ["首页"],
  "/admin/channel": ["平台管理", "渠道管理"],
  "/admin/groups": ["平台管理", "分组管理"],
  "/admin/pricing": ["平台管理", "模型定价"],
  "/admin/users": ["平台管理", "用户管理"],
  "/admin/monitor": ["平台管理", "运维监控"],
  "/admin/settings": ["平台管理", "系统设置"],
};

export default function MainLayout() {
  const { user, status, logout } = useApp();
  const { resolved } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

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
  }, [collapsed, selectedKey, isAdmin, isMobile, navigate]);

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

        <Content className={`oo-content${location.pathname === "/chat" ? " ui-chat-content" : ""}`}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
