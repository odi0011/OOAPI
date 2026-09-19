// 全量静态健全性检查：语法 + import/export 一致性（跨文件导出是否存在）
// 背景：批量清理未使用 import 的脚本改过 import 行，必须确认没有留下语法错误或引用不存在的导出。
// 路径用脚本自身位置推导（不能用写死的绝对路径，否则换机器/换目录就找不到 src）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "src");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk(SERVER);
let syntaxFail = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    syntaxFail += 1;
    console.log("SYNTAX FAIL:", path.relative(SERVER, f));
    console.log(String(e.stderr || "").split("\n").slice(0, 3).join("\n"));
  }
}
console.log(`语法检查：${files.length} 个文件，失败 ${syntaxFail}`);

// 导出收集：file -> Set(exported names)
const exportMap = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  if (/export\s+default/.test(src)) names.add("default");
  exportMap.set(f.replace(/\\/g, "/"), names);
}

// 检查相对 import：目标文件存在、具名导出存在
// 注意：不能跨 import 语句匹配 —— 用 [^;]*? 且禁止出现分号，
// 否则 `import { Router } from "express"; import { pool } from "../db.js";`
// 会被当成「Router 来自 ../db.js」（本脚本第一版就踩了这个坑）。
let importFail = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/import\s+([^;]*?)\s+from\s+["'](\.[^"']+)["']/gs)) {
    const clause = m[1];
    const spec = m[2];
    const target = path.resolve(path.dirname(f), spec).replace(/\\/g, "/");
    if (!fs.existsSync(target)) {
      importFail += 1;
      console.log(`MISSING FILE: ${path.relative(SERVER, f)} -> ${spec}`);
      continue;
    }
    const exports = exportMap.get(target);
    if (!exports) continue;
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const t = part.trim().split(/\s+as\s+/)[0].trim();
        if (!t) continue;
        if (!exports.has(t)) {
          importFail += 1;
          console.log(`MISSING EXPORT: ${path.relative(SERVER, f)} imports {${t}} from ${spec}`);
        }
      }
    }
  }
}
console.log(`import 检查：失败 ${importFail}`);
console.log(syntaxFail === 0 && importFail === 0 ? "SERVER_STATIC_CHECK_PASS" : "SERVER_STATIC_CHECK_FAIL");
process.exit(syntaxFail === 0 && importFail === 0 ? 0 : 1);
