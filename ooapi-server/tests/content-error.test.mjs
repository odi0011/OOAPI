// content-error 回归测试
// ===========================================================================
// 为什么有这个文件（Round 4 模拟用户实测暴露的真实缺陷）：
//
// content-error.js 用来识别「上游用正文说错误」（上游不返 HTTP 错误，
// 而把错误写成一整段正文）。原判据是「短回复 + 命中错误句式」——
// 但那些句式**也是用户正常提问里的常见词**，于是：
//
//   5 个人格各提 3 个常见问题，15 条里 **7 条被误判**为上游故障：
//     「余额不足是什么意思？」        → 判为"账号权限或额度不足"
//     「账号权限不足怎么办」          → 同上
//     「模型不可用的时候我该怎么做」   → 判为"模型不存在或已下线"
//     …
//   表现为：用户问这类问题**拿不到回答**，请求被当作上游故障丢弃（502/503）。
//   实测触发率约 1/170 轮（子线持续产出计费类内容时），
//   且线上真实发生过（子线生成的一段 109 字抱怨被整段判为上游错误）。
//
// 本测试把两类用例都固化下来：
//   · 误判项（正常提问/讨论）→ 必须**放行**
//   · 真错误（上游错误提示）→ 必须**识别**
// 任何一边退化都会让测试失败。
import assert from "node:assert/strict";
import { detectContentError, assertNoContentError } from "../src/services/upstream/content-error.js";

let n = 0;
const t = (name, fn) => {
  try {
    fn();
    n++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("  FAIL " + name);
    console.error("       " + e.message);
    process.exitCode = 1;
  }
};

console.log("\n=== content-error 回归测试 ===");

/* ---------------------------------------------------------------------------
   一、不得误判：用户正常提问 / 讨论这些话题，不能被当成上游故障
   （用例取自实测：五人格提问 + 子线真实触发过的那两条内容）
   --------------------------------------------------------------------------- */
const MUST_PASS = [
  // 五人格常见的正常提问（Round 4 实测的误判项）
  "余额不足是什么意思？",
  "我的额度不足，应该怎么充值？",
  "请解释一下 insufficient quota 这个报错",
  "账号权限不足怎么办",
  "这条报错的意思是权限不足吗",
  "模型不可用的时候我应该怎么做",
  "为什么我的额度不足了",
  "额度不足会影响业务吗",
  "我的余额不足了怎么办",
  // 子线真实生成过、且线上确实被误判的内容（109 字，含 insufficient quota 但出现在中段）
  "新用户额度被吃掉了 前两天注册了个号，想试 GPT-4o 新出的那档。绑卡前先送了 5 块额度，我跑了个 200 行的翻译脚本，提示 insufficient quota。翻后台流水，发现调用计费是官方价的三倍。",
  "5块额度跑半篇就没了 前天注册的号，送5块，想试下GPT-4o新档。拿个200行的中译英脚本跑，跑到一半 insufficient quota。翻后台流水才发现，计费是官方价三倍。",
  // 其它常见提问（不应因含关键词被误伤）
  "帮我写一段介绍我们产品的文案",
  "今天天气不错，我们去公园吧",
  "什么是 API 的 quota？",
  "我们团队十个人怎么分配额度",
  "这个平台的计费规则是怎么算的",
];

t("正常提问/讨论不得被判为上游错误", () => {
  const bad = MUST_PASS.filter((s) => detectContentError(s));
  assert.deepEqual(
    bad,
    [],
    "这些正常内容被误判为上游错误（会导致用户拿不到回答）：\n       · " + bad.map((s) => s.slice(0, 40)).join("\n       · ")
  );
});

t("assertNoContentError 对正常提问不抛错（适配器调用的就是这个）", () => {
  for (const s of MUST_PASS) {
    assert.doesNotThrow(() => assertNoContentError(s, "上游"), `不该抛错：${s.slice(0, 30)}`);
  }
});

/* ---------------------------------------------------------------------------
   二、必须识别：真正的上游错误提示
   （这些是上游真的会返回的内容；漏杀会让错误被当成正常回答）
   --------------------------------------------------------------------------- */
const MUST_CATCH = [
  // 线上实测抓到过的原文（Gemini 模型下线）
  "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.",
  "insufficient quota",
  "model gpt-3.5-turbo is unavailable",
  "invalid model specified",
  "permission denied",
  "Your account has been suspended. Please contact support.",
  "Your account was deactivated",
  "模型已下线，请切换新模型",
  "接口不存在，请检查模型名",
  "额度不足，请充值后重试",
  "unusual activity detected, please complete the verification",
];

t("真正的上游错误必须被识别（不得漏杀）", () => {
  const missed = MUST_CATCH.filter((s) => !detectContentError(s));
  assert.deepEqual(
    missed,
    [],
    "这些真错误未被识别（会被当成正常回答返回给用户）：\n       · " + missed.map((s) => s.slice(0, 40)).join("\n       · ")
  );
});

t("assertNoContentError 对真错误必须抛 CHANNEL_BIZ_ERROR", () => {
  for (const s of MUST_CATCH) {
    let code = "";
    try {
      assertNoContentError(s, "上游");
    } catch (e) {
      code = e.code;
    }
    assert.equal(code, "CHANNEL_BIZ_ERROR", `应抛 CHANNEL_BIZ_ERROR：${s.slice(0, 30)}`);
  }
});

/* ---------------------------------------------------------------------------
   三、边界与不变量
   --------------------------------------------------------------------------- */
t("长回复不判定（400 字上限是防误判的第一道闸）", () => {
  const long = "insufficient quota ".repeat(40); // 680 字
  assert.equal(detectContentError(long), null, "超长回复不应判定");
});

t("空内容不判定", () => {
  for (const v of ["", "   ", null, undefined]) assert.equal(detectContentError(v), null);
});

t("命中位置太靠后不判定（把「内容里提到」与「整段就是错误」区分开）", () => {
  // 前半句是正常内容，命中词出现在 60 字符之后
  const s = "我先说明一下背景，这个项目是我业余时间做的，主要用来处理一些文本翻译工作，结果它提示 insufficient quota";
  assert.equal(detectContentError(s), null, "中后段命中不应整段判错");
});

t("时态变体都要认（has been / was 曾经漏杀）", () => {
  // 这条在修复前识别不出来（原正则只认 "account is suspended"）
  assert.ok(detectContentError("Your account has been suspended."), "has been 形态应识别");
  assert.ok(detectContentError("Your account was disabled."), "was 形态应识别");
});

console.log(`\ncontent-error 回归测试：${n} 项通过` + (process.exitCode ? "（有失败项）" : ""));
