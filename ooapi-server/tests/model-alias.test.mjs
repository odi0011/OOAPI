// 模型别名归一回归（2026-09-29，用户实测）：
//   DeepSeek 官方把 V4.1-Flash 更名为 deepseek-flash，但 WorkBuddy/OpenCode 渠道
//   声明的仍是旧 id deepseek-v4.1-flash —— 用户请求任一名字都必须能路由到全部
//   三个渠道，且计费/白名单都落到规范名一行。
// 修复点：deepseek-models.js#ALIASES（旧名→规范名）、router.js#channelSupportsModel
// （精确项按归一名比较）、vendor-quirks.js#UPSTREAM_MODEL_MAP（规范名→上游旧 id）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAliasSync, canonicalModelName } from "../src/services/models.js";
import { channelSupportsModel, collectAvailableModels } from "../src/services/router.js";
import { upstreamModelOf, applyVendorRequest } from "../src/services/upstream/vendor-quirks.js";
import { warmAliasMap, modelRegistry } from "../src/services/models.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
let pass = 0;
let fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? `  ← ${extra}` : ""}`);
  }
};

import { pool } from "../src/db.js";
const savedQuery = pool.query;
pool.query = async () => [[]];
await warmAliasMap();
// 空白声明渠道走 vendorModelSet → modelRegistrySync：登记表必须先预热
await modelRegistry();
pool.query = savedQuery;

const mk = (type, models) => ({ type, models, groups: ["g"] });

console.log("=== ① 别名解析 ===");
ck("旧名 deepseek-v4.1-flash → 规范名 deepseek-flash", resolveAliasSync("deepseek-v4.1-flash") === "deepseek-flash", resolveAliasSync("deepseek-v4.1-flash"));
ck("带能力后缀同样归一", resolveAliasSync("deepseek-v4.1-flash-thinking") === "deepseek-flash", resolveAliasSync("deepseek-v4.1-flash-thinking"));
ck("规范名原样保留", resolveAliasSync("deepseek-flash") === "deepseek-flash");
ck("canonicalModelName 两名同源", canonicalModelName("deepseek-v4.1-flash") === canonicalModelName("deepseek-flash"));
ck("workbuddy/codebuddy 别名直指规范名（解析只有一跳，不能指向旧名）", resolveAliasSync("codebuddy") === "deepseek-flash" && resolveAliasSync("workbuddy") === "deepseek-flash");

console.log("\n=== ② 渠道匹配：任一名字命中任一声明方式的渠道 ===");
{
  const oldName = mk("workbuddy", "deepseek-v4.1-flash,hy4-preview-fast");
  const newName = mk("deepseek", "deepseek-flash,deepseek-v4-pro");
  const wildcard = mk("workbuddy", "");
  ck("请求新名 → 命中声明旧名的渠道", channelSupportsModel(oldName, "deepseek-flash") === true);
  ck("请求旧名 → 命中声明旧名的渠道", channelSupportsModel(oldName, "deepseek-v4.1-flash") === true);
  ck("请求新名 → 命中声明新名的渠道", channelSupportsModel(newName, "deepseek-flash") === true);
  ck("请求旧名 → 命中声明新名的渠道", channelSupportsModel(newName, "deepseek-v4.1-flash") === true);
  ck("带 thinking 后缀 → 仍命中", channelSupportsModel(oldName, "deepseek-flash-thinking") === true);
  ck("不同模型不误命中", channelSupportsModel(oldName, "deepseek-v4-pro") === false);
  ck("空白声明渠道按厂商登记表放行规范名", channelSupportsModel(wildcard, "deepseek-flash") === true, JSON.stringify({ t: wildcard.type }));
  // 通配符不受影响
  const wc = mk("deepseek", "deepseek-*");
  ck("通配 deepseek-* 照常工作", channelSupportsModel(wc, "deepseek-flash") === true && channelSupportsModel(wc, "deepseek-v4.1-flash") === true);
  // 口径一致性：collectAvailableModels 必须把两个名字都列出来（列表=可调）
  const avail = collectAvailableModels([{ models: "deepseek-v4.1-flash,hy4-preview-fast", type: "workbuddy" }]);
  ck("available 同时含旧名与新名", avail.has("deepseek-v4.1-flash") && avail.has("deepseek-flash"), JSON.stringify([...avail]));
}

console.log("\n=== ③ 上游名映射：规范名发到托管上游前翻译回旧 id ===");
{
  ck("workbuddy: deepseek-flash → deepseek-v4.1-flash", upstreamModelOf("workbuddy", "deepseek-flash") === "deepseek-v4.1-flash");
  ck("opencode: deepseek-flash → deepseek-v4.1-flash", upstreamModelOf("opencode", "deepseek-flash") === "deepseek-v4.1-flash");
  ck("旧名透传不改", upstreamModelOf("workbuddy", "deepseek-v4.1-flash") === "deepseek-v4.1-flash");
  ck("其他模型透传", upstreamModelOf("workbuddy", "glm-5.3") === "glm-5.3");
  ck("无关厂商透传", upstreamModelOf("deepseek", "deepseek-flash") === "deepseek-flash");
  const body = { model: "deepseek-flash" };
  applyVendorRequest(body, { channel: { type: "workbuddy" }, model: "deepseek-flash" });
  ck("applyVendorRequest 实际改写 body.model", body.model === "deepseek-v4.1-flash", body.model);
  // 裸名 workbuddy/codebuddy（历史别名）也要翻译到上游认识的 id
  const b2 = { model: "workbuddy" };
  applyVendorRequest(b2, { channel: { type: "workbuddy" }, model: "workbuddy" });
  ck("裸名 workbuddy 同样翻译", b2.model === "deepseek-v4.1-flash", b2.model);
}

console.log("\n=== ④ 定价归一：一份价格，两个名字 ===");
{
  const pricing = read("src/services/pricing.js");
  ck("DEFAULT_PRICES 不再有 deepseek-v4.1-flash 独立行", !/model: "deepseek-v4\.1-flash"/.test(pricing));
  ck("规范名 deepseek-flash 仍有定价", /model: "deepseek-flash"/.test(pricing));
  const wb = read("src/services/upstream/workbuddy-models.js");
  ck("workbuddy 条目标记 aliasOf（登记表/下拉不再当独立模型）", /aliasOf: "deepseek-flash"/.test(wb));
  const dm = read("src/services/upstream/deepseek-models.js");
  ck("deepseek 模块导出 ALIASES（旧名→规范名）", /"deepseek-v4\.1-flash": "deepseek-flash"/.test(dm));
}

console.log("\n=== ⑤ 站内对话与网关同一套白名单 + 旧会话模型名仍可用 ===");
{
  const { modelInAllowList } = await import("../src/services/models.js");
  // 旧逻辑 id.startsWith(l) 会把 deepseek-v4 放行成 deepseek-v4-pro；新逻辑只认精确/显式通配
  ck("精确项不再隐式前缀放行", !modelInAllowList(["deepseek-v4"], "deepseek-v4-pro"));
  ck("显式通配仍放行", modelInAllowList(["deepseek-*"], "deepseek-v4-pro"));
  ck("白名单写旧名 = 放行规范名", modelInAllowList(["deepseek-v4.1-flash"], "deepseek-flash"));
  const chat = read("src/routes/chat.js");
  ck("chat.js 密钥限制不再用 startsWith 前缀匹配", !/limits\.some\(\(l\) => id === l \|\| id\.startsWith\(l\)\)/.test(chat));
  ck("chat.js 分组/密钥限制走 modelInAllowList", /modelInAllowList\(groupModels, id\)/.test(chat) && /modelInAllowList\(limits, id\)/.test(chat));
  ck("/run 按规范名匹配会话模型（旧会话存的旧名不被拒）", /canonicalModelName\(m\.id\) === wantCanon/.test(chat));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
await import("./model-price-identity.test.mjs");
process.exit(fail ? 1 : 0);
