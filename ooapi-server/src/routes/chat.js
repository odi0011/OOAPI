// 站内对话与智能体（用户态，JWT 鉴权，按用户额度计费）
// ---------------------------------------------------------------------------
// 与 /v1 网关共用同一个执行器（渠道选择 + 失败切换 + 计价），
// 差别仅在鉴权方式（JWT 而非 sk- 令牌）与计费对象（直接扣用户额度）。
import express from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now } from "../utils.js";
import { authRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { runCompletion } from "../services/execute.js";
import { getPrice, computeCost, splitTokens, estimateTokens, UNITS_PER_OD, CURRENCY } from "../services/pricing.js";
import { allPublicModels, modelForChannelMatch, resolveAliasSync } from "../services/models.js";
import { getBoolOption } from "../config.js";

const router = express.Router();
// 鉴权头预检放在 express.json 之前：站内接口全部要求 JWT，匿名请求没必要先缓冲 20MB 大包。
// 只查头存在性（api.js/stream.js 均以 Bearer 发送），真正的 authRequired 仍在各路由上。
router.use((req, res, next) => {
  if (!req.headers.authorization) return fail(res, "未登录或登录已过期", 401);
  next();
});
router.use(express.json({ limit: "20mb" }));

// ---------- 智能体预设 ----------
// 每个智能体是一套多步流程提示词；步骤由模型自主规划，每一步都真实调用上游模型。
export const AGENTS = [
  {
    id: "general",
    name: "通用助手",
    desc: "拆解目标、分步推理、给出结论。适合开放性问题与日常任务。",
    icon: "sparkles",
    model: "deepseek-flash",
    thinking: false,
    steps: ["理解目标", "分步分析", "给出结论"],
    sysPlan: "你是一个任务规划专家。请把用户目标拆成 3-4 个可执行的步骤。只输出 JSON 数组，形如 [\"步骤1\",\"步骤2\"]，不要任何其他文字。",
    sysStep: "你正在执行任务的其中一个步骤。请针对该步骤给出扎实、具体的内容，不要重复其他步骤。",
    sysFinal: "请基于以上各步骤的分析，给出最终完整答案。要求结构清晰、结论明确。",
  },
  {
    id: "research",
    name: "深度研究",
    desc: "多角度检索式分析，覆盖背景、现状、风险与机会。",
    icon: "search",
    model: "deepseek-flash",
    thinking: true,
    steps: ["界定问题", "多角度分析", "风险评估", "综合结论"],
    sysPlan: "你是资深研究员。请把研究主题拆成 3-4 个研究角度。只输出 JSON 数组，形如 [\"角度1\",\"角度2\"]。",
    sysStep: "你正在从某个特定角度分析研究主题，请给出有深度、有依据的分析。",
    sysFinal: "请综合以上分析，输出一份结构化的研究结论，包含关键发现与建议。",
  },
  {
    id: "writer",
    name: "写作助手",
    desc: "先立大纲，再成稿，最后润色。适合文章、文案与报告。",
    icon: "edit",
    model: "deepseek-flash",
    thinking: false,
    steps: ["拟定大纲", "撰写初稿", "润色优化"],
    sysPlan: "你是专业编辑。请为写作任务拟定 3 个结构部分。只输出 JSON 数组，形如 [\"部分1\",\"部分2\"]。",
    sysStep: "你正在撰写文章的某个部分，请写出完整、流畅的内容。",
    sysFinal: "请把各部分整合成一篇连贯的完整文章，语言自然、逻辑顺畅。",
  },
  {
    id: "coder",
    name: "代码助手",
    desc: "分析需求、给出实现、指出边界情况与改进点。",
    icon: "code",
    model: "deepseek-flash",
    thinking: true,
    steps: ["分析需求", "设计实现", "代码审查"],
    sysPlan: "你是资深工程师。请把编程任务拆成 3 个阶段。只输出 JSON 数组，形如 [\"阶段1\",\"阶段2\"]。",
    sysStep: "你正在处理编程任务的某个阶段，请给出具体、可落地的技术内容（含代码）。",
    sysFinal: "请给出完整的最终实现方案，包含可运行的代码和关键说明。",
  },
];

// 用户可用的模型：真实模型 + 兼容别名（聚合当前启用渠道支持的模型）
async function availableModels(user) {
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

// ---------- 元信息 ----------
router.get(
  "/meta",
  authRequired,
  asyncHandler(async (req, res) => {
    const models = await availableModels(req.user);
    return ok(res, {
      currency: CURRENCY,
      units_per_od: UNITS_PER_OD,
      quota: Number(req.user.quota),
      used_quota: Number(req.user.used_quota),
      models,
      agents: AGENTS.map(({ sysPlan, sysStep, sysFinal, ...pub }) => pub),
    });
  })
);

// ---------- 计费（用户额度）----------
async function chargeUser({ user, model, prompt, output, usage, channel, kind, tokens }) {
  // tokens 由调用方按「每次 call 分别结算」预先算好时直接使用（智能体多步）：
  // 混用 API 渠道（结构化 usage）与反代渠道（usage=null）时，合并成一个 usage 对象
  // 会让 splitTokens 只认结构化部分，反代步骤的输入/输出漏计。
  const { promptTokens, completionTokens, cacheTokens } =
    tokens || splitTokens({ prompt, output, upstreamTotal: usage });
  // 兼容别名必须按真实模型计价（否则落到默认兜底档，偏差可达 3~10 倍）
  const price = await getPrice(resolveAliasSync(model));
  const units = computeCost({ price, promptTokens, completionTokens, cacheTokens });

  const [uRows] = await pool.query("SELECT quota FROM users WHERE id = ?", [user.id]);
  if (Number(uRows[0]?.quota || 0) <= 0) {
    throw Object.assign(new Error(`${CURRENCY} 币余额不足，请联系管理员充值`), { code: "INSUFFICIENT_QUOTA" });
  }
  // 与网关同一套原子扣费：条件更新避免并发透支；不足时兜底扣到 0
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
    content: `${kind === "agent" ? "智能体" : "站内对话"} · ${model} · 提示 ${promptTokens} / 补全 ${completionTokens} tokens${
      cacheTokens ? ` / 缓存 ${cacheTokens}` : ""
    } · ${(units / UNITS_PER_OD).toFixed(4)} ${CURRENCY}`,
    detail: JSON.stringify({ channel: channel?.name, kind }),
    quota: units,
  });
  return { units, promptTokens, completionTokens, cacheTokens };
}

// ---------- 站内对话（流式）----------
router.post(
  "/completions",
  authRequired,
  asyncHandler(async (req, res) => {
    const { messages = [], model = "deepseek-chat", thinking, search = false, images = [] } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) return fail(res, "messages 不能为空");
    // 过滤非对象元素：null 会让适配器 `.map(m => m.role)` 抛 TypeError（无 code 异常会冷却全部渠道）
    const safeMessages = messages.filter((m) => m && typeof m === "object");
    if (!safeMessages.length) return fail(res, "messages 不能为空");
    if (!getBoolOption("chat_enabled")) return fail(res, "站内对话功能已关闭", 403);
    if (Number(req.user.quota) <= 0) return fail(res, `${CURRENCY} 币余额不足，请联系管理员充值`, 403);

    // 拼装 prompt
    let prompt = "";
    for (const m of safeMessages) {
      const c = String(m.content ?? "");
      if (m.role === "system") prompt += c + "\n";
      else if (m.role === "assistant") prompt += "<｜Assistant｜>" + c + "<｜end▁of▁sentence｜>";
      else prompt += "<｜User｜>" + c;
    }

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
    if (imgs.length > 3) return fail(res, "不支持三张以上图片，请修改问题或切换对话窗口");

    // SSE
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const matchModel = modelForChannelMatch(model) || model;

    // 客户端断开时中止上游，避免继续消耗额度/浏览器会话。
    // 注意必须监听 res 而不是 req：Node 16+ 的 req "close" 在请求体读完（express.json 解析完）
    // 后就会立即触发，与客户端是否断线无关，会把正常请求的上游全部误杀。
    const clientCtrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) clientCtrl.abort();
    });

    // 已流出的内容：上游中途失败时按实际产出计费（客户端已看到部分回答）
    let partialOut = "";
    let settledOnce = false;

    try {
      const result = await runCompletion({
        model: matchModel,
        prompt,
        messages: safeMessages,
        // 未显式指定时用模型默认（V4.1-Flash 默认开启思考）
        thinking: typeof thinking === "boolean" ? thinking : undefined,
        search,
        images: imgs,
        groupName: req.user.group_name,
        signal: clientCtrl.signal,
        onChannelTry: (ch) => send({ type: "channel", name: ch.name }),
        onReasoning: (t) => {
          partialOut += t;
          send({ type: "reasoning", delta: t });
        },
        onSearchStatus: (s) => send({ type: "search", status: s }),
        onDelta: (t) => {
          partialOut += t;
          send({ type: "delta", delta: t });
        },
      });

      const billed = await chargeUser({
        user: req.user,
        model: matchModel,
        prompt,
        output: result.content + (result.reasoning || ""),
        usage: result.usage,
        channel: result.channel,
        kind: "chat",
      });
      settledOnce = true;

      send({
        type: "done",
        content: result.content,
        reasoning: result.reasoning,
        cost: Number((billed.units / UNITS_PER_OD).toFixed(6)),
        currency: CURRENCY,
        tokens: { prompt: billed.promptTokens, completion: billed.completionTokens },
        channel: result.channel?.name,
        latency_ms: result.elapsed,
      });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      console.error("[chat] 失败：", err.code, err.message);
      if (!settledOnce && partialOut) {
        try {
          await chargeUser({
            user: req.user,
            model: matchModel,
            prompt,
            output: partialOut,
            usage: null,
            channel: null,
            kind: "chat",
          });
        } catch (e2) {
          console.error("[chat] 部分计费失败：", e2.message);
        }
      }
      send({ type: "error", code: err.code || "ERROR", message: err.message });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  })
);

// ---------- 智能体：多步执行（流式推送每一步）----------
router.post(
  "/agents/run",
  authRequired,
  asyncHandler(async (req, res) => {
    const { agentId = "general", goal = "", model: modelOverride } = req.body || {};
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) return fail(res, "智能体不存在");
    if (!getBoolOption("agent_enabled")) return fail(res, "智能体功能已关闭", 403);
    if (!String(goal).trim()) return fail(res, "请输入任务目标");
    if (Number(req.user.quota) <= 0) return fail(res, `${CURRENCY} 币余额不足，请联系管理员充值`, 403);

    const model = modelOverride || agent.model;

    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // 客户端断开时中止当前步骤的上游请求（同样监听 res，原因见 /completions）
    const clientCtrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) clientCtrl.abort();
    });

    // 每次 call 单独记录 { prompt, output, usage }：结算时逐条 splitTokens 后求和，
    // 避免 API 渠道（结构化 usage）与反代渠道（usage=null）混合时互相覆盖口径
    const calls = [];
    let totalPrompt = "";
    let totalOutput = "";
    let firstChannel = null;
    let settledOnce = false;

    // 逐条结算 → 汇总 token 数（供 chargeUser 使用）
    const aggregateTokens = () => {
      const sum = { promptTokens: 0, completionTokens: 0, cacheTokens: 0 };
      for (const c of calls) {
        const s = splitTokens({ prompt: c.prompt, output: c.output, upstreamTotal: c.usage });
        sum.promptTokens += s.promptTokens;
        sum.completionTokens += s.completionTokens;
        sum.cacheTokens += s.cacheTokens;
      }
      return sum;
    };

    // 单步调用（复用执行器，自带渠道切换）
    const call = async ({ system, user: userMsg, thinking, onDelta }) => {
      const prompt = system ? `${system}\n\n${userMsg}` : userMsg;
      // 本次调用已流出的内容：失败时挂到 error 上用于部分计费。
      // 反代渠道的 usage 常为 null（normalizeUsage 后全 0），只看 usage 会整单漏计。
      let streamed = "";
      const wrappedDelta = onDelta
        ? (t) => {
            streamed += t;
            onDelta(t);
          }
        : null;
      try {
        const r = await runCompletion({
          model: modelForChannelMatch(model) || model,
          prompt: `<｜User｜>${prompt}`,
          // API 渠道按角色下发；反代渠道仍用上面的 prompt
          messages: system
            ? [{ role: "system", content: system }, { role: "user", content: userMsg }]
            : [{ role: "user", content: userMsg }],
          thinking: typeof thinking === "boolean" ? thinking : agent.thinking,
          search: agent.id === "research",
          images: [],
          groupName: req.user.group_name,
          signal: clientCtrl.signal,
          onDelta: wrappedDelta,
          // 思考链不推给步骤面板，但要计入部分计费
          onReasoning: (t) => {
            streamed += t;
          },
        });
        totalPrompt += prompt;
        totalOutput += r.content + (r.reasoning || "");
        calls.push({ prompt, output: r.content + (r.reasoning || ""), usage: r.usage });
        if (!firstChannel) firstChannel = r.channel;
        return r.content;
      } catch (e) {
        e.partialOutput = streamed;
        e.callPrompt = prompt;
        throw e;
      }
    };

    try {
      // ① 规划
      send({ type: "plan_start" });
      const planRaw = await call({
        system: agent.sysPlan,
        user: `任务目标：${goal}`,
        onDelta: null,
      });

      let steps = [];
      try {
        const m = /\[[\s\S]*?\]/.exec(planRaw);
        steps = m ? JSON.parse(m[0]) : [];
      } catch {
        steps = [];
      }
      if (!Array.isArray(steps) || !steps.length) steps = [...agent.steps];
      steps = steps.slice(0, 5).map((s) => String(s).slice(0, 80));

      send({ type: "plan", steps });

      // ② 逐步执行
      const results = [];
      for (let i = 0; i < steps.length; i++) {
        const title = steps[i];
        send({ type: "step_start", index: i, title });
        let buf = "";
        const out = await call({
          system: agent.sysStep,
          user: `总体目标：${goal}\n\n当前步骤（${i + 1}/${steps.length}）：${title}\n\n已完成内容：\n${
            results.map((r, j) => `【${steps[j]}】${r.slice(0, 400)}`).join("\n") || "（无）"
          }`,
          onDelta: (t) => {
            buf += t;
            send({ type: "step_delta", index: i, delta: t });
          },
        });
        results.push(out);
        send({ type: "step_done", index: i, title, content: out });
      }

      // ③ 汇总
      send({ type: "final_start" });
      let answer = "";
      const finalText = await call({
        system: agent.sysFinal,
        user: `任务目标：${goal}\n\n各步骤产出：\n${steps
          .map((s, i) => `【${s}】\n${results[i]}`)
          .join("\n\n")}`,
        onDelta: (t) => {
          answer += t;
          send({ type: "delta", delta: t });
        },
      });
      if (!answer) answer = finalText;

      // 计费：逐次 call 的 token 汇总（见 aggregateTokens）
      const billed = await chargeUser({
        user: req.user,
        model,
        prompt: totalPrompt,
        output: totalOutput,
        usage: null,
        tokens: aggregateTokens(),
        channel: firstChannel,
        kind: "agent",
      });
      settledOnce = true;

      send({
        type: "done",
        answer,
        steps,
        cost: Number((billed.units / UNITS_PER_OD).toFixed(6)),
        currency: CURRENCY,
        tokens: { prompt: billed.promptTokens, completion: billed.completionTokens },
        channel: firstChannel?.name,
      });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      console.error("[agent] 失败：", err.code, err.message);
      // 已完成步骤 + 失败步骤已推送的内容都真实消耗了上游额度：逐次 call 结算后求和，
      // 再为失败步骤补上估算（它没有成功的 r.usage，按 prompt/输出字符数折算）
      const partial = err?.partialOutput || "";
      const billOutput = totalOutput + partial;
      const tokens = aggregateTokens();
      if (partial) {
        tokens.completionTokens += estimateTokens(partial);
        tokens.promptTokens += estimateTokens(err?.callPrompt || "");
      }
      if (!settledOnce && (tokens.promptTokens || tokens.completionTokens)) {
        try {
          await chargeUser({
            user: req.user,
            model,
            prompt: totalPrompt,
            output: billOutput,
            usage: null,
            tokens,
            channel: firstChannel,
            kind: "agent",
          });
        } catch (e2) {
          console.error("[agent] 部分计费失败：", e2.message);
        }
      }
      send({ type: "error", code: err.code || "ERROR", message: err.message });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  })
);

export default router;
