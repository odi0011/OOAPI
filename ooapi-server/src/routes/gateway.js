// OpenAI 兼容网关：/v1/chat/completions、/v1/models
// 按模型路由到渠道，OD 币 1:1 计费。
import express from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { getBoolOption } from "../config.js";
import { now, clientIp, asyncHandler, assertPublicUrl } from "../utils.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { recordRequest, enterRequest, leaveRequest, classifyError } from "../services/metrics.js";
import { runCompletion } from "../services/execute.js";
import { acquire, estimateRequestTokens } from "../services/user-limit.js";
import {
  getPrice,
  computeCost,
  splitTokens,
  effectivePrice,
  isModelPriced,
  estimateTokens,
  UNITS_PER_OD,
  CURRENCY,
} from "../services/pricing.js";
// displayGroupName 被用来把分组名归一化后再写日志（见下方 groupName 处），
// 但此前**没有导入**：每次成功请求都会在写日志时抛
// ReferenceError: displayGroupName is not defined，把一次本来成功的调用
// 变成 500（用户只看到"服务器内部错误"，日志里却只有一条引用错误）。
import { groupConfigOf, applyGroupRate, displayGroupName } from "../services/group-rate.js";
import {
  allPublicModels,
  modelForChannelMatch,
  resolveAliasSync,
  modelRegistry,
  modelInAllowList,
} from "../services/models.js";
import { collectAvailableModels, channelInGroup, rowToChannel } from "../services/router.js";
import { PROTOCOLS } from "../services/gateway-protocols.js";
import { holdTokenQuota } from "../services/token-quota.js";

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
//
// 用户实测反馈（原话）：「我创建了一个分组叫 deepseek，然后创建一个密钥也叫 deepseek，
// 这个分组我设定只能走俩模型，但是我在外部调用 api，还是能拿到这个分组里全部渠道支持的
// 模型，并且是 21 个模型？外部调用甚至没去重自动调度？你不是检查了吗？这是你检查的结果吗？」
//
// 他说得对，这里原先有三个真实缺陷（全部已复现）：
//   ① **完全没按分组过滤** —— 直接 `SELECT * FROM channels WHERE status = 1`，
//      把全平台渠道的模型都算进 available。于是「分组限 2 个模型」的密钥
//      却看到 21 个（含 glm-5.3、gpt-5.6-luna 等它根本调不了的）。
//      客户端按这份清单选模型，选了就被 503「分组限制了可用模型」拒 —— 列表与能力不一致。
//   ② **没去重** —— 输出里 deepseek-v4-pro / glm-5.3 / gpt-5.6-luna 各出现 3 次
//      （allPublicModels 同时返回真实模型与兼容别名，两边都命中过滤器）。
//   ③ 分组没配「可用模型」时也没限制到「该分组下的渠道」。
//
// 正确语义（与 selectChannels / explainNoChannel 同一套判定，三处必须一致）：
//   能调的模型 = 该密钥所属分组下的启用渠道所支持的模型 ∩ 分组配置的 models 白名单
// **能力后缀要声明出来**，否则会出现「列表里只有 X，实际 X-thinking 也能调」
// 这种自相矛盾 —— 黑盒测试实测抱怨过：
//   「放不进来就别放，放了就得在 /v1/models 里告诉我，
//     不然我按 /v1/models 写代码，线上却有个隐藏模型能悄悄烧钱。」
//
// 后缀**不是独立模型**（同一模型上的开关，见 deepseek-models.js 的设计说明），
// 所以不把 `X-thinking` / `X-search` 全展开成条目（那会让列表膨胀数倍）。
// 也不构成「隐藏计费」风险：`canonicalModelName` 把带后缀的名字归一到基础模型，
// **计价与白名单判定用的都是基础模型**，不存在第二个价格。
// 声明一次即可 —— 调用方由此知道列表里每个 id 都能加该后缀。
// 非标准扩展键：OpenAI 客户端会忽略未知字段，不影响兼容性。
// 后缀是**解析层**接受的写法（路由与计费都会归一化掉它），
// 但「能不能真的开启该能力」取决于**渠道与模型** —— 见 note 字段。
//
// 背景（人格实测报的，两次）：老王实测 `hy3` / `hy3-thinking` / `hy3-search`
// 三者的 reasoning 长度与 completion 都在自然波动范围内，
// `deepseek-v4.1-flash-thinking` 的 reasoning 长度是 **0**（与基础版完全相同）；
// 我自己复测也确认 flash 加 `-thinking` 后 reasoning_len 仍为 0。
// 也就是说：在多数反代渠道上，这些后缀**不激活任何能力**，只换了个名字。
//
// 但完全删掉声明又会回到另一个问题（原始抱怨）：「列表里只有 X，
// 实际 X-thinking 也能调，按列表写代码的人不知道」。
// 折中：**保留声明，但把真实语义写清楚** —— 后缀会被接受、
// 路由与计价按基础模型处理；是否真开启能力由渠道决定，
// 调用方应优先用请求体参数（`thinking` / `search` / `reasoning_effort`）
// 而不是依赖后缀。
const CAPABILITY_SUFFIXES = [
  {
    suffix: "-thinking",
    desc: "被接受并归一到基础模型；是否真开启深度思考取决于渠道",
    note: "推荐改用请求体参数 thinking:true（部分渠道会下发上游，部分不会）",
  },
  {
    suffix: "-search",
    desc: "被接受并归一到基础模型；是否真联网取决于渠道",
    note: "推荐改用请求体参数 search:true；反代渠道多数不支持联网",
  },
  {
    suffix: "-agent / -agent-swarm",
    desc: "被接受并归一到基础模型（仅影响站内编排语义，API 侧无额外行为）",
    note: "",
  },
];

router.get(
  "/models",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) return;
    const { token, user } = auth;
    const groupName = displayGroupName(token?.group_name || user?.group_name);

    // ① 只取**该分组下的**启用渠道（与 selectChannels 的 channelInGroup 同一判定）。
    //    没绑分组的密钥在这里就被拦下（见下面 authorize 的 token_group_required），
    //    所以 groupName 一定有值。
    const [rows] = await pool.query("SELECT * FROM channels WHERE status = 1");
    const inGroup = rows.filter((r) => channelInGroup(rowToChannel(r), groupName));
    const available = collectAvailableModels(inGroup);

    // 分组下一个渠道都没有 → **空列表**，不是「不限」。
    //
    // 这里踩过一个把整份目录泄漏出去的坑（黑盒测试实测）：
    // `collectAvailableModels` 对「没有渠道」与「渠道声明为空」都返回**空 Set**，
    // 而下面的过滤器原本写作 `available.has(id) || available.has("*") || available.size === 0`
    // —— 最后那个 `size === 0` 分支在「分组没有渠道」时恒为真，
    // 于是**整份模型目录（104 个）**被返回给一个什么都调不了的密钥。
    // 用户按列表选模型 → 必然 503。这正是「列表说能调、调用说不能」的原病。
    if (!inGroup.length) {
      // 带上 capability_suffixes：即使这里一个模型都没有，响应形状也要和
      // 正常路径**一致** —— 客户端只写一套解析逻辑，不该因为空列表就缺字段。
      return res.json({ object: "list", data: [], capability_suffixes: CAPABILITY_SUFFIXES });
    }

    // ② 分组配置的模型白名单（分组管理里设的「只能走这俩模型」就是它）
    const cfg = await groupConfigOf(groupName);
    const allowPatterns = Array.isArray(cfg?.models) ? cfg.models.filter(Boolean) : [];
    // 与 selectChannels / explainNoChannel / 密钥限制**同一套**判定（见 modelInAllowList 注释）
    const allowedByGroup = (id) => modelInAllowList(allowPatterns, id);
    // ③ 密钥级模型限制（令牌管理里可给单把 Key 限模型）。
    //    与 handleCompletion 用的是**同一个** modelAllowed 判定 ——
    //    之前列表页没调用它，导致「列表给 7 个、实际只有 1 个能调」
    //    （黑盒测试实测：限制 glm-5.3-flash 的 Key 看到 7 个模型，其中 6 个 403）。
    const allowedByToken = (id) => modelAllowed(token, id);

    // 能调的模型 = **渠道声明的模型** ∩ 分组白名单 ∩ 密钥限制。
    //
    // 注意这里的主数据源是 `available`（渠道能力）而不是 `allPublicModels()`（厂商登记表）：
    // 反代/聚合渠道会产出**登记表里没有**的模型（hy3、omen-alpha、gemini-3.8-flash-low、
    // mimo-v2.6-flash 等，实测这些都能调通却不在公共目录里）。
    // 原实现是「公共目录 ∩ 分组」，那些模型就被整片吞掉了 ——
    // 一个只能调 omen-alpha 的密钥拿到**空列表**（黑盒测试实测）。
    // 现在反过来：以渠道能力为准，再去公共目录取元信息（vendor/别名）丰富展示。
    const all = await allPublicModels();
    const metaById = new Map(all.map((m) => [String(m.id).toLowerCase(), m]));
    // 渠道声明了通配（models 留空或写 "*"）= 该渠道所属厂商的全部登记模型都可用
    const wildcard = available.has("*");

    const out = [];
    const seen = new Set();
    const pushModel = (id, meta) => {
      const key = String(id).toLowerCase();
      if (!key || seen.has(key)) return;
      if (!allowedByGroup(key) || !allowedByToken(key)) return;
      seen.add(key);
      out.push({
        id: meta?.id || id,
        object: "model",
        // owned_by 用厂商类型，便于客户端区分模型来源
        owned_by: meta?.aliasOf ? meta.vendor : meta?.vendor || meta?.aliasOf || "unknown",
        ...(meta?.vendorName ? { vendor_name: meta.vendorName } : {}),
        ...(meta?.aliasOf ? { alias_of: meta.aliasOf, deprecated: true } : {}),
      });
    };

    if (wildcard) {
      // 通配渠道：公共目录里该有的都给（保留别名与 vendor 元信息）
      for (const m of all) pushModel(m.id, m);
    }
    // 渠道显式声明的模型：即使不在公共目录里也要给（这才是它们的真实来源）
    for (const id of available) {
      if (id === "*") continue;
      pushModel(id, metaById.get(id));
    }
    // 通配情况下，别名（kimi-latest 这类）也要覆盖到：它们不在 available 里，
    // 但 resolveAliasSync 能把它们映射到真实模型，用户调得通。
    if (wildcard) {
      for (const m of all) {
        if (!m.aliasOf) continue;
        pushModel(m.id, m);
      }
    }

    res.json({
      object: "list",
      data: out.sort((a, b) => String(a.id).localeCompare(String(b.id))),
      capability_suffixes: CAPABILITY_SUFFIXES,
    });
  })
);

// ---------- 令牌鉴权 ----------
async function authorize(req, res) {
  // 取 Key：`Authorization: Bearer sk-xxx` 为主，`x-api-key` 为**兼容**。
  //
  // 为什么必须认 x-api-key：官方 Anthropic SDK（@anthropic-ai/sdk）
  // 默认**只发 x-api-key、不发 Authorization**，所以 `new Anthropic({apiKey})`
  // 直连本平台会直接 401。我们的 `/v1/messages` 已经把 SSE 事件序列
  // （message_start → content_block_delta → message_delta → message_stop）、
  // content 分片数组、system block 数组、thinking block 全做对了 ——
  // 就差这一个头，等于把官方 SDK 用户整个挡在门外（黑盒测试实测：
  // 只带 x-api-key → 401；同一个 key 再加 Authorization → 200 完全正常）。
  //
  // 两个头同时存在时以 Authorization 为准（不合并、不叠加）。
  const raw = (
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() ||
    String(req.headers["x-api-key"] || "").trim()
  );
  if (!raw) {
    res.status(401).json({
      error: {
        message:
          "缺少 API Key。请携带 `Authorization: Bearer sk-xxx`（OpenAI 风格），" +
          "或 `/v1/messages` 用 `x-api-key: sk-xxx`（Anthropic 官方 SDK 默认方式）",
        type: "invalid_request_error",
      },
    });
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
      error: { message: `账户 ${CURRENCY}余额不足，请联系管理员充值`, type: "insufficient_user_quota", code: "insufficient_user_quota" }});
    return null;
  }
  // 密钥必须绑定分组 —— 用户要求（原话）：
  //   「我说了密钥必须绑定分组。如果密钥没绑定分组则直接调用的时候报错啊」
  //
  // 为什么必须在**调用时**也拦，而不只是在创建时拦：
  //   · 历史密钥（在「必须绑分组」这条规则上线之前建的）身上是空的，
  //     它们仍然能用，且因为没有分组 → `channelInGroup(c, "")` 只匹配**同样没分组的渠道**
  //     → 走到一批管理员没打算开放的渠道上，计费与可见范围都是不可预期的；
  //   · 只在前端表单必填是不够的（直连 API、脚本、旧客户端都能绕过）。
  // 所以这里做最后一道闸：空分组直接拒绝，并说清怎么修。
  if (!String(token.group_name || "").trim()) {
    res.status(403).json({
      error: {
        message:
          "该 API Key 未绑定分组（已取消「公共池」）。请在「令牌管理」里编辑这把 Key 并选择一个分组后再调用。",
        type: "invalid_request_error",
        code: "token_group_required",
      },
    });
    return null;
  }
  return { token, user };
}

// 密钥级模型限制。判定逻辑与分组白名单**共用** modelInAllowList：
//
// 旧实现是 `model === l || model.startsWith(l)` —— 同样是隐式前缀匹配，
// 于是限制 `deepseek-v4.1-flash` 的 Key 能调 `deepseek-v4.1-flash-thinking`
//（黑盒测试实测：白名单外的模型照样能调通并正常扣费）。
// 归一化 + 精确匹配之后，能力后缀仍然放行（它就是同一个模型），
// 但上游将来新增的 `同前缀-别的模型` 不会再被静默授权。
function modelAllowed(token, model) {
  const limits = String(token.model_limits || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return modelInAllowList(limits, model);
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

// 图片数量上限（按来源分开，因为两类代价完全不同）：
//   · 外链图片：每张都要发一次带凭据的 HTTP 请求 → SSRF/DoS 面 → 严格限制
//   · base64 内嵌：已在请求体里，解码是纯内存操作 → 宽松上限，只防荒唐输入
// 早先两者共用「3 张」的硬上限，用户贴 4 张截图（完全正常）就被拒。
const MAX_REMOTE_IMAGES = 8;
const MAX_INLINE_IMAGES = 30;

// 按来源数图片，不抓取（超限时快速拒绝，避免对上白张外链发请求）
function countImagePartsByKind(messages) {
  let inline = 0;
  let remote = 0;
  for (const m of messages || []) {
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type !== "image_url") continue;
      const url = String(part.image_url?.url || "");
      if (/^data:/i.test(url)) inline += 1;
      else if (/^https?:/i.test(url)) remote += 1;
      else inline += 1; // 其它形态按内联算（适配器自己会判断能不能用）
    }
  }
  return { inline, remote };
}

async function extractImages(messages) {
  const images = [];
  // 远程图片并发抓取：原先在双层 for 里 await，3 张各 800ms 的图要串行等 2.4s，
  // 而这段时间完全在「鉴权之后、调上游之前」，用户侧就是纯等待（首字延迟里最大的一块
  // 固定开销）。改为收集任务后 Promise.all —— 顺序仍按出现顺序保持（all 保证）。
  // base64 图片是纯内存操作，保持同步处理。
  const remoteTasks = [];
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
        remoteTasks.push(url);
      }
    }
  }
  if (remoteTasks.length) {
    const fetched = await Promise.all(
      remoteTasks.map((u) => fetchRemoteImage(u).catch(() => null))
    );
    for (const img of fetched) if (img) images.push(img);
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
  userAgent = "",
  billModel = "",
  tokenQuotaHold = 0}) {
  // tokensEstimated：上游没给（或只给了一部分）usage，用量由字符数估算得到。
  // 下游要把它透出到日志/响应头 —— 估算值不能与精确值用同一个口径展示，
  // 否则管理员看到的是「精确数字」，实际偏差可能很大（第 46 批复审）。
  const { promptTokens, completionTokens, cacheTokens, estimated: tokensEstimated } = splitTokens({ prompt, output, upstreamTotal: usage });
  // 兼容别名必须按真实模型计价（否则落到默认兜底档，偏差可达 3~10 倍）
  // billModel：上游实际跑的不是请求的那个档位时（目前只有 GLM 网页版会这样，
  // 它用页面自身的档位），适配器会把真实档位回传，这里优先按真实档位计价 ——
  // 否则用户按贵档付费、拿到的是另一个档位（或少收）。
  // 只有在真实档位能解析到价格时才采用，避免因为未知档位名落到兜底高价。
  let priceModel = resolveAliasSync(model);
  if (billModel) {
    const actual = await getPrice(resolveAliasSync(billModel));
    // exact=true 才采用：否则说明这个档位没配价，用的是兜底价，
    // 那还不如按用户请求的档位算（至少是明确配置过的价格）。
    if (actual?.exact) {
      priceModel = resolveAliasSync(billModel);
      console.warn(`[gateway] 上游实际档位「${billModel}」与请求「${model}」不一致，按实际档位计费`);
    }
  }
  const basePrice = await getPrice(priceModel);
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
  // 这里用单条 SQL 保证原子性。
  //
  // 余额不足时**允许扣成负数**（quota 是 BIGINT，可以为负），而不是像以前那样
  // 「扣到 0」——那是静默核销：请求已经被服务完了，把 quota 置 0 等于平台自己
  // 把这笔钱一笔勾销，用户下次充值后债务凭空消失。
  // 具体例子：用户余额 1 单位（0.0001 OD），跑了一个应收 52800 单位（5.28 OD）的
  // 请求，旧逻辑实收 0.0001 OD，平台净亏 5.2799 OD。
  // 现在记账成 -52799 单位：账目真实，且下一请求会被鉴权处的 `quota <= 0` 直接挡掉。
  let ret;
  try {
    [ret] = await pool.query(
      "UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ? AND quota >= ?",
      [units, units, user.id, units]
    );
    if (!ret.affectedRows) {
      await pool.query(
        "UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?",
        [units, units, user.id]
      );
      console.warn(
        `[gateway] 用户 ${user.id} 余额不足仍完成请求，已记账为欠费 ${units} 单位（${od} ${CURRENCY}），后续请求将被拒绝直到充值`
      );
    }
  } catch (e) {
    // 扣费是否已提交无法确认：调用方据此跳过部分结算，避免重复扣费
    throw Object.assign(new Error(`扣费结果不确定：${e.message}`), { code: "BILLING_UNCERTAIN" });
  }
  // 扣费后的令牌更新与日志写入是 best-effort：如果这里抛错，调用方 catch 会因
  // settledOnce 还没置位而再次结算，导致用户额度被扣两次。
  //
  // 这两条 UPDATE 合并成一次（同一个 tokens 行），并与「写日志」并发执行：
  // 原先三条串行语句在客户端拿到 [DONE] 之前逐一 await，本机约 1~2ms，
  // 跨机数据库每往返 0.5~3ms，合计 3~15ms 的纯延迟，且直接推迟流式响应的收尾。
  const tokenUpdates = pool
    .query(
      // remain_quota：先加回入口预占的 hold，再扣本次实际用量 —— 净效果 = 只扣实际用量。
      // 没预占时 hold=0，与旧行为完全一致。
      `UPDATE tokens SET used_quota = used_quota + ?, accessed_time = ?,
              remain_quota = IF(unlimited_quota = 1, remain_quota, GREATEST(0, remain_quota + ? - ?))
        WHERE id = ?`,
      [units, now(), Number(tokenQuotaHold) || 0, units, token.id]
    )
    .then(async ([ret]) => {
      // 额度**恰好用尽**时给用户一条站内通知。
      //
      // 人格实测报的（小团队负责人）：「把一把 Key 打爆（403 insufficient_quota），
      // 通知中心一条没多，也没提醒管理员。10 个人的团队里某个人的钥匙悄悄用完了，
      // 只能等他跑来问我，或者我自己去翻列表。」
      //
      // 判据用 affectedRows + 扣完为 0 双重确认：这个 UPDATE 每次都命中（used_quota 变了），
      // 所以真正要判断的是「扣完之后 remain_quota 是否归零」。
      // 只在**从有到无**的那一刻发一次，避免每次调用都刷屏 ——
      // 做法是再查一次当前值并比对（用 GREATEST 保证不会为负，
      // 所以归零后就恒为 0，不会重复触发「从有到无」）。
      const limited = Number(token.unlimited_quota) ? 0 : 1;
      if (!limited || !ret?.affectedRows) return;
      const [[cur]] = await pool
        .query("SELECT remain_quota FROM tokens WHERE id = ? LIMIT 1", [token.id])
        .catch(() => [[null]]);
      if (cur && Number(cur.remain_quota) === 0) {
        const { notify } = await import("../services/notify-center.js");
        await notify({
          userId: user.id,
          actorId: user.id,
          type: "token_quota_exhausted",
          target: { postTitle: token.name || `#${token.id}` },
        }).catch(() => {});
      }
    })
    .catch((e) => console.error("[gateway] 令牌额度更新失败：", e.message));
  const logWrite = writeLog({
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
      // 输入/输出**原文**（仅管理员可见）。
      //
      // 用户要求（原话）：「历史记录原始明细没存储输入和输出实际内容（仅管理员可见）？」
      // 原先 detail 里只有 token 数与价格 —— 排查「用户说回复不对」「这笔为什么这么贵」
      // 时，界面只能显示「提示 19 / 补全 155 tokens」，完全不知道当时问了什么、答了什么。
      //
      // 三条约束（缺一个就会出事）：
      //   ① **只在管理员能看的地方**：detail 列在接口层已按 `isAdmin` 裁剪
      //      （见 routes/log.js 的 cols：非管理员根本不返回这一列），
      //      所以这里不需要再套一层开关。
      //   ② **必须截断**：detail 是 TEXT（64KB 上限），而上下文可达 1M token ——
      //      不截断会让整行 INSERT 失败，连带这条日志一起丢。各留前 4000 字符。
      //   ③ 存的是**拼装后的完整 prompt**（含系统提示与历史消息）：计费按它算，
      //      要复核「为什么这么贵」就得看到真正发出去的那段。
      prompt_text: String(prompt || "").slice(0, 4000),
      output_text: String(output || "").slice(0, 4000),
      // 被截断时明确标记 —— 否则管理员会误以为「模型只输出了 4000 字」
      text_truncated: String(prompt || "").length > 4000 || String(output || "").length > 4000,
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
    // 归一化为纯分组名再写日志：历史绑定值可能是 "厂商:分组名"，原样写会让
    // 同一个分组在日志里出现多种标签，前端按分组聚合/筛选就对不上
    // 密钥没绑分组时退回用户分组，最后兜一句「(未绑定分组)」而不是写空：
    // 空值会让这条记录在「使用记录」页的分组列显示为空、无法按分组聚合
    //（用户实测反馈过这个现象）。注意这只是**日志展示**的兜底 —— 真正调用前
    // authorize 已经拦下空分组密钥（见 token_group_required），正常不会再出现空值。
    groupName: displayGroupName(token?.group_name || user?.group_name) || "(未绑定分组)",
    promptTokens,
    completionTokens,
    cacheTokens,
    // 首 token 耗时：流式为首个增量到达时刻；非流式没有增量信号，按总耗时记
    firstTokenMs: firstTokenAt && startedAt ? firstTokenAt - startedAt : startedAt ? Date.now() - startedAt : 0,
    elapsedMs: startedAt ? Date.now() - startedAt : 0,
    userAgent,
    pricePhase: eff.phase});
  await Promise.all([tokenUpdates, logWrite]);
  // tokensEstimated 透出给调用方：上游没给 usage 时用量是字符估算值，
  // 响应头会带 X-Tokens-Estimated: 1，便于调用方与排查时区分口径。
  return { units, promptTokens, completionTokens, cacheTokens, tokensEstimated };
}

// ---------- 聊天补全 ----------
/**
 * 三种对外协议的共用处理器。
 *
 * 协议差异（怎么读请求、怎么写响应）全部交给 protocol 对象；
 * 中间的鉴权、限流、渠道选择、计费、日志**只有这一份实现** ——
 * 为每个协议复制一份主流程是重复扣费与漏记日志的典型来源。
 */
async function handleCompletion(protocol, req, res) {
  const prefix = protocol.name === "messages" ? "msg" : protocol.name === "responses" ? "resp" : "chatcmpl";
  const requestId = `${prefix}-` + crypto.randomBytes(12).toString("hex");
  const ip = clientIp(req);
  const body = req.body || {};

  // 请求解析（各协议字段名不同：messages / input / system 的位置都不一样）
  let parsed;
  try {
    parsed = protocol.parse(body);
  } catch (e) {
    return protocol.error(res, 400, { message: e.message, code: "invalid_request_error" }, { id: requestId });
  }
  const model = parsed.model;
  const wantStream = parsed.stream === true;
  // 输出上限（max_tokens / max_output_tokens，见 onDelta 处的说明）。
  // 0 = 未指定，不限。要交给结算用，所以声明在这里而不是 onDelta 里。
  const maxOutTokens = Number(parsed.maxTokens) || 0;
  // 已**发给客户端**的输出（与 partialOut 不同：截断后 partialOut 还会继续累积
  // 上游产出用于审计，而 emitted 停在上限处 —— 计费按 emitted 算，
  // 否则用户设了 max_tokens=8 却被按 88 个 token 收费，与「成本控制」的预期相反）
  let emitted = "";
  let outputTruncated = false;

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
    return protocol.error(res, 400, { message: "缺少 model 参数", code: "invalid_request_error" }, { id: requestId });
  }
  if (!modelAllowed(token, model)) {
    return protocol.error(res, 403, { message: `当前 API Key 不允许使用模型 ${model}`, code: "invalid_request_error" }, { id: requestId });
  }
  // 未定价模型**不放行**（用户明确要求：「若没返回则不给用户使用，直接明文返回
  // xxx模型未设定价格」）。
  //
  // 为什么以前允许：未定价会走兜底链（同族 → 同厂商最贵档 → 全表最贵档），
  // 那是「宁可高估不可漏收」的权宜之计 —— 但用户是按**猜出来的**价格付费
  // （实测 mimo-v2.6-flash 被按 claude-opus-5 的最贵档收），而且兜底是静默的，
  // 管理员永远不知道有模型漏配价。
  //
  // 报错刻意用**明文中文**而不是 OpenAI 那套错误码：管理员/用户看到的应当是
  // 「该模型未定价」这个可执行的信息，而不是 invalid_request_error 这种泛化类型。
  // 走 402（需付费/未配置价格）语义最贴近；但为兼容各家 SDK 的错误处理，
  // 统一用 400 + 明确的 message 与 code=model_not_priced。
  if (!(await isModelPriced(model))) {
    return protocol.error(
      res,
      400,
      {
        message: `「${model}」模型未设定价格，请联系管理员在「模型定价」中配置后再使用`,
        code: "model_not_priced",
      },
      { id: requestId }
    );
  }
  // 过滤非对象元素：null/字符串会让适配器 `.map(m => m.role)` 抛 TypeError；
  // 无 code 的异常会被 execute 当成渠道故障并冷却所有渠道（可被构造的 DoS）
  const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).filter(
    (m) => m && typeof m === "object"
  );
  if (!messages.length) {
    const hint = protocol.name === "responses" ? "input 不能为空（字符串或消息数组）" : "messages 不能为空";
    return protocol.error(res, 400, { message: hint, code: "invalid_request_error" }, { id: requestId });
  }

  // 用户级限流（并发 / RPM / TPM）：这三个限额来自系统设置的 default_user_*，
  // 也可被用户 setting.limits 覆盖。放在这里（鉴权后、抓图与调上游之前）：
  // 越早拒绝越省资源，尤其避免大图抓取和上游调用被超额请求白白消耗。
  const promptForLimit = messagesToPrompt(messages);
  const estTokens = estimateRequestTokens(promptForLimit, body.max_tokens);
  const slot = acquire(user, { estimatedTokens: estTokens });
  if (!slot.ok) {
    res.setHeader("retry-after", String(slot.retryAfterSec || 1));
    return res.status(429).json({
      error: { message: slot.message, type: "rate_limit_exceeded", code: slot.code },
    });
  }
  // 请求结束（无论成功失败）都要释放名额；res "close" 与 finally 可能都触发，
  // release() 内部做了幂等保护，不会把计数减成负数。
  res.on("close", () => slot.release());

  // 令牌额度预占：必须在**发起上游调用之前**原子占位，否则并发的 N 个请求
  // 会共享同一次「余额 > 0」检查全部放行（见 holdTokenQuota 的注释）。
  const quotaHold = await holdTokenQuota(token);
  if (!quotaHold.ok) {
    slot.release();
    return protocol.error(
      res,
      403,
      { message: "该 API Key 额度已用尽", type: "insufficient_quota", code: "insufficient_quota" },
      { id: requestId }
    );
  }
  // 结算时会用 hold 的金额做「加回再扣实际」，所以这条只兜底「没走到结算」的路径
  //（上游直接失败、鉴权后异常等）；refund() 幂等，重复调用无害。
  res.on("close", () => quotaHold.refund());

  // 模型名归一化后透传给渠道层匹配（各厂商别名在适配器内部处理）；
  // 是否支持视觉也由适配器判断，网关不预设能力
  const matchModel = modelForChannelMatch(model) || model;
  const wantSearch = /-search$/i.test(String(model || ""));
  // 图片数量与来源分类。
  //
  // 用户实测反馈（原话）：「为啥老是报『不支持三张以上图片，请修改问题或切换对话窗口！』？
  // 这他妈是正常的问题吗，需要解决掉」—— 他说得对，这里有**两个**真实缺陷：
  //
  //   ① **上限的口径错了**：3 张的初衷是防「外链图片」的抓取 DoS
  //      （每个 URL 都要发一次带凭据的 HTTP 请求，几十上百个就是 SSRF/DoS 面）。
  //      但 base64 图片**已经在请求体里了**、解码是纯内存操作，抓不到任何东西 ——
  //      把两者一起卡在 3 张，等于用户贴 4 张截图（完全正常的用法）就被拒。
  //   ② **拒绝方式错的更离谱**：原先不是报错，而是**伪造一条模型回复**
  //      （把提示词当成模型说出的话返回）。用户问 A，收到「不支持三张以上图片」，
  //      看起来像模型答非所问 —— 比直接报错还难排查。
  //
  // 现在：base64 只做「防荒唐」的宽松上限，外链单独限（真正的 DoS 面），
  // 超限走协议层**标准错误**（三种 SDK 都能正常解析成 error）。
  const imgKinds = countImagePartsByKind(messages);
  const localCount = imgKinds.inline;
  const remoteCount = imgKinds.remote;
  const images = await extractImages(messages);

  // 外链过多：这才是需要拦的那一类（每个 URL 一次出站请求）
  if (remoteCount > MAX_REMOTE_IMAGES) {
    return protocol.error(res, 400, {
      message: `单次请求最多支持 ${MAX_REMOTE_IMAGES} 张**外链图片**（当前 ${remoteCount} 张）。请改为上传图片（base64 内嵌）或分成多次请求。`,
      code: "too_many_remote_images",
    }, { id: requestId });
  }
  // base64 过多：纯内存开销，给一个宽松上限防荒唐输入（100 张 20MB 图 = 2GB 内存）
  if (localCount > MAX_INLINE_IMAGES) {
    return protocol.error(res, 400, {
      message: `单次请求最多支持 ${MAX_INLINE_IMAGES} 张图片（当前 ${localCount} 张），请分批发送。`,
      code: "too_many_images",
    }, { id: requestId });
  }

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

  // 图片数量校验已在上方完成（走协议层标准错误，见那里的说明）。
  // 这里不再有「伪造一条模型回复」的分支 —— 那是用户实测反馈的核心问题：
  // 明明是一个参数错误，却伪装成模型的回答，比报错更难排查。

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
  // 厂商归属：模型属于厂商而不是渠道，从模型注册表取（前端厂商维度排行要用）
  let metricVendor = "";
  modelRegistry()
    .then((reg) => {
      metricVendor = reg.get(String(model || "").toLowerCase())?.type || "";
    })
    .catch(() => {});
  const finishMetric = ({ ok = true, status = 200, channelName = "", err = null, usage = null } = {}) => {
    if (metricDone) return;
    metricDone = true;
    leaveRequest();
    const cls = err ? classifyError(err) : { errorCode: "", upstreamStatus: 0 };
    recordRequest({
      ok,
      status,
      ms: Date.now() - startedAt,
      model,
      channel: channelName,
      ttftMs: firstTokenAt ? firstTokenAt - startedAt : 0,
      userId: token?.user_id || 0,
      vendor: metricVendor,
      // token 数用于 TPS 趋势；用量缺失（上游没返回）时按 0 记，不影响 QPS
      tokens: usage ? (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0) : 0,
      errorCode: cls.errorCode,
      upstreamStatus: cls.upstreamStatus,
    });
  };

  // 流式响应统一交给协议对象：三种协议的 SSE 事件名与结构完全不同
  // （chat.completions 是 data: {...chunk}；messages 是 event: content_block_delta；
  //   responses 是 event: response.output_text.delta），这里不再手写其中一种。
  let protoState = null;
  const startStream = () => {
    if (streamStarted || !wantStream) return;
    protoState = protocol.openStream(res, requestId, model);
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
        // 输出上限（max_tokens / max_output_tokens）在这里**真正生效**。
        //
        // 背景（黑盒测试实测）：三个协议都接受该参数却完全不用它 ——
        // 同一 prompt 传 max_tokens: 8 与 4096，两次都返回 88 个 token。
        // 这是成本控制最被信任的旋钮，静默失效比报错更糟：
        // 任何依赖 finish_reason === "length" 判断截断的客户端永远等不到它。
        //
        // 为什么在**网关层**截而不传给上游：本平台大量渠道是网页版反代
        // （浏览器驱动 / OAuth 订阅），上游根本没有这个参数可传；
        // 在唯一收敛点截断，三种协议、所有渠道口径一致。
        // 估算沿用计费的 estimateTokens（字符数/3），所以是**近似上限**：
        // 宁可略超也不误伤短回复（精确值要等上游返回 usage，来不及）。
        // partialOut 始终记录**上游真实产出**（含被截断丢弃的部分）——
        // 它是「上游消耗了多少」的审计依据，与「用户收到多少」是两回事。
        partialOut += t;
        // 已经截断过：后续增量一律不再下发（但继续记账）
        if (outputTruncated) return;
        if (maxOutTokens > 0 && estimateTokens(emitted + t) > maxOutTokens) {
          outputTruncated = true;
          // 只送出还放得下的那一段。估算口径与 estimateTokens 一致（3 字符/token），
          // 所以「还能放多少字符」= maxOutTokens*3 - 已发字符数。
          const room = Math.max(0, maxOutTokens * 3 - emitted.length);
          const keep = t.slice(0, room);
          if (keep) {
            emitted += keep;
            if (wantStream) {
              startStream();
              protocol.delta(protoState, keep);
            }
          }
          return;
        }
        emitted += t;
        if (wantStream) {
          startStream();
          protocol.delta(protoState, t);
        }
      },
      onReasoning: (t) => {
        markFirstToken();
        partialOut += t;
        if (wantStream) {
          startStream();
          if (protocol.reasoning) protocol.reasoning(protoState, t);
        }
      }});

    // 被 max_tokens 截断时，**按实际发给客户端的内容**计费。
    //
    // 为什么不能按上游全量算：上游不受我们控制（网页版反代根本没有这个参数），
    // 它在服务端已经跑完 88 个 token；但用户设 `max_tokens: 8` 的目的正是
    // 控制成本，按 88 收费与这个预期直接相反。
    // 截断时上游的 usage 也不再可信（它算的是全量），所以整段用估算。
    const cutThis = outputTruncated && maxOutTokens > 0;
    const settled = await settle({
      token,
      user,
      model,
      prompt,
      output: cutThis
        ? emitted + (result.reasoning || "")
        : result.content + (result.reasoning || ""),
      usage: cutThis ? null : result.usage,
      ip,
      requestId,
      channel: result.channel,
      // 上游真实档位（仅 GLM 等会与请求不一致的渠道回传）：用于按实际档位计费
      billModel: result.billModel || "",
      startedAt,
      firstTokenAt,
      userAgent,
      tokenQuotaHold: quotaHold.amount});
    // 结算已把预占计入（加回 hold、扣掉实际用量）→ 阻止响应结束时的兜底退回
    quotaHold.consume();
    settledOnce = true;
    finishMetric({ ok: true, status: 200, channelName: result.channel?.name || "", usage: result.usage });
    // TPM 按真实用量记账（预占的是估算值），多退少补
    slot.release({
      tokens: result.usage
        ? (Number(result.usage.prompt_tokens) || 0) + (Number(result.usage.completion_tokens) || 0)
        : null,
    });

    // 计费结果整理成协议层需要的形状（三种协议共用这一份，避免各自算一遍）
    const settledForClient = {
      promptTokens: settled.promptTokens,
      completionTokens: settled.completionTokens,
      cacheTokens: settled.cacheTokens || 0,
      od: Number((settled.units / UNITS_PER_OD).toFixed(6)),
      currency: CURRENCY,
      channel: result.channel?.name || "",
      elapsed: result.elapsed,
      // 用量为估算值（上游未返回 usage）：响应头会带出去，调用方据此判断
      // 是否可以把本次 token 数当精确值用
      estimated: Boolean(settled.tokensEstimated),
      // 因 max_tokens / max_output_tokens 被截断：协议层据此回
      // finish_reason: "length" / stop_reason: "max_tokens" ——
      // 这是客户端判断「回答是否完整」的唯一正规信号
      //（黑盒测试实测：原先永远是 "stop"/"end_turn"，依赖它的 agent 会误判）。
      truncated: cutThis,
    };
    if (settled.tokensEstimated && !res.headersSent) res.setHeader("X-Tokens-Estimated", "1");
    if (cutThis && !res.headersSent) res.setHeader("X-Output-Truncated", String(maxOutTokens));
    if (wantStream) {
      if (!streamStarted) startStream();
      protocol.done(res, protoState, { settled: settledForClient });
    } else {
      protocol.finish(res, {
        id: requestId,
        model,
        content: cutThis ? emitted : result.content,
        reasoning: result.reasoning,
        settled: settledForClient,
      });
    }
  } catch (err) {
    const code = err.code || "UPSTREAM_ERROR";
    console.error(`[gateway] ${requestId} 失败：${code} ${err.message}`);
    // 扣费结果不确定时跳过部分结算（防重复扣费）。
    // 同时把预占「消费掉」：那条 UPDATE 可能已经提交，此时再退回就会白送 1 个单位。
    // 宁可少退也不能多退 —— 多退会让额度阀门永远漏气（正是本次要修的缺陷）。
    if (code === "BILLING_UNCERTAIN") {
      settledOnce = true;
      quotaHold.consume();
    }
    // 已产生内容：按已产出部分结算（客户端已收到这些内容，不能零计费）。
    // 条件不能只看 streamStarted：非流式请求（stream:false）适配器同样边流边回调，
    // 中途失败时 partialOut 也有内容，却会漏计费。
    // 部分结算的金额要留到错误日志里：否则「使用记录」里那笔真实扣费
    // 与「操作日志」里那条 quota=0 的错误行对不上，管理员看不出这次花过钱。
    // 黑盒测试实测抱怨（运维人格原话）：「错误行的 quota/pt/ct 全是 0，
    // 看不出这次已经花了钱」。
    let partialUnits = 0;
    let partialTokens = null;
    if (!settledOnce && partialOut) {
      try {
        const partialSettled = await settle({
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
          userAgent,
          tokenQuotaHold: quotaHold.amount});
        quotaHold.consume();
        partialUnits = Number(partialSettled?.units) || 0;
        partialTokens = {
          prompt: Number(partialSettled?.promptTokens) || 0,
          completion: Number(partialSettled?.completionTokens) || 0,
        };
      } catch (e2) {
        console.error(`[gateway] ${requestId} 部分结算失败：${e2.message}`);
      }
    }
    // 错误行的措辞要能区分「客户端断开 / 上游断开 / 网关超时」——
    // 这三者的处置完全不同（前者不用管、中者要找上游、后者要调超时配置），
    // 而原先一律是上游那句英文原文（如 "This operation was aborted"），分不清。
    const errKind = /abort/i.test(err.message)
      ? clientCtrl.signal.aborted
        ? "客户端提前断开"
        : "上游中断"
      : /timeout|timed out/i.test(err.message)
        ? "超时"
        : "";
    const failReason = errKind ? `${errKind}：${err.message}` : err.message;
    await writeLog({
      user,
      type: LOG_TYPE.ERROR,
      // 已经部分结算过的，把金额写进文案里 —— 与「使用记录」那笔对得上
      content:
        `调用 ${model} 失败：${failReason}` +
        (partialUnits ? ` · 已按已产出内容计费 ${(partialUnits / UNITS_PER_OD).toFixed(4)} ${CURRENCY}` : ""),
      // 带上部分结算的金额与 token：两个日志页都能看出「这次其实花了钱」
      detail: JSON.stringify({ code, requestId, partial_units: partialUnits, partial_tokens: partialTokens }),
      quota: partialUnits,
      promptTokens: partialTokens?.prompt || 0,
      completionTokens: partialTokens?.completion || 0,
      ip,
      requestId,
      model,
      // 失败也归属到渠道：看板的「渠道成功率」按 logs 聚合，没有这个就只能靠 20 条环形缓冲
      channelId: err.channelId || 0,
      channelName: err.channelName || "",
      tokenId: token?.id || 0,
      tokenName: token?.name || "",
      // 归一化为纯分组名再写日志：历史绑定值可能是 "厂商:分组名"，原样写会让
    // 同一个分组在日志里出现多种标签，前端按分组聚合/筛选就对不上
    // 密钥没绑分组时退回用户分组，最后兜一句「(未绑定分组)」而不是写空：
    // 空值会让这条记录在「使用记录」页的分组列显示为空、无法按分组聚合
    //（用户实测反馈过这个现象）。注意这只是**日志展示**的兜底 —— 真正调用前
    // authorize 已经拦下空分组密钥（见 token_group_required），正常不会再出现空值。
    groupName: displayGroupName(token?.group_name || user?.group_name) || "(未绑定分组)",
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
    finishMetric({ ok: false, status, channelName: err.channelName || "", err });
    // 错误也要按协议输出：Anthropic 客户端认 {type:"error",error:{...}}，
    // 拿 OpenAI 的 {error:{...}} 会解析失败并丢掉真正的错误信息。
    const errObj = Object.assign(new Error(err.message), { code });
    if (streamStarted) {
      protocol.errorInStream(res, protoState, errObj);
    } else if (!res.headersSent) {
      protocol.error(res, status, errObj, { id: requestId });
    } else {
      res.end();
    }
  }
}

// 三个协议各自注册路由，共用 handleCompletion。
// 路径与官方一致：/v1/chat/completions、/v1/messages、/v1/responses
router.post("/chat/completions", asyncHandler((req, res) => handleCompletion(PROTOCOLS.chat, req, res)));
router.post("/messages", asyncHandler((req, res) => handleCompletion(PROTOCOLS.messages, req, res)));
router.post("/responses", asyncHandler((req, res) => handleCompletion(PROTOCOLS.responses, req, res)));

export default router;
