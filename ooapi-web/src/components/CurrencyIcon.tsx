import styles from "./CurrencyIcon.module.css";

interface CurrencyIconProps {
  /** 图标地址（管理员可上传自定义）。缺省用内置金币。 */
  src?: string | null;
  /** 尺寸，跟随字号时用 "1em"。 */
  size?: number | string;
  /** 无障碍文本，默认读作"货币单位"。 */
  alt?: string;
  className?: string;
}

/**
 * 货币单位图标。
 *
 * 站内所有金额后面统一用它代表单位，不再写死文字（如 "OD"）——
 * 货币名称与图标都由管理员在设置里配置，可以随时改名换图。
 *
 * 用 <img> 而不是内联 SVG：管理员上传的图标是独立文件，
 * 内联会把它注入到 DOM 里，且无法用同一套样式统一尺寸。
 */
export default function CurrencyIcon({
  src,
  size = "1em",
  alt = "货币单位",
  className,
}: CurrencyIconProps) {
  // 未上传自定义图标时用内置金币兜底。
  const url = src && src.trim() ? src : "/currency-default.svg";

  return (
    <img
      className={[styles.icon, className].filter(Boolean).join(" ")}
      src={url}
      alt={alt}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
