// 上游 429（限流）处理的行为锁 —— 用户要求（原话）：
//   「如果哪个渠道报错 429，不要计入最近调用条条里，应该直接停止渠道状态
//     然后在额度的余额那一行 tag 的下面新起一行，用橙黄色显示上游 429，预计恢复时间 xxx」
//
// 为什么必须有这组测试：这条链路上每一个环节都是**静默失败**的 —
//   · 错误码写错一个字母（CHANNEL_RATE_LIMIT vs CHANNEL_RATE_LIMITED）不会报错，
//     只会让冷却档位与判据悄悄走 default；线上已经真实发生过（两个码曾各写一半）。
//   · 「不计入最近调用」写漏了不会报错，只会让成功率被限流噪声稀释。
//   · 自动恢复任务的判据写宽了（不看 rate_limit_until）会把凭据失效的渠道也复活，
//     那是比停着更危险的状态（坏凭据被反复调度）。
// 所以这里逐条锁死：码的集合、判据函数、SQL 语句、恢复条件、以及 min_gap 的兜底。
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

const router = read("src/services/router.js");
const execute = read("src/services/execute.js");
const autotest = read("src/services/autotest.js");
const channelRoute = read("src/routes/channel.js");
const pingyi = read("src/services/upstream/openai-compat.js");
const htmErr = read("src/services/upstream/http-error.js");
const dbSrc = read("src/db.js");

console.log("=== 1. 双错误码必须都被认（历史上各写一半）===");
t("router 导出 RATE_LIMIT_CODES 且含两个码", () => {
  const m = router.match(/export const RATE_LIMIT_CODES = new Set\(\[([\s\S]*?)\]\)/);
  ck(m, "未找到 RATE_LIMIT_CODES 定义");
  ck(/"CHANNEL_RATE_LIMIT"/.test(m[1]), "缺 CHANNEL_RATE_LIMIT（适配器侧用的那个）");
  ck(/"CHANNEL_RATE_LIMITED"/.test(m[1]), "缺 CHANNEL_RATE_LIMITED（http-error.js 用的那个）");
});
t("router 导出 isRateLimitedCode", () => {
  ck(/export function isRateLimitedCode\(/.test(router), "没有 isRateLimitedCode");
});
t("execute 的 RETRYABLE 收录两个码", () => {
  const m = execute.match(/const RETRYABLE = new Set\(\[([\s\S]*?)\]\)/);
  ck(m, "未找到 RETRYABLE");
  ck(/"CHANNEL_RATE_LIMIT"/.test(m[1]), "RETRYABLE 缺 CHANNEL_RATE_LIMIT");
  ck(/"CHANNEL_RATE_LIMITED"/.test(m[1]), "RETRYABLE 缺 CHANNEL_RATE_LIMITED");
});
t("cooldownFor 给两个码明确档位（不靠 default）", () => {
  const m = execute.match(/function cooldownFor\([\s\S]*?\n\}/);
  ck(m, "未找到 cooldownFor");
  ck(/case "CHANNEL_RATE_LIMIT":/.test(m[0]), "cooldownFor 缺 case CHANNEL_RATE_LIMIT");
  ck(/case "CHANNEL_RATE_LIMITED":/.test(m[0]), "cooldownFor 缺 case CHANNEL_RATE_LIMITED");
});
t("http-error.js 归类出的码在集合内", () => {
  ck(/RATE_LIMITED: "CHANNEL_RATE_LIMITED"/.test(htmErr), "http-error 的 RATE_LIMITED 取值变了");
});

console.log("\n=== 2. 429 不计入「最近调用」 ===");
t("markChannelError 对限流走单独分支（不 pushRecent）", () => {
  ck(/const rateLimited = isRateLimitedCode\(code\)/.test(router), "markChannelError 没有算 rateLimited");
  ck(/if \(!rateLimited\) \{[\s\S]*?pushRecent\(/.test(router), "限流分支没有跳过 pushRecent");
});
t("限流分支只写 last_error/last_error_code，不碰 recent_calls", () => {
  // 取 markChannelError 函数体，逐条 UPDATE 检查：限流相关的那些 SQL 不许出现 recent_calls
  const fn = router.match(/export async function markChannelError[\s\S]*?\n\}/);
  ck(fn, "未找到 markChannelError");
  const updates = fn[0].match(/UPDATE channels SET [^"]+"/g) || [];
  ck(updates.length >= 3, `markChannelError 里的 UPDATE 语句太少（${updates.length}）`);
  // 前两条是 recent 写入（非限流路径），其余（限流 / 自动暂停）不许带 recent_calls
  const pauseUpdates = updates.filter((u) => /status = 3/.test(u));
  ck(pauseUpdates.length >= 2, "没找到两条停用语句（限流 / 不可自愈）");
  for (const u of pauseUpdates) {
    ck(!/recent_calls/.test(u), `停用语句里出现了 recent_calls：${u}`);
  }
  // 至少有一条 UPDATE 是「只写 last_error + last_error_code」的限流路径
  ck(
    updates.some((u) => /last_error = \?, last_error_code = \?/.test(u) && !/recent_calls/.test(u)),
    "限流路径没有「只写错误信息、不碰 recent_calls」的 UPDATE"
  );
});
t("手动测试（routes/channel.js）同样跳过 429 的 recordChannelCall", () => {
  ck(/if \(!rateLimited\) \{\s*\n\s*await recordChannelCall/.test(channelRoute), "手动测试没有跳过限流的最近调用记录");
});
t("定时检测（autotest.js）同样跳过", () => {
  ck(/if \(!rateLimited\) \{\s*\n\s*await recordChannelCall/.test(autotest), "定时检测没有跳过限流的最近调用记录");
});

console.log("\n=== 3. 429 直接停用渠道，并带自动恢复时刻 ===");
t("markChannelError 的限流分支写 status=3 + rate_limit_until", () => {
  ck(/UPDATE channels SET status = 3, rate_limit_until = \? WHERE id = \? AND status = 1/.test(router), "限流分支没有写 status=3 + rate_limit_until");
});
t("停用前失效渠道快照缓存（否则 5s TTL 内仍会被调度）", () => {
  const m = router.match(/export async function markChannelError[\s\S]*?\n\}/);
  ck(m, "未找到 markChannelError");
  ck(/invalidateChannelCache\(\)/.test(m[0]), "markChannelError 停用后没有失效缓存");
});
t("存在共享的时长口径函数 rateLimitPauseSec（三条路径共用，不会漂移）", () => {
  ck(/export function rateLimitPauseSec\(cooldownSec\)/.test(router), "没有 rateLimitPauseSec");
  ck(/Math\.min\(1800, Math\.max\(RATE_LIMIT_PAUSE_SEC/.test(router), "时长没有钳制在默认~1800s");
  ck(/RATE_LIMIT_PAUSE_SEC = 600/.test(router), "默认停用时长不是 600s");
});
t("手动测试与定时检测都调用同一个函数", () => {
  ck(/rateLimitPauseSec\(e\.cooldownSec\)/.test(channelRoute), "手动测试没用共享函数");
  ck(/rateLimitPauseSec\(e\.cooldownSec\)/.test(autotest), "定时检测没用共享函数");
});
t("不可自愈错误那条分支把 rate_limit_until 归零", () => {
  ck(/UPDATE channels SET status = 3, rate_limit_until = 0 WHERE id = \? AND status = 1/.test(router), "不可自愈分支没有清零 rate_limit_until");
});

console.log("\n=== 4. 自动恢复任务 ===");
t("存在 resumeRateLimitedChannels 且只挑 status=3 且 rate_limit_until>0", () => {
  const m = router.match(/export async function resumeRateLimitedChannels\(\)[\s\S]*?\n\}/);
  ck(m, "未找到 resumeRateLimitedChannels");
  ck(/status = 3 AND rate_limit_until > 0 AND rate_limit_until <= \?/.test(m[0]), "恢复条件不对（会把凭据失效的渠道也复活）");
  ck(/UPDATE channels SET status = 1, rate_limit_until = 0, last_error = '' WHERE id = \? AND status = 3/.test(m[0]), "恢复 SQL 不对");
});
t("恢复后清内存态 + 失效缓存", () => {
  const m = router.match(/export async function resumeRateLimitedChannels\(\)[\s\S]*?\n\}/);
  ck(/s\.autoPaused = false/.test(m[0]), "恢复后没清 autoPaused");
  ck(/s\.rateLimitUntil = 0/.test(m[0]), "恢复后没清 rateLimitUntil");
  ck(/invalidateChannelCache\(\)/.test(m[0]), "恢复后没失效缓存");
});
t("index.js 注册了恢复定时器", () => {
  const idx = read("src/index.js");
  ck(/resumeRateLimitedChannels/.test(idx), "index.js 没有启动恢复任务");
  ck(/setInterval\(run, 30_000\)/.test(idx), "恢复任务不是 30s 一轮");
});
t("setChannelRateLimit 供手动测试补回内存态", () => {
  ck(/export function setChannelRateLimit\(/.test(router), "没有 setChannelRateLimit");
});

console.log("\n=== 5. 数据库列 ===");
t("channels 表补了 rate_limit_until", () => {
  ck(/column: "rate_limit_until"/.test(dbSrc), "没补 rate_limit_until 列");
});
t("channels 表补了 last_error_code", () => {
  ck(/column: "last_error_code"/.test(dbSrc), "没补 last_error_code 列");
});

console.log("\n=== 6. min_gap_ms=0 必须回落默认（线上 429 的真实诱因）===");
t("rateOf 对 0/未设回落 RATE.minGapMs", () => {
  const m = router.match(/function rateOf\(channel\)[\s\S]*?\n\}/);
  ck(m, "未找到 rateOf");
  ck(/gap > 0 && gap <= 600_000 \? gap : RATE\.minGapMs/.test(m[0]), "min_gap 的 0 没有被回落成默认值");
  ck(!/minGapMs: num\(o\.min_gap_ms, RATE\.minGapMs, 0,/.test(m[0]), "还留着把 0 当合法最小值的旧写法");
});
t("默认最小间隔不是 0", () => {
  const m = router.match(/const RATE = \{([^}]*)\}/);
  ck(m, "未找到 RATE 默认值");
  ck(/minGapMs:\s*(?!0)\d+/.test(m[1]), "默认 minGapMs 是 0");
});

console.log("\n=== 7. DeepSeek 503（上游过载）不能再直达用户 ===");
t("openai-compat 把 5xx 归为 CHANNEL_UPSTREAM_BUSY", () => {
  ck(/resp\.status >= 500[\s\S]{0,80}CHANNEL_UPSTREAM_BUSY/.test(pingyi), "5xx 没有归为 CHANNEL_UPSTREAM_BUSY");
});
t("chat() 对过载原地重试（有次数上限）", () => {
  ck(/const BUSY_RETRIES = 2/.test(pingyi), "没有 BUSY_RETRIES 常量");
  ck(/attempt >= BUSY_RETRIES/.test(pingyi), "重试没有次数上限");
});
t("已流出内容就不再重试（否则客户端会收到两份拼接）", () => {
  ck(/sawOutput/.test(pingyi), "没有 sawOutput 保护");
  ck(/!busy \|\| attempt >= BUSY_RETRIES \|\| sawOutput/.test(pingyi), "重试条件里没有 sawOutput");
});
t("等待期间客户端断开就放弃", () => {
  const m = pingyi.match(/for \(let attempt = 0; ; attempt \+= 1\)[\s\S]*?\n  \}\n\}/);
  ck(m, "未找到重试循环");
  ck(/signal\?\.aborted/.test(m[0]), "重试前没有检查 abort");
});
t("CHANNEL_UPSTREAM_BUSY 可重试且有冷却档位", () => {
  ck(/"CHANNEL_UPSTREAM_BUSY"/.test(execute), "RETRYABLE/cooldownFor 里没有 CHANNEL_UPSTREAM_BUSY");
  const m = execute.match(/const RETRYABLE = new Set\(\[([\s\S]*?)\]\)/);
  ck(/"CHANNEL_UPSTREAM_BUSY"/.test(m[1]), "RETRYABLE 没收 CHANNEL_UPSTREAM_BUSY");
});

console.log("\n=== 8. 前端展示字段 ===");
const page = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "AdminChannelsPage.jsx"), "utf8");
t("后端列表接口返回 rate_limit_until 与 last_error_code", () => {
  ck(/rate_limit_until: Number\(r\.rate_limit_until\)/.test(channelRoute), "toRow 没返回 rate_limit_until");
  ck(/last_error_code: String\(r\.last_error_code \|\| ""\)/.test(channelRoute), "toRow 没返回 last_error_code");
});
t("状态标签区分「限流停用」", () => {
  ck(/限流停用/.test(channelRoute), "status_label 没有限流停用档");
});
t("前端有 RateLimitRow 组件且用橙黄色（amber 色板）", () => {
  ck(/function RateLimitRow\(/.test(page), "没有 RateLimitRow");
  ck(/--pill-amber-ink/.test(page), "没有用 amber 前景色");
  ck(/--pill-amber-tint/.test(page), "没有用 amber 背景色");
});
t("文案是「上游 429 + 恢复时刻」（够短，不被列宽截断）", () => {
  ck(/上游 429 \{text\}/.test(page), "文案不是「上游 429 …」");
  const m = page.match(/const text = left > 0 \? `([^`]+)`/);
  ck(m, "未找到 text 文案");
  // 按**渲染后**的宽度估算，而不是源码字符数：`${fmtClock(until)}` 在源码里 17 字符、
  // 渲染出来只有 5（HH:MM）。额度列 ~240px / 11px 字号，一行约放得下 26 个半角字符。
  const rendered = m[1].replace(/\$\{[^}]+\}/g, "XXXXX"); // 插值按 5 字符估
  ck(rendered.length <= 12, `渲染后文案过长（约 ${rendered.length} 字符）：${m[1]}`);
  // 倒计时（分/秒）必须已挪进悬浮提示：它是长文案被截断的根源
  ck(!/分|秒/.test(m[1]), `可见文案里还有倒计时：「${m[1]}」`);
  ck(/leftText/.test(page), "倒计时没有挪进提示（leftText 缺失）");
  // 时刻到分为止（带秒会多占 ~14px）
  const fc = page.match(/function fmtClock\(epochSeconds\)[\s\S]*?\n\}/);
  ck(fc, "未找到 fmtClock");
  ck(!/:?\$\{p\(d\.getSeconds\(\)\)\}/.test(fc[0]), "fmtClock 仍带秒，列宽不够");
});
t("RateLimitRow 挂在额度列（余额那一行的下方）", () => {
  // 必须出现在 quota 列的 render 里：先 <QuotaInline/>，随后紧跟 rateLimitRow
  ck(
    /const rateLimitRow = <RateLimitRow r=\{r\} \/>/.test(page) && /<QuotaInline quota=\{q\} stats=\{stats\} \/[\s\S]{0,60}\{rateLimitRow\}/.test(page),
    "RateLimitRow 不在额度列（或没排在 QuotaInline 之后）"
  );
});
t("rate_limit_until 为 0 时不渲染（限流恢复后自动消失）", () => {
  const m = page.match(/function RateLimitRow\(\{ r \}\) \{[\s\S]*?\n\}/);
  ck(m, "未找到 RateLimitRow 定义");
  ck(/if \(!until\) return null;/.test(m[0]), "没有对 0 直接返回 null");
});
t("表单提示与后端语义一致（0 = 用默认 1200ms）", () => {
  ck(/0 = 用默认（1200ms）/.test(page), "表单 extra 文案与实际语义不一致");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
