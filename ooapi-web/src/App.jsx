import React from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Alert, Button, Spin } from "antd";
import MainLayout from "./components/MainLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import HomePage from "./pages/HomePage";
import AuthPage from "./pages/AuthPage";
import ConsolePage from "./pages/ConsolePage";
import ChatPage from "./pages/ChatPage";
import TokenPage from "./pages/TokenPage";
import PricingPage from "./pages/PricingPage";
import LogPage from "./pages/LogPage";
import OperationLogPage from "./pages/OperationLogPage";
import MediaPage from "./pages/MediaPage";
import ProfilePage from "./pages/ProfilePage";
import AdminUsersPage from "./pages/AdminUsersPage";
import AdminSettingsPage from "./pages/AdminSettingsPage";
import AdminChannelsPage from "./pages/AdminChannelsPage";
import AdminGroupsPage from "./pages/AdminGroupsPage";
import AdminPricingPage from "./pages/AdminPricingPage";
import MonitorPage from "./pages/MonitorPage";
import ProfileViewPage from "./pages/ProfileViewPage";
import CommunityPage from "./pages/CommunityPage";
import PostDetailPage from "./pages/PostDetailPage";
import MessagesPage from "./pages/MessagesPage";
import NotificationsPage from "./pages/NotificationsPage";
import AppearancePage from "./pages/AppearancePage";
import AdminDashboardPage from "./pages/AdminDashboardPage";
import AdminCommunityPage from "./pages/AdminCommunityPage";
import { useApp } from "./context/AppContext";

function RequireAuth({ children, admin = false }) {
  const { user, loading, authError, refreshUser } = useApp();
  const location = useLocation();
  const [retrying, setRetrying] = React.useState(false);
  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!user && authError) {
    return (
      <div style={{ maxWidth: 480, margin: "96px auto", padding: "0 20px" }}>
        <Alert
          type="warning"
          showIcon
          message="暂时无法确认登录状态"
          description={authError.message || "网络连接失败，请稍后重试"}
          action={
            <Button
              size="small"
              loading={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await refreshUser();
                } finally {
                  setRetrying(false);
                }
              }}
            >
              重试
            </Button>
          }
        />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (admin && user.role < 100) return <Navigate to="/console" replace />;
  return children;
}

export default function App() {
  return (
    // 错误边界包住**整棵路由树**：任何页面崩了都还能看到「页面出错了 + 刷新」，
    // 而不是纯白页（真实事故：一个未定义标识符就让 5 个页面同时白屏，
    // 用户连导航都没了。见 components/ErrorBoundary.jsx 的说明）。
    <ErrorBoundary>
    <Routes>
      <Route path="/" element={<HomePage />} />
      {/* 侧边栏「返回首页」的兼容路由：跳出控制台布局回公开首页 */}
      <Route path="/home" element={<Navigate to="/" replace />} />
      <Route path="/login" element={<AuthPage initialTab="login" />} />
      <Route path="/register" element={<AuthPage initialTab="register" />} />
      <Route element={<RequireAuth><MainLayout /></RequireAuth>}>
        <Route path="/console" element={<ConsolePage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/agent" element={<Navigate to="/chat?mode=agent" replace />} />
        {/* 社区：大厅 / 帖子详情 / 个人主页（统一路由，自己看与别人看同一入口） */}
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/community/:id" element={<PostDetailPage />} />
        <Route path="/u/:id" element={<ProfileViewPage />} />
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/messages/:roomId" element={<MessagesPage />} />
        <Route path="/token" element={<TokenPage />} />
        <Route path="/log" element={<LogPage />} />
        {/* 操作日志：与使用记录分开（一个是用量审计，一个是行为审计） */}
        <Route path="/operation-log" element={<OperationLogPage />} />
        {/* 媒体库：普通用户看自己的；管理员可用 ?user_id 切到指定用户 */}
        <Route path="/media" element={<MediaPage />} />
        {/* 模型价格（只读）：用户端比价用；后台可关（expose_pricing_to_user） */}
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        {/* 外观设置：即时热注入，改动立刻生效 */}
        <Route path="/settings/appearance" element={<AppearancePage />} />
          <Route path="/admin/channel" element={<RequireAuth admin><AdminChannelsPage /></RequireAuth>} />
          <Route path="/admin/groups" element={<RequireAuth admin><AdminGroupsPage /></RequireAuth>} />
          <Route path="/admin/pricing" element={<RequireAuth admin><AdminPricingPage /></RequireAuth>} />
        <Route path="/admin/users" element={<RequireAuth admin><AdminUsersPage /></RequireAuth>} />
        <Route path="/admin/settings" element={<RequireAuth admin><AdminSettingsPage /></RequireAuth>} />
        <Route path="/admin/monitor" element={<RequireAuth admin><MonitorPage /></RequireAuth>} />
        {/* 管理端看板：与个人看板（/console）物理分离，权限边界靠路由守卫 */}
        <Route path="/admin/dashboard" element={<RequireAuth admin><AdminDashboardPage /></RequireAuth>} />
        <Route path="/admin/community" element={<RequireAuth admin><AdminCommunityPage /></RequireAuth>} />
        <Route path="/admin" element={<Navigate to="/admin/channel" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ErrorBoundary>
  );
}
