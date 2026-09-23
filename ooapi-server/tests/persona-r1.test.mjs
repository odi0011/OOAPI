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
import { readFileSync } from "node:fs";
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

/* ============ 语法校验（改坏一个字符就全站 500）============ */
console.log("\n=== ⑫ 改动的文件语法可解析 ===");
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
