/**
 * 币种图标：高精度内联矢量 SVG 徽标（带高光环与品牌渐变质感），不依赖外链图片。
 * 支持 BTC / ETH / SOL / XRP / DOGE / BNB / SUI / AVAX 及任意自定义合约标的。
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
        <text
          x="12"
          y="16.5"
          textAnchor="middle"
          fontSize="12"
          fontWeight="800"
          fill="#fff"
          fontFamily="var(--font-display, inherit)"
        >
          ₿
        </text>
      );
    case "eth":
      return (
        <path
          d="M12 3.6 7.1 12.1 12 15l4.9-2.9L12 3.6Zm0 16.8-4.9-6.9L12 16.4l4.9-2.9-4.9 6.9Z"
          fill="#fff"
        />
      );
    case "doge":
      return (
        <text
          x="12"
          y="16.5"
          textAnchor="middle"
          fontSize="12"
          fontWeight="800"
          fill="#fff"
          fontFamily="var(--font-display, inherit)"
        >
          Ð
        </text>
      );
    case "xrp":
      return (
        <path
          d="M6.8 7.8c1.5-1.8 3.2-2.7 5.2-2.7s3.7.9 5.2 2.7l-1.5 1.4c-1.1-1.2-2.3-1.8-3.7-1.8s-2.6.6-3.7 1.8L6.8 7.8Zm0 8.4c1.5 1.8 3.2 2.7 5.2 2.7s3.7-.9 5.2-2.7l-1.5-1.4c-1.1 1.2-2.3 1.8-3.7 1.8s-2.6-.6-3.7-1.8l-1.5 1.4Z"
          fill="#fff"
        />
      );
    case "sol":
      return (
        <path
          d="M7.3 8.6c.4-.5 1.1-.8 1.8-.8h5.8c.5 0 .8.6.4 1l-1.1 1.1c-.4.4-1 .7-1.7.7H6.8c-.5 0-.8-.6-.4-1l.9-1Zm0 6.8c.4-.5 1.1-.8 1.8-.8h5.8c.5 0 .8.6.4 1l-1.1 1.1c-.4.4-1 .7-1.7.7H6.8c-.5 0-.8-.6-.4-1l.9-1Zm9.4-3.4c-.4.5-1.1.8-1.8.8H9.1c-.5 0-.8-.6-.4-1l1.1-1.1c.4-.4 1-.7 1.7-.7h5.7c.5 0 .8.6.4 1l-.9 1Z"
          fill="#fff"
        />
      );
    case "bnb":
      return (
        <path
          d="m12 4.8 2.7 2.7-1.5 1.5-1.2-1.2-1.2 1.2-1.5-1.5L12 4.8Zm-4.5 4.5 1.5 1.5-1.2 1.2 1.2 1.2-1.5 1.5-2.7-2.7 2.7-2.7Zm9 0 2.7 2.7-2.7 2.7-1.5-1.5 1.2-1.2-1.2-1.2 1.5-1.5ZM12 10.2l1.8 1.8-1.8 1.8-1.8-1.8 1.8-1.8Zm0 4.2 1.2 1.2 1.5-1.5 1.5 1.5L12 19.2l-4.2-3.6 1.5-1.5 1.5 1.5 1.2-1.2Z"
          fill="#fff"
        />
      );
    case "sui":
      return (
        <path
          d="M12 4.5c2.9 3.1 5 5.8 5 8.6a5 5 0 1 1-10 0c0-2.8 2.1-5.5 5-8.6Zm0 3.3c-1.6 2-2.8 3.8-2.8 5.3a2.8 2.8 0 1 0 5.6 0c0-1.5-1.2-3.3-2.8-5.3Z"
          fill="#fff"
        />
      );
    case "avax":
      return (
        <path
          d="M12.7 5.6c-.3-.6-1.1-.6-1.4 0L5.8 16.2c-.3.5.1 1.1.7 1.1h3.2c.5 0 .9-.3 1.1-.7l3.4-6.6c.2-.5.2-1 0-1.5l-1.5-2.9Zm3.1 6.2c-.3-.5-.9-.5-1.2 0l-1.9 3.6c-.3.5.1 1.1.6 1.1h3.8c.5 0 .9-.6.6-1.1l-1.9-3.6Z"
          fill="#fff"
        />
      );
    default:
      return (
        <text
          x="12"
          y="16.2"
          textAnchor="middle"
          fontSize="10.5"
          fontWeight="800"
          fill="#fff"
          fontFamily="var(--font-display, inherit)"
        >
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
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
      <Glyph icon={icon} />
    </svg>
  );
}
