// 快捷登录路径规范：**本机浏览器优先，服务器浏览器只作备选**
// ===========================================================================
// 用户反馈（原话）：
//   「所有快捷登录你都是做的内置浏览器？你有病吧？这不是给服务器徒增压力吗，
//    而且压根没必要啊，就直接唤起用户本机浏览器窗口就行啊，登录完抓回调参数
//    回填不就行了吗？」
//
// 这个判断是对的，代价差别很大：
//   · 本机浏览器：用户自己电脑上多半已经登录好了，复制一串凭据即可 —— 零服务器开销；
//   · 服务器浏览器：每次登录要在服务器上起一个真实 Chromium（xvfb + 过风控 + 读 storage）。
//
// 但有一个**诚实的例外必须保留服务器浏览器**：HttpOnly cookie 用 JS 读不到，
// 服务器浏览器能自动读。所以它降级为备选，而不是删掉。
//
// 这套断言锁住三件事：
//   ① 每个能抓取的网页渠道都登记了本机登录指引（否则用户只能走服务器浏览器）；
//   ② 指引里的取码代码语法合法（能直接粘到浏览器控制台执行）；
//   ③ 找回方式列表里「本机浏览器」排在「服务器浏览器」之前，且不重复。
import { publicProviders, localLoginGuide } from "../src/services/channel-types.js";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`); }
};

const providers = publicProviders();
/** 收集所有「能在网页上登录」的接入方式：有 entryUrl（可抓取）或有本机指引 */
const webMethods = [];
for (const p of providers) {
  for (const m of p.methods) {
    if (m.apiKey) continue; // API Key 型与登录无关
    if (m.canCapture || m.localLogin) webMethods.push({ provider: p, method: m });
  }
}

/* ============ ① 覆盖度：能抓取的渠道必须有本机指引 ============ */
console.log("\n=== ① 每个网页渠道都有本机登录指引 ===");
{
  const missing = webMethods.filter((x) => x.method.canCapture && !x.method.localLogin);
  ck("所有可抓取渠道都登记了本机指引（否则用户只能走服务器浏览器）",
    missing.length === 0,
    missing.map((x) => `${x.provider.key}:${x.method.key}`).join(", "));
  const withGuide = webMethods.filter((x) => x.method.localLogin);
  ck("登记了本机指引的渠道数 ≥ 8", withGuide.length >= 8, String(withGuide.length));
  // 逐个点名（这些是用户实际会用到的主力渠道）
  for (const [p, m] of [["deepseek", "relay"], ["glm", "relay"], ["kimi", "relay"], ["doubao", "relay"],
    ["qwen", "relay"], ["mimo", "mimo-web"], ["minimax", "minimax-web"], ["stepfun", "stepfun-web"]]) {
    ck(`${p}:${m} 有本机指引`, Boolean(localLoginGuide(p, m)));
  }
}

/* ============ ② 指引质量：文案与代码都要能真的用 ============ */
console.log("\n=== ② 指引可用性 ===");
{
  for (const { provider, method } of webMethods) {
    const g = method.localLogin;
    if (!g) continue;
    const tag = `${provider.key}:${method.key}`;
    ck(`${tag} 有分步说明（≥2 步）`, Array.isArray(g.steps) && g.steps.length >= 2,
      String(g.steps?.length));
    ck(`${tag} 步骤里提到了「在哪取」（F12/Console/Cookies/Network 之一）`,
      g.steps.some((s) => /F12|Console|Cookies|Network|开发者工具/.test(s)),
      JSON.stringify(g.steps.slice(0, 1)));
    if (g.snippet) {
      // 取码代码要能直接粘进浏览器控制台跑：这里只能验 JS 语法，
      // 语法错的话用户复制过去只会看到红色报错（比没有更糟）
      let ok = true;
      let err = "";
      try { new Function(g.snippet); } catch (e) { ok = false; err = e.message; }
      ck(`${tag} 取码代码语法合法`, ok, err);
      // 断言「最终会写进剪贴板」而不是「字面以 copy( 开头」：
      // 需要先 await 的渠道（OpenAI 必须先请求 session 接口）必然是 IIFE 形态，
      // 要求字面开头会把正确实现判成错的（第一版就是这么误判的）。
      ck(`${tag} 取码代码会写进剪贴板（含 copy( 调用）`, /copy\(/.test(g.snippet), g.snippet.slice(0, 30));
    }
  }
  // 有 copy 能力的渠道应当给出代码；且必须覆盖 deepseek/glm（这两个用户最常用）
  for (const [p, m] of [["deepseek", "relay"], ["glm", "relay"]]) {
    const s = localLoginGuide(p, m)?.snippet || "";
    ck(`${p} 提供了取码代码`, /^copy\(/.test(s), s.slice(0, 40));
  }
  // 取码代码里不得出现会误伤的写法：copy(整个 JSON 对象) 会让适配器判为非法凭据
  const ds = localLoginGuide("deepseek", "relay")?.snippet || "";
  ck("DeepSeek 取的是 .value 而不是整个 JSON 对象",
    /\.value/.test(ds) && !/copy\(localStorage\.getItem\('userToken'\)\)$/.test(ds), ds);
}

/* ============ ③ 找回方式的排序：本机优先，且不重复 ============ */
console.log("\n=== ③ 找回方式排序（本机浏览器优先）===");
{
  const src = readFileSync(new URL("../src/routes/channel.js", import.meta.url), "utf8");
  // 顺序断言：paste 先 push，session-capture / oauth-browser 后 push
  const iLocalSession = src.indexOf('label: "本机浏览器登录后粘贴（推荐）"');
  const iServerSession = src.indexOf('label: "服务器浏览器自动抓取"');
  ck("session-capture 段：本机路径先于服务器路径", iLocalSession > 0 && iServerSession > iLocalSession,
    `本地@${iLocalSession} 服务器@${iServerSession}`);
  const iLocalOauth = src.indexOf('label: "本机浏览器登录 + 粘贴回调（推荐）"');
  const iServerOauth = src.indexOf('label: "服务器浏览器自动登录"');
  ck("oauth 段：本机路径先于服务器路径", iLocalOauth > 0 && iServerOauth > iLocalOauth,
    `本地@${iLocalOauth} 服务器@${iServerOauth}`);
  ck("不再把服务器浏览器标成「推荐」",
    !/label: "浏览器登录（推荐）"/.test(src) && !/label: "浏览器登录抓取（推荐）"/.test(src));
  // 去重：同一 key 不能出现两次（否则下拉里两个同名项，用户分不清）
  ck("paste 方式做了去重（不重复 push）",
    /if \(!modes\.some\(\(m\) => m\.key === "paste"\)\)/.test(src));
  // 这句文案在前端（后端只提供数据）；且它在 JSX 里跨行，
  // 正则必须先压掉空白再匹配（第一版就是因跨行而误判失败的）
  const feSrcForNote = readFileSync(new URL("../../ooapi-web/src/pages/AdminChannelsPage.jsx", import.meta.url), "utf8");
  ck("服务器浏览器按钮带资源开销说明",
    /会在这台服务器上启动一个真实浏览器/.test(feSrcForNote.replace(/\s+/g, " ")));
  // recovery 接口要下发本机指引，重新登录弹窗才有分步说明可用
  ck("recovery 返回 localLogin 指引", /localLogin: \{ \.\.\.\(localLoginGuide/.test(src));
}

/* ============ ④ 前端渲染：新增面板与重新登录弹窗都用到指引 ============ */
console.log("\n=== ④ 前端两处入口 ===");
{
  const fe = readFileSync(new URL("../../ooapi-web/src/pages/AdminChannelsPage.jsx", import.meta.url), "utf8");
  ck("新增渠道面板：有本机指引时渲染分步说明", /pickMethod\.localLogin\.steps\.map/.test(fe));
  ck("新增渠道面板：主按钮是「打开 XX 登录页」（type=primary）",
    /打开 \{pickProvider\?\.name\} 登录页/.test(fe));
  ck("新增渠道面板：服务器浏览器标注「（备选）」", /服务器浏览器（备选）/.test(fe));
  ck("重新登录弹窗也渲染指引", /reloginLocalGuide\?\.steps/.test(fe));
  ck("重新登录弹窗读的是后端下发的 localLogin", /reloginInfo\?\.localLogin/.test(fe));
  ck("取码代码块可点击复制", /copyText\(pickMethod\.localLogin\.snippet\)/.test(fe));
  ck("默认选推荐方式（后端已把本机排第一）", /info\?\.modes\?\.\[0\]\?\.key/.test(fe));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
