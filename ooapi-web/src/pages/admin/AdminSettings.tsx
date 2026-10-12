import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/arc/button/button";
import AdminLayout from "@/components/admin/AdminLayout";
import { useAppearance } from "@/contexts/AppearanceContext";
import { ApiRequestError, apiRequest } from "@/lib/api";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import AppearanceSection from "./sections/AppearanceSection";
import AuthSection from "./sections/AuthSection";
import BillingSection from "./sections/BillingSection";
import GatewaySection from "./sections/GatewaySection";
import RegistrationSection from "./sections/RegistrationSection";
import SettingsRail from "./SettingsRail";
import SiteSection from "./sections/SiteSection";
import { SETTINGS_SECTIONS } from "./settingsNav";
import styles from "./AdminSettings.module.css";

/** 设置页的完整配置，与后端 SiteSettings 结构一致。 */
export interface SiteSettings {
  appearance: { theme: string; accent: string; font: string; density: string };
  system_name: string;
  logo: string;
  api_endpoint: string;
  site_base_url: string;
  password_register_enabled: boolean;
  password_login_enabled: boolean;
  quota_for_new_user: number;
  currency_name: string;
  currency_icon: string;
  currency_rate: number;
  units_per_od: number;
  request_timeout_ms: number;
}

/**
 * 分区导航。
 * 「登录与注册」与其余分区同处一页。
 * 「交易」分组在 SettingsRail 里，和这些分区同级，子页是策略与账户。
 */
const SECTIONS = SETTINGS_SECTIONS;

export default function AdminSettings() {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 操作反馈走全局 toast；设置加载失败属页面级问题，内联常驻
  const notify = useNotify();
  const action = useAsyncGuard();
  const [sensitiveDirty, setSensitiveDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState("appearance");
  const [dirty, setDirty] = useState(false);
  const appearanceCtx = useAppearance();

  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  /** 点击导航后短暂关闭滚动联动，避免平滑滚动途中经过的分区把高亮抢走。 */
  const suppressObserver = useRef(false);

  /**
   * 滚动联动：用 IntersectionObserver 观察各分区，
   * 一旦某个分区的标题进入顶部区域就把它设为活跃项，并同步 hash。
   */
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (suppressObserver.current) return;
        // 取当前与顶部最接近且可见的那个分区。
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length === 0) return;

        const key = visible[0].target.getAttribute("data-section");
        if (key) {
          setActive(key);
          window.history.replaceState(null, "", `/admin/system#${key}`);
        }
      },
      // 顶栏 64px + 一点余量作为触发边界，只在分区标题越过它时切换。
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );

    for (const el of Object.values(sectionRefs.current)) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [loading]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<SiteSettings>("/api/admin/settings");
      setSettings(data);
      setDirty(false);
      setSensitiveDirty(false);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "加载设置失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // 支持从侧边栏的 /admin/system#auth 直接跳到对应分区。
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash && SECTIONS.some((s) => s.key === hash)) {
      // 等首屏渲染完成后再滚，否则元素还没挂载。
      const timer = window.setTimeout(() => {
        setActive(hash);
        sectionRefs.current[hash]?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 300);
      return () => window.clearTimeout(timer);
    }
  }, [loading]);

  /** 局部更新：标记为有未保存修改，保存时提交整个设置对象。 */
  const patch = useMemo(
    () => (changes: Partial<SiteSettings>) => {
      if (action.busy) return;
      if (Object.keys(changes).some((key) => !["appearance", "system_name", "logo"].includes(key))) {
        setSensitiveDirty(true);
      }
      setSettings((prev) => (prev ? { ...prev, ...changes } : prev));
      setDirty(true);
  
      /*
        外观类的改动同步到 AppearanceContext 做实时预览。
        不这样做的话，改字体/主题色只改了本页的局部 state，
        要保存并刷新整页才能看到效果 —— 而改外观时「立刻看到」正是重点。
      */
      if (changes.appearance) {
        const a = changes.appearance;
        appearanceCtx.previewAppearance({
          theme: a.theme as never,
          accent: a.accent as never,
          font: a.font,
        });
      }
    },
    [appearanceCtx, action.busy],
  );

  async function save() {
    if (!settings || !action.acquire()) return;
    setSaving(true);
    try {
      const fresh = await apiRequest<SiteSettings>("/api/admin/settings", {
        method: "PUT",
        body: settings,
      });
      setSettings(fresh);
      // 让 Provider 拿到服务端值并清掉预览，避免「已保存但仍显示预览态」
      await appearanceCtx.refresh();
      setDirty(false);
      setSensitiveDirty(false);
      notify.success("设置已保存并立即生效");
    } catch (err) {
      notify.error("保存失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setSaving(false);
      action.release();
    }
  }

  function jumpTo(key: string) {
    setActive(key);
    sectionRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" });
    // 同步 hash：侧边栏据此高亮「系统设置」或「登录与注册」，也便于直接分享链接。
    // 用 replaceState 而不是 pushState，避免每次点分区都塞一条历史记录。
    window.history.replaceState(null, "", `/admin/system#${key}`);

    // 滚动时同步高亮：用户手动滚动经过多个分区时，导航应跟着走。
    // 这里只在点击后短暂关闭观察者，避免与平滑滚动打架。
    suppressObserver.current = true;
    window.setTimeout(() => {
      suppressObserver.current = false;
    }, 700);
  }

  if (loading) {
    return (
      <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "系统设置" }]}>
        <p className={styles.loading}>正在加载设置…</p>
      </AdminLayout>
    );
  }

  if (!settings) {
    return (
      <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "系统设置" }]}>
        <p className={styles.err}>{loadError ?? "加载失败"}</p>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "系统设置" }]}>
      <div className={styles.page}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.title}>系统设置</h1>
          </div>
        </header>

        {loadError && (
          <p className={styles.err} role="alert">
            {loadError}
          </p>
        )}

        <div className={styles.layout}>
          {/* 左侧分区导航 */}
          <SettingsRail current="settings" activeSection={active} onJumpSection={jumpTo} />

          {/* 右侧表单区 */}
          <div className={styles.formArea} inert={action.busy}>
            <section data-section="appearance" ref={(el) => { sectionRefs.current.appearance = el; }} className={styles.section}>
              <AppearanceSection
                value={settings.appearance}
                onChange={(appearance) => patch({ appearance })}
              />
            </section>

            <section data-section="site" ref={(el) => { sectionRefs.current.site = el; }} className={styles.section}>
              <SiteSection
                value={{
                  system_name: settings.system_name,
                  logo: settings.logo,
                  api_endpoint: settings.api_endpoint,
                  site_base_url: settings.site_base_url,
                }}
                onChange={(v) => patch(v)}
              />
            </section>

            <section data-section="registration" ref={(el) => { sectionRefs.current.registration = el; }} className={styles.section}>
              <RegistrationSection
                value={{
                  password_register_enabled: settings.password_register_enabled,
                  password_login_enabled: settings.password_login_enabled,
                  quota_for_new_user: settings.quota_for_new_user,
                }}
                onChange={(v) => patch(v)}
              />
            </section>

            {/* 第三方与邮件：这个分区自带保存按钮，读写的是另一个接口 */}
            <section data-section="auth" ref={(el) => { sectionRefs.current.auth = el; }} className={styles.section}>
              <AuthSection actionGuard={action} />
            </section>

            <section data-section="billing" ref={(el) => { sectionRefs.current.billing = el; }} className={styles.section}>
              <BillingSection
                value={{
                  currency_name: settings.currency_name,
                  currency_icon: settings.currency_icon,
                  currency_rate: settings.currency_rate,
                  units_per_od: settings.units_per_od,
                }}
                onChange={(v) => patch(v)}
              />
            </section>

            <section data-section="gateway" ref={(el) => { sectionRefs.current.gateway = el; }} className={styles.section}>
              <GatewaySection
                value={{ request_timeout_ms: settings.request_timeout_ms }}
                onChange={(v) => patch(v)}
              />
            </section>
          </div>
        </div>

        {/*
          未保存提示：只在有改动时出现，且只占内容区宽度的一部分（浮在右下角），
          不是全宽的横条 —— 全宽横条会把表单压得上移，且暗示「整页都在等保存」。
        */}
        {dirty && (
          <div className={styles.floatBar} role="status" aria-live="polite">
            <span className={styles.floatText}>有未保存的修改</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={action.busy || loading}
              onClick={() => {
                appearanceCtx.clearPreview();
                void load();
              }}
            >
              放弃
            </Button>
            {sensitiveDirty ? (
              <HoldToConfirm
                key={String(action.busy)}
                label={saving ? "正在保存…" : "长按保存，登录、计费或网关将立即变更"}
                confirmed={false}
                duration={1200}
                disabled={action.busy || loading}
                onConfirm={() => void save()}
              />
            ) : (
              <Button variant="primary" size="sm" loading={saving} disabled={action.busy} onClick={() => void save()}>
                保存
              </Button>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
