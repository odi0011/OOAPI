// 通用渠道探针：给任意适配器（API Key / 网页反代 / 订阅 OAuth）发一条提示词并取回复。
// ---------------------------------------------------------------------------
// 设计：
//   · 优先用适配器自带的 probe（codex/claude/grok/antigravity：会带上渠道的测试模型与身份头）；
//   · 否则直接用适配器的 chat()（openai-compat 与所有 relay 适配器都有）；
//   · 都没有才退回 verify 健康检查（回复显示为「健康检查通过」）。
//
// 测试模型解析顺序：渠道 test_model → 接入方式的 testModel → 渠道声明的第一个模型（跳过 *）。
import { getMethod, isOAuthMethod } from "./channel-types.js";

export function methodKeyOf(channel) {
  const m = String(channel?.other?.method || "relay");
  return m === "api" || isOAuthMethod(m) ? m : "relay";
}

/** 给渠道解析一个可用的测试模型（可能为空字符串，交给适配器兜底）。
 * 顺序：渠道显式 test_model → 渠道声明的第一个模型（用户口径：默认第一个）→ 接入方式 testModel。 */
export function resolveTestModel(channel) {
  const explicit = String(channel?.test_model || channel?.other?.test_model || "").trim();
  if (explicit) return explicit;
  const first = (channel?.models || []).find((m) => m && m !== "*");
  if (first) return String(first);
  const mCfg = getMethod(channel?.type, methodKeyOf(channel));
  return String(mCfg?.testModel || "").trim();
}

/**
 * 发送一条探测请求。
 * @returns {{ ms:number, reply:string, model:string, degraded?:number, state?:number }}
 *   degraded：1=本轮命中降智/截断信号（目前仅 codex 有）；state：1=注入了通行证（292）
 */
export async function probeChannel(adapter, channel, prompt = "hi") {
  const model = resolveTestModel(channel);
  if (adapter?.probe) {
    // 把解析出的模型显式传给适配器（适配器内部优先读 channel.test_model）
    const r = await adapter.probe({ ...channel, test_model: model || channel?.test_model || "" }, prompt);
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
    const r = await adapter.chat({
      channel,
      model,
      prompt,
      messages: [{ role: "user", content: prompt }],
      images: [],
      onDelta: () => {},
      onReasoning: () => {},
    });
    return {
      ms: Date.now() - started,
      reply: r.content || "",
      model: r.upstreamModel || model,
      ...(r.rotateNext ? { degraded: 1 } : {}),
      ...(r.stateUsed !== undefined ? { state: r.stateUsed ? 1 : 0 } : {}),
    };
  }
  if (adapter?.verify) {
    const ms = await adapter.verify(channel);
    return { ms, reply: "(健康检查通过，适配器未提供对话探针)", model };
  }
  throw Object.assign(new Error("该渠道适配器不支持检测"), { code: "UNSUPPORTED_CHANNEL" });
}
