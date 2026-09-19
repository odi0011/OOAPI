import React from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Alert, Button, Spin } from "antd";
import MainLayout from "./components/MainLayout";
import HomePage from "./pages/HomePage";
import AuthPage from "./pages/AuthPage";
import ConsolePage from "./pages/ConsolePage";
import ChatPage from "./pages/ChatPage";
import TokenPage from "./pages/TokenPage";
import LogPage from "./pages/LogPage";
import OperationLogPage from "./pages/OperationLogPage";
import ProfilePage from "./pages/ProfilePage";
import AdminUsersPage from "./pages/AdminUsersPage";
import AdminSettingsPage from "./pages/AdminSettingsPage";
import AdminChannelsPage from "./pages/AdminChannelsPage";
import AdminGroupsPage from "./pages/AdminGroupsPage";
import AdminPricingPage from "./pages/AdminPricingPage";
import MonitorPage from "./pages/MonitorPage";
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
        <Route path="/token" element={<TokenPage />} />
        <Route path="/log" element={<LogPage />} />
        {/* 操作日志：与使用记录分开（一个是用量审计，一个是行为审计） */}
        <Route path="/operation-log" element={<OperationLogPage />} />
        <Route path="/profile" element={<ProfilePage />} />
          <Route path="/admin/channel" element={<RequireAuth admin><AdminChannelsPage /></RequireAuth>} />
          <Route path="/admin/groups" element={<RequireAuth admin><AdminGroupsPage /></RequireAuth>} />
          <Route path="/admin/pricing" element={<RequireAuth admin><AdminPricingPage /></RequireAuth>} />
        <Route path="/admin/users" element={<RequireAuth admin><AdminUsersPage /></RequireAuth>} />
        <Route path="/admin/settings" element={<RequireAuth admin><AdminSettingsPage /></RequireAuth>} />
        <Route path="/admin/monitor" element={<RequireAuth admin><MonitorPage /></RequireAuth>} />
        <Route path="/admin" element={<Navigate to="/admin/channel" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
