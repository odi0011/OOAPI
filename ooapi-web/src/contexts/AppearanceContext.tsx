import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { apiRequest } from "@/lib/api";
import { DEFAULT_FONT_ID, fontStack } from "@/lib/fonts";

/** 明暗模式。system 表示跟随访问者的系统偏好。 */
export type ThemeMode = "light" | "dark" | "system";

/** 主题色，与组件库 foundation.css 的 data-accent 取值一一对应。 */
export type AccentColor =
  | "neutral"
  | "violet"
  | "blue"
  | "green"
  | "amber"
  | "orange"
  | "coral"
  | "rose";

export interface Appearance {
  theme: ThemeMode;
  accent: AccentColor;
  /** 站点字体 id，见 lib/fonts.ts 的 FONTS。 */
  font: string;
}

const DEFAULT: Appearance = { theme: "system", accent: "neutral", font: DEFAULT_FONT_ID };

/** 本机明暗预览的存储键。 */
const LOCAL_THEME_KEY = "ooapi_local_theme";

interface AppearanceContextValue extends Appearance {
  /**
   * 实际生效的明暗模式（本机预览优先于站点设置）。
   * 顶栏的主题开关改的是这一层。
   */
  effectiveTheme: ThemeMode;
  resolvedTheme: "light" | "dark";
  /** 外观由管理员统一配置、对全站生效，普通用户不能改站点设置。 */
  refresh: () => Promise<void>;
  /**
   * 设置本机明暗预览。
   *
   * 故意与站点设置分开：顶栏的快捷开关是个人化的、可随时撤回的，
   * 不应该悄悄改掉所有访问者看到的外观。改全站配色请用系统设置 → 外观。
   */
  setLocalTheme: (theme: ThemeMode) => void;
  /** 清除本机预览，回到跟随站点设置。 */
  clearLocalTheme: () => void;
  /**
   * 临时预览外观（不落库）。
   *
   * 设置页在编辑时调用：改字体或主题色立刻能看到效果，
   * 不必先保存再手动刷新页面。保存成功后 refresh() 用服务端值覆盖它；
   * 点「放弃修改」时 clearPreview() 还原。
   */
  previewAppearance: (patch: Partial<Appearance>) => void;
  /** 丢弃未保存的预览，回到服务端配置。 */
  clearPreview: () => void;
  /** 是否正处于本机预览状态。 */
  isLocalOverride: boolean;
}

const AppearanceContext = createContext<AppearanceContextValue>({
  ...DEFAULT,
  effectiveTheme: DEFAULT.theme,
  resolvedTheme: "light",
  refresh: async () => {},
  setLocalTheme: () => {},
  clearLocalTheme: () => {},
  previewAppearance: () => {},
  clearPreview: () => {},
  isLocalOverride: false,
});

/** 把设置写到 <html> 上。组件库的选择器（:root[data-theme] / :root[data-accent]）据此切换整套变量。 */
function applyAppearance(appearance: Appearance, effectiveTheme: ThemeMode) {
  const root = document.documentElement;

  const resolvedTheme = effectiveTheme === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : effectiveTheme;
  root.setAttribute("data-theme", resolvedTheme);

  if (appearance.accent === "neutral") {
    // neutral 是 foundation.css 的默认值，无需属性。
    root.removeAttribute("data-accent");
  } else {
    root.setAttribute("data-accent", appearance.accent);
  }

  /* 字体同样写在根元素上：组件库的 --font-body / --font-display 会取到它，
     因此管理员换一次字体，全站（含未登录访客）都跟着变。 */
  const stack = fontStack(appearance.font);
  root.style.setProperty("--font-body", stack);
  root.style.setProperty("--font-display", stack);
  root.style.setProperty("--site-font", stack);
  root.style.setProperty("--mono", stack);
  root.style.setProperty("--font-mono", stack);
}

/**
 * 全站外观 Provider。
 *
 * 数据来自 /api/settings/public，它读的是管理员在设置页保存的值。
 * 因此管理员改一次，所有访问者（含未登录的首页访客）看到的配色都跟着变 ——
 * 这正是「统一外观」的诉求，而不是存在浏览器本地的个人偏好。
 *
 * 唯一的例外是顶栏那个明暗开关：它写的是本机预览（localStorage），
 * 只影响当前浏览器，不会改动站点设置。
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT);
  const [localTheme, setLocalThemeState] = useState<ThemeMode | null>(null);
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  /** 设置页的临时预览；非空时覆盖服务端值。 */
  const [preview, setPreview] = useState<Partial<Appearance> | null>(null);

  // 启动时读本机预览
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCAL_THEME_KEY);
      if (saved === "light" || saved === "dark" || saved === "system") {
        setLocalThemeState(saved);
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await apiRequest<{ appearance?: Partial<Appearance> }>(
        "/api/settings/public",
      );
      setAppearance({
        theme: (data.appearance?.theme as ThemeMode) ?? DEFAULT.theme,
        accent: (data.appearance?.accent as AccentColor) ?? DEFAULT.accent,
        font: data.appearance?.font ?? DEFAULT.font,
      });
      // 已拿到服务端值，未保存的预览就此作废
      setPreview(null);
    } catch {
      /* 取不到就用默认外观，不阻塞渲染 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setLocalTheme = useCallback((theme: ThemeMode) => {
    setLocalThemeState(theme);
    try {
      localStorage.setItem(LOCAL_THEME_KEY, theme);
    } catch {
      /* 忽略 */
    }
  }, []);

  const clearLocalTheme = useCallback(() => {
    setLocalThemeState(null);
    try {
      localStorage.removeItem(LOCAL_THEME_KEY);
    } catch {
      /* 忽略 */
    }
  }, []);

  const previewAppearance = useCallback((patch: Partial<Appearance>) => {
    setPreview((prev) => ({ ...prev, ...patch }));
  }, []);

  const clearPreview = useCallback(() => setPreview(null), []);

  /** 预览值优先于服务端值。 */
  const effectiveAppearance: Appearance = useMemo(
    () => (preview ? { ...appearance, ...preview } : appearance),
    [appearance, preview],
  );

  const effectiveTheme = localTheme ?? effectiveAppearance.theme;
  const resolvedTheme = effectiveTheme === "system" ? systemTheme : effectiveTheme;

  // 每次变化都同步到 <html>，组件库与页面样式据此切换。
  useEffect(() => {
    applyAppearance(effectiveAppearance, effectiveTheme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystem = () => { setSystemTheme(media.matches ? "dark" : "light"); if (effectiveTheme === "system") applyAppearance(effectiveAppearance, effectiveTheme); };
    media.addEventListener("change", applySystem);
    return () => media.removeEventListener("change", applySystem);
  }, [effectiveAppearance, effectiveTheme]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      ...effectiveAppearance,
      effectiveTheme,
      resolvedTheme,
      refresh,
      setLocalTheme,
      clearLocalTheme,
      previewAppearance,
      clearPreview,
      isLocalOverride: localTheme !== null,
    }),
    [
      effectiveAppearance,
      effectiveTheme,
      resolvedTheme,
      refresh,
      setLocalTheme,
      clearLocalTheme,
      previewAppearance,
      clearPreview,
      localTheme,
    ],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  return useContext(AppearanceContext);
}

/** 主题色的中文名，供设置页的选择器展示。 */
export const ACCENT_LABELS: Record<AccentColor, string> = {
  neutral: "中性灰",
  violet: "紫罗兰",
  blue: "蓝",
  green: "绿",
  amber: "琥珀",
  orange: "橙",
  coral: "珊瑚",
  rose: "玫红",
};

/** 主题色的预览色值，与 foundation.css 的浅色模式取值保持一致。 */
export const ACCENT_SWATCHES: Record<AccentColor, string> = {
  neutral: "#3b3b3b",
  violet: "#7747ff",
  blue: "#0562ef",
  green: "#0db879",
  amber: "#f3ad20",
  orange: "#f48120",
  coral: "#f15f55",
  rose: "#ed4e9d",
};
