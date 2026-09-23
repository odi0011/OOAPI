// 五个用户反馈项的回归锁
// ===========================================================================
// 用户原话：
//   ① 「deepseek 的 api 渠道的实际余额显示呢？」
//   ② 「opencode 如果是 go 渠道的额度条呢？都没做啊？」
//   ③ 「我看到有的密钥咋没绑定分组？密钥必须绑定分组，我们没有那个所谓的
//       公共，以及系统默认池，这玩意给我彻底清掉。」
//   ④ 「模型定价页面里点击同步官方价目没用啊？比如 anthropic 今天出了新模型也没同步到啊？」
//   ⑤ 「还有模型归属区域做的太模糊了我根本看不懂咋用，很反人类」
//
// ① 与 ② 的共同根因是「能查但没人去点」：额度快照只在管理员手动点「查额度」时才写库，
// 于是渠道列表的额度列永远是空的 —— 看起来就像没做。所以除了加接口，还必须加**自动刷新**。
// ② 另外是我上一轮的结论就是错的：我只探了 zen 主站的路径（全 404）就断言
// 「OpenCode 没有额度接口」，漏了 GO 套餐自己的 /zen/go/v1/usage（实测 200）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

const quota = read("src/services/upstream/quota.js");
const qref = read("src/services/quota-refresh.js");
const idx = read("src/index.js");
const tokenRoute = read("src/routes/token.js");
const pricingRoute = read("src/routes/pricing.js");
const priceSync = read("src/services/price-sync.js");
const pricingPage = webRead("src/pages/AdminPricingPage.jsx");
const tokenPage = webRead("src/pages/TokenPage.jsx");

console.log("=== ①② 额度：DeepSeek API + OpenCode GO ===");
t("DeepSeek 官方 API 走 deepseek-api 分支（原有能力保留）", () => {
  ck(/case "deepseek-api":/.test(quota), "分派里没有 deepseek-api");
  ck(/api\.deepseek\.com\/user\/balance/.test(quota), "余额端点不对");
});
t("OpenCode GO 有额度查询（我上一轮漏掉的接口）", () => {
  ck(/async function quotaOpencodeGo/.test(quota), "没有 quotaOpencodeGo");
  ck(/\/zen\/go\/v\d+\//.test(quota), "没有按 /zen/go/vN 判定 GO 套餐");
  ck(/case "opencode-go":/.test(quota), "分派里没有 opencode-go");
  ck(/usage\?\.\[name\]/.test(quota) || /j\?\.usage\?\./.test(quota), "没有读 usage 字段");
});
t("GO 的三个窗口映射成额度条（rolling/weekly/monthly）", () => {
  ck(/\brolling\b/.test(quota) && /\bweekly\b/.test(quota) && /\bmonthly\b/.test(quota), "缺窗口名");
  ck(/5 \* 3600|18000/.test(quota), "rolling 没映射成 5 小时窗口");
  ck(/7 \* 86400/.test(quota), "weekly 没映射成 7 天窗口");
});
t("quotaSupportFor 与 quotaOpencodeGo 判定一致（否则按钮能点、点了报不支持）", () => {
  const sf = quota.match(/export function quotaSupportFor[\s\S]*?\n\}/);
  ck(sf, "未找到 quotaSupportFor");
  ck(/isOpencodeGo\(channel\.base_url\)/.test(sf[0]), "quotaSupportFor 没有用 isOpencodeGo");
  ck(/function isOpencodeGo\(raw\)/.test(quota), "没有 isOpencodeGo");
  // 域名精确匹配（不能把 Key 发给第三方）
  ck(/h === "opencode\.ai" \|\| h\.endsWith\("\.opencode\.ai"\)/.test(quota), "域名判定不是精确匹配");
});
t("有自动刷新任务（不然快照永远是空的，看起来就像没做）", () => {
  ck(/export async function refreshAllQuotas/.test(qref), "没有刷新逻辑");
  ck(/export function scheduleQuotaRefresh/.test(qref), "没有调度入口");
  ck(/scheduleQuotaRefresh/.test(idx), "index.js 没有启动它");
  ck(/setInterval\(run, DEFAULT_INTERVAL_SEC \* 1000\)/.test(qref), "没有周期性调度");
});
t("额度刷新失败绝不冷却渠道（额度接口抖动 ≠ 渠道坏了）", () => {
  ck(/catch \(e\) \{[\s\S]{0,200}\[quota\]/.test(qref), "没有捕获失败");
  ck(!/markChannelError|status = 3|last_error =/.test(qref), "刷新失败写了渠道错误状态");
  ck(/status = 1/.test(qref), "没有只取启用渠道");
});

console.log("\n=== ③ 密钥必须绑定分组（彻底清掉公共池/默认池）===");
t("后端不再接受空分组", () => {
  ck(/if \(!raw \|\| raw === "default"\) return false;/.test(tokenRoute), "空分组仍被放行");
  ck(/async function validGroupBinding[\s\S]{0,600}return rows\.length > 0;/.test(tokenRoute), "校验逻辑不对");
});
t("创建与更新都拦（只拦一处会留后门）", () => {
  const calls = tokenRoute.match(/validGroupBinding\(group_name\)/g) || [];
  ck(calls.length >= 2, `validGroupBinding 只在 ${calls.length} 处被调用`);
  ck(/已取消「公共池」/.test(tokenRoute), "错误文案没说明为什么必填");
});
t("前端分组字段必填 + 文案不再提默认池", () => {
  ck(/name="group_name"[\s\S]{0,200}rules=\{\[\{ required: true/.test(tokenPage), "分组不是必填");
  ck(!/使用系统默认池/.test(tokenPage), "仍写着「使用系统默认池」");
  ck(/还没有分组，请先到「分组管理」创建一个/.test(tokenPage), "没有空态引导");
});
t("全站 UI 不再出现「公共」这个池子名", () => {
  for (const f of ["src/components/VendorIcon.jsx", "src/pages/LogPage.jsx", "src/pages/AdminChannelsPage.jsx", "src/pages/AdminGroupsPage.jsx"]) {
    const s = webRead(f);
    // 允许出现在注释里解释「已废弃」，但不允许作为**展示文案**出现
    const shown = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    ck(!/>\s*公共\s*</.test(shown), `${f} 仍把「公共」当展示文案`);
  }
  ck(!/解绑回系统默认池/.test(webRead("src/pages/AdminGroupsPage.jsx")), "分组删除提示仍提默认池");
});

console.log("\n=== ④ 同步官方价目：真的去线上取价 ===");
t("新数据源是上游接口而不是硬编码表", () => {
  ck(/openrouter\.ai\/api\/v1\/models/.test(priceSync), "没有上游价目接口");
  ck(/export async function syncUpstreamPrices/.test(priceSync), "没有同步实现");
  ck(/pricing\?*\.prompt|p\.prompt/.test(priceSync), "没有读上游价格字段");
});
t("价格单位换算正确（上游是 USD/token，平台是 OD/百万 token）", () => {
  ck(/n \* 1e6/.test(priceSync), "没有 ×1e6 换算");
});
t("默认不覆盖已有价（保住管理员手改的）", () => {
  ck(/overwrite = false/.test(priceSync), "overwrite 默认不是 false");
  ck(/if \(exists && !overwrite\) \{[\s\S]{0,80}skipped/.test(priceSync), "已有行没有被跳过");
});
t("路由与前端接的是新接口", () => {
  ck(/"\/sync-upstream"/.test(pricingRoute), "没有 /sync-upstream 路由");
  ck(/pricing\/sync-upstream/.test(pricingPage), "前端还在打旧接口");
  ck(!/pricing\/sync-defaults/.test(pricingPage), "前端仍调用只重写静态表的旧接口");
  ck(/覆盖已有价/.test(pricingPage), "没有覆盖开关（危险操作必须显式选）");
});
t("sync-defaults 保留但注释说明它不发现新模型", () => {
  ck(/"\/sync-defaults"/.test(pricingRoute), "sync-defaults 被删了（历史兼容）");
  ck(/它\*\*不会\*\*发现新模型/.test(pricingRoute), "没说明 sync-defaults 的局限");
});

console.log("\n=== ⑤ 定价体检：可操作而不是罗列内部指标 ===");
t("后端按「价格来源」分四类且各带下一步", () => {
  ck(/const SRC = \{/.test(pricingRoute), "没有来源分类");
  for (const k of ["exact", "rule", "fallback", "none"]) {
    ck(new RegExp(`${k}: \\{ key: "${k}"`).test(pricingRoute), `缺 ${k} 分类`);
  }
  ck(/action|desc:/.test(pricingRoute), "分类没有给「该怎么办」的说明");
});
t("「会被拦下」与「走兜底」分开统计（对管理员是两种事）", () => {
  ck(/counts\.fallback/.test(pricingRoute) && /counts\.none/.test(pricingRoute), "两类没有分开");
  ck(/会被直接拦下/.test(pricingRoute), "summary 没说清后果");
});
t("前端有可读的结论 + 可展开的清单 + 单条自检", () => {
  ck(/attrib\.summary/.test(pricingPage), "没有一句话结论");
  ck(/定价体检/.test(pricingPage), "没有标题");
  ck(/查一个模型/.test(pricingPage), "没有单条自检入口");
  ck(/来自定价表（你配的）/.test(pricingPage), "自检没有说清价格来源");
  ck(/怎么补价？/.test(pricingPage), "缺价时没有引导");
});
t("旧版那些内部指标不再直接甩给管理员", () => {
  // ruleCount（「归属规则 212 条」）是引擎内部指标：既不是问题、也不能操作。
  // 旧版把它摆在最显眼处，正是「看不懂咋用」的来源之一，已从接口与界面移除。
  ck(!/ruleCount:/.test(pricingRoute), "接口仍在返回裸的规则条数");
  ck(!/attrib\.ruleCount/.test(pricingPage), "界面仍在展示裸的规则条数");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
