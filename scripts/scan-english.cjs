const fs = require("fs");
const path = require("path");

// 扫描组件库里的硬编码英文界面文案。
//
// 这些是 Arc UI 的原生默认值，本项目是中文站点，需要逐个中文化。
// registry 模式下组件归项目所有，直接改源码是正确做法。
const root = "src/components/arc";

// 只匹配「会出现在界面上」的字符串默认值，不匹配样式类名与属性名
const patterns = [
  /placeholder\s*=\s*"([A-Za-z][^"]{2,40})"/g,
  /label\s*=\s*"([A-Za-z][^"]{2,40})"/g,
  /aria-label\s*=\s*"([A-Za-z][^"]{2,40})"/g,
  /emptyLabel\s*=\s*"([A-Za-z][^"]{2,40})"/g,
  /emptyMessage\s*=\s*"([A-Za-z][^"]{2,40})"/g,
  /itemName\s*=\s*"[^"]*"/g,
];

const found = new Map();

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
    } else if (e.name.endsWith(".tsx") && !e.name.endsWith(".d.ts")) {
      const src = fs.readFileSync(p, "utf8");
      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
          const text = m[1] ?? m[0];
          // 过滤掉明显不是界面文案的（纯类名、单字符、含 CSS 关键字）
          if (!/[a-z]/.test(text)) continue;
          if (/^(none|auto|button|dialog|menu|list|grid|flex)$/i.test(text)) continue;
          if (text.length < 3) continue;
          const key = p + " :: " + text;
          found.set(key, true);
        }
      }
    }
  }
}

walk(root);

console.log("发现 " + found.size + " 处硬编码英文界面文案：\n");
for (const k of [...found.keys()].sort()) {
  console.log("  " + k.replace(/^src\/components\/arc\//, ""));
}
