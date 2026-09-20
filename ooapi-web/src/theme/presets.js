// ============================================================================
// 设计令牌 —— 严格对齐 beautifului.dev（从运行时计算样式提取）
// 单一事实来源：本文件的令牌与 styles.css 中的 CSS 变量必须保持同构
// 说明：JS 只注入「规范令牌」（--page/--surface/--ink/--accent …），
//      styles.css 中的 --oo-* 是它们的别名，旧页面因此自动继承新视觉。
// ============================================================================

// 强调色预设：默认取 beautifului 的 accent（oklch(62.6% .205 254.947) ≈ #4a72e8）
export const PRIMARY_PRESETS = [
  { key: "blue", label: "经典蓝", color: "#3b6ef5" },
  { key: "indigo", label: "靛青", color: "#5b5bd6" },
  { key: "violet", label: "紫罗兰", color: "#7c5cd6" },
  { key: "cyan", label: "明青", color: "#0d9bb5" },
  { key: "teal", label: "青碧", color: "#12a594" },
  { key: "green", label: "极光绿", color: "#30a46c" },
  { key: "amber", label: "琥珀", color: "#c47f17" },
  { key: "rose", label: "玫红", color: "#d6409f" },
];

export const DEFAULT_PRIMARY = "#3b6ef5";

// 语义色（与 beautifului 的 green/orange/red 对应，明暗各一套）
export const SEMANTIC = {
  light: { success: "oklch(60.3% 0.155 150.883)", warning: "oklch(68.9% 0.179 49.902)", danger: "oklch(62.1% 0.192 23.042)", info: "oklch(62.6% 0.205 254.947)" },
  dark: { success: "oklch(70.5% 0.154 153.814)", warning: "oklch(74.6% 0.156 55.642)", danger: "oklch(66.6% 0.18 21.433)", info: "oklch(68% 0.173 253.301)" },
};

// 表面令牌：与 styles.css 的 :root / [data-theme=dark] 严格同构
export const SURFACES = {
  light: {
    page: "oklch(98.5% 0.001 286.376)",
    canvas: "oklch(96.1% 0.002 247.84)",
    surface: "oklch(100% 0 0)",
    inset: "oklch(97.9% 0.002 247.839)",
    hover: "oklch(97% 0.002 247.839)",
    hover2: "oklch(93.3% 0.003 247.86)",
    field: "oklch(96.1% 0.001 286.375)",
    ink: "oklch(24.7% 0.006 258.361)",
    ink2: "oklch(50.6% 0.01 264.477)",
    ink3: "oklch(69.5% 0.009 264.505)",
    line: "oklch(94.6% 0.003 264.542)",
    lineStrong: "oklch(91.2% 0.005 258.326)",
    lineSoft: "oklch(96.6% 0.002 264.542)",
    accentTint: "oklch(96% 0.019 252.878)",
    tooltipBg: "oklch(27.2% 0.008 264.435)",
    tooltipFg: "oklch(97.6% 0.002 247.839)",
    shadowCard: "0 0 0 1px oklch(94.6% 0.003 264.542), 0 1px 2px oklch(0% 0 0 / 0.06)",
    shadowRaised: "0 0 0 1px oklch(94.6% 0.003 264.542), 0 2px 8px oklch(0% 0 0 / 0.08)",
    shadowOverlay: "0 0 0 1px oklch(94.6% 0.003 264.542), 0 8px 28px oklch(0% 0 0 / 0.12)",
  },
  dark: {
    page: "oklch(20.9% 0.004 264.477)",
    canvas: "oklch(23.1% 0.004 264.487)",
    surface: "oklch(26% 0.006 271.191)",
    inset: "oklch(24.3% 0.004 264.492)",
    hover: "oklch(28.9% 0.006 271.22)",
    hover2: "oklch(31.8% 0.007 274.747)",
    field: "oklch(29.3% 0.006 271.223)",
    ink: "oklch(96.4% 0.002 247.839)",
    ink2: "oklch(73.1% 0.008 260.731)",
    ink3: "oklch(54.1% 0.01 264.484)",
    line: "oklch(30.8% 0.006 258.354)",
    lineStrong: "oklch(35.6% 0.007 264.474)",
    lineSoft: "oklch(27.8% 0.006 258.354)",
    accentTint: "oklch(68% 0.173 253.301 / 0.16)",
    tooltipBg: "oklch(18.2% 0.004 264.459)",
    tooltipFg: "oklch(96.4% 0.002 247.839)",
    shadowCard: "0 0 0 1px oklch(100% 0 0 / 0.11), 0 1px 2px oklch(0% 0 0 / 0.2), 0 2px 6px oklch(0% 0 0 / 0.2)",
    shadowRaised: "0 0 0 1px oklch(100% 0 0 / 0.13), 0 2px 10px oklch(0% 0 0 / 0.22)",
    shadowOverlay: "0 0 0 1px oklch(100% 0 0 / 0.15), 0 8px 28px oklch(0% 0 0 / 0.34)",
  },
};

// 把主色换算成 OKLCH 近似值（保持与 beautifului 同色域观感）
export function hexToOklch(hex) {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full, 16);
  let r = ((num >> 16) & 255) / 255;
  let g = ((num >> 8) & 255) / 255;
  let b = (num & 255) / 255;
  // sRGB → 线性
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  r = lin(r); g = lin(g); b = lin(b);
  // 线性 sRGB → Oklab（Björn Ottosson 矩阵）
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L: L * 100, C, H };
}

export function primaryVars(hex, resolved) {
  const { L, C, H } = hexToOklch(hex);
  const isDark = resolved === "dark";
  // 暗色下略提亮，保证对比度
  const l = isDark ? Math.min(88, L + 8) : L;
  return {
    accent: `oklch(${l.toFixed(1)}% ${C.toFixed(3)} ${H.toFixed(1)})`,
    accentInk: `oklch(${(isDark ? Math.min(92, l + 8) : Math.max(28, l - 7)).toFixed(1)}% ${C.toFixed(3)} ${H.toFixed(1)})`,
    accentTint: isDark
      ? `oklch(${l.toFixed(1)}% ${C.toFixed(3)} ${H.toFixed(1)} / 0.16)`
      : `oklch(${Math.min(97.5, l + 34).toFixed(1)}% ${(C * 0.16).toFixed(3)} ${H.toFixed(1)})`,
  };
}

// 把令牌写入 CSS 变量（只写规范名，--oo-* 别名在 styles.css 中自动跟随）
export function applyCssVars(resolved, primary) {
  const s = SURFACES[resolved] || SURFACES.light;
  const r = document.documentElement;

  r.dataset.theme = resolved;
  r.style.colorScheme = resolved;

  const set = (k, v) => r.style.setProperty(k, v);

  set("--page", s.page);
  set("--canvas", s.canvas);
  set("--surface", s.surface);
  set("--inset", s.inset);
  set("--hover", s.hover);
  set("--hover-2", s.hover2);
  set("--field", s.field);
  set("--ink", s.ink);
  set("--ink-2", s.ink2);
  set("--ink-3", s.ink3);
  set("--line", s.line);
  set("--line-strong", s.lineStrong);
  set("--line-soft", s.lineSoft);
  set("--tooltip-bg", s.tooltipBg);
  set("--tooltip-fg", s.tooltipFg);
  set("--shadow-card", s.shadowCard);
  set("--shadow-raised", s.shadowRaised);
  set("--shadow-overlay", s.shadowOverlay);

  const pv = primaryVars(primary, resolved);
  set("--accent", pv.accent);
  set("--accent-ink", pv.accentInk);
  set("--accent-tint", pv.accentTint);
}

// 派生半透明色（用于 antd 的选中底色等）
export function tint(hex, alpha) {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

// ============================================================================
// 外观四件套：背景底纹 / 圆角 / 密度 / 正文字号
// ----------------------------------------------------------------------------
// 全部走「CSS 变量即时注入」（setProperty 直接改根样式），调控件就是所见即所得，
// **不需要「保存后刷新」** —— 这是只有变量体系才做得到的体验。
//
// 背景为什么只有 4 个受控预设、且透明度锁死在 0.03~0.06：
//   开放自定义图片/全色域会让文字对比度失控（用户选张深色照片配深色文字就废了）。
//   这里只给矢量几何底纹，颜色强制绑定 var(--line)，且内容层（卡片/表格/表单）
//   都是不透明 var(--surface) 实色，所以无论底纹怎么换，正文对比度都稳住。
// ============================================================================

export const BACKGROUNDS = [
  { key: "pure", label: "纯色平底", desc: "无底纹（默认）" },
  { key: "blueprint", label: "蓝图网格", desc: "24px 细网格" },
  { key: "dots", label: "终端点阵", desc: "点阵网格" },
  { key: "grain", label: "微噪点", desc: "细腻颗粒质感" },
];

export const RADIUS_PRESETS = [
  { key: "sharp", label: "直角", r: { window: "6px", card: "4px", btn: "4px", chip: "3px", xs: "2px" } },
  { key: "default", label: "默认", r: { window: "14px", card: "10px", btn: "8px", chip: "6px", xs: "4px" } },
  { key: "round", label: "圆润", r: { window: "20px", card: "14px", btn: "10px", chip: "8px", xs: "6px" } },
];

export const DENSITY_PRESETS = [
  {
    key: "compact",
    label: "紧凑",
    sp: { 1: "3px", 2: "6px", 3: "10px", 4: "13px", 5: "16px", 6: "20px", 8: "26px", 10: "34px" },
  },
  {
    key: "default",
    label: "标准",
    sp: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px", 6: "24px", 8: "32px", 10: "40px" },
  },
  {
    key: "loose",
    label: "宽松",
    sp: { 1: "6px", 2: "10px", 3: "15px", 4: "20px", 5: "25px", 6: "30px", 8: "40px", 10: "50px" },
  },
];

/**
 * 底纹平铺尺寸：按视口宽度放大。
 *
 * 为什么需要：24px 网格在 4K 屏上看着像一层密麻的纱（同一屏里格子数量翻了 4 倍），
 * 而在小笔记本上又刚好。这里按屏宽给三档，保持「肉眼上格子大小一致」的观感。
 * 只改尺寸不改透明度 —— 透明度锁死是为了保证文字对比度稳定。
 */
function tileScale() {
  if (typeof window === "undefined") return 1;
  const w = window.innerWidth || 1280;
  if (w >= 2560) return 1.6;
  if (w >= 1920) return 1.3;
  return 1;
}

/** 把 "24px 24px" 这类尺寸按屏宽放大（保留 px 单位，避免小数累积误差） */
function scaleSize(size, scale) {
  if (scale === 1) return size;
  return size
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? `${Math.round(n * scale)}px` : v;
    })
    .join(" ");
}

/** 背景底纹：以 background-image 挂在根节点，颜色绑定 --line（明暗主题自动跟随） */
function backgroundImage(key) {
  const scale = tileScale();
  switch (key) {
    case "blueprint":
      // 横竖各一组 1px 线，基准 24px 一格
      return {
        size: scaleSize("24px 24px", scale),
        image:
          "linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px)",
        opacity: "0.06",
      };
    case "dots":
      return {
        size: scaleSize("16px 16px", scale),
        image: "radial-gradient(var(--line) 1px, transparent 1px)",
        opacity: "0.06",
      };
    case "grain":
      // 噪点用重复渐变模拟（不引外部图片资源）：三层不同尺寸的斜向条纹叠加
      return {
        size: `${scaleSize("3px 3px", scale)}, ${scaleSize("5px 5px", scale)}, ${scaleSize("7px 7px", scale)}`,
        image:
          "repeating-linear-gradient(45deg, var(--line) 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, var(--line) 0 1px, transparent 1px 5px), repeating-linear-gradient(90deg, var(--line) 0 1px, transparent 1px 7px)",
        opacity: "0.03",
      };
    default:
      return null;
  }
}

/**
 * 应用外观设置（可只传改动的字段）。
 * @param {{background?:string, radius?:string, density?:string, fontSize?:number|string, accent?:string, resolved?:string}} opt
 */
/** 记住当前底纹，屏宽变化时原地重算（不必让调用方知道） */
let lastBackground = "pure";
if (typeof window !== "undefined") {
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    // 防抖 200ms：拖拽窗口会连续触发，每次重算 background-image 会掉帧
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastBackground && lastBackground !== "pure") applyAppearance({ background: lastBackground });
    }, 200);
  });
}

export function applyAppearance(opt = {}) {
  const r = document.documentElement;
  const set = (k, v) => r.style.setProperty(k, v);

  if (opt.background !== undefined) {
    lastBackground = String(opt.background);
    const bg = backgroundImage(String(opt.background));
    const layer = document.getElementById("app-bg");
    if (layer) {
      if (bg) {
        layer.style.backgroundImage = bg.image;
        layer.style.backgroundSize = bg.size;
        layer.style.opacity = bg.opacity;
      } else {
        layer.style.backgroundImage = "none";
        layer.style.opacity = "0";
      }
    }
    r.dataset.bg = String(opt.background);
  }

  if (opt.radius !== undefined) {
    const preset = RADIUS_PRESETS.find((p) => p.key === opt.radius) || RADIUS_PRESETS[1];
    set("--r-window", preset.r.window);
    set("--r-card", preset.r.card);
    set("--r-btn", preset.r.btn);
    set("--r-chip", preset.r.chip);
    set("--r-xs", preset.r.xs);
    // styles.css 里 --r-sm/--r-md 是旧别名（部分组件在用），必须一起更新，
    // 否则「直角」模式下仍有组件是圆角（视觉不统一）
    set("--r-sm", preset.r.chip);
    set("--r-md", preset.r.btn);
    r.dataset.radius = preset.key;
  }

  if (opt.density !== undefined) {
    const preset = DENSITY_PRESETS.find((p) => p.key === opt.density) || DENSITY_PRESETS[0];
    for (const [k, v] of Object.entries(preset.sp)) set(`--sp-${k}`, v);
    r.dataset.density = preset.key;
  }

  if (opt.fontSize !== undefined) {
    // 只改正文基准：标题走 em/rem 相对值，不必逐个调（逐个调必然漏几处）
    const px = Math.min(16, Math.max(12, Number(opt.fontSize) || 14));
    set("--fs-body", `${px}px`);
    set("--fs-desc", `${Math.max(11, px - 1.5)}px`);
    r.dataset.fontSize = String(px);
  }

  if (opt.accent) {
    // 站点默认主色。注意用户本地选择仍优先（见 ThemeContext 的 localStorage）
    const pv = primaryVars(String(opt.accent), opt.resolved || r.dataset.theme || "light");
    set("--accent", pv.accent);
    set("--accent-ink", pv.accentInk);
    set("--accent-tint", pv.accentTint);
  }
}
