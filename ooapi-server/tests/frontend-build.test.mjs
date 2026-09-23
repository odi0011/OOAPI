// 前端构建模式：线上产物必须是 **production 版 React**
// ===========================================================================
// 故障现场（靠产物哈希比对才发现，功能上看不出来）：
//   线上 `index-*.js` 2.51MB，含 `react-dom.development` 与
//   「Consider adding an error boundary」等开发期串；而本地 production 构建是 1.89MB。
//   同一份源码、同一个构建命令 —— 差别只在环境变量。
//
// 根因（updater.js）：更新器把 `NODE_ENV=development` 同时传给了「装依赖」与「打包」两步。
//   · 装依赖需要它：systemd 设了 NODE_ENV=production，npm 会跳过 devDependencies，
//     而 vite 是 devDependency → 必须覆盖（或 --include=dev）；
//   · 打包不能要它：vite 用 NODE_ENV 决定打包哪个 React，development 会把
//     `react-dom.development` 整包打进去。
//   两个用途取值相反，原实现共用一份 frontEnv，于是线上长期跑开发版 React。
//
// 这是典型的「静默故障」：部署显示成功、功能一切正常，只是包大 600KB+、
// 首屏更慢、控制台刷开发警告。没人会主动注意到 —— 所以必须有断言守着。
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`); }
};
const SRC = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

/* ============ ① 更新器：两个 env 必须分开 ============ */
console.log("\n=== ① 更新器的 NODE_ENV 用法 ===");
{
  const up = SRC("services/updater.js");
  ck("装依赖用 NODE_ENV=development（否则 npm 跳过 devDeps，vite 装不上）",
    /const installEnv = \{ \.\.\.process\.env, NODE_ENV: "development" \};/.test(up));
  ck("打包用 NODE_ENV=production（否则打进 react-dom.development）",
    /const buildEnv = \{ \.\.\.process\.env, NODE_ENV: "production" \};/.test(up));
  ck("install 用 installEnv", /env: installEnv \}\)/.test(up));
  ck("build 用 buildEnv", /env: buildEnv \}\)/.test(up));
  // 不能再出现「一份 frontEnv 同时喂给两步」的旧写法
  ck("不再有共用的 frontEnv", !/const frontEnv = /.test(up));
  ck("build 显式带 --mode production（vite 官方推荐用 mode 控制构建）",
    /"build", "--", "--mode", "production"/.test(up));
  ck("说明里写明了两步取值相反的原因",
    /两个用途取值相反|取值不一样|取值\*\*不一样\*\*/.test(up.replace(/\s+/g, " ")) || /取值.{0,4}不一样/.test(up));
}

/* ============ ② 产物自检（静默故障必须被主动发现） ============ */
console.log("\n=== ② 构建后产物自检 ===");
{
  const up = SRC("services/updater.js");
  ck("构建后检查产物是否含 React 开发版标记",
    /react-dom\.development/.test(up) && /Consider adding an error boundary/.test(up));
  ck("命中时明确告警（而不是假装成功）", /疑似含 React 开发版/.test(up));
  ck("自检失败不影响部署（它只是多一道保险）", /前端产物自检跳过/.test(up));
}

/* ============ ③ 本地构建产物本身要是生产版 ============ */
console.log("\n=== ③ 当前 dist 产物 ===");
{
  // dist 可能未构建；未构建时明确跳过而不是假装通过
  let files = [];
  try {
    const { readdirSync, statSync } = await import("node:fs");
    const distAssets = new URL("../../ooapi-web/dist/assets/", import.meta.url);
    files = readdirSync(distAssets).filter((f) => f.endsWith(".js"));
    files = files.map((f) => ({ name: f, size: statSync(new URL(f, distAssets)).size }));
  } catch {
    files = [];
  }
  if (!files.length) {
    console.log("  · 跳过（ooapi-web/dist 未构建）");
  } else {
    const { readFileSync: rf } = await import("node:fs");
    for (const f of files) {
      const text = rf(new URL("../../ooapi-web/dist/assets/" + f.name, import.meta.url), "utf8");
      const dev = text.includes("react-dom.development") || text.includes("Consider adding an error boundary");
      ck(`${f.name} 是生产版 React`, !dev, dev ? "含开发版标记！" : `${(f.size / 1024 / 1024).toFixed(2)}MB`);
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
