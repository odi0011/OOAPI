// 统一执行器：模型 → 渠道选择 → 失败切换 → 返回结果
// 网关（/v1）与站内对话/智能体共用此逻辑，保证行为一致。
import crypto from "node:crypto";
import { withEndpointAudit } from "./endpoint-audit.js";
import { modelCapabilities, reasoningSelection } from "./model-capabilities.js";
import { pool } from "../db.js";
import { getNumberOption } from "../config.js";
import { selectChannels, getAdapter, adapterKeyFor, markChannelError, markChannelOk, withChannelLimit, explainNoChannel } from "./router.js";
import { callsText } from "./tool-wire.js";
import { resolveAliasSync } from "./models.js";
import { recordChannelSwitch } from "./metrics.js";
import { normalizeUsage, assertModelPriced } from "./pricing.js";
import { channelPriceQuote } from "./channel-price-quote.js";
import { clientAgentContext } from "./client-agent-context.js";
import { agentReasoning, orderAgentChannels } from "./agent-routing.js";

/** 请求已经发送不能证明消耗；只认上游返回的用量或实际生成的内容。 */
export function hasBillableUsage(usage) {
  const u = normalizeUsage(usage);
  return u.promptTokens > 0 || u.completionTokens > 0 || u.totalTokens > 0;
}

/** 所有失败结算共用这个出口，工具已记录的调用不能再被外层合成。 */
export function billableFailedCall(err, fallback = {}) {
  if (!err || err.billingRecorded || err.billable !== true) return null;
  const output = String(err.billingOutput ?? fallback.output ?? `${err.content || ""}${err.reasoning || ""}`);
  if (!output && !hasBillableUsage(err.usage)) return null;
  return {
    prompt: String(err.billingPrompt ?? fallback.prompt ?? ""),
    output,
    usage: err.usage ?? null,
    channel: String(err.channelName || fallback.channel || ""),
    channelId: Number(err.channelId || fallback.channelId) || 0,
    startedAt: Number(err.billingStartedAt || fallback.startedAt) || Date.now(),
    firstTokenAt: Number(err.billingFirstTokenAt || err.firstTokenAt || fallback.firstTokenAt) || 0,
    elapsed: Number(err.elapsed || fallback.elapsed) || 0,
    model: String(err.billModel || err.model || fallback.model || ""),
    requestedModel: String(err.requestedModel || fallback.model || err.model || ""),
    upstreamModel: String(err.upstreamModel || fallback.upstreamModel || ""),
    channelQuote: err.channelQuote || fallback.channelQuote || null,
    billModel: String(err.billModel || ""),
    retryCount: Math.max(0, Number(err.retryCount) || 0),
    reasoningEffort: err.reasoningEffort || fallback.reasoningEffort || "default",
    reasoningApplied: err.reasoningApplied === true,
    upstreamEndpoints: err.upstreamEndpoints || [],
    endpointAttempts: err.endpointAttempts || [],
    reasoningRequested: err.reasoningRequested || "",
    errorCode: String(err.code || "CHANNEL_ERROR"),
    httpStatus: Number(err.status || err.httpStatus) || 0,
    failed: true,
    billable: true,
  };
}

// 渠道异常码 → 是否需要换渠道重试
const RETRYABLE = new Set([
  "CHANNEL_MUTED",        // 被风控限制
  "CHANNEL_AUTH_EXPIRED", // 登录态失效
  "CHANNEL_WAF",          // 被 WAF 拦截
  "CHANNEL_EMPTY",        // 空回复（通常也是风控）
  "CHANNEL_NETWORK",      // 网络错误
  "CHANNEL_HTTP_ERROR",   // 上游 HTTP 异常
  "CHANNEL_STREAM_ERROR", // 流中断
  "CHANNEL_BAD_RESPONSE", // 响应格式异常
  "CHANNEL_CAPTCHA",      // 需要人机验证（换账号往往能绕开）
  "CHANNEL_RATE_LIMIT",   // 频率限制
  "CHANNEL_TIMEOUT",      // 上游超时
  "CHANNEL_NOT_READY",    // 页面/会话未就绪
  "CHANNEL_BIZ_ERROR",    // 上游业务错误（多为风控/过载，瞬时性问题换渠道可解）
  "UNSUPPORTED_CHANNEL",  // 渠道类型未注册/配置错误：属于该渠道自身问题，应跳过换下一个
  "CHANNEL_CONFIG_ERROR", // 订阅渠道的部署配置缺失（如 Google OAuth 密钥未配置）：跳过该渠道
  "CHANNEL_DEGRADED",     // 上游降智/过载信号（codex-state-kit）：立即换号，短冷却后重试
  "CHANNEL_POW_FAILED",   // PoW 求解失败（worker 崩溃/超时）：换号往往能拿到更简单的挑战
  // 限流/风控（429 与「返回验证页的 403」）—— 可自愈，冷却后重试；
  // 归到普通 HTTP 错误会让冷却档位与提示都失准（见 upstream/http-error.js）
  "CHANNEL_RATE_LIMITED",
  // 上游 5xx（503 Service is too busy 等）：上游瞬时过载，与「渠道坏了」是两回事。
  // 必须可重试，否则一次上游抖动就把请求直接推给用户，而换个渠道往往立刻成功。
  "CHANNEL_UPSTREAM_BUSY",
  // 403 权限不足（免费号用了付费模型档位）：换号或换模型可解，重抓凭据无效
  "CHANNEL_FORBIDDEN",
  // 上游把该账号标记为「未批准的调用渠道」（WorkBuddy 11128/11140 实测，2026-09-26）：
  // 账号级风控，凭据本身有效 —— 换个渠道（账号）往往就能过，重绑凭据无效。
  // 长冷却见 cooldownFor（6h）；刻意**不进** AUTO_PAUSE_CODES：自动恢复（T1）
  // 上线前，自动停用等于永久下线。
  "CHANNEL_NOT_APPROVED",
]);

export function isRetryable(code) {
  return RETRYABLE.has(code);
}

// 这些错误在模型请求前的能力/配置检查就会抛出，不能因为进过 adapter.chat
// 就估算收取输入费。适配器也可显式带 upstreamStarted=false 标记本地拒绝。
const LOCAL_REJECTION_CODES = new Set([
  "VISION_NOT_SUPPORTED",
  "CHANNEL_UNSUPPORTED",
  "UNSUPPORTED_CHANNEL",
  "CHANNEL_CONFIG_ERROR",
  "CHANNEL_NOT_READY",
]);

/**
 * 执行一次对话。会按优先级依次尝试可用渠道，首个成功的渠道返回结果。
 * @param {object} opts
 * @param {string} opts.model         请求的模型名（真实模型或兼容别名）
 * @param {string} opts.prompt        拼装后的提示词
 * @param {boolean} opts.thinking     是否深度思考（undefined = 用模型默认）
 * @param {boolean} opts.search       是否联网搜索
 * @param {Array}  opts.images        [{buffer,filename,mimeType}]
 * @param {Function} opts.onDelta     内容增量回调
 * @param {Function} opts.onReasoning 思考增量回调
 * @param {AbortSignal} opts.signal
 * @param {string} opts.groupName     用户分组（过滤渠道）
 * @param {Set}    opts.excludeChannelIds 已试过的渠道 id
 * @param {Function} opts.onChannelTry 每次尝试渠道前回调
 * @param {string} opts.sessionId     调用方会话；未提供时仅本次调用共享，不能退回渠道级会话
 * @param {string} opts.requestId     本次逻辑调用的标识
 */
export async function runCompletion({
  tools = [], toolChoice, onToolCall, prepareRequest,
  model,
  prompt,
  messages = null,
  thinking,
  reasoningEffort = "",
  maxOutputTokens,
  search = false,
  images = [],
  onDelta,
  onReasoning,
  onSearchStatus,
  signal,
  groupName = null,
  channelType = "",
  excludeChannelIds = null,
  onChannelTry,
  user = null,
  sessionId = "",
  requestId = "",
}) {
  await assertModelPriced(model);
  const capabilities = modelCapabilities(model);
  const clientContext = clientAgentContext();
  const agentRule = clientContext?.rule;
  const requestedReasoning = agentReasoning(agentRule, reasoningEffort, capabilities);
  let reasoningConfig;
  try { reasoningConfig = reasoningSelection(model, requestedReasoning); }
  catch (e) { e.reasoningEffort = requestedReasoning; throw e; }
  if (clientContext) clientContext.applied = reasoningConfig.level || "default";
  const outputLimit = maxOutputTokens ? Math.min(Number(maxOutputTokens), Number(capabilities.maxOutputTokens) || Infinity) : capabilities.customized ? capabilities.maxOutputTokens || undefined : undefined;
  const runStartedAt = Date.now();
  // 重试沿用同一次调用的上下文；无会话头的 API 请求各自独立，避免不同用户共用渠道会话。
  const callRequestId = requestId || crypto.randomUUID();
  const callSessionId = sessionId || callRequestId;
  const tried = new Set(excludeChannelIds instanceof Set ? excludeChannelIds : []);
  // 渠道声明的是真实模型名：先把兼容别名归一化再匹配，
  // 否则 kimi-latest / qwen-turbo 这类别名请求会直接 NO_CHANNEL
  const matchName = resolveAliasSync(model);
  const channels = orderAgentChannels(await selectChannels({ model: matchName, excludeIds: tried, groupName, channelType }), agentRule);

  if (!channels.length) {
    // 区分「没有渠道支持这个模型」和「渠道都在冷却」，否则排查方向会完全跑偏。
    // displayModel 传原始请求名：报错要回显用户写的那个名字，而不是归一化后的
    //（否则用户会去查一个自己没写过的模型名 —— 见 explainNoChannel 的注释）。
    const why = await explainNoChannel({ model: matchName, displayModel: model, groupName, channelType }).catch(() => null);
    throw Object.assign(
      new Error(why?.message || `没有可用渠道支持模型「${model}」，请在渠道管理中添加或启用对应渠道`),
      { code: "NO_CHANNEL", reason: why?.reason, model, billable: false, retryCount: 0, elapsed: Date.now() - runStartedAt }
    );
  }

  let lastError = null;

  // 单渠道超时：取后台设置（request_timeout_ms），而不是整条重试链共用一个时限。
  // 否则第一个渠道耗掉大部分预算后，后续渠道会「秒败」。
  const timeoutMs = agentRule?.timeoutMs ?? Math.max(1000, getNumberOption("request_timeout_ms") || 600000);

  // 重试预算：`retry_times` 设置项此前是死配置（没有任何代码读取），
  // 实际重试次数等于「匹配到的渠道总数」——10 个渠道集体故障时，
  // 单个客户端请求最坏会挂 10 × timeoutMs（默认 10 分钟 = 100 分钟），
  // 而客户端早就断开了，服务端还在逐个试错、逐个写渠道错误。
  // 语义：retry_times = 换渠道重试次数，故总尝试次数 = retry_times + 1（至少试 1 个）。
  const retryTimes = agentRule?.retries ?? Math.max(0, Math.min(10, Number(getNumberOption("retry_times")) || 0));
  const maxAttempts = Math.min(channels.length, retryTimes + 1);

  let attempts = 0;
  // 传输是否开始仅供排查，不能作为收费证据。
  let upstreamStarted = false;
  let internalRetries = 0;
  for (const channel of channels) {
    if (attempts >= maxAttempts) {
      // 预算用尽：带上最后一个错误抛出，让调用方看到真实失败原因
      // （而不是「所有渠道都不可用」这种误导性结论）
      console.warn(`[execute] 已达重试上限（${maxAttempts} 个渠道），停止换号`);
      break;
    }
    attempts += 1;
    tried.add(channel.id);
    if (onChannelTry) onChannelTry(channel);

    const started = Date.now();
    let attemptQuote = channelPriceQuote(channel, { model, at: started });
    let sawOutput = false;
    let timedOut = false;
    let attemptStarted = false;
    let callStarted = 0;
    let firstTokenAt = 0;
    let attemptContent = "";
    let attemptReasoning = "";
    let attemptTools = "", prepared = null;
    const attemptToolCalls = new Map();
    let attemptUsage = null;
    let settled = false;

    // 组合「客户端断开」与「单渠道超时」两个中止源
    const attemptCtrl = new AbortController();
    const onOuterAbort = () => attemptCtrl.abort();
    if (signal) {
      if (signal.aborted) attemptCtrl.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    const endpointAudit = { endpoints: [], closed: false };
    try {
      const adapter = await getAdapter(channel);
      const key = adapterKeyFor(channel);
      const nativeTools = ["openai-compat", "anthropic-compat", "cline", "opencode", "kiro", "codex", "claude-oauth", "antigravity", "grok", "workbuddy", "qoder", "zcode", "autoclaw"].includes(key)
        && !(key === "opencode" && /(?:^|\/)jev-/i.test(model));
      if (tools.length && !nativeTools && !prepareRequest) throw Object.assign(new Error("当前渠道不支持原生工具调用"), { code: "TOOLS_NOT_SUPPORTED", upstreamStarted: false });
      prepared = prepareRequest ? prepareRequest({ nativeTools, channel }) : { prompt, messages };
      let hardTimer;
      let backstopTimer;
      let armDeadline = () => {};
      // race 是否已结束。用它防住一个隐蔽的定时器泄漏：
      // backstop 先触发（深队列时排队就超时）后，排队中的任务稍后才真正开始执行并调用
      // armDeadline()，那个 hardTimer 在 finally 之后才创建，没人清理，会空转一整个
      // timeoutMs（默认 10 分钟）并再次 abort + 把 timedOut 置真。
      // 两段计时：
      //   · hardTimer 只包住真正的上游调用（排队不算，避免黄条失真/没发请求就超时）；
      //   · backstopTimer 覆盖「排队 + 调用」，防止同渠道前序任务悬挂导致本请求永远排不到队头。
      const deadline = new Promise((_, reject) => {
        // 错误消息只带渠道编号，不带渠道名：这条消息会原样返回给 API 调用方、
        // 也会进普通用户可见的错误日志，而渠道名常是账号邮箱（上游供应商身份）。
        // 管理员在日志的 channel_name 列与渠道最近调用里都能看到真实名称。
        const timeoutError = () =>
          Object.assign(new Error(`上游渠道 #${channel.id} 响应超时（${timeoutMs}ms）`), { code: "CHANNEL_TIMEOUT" });
        const fire = () => {
          if (settled) return;
          timedOut = true;
          attemptCtrl.abort();
          reject(timeoutError());
        };
        armDeadline = () => {
          if (settled) return;
          hardTimer = setTimeout(fire, timeoutMs);
        };
        backstopTimer = setTimeout(fire, timeoutMs + 5 * 60 * 1000);
      });
      const result = await Promise.race([
        withChannelLimit(channel, () => {
          // 排队期间可能已经被 backstop 判超时：这时不必再发请求（上游会被 abort 立刻打断）
          if (settled) return Promise.reject(Object.assign(new Error("渠道排队超时"), { code: "CHANNEL_TIMEOUT" }));
          if (attemptCtrl.signal.aborted) {
            return Promise.reject(Object.assign(new Error("请求已取消"), { code: "ABORTED", upstreamStarted: false }));
          }
          callStarted = Date.now();
          attemptQuote = channelPriceQuote(channel, { model, at: callStarted });
          armDeadline();
          // 先记进入适配器；失败时再排除明确本地拒绝，决定是否补收上下文。
          attemptStarted = true;
          return withEndpointAudit(endpointAudit, () => adapter.chat({
            channel,
            model,
            prompt: prepared.prompt,
            messages: prepared.messages,
            tools: nativeTools ? tools : [], toolChoice: nativeTools ? toolChoice : undefined,
            onToolCall: (call) => {
              if (settled) return;
              sawOutput = true;
              attemptToolCalls.set(call.index ?? call.id, call);
              attemptTools = callsText([...attemptToolCalls.values()]);
              if (!firstTokenAt) firstTokenAt = Date.now();
              onToolCall?.(call);
            },
            sessionId: callSessionId,
            requestId: callRequestId,
            userId: user?.id,
            thinkingOverride: reasoningConfig.disabled ? false : reasoningConfig.level ? undefined : thinking,
            reasoningConfig,
            maxOutputTokens: outputLimit,
            search,
            images,
            signal: attemptCtrl.signal,
            onDelta: (t) => {
              if (settled || !t) return;
              sawOutput = true;
              attemptContent += t;
              if (!firstTokenAt) firstTokenAt = Date.now();
              if (onDelta) onDelta(t);
            },
            onReasoning: (t) => {
              if (settled || !t) return;
              sawOutput = true;
              attemptReasoning += t;
              if (!firstTokenAt) firstTokenAt = Date.now();
              if (onReasoning) onReasoning(t);
            },
            onUsage: (u) => { if (!settled) attemptUsage = u; },
            onSearchStatus: (s) => {
              if (onSearchStatus) onSearchStatus(s);
            },
          }));
        }),
        deadline,
      ]).finally(() => {
        settled = true;
        endpointAudit.closed = true;
        clearTimeout(hardTimer);
        clearTimeout(backstopTimer);
      });
      attemptUsage = result.usage ?? attemptUsage;
      internalRetries += Math.max(0, Number(result.retryCount) || 0);
      if (!result.content && !result.reasoning && !result.toolCalls?.length) {
        throw Object.assign(new Error("上游返回空内容"), { code: "CHANNEL_EMPTY", usage: attemptUsage,
          status: result.httpStatus, upstreamModel: result.upstreamModel, billModel: result.billModel });
      }

      // 渠道运行时统计与响应内容无关（也不影响计费）：不 await，
      // 否则多一次 DB 往返会推迟流式响应的收尾。失败只记日志。
      markChannelOk(channel, Date.now() - (callStarted || started), {
        prompt,
        reply: result.content || result.reasoning || "",
        // codex-state-kit：记录本轮是否降智 / 是否携带 292 通行证（tip 展示）。
        // **必须显式区分「不支持检测」与「检测为否」**：
        // `result.rotateNext ? 1 : 0` 对不支持该机制的适配器（除 codex 外全部）
        // 恒为 0，而 0 是**已定义值** —— 于是每个厂商的每次调用都会带上 `d:0`，
        // 前端「降智状态：否」那一行就出现在所有渠道上（用户实测：
        // 「这个降智方案是只有 gpt 才有的吧，为什么我现在看很多都有」）。
        // 这里改成与下一行 state 同样的处理：适配器没给就写 undefined（不落库、不展示）。
        degraded: result.rotateNext === undefined ? undefined : result.rotateNext ? 1 : 0,
        state: result.stateUsed === undefined ? undefined : result.stateUsed ? 1 : 0,
        kind: "chat",
        // 最近调用里显示调用方（管理端头像+名字，点击复制邮箱）
        user,
        // DeepSeek 托管端点的安全审核标注被剥离（vendor-quirks stripDsSafety）：
        // 最近调用记 safe=1（tip 展示「触发了 safe 机制」），渠道上落 last_safe_at。
        safe: result.safetyStripped ? 1 : undefined,
      }).catch((e) => console.warn(`[execute] 渠道统计更新失败：${e.code || "DB_ERROR"}`));
      // 渠道级标记：最近一次触发 safe 的时刻（凭证列的小 tag 用）。
      // JSON_SET 原位更新 other，不整包读改写；失败无碍主流程。
      if (result.safetyStripped) {
        pool
          .query("UPDATE channels SET other = JSON_SET(other, '$.last_safe_at', ?) WHERE id = ?", [Date.now(), channel.id])
          .catch(() => {});
      }
      await persistProfile(channel, result);
      // codex-state-kit：命中「思考截断/降智」指纹时内容照常返回，但给渠道一个短冷却，
      // 让后续请求优先换号（避免连续拿到降智/过载响应）。
      if (result?.rotateNext) {
        await markChannelError(
          channel,
          String(result.rotateReason || "上游降智信号").slice(0, 400),
          Math.min(3600, Math.max(30, Number(result.rotateCooldownSec) || 90)),
          // 与成功记录一样带上来源与调用者：否则这条在「最近调用」里既没有 tag 也没有用户名
          {
            prompt,
            reply: String(result.rotateReason || "上游降智信号"),
            degraded: 1,
            kind: "chat",
            user,
          }
        );
      }
      return { ...result, endpointAttempts: endpointAudit.attempts || [], reasoningRequested: reasoningEffort, upstreamEndpoints: endpointAudit.endpoints, reasoningEffort: reasoningConfig.level || (thinking === true ? "enabled" : thinking === false ? "disabled" : "default"), reasoningApplied: result.reasoningApplied === true, toolMode: nativeTools ? "native" : "text", requestPrompt: prepared.billingPrompt || prepared.prompt, channel, channelQuote: attemptQuote, startedAt: callStarted || started, firstTokenAt,
        retryCount: attempts - 1 + internalRetries, elapsed: Date.now() - runStartedAt };
    } catch (err) {
      lastError = tagChannel(err, channel);
      endpointAudit.closed = true;
      lastError.upstreamEndpoints = endpointAudit.endpoints;
      lastError.endpointAttempts = endpointAudit.attempts || [];
      lastError.reasoningRequested = reasoningEffort;
      lastError.reasoningEffort = reasoningConfig.level || (thinking === true ? "enabled" : thinking === false ? "disabled" : "default");
      // 停止也要保留已消耗上下文的证据；原先在赋值前 throw，首步停止会漏账。
      // 已输出内容优先于错误分类（它直接证明模型请求已开始）。
      if (sawOutput || (attemptStarted && err.upstreamStarted !== false && !LOCAL_REJECTION_CODES.has(err.code))) {
        upstreamStarted = true;
      }
      lastError.upstreamStarted = upstreamStarted;
      // 本渠道超时：转换为可重试错误，换下一个渠道（消息同样只带编号，不带渠道名）
      if (timedOut) {
        lastError = tagChannel(
          Object.assign(new Error(`上游渠道 #${channel.id} 响应超时（${timeoutMs}ms）`), lastError, {
            code: "CHANNEL_TIMEOUT",
          }),
          channel
        );
      }
      // 计费上下文：这一轮是否真的打到过上游（决定失败时要不要补收）。
      // 挂在同一个错误对象上，随 throw 冒泡到站内对话的结算逻辑。
      lastError.upstreamStarted = upstreamStarted;
      internalRetries += Math.max(0, Number(err.retryCount) || 0);
      lastError.usage = err.usage ?? attemptUsage;
      lastError.content = err.content ?? attemptContent;
      lastError.reasoning = err.reasoning ?? attemptReasoning;
      lastError.billingOutput = String(err.billingOutput ?? `${lastError.content || ""}${lastError.reasoning || ""}${callsText(err.toolCalls) || attemptTools}`);
      lastError.billingPrompt = String(err.billingPrompt ?? prepared?.billingPrompt ?? prepared?.prompt ?? prompt ?? "");
      lastError.billingStartedAt = Number(err.billingStartedAt) || callStarted || started;
      lastError.billingFirstTokenAt = Number(err.billingFirstTokenAt || err.firstTokenAt) || firstTokenAt;
      lastError.firstTokenAt = lastError.billingFirstTokenAt;
      lastError.model = err.model || model;
      lastError.channelQuote = attemptQuote;
      lastError.elapsed = Date.now() - runStartedAt;
      lastError.retryCount = attempts - 1 + internalRetries;
      lastError.billable = Boolean(lastError.billingOutput) || hasBillableUsage(lastError.usage);
      // 客户端主动断开：先保留消耗证据，再结束；不把零输出停止估成整段输入费。
      if (signal?.aborted) throw lastError;
      const code = lastError.code || "CHANNEL_ERROR";

      // 已经输出或报告真实用量就不能换渠道（否则会拼接内容或漏掉上一尝试的账单），
      // 但故障渠道仍要冷却与记录，否则下一请求还会优先命中它、反复失败。
      // 冷却用与下方同一条计算函数：已流出内容只决定「不换渠道」，不该影响「冷却多久」——
      // 之前这里硬编码 300s，会把 DeepSeek WAF（6h）、429（15min）等档位压成 5 分钟，
      // 等于立刻回去撞同一个账号。
      if (sawOutput || lastError.billable) {
        await markChannelError(channel, lastError.message, cooldownFor(code, lastError), {
          prompt,
          reply: lastError.message,
          kind: "chat",
          user,
          errorCode: code,
        }).catch(() => {});
        throw lastError;
      }

      // 参数类错误（模型不支持看图等）不重试，直接抛给用户。
      // 但没带 code 的异常（Playwright 原生报错、TypeError 等）无法判断性质，
      // 按基础设施故障处理：换下一个渠道往往就能成功，比直接 500 更合理。
      const judgeable = Boolean(lastError.code);
      if (judgeable && !isRetryable(code)) throw lastError;

      await markChannelError(channel, lastError.message, cooldownFor(code, lastError), {
        prompt,
        reply: lastError.message,
        kind: "chat",
        user,
        // 带上错误码：不可自愈的错误（凭据失效/被封/权限不足）由 router 自动暂停渠道
        errorCode: code,
      });
      // 监控页「账号切换率」：每换一次号记一次，趋势突然抬升说明渠道集体不稳
      recordChannelSwitch();
      console.warn(`[execute] 渠道「${channel.name}」失败（${code}），切换下一渠道`);
    } finally {
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
  }

  throw lastError || Object.assign(new Error("所有渠道均不可用"), { code: "NO_CHANNEL" });
}

/**
 * 失败后的冷却时长（秒）。两条失败路径（已输出内容 / 未输出）共用同一口径。
 * 分档依据是「这个渠道能不能自己恢复」：
 *   · 适配器自带 cooldownSec（grok 免费额度 24h、codex 降智 90s）优先；
 *   · 风控（WAF）：需要人工处理或等待较久，冷却太短等于反复去撞，会把临时限制升级成封禁；
 *   · 验证码：通常要人过，给 1 小时；
 *   · 登录态失效：6 小时（等管理员重新登录，期间不再浪费请求）；
 *   · 渠道类型未注册/配置缺失：不会自愈，给 6 小时，避免每次请求都遍历一遍坏渠道；
 *   · 其余瞬时错误：5 分钟。
 */
function cooldownFor(code, err) {
  const requested = Number(err?.cooldownSec);
  if (Number.isFinite(requested) && requested > 0) return Math.min(86400, Math.max(30, Math.floor(requested)));
  switch (code) {
    case "CHANNEL_EMPTY":
      return Math.min(300, Math.max(1, getNumberOption("gateway_empty_cooldown_seconds") || 30));
    case "CHANNEL_MUTED":
      return 1800;
    case "CHANNEL_AUTH_EXPIRED":
    case "CHANNEL_WAF":
    case "UNSUPPORTED_CHANNEL":
    case "CHANNEL_CONFIG_ERROR":
      return 21600;
    // 账号被上游标记为「未批准渠道/风控拦截」：账号级状态，短时间内不会自愈，
    // 但也不是死罪（腾讯对新账号的首次调用常见，等账号信誉爬上来就好了）——
    // 与登录态失效同档 6h，期间流量由其他渠道承担。
    case "CHANNEL_NOT_APPROVED":
      return 21600;
    case "CHANNEL_CAPTCHA":
      return 3600;
    // 限流：可自愈，冷却后重试。**两个错误码都要覆盖** —— 适配器侧抛
    // CHANNEL_RATE_LIMIT（无 D），http-error.js 归类出 CHANNEL_RATE_LIMITED（有 D）。
    // 此前只写了带 D 的版本，不带 D 的那条（也就是 429 的绝大多数来源）靠
    // `default: 300` 巧合对上同档数值；一旦有人调整 default 就会静默漂移。
    case "CHANNEL_RATE_LIMIT":
    case "CHANNEL_RATE_LIMITED":
      return 300;
    // 权限不足：不是渠道坏了，是模型档位不对 —— 给短冷却，
    // 让它在换个模型时能立刻复用（长冷却会把好账号也冻住）
    case "CHANNEL_FORBIDDEN":
      return 300;
    default:
      return 300;
  }
}

/**
 * 给错误挂上「最后尝试的渠道」身份。
 * 为什么需要：错误日志（type=4）要能归因到具体渠道，否则「渠道成功率」这类
 * 看板指标只能靠最近 20 条环形缓冲（recent_calls）估算，按天/周维度完全失真。
 * 挂在 error 对象上而不是包装新错误：调用方（gateway/chat）需要保留原始 message 与 code。
 */
function tagChannel(err, channel) {
  if (!err || !channel) return err;
  try {
    if (!err.channelId) {
      err.channelId = Number(channel.id) || 0;
      err.channelName = String(channel.name || "");
    }
  } catch {
    /* 冻结对象等极端情况：不影响主流程 */
  }
  return err;
}

/**
 * 指纹持久化闭环：适配器首次生成指纹后返回 profileNeedPersist=true，
 * 这里把它写回 channels.other.profile，保证同一账号后续请求指纹固定。
 */
async function persistProfile(channel, result) {
  if (!result?.profileNeedPersist || !result?.profile) return;
  try {
    // 不能直接用选渠道时的旧快照整体覆盖：请求耗时期间管理员可能更新了
    // cookies/登录态，旧快照写回会把那次变更静默回滚。写前重读一次最新值再合并。
    const [rows] = await pool.query("SELECT other FROM channels WHERE id = ?", [channel.id]);
    let latest = {};
    try {
      latest = rows[0]?.other ? JSON.parse(rows[0].other) : {};
    } catch {
      latest = {};
    }
    latest.profile = result.profile;
    await pool.query("UPDATE channels SET other = ? WHERE id = ?", [JSON.stringify(latest), channel.id]);
    channel.other = latest;
  } catch (e) {
    console.warn(`[execute] 渠道「${channel.name}」指纹持久化失败：${e.code || "DB_ERROR"}`);
  }
}
