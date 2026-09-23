// 关键符号存在性检查 —— 专防「按行号批量删代码，误删仍在使用的符号」
// ===========================================================================
// 线上真出过事故：清理服务器浏览器死代码时用「按行号区间删除」，连带删掉了
// `load` / `addForm` / `editModels` 等仍在使用的符号 ——
//   · `npm run build` **照样通过**（vite 只打包，不做作用域分析）
//   · 部署**显示成功**
//   · 但打开管理页**白屏**：`ReferenceError: load is not defined`
//
// 教训两条，本文件就是它们的固化：
//   ① 删代码必须按**符号**查引用，不能只按行号切（行号会因前面的编辑漂移）；
//   ② build 通过 ≠ 没有未定义引用，必须有这道检查。
//
// 为什么用「精确声明形态」而不是泛化的 AST/no-undef：
//   先写过一版宽泛正则的检查器，它在 5000 行的 JSX 文件上误报 6~11 个
//   （把 `DownloadOutlined` 里的 load 当成 load、把 CSS 的 clamp() 当成 JS 调用、
//    漏掉 `const [x, setX] = useState` 这种解构）—— 一个会误报的门禁最终会被无视。
//   这里只锁「被误删过 + 一旦缺失必然白屏」的那批符号，判据是**精确的声明形态**，
//   零误报，且正好覆盖真实故障面。
import fs from "node:fs";

const FILE = new URL("../../ooapi-web/src/pages/AdminChannelsPage.jsx", import.meta.url);
const src = fs.readFileSync(FILE, "utf8");

/** 必须存在的符号 + 它们的精确声明形态 */
const REQUIRED = [
  // 列表加载：被误删过，缺了直接白屏
  ["load", /const load\s*=\s*useCallback\(/],
  ["resync 轮询（load 的静默调用）", /load\(\{\s*silent:\s*true\s*\}\)/],
  // 三个表单实例：新增/编辑/批量全靠它们
  ["addForm", /const \[addForm\]\s*=\s*Form\.useForm\(\)/],
  ["editForm", /const \[editForm\]\s*=\s*Form\.useForm\(\)/],
  ["batchForm", /const \[batchForm\]\s*=\s*Form\.useForm\(\)/],
  // 表单实时值：ModelPicker 与检测配置依赖
  ["addBaseUrl", /const addBaseUrl\s*=\s*Form\.useWatch\(/],
  ["addApiKey", /const addApiKey\s*=\s*Form\.useWatch\(/],
  ["editModels", /const editModels\s*=\s*Form\.useWatch\(/],
  ["editAutoTestOn", /const editAutoTestOn\s*=\s*Form\.useWatch\(/],
  // 竞态令牌：列表请求的作废判定
  ["useLatest 解构", /const \{ begin, isLatest \}\s*=\s*useLatest\(\)/],
  // 本次新增/改造的函数
  ["openLocalLoginWindow（弹出登录小窗）", /const openLocalLoginWindow\s*=/],
  ["startOAuth", /const startOAuth\s*=/],
  ["keyUrlOf", /const keyUrlOf\s*=/],
  ["doDelete", /const doDelete\s*=\s*async/],
  ["doBatch", /const doBatch\s*=\s*async/],
  ["openAdd", /const openAdd\s*=\s*\(\)\s*=>/],
  ["applyMethod", /const applyMethod\s*=/],
  ["credOptions", /const credOptions\s*=\s*useMemo\(/],
  // 登录相关的 state（删服务器浏览器时误删过 setter）
  ["oauthUrl/oAuthState/oauthBusy", /const \[oauthUrl, setOauthUrl\]\s*=\s*useState/],
  ["bindInfo", /const \[bindInfo, setBindInfo\]\s*=\s*useState/],
  ["bindTicketRef", /const bindTicketRef\s*=\s*useRef\(/],
];

/** 必须**不存在**的符号（服务器浏览器登录链路已整体删除） */
const FORBIDDEN = [
  ["服务器浏览器抓取面板 state", /const \[capSid, setCapSid\]/],
  ["noVNC 实时画面 state", /const \[vncInfo, setVncInfo\]/],
  ["服务器浏览器弹窗 state", /const \[browserOpen, setBrowserOpen\]/],
  ["抓取面板启动函数", /const startCapture\s*=\s*async/],
  ["服务器浏览器重登函数", /const reloginBrowserStart\s*=\s*async/],
  ["服务器浏览器按钮文案", />\s*服务器浏览器[（(]/],
];

let bad = 0;
console.log("=== 必须存在（缺一个就白屏或功能不可用）===");
for (const [name, re] of REQUIRED) {
  const ok = re.test(src);
  if (!ok) bad++;
  console.log((ok ? "  ✓ " : "  ✗ ") + name);
}
console.log("\n=== 必须不存在（服务器浏览器链路已删）===");
for (const [name, re] of FORBIDDEN) {
  const gone = !re.test(src);
  if (!gone) bad++;
  console.log((gone ? "  ✓ " : "  ✗ ") + name + (gone ? "（已删除）" : " ← 仍在！"));
}

if (bad) {
  console.log(`\n失败 ${bad} 项。注意：npm run build 不会发现这类问题，必须修完再部署。`);
  process.exit(1);
}
console.log(`\n✓ 符号检查通过（${REQUIRED.length} 项必须存在 + ${FORBIDDEN.length} 项必须已删）`);
