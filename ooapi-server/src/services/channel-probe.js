// 通用渠道探针：给任意适配器（API Key / 网页反代 / 订阅 OAuth）发一条提示词并取回复。
// ---------------------------------------------------------------------------
// 设计：
//   · 优先用适配器自带的 probe（codex/claude/grok/antigravity：会带上渠道的测试模型与身份头）；
//   · 否则直接用适配器的 chat()（openai-compat 与所有 relay 适配器都有）；
//   · 都没有才退回 verify 健康检查（回复显示为「健康检查通过」）。
//
// 测试模型解析顺序：渠道 test_model → 接入方式的 testModel → 渠道声明的第一个模型（跳过 *）。
import { getMethod, isOAuthMethod, isApiKeyMethod } from "./channel-types.js";
import { withChannelLimit } from "./router.js";

export function methodKeyOf(channel) {
  const m = String(channel?.other?.method || "relay");
  // 同 routes/channel.js 的 methodOf：**不能把未知 method 归一成 relay**，
  // 否则同一厂商下的具名反代方式（openai-web-ui）会被错判成经典 relay，
  // 探测时拿到错误的 testModel 与 needsBrowser 判定。
  if (isApiKeyMethod(channel?.type, m) || isOAuthMethod(m)) return m;
  return getMethod(channel?.type, m) ? m : "relay";
}

/** 该渠道是否走浏览器会话（needsBrowser 的接入方式） */
function needsBrowserSession(channel) {
  try {
    return Boolean(getMethod(channel?.type, methodKeyOf(channel))?.needsBrowser);
  } catch {
    return false;
  }
}

/** 给渠道解析一个可用的测试模型（可能为空字符串，交给适配器兜底）。
 * 顺序：渠道显式 test_model → 渠道声明的第一个模型（用户口径：默认第一个）→ 接入方式 testModel。
 * 注意：rowToChannel 的 models 是逗号字符串（不是数组），必须兼容两种形态。 */
export function resolveTestModel(channel) {
  const explicit = String(channel?.test_model || channel?.other?.test_model || "").trim();
  if (explicit) return explicit;
  const raw = channel?.models;
  const list = Array.isArray(raw)
    ? raw.map((m) => String(m).trim())
    : String(raw || "").split(/[\s,，]+/).map((s) => s.trim());
  const first = list.find((m) => m && m !== "*");
  if (first) return first;
  const mCfg = getMethod(channel?.type, methodKeyOf(channel));
  return String(mCfg?.testModel || "").trim();
}

// 探针总超时：此前 probe 与兜底 chat 都不传 signal，上游返回 200 后 SSE 永不结束
// （网关卡死、半开连接）会一直挂着 —— 期间这个渠道的串行槽被占死，
// 后续**所有真实请求**都得排队，而前端 90s 就报超时，管理员完全看不到真实原因。
// 给探针一个比 verify（30~60s）宽松、但一定有上限的预算。
const PROBE_TIMEOUT_MS = 90000;
// 浏览器驱动渠道（browser 会话）首次探测要付「启动 Chromium + 过风控 + 页面水合」
// 的固定开销，实测常到 60~120s：90s 预算下**测试按钮每次都报超时**，
// 而渠道其实是好的 —— 管理员会据此误判为坏渠道。给这类渠道单独放宽。
// 仍保留上限：探测必须能结束，否则会占住该渠道的串行槽。
const PROBE_TIMEOUT_BROWSER_MS = 240000;

/**
 * 该渠道的探测超时预算（毫秒）。
 *
 * 支持逐模型覆盖：`other.probe_timeout_ms`（或 `test_timeout_ms`）。
 * 为什么需要它（用户实测反馈）：「如果这个渠道这个厂商本身响应就很慢的话，
 * 则可以根据具体的模型进行这个响应时间的配置，有的模型好像响应时间就是很慢」——
 * 实测确实如此：同一渠道下 gpt-5.6 / glm-5.3 这类大档位的思考时间可达数分钟，
 * 而「hi」这种最短提示词也救不了它（思考长度由模型档位决定，与提示词长短无关）。
 * 统一 90s 预算下这些渠道**每次都报超时**，管理员只能反复重试。
 *
 * 优先级：渠道 other 配置 > 浏览器渠道默认 > 普通默认。
 * 上限 30 分钟：必须有上限，否则探测会占死该渠道的串行槽。
 */
export function probeBudgetMs(channel) {
  const custom = Number(channel?.other?.probe_timeout_ms ?? channel?.other?.test_timeout_ms);
  if (Number.isFinite(custom) && custom > 0) return Math.min(30 * 60 * 1000, Math.max(5000, Math.floor(custom)));
  return needsBrowserSession(channel) ? PROBE_TIMEOUT_BROWSER_MS : PROBE_TIMEOUT_MS;
}

/**
 * 发送一条探测请求。
 * @returns {{ ms:number, ttftMs:number, reply:string, model:string, degraded?:number, state?:number }}
 *   ms：本次探测的**总耗时**（发出 → 流结束）。
 *   ttftMs：**首 Token 耗时**（首个正文**或思考**增量到达的时刻）。
 *   degraded：1=本轮命中降智/截断信号（目前仅 codex 有）；state：1=注入了通行证（292）
 *
 * **为什么必须同时给两个数**（用户实测反馈）：
 *   「你线上测测 Gemini 渠道的是不是根据首 t 来判定的检测时间？为什么响应时间这么长？」
 *   「GLM 这个模型响应也是很慢，但是实际上人家是一直在思考的，思考的首 t 也算首 t 吧？」
 *
 * 原实现只记总耗时，于是：
 *   · 思考型模型（GLM / o 系列 / R1）先吐几十秒 reasoning 再吐正文 —— 首字其实很快，
 *     总耗时却是几十秒，管理员看到的「响应时间」严重偏离体感，误判成坏渠道；
 *   · Gemini 这类预填充重的模型同理：真正慢的是生成总量，不是「连不上」。
 * 用户感知的健康度是「多久开始出字」，所以**展示与慢速判定都用 ttftMs**，
 * 总耗时作为参考一并返回（吞吐与截断排查要用）。
 */
export async function probeChannel(adapter, channel, prompt = "hi") {
  const budget = probeBudgetMs(channel);
  // 走渠道限速闸门：测试/定时检测此前完全绕过 withChannelLimit，
  // 批量检测会并发打同一个账号（HTTP 渠道没有任何串行保护），是实打实的风控触发点。
  // 浏览器渠道靠会话锁侥幸串行，但不能依赖这种巧合。
  return withChannelLimit(channel, () =>
    probeChannelInner(adapter, channel, prompt, AbortSignal.timeout(budget), budget)
  );
}

async function probeChannelInner(adapter, channel, prompt = "hi", signal = undefined, budgetMs = PROBE_TIMEOUT_MS) {
  const model = resolveTestModel(channel);
  const withTimeout = (p) =>
    p.catch((e) => {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        // 报实际预算：浏览器渠道的预算与普通渠道不同，写死 90 会与实际不符
        throw Object.assign(new Error(`渠道检测超时（${budgetMs / 1000}s 未返回）`), { code: "CHANNEL_TIMEOUT" });
      }
      throw e;
    });
  if (adapter?.probe) {
    // 把解析出的模型显式传给适配器（适配器内部优先读 channel.test_model）
    const r = await withTimeout(
      adapter.probe({ ...channel, test_model: model || channel?.test_model || "" }, prompt, signal)
    );
    // 适配器自带 probe 的 ms 是总耗时；没给 ttft 时回填 ms。
    // 不能回填 0：0 会被前端当成「没测到」，且会被小竖条判定成「极快」，比不显示更误导。
    const ttft = Number(r.ttftMs) > 0 ? Number(r.ttftMs) : r.ms;
    return {
      ms: r.ms,
      ttftMs: ttft,
      reply: r.reply || "",
      model: r.model || model,
      ...(r.degraded !== undefined ? { degraded: r.degraded ? 1 : 0 } : {}),
      ...(r.state !== undefined ? { state: r.state ? 1 : 0 } : {}),
    };
  }
  if (adapter?.chat) {
    const started = Date.now();
    // 首个增量（正文**或思考**）到达即记首 Token。
    // 思考必须计入：模型在「想着」对用户而言就是「已经在响应了」，
    // 漏掉思考会把所有思考型渠道判成慢渠道（用户实测的原话）。
    let firstAt = 0;
    const mark = () => {
      if (!firstAt) firstAt = Date.now();
    };
    const r = await withTimeout(
      adapter.chat({
        channel,
        model,
        prompt,
        messages: [{ role: "user", content: prompt }],
        images: [],
        onDelta: mark,
        onReasoning: mark,
        signal,
      })
    );
    const total = Date.now() - started;
    // 适配器可能**自己**测了更准的首 Token（只算「发出请求 → 上游首帧」，不含
    // 浏览器启动/导航/输入这些我们这侧的开销）。这类渠道（GLM/豆包/通义）的
    // `firstAt` 会晚得离谱：实测 GLM 首个增量在 11.7 秒才到，其中绝大部分是
    // 起 Chromium + 导航 + 逐字符输入 —— 把它当「响应时间」展示会误导管理员
    // （用户实测反馈：「检测机制也无法检测到真正的首token」）。
    // 有自报值就优先用它，并把两个数都留下（`browserMs` = 我们这侧的开销）。
    const selfTtft = Number(r?.firstTokenMs);
    const browserMs = firstAt ? firstAt - started : 0;
    const ttft = Number.isFinite(selfTtft) && selfTtft > 0 ? Math.min(selfTtft, browserMs || selfTtft) : browserMs || total;
    return {
      ms: total,
      // 一次增量都没回调且适配器也没自报（非流式适配器）：退化用总耗时
      ttftMs: ttft,
      // 我们这侧的开销（浏览器渠道才有意义）：展示时可用来说明「11.7s 里绝大部分不是上游慢」
      ...(browserMs ? { browserMs } : {}),
      reply: r.content || "",
      model: r.upstreamModel || model,
      ...(r.rotateNext ? { degraded: 1 } : {}),
      ...(r.stateUsed !== undefined ? { state: r.stateUsed ? 1 : 0 } : {}),
    };
  }
  if (adapter?.verify) {
    const ms = await withTimeout(adapter.verify(channel));
    return { ms, ttftMs: ms, reply: "(健康检查通过，适配器未提供对话探针)", model };
  }
  throw Object.assign(new Error("该渠道适配器不支持检测"), { code: "UNSUPPORTED_CHANNEL" });
}
