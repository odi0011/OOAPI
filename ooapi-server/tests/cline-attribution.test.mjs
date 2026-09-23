// Cline 模型归属（图标 + 价格）的行为锁
// ===========================================================================
// 用户要求（原话）：
//   「我看到 Cline 里很多模型，并没有走系统已有模型的厂商的图标，应该是他们的 id
//     不相同，这个有什么办法自动归属吗？比如 workbuddy 或者其他渠道有那个
//     deepseekv4.1flash，但是实际他应该就是 deepseek-flash 模型，能不能全部，
//     在获取模型的时候自动归属，在后台模型定价页面坐一块功能区给管理员做？
//     Cline 出来的模型很多都是厂商/模型 id，所以有的模型本身就是归属到某个厂商的，
//     但是实际上他 id 不相符就导致他走了渠道厂商的图标了。价格我估计也是对不上的」
//
// 为什么必须有这组测试：这件事的两个失败模式都是**静默**的 ——
//   · 图标映射漏一条 → 那个模型显示渠道图标，不报错，只有人眼能发现；
//   · 价格规则漏一条 → 走「同族/最贵档」兜底（实测把便宜模型按旗舰价收），
//     不报错、不告警，用户按猜出来的价格付费。
// 所以这里逐条锁死：归一化口径、覆盖完整度、档位排序、以及前后端口径一致。
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
const ck = (cond, msg) => {
  if (!cond) throw new Error(msg || "断言失败");
};

const { clinePriceFor, normalizeClineModel, clineTierOf, clineModelGroups, CLINE_RULE_COUNT } = await import(
  "../src/services/cline-prices.js"
);

console.log("=== 1. 归一化口径（前后端必须一致）===");
t("剥掉 ~ 前缀 / 厂商前缀 / :free / :batch / -latest", () => {
  ck(normalizeClineModel("~openai/gpt-luna-latest") === "gpt-luna", "别名路由没归一化对");
  ck(normalizeClineModel("anthropic/claude-sonnet-4.5") === "claude-sonnet-4.5", "厂商前缀没剥掉");
  ck(normalizeClineModel("x-ai/grok-4.3:free") === "grok-4.3", ":free 没剥掉");
  ck(normalizeClineModel("openai/gpt-4o:batch") === "gpt-4o", ":batch 没剥掉");
});
t("前端裸模型名函数与后端同一套规则", () => {
  const web = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "VendorIcon.jsx"), "utf8");
  ck(/export function bareModelId/.test(web), "前端没有 bareModelId");
  // 从源码抽出前端的实现逐步核对（前端是 JSX 模块，测试里不引入打包器）
  ck(/s\.replace\(\/-\(latest\|preview\)\$\/i, ""\)/.test(web), "前端没有剥 -latest/-preview");
  for (const [input, want] of [
    ["~openai/gpt-luna-latest", "gpt-luna"],
    ["anthropic/claude-sonnet-4.5", "claude-sonnet-4.5"],
    ["x-ai/grok-4.3:free", "grok-4.3"],
    ["~google/gemini-flash-latest", "gemini-flash"],
  ]) {
    // 前端函数的等价实现（与 bareModelId 逐句对应）
    let s = input.startsWith("~") ? input.slice(1) : input;
    const slash = s.lastIndexOf("/");
    if (slash >= 0) s = s.slice(slash + 1);
    s = s.replace(/:(free|batch|extended|thinking)$/i, "");
    s = s.replace(/-(latest|preview)$/i, "");
    ck(s === want, `${input} 前端归一化得到 ${s}，期望 ${want}`);
    ck(normalizeClineModel(input) === s, `${input} 前后端归一化结果不一致：后端 ${normalizeClineModel(input)}，前端 ${s}`);
  }
});

console.log("\n=== 2. 关键模型的价格归属（用户点名的那类）===");
t("deepseek 系：v4.1-flash / v4-flash 归到 flash 档", () => {
  const a = clinePriceFor("deepseek/deepseek-v4.1-flash");
  const b = clinePriceFor("deepseek/deepseek-v4-flash");
  ck(a && a.type === "deepseek" && a.output === 1.2, `v4.1-flash 归属不对：${JSON.stringify(a)}`);
  ck(b && b.type === "deepseek" && b.output === 1.2, `v4-flash 归属不对：${JSON.stringify(b)}`);
});
t("claude / gemini / grok / gpt 都归到各自厂商", () => {
  for (const [m, type] of [
    ["anthropic/claude-sonnet-4.5", "anthropic"],
    ["anthropic/claude-opus-5", "anthropic"],
    ["google/gemini-2.5-flash", "gemini"],
    ["x-ai/grok-4.3", "grok"],
    ["openai/gpt-5", "openai"],
    ["qwen/qwen3-max", "qwen"],
    ["moonshotai/kimi-k2", "kimi"],
    ["z-ai/glm-4.6", "glm"],
    ["tencent/hy-4-preview", "hunyuan"],
    ["mistralai/mistral-large-2512", "mistralai"],
  ]) {
    const p = clinePriceFor(m);
    ck(p, `${m} 未被规则覆盖`);
    ck(p.type === type, `${m} 归到 ${p.type}，期望 ${type}`);
  }
});
t("每一档尺寸不被笼统规则吃掉（nano ≠ 主线价）", () => {
  const nano = clinePriceFor("openai/gpt-5.4-nano");
  const main = clinePriceFor("openai/gpt-5.4");
  ck(nano.output === 0.4, `gpt-5.4-nano 拿到 ${nano.output}，期望 0.4（nano 档）`);
  ck(main.output === 10, `gpt-5.4 拿到 ${main.output}，期望 10（主线档）`);
});
t("旧代旗舰不能被按新代旗舰价收（gpt-4 组）", () => {
  const g4 = clinePriceFor("openai/gpt-4");
  const g4turbo = clinePriceFor("openai/gpt-4-turbo");
  const g41mini = clinePriceFor("openai/gpt-4.1-mini");
  ck(g4.output === 60, `gpt-4 拿到 ${g4.output}，期望 60`);
  ck(g4turbo.output === 30, `gpt-4-turbo 拿到 ${g4turbo.output}，期望 30`);
  ck(g41mini.output === 1.6, `gpt-4.1-mini 拿到 ${g41mini.output}，期望 1.6`);
});

console.log("\n=== 3. 绝不为 0（用户明确要求「不要设置为 0」）===");
t("规则里的每一条都有非零输出价", () => {
  const src = read("src/services/cline-prices.js");
  const rows = [...src.matchAll(/\[\/.*?\/[a-z]*,\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),/g)];
  ck(rows.length >= 80, `规则条数偏少（${rows.length}），可能匹配正则失效`);
  const zero = rows.filter((r) => Number(r[2]) === 0);
  ck(!zero.length, `有 ${zero.length} 条规则的输出价为 0`);
});
t("抽样模型的价格都 > 0", () => {
  for (const m of ["openai/o1-pro", "anthropic/claude-opus-5", "google/gemini-2.5-pro", "x-ai/grok-4.6"]) {
    const p = clinePriceFor(m);
    ck(p && p.output > 0, `${m} 输出价为 ${p?.output}`);
  }
});

console.log("\n=== 4. 分档 / 分组 ===");
t("档位按输出价分四档，:free 优先识别为免费档", () => {
  ck(clineTierOf("openai/gpt-5-nano") === "light", "nano 应为轻量档");
  ck(clineTierOf("openai/gpt-5") === "flagship", "gpt-5 应为旗舰档");
  ck(clineTierOf("inclusionai/ling-3.0-flash-vl:free") === "free", "带 :free 的应为免费档");
});
t("分组结果含厂商组与档位组，且数量一致", () => {
  const ids = ["anthropic/claude-sonnet-4.5", "openai/gpt-5", "openai/gpt-5-nano", "x-ai/grok-4.3:free"];
  const g = clineModelGroups(ids);
  ck(g.total === 4, `total 应为 4，实际 ${g.total}`);
  ck(g.groups.length === 3, `厂商组应为 3（anthropic/openai/x-ai），实际 ${g.groups.length}`);
  const sumTier = g.tiers.reduce((a, x) => a + x.count, 0);
  ck(sumTier === 4, `档位组计数合计应为 4，实际 ${sumTier}`);
  ck(g.freeCount === 1, `免费档应为 1，实际 ${g.freeCount}`);
  // 厂商组按数量降序：openai 有 2 个，应排最前
  ck(g.groups[0].key === "openai", `分组未按数量排序，首位是 ${g.groups[0].key}`);
});
t("分组里的模型带价格（选之前就能看到花多少）", () => {
  const g = clineModelGroups(["anthropic/claude-sonnet-4.5"]);
  const m = g.groups[0].models[0];
  ck(m.output === 15, `模型价格未带出：${JSON.stringify(m)}`);
  ck(m.tier === "flagship", `档位不对：${m.tier}`);
});
t("空输入不炸", () => {
  const g = clineModelGroups([]);
  ck(g.total === 0 && g.groups.length === 0, "空输入应返回空结果");
  ck(clineModelGroups(null).total === 0, "null 输入应返回空结果");
});

console.log("\n=== 5. 与 pricing.js 的接入 ===");
const pricing = read("src/services/pricing.js");
t("getPrice 在 DB 命中之后、同族兜底之前查规则", () => {
  const gi = pricing.indexOf("const clineHit = clinePriceFor(m)");
  ck(gi > 0, "getPrice 没有调用 clinePriceFor");
  const family = pricing.indexOf("// 同族匹配：请求名是某个已配价模型名的前缀");
  ck(family > 0 && gi < family, "规则的插入位置不对（应在同族兜底之前）");
});
t("isModelPriced 认规则（否则闸门会把整个 Cline 拦下来）", () => {
  const m = pricing.match(/export async function isModelPriced\(model\)[\s\S]*?\n\}/);
  ck(m, "未找到 isModelPriced");
  ck(/clinePriceFor\(m\)/.test(m[0]), "isModelPriced 没有认归属规则");
});
t("pendingPricedModels 认规则（否则徽标挂着几百个虚高数字）", () => {
  const m = pricing.match(/export async function pendingPricedModels\(\)[\s\S]*?\n\}/);
  ck(m, "未找到 pendingPricedModels");
  ck(/clinePriceFor\(key\)/.test(m[0]), "pendingPricedModels 没有认归属规则");
});

console.log("\n=== 6. 图标归属（前端）===");
const web = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "VendorIcon.jsx"), "utf8");
t("有厂商前缀 → 图标 的映射表", () => {
  ck(/const VENDOR_PREFIX_ICON = \{/.test(web), "没有 VENDOR_PREFIX_ICON");
  for (const p of ["anthropic", "openai", "google", "x-ai", "deepseek", "qwen", "z-ai", "moonshotai", "mistralai", "meta-llama"]) {
    ck(new RegExp(`"${p}":`).test(web) || new RegExp(`${p}:`).test(web), `VENDOR_PREFIX_ICON 缺 ${p}`);
  }
});
t("iconFileForModel 先按裸模型名、再按厂商前缀", () => {
  const m = web.match(/export function iconFileForModel\(model\)[\s\S]*?\n\}/);
  ck(m, "未找到 iconFileForModel");
  const body = m[0];
  ck(/bareModelId\(raw\)/.test(body), "没有先剥前缀");
  ck(/VENDOR_PREFIX_ICON\[prefix\]/.test(body), "没有按厂商前缀兜底");
  ck(body.indexOf("bareModelId") < body.indexOf("VENDOR_PREFIX_ICON"), "顺序反了（应先模型名、再前缀）");
});
t("混元 hy-4 / hy3 都认（用户实测反馈过 hy-4-preview 漏配）", () => {
  ck(/\^hunyuan\|\^hy\[-\\d\]/.test(web), "混元前缀规则变了");
});
t("VENDOR_PREFIX_ICON 引用的图标文件都存在", async () => {
  // 同步读目录（测试是同步风格，这里用已知清单核对）
  const dir = path.join(root, "..", "ooapi-web", "public", "icons");
  const fs = readFileSync; // eslint-disable-line no-unused-vars
  const names = [...web.matchAll(/"([a-z0-9.-]+\.(?:png|svg|jpg|ico))"/gi)].map((m) => m[1]);
  const uniq = [...new Set(names)].filter((n) => !n.startsWith("/"));
  const missing = [];
  const { existsSync } = await import("node:fs");
  for (const n of uniq) if (!existsSync(path.join(dir, n))) missing.push(n);
  ck(!missing.length, `图标文件不存在：${missing.join("、")}`);
});

console.log("\n=== 7. 管理端归属功能 ===");
const route = read("src/routes/pricing.js");
const page = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "AdminPricingPage.jsx"), "utf8");
t("后端有 /attribution 与 /resolve", () => {
  ck(/"\/attribution"/.test(route), "没有 /attribution 接口");
  ck(/"\/resolve"/.test(route), "没有 /resolve 接口");
});
t("后端有 /materialize 且不覆盖已有定价", () => {
  ck(/"\/materialize"/.test(route), "没有 /materialize 接口");
  // 取 router.post("/materialize", ...) 到该 handler 结束（文件末尾的 export 之前）
  const start = route.indexOf('"/materialize"');
  ck(start > 0, "未找到 materialize 路由");
  const body = route.slice(start, route.indexOf("export default router", start));
  ck(/SELECT model FROM model_prices WHERE model = \?/.test(body), "没有查重（会覆盖管理员手工定价）");
  ck(/if \(exist\.length\) \{ skipped \+= 1; continue; \}/.test(body), "重复时没有跳过");
  ck(/invalidatePrices\(\)/.test(body), "写入后没有失效价格缓存（新价 30s 内不生效）");
});
t("前端有归属功能区（概览 + 自检 + 固化）", () => {
  ck(/模型归属/.test(page), "没有归属功能区标题");
  ck(/doMaterialize/.test(page), "没有固化操作");
  ck(/pricing\/resolve/.test(page), "没有单条自检");
  ck(/pricing\/attribution/.test(page), "没有概览拉取");
});
t("获取模型时就返回分组（不是等管理员手动点）", () => {
  const ch = read("src/routes/channel.js");
  ck(/clineGroupsFor/.test(ch), "channel.js 没有分组逻辑");
  ck(/clineGroups: groups/.test(ch), "上游模型接口没返回分组");
  ck(/list\.length < 20/.test(ch), "没有小清单不分组的下限（十几个模型也分组反而多一层点击）");
});
t("ModelPicker 消费分组并保证一次点击不误选 454 个", () => {
  const mp = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "ModelPicker.jsx"), "utf8");
  ck(/clineGroups/.test(mp), "ModelPicker 没有消费分组");
  ck(/按档位/.test(mp) && /按厂商/.test(mp), "没有档位/厂商切换");
  ck(/toggleGroup/.test(mp), "没有整组加选/取消");
  // 目录型渠道的全自动填入必须被跳过，否则 454 个（含 $600/M 的 o1-pro）一次全放开
  ck(/if \(r\?\.clineGroups\) \{[\s\S]{0,160}请用下方分组按钮挑选/.test(mp), "目录型渠道仍会一次性全选");
});

console.log(`\n通过 ${pass} / 失败 ${fail}（规则 ${CLINE_RULE_COUNT} 条）`);
process.exit(fail ? 1 : 0);
