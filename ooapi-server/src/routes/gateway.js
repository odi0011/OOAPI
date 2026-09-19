// OpenAI 兼容网关：/v1/chat/completions、/v1/models
// 按模型路由到渠道，OD 币 1:1 计费。
import express from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { getBoolOption } from "../config.js";
import { now, clientIp, asyncHandler, assertPublicUrl } from "../utils.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { recordRequest, enterRequest, leaveRequest } from "../services/metrics.js";
import { runCompletion } from "../services/execute.js";
import { getPrice, computeCost, splitTokens, effectivePrice, UNITS_PER_OD, CURRENCY } from "../services/pricing.js";
import { groupConfigOf, applyGroupRate } from "../services/group-rate.js";
import { allPublicModels, modelForChannelMatch, resolveAliasSync } from "../services/models.js";
import { collectAvailableModels } from "../services/router.js";

const router = express.Router();
// 必须在 express.json 之前完成真实鉴权：旧实现只查 Authorization 头存在性，
// 伪造任意 Bearer 就能让匿名请求先被缓冲/解析 50MB 大包（内存/CPU DoS）。
router.use(
  asyncHandler(async (req, res, next) => {
    const auth = await authorize(req, res);
    if (!auth) return; // authorize 已写出 401/403
    req.auth = auth;
    next();
  })
);
router.use(express.json({ limit: "50mb" }));

// ---------- 对外可用模型列表（平台真实模型 + 兼容别名）----------
// 与 OpenAI 一致需要鉴权，避免匿名枚举全量模型目录
router.get(
  "/models",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) return;
    const [rows] = await pool.query("SELECT * FROM channels WHERE status = 1");
    // 可用模型 = 各渠道「显式声明的模型」∪「models 留空渠道所属厂商的全部模型」。
    // 不能只看 models 字段：留空代表该厂商全部模型，漏掉这部分会让客户端看不到能调的模型。
    const available = collectAvailableModels(rows);
    const all = await allPublicModels();
    const list = all.filter((m) => available.has(m.id.toLowerCase()) || available.has("*") || available.size === 0);
    res.json({
      object: "list",
      data: list.map((m) => ({
        id: m.id,
        object: "model",
        // owned_by 用厂商类型，便于客户端区分模型来源
        owned_by: m.aliasOf ? m.vendor : m.vendor || m.aliasOf || "unknown",
        ...(m.vendorName ? { vendor_name: m.vendorName } : {}),
        ...(m.aliasOf ? { alias_of: m.aliasOf, deprecated: true } : {})}))});
  })
);

// ---------- 令牌鉴权 ----------
async function authorize(req, res) {
  const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw) {
    res.status(401).json({ error: { message: "缺少 API Key，请携带 Authorization: Bearer sk-xxx", type: "invalid_request_error" } });
    return null;
  }
  const [rows] = await pool.query("SELECT * FROM tokens WHERE key_str = ? LIMIT 1", [raw]);
  const token = rows[0];
  if (!token) {
    res.status(401).json({ error: { message: "API Key 无效", type: "invalid_request_error" } });
    return null;
  }
  if (token.status !== 1) {
    res.status(403).json({ error: { message: "该 API Key 已被禁用或过期", type: "invalid_request_error" } });
    return null;
  }
  const exp = Number(token.expired_time);
  if (exp !== -1 && exp > 0 && exp < now()) {
    await pool.query("UPDATE tokens SET status = 3 WHERE id = ?", [token.id]).catch(() => {});
    res.status(403).json({ error: { message: "该 API Key 已过期", type: "invalid_request_error" } });
    return null;
  }
  const [uRows] = await pool.query("SELECT * FROM users WHERE id = ? LIMIT 1", [token.user_id]);
  const user = uRows[0];
  if (!user) {
    res.status(401).json({ error: { message: "令牌所属用户不存在", type: "invalid_request_error" } });
    return null;
  }
  if (user.status !== 1) {
    res.status(403).json({ error: { message: "账号已被禁用", type: "invalid_request_error" } });
    return null;
  }
  if (!token.unlimited_quota && Number(token.remain_quota) <= 0) {
    res.status(403).json({ error: { message: "该 API Key 额度已用尽", type: "insufficient_quota", code: "insufficient_quota" } });
    return null;
  }
  if (Number(user.quota) <= 0) {
    res.status(403).json({
      error: { message: `账户 ${CURRENCY} 币余额不足，请联系管理员充值`, type: "insufficient_user_quota", code: "insufficient_user_quota" }});
    return null;
  }
  return { token, user };
}

function modelAllowed(token, model) {
  const limits = String(token.model_limits || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!limits.length) return true;
  return limits.some((l) => model === l || model.startsWith(l));
}

// messages → prompt（DeepSeek 网页版多轮分隔符；其他渠道由适配器决定如何使用）
function messagesToPrompt(messages) {
  let prompt = "";
  for (const m of messages || []) {
    // 元素可能为 null/字符串（调用方伪造）：跳过而不是抛 500
    if (!m || typeof m !== "object") continue;
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("")
          : String(m.content ?? "");
    const role = (m.role || "user").toLowerCase();
    if (role === "system" || role === "developer") prompt += content + "\n";
    else if (role === "assistant") prompt += "<｜Assistant｜>" + content + "<｜end▁of▁sentence｜>";
    else prompt += "<｜User｜>" + content;
  }
  return prompt || "你好";
}

// ---------- SSRF 防护：图片外链只允许公网 http(s)（isPrivateIp/assertPublicUrl 在 utils.js）----------
// 抓取远程图片：逐跳校验（防重定向 SSRF），限制类型与大小
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// 不依赖 content-length 的有界读取：分块响应没有该头，边读边计数，超限立即取消
async function readBodyCapped(resp, max) {
  const reader = resp.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
async function fetchRemoteImage(rawUrl) {
  let target = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(target);
    const r = await fetch(u, { signal: AbortSignal.timeout(30000), redirect: "manual" });
    // 所有提前返回都要取消响应体：否则 undici 连接一直挂着，反复触发会耗尽连接池
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      await r.body?.cancel().catch(() => {});
      if (!loc) return null;
      target = new URL(loc, u).toString();
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    // 先看 Content-Length 再决定下不下载：超大图直接跳过，避免白耗带宽
    const cl = Number(r.headers.get("content-length") || 0);
    if (cl > MAX_IMAGE_BYTES) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    const ab = await readBodyCapped(r, MAX_IMAGE_BYTES);
    if (!ab) return null;
    const mimeType = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("image/")) return null;
    return { buffer: ab, mimeType, filename: mimeType.includes("png") ? "image.png" : "image.jpg" };
  }
  return null;
}

// 只数图片数量，不抓取（用于超限时快速拒绝，避免对上白张外链发请求）
function countImageParts(messages) {
  let count = 0;
  for (const m of messages || []) {
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type === "image_url") count += 1;
    }
  }
  return count;
}

async function extractImages(messages) {
  const images = [];
  for (const m of messages || []) {
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type !== "image_url") continue;
      const url = part.image_url?.url ?? "";
      if (!url) continue;
      const mm = /^data:([^;]+);base64,(.+)$/s.exec(url);
      if (mm) {
        // base64 长度约等于字节数 ×4/3，先用字符串长度挡掉超大图再解码
        if (mm[2].length > MAX_IMAGE_BYTES * 1.4) continue;
        images.push({
          buffer: Buffer.from(mm[2], "base64"),
          mimeType: mm[1],
          filename: mm[1].includes("png") ? "image.png" : "image.jpg"});
      } else if (/^https?:/i.test(url)) {
        try {
          const img = await fetchRemoteImage(url);
          if (img) images.push(img);
        } catch {
          /* 忽略非法/不可达图片 */
        }
      }
    }
  }
  return images;
}

// 计费 + 日志
async function settle({
  token,
  user,
  model,
  prompt,
  output,
  usage,
  ip,
  requestId,
  channel,
  startedAt = 0,
  firstTokenAt = 0,
  userAgent = ""}) {
  const { promptTokens, completionTokens, cacheTokens } = splitTokens({ prompt, output, upstreamTotal: usage });
  // 兼容别名必须按真实模型计价（否则落到默认兜底档，偏差可达 3~10 倍）
  const basePrice = await getPrice(resolveAliasSync(model));
  // 分时（峰谷）定价：按「请求发起时刻」归属时段，而不是结算时刻 ——
  // 一个 11:59 发起、12:01 结束的请求应当按高峰价算，用结算时刻会差出一倍。
  const eff = effectivePrice(basePrice, startedAt || Date.now());
  const price = eff.price;
  // 分组倍率：Key 绑定分组后按分组倍率计费（rate=1 时不变）；
  // 与分时是两层独立乘数（时段决定单价，倍率决定加价倍数），顺序保持原样
  const gcfg = await groupConfigOf(token?.group_name || user?.group_name);
  const units = applyGroupRate(
    computeCost({
      price,
      promptTokens,
      completionTokens,
      cacheTokens,
      // 账号级计费口径（渠道 other.context_billing）：input_only 的账号不计输出
      // （仅用于「上游按上下文长度计费、不按生成量计费」的账号，会改变用户实际扣费）
      contextBilling: channel?.other?.context_billing || "auto",
    }),
    gcfg?.rate
  );
  const od = (units / UNITS_PER_OD).toFixed(4);

  // 条件扣费：quota >= units 才扣。并发场景下「先读余额再写回」会超额透支，
  // 这里用单条 SQL 保证原子性；余额不足（并发透支）时兜底扣到 0，避免负余额。
  let ret;
  try {
    [ret] = await pool.query(
      "UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ? AND quota >= ?",
      [units, units, user.id, units]
    );
    if (!ret.affectedRows) {
      await pool.query(
        "UPDATE users SET quota = 0, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?",
        [units, user.id]
      );
    }
  } catch (e) {
    // 扣费是否已提交无法确认：调用方据此跳过部分结算，避免重复扣费
    throw Object.assign(new Error(`扣费结果不确定：${e.message}`), { code: "BILLING_UNCERTAIN" });
  }
  // 扣费后的令牌/日志更新是 best-effort：如果这里抛错，调用方 catch 会因
  // settledOnce 还没置位而再次结算，导致用户额度被扣两次。
  if (!token.unlimited_quota) {
    await pool
      .query("UPDATE tokens SET remain_quota = GREATEST(0, remain_quota - ?) WHERE id = ?", [units, token.id])
      .catch((e) => console.error("[gateway] 令牌额度更新失败：", e.message));
  }
  await pool
    .query("UPDATE tokens SET used_quota = used_quota + ?, accessed_time = ? WHERE id = ?", [units, now(), token.id])
    .catch((e) => console.error("[gateway] 令牌用量更新失败：", e.message));
  await writeLog({
    user,
    type: LOG_TYPE.CONSUME,
    content: `调用 ${model} · 提示 ${promptTokens} / 补全 ${completionTokens} tokens${
      cacheTokens ? ` / 缓存 ${cacheTokens}` : ""
    } · ${od} ${CURRENCY}`,
    detail: JSON.stringify({
      channel: channel?.name,
      channel_id: channel?.id,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cache_tokens: cacheTokens,
      price: { in: price.input, out: price.output, cache: price.cache },
      // 分时审计：事后能复核「这次按峰价还是谷价算的」，以及用的是哪个时刻判档
      price_phase: eff.phase,
      priced_at: startedAt || Date.now(),
      rate: Number(gcfg?.rate) || 1,
      amount_units: units,
      requestId}),
    quota: units,
    ip,
    requestId,
    // 使用记录页直接展示的明细（列存储，便于筛选排序）
    model,
    channelId: channel?.id || 0,
    channelName: channel?.name || "",
    tokenId: token?.id || 0,
    tokenName: token?.name || "",
    groupName: token?.group_name || user?.group_name || "",
    promptTokens,
    completionTokens,
    cacheTokens,
    // 首 token 耗时：流式为首个增量到达时刻；非流式没有增量信号，按总耗时记
    firstTokenMs: firstTokenAt && startedAt ? firstTokenAt - startedAt : startedAt ? Date.now() - startedAt : 0,
    elapsedMs: startedAt ? Date.now() - startedAt : 0,
    userAgent,
    pricePhase: eff.phase});
  return { units, promptTokens, completionTokens, cacheTokens };
}

// ---------- 聊天补全 ----------
router.post(
  "/chat/completions",
  asyncHandler(async (req, res) => {
  const requestId = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const ip = clientIp(req);
  const body = req.body || {};
  const model = String(body.model || "");
  const wantStream = body.stream === true;

  // 客户端断开时中止上游（提前注册：authorize/图片抓取阶段断线也能感知）。
  // 必须监听 res 而不是 req：req "close" 在请求体读完后立即触发（Node 16+），
  // 会把正常请求的上游全部误杀；res "close" + writableEnded 才能区分「断线」与「正常结束」。
  const clientCtrl = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) clientCtrl.abort();
  });

  const auth = req.auth;
  if (!auth) return;
  const { token, user } = auth;

  if (!model) {
    return res.status(400).json({ error: { message: "缺少 model 参数", type: "invalid_request_error" } });
  }
  if (!modelAllowed(token, model)) {
    return res.status(403).json({ error: { message: `当前 API Key 不允许使用模型 ${model}`, type: "invalid_request_error" } });
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: { message: "messages 不能为空", type: "invalid_request_error" } });
  }
  // 过滤非对象元素：null/字符串会让适配器 `.map(m => m.role)` 抛 TypeError；
  // 无 code 的异常会被 execute 当成渠道故障并冷却所有渠道（可被构造的 DoS）
  const messages = body.messages.filter((m) => m && typeof m === "object");
  if (!messages.length) {
    return res.status(400).json({ error: { message: "messages 不能为空", type: "invalid_request_error" } });
  }

  // 模型名归一化后透传给渠道层匹配（各厂商别名在适配器内部处理）；
  // 是否支持视觉也由适配器判断，网关不预设能力
  const matchModel = modelForChannelMatch(model) || model;
  const wantSearch = /-search$/i.test(String(model || ""));
  // 先数图片数量：超 3 张走「不支持」分支，绝不先抓取（防外链 DoS）
  const imageCount = countImageParts(messages);
  const images = imageCount > 3 ? [] : await extractImages(messages);

  // 客户端可显式覆盖深度思考（兼容官方 thinking / reasoning_effort 语义）
  let thinkingOverride;
  if (body.thinking !== undefined) {
    thinkingOverride =
      body.thinking && typeof body.thinking === "object"
        ? String(body.thinking.type).toLowerCase() !== "disabled"
        : Boolean(body.thinking);
  } else if (body.reasoning_effort !== undefined) {
    thinkingOverride = String(body.reasoning_effort).toLowerCase() !== "none";
  }

  // 超 3 张图：以正常回复形式告知，避免打断调用方
  if (imageCount > 3) {
    const notice = "不支持三张以上图片，请修改问题或切换对话窗口！";
    if (wantStream) {
      res.status(200).setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason: finish }]})}\n\n`
        );
      send({ role: "assistant" });
      send({ content: notice });
      send({}, "stop");
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return res.json({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: notice }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }});
  }
  // 图片校验交由各厂商适配器判断（不同厂商支持的模型不同），
  // 网关只做「超 3 张」的通用限制（见上）。

  const prompt = messagesToPrompt(messages);
  let streamStarted = false;
  // 已流出的内容：上游中途失败时按实际产出结算，避免「答了一半却零计费」
  let partialOut = "";
  let settledOnce = false;
  // 首 token 时刻（首个正文/思考增量到达）：使用记录页要展示「首Token耗时」，
  // 这是用户最能感知的延迟指标，只有在此处能测到。
  const startedAt = Date.now();
  let firstTokenAt = 0;
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 255);
  const markFirstToken = () => {
    if (!firstTokenAt) firstTokenAt = Date.now();
  };
  // 运维监控埋点：在途计数 + 结束时记入延迟分位（监控页的 QPS/成功率/P95 来源）
  enterRequest();
  let metricDone = false;
  const finishMetric = ({ ok = true, status = 200, channelName = "" } = {}) => {
    if (metricDone) return;
    metricDone = true;
    leaveRequest();
    recordRequest({ ok, status, ms: Date.now() - startedAt, model, channel: channelName });
  };

  const sendChunk = (delta, finishReason = null) => {
    res.write(
      `data: ${JSON.stringify({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]})}\n\n`
    );
  };

  const startStream = () => {
    if (streamStarted || !wantStream) return;
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    sendChunk({ role: "assistant" });
    streamStarted = true;
  };

  try {
    const result = await runCompletion({
      model: matchModel,
      prompt,
      // API 接入方式需要保留消息角色（system/user/assistant）；
      // 反代适配器忽略它，仍用拼好的 prompt
      messages,
      thinking: thinkingOverride,
      search: wantSearch,
      images,
      groupName: token.group_name || null,
      user,
      signal: clientCtrl.signal,
      onDelta: (t) => {
        markFirstToken();
        partialOut += t;
        if (wantStream) {
          startStream();
          sendChunk({ content: t });
        }
      },
      onReasoning: (t) => {
        markFirstToken();
        partialOut += t;
        if (wantStream) {
          startStream();
          sendChunk({ reasoning_content: t });
        }
      }});

    // 扣费函数内部已区分：确定未扣（余额不足等）走 catch 部分结算；结果不确定（BILLING_UNCERTAIN）跳过
    const settled = await settle({
      token,
      user,
      model,
      prompt,
      output: result.content + (result.reasoning || ""),
      usage: result.usage,
      ip,
      requestId,
      channel: result.channel,
      startedAt,
      firstTokenAt,
      userAgent});
    settledOnce = true;
    finishMetric({ ok: true, status: 200, channelName: result.channel?.name || "" });

    if (wantStream) {
      if (!streamStarted) {
        startStream();
      }
      sendChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.json({
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.content,
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {})},
            finish_reason: "stop"},
        ],
        usage: {
          // 严格遵循 OpenAI usage 结构，扩展字段放到顶层 x_* （严格 SDK 会校验 usage 子字段）
          prompt_tokens: settled.promptTokens,
          completion_tokens: settled.completionTokens,
          total_tokens: settled.promptTokens + settled.completionTokens,
          ...(settled.cacheTokens ? { prompt_tokens_details: { cached_tokens: settled.cacheTokens } } : {})},
        x_od_cost: Number((settled.units / UNITS_PER_OD).toFixed(6)),
        x_currency: CURRENCY,
        x_channel: result.channel?.name,
        x_latency_ms: result.elapsed});
    }
  } catch (err) {
    const code = err.code || "UPSTREAM_ERROR";
    console.error(`[gateway] ${requestId} 失败：${code} ${err.message}`);
    // 扣费结果不确定时跳过部分结算（防重复扣费）
    if (code === "BILLING_UNCERTAIN") settledOnce = true;
    // 已产生内容：按已产出部分结算（客户端已收到这些内容，不能零计费）。
    // 条件不能只看 streamStarted：非流式请求（stream:false）适配器同样边流边回调，
    // 中途失败时 partialOut 也有内容，却会漏计费。
    if (!settledOnce && partialOut) {
      try {
        await settle({
          token,
          user,
          model,
          prompt,
          output: partialOut,
          usage: null,
          ip,
          requestId,
          // 失败渠道由 execute.tagChannel 挂在 error 上：带上它，这部分真实产生的用量
          // 才能归到渠道，否则在渠道统计里完全不可见（主查询与老记录回填都匹配不到）
          channel: err.channelId ? { id: err.channelId, name: err.channelName } : null,
          startedAt,
          firstTokenAt,
          userAgent});
      } catch (e2) {
        console.error(`[gateway] ${requestId} 部分结算失败：${e2.message}`);
      }
    }
    await writeLog({
      user,
      type: LOG_TYPE.ERROR,
      content: `调用 ${model} 失败：${err.message}`,
      detail: JSON.stringify({ code, requestId }),
      ip,
      requestId,
      model,
      // 失败也归属到渠道：看板的「渠道成功率」按 logs 聚合，没有这个就只能靠 20 条环形缓冲
      channelId: err.channelId || 0,
      channelName: err.channelName || "",
      tokenId: token?.id || 0,
      tokenName: token?.name || "",
      groupName: token?.group_name || user?.group_name || "",
      elapsedMs: Date.now() - startedAt,
      userAgent});
    // 错误码 → HTTP 状态要能区分「调用方请求错」与「网关/上游故障」，
    // 否则客户端会把 400/429 当成 502 盲目重试。
    const status =
      code === "CHANNEL_BAD_REQUEST" || code === "LOGIN_BAD_PARAMS"
        ? 400
        : code === "CHANNEL_AUTH_EXPIRED"
          ? 401
          : code === "CHANNEL_RATE_LIMIT"
            ? 429
            : code === "NO_CHANNEL" ||
                code === "CHANNEL_MUTED" ||
                code === "CHANNEL_EMPTY" ||
                code === "CHANNEL_BIZ_ERROR" ||
                code === "CHANNEL_UNSUPPORTED"
              ? 503
              : 502;
    finishMetric({ ok: false, status, channelName: err.channelName || "" });
    if (streamStarted) {
      sendChunk({}, null);
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: code } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (!res.headersSent) {
      res.status(status).json({ error: { message: err.message, type: code, code } });
    } else {
      res.end();
    }
  }
  })
);

export default router;
