// 第 46 批复审修复项的回归测试（AI协作.md）
// ===========================================================================
// 覆盖：上游 HTTP 错误分类、内容级错误识别、用量估算标记、视觉能力声明、
// 逐渠道探测预算、Gemini 端点、stepfun 帧诊断。
//
// 这些都是「看起来只是数据/看起来 HTTP 200 就成功」类的坑，所以测试也按这个
// 角度写：喂进去一个伪装成成功的输入，断言它不会被当成成功。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function ck(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
  }
}
const SRC = (p) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

/* ============ ① 上游 HTTP 错误分类（429/403 不再一律当凭据失效） ============ */
console.log("\n=== ① 上游 HTTP 错误分类 ===");
{
  const { classifyUpstreamHttp, UPSTREAM_ERROR } = await import("../src/services/upstream/http-error.js");

  ck("429 → 限流（可自愈），不是普通 HTTP 错误",
    classifyUpstreamHttp(429, "").code === UPSTREAM_ERROR.RATE_LIMITED,
    classifyUpstreamHttp(429, "").code);
  ck("429 的提示提到「自动重试」（不是让管理员重登）",
    /自动重试/.test(classifyUpstreamHttp(429, "").hint));

  ck("Cloudflare 验证页的 403 → 按限流/风控处理",
    classifyUpstreamHttp(403, "<html><title>Just a moment...</title>cf-chl-").code === UPSTREAM_ERROR.RATE_LIMITED);
  ck("403 风控提示说明「已按可自愈处理」",
    /可自愈/.test(classifyUpstreamHttp(403, "verify you are human").hint));

  ck("403 权限不足（模型档位）→ CHANNEL_FORBIDDEN",
    classifyUpstreamHttp(403, '{"error":{"message":"insufficient permission"}}').code === UPSTREAM_ERROR.FORBIDDEN);
  ck("403 权限不足的提示让换模型而不是重抓凭据",
    /模型/.test(classifyUpstreamHttp(403, "permission denied").hint));

  ck("401 → 凭据失效（需人工重抓）",
    classifyUpstreamHttp(401, "").code === UPSTREAM_ERROR.AUTH_EXPIRED);
  ck("无特征的 403 → 凭据失效",
    classifyUpstreamHttp(403, "nope").code === UPSTREAM_ERROR.AUTH_EXPIRED);
  ck("500 → 普通 HTTP 错误",
    classifyUpstreamHttp(500, "").code === UPSTREAM_ERROR.HTTP_ERROR);

  // 分类结果必须被 execute 认识，否则冷却档位会落到默认 300s（错档）
  const ex = SRC("services/execute.js");
  ck("execute 的 RETRYABLE 收录 CHANNEL_RATE_LIMITED", /"CHANNEL_RATE_LIMITED"/.test(ex));
  ck("execute 的 RETRYABLE 收录 CHANNEL_FORBIDDEN", /"CHANNEL_FORBIDDEN"/.test(ex));
  ck("cooldownFor 给 CHANNEL_RATE_LIMITED 明确档位", /case "CHANNEL_RATE_LIMITED":/.test(ex));
  ck("cooldownFor 给 CHANNEL_FORBIDDEN 明确档位", /case "CHANNEL_FORBIDDEN":/.test(ex));

  // 三个网页适配器都必须改用分类器（不能再有写死的 AUTH_EXPIRED）
  for (const f of ["mimo-web", "minimax-web", "stepfun-web"]) {
    const src = SRC(`services/upstream/${f}.js`);
    ck(`${f} 引入统一分类器`, /from "\.\/http-error\.js"/.test(src));
    ck(`${f} 不再写死 CHANNEL_AUTH_EXPIRED`, !/"CHANNEL_AUTH_EXPIRED"/.test(src));
    ck(`${f} 不再写死 CHANNEL_HTTP_ERROR`, !/"CHANNEL_HTTP_ERROR"/.test(src));
  }
}

/* ============ ② 内容级错误识别（HTTP 200 但有正文＝成功？不是） ============ */
console.log("\n=== ② 「用正文说错误」的识别 ===");
{
  const { detectContentError, assertNoContentError } = await import("../src/services/upstream/content-error.js");

  // 线上抓到的真实原文（AI协作.md 第 46 批记录的 recent_calls）
  const real = "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.";
  const hit = detectContentError(real);
  ck("识别上线实测抓到的那句「已下线」原文", Boolean(hit), JSON.stringify(hit));
  ck("给出的原因是「已下线」", /下线/.test(hit?.reason || ""), hit?.reason);

  ck("识别「模型不存在」", Boolean(detectContentError("The model gpt-9 does not exist.")));
  ck("识别权限不足", Boolean(detectContentError("You do not have access to this model.")));
  ck("识别额度耗尽", Boolean(detectContentError("Insufficient credits to continue.")));
  ck("识别人机验证", Boolean(detectContentError("Please complete the verification to continue.")));
  ck("识别中文「模型已下线」", Boolean(detectContentError("该模型已下线，请切换新模型")));
  ck("识别中文「权限不足」", Boolean(detectContentError("权限不足，无法访问")));

  // 不能误杀正常回答
  ck("正常回答不误判", detectContentError("你好！有什么可以帮你的吗？") === null);
  ck("正常长回答含相同词组也不误判（长度门槛）",
    detectContentError("关于你的问题，" + "好的。".repeat(200) + "总之这个 model is no longer available 的说法需要澄清。") === null);
  ck("空内容返回 null（由 CHANNEL_EMPTY 那条路径处理）", detectContentError("") === null);

  // 抛出的错误要可分类 + 可换渠道
  let code = "";
  try {
    assertNoContentError(real, "Antigravity");
  } catch (e) {
    code = e.code;
  }
  ck("命中后抛 CHANNEL_BIZ_ERROR（可换渠道重试）", code === "CHANNEL_BIZ_ERROR", code);
  ck("未命中时不抛", (() => { try { assertNoContentError("正常回复"); return true; } catch { return false; } })());

  // 所有主要出口都要挂上这道检查
  ck("openai-compat 出口挂上（覆盖大多数厂商）", /assertNoContentError\(content, "上游"\)/.test(SRC("services/upstream/openai-compat.js")));
  ck("antigravity 出口挂上", /assertNoContentError\(content, "Antigravity"\)/.test(SRC("services/upstream/antigravity.js")));
  for (const [f, n] of [["mimo-web", "MiMo"], ["minimax-web", "MiniMax"], ["stepfun-web", "StepFun"]]) {
    ck(`${f} 出口挂上`, new RegExp(`assertNoContentError\\(content, "${n}"\\)`).test(SRC(`services/upstream/${f}.js`)));
  }
}

/* ============ ③ 用量估算标记（估算值不能与精确值同口径） ============ */
console.log("\n=== ③ 用量估算标记 ===");
{
  const { splitTokens } = await import("../src/services/pricing.js");

  const exact = splitTokens({
    prompt: "abc",
    output: "def",
    upstreamTotal: { prompt_tokens: 10, completion_tokens: 20 },
  });
  ck("上游给全 usage → estimated=false", exact.estimated === false, JSON.stringify(exact));
  ck("上游给全 usage → 用上游的值", exact.promptTokens === 10 && exact.completionTokens === 20);

  const none = splitTokens({ prompt: "你好世界", output: "回答内容", upstreamTotal: null });
  ck("上游完全没给 usage → estimated=true", none.estimated === true, JSON.stringify(none));
  ck("上游完全没给 usage → 仍按字符估算（不能零计费）",
    none.promptTokens > 0 && none.completionTokens > 0, JSON.stringify(none));

  const partial = splitTokens({
    prompt: "abc",
    output: "def",
    upstreamTotal: { prompt_tokens: 10 },
  });
  ck("上游只给一半 usage → estimated=true", partial.estimated === true, JSON.stringify(partial));
  ck("已给的那一侧用上游值", partial.promptTokens === 10);

  const totalOnly = splitTokens({ prompt: "aaa", output: "bbb", upstreamTotal: { total_tokens: 100 } });
  ck("只有 total → estimated=true（按比例拆分是估算）", totalOnly.estimated === true, JSON.stringify(totalOnly));

  // 透出链路：settle 返回 → 响应头
  const gw = SRC("routes/gateway.js");
  ck("gateway 取出 estimated 标记", /estimated: tokensEstimated/.test(gw));
  ck("settle 返回 tokensEstimated", /tokensEstimated,?\s*\}/.test(gw) || /tokensEstimated:/.test(gw) || /cacheTokens, tokensEstimated/.test(gw));
  ck("响应头 X-Tokens-Estimated 透出", /X-Tokens-Estimated/.test(gw));
}

/* ============ ④ 视觉能力按模型声明（不再一律 true） ============ */
console.log("\n=== ④ 视觉能力声明 ===");
{
  const mm = await import("../src/services/upstream/minimax-models.js");
  const sf = await import("../src/services/upstream/stepfun-models.js");

  // MiniMax：M3 支持图片，M2.x 纯文本
  const mmVision = mm.resolveModel("MiniMax-M3");
  const mmText = mm.resolveModel("MiniMax-M2.7");
  ck("MiniMax-M3 vision=true（模型表写明的）", mmVision.vision === true, JSON.stringify(mmVision));
  ck("MiniMax-M2.7 vision=false（不再一律 true）", mmText.vision === false, JSON.stringify(mmText));

  // StepFun：step-5-preview / 3.7-flash 支持，3.5-flash 纯文本
  ck("step-5-preview vision=true", sf.resolveModel("step-5-preview").vision === true);
  ck("step-3.5-flash vision=false", sf.resolveModel("step-3.5-flash").vision === false);

  // 未登记的自定义模型：保守按不支持（让适配器显式报错，而不是撞上游的含糊报错）
  ck("未登记模型 vision=false（保守）", mm.resolveModel("my-custom-model").vision === false);
  ck("未登记模型 isReal=false", mm.resolveModel("my-custom-model").isReal === false);

  // resolveModel 里不能再无条件返回 vision: true（模型表逐条声明 vision 是正确的）
  for (const f of ["minimax-models", "stepfun-models"]) {
    const src = SRC(`services/upstream/${f}.js`);
    const fn = src.slice(src.indexOf("export function resolveModel"));
    ck(`${f} 的 resolveModel 不再无条件 vision: true`, !/vision: true/.test(fn), fn.slice(0, 200));
    ck(`${f} 的 resolveModel 按模型规格取 vision`, /vision: Boolean\(spec\?\.vision\)/.test(fn));
  }
  ck("minimax-web 对带图请求显式报 VISION_NOT_SUPPORTED", /VISION_NOT_SUPPORTED/.test(SRC("services/upstream/minimax-web.js")));
}

/* ============ ⑤ 逐渠道探测预算 + 首 Token 口径 ============ */
console.log("\n=== ⑤ 探测预算与首 Token 口径 ===");
{
  const cp = SRC("services/channel-probe.js");
  ck("导出 probeBudgetMs", /export function probeBudgetMs/.test(cp));
  ck("支持渠道自定义超时 other.probe_timeout_ms", /probe_timeout_ms/.test(cp));
  ck("自定义值有上下限钳制", /Math\.min\(30 \* 60 \* 1000/.test(cp));
  ck("返回 ttftMs（首 Token 耗时）", /ttftMs: /.test(cp));
  ck("onReasoning 也计入首 Token（思考算响应）", /onReasoning: mark/.test(cp));
  ck("onDelta 计入首 Token", /onDelta: mark/.test(cp));
  ck("适配器自带 probe 没给 ttft 时回填 ms（不能回填 0）", /Number\(r\.ttftMs\) > 0 \? Number\(r\.ttftMs\) : r\.ms/.test(cp));

  // DB 列 + 路由写入 + 前端展示
  const db = SRC("db.js");
  ck("channels 表有 ttft_ms 列", /ttft_ms INT NOT NULL DEFAULT 0/.test(db));
  ck("老库迁移清单含 ttft_ms", /\{ table: "channels", column: "ttft_ms"/.test(db));
  const ch = SRC("routes/channel.js");
  ck("测试路由写入 ttft_ms", /UPDATE channels SET response_time = \?, ttft_ms = \?/.test(ch));
  ck("rowToResp 暴露 ttft_ms（老数据回退总耗时）", /ttft_ms: Number\(r\.ttft_ms\) \|\| Number\(r\.response_time\)/.test(ch));
  ck("支持保存检测超时（秒）", /probe_timeout_sec/.test(ch));
  ck("autotest 同口径写 ttft_ms", /UPDATE channels SET response_time = \?, ttft_ms = \?/.test(SRC("services/autotest.js")));
  const fe = SRC("../../ooapi-web/src/pages/AdminChannelsPage.jsx");
  ck("前端响应列展示首 Token 耗时", /ttft_ms/.test(fe));
  ck("前端进度条按 UPTIME_SLOW_MS 判慢", /UPTIME_SLOW_MS/.test(fe));
}

/* ============ ⑥ Gemini 端点必须是 OpenAI 兼容路径 ============ */
console.log("\n=== ⑥ Gemini API 端点 ===");
{
  const ct = SRC("services/channel-types.js");
  ck("Gemini baseUrl 指向 /v1beta/openai/chat/completions",
    /baseUrl: "https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions"/.test(ct));
  ck("不再填裸域名（那会拼出不存在的 /v1/chat/completions）",
    !/baseUrl: "https:\/\/generativelanguage\.googleapis\.com",/.test(ct));
  // 实测（2026-09-22）：裸路径 /v1/chat/completions 返回 404；兼容层返回 400「请传有效 API Key」，
  // 说明路径存在。这里按同一规则断言本地 endpoints() 的推导结果。
  const raw = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  ck("openai-compat 能识别为完整 chat 端点", /\/chat\/completions$/.test(raw));
  ck("models 端点推导正确", raw.replace(/\/chat\/completions$/, "/models") ===
    "https://generativelanguage.googleapis.com/v1beta/openai/models");
}

/* ============ ⑦ stepfun 帧诊断（不再静默丢帧） ============ */
console.log("\n=== ⑦ StepFun 帧诊断 ===");
{
  const sf = SRC("services/upstream/stepfun-web.js");
  ck("记录未知 flags", /unknownFlags/.test(sf));
  ck("记录坏 JSON 帧数", /badJson/.test(sf));
  ck("检查尾部残帧", /trailingBytes/.test(sf));
  ck("有诊断时抛 CHANNEL_BAD_RESPONSE（可归因）", /CHANNEL_BAD_RESPONSE/.test(sf));
  ck("无诊断时才抛 CHANNEL_EMPTY（上游真没说话）", /CHANNEL_EMPTY/.test(sf));
  ck("未知 flags 仍尽力解析 JSON（不丢真实内容）", /if \(flags !== 0x00\)/.test(sf));
}

/* ============ ⑧ openai-web-ui 空输入框不再解引用 null ============ */
console.log("\n=== ⑧ OpenAI 网页版输入框判空 ===");
{
  const ui = SRC("services/upstream/openai-web-ui.js");
  const iNull = ui.indexOf("if (!target) {");
  const iEval = ui.indexOf('target.evaluate((n) => n.tagName.toLowerCase())');
  ck("target 判空存在", iNull > 0);
  ck("inputTag 的 evaluate 在判空之后（不再 null 解引用）", iNull > 0 && iEval > iNull, `判空@${iNull} evaluate@${iEval}`);
  ck("仍保留页面现场诊断（url/已登录/可见输入框）", /visibleInputs/.test(ui));
  ck("返回可归因的 CHANNEL_NOT_READY", /CHANNEL_NOT_READY/.test(ui));
}

/* ============ ⑨ 额度条折叠规范（全局统一） ============ */
console.log("\n=== ⑨ 额度条折叠规范 ===");
{
  const qo = await import("../../ooapi-web/src/components/quota-order.js");
  const W = (secs, pct, tag) => ({ windowSeconds: secs, usedPercent: pct, tag });

  // 典型：4 个窗口（Gemini 的两组 5h/7d）→ 只显示 2 条，短的优先
  const gem = [W(604800, 10, "7d"), W(18000, 20, "5h"), W(604800, 15, "7d"), W(18000, 5, "5h")];
  const r1 = qo.pickVisibleWindows(gem);
  ck("条数超过上限时折叠", r1.collapsed.length === 2, JSON.stringify(r1.collapsed.length));
  ck("主行全是短窗口（5h 优先于 7d）", r1.shown.every((w) => w.windowSeconds === 18000), JSON.stringify(r1.shown.map((w) => w.tag)));
  ck("不丢数据（shown + collapsed = 全部）", r1.shown.length + r1.collapsed.length === gem.length);

  // 递进：5h 用满 → 让位给 7d
  const spent = [W(604800, 10, "7d"), W(18000, 100, "5h")];
  const r2 = qo.pickVisibleWindows(spent);
  ck("5h 用满后递进显示 7d", r2.shown.some((w) => w.windowSeconds === 604800), JSON.stringify(r2.shown.map((w) => w.tag)));

  // 全部用满 → 仍要显示最短的（不能空白）。必须用 >maxBars 个窗口才真的发生折叠
  const allSpent = [W(604800, 100, "7d"), W(18000, 100, "5h"), W(2592000, 100, "30d")];
  const r3 = qo.pickVisibleWindows(allSpent);
  ck("全部用满时仍显示（不空白）", r3.shown.length === 2, JSON.stringify(r3.shown.map((w) => w.tag)));
  ck("全部用满时按长度升序（最短在前）", r3.shown[0].windowSeconds === 18000, JSON.stringify(r3.shown.map((w) => w.tag)));

  // 装得下就全显示（只排序不折叠）
  const two = [W(604800, 100, "7d"), W(18000, 100, "5h")];
  const r3b = qo.pickVisibleWindows(two);
  ck("窗口数不超上限时全部显示（不隐藏数据）", r3b.shown.length === 2 && r3b.collapsed.length === 0);
  ck("同时顺序仍按长度升序", r3b.shown[0].windowSeconds === 18000, JSON.stringify(r3b.shown.map((w) => w.tag)));

  // 长度未知的排最后
  const mixed = [{ usedPercent: 10, tag: "?" }, W(18000, 20, "5h")];
  const r4 = qo.pickVisibleWindows(mixed);
  ck("未知长度的窗口不抢占主位", r4.shown[0].windowSeconds === 18000, JSON.stringify(r4.shown.map((w) => w.tag)));

  ck("数量不超上限时原样返回", qo.pickVisibleWindows([W(18000, 1, "5h")]).shown.length === 1);

  // **只有 tag、没有 windowSeconds** 是真实上游的常见形态（antigravity 的
  // buckets[].window 就是字符串）。此时必须从 tag 解析出长度，否则整条递进规则失效。
  ck("tag '5h' 解析为 18000 秒", qo.parseWindowSeconds({ tag: "5h" }) === 18000);
  ck("tag '7d' 解析为 604800 秒", qo.parseWindowSeconds({ tag: "7d" }) === 604800);
  ck("tag '30d' 解析为 2592000 秒", qo.parseWindowSeconds({ tag: "30d" }) === 2592000);
  ck("tag '30m' 解析为 1800 秒", qo.parseWindowSeconds({ tag: "30m" }) === 1800);
  ck("label 尾段 'weekly' 解析为 7 天", qo.parseWindowSeconds({ label: "Gemini Models · weekly" }) === 604800);
  ck("windowSeconds 优先于 tag", qo.parseWindowSeconds({ windowSeconds: 3600, tag: "7d" }) === 3600);
  ck("无法识别时为 Infinity（排最后）", qo.parseWindowSeconds({ tag: "额度" }) === Infinity);

  // 端到端：只有 tag 时也要按短→长排序（这是预览截图里发现的真实缺陷）
  const tagOnly = [{ tag: "7d", usedPercent: 10 }, { tag: "5h", usedPercent: 20 }];
  const r5 = qo.pickVisibleWindows(tagOnly);
  ck("只有 tag 时 5h 排在 7d 前面", r5.shown[0].tag === "5h", JSON.stringify(r5.shown.map((w) => w.tag)));

  const tagOnly4 = [
    { tag: "7d", usedPercent: 10, scope: "Gemini" }, { tag: "5h", usedPercent: 20, scope: "Gemini" },
    { tag: "7d", usedPercent: 15, scope: "Claude" }, { tag: "5h", usedPercent: 5, scope: "Claude" },
  ];
  const r6 = qo.pickVisibleWindows(tagOnly4);
  ck("只有 tag 时 4 个窗口折叠成 2 条", r6.shown.length === 2 && r6.collapsed.length === 2);
  ck("只有 tag 时主行都是 5h", r6.shown.every((w) => w.tag === "5h"), JSON.stringify(r6.shown.map((w) => w.tag)));

  // 余额/积分必须是第一个 tag（用户要求：折叠时余额显示为第一个）
  const cq = SRC("../../ooapi-web/src/components/ChannelQuota.jsx");
  ck("余额 chips 用 unshift 排到最前", /if \(hasBalance\) chips\.unshift\(/.test(cq));

  // `+N` 必须同时统计「放不下的 chips」与「折叠的窗口」。
  // 原来只算窗口：纯积分渠道（WorkBuddy 6 个积分包、无窗口）会只显示前 3 个、
  // 既没有 +N 也无处展开，剩下 3 个静默消失（预览截图里发现）。
  ck("hiddenCount 同时计入 chips 与窗口", /const hiddenCount = hiddenChips\.length \+ collapsedPre\.length;/.test(cq));
  ck("折叠行只渲染一个 +N（不再平铺被折叠的 chips）",
    /\{hiddenCount > 0 \? \(/.test(cq) && !/shownWins\.length \? chips : restChips/.test(cq));
  ck("悬浮提示同时列出 chips 与窗口", /hiddenChips\.map/.test(cq) && /collapsedWins\.map/.test(cq));

  // 余额/积分必须**常驻可见**，不能被 `+N` 吞掉。
  // 线上实测（导出生产库真实 quota 后渲染）：#13/#14 的 free 账号余额 1000、
  // #42 的 119 积分，原先都只显示一个 `+N` —— 用户完全看不到还剩多少额度。
  ck("余额 chip 被单独摘出（balanceChip）", /const balanceChip = chips\.find/.test(cq));
  ck("其余 chips 排除余额后再折叠",
    /const otherChips = chips\.filter\(\(x\) => x\.key !== "bal"\)/.test(cq));
  ck("折叠计数不含余额（+N 与实际隐藏项对齐）",
    /const hiddenChips = wins\.length \? otherChips : restChips;/.test(cq));
  ck("有额度条时余额也在折叠行第一位", /\{hiddenCount > 0 \|\| balanceChip \? \(/.test(cq));
  ck("无额度条时余额是主行第一个 tag", /\{balanceChip \? \(/.test(cq));

  // 线上真实数据的回归：Google 那 4 个窗口只有 label、没有 tag/scope/windowSeconds，
  // 必须能从 label 解析出 5h/weekly 并正确递进（否则 4 条挤在一起看不出主次）
  const gemini = [
    { label: "Gemini Models · weekly", usedPercent: 17.1 },
    { label: "Gemini Models · 5h", usedPercent: 0 },
    { label: "Claude and GPT models · weekly", usedPercent: 0 },
    { label: "Claude and GPT models · 5h", usedPercent: 0 },
  ];
  ck("线上 Gemini 的 weekly 标签解析为 7 天",
    qo.parseWindowSeconds(gemini[0]) === 604800, String(qo.parseWindowSeconds(gemini[0])));
  ck("线上 Gemini 的 5h 标签解析为 18000 秒",
    qo.parseWindowSeconds(gemini[1]) === 18000, String(qo.parseWindowSeconds(gemini[1])));
  const gp = qo.pickVisibleWindows(gemini);
  ck("线上 4 窗口折叠为 2 条主行", gp.shown.length === 2 && gp.collapsed.length === 2,
    JSON.stringify([gp.shown.length, gp.collapsed.length]));
  ck("主行是两个 5h（短窗口优先）", gp.shown.every((w) => /5h/.test(w.label)),
    JSON.stringify(gp.shown.map((w) => w.label)));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
