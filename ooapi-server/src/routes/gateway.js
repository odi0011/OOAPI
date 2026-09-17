// OpenAI 兼容网关：/v1/chat/completions、/v1/models
// 按模型路由到渠道，OD 币 1:1 计费。
import express from "express";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { pool } from "../db.js";
import { getBoolOption } from "../config.js";
import { now, clientIp } from "../utils.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { runCompletion } from "../services/execute.js";
import { getPrice, computeCost, splitTokens, UNITS_PER_OD, CURRENCY } from "../services/pricing.js";
import { allPublicModels, modelForChannelMatch } from "../services/models.js";

const router = express.Router();
router.use(express.json({ limit: "50mb" }));

// ---------- 对外可用模型列表（平台真实模型 + 兼容别名）----------
// 与 OpenAI 一致需要鉴权，避免匿名枚举全量模型目录
router.get("/models", async (req, res) => {
  const auth = await authorize(req, res);
  if (!auth) return;
  const [rows] = await pool.query("SELECT models FROM channels WHERE status = 1");
  const available = new Set();
  for (const r of rows) {
    for (const m of String(r.models || "").split(",")) {
      const t = m.trim();
      if (t && t !== "*") available.add(t);
    }
  }
  const all = await allPublicModels();
  const list = all.filter((m) => available.has(m.id) || available.size === 0);
  res.json({
    object: "list",
    data: list.map((m) => ({
      id: m.id,
      object: "model",
      // owned_by 用厂商类型，便于客户端区分模型来源
      owned_by: m.aliasOf ? m.vendor : m.vendor || m.aliasOf || "unknown",
      ...(m.vendorName ? { vendor_name: m.vendorName } : {}),
      ...(m.aliasOf ? { alias_of: m.aliasOf, deprecated: true } : {}),
    })),
  });
});

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
      error: { message: `账户 ${CURRENCY} 币余额不足，请联系管理员充值`, type: "insufficient_user_quota", code: "insufficient_user_quota" },
    });
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

// ---------- SSRF 防护：图片外链只允许公网 http(s) ----------
function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return false;
  }
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // 保留 / 内网 / 回环
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("协议不允许");
  if (u.username || u.password) throw new Error("不允许携带凭据");
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("目标为内网地址");
  return u;
}

// 抓取远程图片：逐跳校验（防重定向 SSRF），限制类型与大小
async function fetchRemoteImage(rawUrl) {
  let target = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(target);
    const r = await fetch(u, { signal: AbortSignal.timeout(30000), redirect: "manual" });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return null;
      target = new URL(loc, u).toString();
      continue;
    }
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    if (ab.byteLength > 20 * 1024 * 1024) return null;
    const mimeType = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("image/")) return null;
    return { buffer: Buffer.from(ab), mimeType, filename: mimeType.includes("png") ? "image.png" : "image.jpg" };
  }
  return null;
}

async function extractImages(messages) {
  const images = [];
  for (const m of messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type !== "image_url") continue;
      const url = part.image_url?.url ?? "";
      if (!url) continue;
      const mm = /^data:([^;]+);base64,(.+)$/s.exec(url);
      if (mm) {
        images.push({
          buffer: Buffer.from(mm[2], "base64"),
          mimeType: mm[1],
          filename: mm[1].includes("png") ? "image.png" : "image.jpg",
        });
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
async function settle({ token, user, model, prompt, output, usage, ip, requestId, channel }) {
  const { promptTokens, completionTokens, cacheTokens } = splitTokens({ prompt, output, upstreamTotal: usage });
  const price = await getPrice(model);
  const units = computeCost({ price, promptTokens, completionTokens, cacheTokens });
  const od = (units / UNITS_PER_OD).toFixed(4);

  await pool.query(
    "UPDATE users SET quota = GREATEST(0, quota - ?), used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?",
    [units, units, user.id]
  );
  if (!token.unlimited_quota) {
    await pool.query("UPDATE tokens SET remain_quota = GREATEST(0, remain_quota - ?) WHERE id = ?", [units, token.id]);
  }
  await pool.query("UPDATE tokens SET used_quota = used_quota + ?, accessed_time = ? WHERE id = ?", [units, now(), token.id]);
  await writeLog({
    user,
    type: LOG_TYPE.CONSUME,
    content: `调用 ${model} · 提示 ${promptTokens} / 补全 ${completionTokens} tokens${
      cacheTokens ? ` / 缓存 ${cacheTokens}` : ""
    } · ${od} ${CURRENCY}`,
    detail: JSON.stringify({ channel: channel?.name, price: { in: price.input, out: price.output, cache: price.cache }, requestId }),
    quota: units,
    ip,
    requestId,
  });
  return { units, promptTokens, completionTokens, cacheTokens };
}

// ---------- 聊天补全 ----------
router.post("/chat/completions", async (req, res) => {
  const requestId = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const ip = clientIp(req);
  const body = req.body || {};
  const model = String(body.model || "");
  const wantStream = body.stream === true;

  const auth = await authorize(req, res);
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

  // 模型名归一化后透传给渠道层匹配（各厂商别名在适配器内部处理）；
  // 是否支持视觉也由适配器判断，网关不预设能力
  const matchModel = modelForChannelMatch(model) || model;
  const wantSearch = /-search$/i.test(String(model || ""));
  const images = await extractImages(body.messages);

  // 客户端可显式覆盖深度思考（兼容官方 thinking / reasoning_effort 语义）
  let thinkingOverride;
  if (body.thinking !== undefined) {
    thinkingOverride =
      typeof body.thinking === "object" ? String(body.thinking.type).toLowerCase() !== "disabled" : Boolean(body.thinking);
  } else if (body.reasoning_effort !== undefined) {
    thinkingOverride = String(body.reasoning_effort).toLowerCase() !== "none";
  }

  // 超 3 张图：以正常回复形式告知，避免打断调用方
  if (images.length > 3) {
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
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
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
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
  // 图片校验交由各厂商适配器判断（不同厂商支持的模型不同），
  // 网关只做「超 3 张」的通用限制（见上）。

  const prompt = messagesToPrompt(body.messages);
  let streamStarted = false;

  // 客户端断开（关页面/断网）时中止上游请求，避免上游继续跑到自身超时
  const clientCtrl = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) clientCtrl.abort();
  });

  const sendChunk = (delta, finishReason = null) => {
    res.write(
      `data: ${JSON.stringify({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`
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
      messages: body.messages,
      thinking: thinkingOverride,
      search: wantSearch,
      images,
      groupName: user.group_name,
      signal: clientCtrl.signal,
      onDelta: (t) => {
        if (wantStream) {
          startStream();
          sendChunk({ content: t });
        }
      },
      onReasoning: (t) => {
        if (wantStream) {
          startStream();
          sendChunk({ reasoning_content: t });
        }
      },
    });

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
    });

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
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: settled.promptTokens,
          completion_tokens: settled.completionTokens,
          total_tokens: settled.promptTokens + settled.completionTokens,
          ...(settled.cacheTokens ? { prompt_tokens_details: { cached_tokens: settled.cacheTokens } } : {}),
          od_cost: Number((settled.units / UNITS_PER_OD).toFixed(6)),
          currency: CURRENCY,
          channel: result.channel?.name,
          latency_ms: result.elapsed,
        },
      });
    }
  } catch (err) {
    const code = err.code || "UPSTREAM_ERROR";
    console.error(`[gateway] ${requestId} 失败：${code} ${err.message}`);
    await writeLog({
      user,
      type: LOG_TYPE.ERROR,
      content: `调用 ${model} 失败：${err.message}`,
      detail: JSON.stringify({ code, requestId }),
      ip,
      requestId,
    });
    const status = code === "NO_CHANNEL" ? 503 : code === "CHANNEL_MUTED" || code === "CHANNEL_EMPTY" ? 503 : 502;
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
});

export default router;
