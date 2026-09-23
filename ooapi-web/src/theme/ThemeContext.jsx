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

// 非法主题值（脏数据/被篡改）会让 SURFACES[resolved] 取到 undefined 而白屏，
// 且坏值留在 localStorage 里刷新也无法自愈，这里统一归一化
function safeMode(m) {
  return ["light", "dark", "system"].includes(m) ? m : "system";
}

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(() => safeMode(load(MODE_KEY, "system")));
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
    const safe = safeMode(m);
    setModeState(safe);
    try {
      localStorage.setItem(MODE_KEY, safe);
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
    const s = SURFACES[resolved] || SURFACES.light;
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
        colorFill: s.line,
        colorFillTertiary: s.lineSoft,
        colorFillQuaternary: s.field,

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
        // 注意：插画的填充色**不能**在这里配 —— 它读全局 token，
        // 见上面 `token.colorFill` 处的注释（我第一版写在这里，实测无效）。
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
