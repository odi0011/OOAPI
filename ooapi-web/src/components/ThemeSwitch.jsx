import React from "react";
import { Tooltip } from "antd";
import { SunOutlined, MoonOutlined, DesktopOutlined } from "@ant-design/icons";
import { useTheme } from "../theme/ThemeContext";

const OPTIONS = [
  { value: "light", label: "明亮", icon: <SunOutlined /> },
  { value: "dark", label: "黑暗", icon: <MoonOutlined /> },
  { value: "system", label: "跟随系统", icon: <DesktopOutlined /> },
];

/**
 * 主题切换：明亮 / 黑暗 / 跟随系统
 *
 * 第 80 批改为自绘（原为 AntD Segmented + 每个图标外包 Tooltip）：
 *   · Segmented 的选中滑块尺寸由它内部 thumb 计算，而 styles.css 在移动端给
 *     .ant-segmented-item 强制了 min-height:36px（触控目标）—— 滑块不跟着变，
 *     选中态成了一块被切掉的白底（用户截图：右上角选中态被切割）；
 *   · 桌面端 pill 轨道 + Tooltip 包裹的 span 让图标偏离中线，选中块贴边。
 * 自绘后轨道、按钮、选中块的尺寸全部由同一组 CSS 变量决定（.oo-theme-switch），不会再错位。
 */
export default function ThemeSwitch({ size = "middle" }) {
  const { mode, setMode } = useTheme();
  const idx = Math.max(0, OPTIONS.findIndex((o) => o.value === mode));
  return (
    <div
      className={`oo-theme-switch${size === "small" ? " is-small" : ""}`}
      role="radiogroup"
      aria-label="主题模式"
      style={{ "--i": idx }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const next = OPTIONS[(idx + (e.key === "ArrowRight" ? 1 : OPTIONS.length - 1)) % OPTIONS.length];
        setMode(next.value);
        e.currentTarget.querySelector(`[data-v="${next.value}"]`)?.focus();
      }}
    >
      <span className="oo-theme-switch-thumb" aria-hidden="true" />
      {OPTIONS.map((o) => (
        <Tooltip key={o.value} title={o.label} mouseEnterDelay={0.4}>
          <button
            type="button"
            role="radio"
            data-v={o.value}
            aria-checked={mode === o.value}
            aria-label={o.label}
            tabIndex={mode === o.value ? 0 : -1}
            className={mode === o.value ? "is-on" : ""}
            onClick={() => setMode(o.value)}
          >
            {o.icon}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
