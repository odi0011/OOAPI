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
  // Cline（官方 GitHub 仓库的 assets/icons/icon.png —— 官网 favicon 取不到）
  cline: "cline.png",
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
  // 混元：WorkBuddy 渠道里是 `hy-4-preview`（Hy4 预览版），只写 `^hy3` 会漏掉 ——
  // 实测反馈「workbuddy 里面的 hy-4-preview 不是混元的模型吗？为啥给我弄成厂商的图标了」。
  // `^hy[-\d]` 同时覆盖 hy3 / hy-4 / hy4 各种写法；以 `hy` 开头接分隔符或数字的
  // 模型名目前只有混元一家，不会误伤。
  [/^hunyuan|^hy[-\d]/i, "hunyuan.png"],
  // OpenRouter 聚合目录里的「路由型」模型（openrouter/auto、openrouter/free …）：
  // 名字本身就是这家聚合站的产品名，用它的官方图标；不带前缀时（`free`、`auto`）
  // 无法安全判定（可能与别的模型重名），交给渠道图标兜底，不在这里猜。
  [/^openrouter\//i, "openrouter.svg"],
  // 本平台自有/测试模型（omen-alpha 是 OpenCode Zen 上的自有档）：
  // 名字里没有厂商线索，这里**不猜**——由调用方传 channelType 用渠道图标兜底。
];

// 厂商前缀 → 图标文件（`vendor/model` 形式的目录型渠道用）。
//
// 为什么单独一张表：Cline 之类的聚合渠道返回的是 `anthropic/claude-sonnet-4.5`、
// `x-ai/grok-4.3`、`~openai/gpt-luna-latest` —— 前缀是**厂商**，但和我们的渠道 key
// 拼写往往不同（x-ai vs grok、z-ai vs glm、moonshotai vs kimi、meta-llama vs meta）。
// 用户实测反馈：「Cline 里很多模型并没有走系统已有模型的厂商图标，应该是他们的 id
// 不相同，这个有什么办法自动归属吗」。
//
// 两级解析（顺序不能颠倒）：
//   ① 先按**模型名**判定（同名模型无论挂在哪个渠道都是同一家的）——
//      `anthropic/claude-sonnet-4.5` 剥掉前缀后就是 `claude-sonnet-4.5`，
//      MODEL_ICON 直接命中 claude 图标；
//   ② 模型名认不出来时，再按**厂商前缀**判定（`x-ai/某新模型` → grok 图标）——
//      新模型（`grok-build-0.1`）不在 MODEL_ICON 里，但前缀已经说明了归属。
// 两者都没命中才落到「渠道图标」兜底（上一层的 ModelLabel 负责）。
const VENDOR_PREFIX_ICON = {
  anthropic: "claude.svg",
  openai: "openai.svg",
  google: "gemini.svg",
  "x-ai": "grok.svg",
  xai: "grok.svg",
  deepseek: "deepseek.png",
  qwen: "qwen.png",
  alibaba: "alibaba.svg",
  "z-ai": "zhipu.svg",
  zhipu: "zhipu.svg",
  moonshotai: "kimi.png",
  moonshot: "kimi.png",
  minimax: "minimax.png",
  mistralai: "mistralai.png",
  mistral: "mistralai.png",
  "meta-llama": "meta.svg",
  meta: "meta.svg",
  nvidia: "nvidia.png",
  cohere: "cohere.png",
  amazon: "amazon.png",
  perplexity: "perplexity.png",
  tencent: "hunyuan.png",
  bytedance: "bytedance.svg",
  "bytedance-seed": "bytedance.svg",
  xiaomi: "mimo.png",
  inclusionai: "inclusionai.png",
  stepfun: "stepfun.png",
  baidu: "baidu.png",
  meituan: "longcat.png",
  openrouter: "openrouter.svg",
  // 平台自己的模型（omen-alpha 等）
  ooapi: PLATFORM_LOGO,
};

/**
 * 把 `vendor/model` 形式的 id 归一化成裸模型名。
 * 与后端 cline-prices.js 的 normalizeClineModel 保持**同一套规则** —— 前端判图标、
 * 后端判价格，两处若不一致会出现「图标是 Anthropic、价格按别的厂商算」的错配。
 * （`-latest` / `-preview` 也要去掉：`~openai/gpt-luna-latest` 归一化后是 `gpt-luna`，
 * 两边都得到同一个字符串才谈得上一致。）
 */
export function bareModelId(model) {
  let s = String(model || "").trim();
  if (s.startsWith("~")) s = s.slice(1); // ~openai/gpt-luna-latest = 别名路由
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/:(free|batch|extended|thinking)$/i, "");
  return s.replace(/-(latest|preview)$/i, "");
}

export function iconFileForChannel(type) {
  return CHANNEL_ICON[String(type || "").toLowerCase()] || PLATFORM_LOGO;
}

export function iconFileForModel(model) {
  const raw = String(model || "");
  // ① 裸模型名（剥掉 `vendor/` 前缀与 `:free`/`:batch` 后缀后按 MODEL_ICON 判定）
  const bare = bareModelId(raw);
  for (const [re, file] of MODEL_ICON) {
    if (re.test(bare)) return file;
  }
  // ② 模型名认不出来时按厂商前缀判定（`x-ai/新模型` → grok）
  const noTilde = raw.startsWith("~") ? raw.slice(1) : raw;
  const slash = noTilde.indexOf("/");
  if (slash > 0) {
    const prefix = noTilde.slice(0, slash).toLowerCase();
    if (VENDOR_PREFIX_ICON[prefix]) return VENDOR_PREFIX_ICON[prefix];
  }
  // ③ 原始名（没有前缀时，再拿完整串试一次 MODEL_ICON，兼容 `gpt-5.6-sol:batch` 这类）
  for (const [re, file] of MODEL_ICON) {
    if (re.test(raw)) return file;
  }
  return PLATFORM_LOGO;
}

export function vendorNameForModel(model) {
  const m = bareModelId(model) || String(model || "");
  if (/^deepseek/i.test(m)) return "DeepSeek";
  if (/^(gpt|o1|o3|o4|chatgpt|codex)/i.test(m)) return "OpenAI";
  if (/^claude/i.test(m)) return "Claude";
  if (/^gemini/i.test(m)) return "Gemini";
  if (/^qwen|^tongyi/i.test(m)) return "通义千问";
  if (/^glm|^zhipu/i.test(m)) return "智谱";
  if (/^kimi|^moonshot/i.test(m)) return "Kimi";
  if (/^doubao/i.test(m)) return "豆包";
  if (/^grok/i.test(m)) return "Grok";
  if (/^hunyuan|^hy[-\d]/i.test(m)) return "混元";
  if (/^mimo/i.test(m)) return "小米 MiMo";
  if (/^minimax/i.test(m)) return "MiniMax";
  if (/^mistral|^magistral|^codestral|^devstral|^ministral|^mixtral/i.test(m)) return "Mistral";
  if (/^llama|^muse/i.test(m)) return "Meta";
  if (/^nemotron/i.test(m)) return "NVIDIA";
  if (/^command|^north/i.test(m)) return "Cohere";
  if (/^nova/i.test(m)) return "Amazon";
  if (/^sonar/i.test(m)) return "Perplexity";
  if (/^seed/i.test(m)) return "字节 Seed";
  // 认不出来时用厂商前缀兜底（`x-ai/某新模型` → xAI，而不是「其他」）
  const raw = String(model || "");
  const noTilde = raw.startsWith("~") ? raw.slice(1) : raw;
  const slash = noTilde.indexOf("/");
  if (slash > 0) {
    const prefix = noTilde.slice(0, slash).toLowerCase();
    if (VENDOR_PREFIX_ICON[prefix] && VENDOR_PREFIX_ICON[prefix] !== PLATFORM_LOGO) {
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
  }
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
    // 「公共池」已废弃（用户要求彻底清掉）：未分组不再是合法的绑定状态，
    // 只有**历史数据**还可能为空。这里显示为「未分组」而不是「公共」——
    // 前者是「这条记录缺一个归属、需要补」，后者听起来像一个正常的池子。
    return (
      <Tooltip title="该记录没有绑定分组（历史数据）。密钥必须归属某个分组，请在编辑里补上。">
        <span
          className={`bui-chip bui-chip--muted ${className || ""}`}
          style={{ fontSize: 12, height: 22, lineHeight: "22px", padding: "0 6px", ...style }}
        >
          未分组
        </span>
      </Tooltip>
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


