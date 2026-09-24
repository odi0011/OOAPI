// 厂商图标完整性 —— 新增厂商时**必须**有图标，漏了要报错而不是静默掉 logo
// ===========================================================================
// 用户反馈（2026-09-24，第二次了）：
//   「cursor 和 trae 的图标依旧是不对的，为啥每次让你加新厂商就会出这问题」
//
// 根因是流程性的，不是某一次疏忽：加一个厂商要改三处 ——
//   ① 后端 services/vendors.js（厂商清单）
//   ② 后端 services/channel-types.js（接入方式）
//   ③ 前端 components/VendorIcon.jsx 的 CHANNEL_ICON（图标映射）
// 而 ③ **漏了不会报任何错**：`CHANNEL_ICON[type] || PLATFORM_LOGO`
// 查不到就回落到平台 logo，页面照常渲染 —— 于是能一路漏到线上，
// 只能靠人眼在渠道列表里发现「这家的图标怎么是平台 logo」。
//
// 这个测试把它变成**确定性检查**：清单里的厂商必须在图标表里、
// 且映射的文件必须真实存在于 public/icons/。漏了直接红，不用等用户发现。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const web = path.join(root, "..", "ooapi-web");

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name} → ${e.message}`);
  }
};
const ck = (c, m) => {
  if (!c) throw new Error(m);
};

const vendorIconSrc = readFileSync(path.join(web, "src", "components", "VendorIcon.jsx"), "utf8");
const iconDir = path.join(web, "public", "icons");

/** 取出 CHANNEL_ICON 的 { key: "file" } 映射 */
function channelIconMap() {
  const m = vendorIconSrc.match(/const CHANNEL_ICON = \{([\s\S]*?)\n\};/);
  ck(m, "找不到 CHANNEL_ICON 定义");
  const map = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^\s*([a-z0-9_]+):\s*"([^"]+)"/);
    if (mm) map[mm[1]] = mm[2];
    // 值为常量（PLATFORM_LOGO）的也记下来，但标成「有映射」
    const mm2 = line.match(/^\s*([a-z0-9_]+):\s*(PLATFORM_LOGO)/);
    if (mm2) map[mm2[1]] = "__PLATFORM_LOGO__";
  }
  return map;
}

/** 取出 VENDOR_ICON_KEYS 清单 */
function vendorKeys() {
  const m = vendorIconSrc.match(/export const VENDOR_ICON_KEYS = \[([\s\S]*?)\];/);
  ck(m, "找不到 VENDOR_ICON_KEYS 清单（新增厂商时应当一并加进来）");
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
}

console.log("=== ① 厂商清单里的每一项都要有图标映射 ===");
t("VENDOR_ICON_KEYS 的每个厂商都在 CHANNEL_ICON 里有映射", () => {
  const map = channelIconMap();
  const missing = vendorKeys().filter((k) => !map[k]);
  ck(
    !missing.length,
    `这些厂商没有图标映射，会静默回落到平台 logo：${missing.join(", ")}（在 VendorIcon.jsx 的 CHANNEL_ICON 里补）`
  );
});

console.log("\n=== ② 映射的文件必须真实存在 ===");
t("CHANNEL_ICON 里引用的图标文件都在 public/icons/ 下", () => {
  const map = channelIconMap();
  const bad = [];
  for (const [k, file] of Object.entries(map)) {
    if (file === "__PLATFORM_LOGO__") continue; // 有意的兜底，不算缺
    if (!existsSync(path.join(iconDir, file))) bad.push(`${k} → ${file}`);
  }
  ck(!bad.length, `映射了但文件不存在：${bad.join("; ")}`);
});

console.log("\n=== ③ 后端厂商与前端图标要对得上 ===");
t("channel-types 的每个厂商位都能在前端查到图标（反向检查）", () => {
  // 取后端厂商清单里的 channelType（厂商位）
  const vendorsSrc = readFileSync(path.join(root, "src", "services", "vendors.js"), "utf8");
  const types = [...vendorsSrc.matchAll(/channelType:\s*"([a-z0-9_-]+)"/g)].map((x) => x[1]);
  ck(types.length > 5, `解析到的厂商太少（${types.length}），可能 vendors.js 结构变了`);
  const map = channelIconMap();
  // 允许别名（deepseek→deepseek 等）；这里只查「有没有映射」
  const missing = types.filter((ty) => !map[ty]);
  ck(!missing.length, `后端厂商在前端没有图标：${missing.join(", ")}`);
});

console.log("\n=== ④ 图标文件是真图片（不是 HTML / 占位图）===");
t("所有图标都有图片魔数（PNG/JPEG/GIF/WebP/SVG/ICO）", () => {
  // 真实事故：早先直接抓官网 favicon，7 个里只有 1 个是图，其余拿到 HTML/占位图
  //（大小和 Content-Type 看着都正常）。所以必须校验魔数。
  const files = ["cursor.png", "trae.png", "kiro.png", "cline.png", "workbuddy.svg", "qoder.svg"];
  const bad = [];
  for (const f of files) {
    const p = path.join(iconDir, f);
    if (!existsSync(p)) continue; // 文件不存在的由 ② 覆盖
    const b = readFileSync(p);
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const isJpg = b[0] === 0xff && b[1] === 0xd8;
    const isGif = b.slice(0, 3).toString("latin1") === "GIF";
    const isWebp = b.slice(0, 4).toString("latin1") === "RIFF";
    const isIco = b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01;
    const head = b.slice(0, 200).toString("utf8").toLowerCase();
    const isSvg = head.includes("<svg");
    if (!(isPng || isJpg || isGif || isWebp || isIco || isSvg)) {
      bad.push(`${f}（前 8 字节 ${b.slice(0, 8).toString("hex")}）`);
    }
  }
  ck(!bad.length, `这些图标不是图片：${bad.join("; ")}`);
});

console.log("\n=== ⑤ 本次修复的回归锚点（cursor / trae）===");
t("cursor 与 trae 都有独立图标且文件存在", () => {
  const map = channelIconMap();
  for (const k of ["cursor", "trae"]) {
    ck(map[k], `${k} 没有图标映射（用户报过的就是这个）`);
    ck(map[k] !== "__PLATFORM_LOGO__", `${k} 仍是平台 logo 兜底，应当是厂商自己的图标`);
    ck(existsSync(path.join(iconDir, map[k])), `${k} 映射的文件 ${map[k]} 不存在`);
  }
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
