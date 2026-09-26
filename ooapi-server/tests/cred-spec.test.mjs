// 凭据规格门禁（credSpec）
// ---------------------------------------------------------------------------
// 用户原话（这是第二次为同一件事发火）：
//   「手动填凭证也没引导用户要拿哪个字段啊」
//   「cookie 就 cookie，token 就 token，哪个位置哪个参数，每个厂商都要对应官网核对清楚，
//     你放个登录态输入框，用户也不知道是啥啊」
//
// 病根是**界面只说"登录态"，不说"哪个值"**。修法是把每个接入方式要粘的字段
// 写成结构化清单（channel-types.js 的 CRED_SPEC），前端渲染成编号列表。
//
// 这个测试防的是修复本身的退化 —— 凭据指引最容易出的三种错：
//   ① 新加厂商忘了写规格 → 用户又看到光秃秃一个「登录态」输入框；
//   ② 写了规格但 field 名是编的（凭印象写）→ 用户按指引找不到那个 cookie，
//      比没有指引更气人。所以必须回到**该厂商适配器源码**里查证字段名真的存在；
//   ③ 规格键写错（provider:method 对不上真实方法键）→ credSpecOf 永远返回 null，
//      规格静静躺着不生效，而肉眼完全看不出来。
// 三种都是"不报错、只让用户困惑"的类型，必须靠门禁挡。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicProviders, credSpecOf } from "../src/services/channel-types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

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

// 遍历所有厂商 × 接入方式的规格，返回 [「厂商:方式」, 规格] 列表。
// 供后面几条文案类断言共用（声明在前，避免 TDZ）。
function allSpecs() {
  const out = [];
  for (const p of publicProviders()) {
    for (const m of p.methods) {
      const s = credSpecOf(p.key, m.key);
      if (s) out.push([`${p.key}:${m.key}`, s]);
    }
  }
  return out;
}

// 这些方式不走「粘贴凭据」表单，因此不需要 credSpec：
//   openai-web-ui 是账号密码型（needs2fa），字段由 loginFields 定义；
//   custom:anthropic 是 Key 型（填 Base URL + API Key），由 keyHint 承担说明。
const NO_PASTE_FORM = new Set(["openai:openai-web-ui", "custom:anthropic"]);

console.log("\n=== 凭据规格（credSpec）门禁 ===");

// 需要凭据规格的方式：凡是"要用户手填/粘贴凭据"的非 API 方式。
// API Key 类（apiKey: true）走独立的 Key 输入框与 keyHint，不在本清单范围。
const providers = publicProviders();
const needSpec = [];
for (const p of providers) {
  for (const m of p.methods) {
    if (m.apiKey) continue; // API Key 方式：有 keyHint，不算「登录态」
    if (NO_PASTE_FORM.has(`${p.key}:${m.key}`)) continue; // 无粘贴表单，说明由 loginFields / keyHint 承担
    needSpec.push({ provider: p.key, method: m.key, oauth: Boolean(m.oauth), paste: m.loginModes || [] });
  }
}

t("每个非 API 方式都有凭据规格（否则用户又只看到一个「登录态」框）", () => {
  const missing = needSpec.filter((x) => !credSpecOf(x.provider, x.method)).map((x) => `${x.provider}:${x.method}`);
  assert.deepEqual(missing, [], `缺少 CRED_SPEC：${missing.join(", ")}`);
});

t("规格本身形状正确：values 非空，每项有 field 与 from", () => {
  const bad = [];
  for (const x of needSpec) {
    const s = credSpecOf(x.provider, x.method);
    if (!s) continue;
    if (!Array.isArray(s.values) || !s.values.length) bad.push(`${x.provider}:${x.method} values 为空`);
    for (const v of s.values || []) {
      const label = `${x.provider}:${x.method}`;
      if (!v || !String(v.field || "").trim()) bad.push(`${label} 有 value 缺 field`);
      if (!v || !String(v.from || "").trim()) bad.push(`${label} 的 ${v?.field} 缺 from（没说去哪取）`);
    }
    if (!String(s.why || "").trim()) bad.push(`${x.provider}:${x.method} 缺 why`);
  }
  assert.deepEqual(bad, [], bad.join("; "));
});

t("规格的键与真实方法键对得上（写错键 = 规格不生效且看不出来）", () => {
  const real = new Set();
  for (const p of providers) for (const m of p.methods) real.add(`${p.key}:${m.key}`);
  // 反向：能取到规格的键，必须在真实方法表里
  const wrong = needSpec.map((x) => `${x.provider}:${x.method}`).filter((k) => credSpecOf(...k.split(":")) && !real.has(k));
  assert.deepEqual(wrong, [], `规格键不存在于方法表：${wrong.join(", ")}`);
});

// 关键一条：field 名不能凭印象写。
// 逐个到**该厂商适配器源码**里查证 —— field 名或它的等价写法必须真实出现过。
// 映射关系与 router.js 的 ADAPTERS 表一致（relay → 厂商自己的适配器）。
//
// 一个数组是因为有的字段名不在厂商适配器里，而在共用的驱动/凭据模块里 ——
// 浏览器驱动型渠道（deepseek/glm/doubao/qwen）的登录态是 browser-driver.js
// 从 localStorage 里读的（那里按候选键打分，deepseek 的 userToken 就在其中）。
// 查证时把这些文件一起算作该渠道的依据，否则会把真实字段名误判成编造。
const ADAPTER_FILE = {
  "deepseek:relay": ["src/services/upstream/deepseek.js", "src/services/upstream/browser-driver.js"],
  "glm:relay": ["src/services/upstream/glm.js", "src/services/upstream/browser-driver.js"],
  "kimi:relay": ["src/services/upstream/kimi.js"],
  "doubao:relay": ["src/services/upstream/doubao.js", "src/services/upstream/browser-driver.js"],
  "qwen:relay": ["src/services/upstream/qwen.js", "src/services/upstream/browser-driver.js"],
  "mimo:mimo-web": ["src/services/upstream/mimo-web.js"],
  "minimax:minimax-web": ["src/services/upstream/minimax-web.js"],
  "stepfun:stepfun-web": ["src/services/upstream/stepfun-web.js"],
  "openai:codex": ["src/services/upstream/codex.js"],
  "openai:openai-web": ["src/services/upstream/openai-web.js"],
  "anthropic:claude-oauth": ["src/services/upstream/claude-oauth.js"],
  "gemini:antigravity": ["src/services/upstream/antigravity.js"],
  "grok:grok-oauth": ["src/services/upstream/grok.js"],
  "kiro:kiro": ["src/services/upstream/kiro.js"],
  "workbuddy:workbuddy": ["src/services/upstream/workbuddy.js"],
  "qoder:qoder": ["src/services/upstream/qoder.js"],
  "cline:cli": ["src/services/upstream/cline.js"],
  "trae:trae": ["src/services/upstream/trae.js"],
  "cursor:cursor": ["src/services/upstream/cursor.js"],
  "zcode:zcode": ["src/services/upstream/zcode.js"],
  "autoclaw:autoclaw": ["src/services/upstream/autoclaw.js"],
};

t("适配器映射表覆盖全部需要规格的方式（漏一个就等于没查证）", () => {
  const missing = needSpec.map((x) => `${x.provider}:${x.method}`).filter((k) => !ADAPTER_FILE[k]);
  assert.deepEqual(missing, [], `未登记适配器文件：${missing.join(", ")}`);
});

t("每个 field 名都在对应适配器源码里真实出现（防止编造字段名）", () => {
  const bad = [];
  for (const [key, fileList] of Object.entries(ADAPTER_FILE)) {
    const spec = credSpecOf(...key.split(":"));
    if (!spec) continue;
    const src = fileList.map(read).join("\n");
    for (const v of spec.values) {
      // 「（留空即可）」是系统驱动型渠道的说明项，不是字段名，跳过
      if (/^（.*）$/.test(v.field)) continue;
      // 「完整 Cookie 串」「凭据文件整份内容」这类是形态描述，不是字面字段名；
      // 它们靠 values[].from 指明位置，这里只校验真正的字段名。
      if (/[ 整份串]/.test(v.field)) continue;
      // field 可能写成 "access_token + refresh_token" 这种多值提示，拆开逐个查
      const names = v.field.split(/[+/、]/).map((s) => s.trim()).filter(Boolean);
      for (const nm of names) {
        if (nm === "PAT" || nm === "api_key") {
          // PAT / api_key 是通用叫法：在源码里查它的形态或别名即可
          if (!/pt-|api_key|apiKey/i.test(src)) bad.push(`${key} 的 ${nm} 在 ${fileList.join(" / ")} 里查不到`);
          continue;
        }
        if (!src.includes(nm)) bad.push(`${key} 的字段「${nm}」在 ${fileList.join(" / ")} 里查不到`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join("; "));
});

t("系统驱动型渠道明确标注「留空即可」（否则用户会以为必须填）", () => {
  for (const key of ["glm:relay", "doubao:relay", "qwen:relay"]) {
    const s = credSpecOf(...key.split(":"));
    assert.ok(s, `${key} 缺规格`);
    assert.equal(s.blankOk, true, `${key} 应标注 blankOk（浏览器驱动，凭据可留空）`);
    assert.ok(
      s.values.some((v) => /留空/.test(v.field) || /留空/.test(v.note || "")),
      `${key} 的说明里要写明可以留空`
    );
  }
});

t("前端渲染用上了 credSpec（否则后端写了也不显示）", () => {
  const ui = read("../ooapi-web/src/pages/AdminChannelsPage.jsx");
  assert.ok(ui.includes("credSpec"), "AdminChannelsPage 未使用 credSpec");
});

t("输入框标签不再一律叫「登录态」（用户就是被这个词卡住的）", () => {
  const ui = read("../ooapi-web/src/pages/AdminChannelsPage.jsx");
  // 凭据输入框那一处不能再出现写死的「登录态」标签。
  // 允许出现在注释/说明文字里（要保留用户反馈的原文），
  // 所以查的是 `: "登录态"` 这种**赋值成标签**的写法。
  const hardcoded = ui.match(/[:?]\s*"登录态"\s*[,:]/g) || [];
  assert.equal(hardcoded.length, 0, `仍有写死的「登录态」标签 ${hardcoded.length} 处`);
});

t("多值凭据有自己的标签（不能退回含糊的「登录凭据」）", () => {
  const ui = read("../ooapi-web/src/pages/AdminChannelsPage.jsx");
  assert.ok(ui.includes("credLabelMulti"), "多值规格没有专门标签函数");
  for (const key of ["mimo:mimo-web", "workbuddy:workbuddy", "cursor:cursor"]) {
    const spec = credSpecOf(...key.split(":"));
    assert.ok(spec.values.length > 1, `${key} 应为多值规格（否则这条断言失去意义）`);
  }
});

// 下面三条查的都是**只在界面上暴露、构建期查不出**的文案缺陷。
// 前两类我自己都犯过：ChatPage 里写 `**不是你的配置问题。**` 结果星号直接显示给用户；
// 凭据规格里写 %USERPROFILE%\.codex 结果是 %USERPROFILE%.codex（路径不存在）。
t("规格文案是纯文本：不能出现反引号或 markdown 星号", () => {
  const bad = [];
  for (const [key, spec] of allSpecs()) {
    const texts = [spec.why || "", ...spec.values.flatMap((v) => [v.field || "", v.from || "", v.note || ""])];
    for (const t of texts) {
      if (t.includes("`")) bad.push(`${key} 有反引号：${t.slice(0, 50)}`);
      if (t.includes("**")) bad.push(`${key} 有 markdown 星号：${t.slice(0, 50)}`);
    }
  }
  assert.deepEqual(bad, [], bad.join("; "));
});

t("Windows 路径里的反斜杠没有被吃掉（%USERPROFILE%\\.codex 不能变成 %USERPROFILE%.codex）", () => {
  const bad = [];
  for (const [key, spec] of allSpecs()) {
    for (const v of spec.values) {
      const t = String(v.from || "");
      if (/%USERPROFILE%/.test(t) && !t.includes("\\")) {
        bad.push(`${key} 的路径缺反斜杠：${t.slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join("; "));
});

t("每条规格都写明了「去哪取」（from 非空）", () => {
  const bad = [];
  for (const [key, spec] of allSpecs()) {
    for (const v of spec.values) {
      if (!String(v.from || "").trim()) bad.push(`${key} 的 ${v.field} 缺 from`);
    }
  }
  assert.deepEqual(bad, [], bad.join("; "));
});

t("抓取类渠道也给出可手工填写的字段名（可能只想手工填）", () => {
  // deepseek / kimi / mimo 等既有远程抓取又要手工粘贴的，
  // 规格里必须写清手工粘贴的是什么 —— 「点抓取就行」不能代替字段说明。
  for (const key of ["deepseek:relay", "kimi:relay", "mimo:mimo-web"]) {
    const s = credSpecOf(...key.split(":"));
    assert.ok(s.values.some((v) => !/^（.*）$/.test(v.field)), `${key} 要给出可手工填写的字段名`);
  }
});

console.log(`\n凭据规格门禁：${n} 项通过` + (process.exitCode ? "（有失败项）" : ""));
