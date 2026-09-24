// Round 1 人格测试挖出的缺陷 —— 回归锁
// ===========================================================================
// 这一批全部来自「五个模拟真人」黑盒测试，每条都有线上实测复现记录。
// 与原话的对应关系：
//
//  老张（后端老兵 zqp1a_async）：
//   · A 模型白名单前缀绕过：分组只勾了 2 个模型，`...-thinking` 却能调通并计费
//   · B Token 的 used_quota 不含站内对话（两本账对不上，差额 14 单位）
//   · C /v1/messages 不认 x-api-key（官方 Anthropic SDK 直接 401）
//   · D 报错回显的是**映射后**的模型名（写 deepseek-chat，报 deepseek-flash）
//   · E 媒体解析失败把裸 MySQL 错误吐给用户（泄露表结构）
//
//  阿强（暴躁老哥 zqp1c_strong）：
//   · A2 帖子删了图永远删不掉（引用泄漏，库内 25 条僵尸引用）
//   · A3 额度 1 单位的 Key 并发/单次都能跑完应收 24 单位的请求
//   · B1 超长内容静默截断却返回「成功」
//   · B5 8 个空格能设成密码，还能用它登录
//   · B3 并发双击点赞吞掉一次切换
//   · Infinity 型参数 → 500
//
//  安全研究者 K：
//   · 评论可伪造 reply_to_user_id 向任意用户投递通知
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

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
  if (!c) throw new Error(m);
};
// 只看**代码**，不看成句的注释：修复说明里会引用旧写法，那是解释不是实现
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const gateway = read("src/routes/gateway.js");
const gatewayCode = stripComments(gateway);
const chat = read("src/routes/chat.js");
const chatCode = stripComments(chat);
const community = read("src/routes/community.js");
const communityCode = stripComments(community);
const userjs = read("src/routes/user.js");
const mediaSvc = read("src/services/media.js");
const models = read("src/services/models.js");

/* ============ ① 模型白名单不能再被前缀绕过 ============ */
console.log("\n=== ① 白名单前缀绕过（老张 A）===");
t("白名单/密钥限制不再用隐式前缀匹配", () => {
  ck(!/model\.startsWith\(l\)/.test(gatewayCode), "gateway 还留着 model.startsWith(白名单项)");
  ck(/modelInAllowList/.test(gatewayCode), "gateway 没走共用判定");
});
t("能力后缀被归一化（-thinking 应当放行，因为它就是同一个模型）", () => {
  // canonicalModelName = modelForChannelMatch(resolveAliasSync(raw))
  ck(/modelForChannelMatch\(resolveAliasSync\(raw\)\)/.test(models), "规范名没处理能力后缀");
});
t("/v1/models 与调用用的是同一个判定（否则列表与调用会互相矛盾）", () => {
  // 源码是 CRLF：用 \r?\n，否则匹配不到
  const i = gateway.search(/router\.get\(\r?\n\s*"\/models"/);
  ck(i >= 0, "未找到 /models 处理器");
  const body = gateway.slice(i, i + 6000);
  ck(/modelInAllowList/.test(body), "/v1/models 没有走共用判定");
});
t("定价判定也认同规范名（否则别名模型会被误判成未定价）", () => {
  const pricing = read("src/services/pricing.js");
  ck(/canonicalModelName/.test(pricing), "isModelPriced 没有规范名兜底");
});
t("/v1/models 声明能力后缀（老张：「放了就得在列表里告诉我」）", () => {
  ck(/CAPABILITY_SUFFIXES/.test(gatewayCode), "没有声明能力后缀");
  ck(/-thinking/.test(gatewayCode) && /-search/.test(gatewayCode), "后缀没写全");
  // 空分组路径也要带该字段：响应形状不能因为空列表就变
  const iEmpty = gatewayCode.indexOf("if (!inGroup.length)");
  ck(iEmpty > 0, "找不到空分组分支");
  ck(/capability_suffixes: CAPABILITY_SUFFIXES/.test(gatewayCode.slice(iEmpty, iEmpty + 400)),
    "空分组分支漏了 capability_suffixes（响应形状不一致）");
});

/* ============ ② 报错回显用户请求的原始模型名 ============ */
console.log("\n=== ② 错误信息可归因（老张 D）===");
t("NO_CHANNEL 报错回显**用户写的**模型名，不是映射后的", () => {
  const router = read("src/services/router.js");
  ck(/displayModel/.test(router), "explainNoChannel 没有 displayModel 参数");
  ck(/const shown = String\(displayModel \|\| model/.test(router), "没有用 displayModel 作为回显名");
  // 三处 message 都必须用 shown
  const msgs = router.match(/支持模型「\$\{(\w+)\}」|模型「\$\{(\w+)\}」的/g) || [];
  ck(msgs.length >= 2, "没找到用变量回显的 message");
  ck(!/message: `支持模型「\$\{model\}」/.test(router), "COOLING 还在回显映射后的名字");
  ck(!/message: `当前没有可服务模型「\$\{model\}」/.test(router), "NO_MODEL 还在回显映射后的名字");
});
t("execute 把原始请求名传下去", () => {
  const exec = read("src/services/execute.js");
  ck(/explainNoChannel\(\{ model: matchName, displayModel: model/.test(exec), "没有传 displayModel: model");
});

/* ============ ③ Token 的 used_quota 必须记站内对话 ============ */
console.log("\n=== ③ 两本账对不上（老张 B）===");
t("站内对话结算时同步更新 tokens 表", () => {
  ck(/UPDATE tokens SET used_quota = used_quota \+ \?/.test(chatCode), "chat 没写 tokens.used_quota");
  ck(/remain_quota = IF\(unlimited_quota = 1, remain_quota, GREATEST\(0, remain_quota \+ \? - \?\)\)/.test(chatCode),
    "chat 没同步 remain_quota（含预占加回）");
});
t("只有在确实绑定了密钥时才写（keyId 为 0 时不能乱扣）", () => {
  ck(/if \(keyId\) \{/.test(chatCode), "没有 keyId 守卫");
});
t("站内对话也检查密钥额度（与网关 insufficient_quota 同口径）", () => {
  ck(/unlimited_quota && Number\(usableKey\.remain_quota\) <= 0/.test(chatCode),
    "站内对话没有拦「密钥额度已用尽」");
});

/* ============ ④ 令牌额度不能靠并发绕过 ============ */
console.log("\n=== ④ 密钥额度并发绕过（阿强 A3 / K）===");
t("存在共用的原子预占实现", () => {
  const tq = read("src/services/token-quota.js");
  ck(/export async function holdTokenQuota/.test(tq), "没有 holdTokenQuota");
  // 判定与扣减必须在**同一条 SQL** 里，否则并发下两个请求都能通过检查
  ck(/WHERE id = \? AND unlimited_quota = 0 AND remain_quota >= \?/.test(tq),
    "预占不是原子的（判定与扣减必须同一条 SQL）");
  ck(/remain_quota = remain_quota - \?/.test(tq), "预占没有真正扣减");
});
t("网关在发起上游调用之前预占", () => {
  const iHold = gatewayCode.indexOf("await holdTokenQuota(token)");
  const iRun = gatewayCode.indexOf("await runCompletion(");
  ck(iHold > 0, "网关没有预占");
  ck(iRun > iHold, "预占发生在调用上游之后（来不及了）");
});
t("结算时加回预占再扣实际用量（净效果 = 只扣实际）", () => {
  ck(/remain_quota \+ \? - \?/.test(gatewayCode), "网关结算没有加回预占");
  ck(/tokenQuotaHold/.test(gatewayCode), "没有把 hold 传进结算");
});
t("consume/refund 互斥（否则额度会凭空变多）", () => {
  const tq = read("src/services/token-quota.js");
  ck(/settledOrRefunded/.test(tq), "没有互斥标记");
  ck(/consume\(\)/.test(tq) && /refund\(\)/.test(tq), "缺 consume 或 refund");
});
t("站内对话同样预占（两条计费路径口径一致）", () => {
  ck(/holdTokenQuota\(usableKey\)/.test(chatCode), "chat 没有预占");
  ck(/quotaHold\?\.refund\(\)/.test(chatCode), "chat 的 finally 没有兜底退回");
  ck(/quotaHold\?\.consume\(\)/.test(chatCode), "chat 结算后没有 consume");
});
t("建 Key 时「给了额度」就当有限额度（否则用户设的额度被静默忽略）", () => {
  // 实测踩到：{remain_quota: 1} 建出来的 Key 是 unlimited（默认 true），
  // 于是并发 20 次全部通过 —— 看着像预占失效，其实是这把 Key 根本不限额。
  const tk = stripComments(read("src/routes/token.js"));
  ck(/const unlimitedVal = unlimitedGiven \? Boolean\(unlimited_quota\) : !remainGiven/.test(tk),
    "新建令牌没有按「是否给了 remain_quota」推断 unlimited");
  ck(/unlimitedVal \? 1 : 0/.test(tk), "INSERT 仍在用原始的 unlimited_quota 变量");
});

/* ============ ⑤ 官方 Anthropic SDK 要能直连 ============ */
console.log("\n=== ⑤ x-api-key（老张 C）===");
t("authorize 认 x-api-key", () => {
  ck(/req\.headers\["x-api-key"\]/.test(gatewayCode), "没有读 x-api-key");
  ck(/req\.headers\.authorization \|\| ""\)\.replace\(\/\^Bearer/.test(gatewayCode), "Authorization 解析被改坏了");
});
t("两个头同时存在时以 Authorization 为准（不合并）", () => {
  // 旧事故：同名头用 fetch 合并成逗号串 → 401。这里是显式二选一
  ck(/\|\|\s*String\(req\.headers\["x-api-key"\]/.test(gatewayCode), "不是二选一（可能拼成一个串）");
});
t("401 提示要同时给出两种方式", () => {
  ck(/x-api-key: sk-xxx/.test(gatewayCode), "缺 Key 的提示没提 x-api-key");
});

/* ============ ⑥ 引用泄漏（用户文件被永久锁死）============ */
console.log("\n=== ⑥ 引用泄漏（阿强 A2）===");
t("删帖要释放图片引用", () => {
  ck(/releaseRefs\("community_post", \[String\(id\)\]\)/.test(communityCode), "删帖没有 releaseRefs");
});
t("编辑帖子也要重算引用（移掉的图必须解绑）", () => {
  ck(/releaseRefs\("community_post", \[String\(id\)\]\)/.test(communityCode), "编辑没有释放");
  ck(/for \(const mid of mediaIds\) \{/.test(communityCode), "编辑没有重新绑定当前图片集");
});
t("隐藏（status=3，可恢复）不释放，只有软删（=2）才释放", () => {
  // 释放必须落在 DELETE 处理器里，而不是 moderate（隐藏）里
  // 源码是 CRLF，用 \r?\n
  const iDel = community.search(/router\.delete\(\r?\n\s*"\/posts\/:id"/);
  ck(iDel >= 0, "未找到 DELETE /posts/:id");
  const delBody = community.slice(iDel, iDel + 3000);
  ck(/releaseRefs/.test(delBody), "DELETE 处理器里没有释放引用");
  const iMod = community.search(/router\.post\(\r?\n\s*"\/posts\/:id\/moderate"/);
  ck(iMod >= 0, "未找到 moderate");
  const modBody = community.slice(iMod, iMod + 2000);
  ck(!/releaseRefs/.test(modBody), "隐藏帖子时不该释放引用（内容还在，可恢复）");
});

/* ============ ⑦ 评论通知不能伪造 ============ */
console.log("\n=== ⑦ 通知伪造（K）===");
t("reply_to_user_id 不接受客户端任意指定", () => {
  // 有 parent_id 时按父评论作者重算；没有 parent_id 又带了 reply_to_user_id 直接拒
  ck(/replyToUserId = Number\(parent\.user_id\) \|\| 0/.test(communityCode), "没有按父评论作者重算");
  ck(/if \(replyToUserId && !parentId\) return fail\(res, "回复目标不正确"/.test(communityCode),
    "没有拦住「无 parent_id 却指定 reply_to_user_id」");
});

/* ============ ⑧ 不再静默截断内容 ============ */
console.log("\n=== ⑧ 静默截断（阿强 B1）===");
t("超长内容返回 400，而不是截断后回「成功」", () => {
  ck(/function tooLong\(/.test(communityCode), "没有 tooLong 校验");
  const sliceTitle = /const title = String\(req\.body\?\.title \|\| ""\)\.trim\(\)\.slice\(0, MAX_TITLE\)/;
  ck(!sliceTitle.test(communityCode), "发帖仍在静默 slice 标题");
  ck(/tooLong\(titleRaw, MAX_TITLE, "标题"\)/.test(communityCode), "发帖没校验标题长度");
  ck(/tooLong\(contentRaw, MAX_CONTENT, "正文"\)/.test(communityCode), "发帖没校验正文长度");
  ck(/tooLong\(contentRaw, MAX_COMMENT, "评论"\)/.test(communityCode), "评论没校验长度");
});

/* ============ ⑨ 密码不能全是空白 ============ */
console.log("\n=== ⑨ 空格密码（阿强 B5）===");
t("修改密码与注册都拒绝全空白密码", () => {
  ck(/if \(!\/\\S\/\.test\(pwd\)\) return fail\(res, "密码不能全是空格/.test(userjs), "改密没拦空白密码");
  const auth = read("src/routes/auth.js");
  ck(/if \(!\/\\S\/\.test\(pwd\)\) return fail\(res, "密码不能全是空格/.test(auth), "注册没拦空白密码");
});
t("不 trim 密码（空格是合法字符，只是不能全是空格）", () => {
  ck(!/const pwd = String\(new_password \|\| ""\)\.trim\(\)/.test(userjs), "把密码 trim 了（会改变合法密码）");
});

/* ============ ⑩ 脏参数不再 500 ============ */
console.log("\n=== ⑩ Infinity 型参数（阿强）===");
t("查询参数过 safeInt，不再靠 `|| 0` 兜底", () => {
  // Number("Infinity") 是合法数字，`|| 0` 拦不住它
  const media = stripComments(read("src/routes/media.js"));
  ck(/safeInt\(req\.query\.user_id, \{ min: 1 \}\)/.test(media), "media 的 user_id 没过 safeInt");
  ck(/safeInt\(req\.query\.topic_id, \{ min: 1 \}\)/.test(communityCode), "community 的 topic_id 没过 safeInt");
});
t("图片宽高要钳制，不能把 MySQL 原始报错吐给用户", () => {
  ck(/const MAX_DIM = 100000/.test(mediaSvc), "没有 MAX_DIM 上限");
  ck(/function clampDim/.test(mediaSvc), "没有 clampDim");
  ck(/width: clampDim\(buf\.readUInt32BE\(16\)\)/.test(mediaSvc), "PNG 宽高没有钳制");
});

/* ============ ⑪ 编辑帖子不能指向不存在的话题 ============ */
console.log("\n=== ⑪ 话题计数漂移（K）===");
t("改话题前先确认目标话题存在且启用", () => {
  ck(/SELECT id, status FROM community_topics WHERE id = \?/.test(communityCode), "没有查目标话题");
  ck(/if \(!t\) return fail\(res, "话题不存在"\)/.test(communityCode), "没有拦不存在的话题");
  ck(/该话题已停用，无法移入/.test(communityCode), "没有拦停用话题");
});
t("隐藏/恢复帖子要同步话题计数、删除不能重复扣", () => {
  // 实测发现：批量隐藏 24 条测试帖后，「综合讨论」显示 25 帖、实际只剩 2 帖 ——
  // moderate 只改 status、不动 post_count。
  const iMod = community.search(/"\/posts\/:id\/moderate"/);
  ck(iMod >= 0, "未找到 moderate 处理器");
  const modBody = community.slice(iMod, iMod + 2500);
  ck(/countDelta/.test(modBody), "moderate 没有计算计数增减");
  ck(/post_count = GREATEST\(0, post_count \+ \?\)/.test(modBody), "moderate 没有同步 post_count");
  // 删除侧必须只在「从正常删」时减，否则删一个已隐藏的帖子会二次扣减
  ck(/if \(Number\(row\.status\) === 1\) \{[\s\S]{0,160}post_count = GREATEST\(post_count - 1, 0\)/.test(communityCode),
    "删除没有按原状态判断，隐藏后再删会重复扣减");
});

/* ============ ⑫ 注册限流不再把「第一次来的人」挡在门外 ============ */
console.log("\n=== ⑫ 注册限流（阿强：第一次点注册就 429）===");
t("成功注册不计数（只惩罚失败），并有小时级总量兜底", () => {
  const rl = read("src/middleware/ratelimit.js");
  ck(/skipSuccessful/.test(rl), "限流中间件没有 skipSuccessful 选项");
  ck(/if \(res\.statusCode >= 400\) hits\.push/.test(rl), "不是只在失败时计数");
  const auth = stripComments(read("src/routes/auth.js"));
  ck(/registerFailLimit/.test(auth), "没有失败层限流");
  ck(/registerTotalLimit/.test(auth), "没有总量层限流（放开成功计数就等于不限量）");
  ck(/registerTotalLimit,\s*\r?\n\s*registerFailLimit,/.test(auth), "两层顺序不对（总量应先判）");
});

/* ============ ⑬ 网关未实现端点返回 JSON 而不是 HTML ============ */
console.log("\n=== ⑬ /v1 未知端点（老张：HTML 错误页混在 JSON API 里）===");
t("网关兜底返回 JSON 404 并列出支持的端点", () => {
  const idx = stripComments(read("src/index.js"));
  ck(/endpoint_not_supported/.test(idx), "没有 JSON 兜底 404");
  ck(/GATEWAY_ENDPOINTS/.test(idx), "没有列出支持的端点");
  ck(/app\.use\(\["\/v1", "\/api\/v1"\]/.test(idx), "兜底没有覆盖 /v1 与 /api/v1");
});

/* ============ ⑭ 暗色空状态插画可见 ============ */
console.log("\n=== ⑭ 暗色空状态插画（Mia：对比度 1.1:1）===");
t("Empty 插画的填充 token 写在**全局**层且转成 hex", () => {
  const web = readFileSync(path.join(root, "..", "ooapi-web", "src", "theme", "ThemeContext.jsx"), "utf8");
  const presets = readFileSync(path.join(root, "..", "ooapi-web", "src", "theme", "presets.js"), "utf8");
  // ① 必须在全局 token 层：插画读的是 useToken()，写进 components.Empty 不生效
  //    （我第一版就写在那里，实测插画仍是 rgb(20,20,20)）
  //
  // 用行首锚定 `\n      components: {` 定位全局 token 块的结束 ——
  // `web.indexOf("components:")` 会先命中注释里那句 "写在 components: {...} 里不会生效"，
  // 把分界点算到 92 行（注释），于是误判「没写在全局层」。
  const compIdx = web.search(/\n\s{4,}components:\s*\{/);
  ck(compIdx > 0, "没找到 components 配置块");
  const globalPart = web.slice(0, compIdx);
  ck(/colorFill: oklchToHex\(s\.line\)/.test(globalPart),
    "colorFill 没写在全局 token 层（组件层覆盖对插画无效）");
  ck(/colorFillQuaternary: oklchToHex\(s\.field\)/.test(globalPart), "colorFillQuaternary 没写在全局层");
  // ② 必须转 hex：AntD 的颜色合成库不认 oklch，解析失败退化成纯黑
  ck(/export function oklchToHex/.test(presets), "没有 oklchToHex 转换器");
  ck(!/colorFill: s\.line\b/.test(web), "colorFill 直接给了 oklch（AntD 会算成纯黑）");
});

t("oklchToHex 转换数值正确（手算对照）", () => {
  const presets = readFileSync(path.join(root, "..", "ooapi-web", "src", "theme", "presets.js"), "utf8");
  const body = presets.match(/export function oklchToHex[\s\S]*?\n\}/)[0].replace("export function", "function");
  const fn = new Function(`${body}; return oklchToHex;`)();
  const cases = [
    ["oklch(30.8% 0.006 258.354)", "#2e3033"],
    ["oklch(27.8% 0.006 258.354)", "#27282b"],
    ["oklch(29.3% 0.006 271.223)", "#2b2c2f"],
    ["oklch(94.6% 0.003 264.542)", "#ecedef"],
  ];
  for (const [input, want] of cases) {
    ck(fn(input) === want, `${input} → ${fn(input)}（期望 ${want}）`);
  }
  ck(fn("#abcdef") === "#abcdef", "非 oklch 输入应原样返回");
});

/* ============ ⑮ 手机端触控目标 ============ */
console.log("\n=== ⑮ 触控目标（Mia：26×26 容易点错）===");
t("窄屏放大了图标按钮/分段控件/分页的命中区域", () => {
  const css = readFileSync(path.join(root, "..", "ooapi-web", "src", "styles.css"), "utf8");
  ck(/pointer: coarse/.test(css), "没有针对触屏的媒体查询");
  ck(/\.oo-header \.ant-btn \{ min-width: 40px/.test(css), "顶栏按钮没放大");
  ck(/\.ant-pagination-item/.test(css), "分页没放大");
});
t("聊天附件缩略图放大到 36px", () => {
  const css = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "beautifului.css"), "utf8");
  ck(/\.bui-chip-file img \{[\s\S]{0,90}width: 36px/.test(css), "缩略图没放大（贴多张图认不出）");
});

/* ============ ⑯ 信息流摘要不再漏 Markdown 标记 ============ */
console.log("\n=== ⑯ 摘要漏 markdown（Mia）===");
t("摘要走 summarize 剥离，而不是直接 slice 原文", () => {
  ck(/function summarize\(/.test(communityCode), "没有 summarize");
  ck(/summary: withContent \? undefined : summarize\(row\.content/.test(communityCode),
    "摘要仍在直接 slice（会漏出 ** 等标记）");
  // 常见标记逐条检查。
  // 用**字面量包含**而不是正则：这些规则本身就是带转义的正则字面量，
  // 再套一层正则去匹配极容易把转义搞错（我就先踩了一次，误报「没处理加粗」）。
  // 断言打在**未剥离注释的原文**上 —— stripComments 会把 `**` 开头的那行
  // 当成块注释起点删掉（它长得像注释）。
  // 源码里的正则是带转义字面量，所以 needle 也要带转义（`\*\*` 而不是 `**`）
  const rules = [
    ["```", "代码块"],
    ["\\*\\*([^*]+)\\*\\*", "加粗"],
    ["^#{1,6}\\s+", "标题"],
    ["^\\s*[-*+]\\s+", "列表符"],
    ["~~([^~]+)~~", "删除线"],
    ["\\|.*\\|", "表格行"],
  ];
  for (const [needle, what] of rules) {
    ck(community.includes(needle), `summarize 没处理${what}（缺 ${needle}）`);
  }
});
t("非 markdown 容器里没有裸露的 ** 强调（全站扫描）", () => {
  // 原用例只查 GameZone（小游戏规则区曾写 `**胜负由服务端判定**`，星号原样显示）。
  // 2026-09-24 小游戏模块整体下线（用户改动），改扫**所有页面与组件** ——
  // 这条约束本身与游戏无关：任何「纯文本展示区」写 markdown 语法都是 bug。
  const dirs = ["pages", "components"];
  const bad = [];
  for (const d of dirs) {
    const dir = path.join(root, "..", "ooapi-web", "src", d);
    for (const f of readdirSync(dir)) {
      if (!/\.jsx$/.test(f)) continue;
      const raw = readFileSync(path.join(dir, f), "utf8");
      // 去掉注释再判定（说明这段历史的那几行里出现 ** 是正常的）
      const code = stripComments(raw).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
      // JSX 文本节点里形如 **xxx** 的强调写法
      const hit = code.match(/>[^<>{]*\*\*[^*<>{}]+\*\*[^<>{]*</g) || [];
      if (hit.length) bad.push(`${f}: ${hit[0].trim().slice(0, 60)}`);
    }
  }
  ck(!bad.length, `有 ${bad.length} 处非 markdown 容器用 ** 强调：${bad[0]}`);
});

/* ============ ⑰ 评论带图（用户要求：评论也要能带图）============ */
console.log("\n=== ⑰ 评论附图 ===");
t("评论接受 media_ids、校验归属、写入并绑定引用", () => {
  const c = communityCode;
  // ① 建表语句带列 + 老库走列迁移（CREATE TABLE IF NOT EXISTS 不会补列）
  const db = read("src/db.js");
  ck(/media_ids TEXT COMMENT '附图 media\.id 列表/.test(db), "建表语句没有 media_ids 列");
  ck(/table: "community_comments", column: "media_ids"/.test(db), "没有列迁移（老库不会补列）");
  // ② 评论创建：校验归属 + 允许纯图
  ck(/filterOwnedMediaIds\(rawMediaIds, req\.user\.id\)/.test(c), "评论没有校验图片归属");
  ck(/请输入评论内容或添加图片/.test(c), "没有放开「纯图评论」");
  // ③ 写入并绑定引用（删评论时图才回收得掉）
  ck(/INSERT INTO community_comments \(post_id, user_id, parent_id, reply_to_user_id, content, media_ids/.test(c),
    "INSERT 没有带 media_ids");
  ck(/refType: "community_comment"/.test(c), "没有绑定 community_comment 引用");
  // ④ 读取时返回 media（**已删评论返回空数组** —— 见下一条测试的说明）
  ck(/media: deleted \? \[\] : await mediaList\(c\.media_ids\)/.test(c), "列表没返回 media（或没对已删评论做屏蔽）");
});
t("已删评论只回墓碑，不回正文与附图（防第三方客户端把删掉的内容重新显示）", () => {
  const c = communityCode;
  // 人格实测：「删掉的评论，接口照样原样吐回来，连内容都没清掉。
  // 网页端过滤了（显示灰色『已删除』），但任何拿这个接口做客户端的人
  // 会把删掉的评论原样重新显示出来。」
  ck(/const deleted = Number\(c\.status\) !== 1/.test(c), "没有识别「已删/隐藏」状态");
  ck(/content: deleted \? "" : c\.content/.test(c), "已删评论仍返回正文");
  ck(/media: deleted \? \[\] : await mediaList/.test(c), "已删评论仍返回附图（会给已删内容现签 URL）");
});
t("删除路径要释放评论附图引用（否则用户的图被永久锁死）", () => {
  const c = communityCode;
  ck(/releaseRefs\("community_comment", \[String\(id\)\]\)/.test(c), "删评论没有释放引用");
  // 删帖也要带走其评论的引用（两套 ref key，不会自动级联）
  ck(/SELECT id FROM community_comments WHERE post_id = \?/.test(c), "删帖没有查它的评论");
  ck(/releaseRefs\("community_comment", cmts\.map/.test(c), "删帖没有释放评论引用");
  // 重算里也要清僵尸（存量数据）
  ck(/r\.ref_type = 'community_comment' AND r\.is_live = 1 AND c\.status = 2/.test(c),
    "recount 没有清理评论僵尸引用");
});
t("前端：评论框有图片入口、可粘贴截图、列表渲染缩略图", () => {
  const p2 = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "PostDetailPage.jsx"), "utf8");
  ck(/pickCommentImage/.test(p2), "没有评论上传函数");
  ck(/onPaste=/.test(p2) && /clipboardData/.test(p2), "没有支持粘贴截图");
  ck(/media_ids: cMedia\.map/.test(p2), "提交时没带 media_ids");
  ck(/comment\.media/.test(p2), "一级评论没有渲染图片");
  ck(/c\.media/.test(p2), "二级评论没有渲染图片");
});

/* ============ ⑱ 多图按选择顺序入列（插画师人格实测三次）============ */
console.log("\n=== ⑱ 多图顺序 ===");
t("发帖多图按选择顺序占位，不按上传完成顺序追加", () => {
  const p2 = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "CommunityPage.jsx"), "utf8");
  // 必须有「先占位」的机制
  ck(/const addSlot = /.test(p2), "没有 addSlot（先占位再上传）");
  ck(/const fillSlot = /.test(p2), "没有 fillSlot（按槽位回填）");
  ck(/slotSeqRef/.test(p2), "没有槽位序号");
  // 关键：不能再出现「完成时直接 append」的写法（那就是错序的根因）
  ck(!/setPostMedia\(\(prev\) => \[\.\.\.prev, item\]\)/.test(p2),
    "仍在按上传完成顺序追加（setPostMedia 直接 append item）—— 顺序会错乱");
  // 上传前后必须走 addSlot/fillSlot
  ck(/const slot = addSlot\(file\.name\)/.test(p2), "Upload 路径没有先占位");
  ck(/fillSlot\(slot, item\)/.test(p2), "Upload 路径没有按槽位回填");
  // 提交前要拦住还在上传的图（否则用户以为发了 5 张实际只有 3 张）
  ck(/postMedia\.some\(\(m\) => m\.pending\)/.test(p2), "提交时没有拦住「还在上传」的图");
  ck(/filter\(\(m\) => m\.id\)\.map\(\(m\) => m\.id\)/.test(p2), "提交时没有过滤掉占位项");
});
t("粘贴插图也走同一条有序队列", () => {
  const p2 = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "CommunityPage.jsx"), "utf8");
  const blk = p2.slice(p2.indexOf("onMediaUploaded="), p2.indexOf("onMediaUploaded=") + 400);
  ck(/addSlot\(/.test(blk) && /fillSlot\(/.test(blk), "粘贴路径没走槽位队列（顺序会与手选不一致）");
});

/* ============ ⑲ Round 3 人格报告的三项（流式 usage / 通知筛选 / 好友通知）============ */
console.log("\n=== ⑲ Round 3 修复项 ===");
t("流式响应末帧要带 usage 与计费字段（两人格都报过）", () => {
  const gp = read("src/services/gateway-protocols.js");
  // OpenAI 规范：usage 在末帧、choices 为空数组
  ck(/usage: \{/.test(gp) && /prompt_tokens: settled\.promptTokens/.test(gp),
    "流式 done() 没有发 usage 帧");
  ck(/x_od_cost: settled\.od/.test(gp), "流式末帧没有 x_od_cost");
  ck(/emptyChoices \? \[\] :/.test(gp), "usage 帧没有用空 choices（会用成含空 delta 的一项）");
  ck(/\}, true\); \/\/ ← 第 4 个参数/.test(gp), "done() 里没传空 choices 标志");
});
t("通知列表的 type 筛选真的生效（原先是假的）", () => {
  const nc = read("src/services/notify-center.js");
  ck(/const wantTypes = String\(query\.type/.test(nc), "没有解析 type 参数");
  ck(/n\.type IN \(\$\{wantTypes\.map/.test(nc), "type 没有进 WHERE");
  ck(/knownTypes\.includes\(s\)/.test(nc), "没有对未知 type 做白名单（会变成查不到而不是不过滤）");
  ck(/Object\.keys\(TYPE_TEXT\)/.test(nc), "已知类型没有从 TYPE_TEXT 推导（新增类型会漏）");
});
t("好友申请/通过要落库通知（原实现只有 SSE，离线用户永远不知道）", () => {
  const f = read("src/routes/friends.js");
  const nc = read("src/services/notify-center.js");
  ck(/friend_request: "申请加你为好友"/.test(nc), "缺 friend_request 通知文案");
  ck(/friend_accept: "同意了你的好友申请"/.test(nc), "缺 friend_accept 通知文案");
  // 两处都要 notify（不能只有 SSE）
  ck(/type: "friend_request"/.test(f), "发申请时没有落库通知");
  ck(/type: "friend_accept"/.test(f), "同意申请时没有落库通知");
});
t("首页示例模型名必须是当前部署里**真能调**的（改过两次都错）", () => {
  const hp = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "HomePage.jsx"), "utf8");
  // 历史：deepseek-chat（官方停用）→ deepseek-flash（有渠道声明但那渠道不可用）→ 现在
  ck(!/const SAMPLE_MODEL = "deepseek-chat"/.test(hp), "又退回了已停用的 deepseek-chat");
  ck(!/const SAMPLE_MODEL = "deepseek-flash"/.test(hp), "又退回了实测不可用的 deepseek-flash");
  ck(/const SAMPLE_MODEL = "deepseek-v4\.1-flash"/.test(hp), "示例模型名不是实测可用的那个");
  // 且必须带「以控制台为准」的指路（否则换个部署环境又会卡住用户）
  ck(/以.{0,20}控制台.{0,30}为准|控制台 → 数据看板 → 接入信息/.test(hp), "示例旁没有指路到控制台的真实可用模型");
});

/* ============ ⑳ Round 3 后三人格 + 假人报的项 ============ */
console.log("\n=== ⑳ Round 3 后段修复项 ===");
t("编辑器不再往正文插 ![文件名](url)（同一张图显示两次）", () => {
  const rte = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "RichTextEditor.jsx"), "utf8");
  // 两个假人独立报：「传完图正文里多一行 !IMG_2043.JPG，得手动删」
  ck(!/imgMarkdown/.test(rte), "还在往正文插 markdown 图片语法（会渲染成纯文本文件名）");
  ck(/onMediaUploaded\?\.\(\{ id: res\.id/.test(rte), "没有登记附件（图片就丢了）");
  ck(/图片已添加为附件/.test(rte), "提示文案没改（仍说『已插入正文』会误导）");
});
t("图片消息不再塞「[图片]」占位文字", () => {
  const mp = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "MessagesPage.jsx"), "utf8");
  // 人格实测：「图的上面多了一行字『[图片]』，像模板没渲染完」
  // 去掉注释再判定 —— 修复说明里会引用旧写法（`doSend("image", "[图片]", …)`），
  // 那是解释不是实现，直接全文匹配会误报。
  const mpCode = mp.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  ck(!/doSend\("image", "\[图片\]"/.test(mpCode), "还在发「[图片]」占位（气泡里会和图重复显示）");
  ck(/doSend\("image", "", \[r\.id\]\)/.test(mpCode), "没有改成只发图");
});
t("对话页短会话不再强制滚到底（手机欢迎语被切）", () => {
  const cp = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "ChatPage.jsx"), "utf8");
  // 人格实测（手机 390）：「『今天，想弄清楚什么？』只露出下半截」
  ck(/el\.scrollHeight <= el\.clientHeight \+ 4/.test(cp), "没有「内容装得下就不滚」的判据");
  ck(/el\.scrollTop = 0/.test(cp), "装得下时没有归零（会把顶部内容顶出视野）");
});
t("折叠评论框的提示文字单行省略（手机上会挤成 3 行压住图标）", () => {
  const css = readFileSync(path.join(root, "..", "ooapi-web", "src", "styles.css"), "utf8");
  // 注意文件里有**两条**同名前缀规则：一条是 `.oo-comment-collapsed-bar .oo-comment-input-pill > span:first-child`
  //（只管颜色），另一条才是独立的省略规则。取最后一条。
  const marker = "\n.oo-comment-input-pill > span:first-child {";
  const blk = css.slice(css.lastIndexOf(marker), css.lastIndexOf(marker) + 400);
  ck(/white-space: nowrap/.test(blk) && /text-overflow: ellipsis/.test(blk), "提示文字没有单行省略");
  ck(/flex: 0 0 auto/.test(css.slice(css.indexOf(".oo-comment-pill-actions"), css.indexOf(".oo-comment-pill-actions") + 200)),
    "右侧图标组没有禁止收缩（会被长文案挤走）");
});
t("使用记录的令牌/分组对本人可见（不只是管理员）", () => {
  const lg = read("src/routes/log.js");
  const baseEnd = lg.indexOf("if (!isAdmin) return base;");
  const base = lg.slice(0, baseEnd);
  ck(/token_id: Number\(r\.token_id\)/.test(base), "token_id 不在 base（普通用户看不到是哪把 Key 花的）");
  ck(/token_name: r\.token_name/.test(base), "token_name 不在 base");
  ck(/group_name: r\.group_name/.test(base), "group_name 不在 base");
  // 渠道名仍必须只给管理员（上游账号身份）
  ck(!/channel_name: r\.channel_name/.test(base), "channel_name 被开放给普通用户了（会泄露上游账号身份）");
});
t("令牌对账接口在 /:id 之前声明（否则被路由吞掉）", () => {
  const tk = read("src/routes/token.js");
  const iReconcile = tk.indexOf('"/reconcile"');
  const iId = tk.indexOf('"/:id"');
  ck(iReconcile > 0, "没有 /reconcile 接口（删过密钥的账对不上）");
  ck(iId > 0 && iReconcile < iId, "/reconcile 声明在 /:id 之后，会被它吞掉（Express 按声明顺序匹配）");
});

/* ============ ㉑ Round 3 清账：把登记项做完 ============ */
console.log("\n=== ㉑ Round 3 清账 ===");
t("对话页支持粘贴截图，且与文件选择共用同一套校验", () => {
  const pb = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "PromptBar.jsx"), "utf8");
  const cp = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "ChatPage.jsx"), "utf8");
  // 人格实测：「Ctrl+V 贴图什么都不发生，而且是静默的」
  ck(/onPaste=\{/.test(pb), "PromptBar 没有 onPaste 处理");
  ck(/kind === "file"/.test(pb) && /type\.startsWith\("image\/"\)/.test(pb), "paste 没有识别图片类型");
  ck(/if \(!imgs\.length\) return/.test(pb), "paste 没有放行纯文本粘贴（会把贴代码也吃掉）");
  // 必须复用同一套校验（否则粘贴会绕过视觉能力/张数/类型检查）
  ck(/const acceptImageFiles = async \(files\)/.test(cp), "ChatPage 没有抽出共用的收图函数");
  ck(/await acceptImageFiles\(files\)/.test(cp), "pickImages 没有复用 acceptImageFiles");
  ck(/onPasteImage=\{\(files\) => acceptImageFiles\(files\)\}/.test(cp), "ChatPage 没有把粘贴接到共用函数");
});
t("顶栏头像读真实 avatar_url（不再写死默认图标）", () => {
  const ml = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "MainLayout.jsx"), "utf8");
  // 人格实测：「头像传上去了，个人设置里能看到，但侧边栏还是默认小人」
  ck(/<UserAvatar user=\{user\} size=\{24\} \/>/.test(ml), "顶栏没有用 UserAvatar");
  ck(!/<Avatar size=\{24\} icon=\{<UserOutlined \/>\}/.test(ml), "顶栏仍写死默认图标");
});
t("发图不再清空用户正在输入的文字", () => {
  const mp = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "MessagesPage.jsx"), "utf8");
  // 人格实测（阿蓝，3 次复现）：「先打好一句话，再点图片图标选图 → 输入框变空」
  ck(/const draft = input;/.test(mp), "没有保存草稿");
  ck(/setInput\(draft\)/.test(mp), "发图后没有恢复草稿");
});
t("头像上传上限与服务端一致（不再各写一个数）", () => {
  const au = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "AvatarUploader.jsx"), "utf8");
  // 人格实测：「头像弹窗说上限 20MB，媒体库页面写 10MB，不知道以哪个为准」
  ck(!/20 \* 1024 \* 1024/.test(au), "仍硬编码 20MB");
  ck(/maxUploadBytes/.test(au), "没有从服务端读上限");
  ck(/await maxUploadBytes\(\)/.test(au), "读了上限却没 await（会拿到 Promise 比较大小）");
});
t("暗色禁用态文字有显式 token（对比度 1.8:1 → 3:1+）", () => {
  const th = readFileSync(path.join(root, "..", "ooapi-web", "src", "theme", "ThemeContext.jsx"), "utf8");
  ck(/colorTextDisabled: s\.ink3/.test(th), "没有显式指定 colorTextDisabled（会落到 AntD 暗色默认的极低对比）");
});
t("令牌额度列精度自适应（0.002 不再显示成 0.00）", () => {
  const tp = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "TokenPage.jsx"), "utf8");
  ck(/odOf\(r\.remain_quota, perUnit\) < 0\.01 \? 4 : 2/.test(tp), "额度列仍是固定 2 位小数");
});
t("令牌变更留痕（禁用/启用、额度、分组）", () => {
  const tk = read("src/routes/token.js");
  ck(/const changes = \[\]/.test(tk), "PUT 处理器没有收集变更");
  ck(/状态 \$\{LABEL/.test(tk), "状态变更没记录");
  ck(/额度 \$\{Number\(cur\.remain_quota\)\}/.test(tk), "额度变更没记录");
  ck(/分组的 Key/.test(tk) || /分组 \$\{cur\.group_name/.test(tk), "分组变更没记录");
  ck(/if \(changes\.length\)/.test(tk), "没有只在有变更时才写日志（会产生噪音）");
});
t("密钥额度用尽给站内通知（系统通知要豁免「不给自己发」）", () => {
  const gw = read("src/routes/gateway.js");
  const nc = read("src/services/notify-center.js");
  ck(/token_quota_exhausted/.test(nc), "没有注册该通知类型");
  ck(/token_quota_exhausted/.test(gw), "网关没有在额度归零时发通知");
  // 关键：notify() 有「to === from 直接 return false」的守卫，
  // 而系统类通知的 actor 只能是用户自己 —— 不豁免就永远发不出去，且是静默失败
  ck(/SELF_ALLOWED/.test(nc), "没有为系统通知豁免自发送限制（会静默发不出去）");
  ck(/SELF_ALLOWED\.has\(type\)/.test(nc), "豁免集合没有被使用");
});
t("价格表有用户端只读端点，且声明在 adminRequired 之前", () => {
  const pr = read("src/routes/pricing.js");
  // 注意源码里路径单独占一行（router.get 换行后才是 "/public"），
  // 所以找「引号 + 路径」这个片段，不能拼成 router.get("/public" 去匹配。
  // **必须先去掉注释再比位置**。
  // 这段修复说明的注释里就写着 `router.use(adminRequired)` 这几个字
  //（"必须声明在 router.use(adminRequired) 之前"），indexOf 会先命中注释里的那处，
  // 于是「公开路由在前」这个事实被判成 false —— 我自己连踩两次：
  // 第一次命中 import，第二次命中注释。凡是「按源码位置断言顺序」的测试
  // 都得先把注释剥掉，否则注释一改就会误报。
  const prCode = pr.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const iPublic = prCode.indexOf('"/public"');
  const iAdmin = prCode.indexOf("router.use(adminRequired)");
  ck(iPublic > 0, "没有 /pricing/public 端点");
  ck(iAdmin > 0 && iPublic < iAdmin, "/public 声明在 adminRequired 之后（会被门禁拦住）");
  ck(/expose_pricing_to_user/.test(pr), "没有尊重后台的展示开关");
  // 前端要有页面与入口
  const web = path.join(root, "..", "ooapi-web", "src");
  ck(existsSync(path.join(web, "pages", "PricingPage.jsx")), "前端没有价格页");
  const app = readFileSync(path.join(web, "App.jsx"), "utf8");
  ck(/path="\/pricing"/.test(app), "没有挂 /pricing 路由");
  const ml = readFileSync(path.join(web, "components", "MainLayout.jsx"), "utf8");
  ck(/key: "\/pricing"/.test(ml), "侧边栏没有入口");
});
t("能力后缀的声明要写实（不再暗示一定生效）", () => {
  const gw = read("src/routes/gateway.js");
  // 人格实测：hy3/-thinking/-search 三者行为无差异；flash 加 -thinking 后 reasoning 仍为 0
  ck(/是否真开启深度思考取决于渠道/.test(gw) || /取决于渠道/.test(gw), "后缀声明没写清「取决于渠道」");
  ck(/推荐改用请求体参数/.test(gw), "没有引导用户用请求体参数");
  ck(/capability_suffixes/.test(gw), "仍要保留声明（删掉会回到「隐藏模型」那个抱怨）");
});

/* ============ ㉒ Round 3 清账（第二批）============ */
console.log("\n=== ㉒ Round 3 清账（二）===");
t("推理内容也计入 max_tokens 预算（推理模型不再超支）", () => {
  const gw = read("src/routes/gateway.js");
  // 人格实测：「gemini-3.8-flash-high max_tokens=10 → completion=85，可见内容只有 1 个字」
  ck(/let reasoningOut = ""/.test(gw), "没有单独记录推理增量");
  ck(/estimateTokens\(emitted \+ reasoningOut \+ t\) > maxOutTokens/.test(gw),
    "onReasoning 没有把推理计入预算（会绕过上限）");
  ck(/if \(outputTruncated\) return;/.test(gw), "onReasoning 没有在已截断时停止下发");
  // 计费口径：截断时按实际交付（emitted + reasoningOut），不是上游全量
  ck(/\? emitted \+ reasoningOut/.test(gw), "截断时仍按上游全量推理计费");
});
t("发帖图片按正方形缩略图渲染（长图不再撑高整行）", () => {
  const pd = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "PostDetailPage.jsx"), "utf8");
  // 人格实测：「三张图并排时中间那张高一截，整块图区被它拉长」
  // 窗口要够大：中间夹着一段说明注释（注释本身也提到 width/height，
  // 但断言必须落在**真正的 props** 上，所以取到 <Image 那一块）
  const i = pd.indexOf("post.media.map");
  const blk = pd.slice(i, pd.indexOf("</Image.PreviewGroup>", i));
  ck(/width=\{140\}/.test(blk) && /height=\{140\}/.test(blk), "帖子缩略图没有固定宽高（长图会撑高行）");
});
t("媒体库有直传入口（原先只能绕道发帖/换头像）", () => {
  const mp = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "MediaPage.jsx"), "utf8");
  ck(/uploadRef/.test(mp), "没有上传用的 file ref");
  ck(/onPickUpload/.test(mp), "没有上传处理函数");
  ck(/upload: "媒体库上传"/.test(mp), "来源标签没有对应项");
  ck(/accept="image\/\*,application\/pdf/.test(mp), "文件类型白名单没收窄（会送明显不支持的类型给后端）");
});
t("评论框有 @ 联想，且补全用用户名（昵称 @ 不生效）", () => {
  const pd = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "PostDetailPage.jsx"), "utf8");
  // 人格实测：「@ 输入时没有联想下拉」；后端 @ 解析只认 username
  ck(/oo-mention-pop/.test(pd), "没有联想下拉");
  ck(/@\$\{name\} /.test(pd), "补全没有插入 @用户名");
  ck(/chatroom\/users/.test(pd), "没有复用已有的用户搜索接口");
});
t("好友申请弹窗的字数计数器不压内容", () => {
  const mp = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "MessagesPage.jsx"), "utf8");
  const css = readFileSync(path.join(root, "..", "ooapi-web", "src", "styles.css"), "utf8");
  // 人格实测量到重叠
  ck(/oo-count-textarea/.test(mp), "没有给该文本域加避让类名");
  ck(/padding-bottom: 22px/.test(css), "没有给计数器留出底部空间");
});

/* ============ 语法校验（改坏一个字符就全站 500）============ */
console.log("\n=== ⑰ 改动的文件语法可解析 ===");
for (const f of [
  "src/routes/gateway.js",
  "src/routes/chat.js",
  "src/routes/community.js",
  "src/routes/media.js",
  "src/routes/user.js",
  "src/routes/auth.js",
  "src/services/models.js",
  "src/services/router.js",
  "src/services/pricing.js",
  "src/services/media.js",
  "src/services/token-quota.js",
  "src/services/execute.js",
]) {
  t(`${f} 语法正确`, () => {
    const r = spawnSync(process.execPath, ["--check", path.join(root, f)], { encoding: "utf8" });
    ck(r.status === 0, (r.stderr || "").split("\n").slice(0, 3).join(" "));
  });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
