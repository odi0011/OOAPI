// 前端「用到了但没导入/没定义」的标识符扫描
// ===========================================================================
// 为什么需要它（真实事故）：AdminChannelsPage.jsx 的渠道「用量统计」弹窗里写了
// `SERIES_COLORS[i % SERIES_COLORS.length]`，但那个文件**从来没有导入过**
// SERIES_COLORS —— 打开该弹窗会抛 `ReferenceError: SERIES_COLORS is not defined`，
// 整块图表打空。
//
// 为什么之前没被发现：
//   · `vite build` 只做语法与模块解析，**不解析自由变量**（没有类型检查）；
//   · 该代码只在「点开用量统计弹窗」这条路径上执行 —— 构建、首页、渠道列表全都正常，
//     页面级 smoke test 也过（上一次真实事故 `load is not defined` 是同一类问题）。
// 所以补一个静态扫描：把每个文件「用到的全大写标识符」与「导入/定义过的」对一遍。
//
// 范围刻意只做 UPPER_SNAKE（常量约定）：它噪音低（普通变量名是 camelCase，
// React 组件名是 PascalCase，误报少），而踩过的两个坑（SERIES_COLORS、load）
// 里 SERIES_COLORS 正好属于这一类。小写自由变量扫不了（无法与属性名/局部变量区分），
// 那部分靠 e2e 真点开弹窗覆盖。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.join(here, "..", "..", "ooapi-web", "src");

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

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx|js)$/.test(f)) out.push(p);
  }
  return out;
}

/** 去掉注释与字符串/模板字面量：只在「代码」里找标识符，避免文案里的全大写词误报 */
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ") // 行注释（避开 http://）
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``") // 模板字面量
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""') // 双引号串
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''"); // 单引号串
}

/** 该文件里「有定义」的标识符：声明、导入、re-export */
function definedNames(src) {
  const names = new Set();
  // const/let/var/function/class FOO
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // import { A, B as C } from "..."
  for (const m of src.matchAll(/import\s+(?:[A-Za-z_$][\w$]*\s*,?\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  // import X from "..."（默认导入）
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from/g)) names.add(m[1]);
  // export { A, B } from "..."（re-export，本文件里也算「有」）
  for (const m of src.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*"[^"]*")?/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  return names;
}

/**
 * 只查 **SCREAMING_SNAKE（名字里带下划线）** 的常量。
 *
 * 为什么加这个限制：单字缩写（PNG / POST / CPA / UTC / SSE …）在 JSX 文本与属性里
 * 大量出现，而「文本 vs 表达式」在纯正则层面分不干净（实测：注释与字符串剥离在大文件里
 * 会被少数游离的引号/反引号带偏，导致整段文本残留）。带下划线的常量名误报率极低，
 * 而踩过的真实事故（SERIES_COLORS、MAX_INLINE_BARS 那一类）正好都是这种形态。
 *
 * 已知覆盖不到的：小写自由变量（历史上出过 `load is not defined`）——
 * 那类只能靠 e2e 真点开对应弹窗覆盖，不在本扫描的职责内。
 */
const REQUIRE_UNDERSCORE = true;

/** 语言/平台/业务通用的大写词，不算「未定义」 */
const ALLOW = new Set([
  "JSON", "URL", "API", "NaN", "Infinity", "CSS", "HTML", "HTTP", "HTTPS", "ID", "UID", "UUID",
  "URLSearchParams", "AbortController", "Set", "Map", "Date", "Math", "Object", "Array",
  "String", "Number", "Boolean", "Promise", "Error", "RegExp", "Symbol", "WeakMap", "TextEncoder",
  "Uint8Array", "ArrayBuffer", "Blob", "FileReader", "Image", "XMLHttpRequest", "EventSource",
  // 业务缩写（在注释/文案里也常见，但不该被当成未定义标识符）
  "TTFT", "OIDC", "OOAPI", "TOTP", "OD", "JWT", "SQL", "CORS", "SSRF", "WAF", "CDN", "DOM",
  // SQL 关键字片段（多行模板里拼出来的，被模板字面量剥掉后偶尔残留）
  "SELECT", "INSERT", "UPDATE", "DELETE", "WHERE", "FROM", "JOIN", "LEFT", "RIGHT", "INNER",
  "GROUP", "ORDER", "LIMIT", "OFFSET", "VALUES", "INTO", "UNION", "COUNT", "SUM", "AVG", "MAX",
  "MIN", "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "AS", "ON", "BY", "HAVING", "DESC",
  "ASC", "PRIMARY", "KEY", "INDEX", "UNIQUE", "DEFAULT", "COLLATE", "CHARSET", "ENGINE", "COMMENT",
  "NULL", "VARCHAR", "TEXT", "INT", "BIGINT", "TINYINT", "DECIMAL", "TIMESTAMP",
]);

/** 扫一个目录，返回「可疑的未定义大写标识符」清单 */
function scanUndefined(dir) {
  const problems = [];
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    const defined = definedNames(src);
    const code = stripNonCode(src);
    const rel = path.relative(path.join(dir, ".."), file).replace(/\\/g, "/");
    for (const m of code.matchAll(/(?<![.\w$])([A-Z][A-Z0-9_]{2,})(?![\w$])/g)) {
      const name = m[1];
      if (REQUIRE_UNDERSCORE && !name.includes("_")) continue;
      if (defined.has(name) || ALLOW.has(name)) continue;
      // JSX 组件名（PascalCase，不以 _ 结尾、全大写字母但含小写）已被上面正则排除；
      // 这里剩下的都是「连续大写+下划线+数字」形态，属于常量约定
      problems.push(`${rel}: ${name}`);
    }
  }
  return [...new Set(problems)];
}

const problems = scanUndefined(WEB_SRC);

console.log("=== 前端未定义常量扫描 ===");
if (problems.length) for (const p of problems) console.log(`    ${p}`);
t("所有页面/组件用到的大写常量都有导入或定义", () => {
  if (problems.length) {
    throw new Error(`发现 ${problems.length} 处未定义常量（打开对应界面会抛 ReferenceError）：\n    ${problems.join("\n    ")}`);
  }
});

// 回归锚点：确保扫描器本身真的能工作（人为构造一个反例，它必须报出来）
t("扫描器有效性自检（构造反例必须被抓到）", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "undef-check-"));
  try {
    writeFileSync(path.join(tmp, "bad.jsx"), "export const a = NOT_IMPORTED_THING[0];\n", "utf8");
    const found = scanUndefined(tmp);
    if (!found.some((f) => f.includes("NOT_IMPORTED_THING"))) {
      throw new Error("扫描器漏报了反例，说明它已经不工作了");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// 锚点：SERIES_COLORS 这个具体事故必须保持修好（它在 AdminChannelsPage 里被引用）
t("AdminChannelsPage 实际导入了 SERIES_COLORS（真实事故回归）", () => {
  const f = path.join(WEB_SRC, "pages", "AdminChannelsPage.jsx");
  if (!existsSync(f)) throw new Error("AdminChannelsPage.jsx 不存在");
  const src = readFileSync(f, "utf8");
  if (!/SERIES_COLORS/.test(src)) return; // 不再用它就无所谓
  const defined = definedNames(src);
  if (!defined.has("SERIES_COLORS")) throw new Error("引用了 SERIES_COLORS 但没有导入");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
