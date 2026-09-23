// 路由挂载完整性 —— import 了 ≠ 挂载了
// ===========================================================================
// 真实事故（黑盒测试「新用户全旅程」发现，P0 级）：
//   `src/index.js` 顶部 `import dashboardRoutes from "./routes/dashboard.js"`，
//   第 48 行的 body-parser 白名单里也写了 `/api/dashboard`，
//   但**挂载表（app.use 那一串）里漏了这一行**。
//
//   后果：/api/dashboard/self、/api/dashboard/admin、/api/dashboard/community 全部 404。
//   而用户注册成功后的**第一个落地页就是 /console（数据看板）** ——
//   新用户看到的是一片红色「看板数据加载失败 / 请求失败（HTTP 404）」，
//   所有 KPI 卡片永远是 0 / 暂无数据。管理员看板同样全死。
//
//   这类缺陷的特点是「三处有两处做了」：import 有、白名单有、挂载没有。
//   人眼审代码时很容易被前两处骗过（看着像已经接好了），所以用测试锁住：
//   **凡是被 import 进 index.js 的 *Routes，都必须在 app.use 里出现**。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

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
  if (!c) throw new Error(m || "断言失败");
};

const index = read("src/index.js");

console.log("=== ① index.js 里 import 的每个 *Routes 都必须被 app.use 挂载 ===");
t("所有 import 的路由都挂载了", () => {
  // 抓 `import xxxRoutes from "./routes/yyy.js"` 形态
  const imported = [];
  for (const m of index.matchAll(/import\s+(\w*[Rr]outes)\s+from\s+"\.\/routes\/([\w.-]+)\.js"/g)) {
    imported.push({ name: m[1], file: m[2] });
  }
  ck(imported.length >= 10, `只解析到 ${imported.length} 个路由 import，正则可能失效了`);
  const unMounted = imported.filter((r) => !new RegExp(`app\\.use\\([^)]*\\b${r.name}\\b`).test(index));
  ck(
    !unMounted.length,
    `以下路由被 import 但**从未挂载**（其接口会 404）：\n      ` +
      unMounted.map((r) => `${r.name} (routes/${r.file}.js)`).join("\n      ")
  );
});

console.log("\n=== ② body-parser 白名单里的前缀必须都有对应挂载 ===");
t("白名单里的每个 /api/xxx 都能在 app.use 里找到", () => {
  // 白名单形如 ["/api/user", "/api/users", ...]
  const listMatch = index.match(/\[\s*"\/api\/user"[\s\S]*?\]/);
  ck(listMatch, "未找到 body-parser 白名单数组");
  const prefixes = [...listMatch[0].matchAll(/"(\/api\/[\w-]+)"/g)].map((m) => m[1]);
  ck(prefixes.length >= 10, `白名单只解析到 ${prefixes.length} 项`);
  const mounted = new Set([...index.matchAll(/app\.use\(\s*"(\/api\/[\w-]+)"/g)].map((m) => m[1]));
  const orphan = prefixes.filter((p) => !mounted.has(p));
  ck(
    !orphan.length,
    `白名单里有、但没有挂载（请求会 404，且 body 不会被解析）：${orphan.join(", ")}`
  );
});

console.log("\n=== ③ routes/ 目录下每个文件都应被 index.js 引用（防止新增路由忘了接） ===");
t("路由文件都在 index.js 里出现过", () => {
  const files = readdirSync(path.join(root, "src", "routes"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""));
  ck(files.length >= 10, `routes 目录只有 ${files.length} 个文件，路径可能不对`);
  const missing = files.filter((f) => !new RegExp(`routes/${f}\\.js`).test(index));
  ck(!missing.length, `routes/${missing.join(".js, routes/")}.js 从未在 index.js 里被引用`);
});

console.log("\n=== ④ 关键挂载点的回归锚点（这几条各自出过或差点出过事故） ===");
for (const [prefix, why] of [
  ["/api/dashboard", "数据看板（新用户第一个落地页）——曾漏挂载导致全站 404"],
  ["/api/community", "社区"],
  ["/api/chatroom", "私信"],
  ["/api/games", "小游戏"],
  ["/v1", "对外网关（OpenAI 协议）"],
]) {
  t(`挂载了 ${prefix}（${why}）`, () => {
    ck(new RegExp(`app\\.use\\(\\s*"${prefix.replace(/\//g, "\\/")}"`).test(index), `${prefix} 没有挂载`);
  });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
