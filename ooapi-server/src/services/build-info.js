// 前端构建版本号 —— 用于识别「浏览器还开着旧前端包」。
//
// 为什么必须有：这是纯前端 SPA，页面打开后就不会再请求 index.html，
// 发版换掉 bundle 也换不掉已打开的页面。线上实测踩过这个坑 ——
// 渠道图标、弹窗滚动明明已经改好并部署，用户在旧页面里看到的还是旧行为，
// 于是判断「没改」。有了 build_id，页面自己就能发现落后并提示刷新。
//
// 判定口径用 bundle 文件名（index-XXXXXXXX.js）而不是时间戳：
// vite 的文件名带内容哈希，只有真正重新构建才会变；
// 而「部署同一份产物」不该打扰用户刷新。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "..", "..", "web", "index.html");

// stat 做缓存键：部署后 mtime+size 必变，没变就不重复读文件。
// 不缓存「读失败」的结果，否则前端还没构建时启动会把空值永久缓存住。
let cache = { key: "", id: "" };

export function buildId() {
  try {
    const st = fs.statSync(INDEX_HTML);
    const key = `${st.mtimeMs}:${st.size}`;
    if (cache.key === key && cache.id) return cache.id;
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    const m = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
    if (!m) return "";
    cache = { key, id: m[1] };
    return cache.id;
  } catch {
    // 未构建（本地开发直连 vite）时返回空串，前端据此跳过检测
    return "";
  }
}
