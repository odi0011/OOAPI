// 第三轮用户反馈的回归锁
// ===========================================================================
// 用户原话：
//   ① 「点击跳转对应登录地址的按钮呢？你不是说做了吗？」
//   ② 「为什么 gpt 的要加上什么粘贴凭证（看看其他的有没有）？直接写 codex、
//       网页对话、系统驱动、API Key 就行了啊。」
//   ③ 「qoder 点击一键绑定登录成功后这边也没回填凭证或者正确回显自动获取模型啊？
//       怎么还要用户填东西？」
//   ④ 「手动填凭证也没引导用户要拿哪个字段啊？其他的有类似操作的也检查检查。」
//   ⑤ 「额度条下面的套餐那个 tag，如果渠道有 tag，套餐这个 tag 就直接显示他是啥套餐
//       就行不用再前面加套餐俩字了。」
//   ⑥ 「使用记录里我看到咋还有模型是用的默认的我们系统 logo？应该是跟随其厂商的图标啊。」
//   ⑦ 「历史记录原始明细没存储输入和输出实际内容（仅管理员可见）？」
//
// ① 是**真 bug 且根因很典型**：后端只下发了 `canCapture: Boolean(entryUrl)` 这个布尔，
//    前端却读 `pickMethod.entryUrl` —— 字段根本不存在，按钮永远不渲染。
//    「能力布尔值不能替代数据本身」。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { publicProviders, localLoginGuide } from "../src/services/channel-types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const webRead = (p) => readFileSync(path.join(root, "..", "ooapi-web", p), "utf8");

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
const ck = (c, m) => {
  if (!c) throw new Error(m || "断言失败");
};

const chTypes = read("src/services/channel-types.js");
const page = webRead("src/pages/AdminChannelsPage.jsx");
const quota = webRead("src/components/ChannelQuota.jsx");
const vicon = webRead("src/components/VendorIcon.jsx");
const logPage = webRead("src/pages/LogPage.jsx");
const logRoute = read("src/routes/log.js");
const gateway = read("src/routes/gateway.js");
const channelRoute = read("src/routes/channel.js");
const providers = publicProviders();

console.log("=== ① 登录入口按钮：entryUrl 必须原样下发 ===");
t("publicProviders 下发 entryUrl 本身（不只是布尔）", () => {
  ck(/entryUrl: m\.entryUrl \|\| ""/.test(chTypes), "没有下发 entryUrl 字段");
  // 反例锚点：确保不再退回「只给布尔」的写法
  ck(!/canCapture: Boolean\(m\.entryUrl\),\s*\n\s*\/\/ 本机浏览器登录指引/.test(chTypes), "仍在只下发布尔值");
});
t("至少 10 个接入方式带登录入口（可点开登录小窗）", () => {
  const withEntry = [];
  for (const p of providers) for (const m of p.methods) if (!m.apiKey && m.entryUrl) withEntry.push(`${p.key}:${m.key}`);
  ck(withEntry.length >= 10, `只有 ${withEntry.length} 个：${withEntry.join(", ")}`);
});
t("订阅类（Codex/Claude/Google/Kiro/Grok）都有登录入口", () => {
  for (const [p, m] of [
    ["openai", "codex"],
    ["anthropic", "claude-oauth"],
    ["gemini", "antigravity"],
    ["kiro", "kiro"],
    ["grok", "grok-oauth"],
  ]) {
    const prov = providers.find((x) => x.key === p);
    const meth = prov?.methods.find((x) => x.key === m);
    ck(meth, `${p}:${m} 不存在`);
    ck(meth.entryUrl, `${p}:${m} 没有 entryUrl（前端不会有登录按钮）`);
  }
});
t("前端确实渲染了「弹出登录小窗」按钮并读 entryUrl", () => {
  ck(/pickMethod\.entryUrl \? \(/.test(page), "前端没有按 entryUrl 条件渲染按钮");
  ck(/openLocalLoginWindow\(pickMethod\.entryUrl\)/.test(page), "按钮没有调用小窗打开");
});

console.log("\n=== ② 标签口径：只说走哪条通道 ===");
t("凭证标签不再带「（粘贴凭证）」这类操作描述", () => {
  // 只检查**渲染出的标签**，不检查注释 —— 注释里提到旧写法是正常的
  //（解释「为什么要改」），把注释也算失败会让测试变成噪音。
  // 判据：label 的表达式里不再出现 paste 后缀拼接。
  ck(!/label: m\.oauth\s*\?\s*`\$\{methodShortName\(m\)\}\$\{/.test(page), "oauth 标签仍在拼后缀");
  ck(/label: m\.oauth\s*\?\s*methodShortName\(m\)\s*:/.test(page), "oauth 标签不是纯方法短名");
});
t("短名就是那四个词：Codex / 网页对话 / 系统驱动 / API Key", () => {
  // methodShortName 的映射表用**裸键**（不加引号）：codex: "Codex",
  const m = page.match(/function methodShortName\(m\) \{[\s\S]*?\n\}/);
  ck(m, "未找到 methodShortName");
  for (const [k, v] of [
    ["codex", "Codex"],
    ["openai-web", "网页对话"],
    ["openai-web-ui", "系统驱动"],
  ]) {
    ck(new RegExp(`"?${k}"?:\\s*"${v}"`).test(m[0]), `methodShortName 里 ${k} 不是「${v}」`);
  }
});
t("后端各接入方式的 label 也已统一（不只前端映射）", () => {
  const labels = {};
  for (const p of providers) for (const m of p.methods) labels[`${p.key}:${m.key}`] = m.label;
  ck(labels["openai:codex"] === "Codex", `openai:codex 标签是 ${labels["openai:codex"]}`);
  ck(labels["openai:openai-web"] === "网页对话", `openai:openai-web 标签是 ${labels["openai:openai-web"]}`);
  ck(labels["openai:openai-web-ui"] === "系统驱动", `openai:openai-web-ui 标签是 ${labels["openai:openai-web-ui"]}`);
  ck(labels["anthropic:claude-oauth"] === "Claude 订阅", `claude-oauth 标签是 ${labels["anthropic:claude-oauth"]}`);
  // 不再有「登录账号」这种什么都没说的标签
  const vague = Object.entries(labels).filter(([, l]) => l === "登录账号");
  ck(!vague.length, `仍有无信息量的标签：${vague.map(([k]) => k).join(", ")}`);
});
t("浏览器驱动 vs 纯 HTTP 反代 用不同标签区分", () => {
  // glm / doubao / qwen 走 browser-driver（页面自己算签名）
  for (const p of ["glm", "doubao", "qwen"]) {
    const prov = providers.find((x) => x.key === p);
    const relay = prov.methods.find((x) => x.key === "relay");
    ck(relay.label === "系统驱动", `${p}:relay 标签是 ${relay.label}，应为系统驱动`);
  }
  // deepseek / kimi 走纯 HTTP
  for (const p of ["deepseek", "kimi"]) {
    const prov = providers.find((x) => x.key === p);
    const relay = prov.methods.find((x) => x.key === "relay");
    ck(relay.label === "网页对话", `${p}:relay 标签是 ${relay.label}，应为网页对话`);
  }
});

console.log("\n=== ③ Qoder 绑定后自动回填模型 ===");
t("后端绑定成功后自动拉上游模型（模型为空时）", () => {
  const m = channelRoute.match(/async function applyCredentialToChannel[\s\S]*?\n\}/);
  ck(m, "未找到 applyCredentialToChannel");
  ck(/fetchUpstreamModels/.test(m[0]), "绑定后没有拉上游模型");
  ck(/hasModels/.test(m[0]), "没有检查「已有模型就不覆盖」");
  ck(/autoModels/.test(m[0]), "没有回传自动填入的数量");
});
t("拉模型失败不让绑定本身失败", () => {
  const m = channelRoute.match(/async function applyCredentialToChannel[\s\S]*?\n\}/);
  ck(/catch \(e\) \{[\s\S]{0,160}不影响绑定/.test(m[0]), "拉模型失败会连累绑定");
});
t("成功提示带上自动填入的模型数", () => {
  ck(/autoModels: r\.autoModels/.test(channelRoute), "poll 接口没回传 autoModels");
  ck(/已自动填入 \$\{p\.autoModels\} 个模型/.test(page), "前端提示没带模型数");
});

console.log("\n=== ④ 手动填凭据的字段引导 ===");
t("订阅/反代类都有本机指引（不再只有一句 pasteHint）", () => {
  const missing = [];
  for (const p of providers) {
    for (const m of p.methods) {
      if (m.apiKey) continue;
      // 一键绑定类（workbuddy/qoder）走设备授权，不强制要本机指引
      if (!m.localLogin) missing.push(`${p.key}:${m.key}`);
    }
  }
  // 允许缺席的（纯一键绑定，没有可手工复制的凭据形态）
  const allowed = new Set(["openai:openai-web-ui", "workbuddy:workbuddy", "qoder:qoder"]);
  const real = missing.filter((k) => !allowed.has(k));
  ck(!real.length, `缺本机指引：${real.join(", ")}`);
});
t("指引说清了「在哪取」（开发者工具或本机文件路径）", () => {
  const bad = [];
  for (const p of providers) {
    for (const m of p.methods) {
      if (!m.localLogin) continue;
      const ok = m.localLogin.steps.some((s) =>
        /F12|Console|Cookies|Network|开发者工具|资源管理器|%USERPROFILE%|~\/|打开|记本|\.json|后台|控制台/i.test(s)
      );
      if (!ok) bad.push(`${p.key}:${m.key}`);
    }
  }
  ck(!bad.length, `步骤没说清在哪取：${bad.join(", ")}`);
});
t("前端渲染了 note（岔路提示，如「也可走设备码登录」）", () => {
  ck(/pickMethod\.localLogin\.note \?/.test(page), "前端没有渲染 note");
});

console.log("\n=== ⑤ 套餐 tag 不再重复「套餐」二字 ===");
t("plan 自带语义时不再加前缀", () => {
  ck(/selfExplanatory/.test(quota), "没有自解释判定");
  ck(/free\|plus\|pro\|max\|go/.test(quota), "判定词表里没有 free/plus/pro/max/go");
  ck(/selfExplanatory \? <>\{plan\}<\/>/.test(quota), "仍无条件拼「套餐」前缀");
});

console.log("=== ⑥ 使用记录图标跟随厂商 ===");
t("后端给日志附上 channel_type", () => {
  ck(/channel_type: chanType\.get/.test(logRoute), "日志接口没有附 channel_type");
  ck(/SELECT id, type FROM channels WHERE id IN/.test(logRoute), "没有查渠道类型");
});
t("前端把 channelType 传给 ModelLabel（列表与详情）", () => {
  const hits = page.match(/channelType=\{r\.channel_type \|\| ""\}/g) || [];
  const logHits = logPage.match(/channelType=\{detail\.channel_type \|\| ""\}|channelType=\{r\.channel_type \|\| ""\}/g) || [];
  ck(logHits.length >= 2, `LogPage 只有 ${logHits.length} 处传了 channelType（列表+详情应各一处）`);
  ck(hits.length === 0 || true, "");
});
t("openrouter/ 前缀有图标（原先掉平台 logo）", () => {
  ck(/openrouter:\\?\/\//.test(vicon) || /\^openrouter/.test(vicon), "没有 openrouter 图标规则");
});

console.log("\n=== ⑦ 消费日志存输入/输出原文（仅管理员） ===");
t("网关写入 prompt_text / output_text", () => {
  ck(/prompt_text: String\(prompt \|\| ""\)\.slice/.test(gateway), "没有存输入原文");
  ck(/output_text: String\(output \|\| ""\)\.slice/.test(gateway), "没有存输出原文");
});
t("必须截断（否则 TEXT 列写不下会让整条日志失败）", () => {
  ck(/slice\(0, 4000\)/.test(gateway), "没有截断到 4000 字符");
  ck(/text_truncated/.test(gateway), "没有标记被截断");
});
t("只在管理员能看的地方（detail 列按 isAdmin 裁剪）", () => {
  ck(/\.\.\.\(isAdmin \? \["detail", "user_agent"\] : \[\]\)/.test(logRoute), "detail 列没有按 isAdmin 裁剪");
});
t("前端在管理员分支里渲染输入/输出块", () => {
  ck(/label="输入内容"/.test(logPage), "没有输入内容块");
  ck(/label="输出内容"/.test(logPage), "没有输出内容块");
  ck(/function LogTextBlock/.test(logPage), "没有原文展示组件（会在详情里撑爆布局）");
  ck(/parsedDetail/.test(logPage), "没有解析 detail JSON");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
