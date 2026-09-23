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
import { TeamOutlined } from "@ant-design/icons";

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
  // Kiro（AWS）：独立厂商后需要自己的图标（原先是 anthropic 下的一员，
  // 借用 claude 图标；提出来之后必须有自己的标识）
  kiro: "kiro.png",
  // 2026-09 新增厂商。图标取自各站 favicon（Google favicon 服务，
  // 128px PNG）—— 直接抓官网 favicon 大多拿到 HTML/占位图（实测 7 个里只有 1 个可用）。
  // 每个都已在服务器上渲染成对照图人工核对过是真图标。
  typesafe: "typesafe.png",
  longcat: "longcat.png",
  chutes: "chutes.png",
  nvidia: "nvidia.png",
  cerebras: "cerebras.png",
  hunyuan: "hunyuan.png",
  // Meta：favicon 服务对该域名返回的不是 PNG，暂无可用官方图标，
  // 暂用平台 logo 兜底（会在界面上显示为统一 logo，非错误）。
  meta: PLATFORM_LOGO,
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
  // 2026-09 新增厂商的模型名前缀
  [/^jev/i, "typesafe.png"],
  [/^longcat/i, "longcat.png"],
  [/^nemotron/i, "nvidia.png"],
  [/^hy3|^hunyuan/i, "hunyuan.png"],
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
      </span>
    </Tooltip>
  );
}

/**
 * 精致倍率微徽章（重构全站倍率展示）：
 * 1. 解决「乘号 × 硕大怪异、数字失衡」问题：乘号微缩弱化、数字使用等宽精细字体 (var(--font-mono))
 * 2. 区分倍率状态：1.0 为基准低调灰，>1 为微强调高亮色，<1 为优惠折让绿色
 */
export function GroupRateBadge({ rate = 1, className, style }) {
  const num = Number(rate);
  const valid = !Number.isNaN(num) && num > 0 ? num : 1;
  const isBase = valid === 1;
  const isBoost = valid > 1;
  const isDiscount = valid < 1;

  const toneClass = isDiscount
    ? "oo-rate-badge--discount"
    : isBoost
    ? "oo-rate-badge--boost"
    : "oo-rate-badge--base";

  return (
    <span
      className={`oo-rate-badge ${toneClass} ${className || ""}`}
      style={style}
      title={`计费倍率：×${valid}`}
    >
      <span className="oo-rate-badge__x">×</span>
      <span className="oo-rate-badge__num">{valid}</span>
    </span>
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
export function ModelLabel({ model, size = 15, showVendor = false, className, style, title, channelType = "" }) {
  // 图标解析：先按模型名匹配厂商；**匹配不到时用「渠道」的图标**。
  // 用户要求：「如果渠道里有一些我们系统本身没有的模型，则模型图标就直接使用对应
  // 哪个渠道的就行」—— 那些模型（omen-alpha、mimo-v2.6-flash 之类）在模型表里
  // 没有对应厂商，退回平台 logo 等于把「未知」和「本平台」混在一起；
  // 用渠道图标既指明了来源，又不假装认识它。
  const file = (() => {
    const byModel = iconFileForModel(model);
    if (byModel !== PLATFORM_LOGO) return byModel;
    const byChannel = CHANNEL_ICON[String(channelType || "").toLowerCase()];
    return byChannel || byModel;
  })();
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

/**
 * 判断指定标识是否对应已知厂商
 */
export function hasKnownVendor(name) {
  const k = String(name || "").toLowerCase().trim();
  return Boolean(CHANNEL_ICON[k]);
}

/**
 * 统一分组标签（独立 Tag，包含专属或推导图标 + 名称 + 悬浮提示）
 * 解决全站分组图标关联错漏与 [+N] 折叠遮挡问题：
 * 1. 若 meta 带有 vendors 数组且非空，优先按 vendors 渲染（单厂商显示单图标，多厂商显示叠放图标，最多 3 个）
 * 2. 若 meta 带有 vendor 单厂商，直接渲染对应图标
 * 3. 若分组名直接命中已知厂商关键字（如 deepseek / openai / kimi 等），渲染对应厂商图标
 * 4. 其余自定义/跨厂商分组，使用统一优雅的 TeamOutlined 图标兜底，绝不丢失图标或留空
 * 5. 表格内只展示图标与分组名，干净清爽；倍率收敛至 Tooltip 悬浮提示，不污染表格单元格
 */
export function GroupTag({ name, meta, size = 13, className, style }) {
  const n = String(name || "").trim();
  if (!n || n === "default") {
    return (
      <span
        className={`bui-chip bui-chip--muted ${className || ""}`}
        style={{ fontSize: 12, height: 22, lineHeight: "22px", padding: "0 6px", ...style }}
      >
        公共
      </span>
    );
  }

  const vendors = Array.isArray(meta?.vendors) ? meta.vendors.filter(Boolean) : [];
  let icon = null;
  if (vendors.length === 1) {
    icon = <VendorIcon type={vendors[0]} size={size} />;
  } else if (vendors.length > 1) {
    icon = <GroupVendorIcons vendors={vendors} size={size} />;
  } else if (meta?.vendor) {
    icon = <VendorIcon type={meta.vendor} size={size} />;
  } else if (hasKnownVendor(n)) {
    icon = <VendorIcon type={n} size={size} />;
  } else {
    icon = <TeamOutlined style={{ fontSize: size, color: "var(--ink-2)", flexShrink: 0 }} />;
  }

  const rate = Number(meta?.rate);
  const tip = meta?.remark
    ? `${n} · ${meta.remark}${rate && rate !== 1 ? `（倍率 ×${rate}）` : ""}`
    : `分组：${n}${rate && rate !== 1 ? `（倍率 ×${rate}）` : ""}`;

  return (
    <Tooltip title={tip}>
      <span
        className={`bui-chip ${className || ""}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4.5,
          height: 22,
          lineHeight: "22px",
          padding: "0 7px",
          fontSize: 12,
          fontWeight: 500,
          whiteSpace: "nowrap",
          ...style,
        }}
      >
        {icon}
        <span className="oo-truncate" style={{ maxWidth: 120 }}>{n}</span>
      </span>
    </Tooltip>
  );
}


