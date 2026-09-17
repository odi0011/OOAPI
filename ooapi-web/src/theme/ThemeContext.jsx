import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { SURFACES, applyCssVars, DEFAULT_PRIMARY, tint } from "./presets";

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

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(() => load(MODE_KEY, "system"));
  const [primary, setPrimaryState] = useState(() => load(PRIMARY_KEY, DEFAULT_PRIMARY));
  const [systemDark, setSystemDark] = useState(() => systemResolved() === "dark");

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    applyCssVars(resolved, primary);
  }, [resolved, primary]);

  const setMode = useCallback((m) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch { /* ignore */ }
  }, []);

  const setPrimary = useCallback((c) => {
    setPrimaryState(c);
    try {
      localStorage.setItem(PRIMARY_KEY, c);
    } catch { /* ignore */ }
  }, []);

  // antd 主题：与 beautifului 令牌同构（13px 正文、8px 圆角、环形阴影）
  const antdConfig = useMemo(() => {
    const s = SURFACES[resolved];
    const isDark = resolved === "dark";

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

        colorBorder: s.line,
        colorBorderSecondary: s.lineSoft,
        colorSplit: s.line,

        // 几何：对齐 beautifului 圆角阶梯
        borderRadius: 8,
        borderRadiusLG: 10,
        borderRadiusSM: 6,
        borderRadiusXS: 4,
        controlHeight: 30,
        controlHeightLG: 36,
        controlHeightSM: 26,

        fontSize: 14,
        fontSizeSM: 13,
        fontSizeLG: 15,
        fontSizeXL: 18,
        lineHeight: 1.5,

        fontFamily:
          'Inter, "Inter Fallback", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
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
          itemBorderRadius: 8,
          itemMarginInline: 0,
        },
        Card: {
          colorBorderSecondary: s.line,
          paddingLG: 14,
          headerHeight: 44,
          headerFontSize: 13,
        },
        Table: {
          headerBg: "transparent",
          headerColor: s.ink3,
          headerSplitColor: "transparent",
          borderColor: s.lineSoft,
          rowHoverBg: s.hover,
          cellPaddingBlock: 10,
          cellPaddingInline: 12,
          cellFontSize: 13,
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
        Modal: { borderRadiusLG: 14, paddingContentHorizontalLG: 20, titleFontSize: 15 },
        Tag: { defaultBg: s.field, defaultColor: s.ink2, borderRadiusSM: 6 },
        Tabs: { horizontalItemPadding: "9px 0", titleFontSize: 14, inkBarColor: primary },
        Segmented: {
          itemSelectedBg: s.surface,
          itemSelectedColor: s.ink,
          trackBg: s.field,
          itemColor: s.ink3,
          borderRadius: 9999,
          borderRadiusSM: 9999,
        },
        Statistic: { titleFontSize: 12.5, contentFontSize: 21 },
        Descriptions: { labelColor: s.ink3, itemPaddingBottom: 10 },
        Alert: { borderRadiusLG: 10 },
        Divider: { colorSplit: s.line },
        Dropdown: { paddingBlock: 4 },
        Form: { labelColor: s.ink3, labelFontSize: 13, verticalLabelPadding: "0 0 5px" },
        Empty: { colorTextDescription: s.ink3 },
        Message: { contentBg: s.surface },
        Tooltip: { colorBgSpotlight: s.tooltipBg, colorTextLightSolid: s.tooltipFg, borderRadius: 8 },
        Popover: { borderRadiusLG: 10 },
      },
    };
  }, [resolved, primary]);

  const value = useMemo(
    () => ({ mode, setMode, resolved, primary, setPrimary }),
    [mode, resolved, primary, setMode, setPrimary]
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
