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
    // 「在哪取」必须说清 —— 但取法有**两族**，正则不能只认浏览器那一族：
    //   · 网页反代类：凭据在浏览器里 → F12 / Console / Cookies / Network / 开发者工具
    //   · 订阅 CLI 类（Codex / Claude Code / Kiro / Antigravity）：凭据是**本机文件**
    //     → 要说出打开哪个目录 / 哪个文件（%USERPROFILE% / ~/.codex / 资源管理器…）
    // 早先只认第一族，把「打开 %USERPROFILE%\.codex 里的 auth.json」这种
    // 完全正确的指引判成不合格（误报会让人不再信任这条测试）。
    ck(`${tag} 步骤里提到了「在哪取」（开发者工具或本机凭据文件路径）`,
      g.steps.some((s) =>
        /F12|Console|Cookies|Network|开发者工具|资源管理器|%USERPROFILE%|~\/|打开|记本|\.json|后台/i.test(s)
      ),
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
  // 用户要求（原话）：「那个服务器内部浏览器压根用不了你懂吗？卡的不行啊而且吃服务器内存
  // 和性能，这个逼玩意可以直接删了啊，根本用不着啊。」
  // 删的是**登录用的**服务器浏览器；对话驱动的浏览器（GLM/豆包/通义）另有原因必须保留
  //（页面签名无法服务端伪造，见 glm.js 说明），所以这里只断言登录相关已清理。
  ck("后端不再提供服务器浏览器登录方式（session-capture）",
    !/key: "session-capture"/.test(src));
  ck("后端不再提供服务器浏览器自动登录（oauth-browser）",
    !/key: "oauth-browser"/.test(src));
  ck("后端不再提供 browser-ready（服务器浏览器打开登录页）",
    !/key: "browser-ready"/.test(src));
  ck("oauth 找回用「本机浏览器 + 粘贴回调」", /label: "本机浏览器登录 \+ 粘贴回调"/.test(src));
  ck("needsBrowser 渠道也只剩本机浏览器路径",
    src.includes('label: "本机浏览器登录"') && src.includes('desc: "在弹出的小窗里登录上游'));
  // 去重：同一 key 不能出现两次（否则下拉里两个同名项，用户分不清）
  ck("paste 方式做了去重（不重复 push）",
    /if \(!modes\.some\(\(m\) => m\.key === "paste"\)\)/.test(src));
  // 这句文案在前端（后端只提供数据）；且它在 JSX 里跨行，
  // 正则必须先压掉空白再匹配（第一版就是因跨行而误判失败的）
  const feSrcForNote = readFileSync(new URL("../../ooapi-web/src/pages/AdminChannelsPage.jsx", import.meta.url), "utf8");
  // 只断言「没有入口/按钮」，不断言「一个字都不许提」——
  // 注释里写明「这条已删除及其原因」恰恰是必要的（否则下一个人会再加回来）
  const feCode = feSrcForNote
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")   // 去掉 JSX 注释块
    .replace(/^\s*\/\/.*$/gm, "");              // 去掉行注释
  ck("前端不再有「服务器浏览器」入口/按钮文案",
    !/服务器浏览器（备选）/.test(feCode) && !/>\s*服务器浏览器/.test(feCode));
  ck("前端不再引用捕获/实时画面相关接口",
    !/\/capture\/|vnc\/info/.test(feSrcForNote));
  // recovery 接口要下发本机指引，重新登录弹窗才有分步说明可用
  ck("recovery 返回 localLogin 指引", /localLogin: \{ \.\.\.\(localLoginGuide/.test(src));
}

/* ============ ④ 前端渲染：新增面板与重新登录弹窗都用到指引 ============ */
console.log("\n=== ④ 前端两处入口 ===");
{
  const fe = readFileSync(new URL("../../ooapi-web/src/pages/AdminChannelsPage.jsx", import.meta.url), "utf8");
  // 分步说明：第 1 步（「在打开的页面完成登录」）由按钮承担，渲染时被过滤掉
  ck("新增渠道面板：有本机指引时渲染分步说明",
    /pickMethod\.localLogin\.steps/.test(fe) && /\.filter\(\(t\) => !\/\^在打开的页面\//.test(fe));
  // 用户要求：「本机浏览器应该是直接唤起用户的当前的浏览器的一个小窗啊…
  //           应该是弹出小窗口啊弹出用户浏览器的小窗口啊」
  ck("新增渠道面板：主按钮是「弹出登录小窗」",
    /弹出登录小窗（\{pickProvider\?\.name\}）/.test(fe));
  ck("用小窗打开（window.open 带 popup 尺寸），不是普通新标签",
    /popup=yes,width=\$\{w\},height=\$\{h\}/.test(fe));
  ck("弹窗被拦截时给出可点链接兜底（不静默失败）",
    /浏览器拦截了弹窗/.test(fe));
  ck("重新登录弹窗也渲染指引", /reloginLocalGuide\?\.steps/.test(fe));
  ck("重新登录弹窗读的是后端下发的 localLogin", /reloginInfo\?\.localLogin/.test(fe));
  ck("取码代码块可点击复制", /copyText\(pickMethod\.localLogin\.snippet\)/.test(fe));
  ck("默认选推荐方式（后端已把本机排第一）", /info\?\.modes\?\.\[0\]\?\.key/.test(fe));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
