/**
 * 币种图标：内联 SVG，不依赖外链图片。
 * 浅色底 + 品牌色圆形徽标 + 白色字母/符号，风格与系统徽章一致。
 */

interface CoinIconProps {
  icon: string;
  color: string;
  label: string;
  size?: number;
}

function Glyph({ icon }: { icon: string }) {
  switch (icon) {
    case "btc":
      return (
        <text x="12" y="16.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="inherit">
          ₿
        </text>
      );
    case "eth":
      return (
        <path
          d="M12 3.5 6.8 12.2l5.2 3.1 5.2-3.1L12 3.5Zm0 17.3-5.2-7.4 5.2 3.1 5.2-3.1-5.2 7.4Z"
          fill="#fff"
        />
      );
    case "doge":
      return (
        <text x="12" y="16.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="inherit">
          Ð
        </text>
      );
    case "xrp":
      return (
        <path
          d="M7 8.2c1.6-1.9 3.3-2.9 5-2.9s3.4 1 5 2.9l-1.6 1.5c-1.1-1.3-2.2-1.9-3.4-1.9s-2.3.6-3.4 1.9L7 8.2Zm0 7.6c1.6-1.9 3.3-2.9 5-2.9s3.4 1 5 2.9l-1.6 1.5c-1.1-1.3-2.2-1.9-3.4-1.9s-2.3.6-3.4 1.9L7 15.8Z"
          fill="#fff"
        />
      );
    case "sol":
      return (
        <path
          d="M7.5 9.2c.5-.6 1.2-.9 2-1h5c.8.1 1.5.4 2 1l-1.3 1.2H8.8L7.5 9.2Zm0 5.6c.5-.6 1.2-.9 2-1h5c.8.1 1.5.4 2 1l-1.3 1.2H8.8l-1.3-1.2Zm9-2.8c-.5.6-1.2.9-2 1h-5c-.8-.1-1.5-.4-2-1l1.3-1.2h6.4l1.3 1.2Z"
          fill="#fff"
        />
      );
    case "bnb":
      return (
        <path
          d="m12 5 2.6 2.6-2.6 2.6L9.4 7.6 12 5Zm-5.2 5.2L9.4 7.6l2.6 2.6-2.6 2.6-2.6-2.6Zm10.4 0-2.6-2.6 2.6-2.6 2.6 2.6-2.6 2.6ZM12 19l-2.6-2.6 2.6-2.6 2.6 2.6L12 19Z"
          fill="#fff"
        />
      );
    default:
      return (
        <text x="12" y="16.5" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="inherit">
          ¤
        </text>
      );
  }
}

export default function CoinIcon({ icon, color, label, size = 28 }: CoinIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
      style={{ flexShrink: 0, display: "block" }}
    >
      <circle cx="12" cy="12" r="11" fill={color} />
      <circle cx="12" cy="12" r="11" fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="1" />
      <Glyph icon={icon} />
    </svg>
  );
}
