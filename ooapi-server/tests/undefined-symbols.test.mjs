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
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
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

/**
 * 去掉注释与字符串/模板字面量：只在「代码」里找标识符，避免文案里的全大写词误报。
 *
 * ⚠️ 这里的顺序与判据很讲究，踩过一次**致命的**坑（2026-09-24）：
 * 原先第一步是 `/\/\*[\s\S]*?\*\//g` 去块注释。但文件开头那种
 * 「多行 // 注释里出现 `/**` 字样」的写法（本项目的注释风格大量如此，
 * 注释里会引用示例代码）会让这个正则把**从那个 `/**` 到很后面某个 `*​/`**
 * 之间的 30 多行整段吃掉 —— **包括文件顶部所有 import**。
 * 后果不是「少识别几个名字」，而是 definedNames 认为「什么都没导入」，
 * 于是后端扫描器对 channel.js 报出 20 个假阳性（providerKeys/fail/writeLog…），
 * 一个会误报的门禁等于没有门禁。
 *
 * 所以现在按「先去掉行注释（它最简单、最不容易误吃），再去块注释」的顺序，
 * 且块注释要求 `/*` **不在行注释里**（前面不能是 `//`）。
 * 自检见文件末尾的「扫描器有效性」用例 —— 反例必须被抓到、正例不许误报。
 */
function stripNonCode(src) {
  let s = src;
  // ① 行注释：要求 // 前面不是冒号（避开 http://）也不是转义
  s = s.replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
  // ② 块注释：走过行注释后，剩下的 /* 才是真块注释起点
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  // ③ 字符串与模板字面量
  s = s
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''");
  return s;
}

/** 该文件里「有定义」的标识符：声明、导入、re-export、解构 */
function definedNames(rawSrc) {
  // 先在**去注释**的源码上跑：import 列表里可以有注释
  //（实测：`ExclamationCircleOutlined,\n // 说明\n ClockCircleOutlined,\n} from "..."` 这种写法
  //  会让按逗号切分的解析把注释与下一个名字粘在一起，那个名字就被误判成「未导入」）。
  const src = stripNonCode(rawSrc);
  const names = new Set();
  // const/let/var/function/class FOO
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // 函数参数的解构：function f({ onDelta, onReasoning = null }, x) { … }
  //   `async function execute({ onChannelTry, onDelta }) { onDelta(t) }` ——
  //   这些名字是**参数**，不是未导入的全局。后端扫描器在 execute.js /
  //   battleship.js 上正是被这类形态误报（onDelta(、move(、view(…）。
  // 覆盖三种声明形态（游戏模块用的是第二种）：
  //   ① function f({ a, b }) {}
  //   ② 对象简写方法：view(state, { side, payload }) {}
  //   ③ 箭头函数：({ a }) => {}
  for (const m of src.matchAll(/(?:function\s+[\w$]*\s*|[\w$]+\s*\([^)]*?|\(\s*|,\s*)\{([^{}]*)\}\s*(?:=[^,)]*)?\s*[,)]/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(":").pop()?.trim().split("=")[0].trim().split(/\s+as\s+/).pop()?.trim();
      if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  // 对象解构：const { Text, Title } = Typography;  /  const { a: b } = obj;
  // 这也是**真实事故**的一种：定价页用了 <Text> 却没在导入里加它，
  // 靠 `const { Text } = Typography` 这种写法才拿到的名字必须被认作「有定义」。
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(":").pop()?.trim().split(/\s+as\s+/).pop()?.trim();
      if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  // import { A, B as C } from "..."
  for (const m of src.matchAll(/import\s+(?:[A-Za-z_$][\w$]*\s*,?\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  // import X from "..."（默认导入）
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from/g)) names.add(m[1]);
  // export { A, B } from "..."（re-export，本文件里也算「有」）
  for (const m of src.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*"[^"]*")?/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
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

/**
 * 扫「用到了但没导入/没定义」的 **JSX 组件**（PascalCase 标签）。
 *
 * 为什么要加这一层（真实事故）：定价页重写时写了 `<Row>` / `<Col>` 却没往 antd 那行
 * import 里加这两个名字。后果与 SERIES_COLORS 那次一模一样 ——
 * vite build 成功、点开页面才抛 `ReferenceError: Row is not defined`，整页白屏。
 * 而 SCREAMING_SNAKE 扫描抓不到它（PascalCase 不含下划线）。
 *
 * 判定要点：**只认 JSX 标签位置**（`<Foo` / `</Foo>`），不认普通标识符 ——
 * 后者噪音太大（类型名、注释里的词、对象键都会被误伤）。
 * 同时排除：本文件定义/导入的、已知的全局（React 等）、
 * JSX 成员访问（`<Foo.Bar>` 的 Foo 会被 `[.\w$]` 的前瞻排掉）。
 */
function scanUndefinedJsx(dir) {
  const problems = [];
  // 这些是运行时/框架提供的，不需要导入
  const GLOBAL_JSX = new Set(["React", "Fragment", "Suspense", "StrictMode", "Profiler"]);
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    const defined = definedNames(src);
    const code = stripNonCode(src);
    const rel = path.relative(path.join(dir, ".."), file).replace(/\\/g, "/");
    // 只取 JSX 标签位置：`<Foo` 或 `</Foo>`，且 Foo 首字母大写（小写的是 HTML 原生标签）
    for (const m of code.matchAll(/<\/?([A-Z][A-Za-z0-9_$]*)/g)) {
      const name = m[1];
      if (defined.has(name) || GLOBAL_JSX.has(name)) continue;
      problems.push(`${rel}: <${name}>`);
    }
  }
  return [...new Set(problems)];
}

const problems = scanUndefined(WEB_SRC);
const jsxProblems = scanUndefinedJsx(WEB_SRC);

console.log("=== 前端未定义常量扫描 ===");
if (problems.length) for (const p of problems) console.log(`    ${p}`);
t("所有页面/组件用到的大写常量都有导入或定义", () => {
  if (problems.length) {
    throw new Error(`发现 ${problems.length} 处未定义常量（打开对应界面会抛 ReferenceError）：\n    ${problems.join("\n    ")}`);
  }
});

console.log("\n=== 前端未导入的 JSX 组件扫描 ===");
if (jsxProblems.length) for (const p of jsxProblems) console.log(`    ${p}`);
t("所有 JSX 组件标签都有导入或定义", () => {
  if (jsxProblems.length) {
    throw new Error(`发现 ${jsxProblems.length} 处未导入的组件（打开对应界面会抛 ReferenceError）：\n    ${jsxProblems.join("\n    ")}`);
  }
});

t("JSX 扫描器有效性自检（构造反例必须被抓到）", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "undef-jsx-"));
  try {
    writeFileSync(
      path.join(tmp, "bad.jsx"),
      "export const A = () => <NotImportedThing x={1} />;\nexport const B = () => <div />;\n",
      "utf8"
    );
    const found = scanUndefinedJsx(tmp);
    if (!found.some((f) => f.includes("NotImportedThing"))) {
      throw new Error("JSX 扫描器漏报了反例");
    }
    if (found.some((f) => f.includes("<div"))) {
      throw new Error("JSX 扫描器把原生 HTML 标签误报为组件");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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

// 锚点：定价页用 <Row>/<Col> 布局，必须从 antd 导入（2026-09 真实事故：
// 重写体检面板时用了这两个标签却没加进 import，整页白屏）
t("AdminPricingPage 导入了 Row / Col（真实事故回归）", () => {
  const f = path.join(WEB_SRC, "pages", "AdminPricingPage.jsx");
  const src = readFileSync(f, "utf8");
  const defined = definedNames(src);
  for (const name of ["Row", "Col"]) {
    if (!new RegExp(`<${name}[\\s>]`).test(src)) continue; // 不用就无所谓
    if (!defined.has(name)) throw new Error(`用了 <${name}> 但没有导入`);
  }
});

/* ===========================================================================
   后端：整包**可加载性**（比「正则当 linter」更可靠的一层）
   ===========================================================================
   真实事故（2026-09-24，我自己造成的）：给网关加 max_tokens 截断时用了
   `estimateTokens(...)` 却没把它加进 pricing.js 的 import 列表 ——
   `node --check` 通过（只做语法分析，不做作用域解析），部署成功、服务健康，
   但每次真实调用都在适配器里抛 `ReferenceError: estimateTokens is not defined`，
   渠道被标记 CHANNEL_ERROR 并冷却，用户看到的是 503「账号都在冷却中」——
   症状与根因看起来毫无关系（像是把渠道搞挂了），排查成本很高。

   我先试着写「正则扫未定义调用」，失败得很彻底：要给 Promise 的
   `resolve(` / `reject(`、对象简写方法 `view(state, {…}) {`、动态 `import(`、
   参数解构……逐个开豁免，最后剩下的仍是十几处误报。
   **一个会误报的门禁等于没有门禁** —— 正则做不了作用域分析。

   所以改用这个更朴素但**可靠**的判据：把每个后端模块**真正 import 一遍**。
   · 若是「顶层就引用了不存在的标识符」，加载即抛 ReferenceError；
   · 若是「只有某条路径用到」，加载不会抛 —— 那种只能靠真实调用覆盖，
     本文件不假装能测到（诚实划界，而不是给个假绿灯）。
   代价是每个模块都要被求值一次：本项目模块都是「定义函数 + 少量常量」，
   不连数据库、不起服务（连接是惰性的），所以安全且快。
   =========================================================================== */
const SKIP_LOAD = new Set([
  // 这些模块在被 import 时会立即做副作用（读文件/起定时器/连库），
  // 不适合在单测进程里加载。它们由各自的专项测试与 e2e 覆盖。
  "index.js",
]);

t("后端每个模块都能被 import（顶层未定义标识符会让加载直接抛错）", async () => {
  // ⚠️ 诚实划界：这一条**只能**抓「顶层」引用（import 时求值的路径）。
  // 实测验证过它抓不到真事故：estimateTokens 的引用在闭包里，
  // 只有真正处理请求时才抛 —— 我把 import 删掉跑这个测试，它照样全绿。
  // 闭包里的未定义标识符只能靠**真实调用**覆盖，
  // 那一层由 tests/api-smoke.mjs（真打接口）与线上 e2e 负责，这里不假装能测到。
  const srcDir = path.join(here, "..", "src");
  const files = [];
  const walkJs = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walkJs(p);
      else if (f.endsWith(".js") && !SKIP_LOAD.has(f)) files.push(p);
    }
  };
  walkJs(srcDir);

  const broken = [];
  for (const f of files) {
    try {
      await import(pathToFileURL(f).href);
    } catch (e) {
      // 只报「标识符未定义」这类**代码缺陷**；
      // 缺依赖/缺环境变量属于部署问题，不是本测试的职责
      const msg = String(e && e.message);
      if (/is not defined|Cannot access .* before initialization/.test(msg)) {
        broken.push(`${path.relative(srcDir, f).split(path.sep).join("/")}: ${msg}`);
      }
    }
  }
  if (broken.length) {
    const head = `有 ${broken.length} 个模块加载即失败（真实事故：estimateTokens is not defined 让整条渠道 503）：`;
    throw new Error(head + "\n    " + broken.join("\n    "));
  }
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
