import { useMemo } from "react";

import { Select } from "@/components/arc/select/select";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { ACCENT_LABELS, ACCENT_SWATCHES, type AccentColor, type ThemeMode } from "@/contexts/AppearanceContext";
import { FONTS } from "@/lib/fonts";

import styles from "./Section.module.css";

interface AppearanceSectionProps {
  value: { theme: string; accent: string; font: string; density: string };
  onChange: (value: { theme: string; accent: string; font: string; density: string }) => void;
}

/**
 * 外观设置。
 *
 * 这些值写到 <html> 的 data-theme / data-accent 与 --site-font 上，
 * 组件库与页面样式据此切换 —— 所以改一次，全站（含未登录访客）立刻跟着变。
 *
 * 用 SegmentedControl / 自定义色板而不是 RadioGroup：
 * RadioGroup 的选项是「每项占一整行、带边框」的列表式布局，
 * 而这里都是两三个字的短选项，列表式会浪费大半个行宽。
 */
export default function AppearanceSection({ value, onChange }: AppearanceSectionProps) {
  // 字体按分组整理，供下拉选择器使用
  const fontOptions = useMemo(
    () =>
      FONTS.map((f) => ({
        value: f.id,
        label: f.id === "zcool-kuaile" ? `${f.label}（默认）` : f.label,
      })),
    [],
  );

  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>外观</h2>
      </header>

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>站点字体</strong>
            <p>全站统一的字体，含首页、登录页与后台。</p>
          </div>
          <div className={styles.rowControl}>
            <Select
              label="站点字体"
              options={fontOptions}
              value={value.font}
              onValueChange={(font) => onChange({ ...value, font })}
            />
            {/* 用选中字体渲染一行预览，管理员不必保存后回前台确认 */}
            <p className={styles.fontPreview} style={{ fontFamily: `var(--site-font)` }}>
              站酷快乐体 · 大模型 API 网关 0123
            </p>
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>明暗模式</strong>
          </div>
          <div className={styles.rowControlInline}>
            <SegmentedControl
              label="明暗模式"
              value={value.theme}
              onValueChange={(theme) => onChange({ ...value, theme: theme as ThemeMode })}
              options={[
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
                { value: "system", label: "跟随系统" },
              ]}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>主题色</strong>
          </div>
          <div className={styles.rowControlInline}>
            <div className={styles.swatches} role="radiogroup" aria-label="主题色">
              {(Object.keys(ACCENT_SWATCHES) as AccentColor[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={value.accent === key}
                  aria-label={ACCENT_LABELS[key]}
                  title={ACCENT_LABELS[key]}
                  className={
                    value.accent === key
                      ? `${styles.swatch} ${styles.swatchActive}`
                      : styles.swatch
                  }
                  onClick={() => onChange({ ...value, accent: key })}
                >
                  <span className={styles.swatchDot} style={{ background: ACCENT_SWATCHES[key] }} />
                  <span className={styles.swatchLabel}>{ACCENT_LABELS[key]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>布局密度</strong>
          </div>
          <div className={styles.rowControlInline}>
            <SegmentedControl
              label="布局密度"
              value={value.density}
              onValueChange={(density) => onChange({ ...value, density })}
              options={[
                { value: "comfortable", label: "舒适" },
                { value: "compact", label: "紧凑" },
              ]}
            />
          </div>
        </div>
      </div>
    </>
  );
}
