import type { CSSProperties } from "react";

/**
 * 已授权面板的背景占位。
 * 预构建渐变（feral-gradient.js，307KB）不在仓库里。同目录若放了那个 .js，
 * Vite 会优先用它；这里只保证干净检出时 import("@/vendor/feral-gradient") 能通过构建。
 */
export default function GradientBackdrop({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
  speed?: number;
}) {
  return <div className={className} style={style} />;
}
