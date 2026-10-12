import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import AvatarUploader from "@/components/AvatarUploader";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { Textarea } from "@/components/arc/textarea/textarea";
import AdminLayout from "@/components/admin/AdminLayout";
import CurrencyIcon from "@/components/CurrencyIcon";
import { useAuth } from "@/contexts/AuthContext";
import { formatAmount, useCurrency } from "@/contexts/CurrencyContext";
import { ApiRequestError, apiRequest, clearStoredToken } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";
import { vendorIconUrl, vendorLabel } from "@/lib/vendorIcons";

import styles from "./AdminProfile.module.css";

/** GET /api/user/profile 返回的可编辑字段（后端还带额度等展示字段，这里只取需要的）。 */
interface Profile {
  display_name: string;
  email: string;
  bio: string;
  website: string;
  location: string;
  avatar_url: string;
}

interface Binding {
  provider: string;
  username: string;
  email: string;
  bound_at: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 个人中心。
 *
 * 头部是身份与头像（可上传/移除），下面用 Tabs 分「资料 / 安全 / 绑定」：
 * 资料是展示信息，安全是不可逆操作，绑定是登录方式 —— 三者的操作风险不同，
 * 放在同一屏里容易误触，所以分开。
 */
export default function AdminProfile() {
  const { user, refresh } = useAuth();
  const currency = useCurrency();
  const notify = useNotify();
  const action = useAsyncGuard();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [location, setLocation] = useState("");
  const [bio, setBio] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploaderOpen, setUploaderOpen] = useState(false);

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);

  const [bindings, setBindings] = useState<Binding[]>([]);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  /** 每个解绑按钮的完成态（失败时要能复位回可长按） */
  const [unbound, setUnbound] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<Profile>("/api/user/profile");
      setProfile(data);
      setDisplayName(data.display_name || "");
      setEmail(data.email || "");
      setWebsite(data.website || "");
      setLocation(data.location || "");
      setBio(data.bio || "");
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBindings = useCallback(async () => {
    setBindingsError(null);
    try {
      const data = await apiRequest<{ bindings: Binding[] }>("/api/user/oauth");
      setBindings(data.bindings ?? []);
    } catch (err) {
      setBindingsError(err instanceof ApiRequestError ? err.message : "加载绑定失败");
    }
  }, []);

  useEffect(() => {
    void load();
    void loadBindings();
  }, [load, loadBindings]);

  const emailError = email.trim() && !EMAIL_RE.test(email.trim()) ? "请输入有效的邮箱地址" : undefined;
  const websiteError =
    website.trim() && !/^https?:\/\//i.test(website.trim()) ? "链接需以 http:// 或 https:// 开头" : undefined;
  const newPasswordError =
    newPassword && !(newPassword.length >= 8 && /[A-Za-z]/.test(newPassword) && /\d/.test(newPassword))
      ? "至少 8 位，需同时包含字母与数字"
      : undefined;
  const confirmError = confirmPassword && confirmPassword !== newPassword ? "两次输入的新密码不一致" : undefined;
  const passwordReady = !!oldPassword && !!newPassword && !!confirmPassword && !newPasswordError && !confirmError;

  async function saveProfile() {
    if (emailError || websiteError) {
      notify.error("请检查表单", emailError ?? websiteError);
      return;
    }
    if (passwordChanged || !action.acquire()) return;
    setSavingProfile(true);
    try {
      const fresh = await apiRequest<Profile>("/api/user/profile", {
        method: "PUT",
        body: {
          display_name: displayName.trim(),
          email: email.trim(),
          bio: bio.trim(),
          website: website.trim(),
          location: location.trim(),
        },
      });
      setProfile(fresh);
      setDisplayName(fresh.display_name || "");
      setEmail(fresh.email || "");
      setWebsite(fresh.website || "");
      setLocation(fresh.location || "");
      setBio(fresh.bio || "");
      await refresh();
      notify.success("资料已保存");
    } catch (err) {
      notify.error("保存失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setSavingProfile(false);
      action.release();
    }
  }

  async function changePassword() {
    if (!passwordReady || passwordChanged || !action.acquire()) return;
    setSavingPassword(true);
    try {
      await apiRequest("/api/user/password", {
        method: "PUT",
        body: { old_password: oldPassword, new_password: newPassword },
      });
      setPasswordChanged(true);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // 服务端已作废会话并清 cookie，这里把历史 JWT 一并丢掉。
      clearStoredToken();
      notify.success("密码已修改", "请重新登录");
    } catch (err) {
      notify.error("修改失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setSavingPassword(false);
      action.release();
    }
  }

  async function unbind(provider: string) {
    if (passwordChanged || unbound[provider] || !action.acquire()) return;
    try {
      await apiRequest(`/api/user/oauth/${provider}`, { method: "DELETE" });
      setUnbound((prev) => ({ ...prev, [provider]: true }));
      setBindings((prev) => prev.filter((item) => item.provider !== provider));
      notify.success(`已解绑 ${vendorLabel(provider)}`, "之后不能用它登录");
      void loadBindings();
    } catch (err) {
      setUnbound((prev) => ({ ...prev, [provider]: false }));
      notify.error("解绑失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  if (!user) return null;

  const avatarUrl = profile?.avatar_url ?? user.avatar_url ?? "";
  const name = displayName || user.username;
  const locked = action.busy || passwordChanged;

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "个人中心" }]}>
      <div className={styles.page}>
        <h1 className={styles.title}>个人中心</h1>

        {/* ---------- 身份头部 ---------- */}
        <section className={styles.header}>
          <Avatar size="xl" name={name} src={avatarUrl || undefined} />
          <div className={styles.identity}>
            <div className={styles.nameRow}>
              <h2 className={styles.name}>{name}</h2>
              {user.role_name && <Badge tone="info">{user.role_name}</Badge>}
            </div>
            <span className={styles.handle}>@{user.username}</span>
          </div>
          <div className={styles.headerActions}>
            <Button variant="secondary" size="sm" disabled={passwordChanged} onClick={() => setUploaderOpen(true)}>
              {avatarUrl ? "更换头像" : "上传头像"}
            </Button>
            <Link className={styles.link} to="/admin/tokens">
              管理我的密钥 →
            </Link>
          </div>
        </section>

        {/* ---------- 紧凑统计条 ---------- */}
        <section className={styles.stats} aria-label="账号概览">
          <div className={styles.chip}>
            <span className={styles.chipLabel}>可用额度</span>
            <strong className={`${styles.chipValue} ${styles.amount}`}>
              {formatAmount(user.quota - user.used_quota, currency)}
              <CurrencyIcon src={currency.icon} size="0.9em" />
            </strong>
          </div>
          <div className={styles.chip}>
            <span className={styles.chipLabel}>已用额度</span>
            <strong className={`${styles.chipValue} ${styles.amount}`}>
              {formatAmount(user.used_quota, currency)}
              <CurrencyIcon src={currency.icon} size="0.9em" />
            </strong>
          </div>
          <div className={styles.chip}>
            <span className={styles.chipLabel}>注册时间</span>
            <strong className={styles.chipValue}>{formatTime(user.created_at)}</strong>
          </div>
          <div className={styles.chip}>
            <span className={styles.chipLabel}>最近登录</span>
            <strong className={styles.chipValue}>{formatTime(user.last_login_at)}</strong>
          </div>
        </section>

        {/* ---------- 资料 / 安全 / 绑定 ---------- */}
        <Tabs defaultValue="profile">
          <TabsList>
            <TabsTrigger value="profile">资料</TabsTrigger>
            <TabsTrigger value="security">安全</TabsTrigger>
            <TabsTrigger value="bindings">绑定</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <div className={styles.panel}>
              {loadError ? (
                <div className={styles.errorBox} role="alert">
                  <span className={styles.errorText}>{loadError}</span>
                  <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>
                    重试
                  </Button>
                </div>
              ) : (
                <>
                  <div className={styles.form} inert={locked || loading}>
                    <Input
                      label="显示名称"
                      maxLength={64}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      description="留空则显示用户名"
                    />
                    <Input
                      label="邮箱"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      error={emailError}
                    />
                    <Input
                      label="个人链接"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      placeholder="https://（选填）"
                      error={websiteError}
                    />
                    <Input
                      label="所在地"
                      maxLength={64}
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="如：杭州（选填）"
                    />
                    <Textarea
                      label="个人简介"
                      rows={3}
                      maxLength={255}
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      description="会在个人主页展示"
                    />
                  </div>
                  <div className={styles.actions}>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={savingProfile}
                      disabled={locked || loading}
                      onClick={() => void saveProfile()}
                    >
                      保存修改
                    </Button>
                  </div>
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value="security">
            <div className={styles.panel}>
              {passwordChanged && (
                <p className={styles.note} role="status">
                  密码已修改，请重新登录
                </p>
              )}
              <div className={styles.form} inert={locked}>
                <PasswordField
                  label="当前密码"
                  autoComplete="current-password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
                <div className={styles.field}>
                  <PasswordField
                    label="新密码"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    description="至少 8 位，需同时包含字母与数字"
                  />
                  {newPasswordError && (
                    <p className={styles.fieldError} role="alert">
                      {newPasswordError}
                    </p>
                  )}
                </div>
                <div className={styles.field}>
                  <PasswordField
                    label="确认新密码"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                  {confirmError && (
                    <p className={styles.fieldError} role="alert">
                      {confirmError}
                    </p>
                  )}
                </div>
              </div>
              <div className={styles.actions}>
                <HoldToConfirm
                  key={String(action.busy)}
                  label={savingPassword ? "正在修改密码…" : "长按修改密码并重新登录"}
                  confirmedLabel="密码已修改，请重新登录"
                  confirmed={passwordChanged}
                  duration={1200}
                  tone="danger"
                  disabled={locked || !passwordReady}
                  onConfirm={() => void changePassword()}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="bindings">
            <div className={styles.panel}>
              {bindingsError ? (
                <div className={styles.errorBox} role="alert">
                  <span className={styles.errorText}>{bindingsError}</span>
                  <Button variant="secondary" size="sm" onClick={() => void loadBindings()}>
                    重试
                  </Button>
                </div>
              ) : bindings.length === 0 ? (
                <p className={styles.hint}>还没有绑定任何三方账号。可在登录页用三方账号注册或绑定。</p>
              ) : (
                <ul className={styles.bindings}>
                  {bindings.map((binding) => {
                    const icon = vendorIconUrl(binding.provider);
                    return (
                      <li key={binding.provider} className={styles.binding}>
                        {icon && <img className={styles.bindingIcon} src={icon} alt="" loading="lazy" />}
                        <div className={styles.bindingText}>
                          <strong>{vendorLabel(binding.provider)}</strong>
                          <span>{binding.username || binding.email || "已绑定"}</span>
                        </div>
                        <HoldToConfirm
                          key={String(action.busy)}
                          label={`长按解绑 ${vendorLabel(binding.provider)} 登录`}
                          confirmedLabel="已解绑"
                          tone="danger"
                          duration={1200}
                          disabled={locked}
                          confirmed={unbound[binding.provider] ?? false}
                          onConfirm={() => void unbind(binding.provider)}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}

              <p className={styles.hint}>解绑前请确认还有其他可用的登录方式 —— 否则会失去账号访问权限。</p>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <AvatarUploader
        open={uploaderOpen}
        onClose={() => setUploaderOpen(false)}
        currentAvatar={avatarUrl}
        userName={name}
        onDone={(url) => {
          setProfile((prev) => (prev ? { ...prev, avatar_url: url } : prev));
          void refresh();
        }}
      />
    </AdminLayout>
  );
}
