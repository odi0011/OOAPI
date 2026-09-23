// 分组可见性 / 密钥绑定的回归锁
// ===========================================================================
// 用户实测反馈（原话）：
//   「我创建了一个分组叫 deepseek，然后创建一个密钥也叫 deepseek，然后这个分组
//     我设定只能走俩模型，但是我在外部调用 api，还是能拿到这个分组里全部渠道支持的
//     模型，并且是 21 个模型？外部调用甚至没去重自动调度？你不是检查了吗？
//     这是你检查的结果吗？你到底实机测试了么」
//   「我说了密钥必须绑定分组。如果密钥没绑定分组则直接调用的时候报错啊」
//   「还有分组如果渠道为空则直接也是调用时返回当前密钥绑定分组 xx 下无可用渠道」
//
// 三个缺陷全部在线上复现过（用他的「DeepSeek」分组实测）：
//   · /v1/models 直接 SELECT * FROM channels WHERE status=1，完全没按分组过滤
//     → 限 2 个模型的分组看到 21 个（含它根本调不了的）
//   · 输出没过 id 去重 → deepseek-v4-pro / glm-5.3 / gpt-5.6-luna 各出现 3 次
//   · 未绑分组的密钥仍可调用，且没有专门的「分组无渠道」提示
//
// 这组测试锁的是**三处判定必须一致**（/v1/models、selectChannels、explainNoChannel）——
// 只要有一处漂移，就会出现「列表说能调、调用说不能」这类自相矛盾的结果。
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

const gateway = read("src/routes/gateway.js");
const router = read("src/services/router.js");
const tokenPage = webRead("src/pages/TokenPage.jsx");

// 抽取 /models 处理器源码（按索引切片，避开 CRLF/LF 差异）
function modelsHandler() {
  const i = gateway.indexOf('"/models",');
  if (i < 0) return "";
  const j = gateway.indexOf('async function authorize(', i);
  return gateway.slice(i, j > 0 ? j : i + 4000);
}

console.log("=== ① /v1/models 必须按分组过滤 ===");
t("接口取的是分组名（而不是无脑列全部渠道）", () => {
  const body = modelsHandler();
  ck(body, "未找到 /models 处理器");
  ck(/displayGroupName\(token\?\.group_name/.test(body), "没有取密钥的分组名");
  ck(/channelInGroup\(rowToChannel\(r\), groupName\)/.test(body), "没有用 channelInGroup 过滤渠道");
  // 反例锚点：确认不再出现「直接拿全部启用渠道」的旧写法
  ck(
    !/const \[rows\] = await pool\.query\("SELECT \* FROM channels WHERE status = 1"\);\s*const available = collectAvailableModels\(rows\);/.test(body),
    "仍在把全部渠道喂给 collectAvailableModels"
  );
});
t("分组白名单（group_config.models）参与过滤", () => {
  const body = modelsHandler();
  ck(body, "未找到 /models 处理器");
  ck(/groupConfigOf\(groupName\)/.test(body), "没有读分组配置");
  ck(/allowedByGroup/.test(body), "没有按白名单过滤");
  ck(/endsWith\("\*"\)/.test(body), "没有支持通配（glm-* 这种写法）");
});
t("输出按 id 去重（真实模型优先于兼容别名）", () => {
  const body = modelsHandler();
  ck(body, "未找到 /models 处理器");
  ck(/const seen = new Map\(\)/.test(body), "没有去重");
  ck(/prev\.aliasOf && !m\.aliasOf/.test(body), "去重时没有优先保留真实模型");
  ck(/\[\.\.\.seen\.values\(\)\]/.test(body), "没有用去重后的集合输出");
});

console.log("\n=== ② 密钥未绑分组：调用时报错 ===");
t("authorize 里拦空分组（不只是前端必填）", () => {
  const m = gateway.match(/async function authorize\(req, res\)[\s\S]*?\n\}/);
  ck(m, "未找到 authorize");
  ck(/token_group_required/.test(m[0]), "没有专门的错误码");
  ck(/String\(token\.group_name \|\| ""\)\.trim\(\)/.test(m[0]), "没有判空分组");
  ck(/令牌管理/.test(m[0]), "错误信息没有告诉用户去哪里修");
});
t("拦截位置在鉴权阶段（早于任何计费/调度）", () => {
  const auth = gateway.indexOf("async function authorize(");
  const settle = gateway.indexOf("async function settle(");
  ck(auth > 0 && settle > auth, "authorize 应在 settle 之前定义");
  const groupCheck = gateway.indexOf("token_group_required");
  const quotaCharge = gateway.indexOf("UPDATE users SET quota = quota - ?");
  ck(groupCheck > 0 && groupCheck < quotaCharge, "空分组检查必须在扣费之前");
});
t("前端令牌页把「未绑定」标成不可用（而不是一个装饰性的 —）", () => {
  ck(/未绑定 · 不可用/.test(tokenPage), "列里没有标出不可用");
  ck(/调用会被拒绝（403）/.test(tokenPage), "没有说明后果");
});

console.log("\n=== ③ 分组无渠道：专门的提示 ===");
t("explainNoChannel 有 GROUP_EMPTY 分支", () => {
  const m = router.match(/export async function explainNoChannel[\s\S]*?\n\}/);
  ck(m, "未找到 explainNoChannel");
  ck(/GROUP_EMPTY/.test(m[0]), "没有 GROUP_EMPTY 原因码");
  ck(/分组「\$\{groupName\}」下没有可用渠道/.test(m[0]), "文案没有点名是哪个分组");
});
t("判定顺序正确（先判分组空、再判模型/冷却）", () => {
  const m = router.match(/export async function explainNoChannel[\s\S]*?\n\}/);
  const gi = m[0].indexOf("GROUP_EMPTY");
  const ci = m[0].indexOf('reason: "COOLING"');
  ck(gi > 0 && ci > 0 && gi < ci, "GROUP_EMPTY 应排在 COOLING 之前（分组都没渠道时不该谈冷却）");
});

console.log("\n=== ④ 三处判定必须一致（否则列表与调用自相矛盾）===");
t("都用 channelInGroup 做分组归属判定", () => {
  // selectChannels
  const sc = router.match(/export async function selectChannels[\s\S]*?\n\}/);
  ck(sc && /channelInGroup\(c, groupName\)/.test(sc[0]), "selectChannels 没用 channelInGroup");
  // explainNoChannel
  const en = router.match(/export async function explainNoChannel[\s\S]*?\n\}/);
  ck(en && /channelInGroup\(c, groupName\)/.test(en[0]), "explainNoChannel 没用 channelInGroup");
  // /v1/models
  ck(/channelInGroup\(rowToChannel\(r\), groupName\)/.test(gateway), "/v1/models 没用 channelInGroup");
});
t("分组模型白名单的匹配规则三处一致（支持精确 + 前缀通配）", () => {
  // selectChannels 与 explainNoChannel 各写了一份匹配，语义必须相同
  const sc = router.match(/export async function selectChannels[\s\S]*?\n\}/)[0];
  const en = router.match(/export async function explainNoChannel[\s\S]*?\n\}/)[0];
  for (const [name, body] of [["selectChannels", sc], ["explainNoChannel", en]]) {
    ck(/endsWith\("\*"\)/.test(body), `${name} 没有处理通配`);
    ck(/startsWith\(/.test(body), `${name} 没有做前缀匹配`);
  }
  ck(/endsWith\("\*"\)/.test(gateway), "/v1/models 没有处理通配");
});

console.log("\n=== ⑤ 图片上限（用户实测抱怨过）===");
t("内联与外链分开限（不是一律 3 张）", () => {
  ck(/MAX_REMOTE_IMAGES/.test(gateway) && /MAX_INLINE_IMAGES/.test(gateway), "没有分开的两个上限");
  const rm = Number((gateway.match(/const MAX_REMOTE_IMAGES = (\d+)/) || [])[1]);
  const im = Number((gateway.match(/const MAX_INLINE_IMAGES = (\d+)/) || [])[1]);
  ck(im > 3, `内联上限是 ${im}，用户贴 4 张截图仍会被拒`);
  ck(im > rm, `内联(${im})应比外链(${rm})宽松：外链才是 DoS 面`);
});
t("超限走协议层标准错误，而不是伪造模型回复", () => {
  ck(/protocol\.error\(res, 400, \{/.test(gateway), "没有用协议层错误");
  ck(/too_many_remote_images/.test(gateway), "外链超限没有错误码");
  ck(/too_many_images/.test(gateway), "内联超限没有错误码");
  // 反例锚点：那句伪装成模型回复的通知必须消失
  ck(!/protocol\.delta\(st, notice\)/.test(gateway), "仍在把错误伪装成模型输出");
  ck(!/content: notice/.test(gateway), "仍在把错误当作模型回复返回");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
