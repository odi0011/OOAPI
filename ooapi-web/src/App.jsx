import React from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Spin } from "antd";
import MainLayout from "./components/MainLayout";
import HomePage from "./pages/HomePage";
import AuthPage from "./pages/AuthPage";
import ConsolePage from "./pages/ConsolePage";
import ChatPage from "./pages/ChatPage";
import AgentPage from "./pages/AgentPage";
import TokenPage from "./pages/TokenPage";
import LogPage from "./pages/LogPage";
import ProfilePage from "./pages/ProfilePage";
import AdminUsersPage from "./pages/AdminUsersPage";
import AdminSettingsPage from "./pages/AdminSettingsPage";
import AdminChannelsPage from "./pages/AdminChannelsPage";
import AdminPricingPage from "./pages/AdminPricingPage";
import { useApp } from "./context/AppContext";

function RequireAuth({ children, admin = false }) {
  const { user, loading } = useApp();
  const location = useLocation();
  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 120 }}>
        <Spin size="large" />
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
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/admin/channel" element={<RequireAuth admin><AdminChannelsPage /></RequireAuth>} />
        <Route path="/admin/pricing" element={<RequireAuth admin><AdminPricingPage /></RequireAuth>} />
        <Route path="/admin/users" element={<RequireAuth admin><AdminUsersPage /></RequireAuth>} />
        <Route path="/admin/settings" element={<RequireAuth admin><AdminSettingsPage /></RequireAuth>} />
        <Route path="/admin" element={<Navigate to="/admin/channel" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
