// 厂商图标 —— 使用各厂商官方 SVG / 品牌资源
// ---------------------------------------------------------------------------
// 资源来源（均为官方或权威收录，非手绘）：
//   deepseek.svg   DeepSeek 官网内联 logo（currentColor，自动适配明暗）
//   openai.svg     OpenAI 官方标志（Simple Icons 收录）
//   claude.svg     Anthropic / Claude 官方标志（Simple Icons 收录）
//   gemini.svg     Google Gemini 官方标志（Simple Icons 收录）
//   zhipu.svg      智谱 z.ai 官网 logo（官方 Illustrator 导出）
//   qwen.svg       阿里通义千问官方图标（阿里 CDN）
//   kimi.ico       Moonshot AI 官网 favicon
//   doubao.png     豆包官网 apple-touch-icon
//   alibaba.svg    阿里云（Simple Icons 收录）
//   bytedance.svg  字节跳动（Simple Icons 收录）
//
// 用法：
//   <VendorIcon type="deepseek" />           渠道类型图标
//   <ModelLabel model="deepseek-flash" />    模型名（自动带对应厂商图标）
import React from "react";
import { Tooltip } from "antd";

const ICON_DIR = "/icons";

// 平台自身 logo（自定义渠道使用）
const PLATFORM_LOGO = "/logo.jpg";

// 文件名 → 完整地址。平台 logo 在站点根目录，厂商图标在 /icons 下，
// 拼路径前必须判断，否则会出现 /icons//logo.jpg 这种坏地址。
function iconSrc(file) {
  return file.startsWith("/") ? file : `${ICON_DIR}/${file}`;
}

// 厂商 → 图标文件
// 键同时覆盖「渠道类型 key」与「厂商标识」，两者不一致时（如 glm/zhipu）
// 都要能用，避免调用方拿 type 直接渲染时掉到默认图标。
const CHANNEL_ICON = {
  // 登录型厂商（官方品牌资源）
  deepseek: "deepseek.png",   // 官方鲸鱼
  kimi: "kimi.png",
  doubao: "doubao.png",
  moonshot: "kimi.png",
  glm: "zhipu.svg",           // 渠道类型 key
  zhipu: "zhipu.svg",         // 厂商标识
  // API 型厂商
  openai: "openai.svg",
  claude: "claude.svg",
  anthropic: "claude.svg",    // 渠道类型 key
  gemini: "gemini.svg",       // 官方彩色 sparkle
  qwen: "qwen.png",
  alibaba: "alibaba.svg",
  bytedance: "bytedance.svg",
  // xAI Grok（官方 X 标识，Simple Icons 收录）
  grok: "grok.svg",
  "grok-oauth": "grok.svg",
  xai: "grok.svg",
  // 第三方反代厂商（官网官方 logo）
  workbuddy: "workbuddy.svg",
  codebuddy: "workbuddy.svg",
  qoder: "qoder.svg",
  // 三方兼容聚合
  opencode: "opencode.png",
  openrouter: "openrouter.svg",
  siliconflow: "siliconflow.ico",
  // 国产厂商直连（2026-09 接入）。图标取自各厂商 **GitHub 官方组织头像**
  // （MiniMax-AI / stepfun-ai / volcengine / XiaomiMiMo）——
  // 这些厂商的官网 favicon 取不到（域名不可达或返回 403），
  // 官方组织头像是同源的官方资源。
  minimax: "minimax.png",
  stepfun: "stepfun.png",
  ark: "ark.png",
  volcengine: "ark.png",
  mimo: "mimo.png",
  xiaomi: "mimo.png",
  // 自定义渠道 → 使用平台 logo
  custom: PLATFORM_LOGO,
};

// 模型名前缀 → 厂商图标（用于任何展示模型名的位置）
// 注意：反代/工具渠道产出的模型与官方 API 是同一批模型（Kiro 的 Claude、ChatGPT 网页版的 GPT），
// 因此这里只按**模型名**判定厂商，不按渠道 —— 工具只是通道，模型归属不变。
const MODEL_ICON = [
  [/^deepseek/i, "deepseek.png"],
  // codex-auto-review 也是 OpenAI 的模型（历史漏配会掉到平台 logo）
  [/^(gpt|o1|o3|o4|chatgpt|text-|dall|openai|codex)/i, "openai.svg"],
  [/^claude/i, "claude.svg"],
  [/^gemini/i, "gemini.svg"],
  [/^qwen|^tongyi/i, "qwen.png"],
  [/^glm|^zhipu|^chatglm/i, "zhipu.svg"],
  [/^kimi|^moonshot/i, "kimi.png"],
  [/^doubao|^ep-/i, "doubao.png"],
  [/^grok/i, "grok.svg"],
  // 2026-09 接入的四家（不加这几条会掉到平台 logo，看着像没配图）
  [/^minimax/i, "minimax.png"],
  [/^step-|^stepfun/i, "stepfun.png"],
  [/^mimo/i, "mimo.png"],
];

export function iconFileForChannel(type) {
  return CHANNEL_ICON[String(type || "").toLowerCase()] || PLATFORM_LOGO;
}

export function iconFileForModel(model) {
  const m = String(model || "");
  for (const [re, file] of MODEL_ICON) {
    if (re.test(m)) return file;
  }
  return PLATFORM_LOGO;
}

export function vendorNameForModel(model) {
  const m = String(model || "");
  if (/^deepseek/i.test(m)) return "DeepSeek";
  if (/^(gpt|o1|o3|o4|chatgpt|codex)/i.test(m)) return "OpenAI";
  if (/^claude/i.test(m)) return "Claude";
  if (/^gemini/i.test(m)) return "Gemini";
  if (/^qwen|^tongyi/i.test(m)) return "通义千问";
  if (/^glm|^zhipu/i.test(m)) return "智谱";
  if (/^kimi|^moonshot/i.test(m)) return "Kimi";
  if (/^doubao/i.test(m)) return "豆包";
  if (/^grok/i.test(m)) return "Grok";
  return "其他";
}

/**
 * 厂商图标
 * @param {object} props { type, size, radius, title }
 */
export function VendorIcon({ type, size = 16, radius, title, className, style }) {
  const file = iconFileForChannel(type);
  return (
    <img
      src={iconSrc(file)}
      alt={title || type || ""}
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      className={className}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        borderRadius: radius !== undefined ? radius : Math.max(3, Math.round(size * 0.22)),
        flexShrink: 0,
        display: "block",
        ...style,
      }}
    />
  );
}

/**
 * 分组厂商图标（折叠态）—— 分组表格/下拉统一使用：
 *   · 单厂商账号 → 直接显示该厂商图标
 *   · 多厂商账号 → 折叠成叠放的图标堆（+N 表示还有几个）
 *   · 无成员厂商 → 不显示（由调用方决定占位文案）
 */
export function GroupVendorIcons({ vendors = [], size = 14, max = 3, className, style }) {
  const list = [...new Set((vendors || []).map((v) => String(v || "").trim()).filter(Boolean))];
  if (!list.length) return null;
  if (list.length === 1) {
    return <VendorIcon type={list[0]} size={size} title={list[0]} className={className} style={style} />;
  }
  const shown = list.slice(0, max);
  return (
    <Tooltip title={`成员厂商：${list.join("、")}`}>
      <span
        className={className}
        style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, ...style }}
      >
        {shown.map((t, i) => (
          <VendorIcon
            key={t}
            type={t}
            size={size}
            style={{
              marginInlineStart: i ? -Math.max(3, Math.round(size * 0.38)) : 0,
              zIndex: shown.length - i,
              // 白色描边把叠放图标分开，暗色主题下也清晰
              boxShadow: "0 0 0 1.5px var(--surface)",
              background: "var(--surface)",
              borderRadius: "50%",
            }}
          />
        ))}
        {list.length > max ? (
          <span className="bui-chip" style={{ marginInlineStart: 3, fontSize: 10, height: 15, lineHeight: "15px", padding: "0 4px" }}>
            +{list.length - max}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}

/**
 * 渠道类型（图标 + 名称）
 */
export function VendorLabel({ type, label, size = 15, gap = 7, className, style }) {
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap, minWidth: 0, ...style }}
    >
      <VendorIcon type={type} size={size} />
      {label ? <span className="oo-truncate">{label}</span> : null}
    </span>
  );
}

/**
 * 模型名（带厂商图标）—— 全站统一使用
 * @param {object} props { model, size, showVendor, monoClassName, style }
 */
export function ModelLabel({ model, size = 15, showVendor = false, className, style, title }) {
  const file = iconFileForModel(model);
  return (
    <span
      className={className}
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, ...style }}
    >
      <img
        src={iconSrc(file)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        draggable={false}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          borderRadius: Math.max(3, Math.round(size * 0.22)),
          flexShrink: 0,
          display: "block",
        }}
      />
      <span className="oo-truncate" style={{ fontFamily: "var(--font-mono)", fontSize: "0.95em" }}>
        {model}
      </span>
      {showVendor ? <span style={{ fontSize: "0.85em", color: "var(--ink-3)" }}>{vendorNameForModel(model)}</span> : null}
    </span>
  );
}
