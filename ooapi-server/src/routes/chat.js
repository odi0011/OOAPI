// 对话（站内，JWT 鉴权，按用户额度计费）
// ---------------------------------------------------------------------------
// 本轮重构把「对话 / 智能体」两条链路合并成一条：**一次请求跑完整的 harness 循环**。
//   · 会话与会话设定（智能体、模型、思考/联网、工具开关、最大步数、会话指令）落库，
//     刷新页面不丢；历史消息以 parts 结构存储，前端直接渲染。
//   · 工具调用、思考链、待办清单都在同一条 SSE 流里推送（事件见 /run 注释）。
//   · 计费仍走 services/pricing.js：harness 把每次上游调用记为一条 {prompt,output,usage}，
//     这里逐条 splitTokens 后求和 —— 与网关/旧智能体同一套口径，禁止自行折算。
import express from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, safeJSONParse } from "../utils.js";
import { authRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { getPrice, computeCost, splitTokens, estimateTokens, UNITS_PER_OD, CURRENCY } from "../services/pricing.js";
import { allPublicModels, resolveAliasSync } from "../services/models.js";
import { getBoolOption } from "../config.js";
import { runHarness } from "../services/harness/loop.js";
import { AGENTS, findAgent, publicAgents, PRIMARY_AGENTS } from "../services/harness/agents.js";
import { toolSpecs } from "../services/harness/tools.js";
import {
  createSession,
  listSessions,
  getSession,
  getSessionMessages,
  appendMessage,
  updateSession,
  deleteSession,
  rewindSession,
  sessionWithMessages,
  sanitizeSettings,
  titleFromText,
  TOOL_IDS,
  MAX_STEPS_LIMIT,
  DEFAULT_MAX_STEPS,
} from "../services/harness/sessions.js";

const router = express.Router();
// 鉴权头预检放在 express.json 之前：站内接口全部要求 JWT，匿名请求没必要先缓冲 20MB 大包。
// 只查头存在性（api.js/stream.js 均以 Bearer 发送），真正的 authRequired 仍在各路由上。
router.use((req, res, next) => {
  if (!req.headers.authorization) return fail(res, "未登录或登录已过期", 401);
  next();
});
router.use(express.json({ limit: "20mb" }));

// 用户可用的模型：真实模型 + 兼容别名（聚合当前启用渠道支持的模型）
async function availableModels() {
  const [rows] = await pool.query("SELECT models FROM channels WHERE status = 1");
  const supported = new Set();
  for (const r of rows) {
    for (const m of String(r.models || "").split(",")) {
      const t = m.trim();
      if (t && t !== "*") supported.add(t);
    }
  }
  const [prices] = await pool.query("SELECT model, input_price, output_price, cache_price FROM model_prices");
  const priceMap = new Map(prices.map((p) => [p.model, p]));

  return (await allPublicModels())
    .filter((m) => supported.size === 0 || supported.has(m.id))
    .map((m) => {
      const p = priceMap.get(m.id);
      return {
        id: m.id,
        label: m.label,
        desc: m.desc,
        vision: m.vision,
        thinkingDefault: m.thinkingDefault,
        // 能力标记必须透传：前端据此隐藏无效开关（缺失时前端按“支持”处理）
        supportsSearch: m.supportsSearch,
        supportsThinking: m.supportsThinking,
        deprecated: Boolean(m.deprecated),
        vendor: m.vendor,
        vendorName: m.vendorName,
        aliasOf: m.aliasOf,
        price: p
          ? { input: Number(p.input_price), output: Number(p.output_price), cache: Number(p.cache_price) }
          : null,
      };
    });
}

// ---------- 元信息（模型 / 智能体 / 工具 / 默认值）----------
router.get(
  "/meta",
  authRequired,
  asyncHandler(async (req, res) => {
    const models = await availableModels();
    return ok(res, {
      currency: CURRENCY,
      units_per_od: UNITS_PER_OD,
      quota: Number(req.user.quota),
      used_quota: Number(req.user.used_quota),
      models,
      agents: publicAgents(AGENTS),
      tools: toolSpecs(TOOL_IDS).map(({ id, name, desc }) => ({ id, name, desc })),
      defaults: { agent: PRIMARY_AGENTS[0]?.id || "general", maxSteps: DEFAULT_MAX_STEPS, maxStepsLimit: MAX_STEPS_LIMIT },
      chat_enabled: getBoolOption("chat_enabled"),
    });
  })
);

// ---------- 会话 CRUD ----------
router.get(
  "/sessions",
  authRequired,
  asyncHandler(async (req, res) => {
    return ok(res, { sessions: await listSessions(req.user.id, { q: req.query.q, limit: req.query.limit }) });
  })
);

router.post(
  "/sessions",
  authRequired,
  asyncHandler(async (req, res) => {
    if (!getBoolOption("chat_enabled")) return fail(res, "站内对话功能已关闭", 403);
    const { agent = "general", model = "", settings = {} } = req.body || {};
    if (!findAgent(agent)) return fail(res, "智能体不存在");
    const session = await createSession({ userId: req.user.id, agent, model, settings });
    return ok(res, session);
  })
);

router.get(
  "/sessions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    return ok(res, { session, messages: await getSessionMessages(session.id) });
  })
);

router.put(
  "/sessions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    const patch = {};
    const body = req.body || {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.agent !== undefined) {
      if (!findAgent(body.agent)) return fail(res, "智能体不存在");
      patch.agent = body.agent;
    }
    if (body.model !== undefined) patch.model = body.model;
    if (body.todo !== undefined) patch.todo = body.todo;
    if (body.settings !== undefined) {
      const next = sanitizeSettings(body.settings, { previous: session.settings });
      if (next.tools && next.tools.some((t) => !TOOL_IDS.includes(t))) return fail(res, "包含未知工具");
      patch.settings = next;
    }
    return ok(res, await updateSession(req.user.id, session.id, patch));
  })
);

router.delete(
  "/sessions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const removed = await deleteSession(req.user.id, req.params.id);
    if (!removed) return fail(res, "会话不存在", 404);
    return ok(res, { id: req.params.id });
  })
);

// 重新生成：先回退到指定消息之前，再让前端重发（见 sessions.rewindSession 的注释）
router.post(
  "/sessions/:id/rewind",
  authRequired,
  asyncHandler(async (req, res) => {
    const { fromSeq } = req.body || {};
    const result = await rewindSession(req.user.id, req.params.id, fromSeq);
    if (!result) return fail(res, "会话不存在", 404);
    return ok(res, await sessionWithMessages(req.user.id, req.params.id));
  })
);

// ---------- 计费（用户额度）----------
// 与网关同一套原子扣费；harness 传进来的 tokens 是「每次上游调用分别 splitTokens 后求和」，
// 混用 API 渠道（结构化 usage）与反代渠道（usage=null）时不会互相覆盖口径。
async function chargeUser({ user, model, prompt, output, usage, channel, tokens, kind }) {
  const { promptTokens, completionTokens, cacheTokens } =
    tokens || splitTokens({ prompt, output, upstreamTotal: usage });
  // 兼容别名必须按真实模型计价（否则落到默认兜底档，偏差可达 3~10 倍）
  const price = await getPrice(resolveAliasSync(model));
  const units = computeCost({ price, promptTokens, completionTokens, cacheTokens });

  const [uRows] = await pool.query("SELECT quota FROM users WHERE id = ?", [user.id]);
  if (Number(uRows[0]?.quota || 0) <= 0) {
    throw Object.assign(new Error(`${CURRENCY} 币余额不足，请联系管理员充值`), { code: "INSUFFICIENT_QUOTA" });
  }
  const [ret] = await pool.query(
    "UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ? AND quota >= ?",
    [units, units, user.id, units]
  );
  if (!ret.affectedRows) {
    await pool.query(
      "UPDATE users SET quota = 0, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?",
      [units, user.id]
    );
  }
  await writeLog({
    user,
    type: LOG_TYPE.CONSUME,
    content: `${kind} · ${model} · 提示 ${promptTokens} / 补全 ${completionTokens} tokens${
      cacheTokens ? ` / 缓存 ${cacheTokens}` : ""
    } · ${(units / UNITS_PER_OD).toFixed(4)} ${CURRENCY}`,
    detail: JSON.stringify({ channel: channel?.name, kind }),
    quota: units,
  });
  return { units, promptTokens, completionTokens, cacheTokens };
}

// 逐条调用 → 汇总 token（失败时也算出已消耗的部分）
function aggregate(calls = []) {
  const sum = { promptTokens: 0, completionTokens: 0, cacheTokens: 0 };
  for (const c of calls) {
    const s = splitTokens({ prompt: c.prompt, output: c.output, upstreamTotal: c.usage });
    sum.promptTokens += s.promptTokens;
    sum.completionTokens += s.completionTokens;
    sum.cacheTokens += s.cacheTokens;
  }
  return sum;
}

// ---------- 运行一轮对话（SSE）----------
// 事件：{type:"start", message}|{type:"part", part}|{type:"part_update", id, patch}
//      {type:"delta", id, field, delta}|{type:"todo", todo}|{type:"done", message}|{type:"error"}
router.post(
  "/run",
  authRequired,
  asyncHandler(async (req, res) => {
    const { sessionId, text = "", model: modelOverride, agent: agentOverride, settings: settingsPatch, images = [] } = req.body || {};

    const session = await getSession(req.user.id, sessionId);
    if (!session) return fail(res, "会话不存在", 404);
    if (!getBoolOption("chat_enabled")) return fail(res, "站内对话功能已关闭", 403);
    if (Number(req.user.quota) <= 0) return fail(res, `${CURRENCY} 币余额不足，请联系管理员充值`, 403);

    const content = String(text || "").trim();
    const agentId = agentOverride || session.agent;
    const agent = findAgent(agentId);
    if (!agent) return fail(res, "智能体不存在");
    const model = modelOverride || session.model;
    if (!model) return fail(res, "请选择模型");
    if (!content && !(Array.isArray(images) && images.length)) return fail(res, "请输入内容");

    // 设定优先级：本轮显式传的 > 会话已存 > 智能体默认
    const settings = sanitizeSettings(settingsPatch ?? {}, { previous: session.settings });

    // 图片（base64 data URL）
    const imgs = [];
    for (const img of Array.isArray(images) ? images : []) {
      const mm = /^data:([^;]+);base64,(.+)$/s.exec(String(img?.dataUrl || ""));
      if (mm) {
        imgs.push({
          buffer: Buffer.from(mm[2], "base64"),
          mimeType: mm[1],
          filename: mm[1].includes("png") ? "image.png" : "image.jpg",
        });
      }
    }
    if (imgs.length > 3) return fail(res, "最多 3 张图片");

    const history = await getSessionMessages(session.id);

    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    // 客户端断开时中止上游，避免继续消耗额度/浏览器会话。
    // 注意必须监听 res 而不是 req：Node 16+ 的 req "close" 在请求体读完（express.json 解析完）
    // 后就会立即触发，与客户端是否断线无关，会把正常请求的上游全部误杀。
    const clientCtrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) clientCtrl.abort();
    });

    // 用户消息先落库再跑：即使执行失败，对话历史也是完整的
    const userParts = [{ id: `u${Date.now().toString(36)}`, type: "text", text: content }];
    for (const img of Array.isArray(images) ? images : []) {
      if (typeof img?.dataUrl === "string" && img.dataUrl.startsWith("data:image/")) {
        userParts.push({ id: `i${Math.random().toString(36).slice(2, 8)}`, type: "image", url: img.dataUrl });
      }
    }
    await appendMessage({ sessionId: session.id, userId: req.user.id, role: "user", parts: userParts });

    // 首条消息直接当标题（比再调一次模型便宜；用户之后可手动改名）
    if (session.message_count === 0 && session.title === "新对话") {
      await updateSession(req.user.id, session.id, { title: titleFromText(content || "图片对话") });
    }

    const runCalls = [];
    let runParts = [];
    let runTodo = session.todo || [];
    let channelName = "";
    let settled = false;

    send({ type: "start", sessionId: session.id });

    try {
      const out = await runHarness({
        session,
        agent,
        model,
        settings,
        history,
        userText: content,
        images: imgs,
        groupName: req.user.group_name,
        signal: clientCtrl.signal,
        modelCaps: (await availableModels()).find((m) => m.id === model) || null,
        emit: (ev) => {
          if (ev.type === "todo") runTodo = ev.todo;
          send(ev);
        },
        onTodo: (todo) => {
          runTodo = todo;
        },
        onCall: (c) => runCalls.push(c),
      });

      runParts = out.parts;
      runTodo = out.todo;
      channelName = runCalls.find((c) => c.channel)?.channel || "";

      const tokens = aggregate(runCalls);
      const billed = await chargeUser({
        user: req.user,
        model,
        prompt: "",
        output: "",
        usage: null,
        tokens,
        channel: channelName ? { name: channelName } : null,
        kind: "对话",
      });
      settled = true;

      const message = {
        seq: 0,
        role: "assistant",
        parts: runParts,
        agent: agent.id,
        model,
        cost: Number((billed.units / UNITS_PER_OD).toFixed(6)),
        tokens: { prompt: billed.promptTokens, completion: billed.completionTokens },
        created_time: now(),
      };
      message.seq = await appendMessage({
        sessionId: session.id,
        userId: req.user.id,
        role: "assistant",
        parts: runParts,
        agent: agent.id,
        model,
        cost: message.cost,
        promptTokens: billed.promptTokens,
        completionTokens: billed.completionTokens,
      });
      await updateSession(req.user.id, session.id, { todo: runTodo });

      send({ type: "done", message, todo: runTodo, session: await getSession(req.user.id, session.id) });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      console.error("[chat] 运行失败：", err.code || "", err.message);
      if (Array.isArray(err.parts) && err.parts.length) runParts = err.parts;
      const aborted = clientCtrl.signal.aborted || err.code === "ABORTED";

      // 已消耗的部分照常计费（用户确实为这些 token 付了上游成本）：
      // 失败时最后一次调用没有 usage，按 prompt/输出字符数估算补上。
      const tokens = aggregate(runCalls);
      const partial = runParts.filter((p) => p.type === "text").map((p) => p.text).join("");
      if (!settled && (tokens.promptTokens || tokens.completionTokens || partial)) {
        if (partial && !tokens.completionTokens) {
          tokens.completionTokens += estimateTokens(partial);
          tokens.promptTokens += estimateTokens(content);
        }
        try {
          await chargeUser({
            user: req.user,
            model,
            prompt: "",
            output: "",
            usage: null,
            tokens,
            channel: channelName ? { name: channelName } : null,
            kind: "对话（部分）",
          });
        } catch (e2) {
          console.error("[chat] 部分计费失败：", e2.message);
        }
      }

      if (runParts.length) {
        try {
          await appendMessage({
            sessionId: session.id,
            userId: req.user.id,
            role: "assistant",
            parts: runParts,
            agent: agent.id,
            model,
          });
          await updateSession(req.user.id, session.id, { todo: runTodo });
        } catch (e2) {
          console.error("[chat] 失败消息落库异常：", e2.message);
        }
      }

      if (!aborted) {
        send({
          type: "error",
          code: err.code || "ERROR",
          message: err.message,
        });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    }
  })
);

export default router;
