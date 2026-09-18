// 统一执行器：模型 → 渠道选择 → 失败切换 → 返回结果
// 网关（/v1）与站内对话/智能体共用此逻辑，保证行为一致。
import { pool } from "../db.js";
import { getNumberOption } from "../config.js";
import { selectChannels, getAdapter, markChannelError, markChannelOk, withChannelLimit, explainNoChannel } from "./router.js";
import { resolveAliasSync } from "./models.js";

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
]);

export function isRetryable(code) {
  return RETRYABLE.has(code);
}

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
 */
export async function runCompletion({
  model,
  prompt,
  messages = null,
  thinking,
  search = false,
  images = [],
  onDelta,
  onReasoning,
  onSearchStatus,
  signal,
  groupName = null,
  excludeChannelIds = null,
  onChannelTry,
}) {
  const tried = new Set(excludeChannelIds instanceof Set ? excludeChannelIds : []);
  // 渠道声明的是真实模型名：先把兼容别名归一化再匹配，
  // 否则 kimi-latest / qwen-turbo 这类别名请求会直接 NO_CHANNEL
  const matchName = resolveAliasSync(model);
  const channels = await selectChannels({ model: matchName, excludeIds: tried, groupName });

  if (!channels.length) {
    // 区分「没有渠道支持这个模型」和「渠道都在冷却」，否则排查方向会完全跑偏
    const why = await explainNoChannel({ model: matchName, groupName }).catch(() => null);
    throw Object.assign(
      new Error(why?.message || `没有可用渠道支持模型「${model}」，请在渠道管理中添加或启用对应渠道`),
      { code: "NO_CHANNEL", reason: why?.reason }
    );
  }

  let lastError = null;

  // 单渠道超时：取后台设置（request_timeout_ms），而不是整条重试链共用一个时限。
  // 否则第一个渠道耗掉大部分预算后，后续渠道会「秒败」。
  const timeoutMs = Math.max(1000, getNumberOption("request_timeout_ms") || 600000);

  for (const channel of channels) {
    tried.add(channel.id);
    if (onChannelTry) onChannelTry(channel);

    const started = Date.now();
    let sawOutput = false;
    let timedOut = false;

    // 组合「客户端断开」与「单渠道超时」两个中止源
    const attemptCtrl = new AbortController();
    const onOuterAbort = () => attemptCtrl.abort();
    if (signal) {
      if (signal.aborted) attemptCtrl.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    try {
      const adapter = await getAdapter(channel);
      let hardTimer;
      // 硬截止：Playwright 内部调用（evaluate/fill 等）不一定响应 abort，
      // 只靠 signal 会让请求在适配器里无限悬挂。这里用 Promise.race 保证
      // 到点一定推进到下一个渠道（底层任务随后自行 abort 收尾）。
      const result = await Promise.race([
        withChannelLimit(channel, () =>
          adapter.chat({
            channel,
            model,
            prompt,
            messages,
            thinkingOverride: thinking,
            search,
            images,
            signal: attemptCtrl.signal,
            onDelta: (t) => {
              sawOutput = true;
              if (onDelta) onDelta(t);
            },
            onReasoning: (t) => {
              sawOutput = true;
              if (onReasoning) onReasoning(t);
            },
            onSearchStatus: (s) => {
              if (onSearchStatus) onSearchStatus(s);
            },
          })
        ),
        new Promise((_, reject) => {
          hardTimer = setTimeout(() => {
            timedOut = true;
            attemptCtrl.abort();
            reject(
              Object.assign(new Error(`渠道「${channel.name}」响应超时（${timeoutMs}ms）`), { code: "CHANNEL_TIMEOUT" })
            );
          }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(hardTimer));

      await markChannelOk(channel, Date.now() - started, {
        prompt,
        reply: result.content || result.reasoning || "",
        // codex-state-kit：记录本轮是否降智 / 是否携带 292 通行证（tip 展示）
        degraded: result.rotateNext ? 1 : 0,
        state: result.stateUsed === undefined ? undefined : result.stateUsed ? 1 : 0,
      });
      await persistProfile(channel, result);
      // codex-state-kit：命中「思考截断/降智」指纹时内容照常返回，但给渠道一个短冷却，
      // 让后续请求优先换号（避免连续拿到降智/过载响应）。
      if (result?.rotateNext) {
        await markChannelError(
          channel,
          String(result.rotateReason || "上游降智信号").slice(0, 400),
          Math.min(3600, Math.max(30, Number(result.rotateCooldownSec) || 90))
        );
      }
      return { ...result, channel, elapsed: Date.now() - started };
    } catch (err) {
      lastError = err;
      // 客户端主动断开：不再换渠道，直接结束
      if (signal?.aborted) throw err;
      // 本渠道超时：转换为可重试错误，换下一个渠道
      if (timedOut) {
        lastError = Object.assign(new Error(`渠道「${channel.name}」响应超时（${timeoutMs}ms）`), {
          code: "CHANNEL_TIMEOUT",
        });
      }
      const code = lastError.code || "CHANNEL_ERROR";

      // 已经流式输出过内容就不能换渠道了（否则客户端会收到拼接错乱的内容）
      if (sawOutput) throw lastError;

      // 参数类错误（模型不支持看图等）不重试，直接抛给用户。
      // 但没带 code 的异常（Playwright 原生报错、TypeError 等）无法判断性质，
      // 按基础设施故障处理：换下一个渠道往往就能成功，比直接 500 更合理。
      const judgeable = Boolean(lastError.code);
      if (judgeable && !isRetryable(code)) throw lastError;

      // 标记渠道异常并冷却，尝试下一个。
      // 适配器可自带 cooldownSec（如 grok 免费额度用尽要冷却 24h、codex 降智只冷却 90s）
      const requestedCooldown = Number(lastError?.cooldownSec);
      const cooldown =
        Number.isFinite(requestedCooldown) && requestedCooldown > 0
          ? Math.min(86400, Math.max(30, Math.floor(requestedCooldown)))
          : code === "CHANNEL_MUTED"
            ? 1800
            : code === "CHANNEL_AUTH_EXPIRED"
              ? 21600
              : 300;
      await markChannelError(channel, lastError.message, cooldown, { prompt, reply: lastError.message });
      console.warn(`[execute] 渠道「${channel.name}」失败（${code}），切换下一渠道：${lastError.message}`);
    } finally {
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
  }

  throw lastError || Object.assign(new Error("所有渠道均不可用"), { code: "NO_CHANNEL" });
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
    console.warn(`[execute] 渠道「${channel.name}」指纹持久化失败：${e.message}`);
  }
}
