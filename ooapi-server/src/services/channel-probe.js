// 通用渠道探针：给任意适配器（API Key / 网页反代 / 订阅 OAuth）发一条提示词并取回复。
// ---------------------------------------------------------------------------
// 设计：
//   · 优先用适配器自带的 probe（codex/claude/grok/antigravity：会带上渠道的测试模型与身份头）；
//   · 否则直接用适配器的 chat()（openai-compat 与所有 relay 适配器都有）；
//   · 都没有才退回 verify 健康检查（回复显示为「健康检查通过」）。
//
// 测试模型解析顺序：渠道 test_model → 接入方式的 testModel → 渠道声明的第一个模型（跳过 *）。
import { getMethod, isOAuthMethod } from "./channel-types.js";
import { withChannelLimit } from "./router.js";

export function methodKeyOf(channel) {
  const m = String(channel?.other?.method || "relay");
  return m === "api" || isOAuthMethod(m) ? m : "relay";
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

/**
 * 发送一条探测请求。
 * @returns {{ ms:number, reply:string, model:string, degraded?:number, state?:number }}
 *   degraded：1=本轮命中降智/截断信号（目前仅 codex 有）；state：1=注入了通行证（292）
 */
export async function probeChannel(adapter, channel, prompt = "hi") {
  // 走渠道限速闸门：测试/定时检测此前完全绕过 withChannelLimit，
  // 批量检测会并发打同一个账号（HTTP 渠道没有任何串行保护），是实打实的风控触发点。
  // 浏览器渠道靠会话锁侥幸串行，但不能依赖这种巧合。
  return withChannelLimit(channel, () =>
    probeChannelInner(adapter, channel, prompt, AbortSignal.timeout(PROBE_TIMEOUT_MS))
  );
}

async function probeChannelInner(adapter, channel, prompt = "hi", signal = undefined) {
  const model = resolveTestModel(channel);
  const withTimeout = (p) =>
    p.catch((e) => {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw Object.assign(new Error(`渠道检测超时（${PROBE_TIMEOUT_MS / 1000}s 未返回）`), { code: "CHANNEL_TIMEOUT" });
      }
      throw e;
    });
  if (adapter?.probe) {
    // 把解析出的模型显式传给适配器（适配器内部优先读 channel.test_model）
    const r = await withTimeout(
      adapter.probe({ ...channel, test_model: model || channel?.test_model || "" }, prompt, signal)
    );
    return {
      ms: r.ms,
      reply: r.reply || "",
      model: r.model || model,
      ...(r.degraded !== undefined ? { degraded: r.degraded ? 1 : 0 } : {}),
      ...(r.state !== undefined ? { state: r.state ? 1 : 0 } : {}),
    };
  }
  if (adapter?.chat) {
    const started = Date.now();
    const r = await withTimeout(
      adapter.chat({
        channel,
        model,
        prompt,
        messages: [{ role: "user", content: prompt }],
        images: [],
        onDelta: () => {},
        onReasoning: () => {},
        signal,
      })
    );
    return {
      ms: Date.now() - started,
      reply: r.content || "",
      model: r.upstreamModel || model,
      ...(r.rotateNext ? { degraded: 1 } : {}),
      ...(r.stateUsed !== undefined ? { state: r.stateUsed ? 1 : 0 } : {}),
    };
  }
  if (adapter?.verify) {
    const ms = await withTimeout(adapter.verify(channel));
    return { ms, reply: "(健康检查通过，适配器未提供对话探针)", model };
  }
  throw Object.assign(new Error("该渠道适配器不支持检测"), { code: "UNSUPPORTED_CHANNEL" });
}
