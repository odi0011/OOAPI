import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import {
  applyCssVars, applyAppearance, DEFAULT_PRIMARY,
  normalizeAppearance, isHexColor,
  readSiteAppearanceCache, writeSiteAppearanceCache,
} from "./presets";

const ThemeContext = createContext(null);
const safeMode = (value) => ["light", "dark", "system"].includes(value) ? value : "system";
const PERSONAL_MODE_KEY = "ooapi-color-mode";
const readPersonalMode = () => {
  try { const value = localStorage.getItem(PERSONAL_MODE_KEY); return ["light", "dark"].includes(value) ? value : null; }
  catch { return null; }
};

// 站点设置提供默认外观；访客可单独保存明暗偏好，编辑器预览不写缓存。
export function ThemeProvider({ children }) {
  const [site, setSite] = useState(readSiteAppearanceCache);
  const [canPreview, setCanPreview] = useState(false);
  const [preview, setPreview] = useState(null);
  const [personalMode, setPersonalMode] = useState(readPersonalMode);
  const [systemDark, setSystemDark] = useState(() => !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (e) => setSystemDark(e.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const current = canPreview && preview ? { ...site, ...preview } : site;
  // 访客只覆盖自己浏览器的明暗模式；管理员编辑时仍预览正在配置的站点默认值。
  const mode = safeMode(canPreview && preview ? current.mode : personalMode || current.mode);
  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  const appearance = useMemo(() => normalizeAppearance(current), [site, preview, canPreview]);
  const primary = isHexColor(current.accent) ? current.accent : DEFAULT_PRIMARY;
  useEffect(() => { applyCssVars(resolved, primary); }, [resolved, primary]);
  useEffect(() => { applyAppearance(appearance); }, [appearance]);
  const previewAppearance = useCallback((draft) => setPreview(draft), []);
  const setColorMode = useCallback((value) => {
    const next = ["light", "dark"].includes(value) ? value : null;
    setPersonalMode(next);
    try { if (next) localStorage.setItem(PERSONAL_MODE_KEY, next); else localStorage.removeItem(PERSONAL_MODE_KEY); }
    catch { /* 禁用存储时仍可在当前页面切换。 */ }
  }, []);
  useEffect(() => {
    const sync = (e) => { if (e.key === PERSONAL_MODE_KEY || e.key === null) setPersonalMode(readPersonalMode()); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const setSiteAppearance = useCallback((a, administrator = false) => {
    setCanPreview(Boolean(administrator));
    if (!administrator) setPreview(null);
    if (!a || typeof a !== "object") return;
    const next = { ...normalizeAppearance(a), mode: safeMode(a.mode), accent: isHexColor(a.accent) ? a.accent : "", user_custom: false };
    writeSiteAppearanceCache(next);
    setSite((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
  }, []);

  const previewing = Boolean(canPreview && preview);
  const value = useMemo(() => ({ mode, resolved, primary, appearance, site, setSiteAppearance, previewAppearance, setColorMode, personalMode, previewing, userCustom: false, siteLocked: true }),
    [mode, resolved, primary, appearance, site, setSiteAppearance, previewAppearance, setColorMode, personalMode, previewing]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}
