import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  SURFACES, applyCssVars, applyAppearance, DEFAULT_PRIMARY, tint, oklchToHex,
  RADIUS_PRESETS, DENSITY_PRESETS, APPEARANCE_KEYS, normalizeAppearance, isHexColor,
  readSiteAppearanceCache, writeSiteAppearanceCache,
} from "./presets";

const MODE_KEY = "ooapi-theme";
const PRIMARY_KEY = "ooapi-primary";

const ThemeContext = createContext(null);

function systemResolved() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function load(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    if (value === null || value === undefined || value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* 隐私模式写不了：本次会话仍生效 */ }
}

// 非法主题值（脏数据/被篡改）会让 SURFACES[resolved] 取到 undefined 而白屏，
// 且坏值留在 localStorage 里刷新也无法自愈，这里统一归一化
function safeMode(m) {
  return ["light", "dark", "system"].includes(m) ? m : "system";
}

/** 读用户本地覆盖的外观项（只返回真正存过的键；没存过 = 跟随站点默认） */
function loadOverrides() {
  const out = {};
  for (const [k, storageKey] of Object.entries(APPEARANCE_KEYS)) {
    const v = load(storageKey, "");
    if (v) out[k] = v;
  }
  return normalizeAppearance(out, { partial: true });
}

/**
 * 主题状态的唯一来源。
 *
 * 外观（底纹/圆角/密度/字号）原先只由 AppearancePage 直接 setProperty，
 * 状态不进 React —— 于是有三个问题：
 *   ① AntD 组件的圆角/控件高度/字号是 ConfigProvider token，只改 CSS 变量
 *      对按钮、输入框、弹窗**完全不生效**（选「直角」后只有自绘组件变直角）；
 *   ② 页面初值是写死的默认值而不是当前生效值（普通用户读不到 /api/option，
 *      刷新后外观页显示「标准」，实际生效的是自己上次选的「宽松」）；
 *   ③ 站点默认外观从未下发给普通用户。
 * 现在：站点默认（/api/status.appearance）+ 用户本地覆盖 → 生效值，
 * 同时驱动 CSS 变量与 AntD token。
 */
export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(() => safeMode(load(MODE_KEY, "system")));
  const [primaryOverride, setPrimaryOverride] = useState(() => {
    const v = load(PRIMARY_KEY, "");
    return isHexColor(v) ? v : "";
  });
  const [overrides, setOverrides] = useState(loadOverrides);
  const [site, setSite] = useState(readSiteAppearanceCache);
  const [exempt, setExempt] = useState(false);
  const [systemDark, setSystemDark] = useState(() => systemResolved() === "dark");

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  const siteLocked = site.user_custom === false;
  const userCustom = !siteLocked || exempt;

  // 生效值：允许个性化时「本地覆盖 > 站点默认」，否则一律站点默认
  const appearance = useMemo(
    () => normalizeAppearance(userCustom ? { ...site, ...overrides } : site),
    [site, overrides, userCustom]
  );
  const primary = (userCustom && primaryOverride) || (isHexColor(site.accent) ? site.accent : "") || DEFAULT_PRIMARY;

  useEffect(() => {
    applyCssVars(resolved, primary);
  }, [resolved, primary]);

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  const setMode = useCallback((m) => {
    const safe = safeMode(m);
    setModeState(safe);
    save(MODE_KEY, safe);
  }, []);

  const setPrimary = useCallback((c) => {
    const v = isHexColor(c) ? c : "";
    setPrimaryOverride(v);
    save(PRIMARY_KEY, v);
  }, []);

  /** 改外观（可只传改动项）：写本地覆盖，立刻生效 */
  const setAppearance = useCallback((patch) => {
    const clean = normalizeAppearance(patch, { partial: true });
    setOverrides((prev) => ({ ...prev, ...clean }));
    for (const [k, v] of Object.entries(clean)) save(APPEARANCE_KEYS[k], v);
  }, []);

  /** 清掉本地覆盖，回到站点默认（主题色一并清） */
  const resetAppearance = useCallback(() => {
    setOverrides({});
    for (const storageKey of Object.values(APPEARANCE_KEYS)) save(storageKey, "");
    setPrimaryOverride("");
    save(PRIMARY_KEY, "");
  }, []);

  /** AppContext 拿到 /api/status 后调用；exempt=true（管理员）不受「禁止个性化」约束 */
  const setSiteAppearance = useCallback((a, exemptFlag = false) => {
    setExempt(Boolean(exemptFlag));
    if (!a || typeof a !== "object") return;
    const next = { ...normalizeAppearance(a), accent: isHexColor(a.accent) ? a.accent : "", user_custom: a.user_custom !== false };
    writeSiteAppearanceCache(next);
    setSite((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  const antdConfig = useAntdConfig(resolved, primary, appearance);

  const value = useMemo(
    () => ({
      mode, setMode, resolved, primary, setPrimary, primaryOverride,
      appearance, overrides, setAppearance, resetAppearance,
      site, setSiteAppearance, userCustom, siteLocked,
    }),
    [mode, setMode, resolved, primary, setPrimary, primaryOverride, appearance, overrides, setAppearance, resetAppearance, site, setSiteAppearance, userCustom, siteLocked]
  );

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider locale={zhCN} theme={antdConfig}>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}

const px = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * AntD 主题：与 beautifului 令牌同构，几何量跟随外观设置。
 * 默认档（圆角「默认」+ 密度「紧凑」+ 字号 13）换算出来与改版前的写死值完全一致
 * （8/10/6/4 圆角、30 控件高、14 字号），所以没调过外观的用户观感不变。
 */
function useAntdConfig(resolved, primary, appearance) {
  return useMemo(() => {
    const s = SURFACES[resolved] || SURFACES.light;
    const isDark = resolved === "dark";
    const r = (RADIUS_PRESETS.find((p) => p.key === appearance.radius) || RADIUS_PRESETS[1]).r;
    const d = DENSITY_PRESETS.find((p) => p.key === appearance.density) || DENSITY_PRESETS[0];
    const fs = Math.min(16, Math.max(12, Number(appearance.fontSize) || 13));
    const rBtn = px(r.btn, 8);
    const rCard = px(r.card, 10);
    const rChip = px(r.chip, 6);
    const rXs = px(r.xs, 4);
    const rWindow = px(r.window, 14);
    const pill = appearance.radius === "sharp" ? rBtn : 9999;

    return {
      algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: primary,
        colorInfo: primary,
        colorSuccess: isDark ? "#4cc38a" : "#30a46c",
        colorWarning: isDark ? "#f5a623" : "#c47f17",
        colorError: isDark ? "#ef6b6b" : "#d93b3b",

        colorBgLayout: s.page,
        colorBgContainer: s.surface,
        colorBgElevated: s.surface,
        colorBgSpotlight: s.tooltipBg,

        colorText: s.ink,
        colorTextSecondary: s.ink2,
        colorTextTertiary: s.ink3,
        colorTextQuaternary: s.ink3,
        // 禁用态文字：**必须显式给**，否则落到 AntD 暗色算法默认值，
        // 在深底上几乎看不见。人格实测（阿蓝，量过对比度）：
        //   「社区分页的『上一页』：oklch(0.541…) 灰字压在 rgb(39,40,43) 深底上，
        //     对比度 1.8:1（可读下限是 3:1）。按钮是 disabled 态，
        //     但同一个『下一页』是亮的，对比明显。」
        // 用 ink3（调色板里已过对比度校验的次级文字色），
        // 比正文弱、但仍在可读范围内 —— 禁用态该「看起来弱」，不该「看不见」。
        colorTextDisabled: s.ink3,

        colorBorder: s.line,
        colorBorderSecondary: s.lineSoft,
        colorSplit: s.line,

        // 空状态插画（Empty.PRESENTED_IMAGE_SIMPLE）的填充色。
        //
        // 它读的是**全局** token（`useToken()`）里的 colorFill /
        // colorFillTertiary / colorFillQuaternary，而不是组件级 Empty 段配置 ——
        // 所以写在 `components: { Empty: {...} }` 里**不会生效**（我第一版就是
        // 写在那里，实测插画仍是 rgb(20,20,20)，与面板对比度 1.01:1）。
        //
        // AntD 的暗色算法给这三个 token 的默认值仍是近黑（rgba(0,0,0,.88) 系），
        // 合成到我们的暗色面板上就是「一块糊黑」（黑盒测试实测报上来的）。
        // 这里显式指向调色板里的 line / lineSoft —— 两种主题下都过了对比度校验，
        // 且随主题切换自动跟随。
        //
        // **必须 oklchToHex**：调色板是 oklch，而 AntD 的颜色合成库不认 oklch
        //（解析失败退化成纯黑，实测 rgb(0,0,0)、对比度 1.15:1 —— 换了个黑法而已）。
        // 见 presets.js 里 oklchToHex 的说明。
        colorFill: oklchToHex(s.line),
        colorFillTertiary: oklchToHex(s.lineSoft),
        colorFillQuaternary: oklchToHex(s.field),

        // 几何：圆角阶梯与控件高度跟随外观设置（见函数头注释）
        borderRadius: rBtn,
        borderRadiusLG: rCard,
        borderRadiusSM: rChip,
        borderRadiusXS: rXs,
        controlHeight: d.control.md,
        controlHeightLG: d.control.lg,
        controlHeightSM: d.control.sm,

        fontSize: fs + 1,
        fontSizeSM: fs,
        fontSizeLG: fs + 2,
        fontSizeXL: fs + 5,
        lineHeight: 1.5,

        fontFamily:
          '"Noto Sans SC", "Noto Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        fontFamilyCode:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',

        boxShadow: s.shadowCard,
        boxShadowSecondary: s.shadowOverlay,
        wireframe: false,
        motionDurationMid: "0.15s",
      },
      components: {
        Layout: {
          siderBg: s.page,
          headerBg: "transparent",
          bodyBg: s.page,
          headerHeight: 52,
          headerPadding: "0 16px",
        },
        Menu: {
          itemBg: "transparent",
          subMenuItemBg: "transparent",
          itemSelectedBg: "transparent",
          itemSelectedColor: primary,
          itemHoverBg: s.hover,
          itemHeight: 32,
          itemBorderRadius: rBtn,
          itemMarginInline: 0,
        },
        Card: {
          colorBorderSecondary: s.line,
          paddingLG: 14,
          headerHeight: 44,
          headerFontSize: fs,
        },
        Table: {
          headerBg: "transparent",
          headerColor: s.ink3,
          headerSplitColor: "transparent",
          borderColor: s.lineSoft,
          rowHoverBg: s.hover,
          cellPaddingBlock: d.cell.block,
          cellPaddingInline: d.cell.inline,
          cellFontSize: fs,
          headerBorderRadius: 0,
        },
        Button: {
          primaryShadow: "none",
          defaultShadow: "none",
          dangerShadow: "none",
          fontWeight: 500,
          paddingInline: 12,
          defaultBg: s.surface,
          defaultBorderColor: "transparent",
        },
        Input: { paddingBlock: 4, activeShadow: `0 0 0 3px ${tint(primary, 0.14)}`, colorBgContainer: s.field },
        InputNumber: { activeShadow: `0 0 0 3px ${tint(primary, 0.14)}`, colorBgContainer: s.field },
        Select: { optionSelectedBg: tint(primary, isDark ? 0.18 : 0.1), colorBgContainer: s.field },
        TreeSelect: { colorBgContainer: s.field },
        DatePicker: { colorBgContainer: s.field },
        Modal: { borderRadiusLG: rWindow, paddingContentHorizontalLG: 20, titleFontSize: fs + 2 },
        Tag: { defaultBg: s.field, defaultColor: s.ink2, borderRadiusSM: rChip },
        Tabs: { horizontalItemPadding: "9px 0", titleFontSize: fs + 1, inkBarColor: primary },
        Segmented: {
          itemSelectedBg: s.surface,
          itemSelectedColor: s.ink,
          trackBg: s.field,
          itemColor: s.ink3,
          borderRadius: pill,
          borderRadiusSM: pill,
        },
        Statistic: { titleFontSize: 12.5, contentFontSize: 21 },
        Descriptions: { labelColor: s.ink3, itemPaddingBottom: 10 },
        Alert: { borderRadiusLG: rCard },
        Divider: { colorSplit: s.line },
        Dropdown: { paddingBlock: 4 },
        Form: { labelColor: s.ink3, labelFontSize: fs, verticalLabelPadding: "0 0 5px" },
        // 注意：插画的填充色**不能**在这里配 —— 它读全局 token，
        // 见上面 `token.colorFill` 处的注释（我第一版写在这里，实测无效）。
        Empty: { colorTextDescription: s.ink3 },
        Message: { contentBg: s.surface },
        Tooltip: { colorBgSpotlight: s.tooltipBg, colorTextLightSolid: s.tooltipFg, borderRadius: rBtn },
        Popover: { borderRadiusLG: rCard },
      },
    };
  }, [resolved, primary, appearance]);
}
