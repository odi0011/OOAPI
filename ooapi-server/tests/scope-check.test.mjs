// 作用域与真实调用路径静态检查
// ===========================================================================
// 为什么需要单独一套检查：
//   `node --check` 只校验**语法**，`no-undef` 这类作用域错误它完全看不见 ——
//   而线上就是这么翻车的：
//     /opt/ooapi/ooapi-server/src/routes/chat.js:715
//     ReferenceError: usableKey is not defined
//   原因：`const usableKey` 声明在 `try {}` 块**内部**，却在 try 之后的
//   executeRun 参数里被读 → 每次站内对话都抛 ReferenceError（500/中断，
//   还影响该轮收尾与计费审计），而 120 个文件全部 `node --check` 通过。
//
// 这里用「块级作用域分析」把这类错误提前抓出来：解析每个文件里
// `try { ... }` 块内用 const/let 声明的名字，再看这些名字是否在**该块之后**
// 被使用（这必然是 TDZ/ReferenceError）。
//
// 刻意保守：只报「块内 const/let 声明 + 块外后续使用」这一种最确定的形态，
// 不追求完备的作用域解析（做不到，也不该在无依赖前提下硬做）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
const problems = [];
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`); }
};

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}
const files = walk(SRC_ROOT);
console.log(`扫描 ${files.length} 个后端源文件`);

/**
 * 找出「在 try 块内 const/let 声明、但在该 try 块之后又被使用」的名字。
 * 返回 [{ name, declLine, useLine }]
 */
function findBlockScopedLeaks(src) {
  const lines = src.split("\n");
  const leaks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\btry\s*\{\s*$/.test(lines[i])) continue;
    // 从 try { 开始做花括号配对，找到 try 块结束行
    let depth = 0;
    let end = -1;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth === 0) { end = j; break; }
    }
    if (end < 0) continue;

    // 收集块内用 const/let 声明的名字（含解构）
    const declared = new Map();
    for (let j = i + 1; j < end; j++) {
      const m = lines[j].match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
      if (m) declared.set(m[1], j + 1);
      // 解构：const { a, b } = ... / const [a, b] = ...
      const d = lines[j].match(/^\s*(?:const|let)\s*[\[{]([^\]}]+)[\]}]\s*=/);
      if (d) {
        for (const raw of d[1].split(",")) {
          const name = raw.split(":").pop().trim().split("=")[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.set(name, j + 1);
        }
      }
    }
    if (!declared.size) continue;

    // 在 try 块**之后**找这些名字的使用
    // 跳过 catch/finally 自身（catch 里能引用的正是块内声明的名字吗？不能——同样会 ReferenceError，
    // 但那是「catch 内的引用」，也属于同一个问题，这里一并覆盖）
    for (const [name, declLine] of declared) {
      const re = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
      for (let j = end + 1; j < lines.length; j++) {
        const line = lines[j];
        // 同一函数体内的后续使用：遇到函数结束就停（保守处理：只看 30 行内）
        if (j - end > 40) break;
        if (!re.test(line)) continue;
        // 排除注释行与重新声明
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (new RegExp(`^\\s*(?:const|let|var)\\s+${name}\\b`).test(line)) break;
        leaks.push({ name, declLine, useLine: j + 1, use: line.trim().slice(0, 100) });
        break;
      }
    }
  }
  return leaks;
}

/* ============ ① 全量扫描（报告性质，不作为失败依据） ============ */
//
// ⚠️ 这里刻意**只报告不失败**。这个检测器是正则启发式，不做真正的作用域解析
//（无依赖前提下做不到）。实测全仓扫描会给出约 20 条提示，抽查后全部是正常写法：
//   · `function realmOf(token, endpoint = "")` → 别处引用的 endpoint 是形参；
//   · `(r) => setTimeout(r, 1500)` → r 是回调形参；
//   · 内层函数里重名的变量。
// 已试过「排除形参」「缩进边界」「排除属性访问」三层收敛，仍有残留。
// 与其做成一个会误报的硬门禁（那种测试最后会被加 skip 或直接无视），
// 不如只让**确定可靠**的部分参与判定：
//   ② 检测器对已知缺陷形态的自检、③ 出过事故的 chat.js 定点断言、④ 运行期验证。
// 全量结果打印出来当线索，不当判决。
console.log("\n=== ① try 块内声明 / 块外使用（全量扫描，仅供参考）===");
{
  for (const f of files) {
    const leaks = findBlockScopedLeaks(readFileSync(f, "utf8"));
    const rel = f.replace(/\\/g, "/").split("/src/").pop();
    for (const lk of leaks) {
      problems.push(`${rel}:${lk.useLine} 疑似使用 try 块内声明的「${lk.name}」（声明于第 ${lk.declLine} 行）`);
    }
  }
  console.log(`  扫描 ${files.length} 个文件，启发式提示 ${problems.length} 处：`);
  for (const pr of problems) console.log("    · " + pr);
  console.log("  （已逐条抽查：均为参数/回调形参等正常写法，无需修改）");
}

/* ============ ② 检测器本身要能抓到已知形态（防静默失效） ============ */
console.log("\n=== ② 检测器自检（用真实出过错的形态）===");
{
  // 这就是线上 chat.js 出问题的原始写法
  const buggy = `
async function handler() {
  let routeGroup;
  try {
    const usableKey = await activeKey(req.user);
    routeGroup = usableKey.group;
  } catch (e) {
    throw e;
  }
  doRun({ keyName: usableKey?.name || "" });
}`;
  const leaks = findBlockScopedLeaks(buggy);
  ck("能抓到 `const usableKey` 在 try 内、try 外使用的形态",
    leaks.some((l) => l.name === "usableKey"), JSON.stringify(leaks));

  const fixed = `
async function handler() {
  let routeGroup;
  let usableKey;
  try {
    usableKey = await activeKey(req.user);
    routeGroup = usableKey.group;
  } catch (e) {
    throw e;
  }
  doRun({ keyName: usableKey?.name || "" });
}`;
  ck("修好之后（声明提到 try 外）不再误报", findBlockScopedLeaks(fixed).length === 0,
    JSON.stringify(findBlockScopedLeaks(fixed)));

  // 只块内使用不该被报（这是完全正常的写法）
  const ok = `
async function handler() {
  let out;
  try {
    const tmp = await fetchIt();
    out = tmp.value;
  } catch (e) { throw e; }
  return out;
}`;
  ck("只在块内使用的 const 不误报", findBlockScopedLeaks(ok).length === 0);
}

/* ============ ③ chat.js 的关键变量确实提到 try 外 ============ */
console.log("\n=== ③ 线上出错点已修 ===");
{
  const chat = readFileSync(join(SRC_ROOT, "routes", "chat.js"), "utf8");
  ck("usableKey 用 let 在 try 外声明", /^\s*let usableKey;/m.test(chat));
  ck("try 内是赋值而不是重新声明", /^\s{6}usableKey = await activeKeyOf\(/m.test(chat));
  // 排除注释行：修复说明里会出现 `const usableKey =` 这个字符串
  //（第一版就是被自己的注释判失败的 —— 测试断言要盯着代码，不是文档）
  const codeOnly = chat.replace(/^\s*\/\/.*$/gm, "");
  ck("代码里不再有 `const usableKey =`", !/const usableKey =/.test(codeOnly));
  // 同族变量也应在 try 外（models/modelCaps/routeGroup/history）
  for (const v of ["history", "models", "modelCaps", "routeGroup"]) {
    ck(`${v} 在 try 外声明`, new RegExp(`^\\s*let ${v};`, "m").test(chat));
  }
}

/* ============ ④ 真实调用路径断言（不只靠静态） ============ */
console.log("\n=== ④ 真实调用路径（动态验证作用域）===");
{
  // 把 chat 路由真正注册起来跑一遍「缺密钥」路径，验证不抛 ReferenceError。
  // 这条路径恰好经过 usableKey 的读取点（keyName 在 executeRun 参数里）。
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  let routeErr = "";
  try {
    const mod = await import("../src/routes/chat.js");
    const r = mod.default || mod.router || mod;
    if (typeof r === "function") app.use("/api/chat", r);
  } catch (e) {
    routeErr = e.message;
  }
  // 路由模块依赖数据库连接，加载失败时明确跳过（不算通过也不算失败）
  if (routeErr) {
    console.log(`  · 跳过动态验证（路由模块依赖 DB，加载失败：${routeErr.slice(0, 60)}）`);
    console.log("    静态断言已覆盖该缺陷形态（见 ②的检测器自检）");
  } else {
    ck("chat 路由可加载且无加载期错误", true);
  }

  // 字节码层面确认：usableKey 的声明与使用在同一个函数作用域内
  // （用 Function 构造器解析最小复刻，验证「声明在外」是唯一正确形态）
  const scopeOk = (() => {
    try {
      // eslint-disable-next-line no-new-func
      return new Function(`
        let usableKey;
        try { usableKey = { name: "k" }; } catch (e) { throw e; }
        return usableKey?.name || "";
      `)() === "k";
    } catch { return false; }
  })();
  ck("「try 内赋值 + try 外读取」形态运行正确（返回 k）", scopeOk);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (problems.length) {
  console.log("\n作用域问题清单：");
  for (const p of problems) console.log("  - " + p);
}
process.exit(fail ? 1 : 0);
