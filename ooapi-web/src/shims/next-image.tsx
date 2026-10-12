import type { CSSProperties } from "react";

/**
 * Arc UI 的 site-header 等块级组件按 Next.js 编写，内部 import "next/image"。
 * 本项目是 Vite，没有 Next 运行时，因此用 Vite alias 把 next/image 指到这里。
 * 只实现被用到的能力：src / alt / fill / width / height / className / style。
 */
interface ImageProps {
  src: string;
  alt: string;
  /** 撑满父容器（父元素需为 position: relative）。 */
  fill?: boolean;
  sizes?: string;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Next 的预加载提示，此 shim 无需处理。 */
  priority?: boolean;
}

const FILL_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

export default function Image(props: ImageProps) {
  const { src, alt, fill = false, sizes, width, height, className, style } = props;

  return (
    <img
      src={src}
      alt={alt}
      sizes={sizes}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      className={className}
      style={fill ? { ...FILL_STYLE, ...style } : style}
      draggable={false}
    />
  );
}
