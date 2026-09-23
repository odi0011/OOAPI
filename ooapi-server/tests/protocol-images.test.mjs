// 三个协议的「图片保真」回归锁
// ===========================================================================
// 黑盒测试发现的真实缺陷（P1，两个方向都错）：
//
//   ① **图片被静默丢弃**：`gateway-protocols.js` 的协议解析器把图片块压成纯文本
//      占位符（`[图片]` / 空串），图片**数据**从未交给适配器 ——
//      用 Anthropic SDK 或 Responses SDK 传图的调用方会拿到 200 +
//      一个凭空编的回答（实测模型回答"我目前看不到你发的图片"），
//      而调用方完全不知道图没送到。
//
//   ② **图片数量防护被绕过**：网关的 MAX_REMOTE_IMAGES（防外链抓取的 SSRF/DoS）
//      与 MAX_INLINE_IMAGES 都是按 `part.type === "image_url"` 计数的。
//      拍平之后一个都数不到 —— 实测 10 张外链图在 /v1/messages 上照常放行，
//      而同样的请求在 /v1/chat/completions 上会被正确拒绝。
//      同一套防护在两个入口松紧不一，等于没有。
//
// 这组测试锁住：两个协议解析后必须产出 `image_url` 分片（能被计数、能被适配器取用），
// 且文本里不再重复出现占位符。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
  if (!c) throw new Error(m || "断言失败");
};

const { PROTOCOLS, extractImagesFromAnthropicContent, extractImagesFromResponsesInput } = await import(
  "../src/services/gateway-protocols.js"
);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const byName = (n) => Object.values(PROTOCOLS).find((p) => p.name === n);

console.log("=== ① Anthropic /v1/messages：图片必须作为分片保留 ===");
t("base64 图片 → image_url 片（不是被拍平）", () => {
  const p = byName("messages");
  ck(p, "未找到 messages 协议");
  const r = p.parse({
    model: "x",
    messages: [
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
    ],
  });
  const c = r.messages[0].content;
  ck(Array.isArray(c), "content 应为分片数组（纯字符串说明图片被拍平了）");
  const img = c.find((x) => x.type === "image_url");
  ck(img, "没有 image_url 片 —— 图片会被静默丢弃");
  ck(img.image_url.url.startsWith("data:image/png;base64,"), `URL 形态不对：${String(img.image_url.url).slice(0, 40)}`);
  // 文本片里不该再有无用的占位符（数据已单独带过去）
  const txt = c.find((x) => x.type === "text");
  ck(txt && !/\[图片\]/.test(txt.text), "文本里仍有 [图片] 占位符（会与真实图片语义重复）");
});
t("外链图片 URL 原样保留（能被网关计数与抓取）", () => {
  const p = byName("messages");
  const r = p.parse({
    model: "x",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }],
  });
  const img = r.messages[0].content.find((x) => x.type === "image_url");
  ck(img && img.image_url.url === "https://example.com/a.png", "外链 URL 没有保留");
});
t("10 张外链图全部出现在分片里（防护才数得到）", () => {
  const p = byName("messages");
  const content = [{ type: "text", text: "hi" }];
  for (let i = 0; i < 10; i += 1) content.push({ type: "image", source: { type: "url", url: `https://example.com/${i}.png` } });
  const r = p.parse({ model: "x", messages: [{ role: "user", content }] });
  const n = r.messages[0].content.filter((x) => x.type === "image_url" && /^https?:/.test(x.image_url.url)).length;
  ck(n === 10, `只保留了 ${n} 张（应为 10）—— 少一张就少一道防护`);
});
t("纯文本消息的 content 仍是字符串（不给所有请求加壳）", () => {
  const p = byName("messages");
  const r = p.parse({ model: "x", messages: [{ role: "user", content: [{ type: "text", text: "只有文字" }] }] });
  ck(r.messages[0].content === "只有文字", `无图片时应保持字符串，实际：${JSON.stringify(r.messages[0].content)}`);
});

console.log("\n=== ② Responses /v1/responses：同样必须保留 ===");
t("input_image → image_url 片", () => {
  const p = byName("responses");
  ck(p, "未找到 responses 协议");
  const r = p.parse({
    model: "x",
    input: [{ role: "user", content: [{ type: "input_text", text: "描述" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }] }],
  });
  const c = r.messages[0].content;
  ck(Array.isArray(c), "content 应为分片数组");
  ck(c.some((x) => x.type === "image_url"), "没有 image_url 片 —— 图片会被静默丢弃");
});
t("10 张外链图全部保留", () => {
  const p = byName("responses");
  const content = [{ type: "input_text", text: "hi" }];
  for (let i = 0; i < 10; i += 1) content.push({ type: "input_image", image_url: `https://example.com/${i}.png` });
  const r = p.parse({ model: "x", input: [{ role: "user", content }] });
  const n = r.messages[0].content.filter((x) => x.type === "image_url").length;
  ck(n === 10, `只保留了 ${n} 张`);
});

console.log("\n=== ③ 抽取函数自身的边界 ===");
t("非数组 / 空 / 无图 都返回空数组", () => {
  ck(extractImagesFromAnthropicContent("字符串").length === 0, "字符串输入应返回空");
  ck(extractImagesFromAnthropicContent(null).length === 0, "null 应返回空");
  ck(extractImagesFromAnthropicContent([{ type: "text", text: "x" }]).length === 0, "纯文本应返回空");
  ck(extractImagesFromResponsesInput("str").length === 0, "字符串输入应返回空");
});
t("残缺 source 不产出坏分片", () => {
  ck(extractImagesFromAnthropicContent([{ type: "image", source: {} }]).length === 0, "空 source 不该产出分片");
  ck(extractImagesFromAnthropicContent([{ type: "image" }]).length === 0, "缺 source 不该产出分片");
  ck(extractImagesFromAnthropicContent([{ type: "image", source: { type: "base64" } }]).length === 0, "缺 data 不该产出分片");
});

console.log("\n=== ④ 适配器侧不会再把它变成 [object Object] ===");
t("normalizeContentToText 处理分片数组", () => {
  const src = read("src/services/upstream/content-text.js");
  ck(/Array\.isArray\(content\)/.test(src), "没有处理数组");
  ck(/part\.type === "text"/.test(src), "没有只取文本片");
  // 分片里的图片片必须返回空串（否则 imageContent 会加第二遍）
  ck(/return "";/.test(src), "没有对图片片返回空串");
});
t("openai-compat 用 normalizeContentToText 而不是 String()", () => {
  const src = read("src/services/upstream/openai-compat.js");
  ck(/normalizeContentToText\(out\[i\]\.content\)/.test(src), "openai-compat 没有用归一化函数");
  ck(!/String\(out\[i\]\.content \|\| ""\)/.test(src), "仍留着 String(content) 的旧写法");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
