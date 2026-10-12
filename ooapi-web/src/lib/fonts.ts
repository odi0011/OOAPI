/**
 * 站点字体注册表。
 *
 * 全部为公开可商用字体，托管在项目内（fontsource 包或 public/fonts），
 * 不依赖外部 CDN —— 国内访问 Google Fonts 不稳定。
 *
 * 新增字体时：
 *   1. 在 main.tsx 里 import 对应的 CSS（或把字体文件放进 public/fonts）
 *   2. 在 FONTS 里登记 id、显示名、CSS font-family 值
 *   3. 后端 services/appearance.go 的 fontValues 白名单同步添加 id
 *
 * 注意：字重上限统一到 500。这些中文字体本身笔画较粗，
 * 再用 600/700 会糊成一团，因此站内不提供更粗的字重。
 */

export interface FontOption {
  id: string;
  /** 显示名。 */
  label: string;
  /** 字体分类，用于设置页分组。 */
  group: "默认" | "黑体" | "宋体" | "艺术" | "像素" | "书写";
  /** CSS font-family 值，直接写到 --font-body / --font-display 上。 */
  stack: string;
  /** 该字体的用途说明。 */
  note: string;
}

/** 默认字体：站酷快乐体。 */
export const DEFAULT_FONT_ID = "zcool-kuaile";

export const FONTS: FontOption[] = [
  {
    id: "zcool-kuaile",
    label: "站酷快乐体",
    group: "默认",
    stack: '"ZCOOL KuaiLe", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
    note: "圆润活泼，辨识度高",
  },
  {
    id: "noto-sans-sc",
    label: "思源黑体",
    group: "黑体",
    stack: '"Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
    note: "标准无衬线，适合正文与密集数据",
  },
  {
    id: "noto-serif-sc",
    label: "思源宋体",
    group: "宋体",
    stack: '"Noto Serif SC", ui-serif, Georgia, serif',
    note: "衬线字形，适合长文阅读",
  },
  {
    id: "zcool-qingke-huangyou",
    label: "站酷庆科黄油体",
    group: "艺术",
    stack: '"ZCOOL QingKe HuangYou", "Noto Sans SC", sans-serif',
    note: "手写笔触，适合标题",
  },
  {
    id: "zcool-xiaowei",
    label: "站酷小薇体",
    group: "艺术",
    stack: '"ZCOOL XiaoWei", "Noto Serif SC", serif',
    note: "细瘦秀丽，古风气质",
  },
  {
    id: "ma-shan-zheng",
    label: "马善政毛笔楷书",
    group: "书写",
    stack: '"Ma Shan Zheng", "ZCOOL XiaoWei", serif',
    note: "毛笔楷书，适合品牌展示",
  },
  {
    id: "long-cang",
    label: "龙藏体",
    group: "书写",
    stack: '"Long Cang", "Ma Shan Zheng", cursive',
    note: "行书手写，笔意连绵",
  },
  {
    id: "zhi-mang-xing",
    label: "志忙行书",
    group: "书写",
    stack: '"Zhi Mang Xing", "Long Cang", cursive',
    note: "行书体，速度感强",
  },
  {
    id: "liu-jian-mao-cao",
    label: "柳建毛草",
    group: "书写",
    stack: '"Liu Jian Mao Cao", "Ma Shan Zheng", cursive',
    note: "草书体，装饰性强",
  },
  {
    id: "zpix",
    label: "ZPix 像素体",
    group: "像素",
    stack: '"Zpix", "Noto Sans SC", monospace',
    note: "12px 点阵像素，适合复古风",
  },
];

/** 按 id 取字体；未找到返回默认。 */
export function resolveFont(id: string): FontOption {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}

/** 字体的 CSS font-family 值；未找到返回默认堆栈。 */
export function fontStack(id: string): string {
  return resolveFont(id).stack;
}
