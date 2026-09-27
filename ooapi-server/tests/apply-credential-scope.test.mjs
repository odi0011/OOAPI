// applyCredentialToChannel 的作用域回归锁（WorkBuddy 绑定回滚事故，2026-09-27）
// ===========================================================================
// 事故：该函数体里出现了 `...(rest || {})` —— `rest` 是「添加渠道」大处理器里
// 解构 req.body 的变量，拷贝 importAuth 调用时被一起带了进来。于是：
//   · node --check 通过（只是语法检查，不做作用域解析）；
//   · undefined-symbols 只扫前端 UPPER_SNAKE 自由标识符，也照不到它；
//   · 只在「设备绑定完成 → 写回凭据」这一条路径上抛
//     `ReferenceError: rest is not defined` → 绑定被整体回滚（实测 WorkBuddy）。
// 这类「闭包内未定义引用」目前没有通用静态扫描，先在这里对最高危的落点
// （所有厂商凭据写回的公共函数）做定向断言：函数体内不得出现自由变量 rest。
// 若将来真要透传额外字段，正确做法是显式加入函数签名 —— 到时把这条断言一起改。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "src", "routes", "channel.js"), "utf8");

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

t("applyCredentialToChannel 函数存在且可定位", () => {
  assert.match(src, /async function applyCredentialToChannel\(/);
});

t("函数体内不得引用未定义的 rest（拷贝残留会只在绑定路径上炸）", () => {
  const start = src.indexOf("async function applyCredentialToChannel(");
  assert.ok(start >= 0);
  // 从函数起点取到下一个「顶级 async function / router.」声明为止，即本函数体
  const rest0 = src.slice(start);
  const next = rest0.slice(10).search(/\n(async function |router\.|\/\* -)/);
  const body = next >= 0 ? rest0.slice(0, next + 10) : rest0;
  // 先剥掉整行注释：函数体里的「事故说明注释」本身会提到 rest 这个词，
  // 不剥的话测试永远自打脸（注释里出现 ≠ 代码里引用）
  const code = body
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  // 允许出现 `rest` 作为更大标识符的一部分（如 restore），只拦独立标识符
  const hits = code.match(/\brest\b/g) || [];
  assert.deepEqual(hits, [], `发现 ${hits.length} 处 rest 引用（拷贝残留）`);
});

t("importAuth 调用仍走适配器优先路径（MiMo 事故的回归锚点）", () => {
  const start = src.indexOf("async function applyCredentialToChannel(");
  const body = src.slice(start, start + 4000);
  assert.match(body, /adapter\.importAuth\(\{ token: raw, mode: "paste" \}\)/);
});

console.log(`\napply-credential-scope：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
