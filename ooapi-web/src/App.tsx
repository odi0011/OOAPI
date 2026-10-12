import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { ToastStack, ToastStackProvider } from "@/components/arc/toast-stack/toast-stack";
import RequireAuth from "@/components/RequireAuth";
import { AppearanceProvider } from "@/contexts/AppearanceContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { AuthProvidersProvider } from "@/contexts/AuthProvidersContext";
import { CurrencyProvider } from "@/contexts/CurrencyContext";
import { Perm } from "@/lib/permissions";
import Home from "@/pages/Home";
import Login from "@/pages/Login";
import OAuthCallback from "@/pages/OAuthCallback";
import Register from "@/pages/Register";
import AdminAnalytics from "@/pages/admin/AdminAnalytics";
import AdminDashboard from "@/pages/admin/AdminDashboard";
import AdminChannels from "@/pages/admin/AdminChannels";
import AdminExchangeKeys from "@/pages/admin/AdminExchangeKeys";
import AdminTrading from "@/pages/admin/AdminTrading";
import AdminLogs from "@/pages/admin/AdminLogs";
import AdminMedia from "@/pages/admin/AdminMedia";
import AdminOperationLogs from "@/pages/admin/AdminOperationLogs";
import AdminPrices from "@/pages/admin/AdminPrices";
import AdminStatus from "@/pages/admin/AdminStatus";
import AdminUsers from "@/pages/admin/AdminUsers";
import AdminGroups from "@/pages/admin/AdminGroups";
import AdminProfile from "@/pages/admin/AdminProfile";
import AdminSettings from "@/pages/admin/AdminSettings";
import AdminTokens from "@/pages/admin/AdminTokens";

/**
 * 路由表。
 *
 * 后台页面全部走 AdminLayout 外壳（面包屑 + 侧边栏 + 顶栏），
 * 每个页面的权限要求写在各自的 Route 上：
 * 前端隐藏只是体验，后端每个接口另有 RequirePermission 兜底。
 *
 * ToastStackProvider 放在最外层：所有页面（含登录注册）都要能弹操作反馈，
 * 而 ToastStack 是它的可视区域，只渲染一次，位置固定在底部居中 ——
 * 右下角容易被表格右侧的固定操作列挡住，居中更容易被看见。
 */
export default function App() {
  return (
    <ToastStackProvider>
      <BrowserRouter>
      {/* 这三层都决定全站展示，放最外层：
          Appearance 是配色，Currency 是货币名与图标，
          AuthProviders 是「有哪些登录方式可用」。 */}
      <AppearanceProvider>
        <CurrencyProvider>
          <AuthProvidersProvider>
            <AuthProvider>
              <Routes>
                {/* ---------- 前台 ---------- */}
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/auth/callback" element={<OAuthCallback />} />

                {/* ---------- 管理后台 ---------- */}
                {/* 看板对登录用户开放：统计接口会按权限决定数据范围 ——
                    有 log:view_all 的看到全站，其他人看到的是「我自己的用量」。
                    这里不再要求管理员权限：早先要求了却把回退页也设成 /admin，
                    普通用户会被在同一个路由上反复重定向，页面直接卡死。 */}
                <Route
                  path="/admin"
                  element={
                    <RequireAuth>
                      <AdminDashboard />
                    </RequireAuth>
                  }
                />

                {/* 系统设置：外观、站点、注册、第三方与邮件、计费、网关。
                    登录与注册是其中的一个分区，不再单独占一个侧边栏入口。
                    带 #hash 时页面会滚动到对应分区。需要 option:edit */}
                <Route
                  path="/admin/system"
                  element={
                    <RequireAuth permission={Perm.OptionEdit}>
                      <AdminSettings />
                    </RequireAuth>
                  }
                />

                {/* ---------- 已实现的功能页 ---------- */}

                {/* 账号管理：需要 channel:view */}
                <Route
                  path="/admin/channels"
                  element={
                    <RequireAuth permission={Perm.ChannelView}>
                      <AdminChannels />
                    </RequireAuth>
                  }
                />

                {/* 用户分组：改动会影响所有引用该分组的密钥 */}
                <Route
                  path="/admin/groups"
                  element={
                    <RequireAuth permission={Perm.UserView}>
                      <AdminGroups />
                    </RequireAuth>
                  }
                />

                {/* 密钥管理：用户自己的资源，登录即可进 */}
                <Route
                  path="/admin/tokens"
                  element={
                    <RequireAuth>
                      <AdminTokens />
                    </RequireAuth>
                  }
                />

                {/* 策略在系统设置的交易分组里。读写策略，可启动引擎，不下单门闩。 */}
                <Route
                  path="/admin/system/strategy"
                  element={
                    <RequireAuth permission={Perm.OptionEdit}>
                      <AdminTrading />
                    </RequireAuth>
                  }
                />

                {/* 账户：交易所 API 绑定。登录即可。明文只经 reveal。 */}
                <Route
                  path="/admin/system/account"
                  element={
                    <RequireAuth>
                      <AdminExchangeKeys />
                    </RequireAuth>
                  }
                />

                <Route path="/admin/trading" element={<Navigate to="/admin/system/strategy" replace />} />
                <Route path="/admin/exchange-keys" element={<Navigate to="/admin/system/account" replace />} />

                {/* 个人中心 */}
                <Route
                  path="/admin/profile"
                  element={
                    <RequireAuth>
                      <AdminProfile />
                    </RequireAuth>
                  }
                />

                {/* 模型定价：读用 pricing:view，改在后端另有 pricing:edit 校验 */}
                <Route
                  path="/admin/models"
                  element={
                    <RequireAuth permission={Perm.ViewPricing}>
                      <AdminPrices />
                    </RequireAuth>
                  }
                />

                {/* 用户管理 */}
                <Route
                  path="/admin/users"
                  element={
                    <RequireAuth permission={Perm.UserView}>
                      <AdminUsers />
                    </RequireAuth>
                  }
                />

                {/* 使用记录：所有登录用户可访问。
                    数据范围在服务端收口 —— 有 log:view_all 的看全站，
                    其他人只能看到自己的记录，前端不承担安全边界。 */}
                <Route
                  path="/admin/logs"
                  element={
                    <RequireAuth>
                      <AdminLogs />
                    </RequireAuth>
                  }
                />

                {/* 操作日志：管理操作与登录审计，规则同上。 */}
                <Route
                  path="/admin/operation-logs"
                  element={
                    <RequireAuth>
                      <AdminOperationLogs />
                    </RequireAuth>
                  }
                />

                {/* 媒体库：所有登录用户可访问。
                    服务端强制普通用户只看自己的文件，管理员可切全站 / 指定用户。 */}
                <Route
                  path="/admin/media"
                  element={
                    <RequireAuth>
                      <AdminMedia />
                    </RequireAuth>
                  }
                />

                {/* 运行状态 */}
                <Route
                  path="/admin/status"
                  element={
                    <RequireAuth permission={Perm.OptionView}>
                      <AdminStatus />
                    </RequireAuth>
                  }
                />

                {/* 消费分析：接口内部按权限决定全站/个人范围，
                    所以这里只要求登录。 */}
                <Route
                  path="/admin/analytics"
                  element={
                    <RequireAuth>
                      <AdminAnalytics />
                    </RequireAuth>
                  }
                />

                {/* 兼容旧链接 */}
                <Route
                  path="/admin/auth"
                  element={
                    <RequireAuth permission={Perm.OptionEdit}>
                      <AdminSettings />
                    </RequireAuth>
                  }
                />

                {/* 旧的个人中心已并入后台，保留重定向避免旧链接 404 */}
                <Route path="/dashboard" element={<Navigate to="/admin" replace />} />

                {/* 未匹配路径回首页 */}
                <Route path="*" element={<Home />} />
              </Routes>
            </AuthProvider>
          </AuthProvidersProvider>
        </CurrencyProvider>
        </AppearanceProvider>
      </BrowserRouter>
      {/* 可视区域只挂一次：页面切换不重建它，进行中的提示不会被打断 */}
      <ToastStack label="操作通知" position="bottom-center" visibleToasts={3} />
    </ToastStackProvider>
  );
}
