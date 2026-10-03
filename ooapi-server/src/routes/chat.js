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
import { ok, fail, asyncHandler, now, safeInt, clientIp } from "../utils.js";
import { authRequired, preAuthJwt, adminRequired } from "../middleware/auth.js";
import { agentFlow, agentPolicy, saveAgentFlow } from "../services/harness/policy.js";
import { modelCapabilities, reasoningSelection } from "../services/model-capabilities.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { logTexts } from "../services/log-text.js";
import { getPrice, originalModelPrice, priceForTokens, computeCost, billingDetails, splitTokens, sumCallTokens, loadPrices, effectivePrice, UNITS_PER_OD, CURRENCY } from "../services/pricing.js";
import { finalizeChannelQuote } from "../services/channel-price-quote.js";
import { userDataVisibility, visibleAccountData, visibleChatAudit } from "../services/user-data-visibility.js";
import { sourceVendors } from "../services/model-sources.js";
import { groupConfigOf, applyGroupRate, parseGroupKey, displayGroupName } from "../services/group-rate.js";
import { allPublicModels, publicModelMetadataMap, modelVendorName, modelRegistry, resolveAliasSync, canonicalModelName, modelInAllowList } from "../services/models.js";
import { getProvider } from "../services/channel-types.js";
import { rowToChannel, channelInGroup, channelSupportsModel, collectAvailableModels } from "../services/router.js";
import { getBoolOption } from "../config.js";
import { saveBuffer, getMedia, readBlob, mediaUrl, attachRef, releaseRefs } from "../services/media.js";
import { runHarness } from "../services/harness/loop.js";
import { requestApproval, decideApproval } from "../services/harness/approvals.js";
import { billableFailedCall } from "../services/execute.js";
import { publicRunError } from "../services/upstream/public-error.js";
import { AGENTS, findAgent, publicAgents, PRIMARY_AGENTS } from "../services/harness/agents.js";
import { toolSpecs } from "../services/harness/tools.js";
import { extractFileText, MAX_UPLOAD_FILES, MAX_UPLOAD_BYTES, TEXT_FILE_EXTS } from "../services/harness/files.js";
import { startRun, getRun, isRunning, publish, subscribe, finishRun, runStatus } from "../services/harness/runs.js";
import { isChatDraining, trackChatRun } from "../services/harness/drain.js";
export { drainChatRuns } from "../services/harness/drain.js";
import { holdTokenQuota } from "../services/token-quota.js";
import {
  createSession,
  listSessions,
  sessionCounts,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  batchSessions,
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
// 轻量预鉴权放在 express.json 之前：匿名/伪造请求没必要先被缓冲 20MB 大包。
// 只验 JWT 签名（不查库），完整 authRequired 仍在各路由上。
router.use(preAuthJwt);
router.use(express.json({ limit: "20mb" }));
router.get("/flow", authRequired, adminRequired, asyncHandler(async (_req, res) => ok(res, agentFlow())));
router.put("/flow", authRequired, adminRequired, asyncHandler(async (req, res) => {
  try { return ok(res, await saveAgentFlow(req.body)); }
  catch (e) { return fail(res, e.message, 400); }
}));
// 对话读取/CRUD的统一返回投影；保留库里的真实金额与用量用于后续计费审计。
router.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(body?.data ? { ...body, data: visibleChatAudit(body.data, userDataVisibility(req.user), { isAdmin: Number(req.user?.role) >= 100 }) } : body);
  next();
});

/**
 * 用户的「密钥」列表（前端选 Key 用）。
 * 站内对话虽然扣账户额度（不走 Key 的额度），但**路由配置挂在 Key 上**：
 * Key 绑定的分组决定能调用哪些渠道、哪些模型、按什么倍率计费。
 * 所以这里把 Key 作为「路由身份」暴露给前端，与网关 /v1 的 groupName 口径一致。
 */
export async function listUserKeys(user) {
  const [rows] = await pool.query(
    "SELECT id, name, key_str, status, expired_time, group_name, model_limits, unlimited_quota, remain_quota, used_quota FROM tokens WHERE user_id = ? ORDER BY id ASC",
    [user.id]
  );
  const nowSec = Math.floor(Date.now() / 1000);
  // 分组展示信息（备注/倍率/成员厂商）：密钥菜单与列表按「折叠态厂商图标 + 分组名」展示
  const names = [...new Set(rows.map((t) => parseGroupKey(t.group_name)?.name).filter(Boolean))];
  const meta = new Map();
  if (names.length) {
    const ph = names.map(() => "?").join(",");
    const [gs] = await pool.query(`SELECT name, remark, rate FROM channel_groups WHERE name IN (${ph})`, names);
    for (const g of gs) meta.set(g.name, { remark: g.remark || "", rate: Number(g.rate) || 1, vendors: new Set() });
    const [chans] = await pool.query("SELECT type, group_list, group_name FROM channels");
    for (const c of chans) {
      let list = [];
      try {
        const arr = c.group_list ? JSON.parse(c.group_list) : [];
        if (Array.isArray(arr)) list = arr.map((s) => String(s)).filter(Boolean);
      } catch {
        list = c.group_name ? [String(c.group_name)] : [];
      }
      for (const n of list) if (meta.has(n) && c.type) meta.get(n).vendors.add(String(c.type));
    }
  }
  return rows.map((t) => {
    const expired = Number(t.expired_time) !== -1 && Number(t.expired_time) <= nowSec;
    const gkey = parseGroupKey(t.group_name);
    const gm = gkey ? meta.get(gkey.name) : null;
    // 未绑分组的密钥**不能用于对话**：activeKeyOf 会跳过它，网关也返回
    // token_group_required（黑盒测试实测：管理员删掉分组后，外部 API 立刻 403，
    // 站内对话却照常可用，还会路由到「同样没分组的渠道」上）。
    // 这里仍然把它列出来，但标记 usable:false 并给出原因 ——
    // 直接隐藏会让用户以为密钥丢了；列出来却看似可用，则是选中之后才报错。
    const unbound = !String(t.group_name || "").trim();
    return {
      id: Number(t.id),
      name: t.name || `密钥 ${t.id}`,
      // 只回传前后几位，避免完整密钥出现在页面/日志里
      masked: `${String(t.key_str || "").slice(0, 8)}…${String(t.key_str || "").slice(-4)}`,
      status: expired ? 3 : Number(t.status) || 1,
      usable: !expired && Number(t.status) === 1 && !unbound,
      unusable_reason: expired
        ? "已过期"
        : Number(t.status) !== 1
          ? "已禁用"
          : unbound
            ? "未绑定分组，不能用于对话"
            : "",
      group: t.group_name || "",
      group_name: gkey?.name || "",
      group_remark: gm?.remark || "",
      ...(userDataVisibility(user).pricing ? { group_rate: gm?.rate || 1 } : {}),
      group_vendors: gm ? [...gm.vendors] : [],
      model_limits: String(t.model_limits || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  });
}

/**
 * 取「当前可用的密钥」：站内对话必须通过密钥路由（分组→模型/渠道/倍率），
 * 未指定密钥（keyId=0）时，默认选取当前账户下第一个可用的有效密钥（status=1 且未过期）。
 * 没有可用密钥时不给模型、也不允许开跑。禁用/过期/不属于该用户的密钥一律视为不可用。
 */
async function activeKeyOf(user, keyId = 0) {
  const id = safeInt(keyId, { min: 1 }) || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (id) {
    const [rows] = await pool.query("SELECT * FROM tokens WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!rows.length) return null;
    const t = rows[0];
    const expired = Number(t.expired_time) !== -1 && Number(t.expired_time) <= nowSec;
    if (Number(t.status) !== 1 || expired) return null;
    // 未绑分组 → 不可用（与网关的 token_group_required 同一口径）。
    // 不拦的话，显式传 keyId 就能选中一把未绑分组的密钥绕过校验。
    if (!String(t.group_name || "").trim()) return null;
    return t;
  }
  // 未指定密钥时，默认选取第一个可用有效密钥。
  //
  // **必须排除未绑分组的密钥**（与网关 authorize 的 token_group_required 同一口径）。
  //
  // 这里踩过一个让「必须绑分组」这条规则形同虚设的漏洞（黑盒测试实测）：
  // 站内对话走的是本条查询，而它只筛 status/过期 —— 于是一把密钥在管理员
  // 删掉它所属的分组之后（routes/channel.js 会把 tokens.group_name 清空），
  // **外部 API 立刻 403 拒绝，但站内对话照常可用**，还会因为
  // `channelInGroup(c, null)` 只匹配「同样没分组的渠道」而路由到管理员
  // 没打算开放的渠道上 —— 既绕过了校验，又绕过了分组范围。
  const [rows] = await pool.query(
    "SELECT * FROM tokens WHERE user_id = ? AND status = 1 AND (expired_time = -1 OR expired_time > ?)" +
      " AND group_name IS NOT NULL AND group_name <> '' ORDER BY id ASC LIMIT 1",
    [user.id, nowSec]
  );
  return rows[0] || null;
}

const VENDOR_NAMES = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  glm: "智谱 GLM",
  qwen: "阿里通义千问",
  kimi: "Moonshot Kimi",
  doubao: "字节豆包",
  minimax: "MiniMax",
  stepfun: "阶跃星辰",
  grok: "xAI Grok",
  mimo: "小米 MiMo",
  ark: "火山引擎",
  qoder: "Qoder",
  workbuddy: "WorkBuddy",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  siliconflow: "SiliconFlow",
  custom: "自定义渠道",
  other: "其他厂商",
};

/**
 * 用户可用的模型。
 *
 * 核心口径：**按「当前账户 + 选定密钥（默认第一个）」实际能调用的模型来算**。
 *   · 必须有可用密钥（没有密钥时返回空，引导用户去创建）
 *   · 密钥绑定的分组决定：分组限制的模型 ∩ 分组成员渠道声明的模型
 *   · 当分组下无可用渠道时，严格返回空，绝不展示写死的默认兜底模型
 *   · 自动去重并按厂商精准归类
 */
async function availableModels(user, keyId = 0) {
  const isAdmin = Number(user?.role) >= 100;

  // 1) 解析本次请求用的密钥与路由分组；没有可用密钥 → 没有可选模型
  const key = await activeKeyOf(user, keyId);
  if (!key) return [];
  const groupName = key.group_name || null;

  // 2) 分组成员渠道能服务的模型
  const [channelRows] = await pool.query("SELECT * FROM channels WHERE status = 1");
  const channelsInGrp = channelRows.filter((r) => channelInGroup(rowToChannel(r), groupName));

  /**
   * 该分组里是否有渠道能带图服务这个模型 —— 决定前端「能不能贴图」。
   *
   * 为什么不能只信厂商模型表里的 `vision` 字段：那是**人工猜的**，而且已被证伪 ——
   * `deepseek-v4.1-flash` 在 workbuddy-models.js 里写着 vision:false，
   * 但实测通过 /v1/chat/completions 正确识出了品红色（附件确实送到了模型）。
   * 原因是 vision 本质上是「**上游 + 模型**」的属性，而同一模型可能被多个渠道
   * 服务（该模型同时挂在 workbuddy 与 OpenCode 上），我们无从逐个确知。
   *
   * 判定规则（乐观优先）：
   *   · 委托给 openai-compat / anthropic-compat 的适配器 —— 它们会把 images
   *     一路带到上游（workbuddy / opencode / cline 等都是 `{...args}` 转发），**带图**；
   *   · 明确只做纯文本的适配器（trae / cursor，协议里没有图片字段）—— **不带图**；
   *   · 其余（浏览器驱动的网页反代等）—— 按**带图**处理。
   * 乐观的理由是两个方向的错代价不对等：错成 true 会让用户得到一个明确的上游报错
   * （换模型即可）；错成 false 会让用户**根本看不到这个能力**（实测就是如此 ——
   * 7 个模型全被标成不支持，图片按钮全程灰着）。
   */
  const TEXT_ONLY_TYPES = new Set(["trae", "cursor"]);
  const channelCarriesImages = (r) => !TEXT_ONLY_TYPES.has(String(r.type || ""));
  const supportingChannels = (modelId) => channelsInGrp.filter((r) => channelSupportsModel(rowToChannel(r), modelId));
  const anyChannelCarriesImages = (modelId) => supportingChannels(modelId).some(channelCarriesImages);

  // 若当前分组没有可用渠道，严格返回空模型，绝不回退到全量默认模型
  if (!channelsInGrp.length) return [];

  // 3) 分组限制的模型（分组配了 models 就只给这些）
  const gcfg = groupName ? await groupConfigOf(groupName) : null;
  const groupModels = gcfg?.models?.length ? gcfg.models : null;
  // 与网关 / selectChannels 同一套判定（modelInAllowList：精确匹配规范名 + 显式通配）。
  // 旧实现各写一套，站内与网关对同一个白名单会给出不同结论。
  const groupAllows = (id) => (groupModels ? modelInAllowList(groupModels, id) : true);

  // 4) 密钥自身的模型白名单（管理员豁免）
  const limits = key
    ? String(key.model_limits || "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const keyAllows = (id) => {
    if (isAdmin || !limits.length) return true;
    // 旧逻辑 `id.startsWith(l)` 等于隐式前缀通配：限制 deepseek-v4.1-flash
    // 会顺带放行 deepseek-v4.1-flash-xxx。网关早已改为精确匹配，这里对齐。
    return modelInAllowList(limits, id);
  };

  // 5) 汇总该分组渠道支持的模型集合
  await modelRegistry();
  const supported = collectAvailableModels(channelsInGrp);
  if (supported.size === 0) return [];

  // 从公开模型库中筛选
  const publicModels = publicModelMetadataMap(await allPublicModels());
  // 接入厂商与模型开发厂商是两种身份：按接入厂商去重、选择和路由，价格仍按规范模型。
  const candidateModels = new Map(); // channelType:canonicalModel -> modelObj

  for (const sourceModel of publicModels.values()) {
    const pm = publicModels.get(canonicalModelName(sourceModel.id)) || sourceModel;
    const idLower = String(pm.id).toLowerCase();
    for (const r of supportingChannels(pm.id)) {
      if (groupAllows(pm.id) && keyAllows(pm.id)) {
        const v = r.type || "other";
        candidateModels.set(`${v}:${canonicalModelName(pm.id) || idLower}`, {
          id: canonicalModelName(pm.id) || pm.id,
          label: pm.label || pm.id,
          desc: pm.desc || "",
          // 公开库里明确标了 true 就用它；否则看**服务这个模型的渠道**能不能带图。
          // 不能只信模型表里的 vision —— 那是人工猜的（已被证伪，见上方注释）。
          vision: !TEXT_ONLY_TYPES.has(v) && (Boolean(pm.vision) || anyChannelCarriesImages(pm.id)),
          thinkingDefault: pm.thinkingDefault,
          supportsSearch: pm.supportsSearch,
          supportsThinking: pm.supportsThinking,
          deprecated: Boolean(pm.deprecated),
          vendor: v,
          vendorName: getProvider(v)?.name || modelVendorName(v),
          channel_type: v,
          aliasOf: pm.aliasOf,
        });
      }
    }
  }

  // 6) 检查渠道显式配置的模型（包含自定义/未录入公开库的模型）
  for (const r of channelsInGrp) {
    const ch = rowToChannel(r);
    const declared = String(ch.models || "")
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const rawM of new Set([...declared, ...collectAvailableModels([r])])) {
      if (rawM.includes("*")) continue;
      const idLower = rawM.toLowerCase();
      const canonical = canonicalModelName(rawM);
      const candidateKey = `${ch.type || "other"}:${canonical || idLower}`;
      if (candidateModels.has(candidateKey)) continue;
      if (!groupAllows(rawM) || !keyAllows(rawM)) continue;
      if (!channelSupportsModel(ch, rawM)) continue;

      // 即使模型已登记为 Qwen，Cline 提供的入口也必须显示 Cline，不能混成原厂渠道。
      const vendor = ch.type || "other";
      const vendorName = getProvider(vendor)?.name || modelVendorName(vendor);

      candidateModels.set(candidateKey, {
        id: canonical || rawM,
        label: canonical || rawM,
        desc: "",
        // 渠道声明的模型（不在公开模型库里）：**默认允许附图**，而不是硬编码 false。
        //
        // 这里原先写死 `false`，后果是「站内对话的图片按钮对所有可用模型都是灰的」
        // （黑盒复验实测：7 个模型全部 vision=false，按钮显示「当前模型不支持图片」，
        // 于是用户根本没法在站内贴图 —— 而我们刚把图片上限从 3 张放宽到 30 张，
        // 这条路径却被前端闸门挡死）。
        //
        // 为什么默认 true 而不是 false —— 两个方向的错代价不对等：
        //   · 错成 true：用户贴图 → 上游若不支持，会返回一个**明确的错误**
        //     （适配器的 VISION_NOT_SUPPORTED 或上游 400），用户知道发生了什么，
        //     换模型即可；
        //   · 错成 false：用户**根本看不到这个能力**，以为平台不支持贴图，
        //     而这个模型可能明明能用图（实测 `deepseek-v4.1-flash` 通过
        //     /v1/chat/completions 正确识出了品红色，而厂商模型表里写的是 false）。
        // 厂商模型表（各 *-models.js）里的 vision 是**人工猜的**，已被证伪至少一处；
        // 所以这里不再把它当权威，改为看**当前这个渠道**能不能带图
        //（纯文本适配器如 trae / cursor 的模型正确地标成不支持）。
        vision: channelCarriesImages(r),
        thinkingDefault: false,
        supportsSearch: true,
        supportsThinking: true,
        deprecated: false,
        vendor,
        vendorName,
        channel_type: ch.type || "",
      });
    }
  }

  // 6.5) 别名条目去重：规范名已在列表里时，不再重复展示旧名/托管名。
  //
  // 背景（用户实测）：DeepSeek 官方把 V4.1-Flash 更名为 deepseek-flash，而
  // WorkBuddy 托管档登记的还是旧 id deepseek-v4.1-flash（aliasOf 指向规范名）——
  // 同一分组里两个条目都指向同一个模型，下拉出现「v4.1f 和 flash 俩」。
  // 只在**规范名确实也在列表里**时才隐藏：若分组里只有托管渠道（规范名不在），
  // 保留别名条目，否则用户会没有任何 deepseek 可选（调得通但选不到，更糟）。
  for (const [idLower, entry] of [...candidateModels]) {
    const target = String(entry.aliasOf || "").toLowerCase();
    const targetKey = `${entry.vendor}:${canonicalModelName(target) || target}`;
    if (target && targetKey !== idLower && candidateModels.has(targetKey)) candidateModels.delete(idLower);
  }

  // 7) 补充价格信息并生成最终结果
  const priceMap = await loadPrices();
  const result = [];
  for (const m of candidateModels.values()) {
    const p = priceMap.get(canonicalModelName(m.id)) || priceMap.get(String(m.id).toLowerCase());
    if (!p) continue;
    const identity = p.model;
    const capabilities = modelCapabilities(identity);
    if (!["chat", "decision"].includes(capabilities.category)) continue;
    if (result.some(item => item.id === identity)) continue;
    result.push({
      ...m, id: identity, label: identity, vendor: p.type || m.vendor, vendorName: modelVendorName(p.type || m.vendor),
      capabilities,
      vision: m.vision !== false && (capabilities.verification === "unverified" && !capabilities.customized || capabilities.inputTypes.includes("image")),
      channel_type: "", model_vendor: p.type || m.vendor,
      // loadPrices 返回的键是 input/output/cache（已从列名 input_price 映射），
      // 这里原先读 p.input_price → undefined → NaN → JSON null，下拉/弹窗价格全空（子代理复核发现）
      ...(userDataVisibility(user).pricing ? { price: p ? { input: Number(p.input), output: Number(p.output), cache: Number(p.cache) } : null } : {}),
    });
  }

  return result;
}

/** 解析密钥的路由分组（/run 用；与 availableModels 同一套优先级；没有可用密钥返回 null） */
async function routeGroupOf(user, keyId = 0) {
  const key = await activeKeyOf(user, keyId);
  return key ? key.group_name || null : null;
}

/** 把模型按厂商归类并排好序（前端下拉按厂商分组展示，无重复项） */
function groupModelsByVendor(models) {
  const VENDOR_ORDER = [
    "openai",
    "anthropic",
    "gemini",
    "deepseek",
    "glm",
    "qwen",
    "kimi",
    "doubao",
    "minimax",
    "stepfun",
    "grok",
    "mimo",
    "ark",
    "qoder",
    "workbuddy",
    "opencode",
    "custom",
    "other",
  ];
  const map = new Map();
  for (const m of models) {
    const key = m.vendor || "other";
    if (!map.has(key)) {
      map.set(key, { vendor: key, vendorName: m.vendorName || VENDOR_NAMES[key] || key, models: [] });
    }
    map.get(key).models.push(m);
  }

  const sortedVendors = [];
  for (const v of VENDOR_ORDER) {
    if (map.has(v)) {
      sortedVendors.push(map.get(v));
      map.delete(v);
    }
  }
  for (const g of map.values()) {
    sortedVendors.push(g);
  }
  return sortedVendors;
}

// 单个附件正文上限：留出余量给历史与工具结果，避免一个大文件把上下文挤爆
const FILE_TEXT_LIMIT = 30000;

// 站内对话单次可带的最大图片数。与网关的 MAX_INLINE_IMAGES 同口径（见下方 748 行的说明）：
// 站内上传是 base64 内嵌，只有解码与内存代价，没有外链抓取的 SSRF/DoS 面。
const MAX_CHAT_IMAGES = 30;
function clipFileText(text) {
  const s = String(text || "");
  return s.length > FILE_TEXT_LIMIT ? `${s.slice(0, FILE_TEXT_LIMIT)}\n…（文件较长，已截断）` : s;
}

// ---------- 元信息（密钥 / 模型 / 厂商 / 智能体 / 工具 / 默认值）----------
// keyId：按某个密钥的能力算模型（分组模型 ∩ 密钥白名单 ∩ 渠道声明）。
// 未指定时默认选取当前账户下的第一个可用密钥。
router.get(
  "/meta",
  authRequired,
  asyncHandler(async (req, res) => {
    let keyId = safeInt(req.query.keyId, { min: 1 }) || 0;
    const keys = await listUserKeys(req.user);
    // 默认选取当前账户下的第一个可用密钥
    if (!keyId) {
      const first = keys.find((k) => k.status === 1);
      if (first) keyId = first.id;
    }
    const [models, activeKey] = await Promise.all([
      availableModels(req.user, keyId),
      keyId ? activeKeyOf(req.user, keyId) : null,
    ]);
    return ok(res, {
      currency: CURRENCY,
      units_per_od: UNITS_PER_OD,
      ...visibleAccountData({ quota: Number(req.user.quota), used_quota: Number(req.user.used_quota) }, req.user),
      models,
      // 厂商分组：前端模型下拉按厂商归类展示（带厂商图标），无重复模型且分类准确
      vendors: groupModelsByVendor(models),
      // 密钥：站内对话按账户额度计费，但路由配置挂在密钥上（分组决定可用模型与倍率）
      keys,
      active_key_id: keyId,
      active_key: activeKey
        ? {
            id: activeKey.id,
            name: activeKey.name,
            group_name: activeKey.group_name || "",
          }
        : null,
      agents: publicAgents(AGENTS),
      tools: toolSpecs(TOOL_IDS).map(({ id, name, desc }) => ({ id, name, desc })),
      defaults: { agent: PRIMARY_AGENTS[0]?.id || "general", maxSteps: DEFAULT_MAX_STEPS, maxStepsLimit: MAX_STEPS_LIMIT },
      chat_enabled: getBoolOption("chat_enabled"),
      // 附件能力（前端文件选择器据此显示可选类型）
      upload: { max_files: MAX_UPLOAD_FILES, max_bytes: MAX_UPLOAD_BYTES, text_types: TEXT_FILE_EXTS },
    });
  })
);

// ---------- 会话 CRUD ----------
router.get(
  "/sessions",
  authRequired,
  asyncHandler(async (req, res) => {
    const { q, limit, archived, projectId } = req.query;
    const [sessions, counts] = await Promise.all([
      listSessions(req.user.id, { q, limit, archived, projectId }),
      sessionCounts(req.user.id),
    ]);
    return ok(res, { sessions, counts });
  })
);

// ---------- 项目（ChatGPT 式分类；只做组织，不影响计费与路由）----------
router.get(
  "/projects",
  authRequired,
  asyncHandler(async (req, res) => {
    return ok(res, { projects: await listProjects(req.user.id) });
  })
);

router.post(
  "/projects",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name = "", remark = "" } = req.body || {};
    return ok(res, await createProject({ userId: req.user.id, name, remark }));
  })
);

router.put(
  "/projects/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, remark } = req.body || {};
    const project = await updateProject(req.user.id, req.params.id, { name, remark });
    if (!project) return fail(res, "项目不存在", 404);
    return ok(res, project);
  })
);

// 删除项目不删会话：项目下的对话会退回「未归类」，避免误删聊天记录
router.delete(
  "/projects/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const okDel = await deleteProject(req.user.id, req.params.id);
    if (!okDel) return fail(res, "项目不存在", 404);
    return ok(res, { id: req.params.id });
  })
);

// ---------- 批量操作（侧栏多选：归档/删除/移动项目/置顶）----------
router.post(
  "/sessions/batch",
  authRequired,
  asyncHandler(async (req, res) => {
    const { ids = [], action, projectId = "" } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, "请先选择会话");
    try {
      const result = await batchSessions({ userId: req.user.id, ids, action, projectId });
      return ok(res, result);
    } catch (e) {
      if (e.code === "NO_PROJECT") return fail(res, "项目不存在", 404);
      if (e.code === "BAD_ACTION") return fail(res, "不支持的批量操作");
      throw e;
    }
  })
);

router.post(
  "/sessions",
  authRequired,
  asyncHandler(async (req, res) => {
    if (!getBoolOption("chat_enabled")) return fail(res, "站内对话功能已关闭", 403);
    const { agent = "general", model = "", settings = {}, projectId = "" } = req.body || {};
    if (!findAgent(agent)) return fail(res, "智能体不存在");
    const session = await createSession({ userId: req.user.id, agent, model, settings, projectId });
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
    // 非法 fromSeq 绝不能兜底成 1：那会 DELETE seq>=1 清空整个会话（不可逆）
    const seq = safeInt(fromSeq, { min: 1 });
    if (!seq) return fail(res, "fromSeq 无效");
    const result = await rewindSession(req.user.id, req.params.id, seq);
    if (!result) return fail(res, "会话不存在", 404);
    return ok(res, await sessionWithMessages(req.user.id, req.params.id));
  })
);

// ---------- 计费（用户额度）----------
// 与网关同一套原子扣费；harness 传进来的 tokens 是「每次上游调用分别 splitTokens 后求和」，
// 混用 API 渠道（结构化 usage）与反代渠道（usage=null）时不会互相覆盖口径。
async function chargeUser({ user, model, prompt, output, usage, channel, channelIds, tokens, kind, groupName = null, keyId = 0, keyName = "", startedAt = 0, firstTokenAt = 0, userAgent = "", ip = "", calls = null, tokenQuotaHold = 0, sessionId = "", inputText = "", status = "success", errorCode = "", retryCount = 0, isUsage = true, writeUsage = true, requestId = "", errorMessage = "", httpStatus = 0 }) {
  const actualModel = Array.isArray(calls) && calls.length ? calls.at(-1).billModel || calls.at(-1).model || model : model;
  const displayModel = canonicalModelName(actualModel) || model;
  let { promptTokens, completionTokens, cacheTokens } =
    tokens || splitTokens({ prompt, output, upstreamTotal: usage });
  // 兼容别名必须按真实模型计价（否则落到默认兜底档，偏差可达 3~10 倍）
  const basePrice = await getPrice(resolveAliasSync(model));
  const originalPrice = await originalModelPrice(model);
  // 分组倍率：用户绑定分组后按分组倍率计费（rate=1 时不变）
  // 倍率按本次实际路由的分组（选了密钥就是密钥的分组），与网关 /v1 口径一致
  const gcfg = await groupConfigOf(groupName);

  // 分时（峰谷）定价。
  // 站内对话一轮可能跑十几分钟（最多 16 步 + 子代理），跨过峰谷分界点时
  // 「按整轮发起时刻判一次档」会把边界之后的所有用量都按旧档计价：
  // 谷时开始跨入峰时系统性少收、峰时开始跨入谷时对用户多收，两边都是最多 2 倍。
  // 因此这里改为**按每次上游调用各自的时刻分别判档**，再求和 ——
  // loop.js 已经为每条调用记了 startedAt，正好可用（与网关的逐请求口径一致）。
  let price;
  let eff;
  let units;
  let baseUnits;
  const modelCalls = [];
  const billingCalls = [];
  if (Array.isArray(calls) && calls.length) {
    let sum = 0;
    const phases = new Set();
    for (const c of calls) {
      const at = Number(c.startedAt) || startedAt || Date.now();
      const reportedPrice = c.model ? await getPrice(resolveAliasSync(c.model)) : basePrice;
      // 上游可能回内部部署名，不能把已明确配价的请求变成零单价。
      const callPrice = reportedPrice.exact ? reportedPrice : basePrice;
      const e = effectivePrice(callPrice, at);
      phases.add(e.phase);
      const t =
        c.tokens ||
        splitTokens({ prompt: c.prompt || "", output: c.output || "", upstreamTotal: c.usage || null });
      const tierPrice = priceForTokens(e.price, t.promptTokens);
      billingCalls.push({ price: tierPrice, tokens: t, at, phase: e.phase,
        requestedModel: c.requestedModel || model, upstreamModel: c.upstreamModel || "", pricingModel: canonicalModelName(callPrice.model),
        channelQuote: finalizeChannelQuote(c.channelQuote, t.promptTokens) });
      modelCalls.push({ requested_model: c.requestedModel || model, upstream_model: c.upstreamModel || "", model: canonicalModelName(c.model || model), pricing_model: callPrice.model, price: { in: tierPrice.input, out: tierPrice.output, cache: tierPrice.cache }, price_phase: e.phase, context_tier: tierPrice.contextTier || 0 });
      sum += computeCost({ price: e.price, promptTokens: t.promptTokens, completionTokens: t.completionTokens, cacheTokens: t.cacheTokens });
    }
    baseUnits = sum;
    units = applyGroupRate(baseUnits, gcfg?.rate);
    // 展示口径 = 计费口径：日志/消息统计里的 token 必须取自**逐调用计费**所用的
    // 那一组汇总。线上事故（用户实测）：失败轮（对话（部分））没有可见正文时，
    // 调用方的 tokens 还是 0/0，而钱按失败步的长上下文算出来了 ——
    // 于是出现「收了费但 token 显示 0/0」。见 pricing.js#sumCallTokens。
    const billed = sumCallTokens(calls);
    promptTokens = billed.promptTokens;
    completionTokens = billed.completionTokens;
    cacheTokens = billed.cacheTokens;
    // 审计用：跨档时记 "peak+offpeak"，单档时记该档位
    eff = { phase: phases.size > 1 ? [...phases].join("+") : [...phases][0] || "peak", price: basePrice };
    const onlyCall = modelCalls.length === 1 ? modelCalls[0] : null;
    price = onlyCall ? { ...basePrice, input: onlyCall.price.in, output: onlyCall.price.out, cache: onlyCall.price.cache, contextTier: onlyCall.context_tier } : basePrice;
  } else {
    eff = effectivePrice(basePrice, startedAt || Date.now());
    price = priceForTokens(eff.price, promptTokens);
    // 站内对话一轮可能跨多个渠道（harness 多步），无法对单次调用套用账号级
    // context_billing，这里保持既有的「全额」口径（与网关默认一致）。
    baseUnits = computeCost({ price, promptTokens, completionTokens, cacheTokens });
    units = applyGroupRate(baseUnits, gcfg?.rate);
    billingCalls.push({ price, tokens: { promptTokens, completionTokens, cacheTokens }, at: startedAt,
      phase: eff.phase, requestedModel: model, pricingModel: canonicalModelName(basePrice.model) });
  }
  const bill = billingDetails({ calls: billingCalls, multiplier: gcfg?.rate, chargedUnits: units, baseUnits });

  // 注意：这里**不能**在余额为 0 时直接抛错。旧实现有这一行，后果是
  // 「整轮对话已经完整交付给用户，却一分钱不扣、连一条消费日志都不写」
  // （余额被并发请求清零或管理员扣款时命中，16 步 harness 白送）。
  // 正确做法是照常记账：余额不够就扣成负数（见下），让鉴权处的余额检查
  // 去挡住**下一个**请求，而不是让已经发生的这一轮凭空消失。
  const conn = await pool.getConnection();
  let committing = false;
  let logId = 0;
  try {
    await conn.beginTransaction();
    const [ret] = await conn.query(
      "UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ? AND quota >= ?",
      [units, units, user.id, units]
    );
    if (!ret.affectedRows) {
      const [fallback] = await conn.query(
        "UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?",
        [units, units, user.id]
      );
      if (!fallback.affectedRows) throw new Error("计费账户已不存在");
      console.warn(
        `[chat] 用户 ${user.id} 余额不足仍完成对话，已记账为欠费 ${units} 单位，后续请求将被拒绝直到充值`
      );
    }
  // **令牌侧的 used_quota / remain_quota 也要一起记**。
  //
  // 黑盒测试实测（原话）：「Token 的 used_quota 不含站内对话 —— 两本账对不上」：
  // 站内对话调的就是用户选的那把 Key（前端 `POST /api/chat/run` 带 keyId），
  // usage log 里 98 条也全部挂在它名下，但只有网关那条路写 tokens 表，
  // chat 这条路只写 users → 令牌管理页的「已用」少算了站内对话那一份
  //（实测差额 14 单位 = 该 Key 名下所有 browser/chrome 渠道的日志合计）。
  // 后果：按令牌额度做限流/预算的调用方守不住（额度早就该用尽了却仍显示有余）。
  //
  // 与 gateway 的 settle 同一口径：加回入口预占的 hold，再扣本次实际用量。
  if (keyId) {
    await conn.query(
        `UPDATE tokens SET used_quota = used_quota + ?, accessed_time = ?,
                remain_quota = IF(unlimited_quota = 1, remain_quota, GREATEST(0, remain_quota + ? - ?))
          WHERE id = ? AND user_id = ?`,
        [units, now(), Number(tokenQuotaHold) || 0, units, keyId, user.id]
      );
    // 运行与连接解绑，用户可能在上游执行期间删除密钥。密钥统计允许缺席，
    // 已消耗的账户费用与审计日志必须照常提交（与网关 settle 一致）。
  }
  if (writeUsage) logId = await writeLog({
    connection: conn,
    user,
    type: status === "success" ? LOG_TYPE.CONSUME : LOG_TYPE.ERROR,
    content: `${kind} · ${displayModel} · 提示 ${promptTokens} / 补全 ${completionTokens} tokens${
      cacheTokens ? ` / 缓存 ${cacheTokens}` : ""
    } · ${(units / UNITS_PER_OD).toFixed(4)} ${CURRENCY}`,
    detail: JSON.stringify({
      channel: channel?.name,
      channel_id: channel?.id || (Array.isArray(channelIds) && channelIds.length === 1 ? channelIds[0] : undefined),
      channel_ids: Array.isArray(channelIds) && channelIds.length ? channelIds : undefined,
      model: displayModel,
      requested_model: model,
      reasoning_effort: [...new Set((calls || []).map(c => c.reasoningEffort || "default"))].join(",") || "default",
      reasoning_applied: (calls || []).some(c => c.reasoningApplied === true),
      upstream_model: modelCalls.at(-1)?.upstream_model || "",
      pricing_model: canonicalModelName(modelCalls.length === 1 ? modelCalls[0].pricing_model : basePrice.model || model),
      requested_price: { in: basePrice.input, out: basePrice.output, cache: basePrice.cache },
      original_price: bill.channel_quote?.price || null,
      ...(originalPrice ? { model_alias_price: originalPrice } : {}),
      billing_details: bill,
      source_vendors: sourceVendors([channel?.type, ...billingCalls.map((c) => c.channelQuote?.provider)]),
      ...(modelCalls.length ? { model_calls: modelCalls.slice(0, 40) } : {}),
      kind,
      ...logTexts({ prompt, output, calls, inputText }),
      session_id: sessionId || undefined,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cache_tokens: cacheTokens,
      // 分时审计：与网关同一口径（事后可复核按峰价还是谷价算的）
      price: { in: price.input, out: price.output, cache: price.cache },
      price_phase: eff.phase,
      context_tier: price.contextTier || 0,
      priced_at: startedAt || Date.now(),
      rate: Number(gcfg?.rate) || 1,
      amount_units: units,
      ...(errorCode ? { code: errorCode, http_status: Number(httpStatus) || undefined, error_message: errorMessage } : {}),
    }),
    quota: units,
    // 使用记录明细（列存储）：站内对话不经 Key，但仍记录本次路由用的密钥与分组，
    // 这样管理员在记录页能看出「这次是按哪个分组/倍率算的」。
    model: displayModel,
    channelId: channel?.id || (Array.isArray(channelIds) && channelIds.length === 1 ? channelIds[0] : 0) || 0,
    channelName: channel?.name || "",
    tokenId: keyId || 0,
    tokenName: keyName || "",
    // 同网关：归一化成纯分组名，避免历史 "厂商:分组名" 绑定在日志里产生多个标签
    groupName: displayGroupName(groupName || user?.group_name),
    promptTokens,
    completionTokens,
    cacheTokens,
    firstTokenMs: firstTokenAt && startedAt ? firstTokenAt - startedAt : null,
    elapsedMs: startedAt ? Date.now() - startedAt : 0,
    userAgent,
    ip,
    pricePhase: eff.phase,
    isUsage,
    status,
    errorCode,
    retryCount,
    inputText,
    requestPromptText: logTexts({ prompt, output, calls, inputText }).request_prompt_text,
    outputText: logTexts({ prompt, output, calls, inputText }).output_text,
    requestId,
  });
    committing = true;
    await conn.commit();
    return { units, promptTokens, completionTokens, cacheTokens, logId, billingDetails: bill };
  } catch (e) {
    await conn.rollback().catch(() => {});
    // COMMIT发出后结果无法确认，禁止重试结算或再次退回已计入的预占。
    throw Object.assign(new Error(committing ? "扣费提交结果不确定，请联系管理员核查" : "本轮计费未完成，请联系管理员核查"), { code: committing ? "BILLING_UNCERTAIN" : "BILLING_FAILED", cause: e, billingDetails: bill, ...(committing ? { billingResult: { units, promptTokens, completionTokens, cacheTokens, logId, billingDetails: bill } } : {}) });
  } finally { conn.release(); }
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

// ---------- 运行一轮对话（SSE，可断线续传）----------
// 关键设计：**运行与 HTTP 连接解绑**。
// 用户在生成过程中切页/刷新时，浏览器会断开这条 SSE；如果这里跟着 abort 上游，
// 那一轮就白花钱了（上游已产出、我们照价付费）。因此：
//   · 后台任务负责跑完并把结果落库，客户端断开只取消订阅、不影响运行；
//   · 事件进 runs 环形缓冲，刷新后重新订阅（GET /sessions/:id/stream）先回放再续播；
//   · 只有用户显式点「停止」（POST /sessions/:id/stop）才真的中止上游。
  // 事件类型：start / resumed / part / part_update / delta / todo / done / error / stopped
  router.post(
    "/run",
    authRequired,
    // 单个用户维度限流：一轮对话最多可触发 16 步上游调用（每步都是真金白银），
    // 是本站成本最高的入口。给一个宽松但存在的上限，防脚本化刷量与误连点。
    rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "chat-run", keyFn: (r) => r.user?.id || r.ip }),
    asyncHandler(async (req, res) => {
    const reject = (message, status = 400, data = {}) => fail(res, message, status, { accepted: false, ...data });
    const rejectDraining = () => reject("服务正在重启，请稍后重试", 503, { code: "SERVER_DRAINING" });
    if (isChatDraining()) return rejectDraining();
    const { sessionId, text = "", model: modelOverride, agent: agentOverride, settings: settingsPatch, images = [], files = [], keyId = 0, retryFromSeq: retryRaw = 0 } = req.body || {};
    const retryFromSeq = retryRaw ? safeInt(retryRaw, { min: 1, fallback: 0 }) : 0;
    if (retryRaw && !retryFromSeq) return reject("retryFromSeq 无效", 400, { accepted: false });
    // 令牌额度预占：在**发起上游调用之前**原子占位，避免并发的多个请求
    // 共享同一次「余额 > 0」检查全部放行（见 services/token-quota.js 的说明）
    let quotaHold = { ok: true, amount: 0, consume() {}, refund() {} };

    const session = await getSession(req.user.id, sessionId);
    if (!session) return reject("会话不存在", 404);
    if (!getBoolOption("chat_enabled")) return reject("站内对话功能已关闭", 403);
    if (Number(req.user.quota) <= 0) return reject(`${CURRENCY}余额不足，请联系管理员充值`, 403);

    const inputText = String(text || "");
    const content = inputText.trim();
    // 第 80 批：智能体选择已取消，一律由 general 执行（老会话存的 research/coder 等也收拢到这里）。
    // agentOverride 仍从 body 里解构以兼容旧前端，但不再生效。
    void agentOverride;
    const agent = findAgent("general");
    if (!agent) return reject("智能体不存在");
    const model = modelOverride || session.model;
    if (!model) return reject("请选择模型");
    if (!content && !(Array.isArray(images) && images.length) && !(Array.isArray(files) && files.length) && !(Array.isArray(req.body?.docs) && req.body.docs.length)) {
      return reject("请输入内容或添加附件");
    }

    // 同一会话同时只允许一个运行：重复提交若被放行会跑两份、扣两次费
    if (isRunning(session.id)) return reject("这个会话正在生成中，请稍候或先停止", 409);

    // 能力开关已取消：tools/search 一律回到智能体默认（老会话里存过的「关掉联网」等不再生效，
    // 否则用户在新界面里既看不到开关、又被旧设置限制住，表现为「怎么问都不查资料」）。
    // 深度思考（thinking）仍跟随会话设定；会话指令保留。
    const settings = { ...sanitizeSettings(settingsPatch ?? {}, { previous: session.settings }), ...agentPolicy(), search: null };

    // 图片：优先走媒体库（parts 只存 media_id，字节落盘）。
    //
    // 为什么必须这样：以前是把 dataURL 原样写进 chat_messages.parts（MEDIUMTEXT）——
    // 20MB 请求体下 3 张图就能产出 ~16.9MB 的 parts，超过 16,777,215 字节上限，
    // 严格模式 INSERT 失败（整轮对话落库失败、用户消息丢失），
    // 非严格模式被截断 → 历史消息**静默变空**。
    // 兼容旧前端：仍然接受 dataUrl（先存媒体库再走同一条路），
    // 这样新旧前端都能用，且新数据一定是 media_id。
    const imgs = [];
    const imgMediaIds = [];
    for (const img of Array.isArray(images) ? images : []) {
      // 新格式：前端已上传，直接给 media_id
      const mid = Number(img?.mediaId || img?.media_id) || 0;
      if (mid) {
        const row = await getMedia(mid);
        if (!row || Number(row.user_id) !== req.user.id || !String(row.kind).startsWith("image")) {
          return reject("图片不存在或无权使用");
        }
        const buf = await readBlob(row);
        if (!buf) return reject("图片内容缺失，请重新上传");
        imgs.push({ buffer: buf, mimeType: row.mime || "image/png", filename: row.orig_name || "image" });
        imgMediaIds.push(mid);
        continue;
      }
      // 旧格式：dataUrl（存进媒体库，后续统一按 media_id 处理）
      const mm = /^data:([^;]+);base64,(.+)$/s.exec(String(img?.dataUrl || ""));
      if (!mm) continue;
      const buf = Buffer.from(mm[2], "base64");
      try {
        const saved = await saveBuffer({
          buffer: buf,
          userId: req.user.id,
          origName: mm[1].includes("png") ? "image.png" : "image.jpg",
          source: "chat",
        });
        imgs.push({ buffer: buf, mimeType: mm[1], filename: mm[1].includes("png") ? "image.png" : "image.jpg" });
        imgMediaIds.push(saved.id);
      } catch (e) {
        // 媒体库不可用（关闭/超配额）时不让对话直接失败：回退到旧行为（本轮可用，
        // 但不落库到媒体库）。宁可少存一次图，也不要让用户发不出消息。
        console.warn(`[chat] 图片存媒体库失败，回退为内存透传：${e.message}`);
        imgs.push({ buffer: buf, mimeType: mm[1], filename: mm[1].includes("png") ? "image.png" : "image.jpg" });
        imgMediaIds.push(0);
      }
    }
    // 图片数量上限：与网关侧（gateway.js 的 MAX_INLINE_IMAGES）**保持同一个口径**。
    //
    // 这里有一个我上一轮改漏的地方，值得记下来：
    // 用户反馈「为啥老是报『不支持三张以上图片，请修改问题或切换对话窗口！』」时，
    // 我只改了网关 `/v1/chat/completions` 的 3 张上限，**没有改站内对话这条路** ——
    // 而用户实际就是站内对话里贴图时撞到的。黑盒测试复现：
    //   POST /api/chat/run {images: [4 张]} → 400「最多 3 张图片」
    // 站内上传的图是 base64 内嵌（前端已经读进内存），代价只有解码与内存，
    // 不存在外链抓取的 SSRF/DoS 面 —— 所以和网关一致按 30 张放行。
    if (imgs.length > MAX_CHAT_IMAGES) return reject(`最多 ${MAX_CHAT_IMAGES} 张图片，请分批发送`);

    // 文档附件：前端传 base64，这里解析成文本（PDF/Word/Excel/文本/代码），
    // 解析结果作为 user 消息的 file part 落库 —— 历史里保留文件名与正文，
    // 下一轮模型仍能看到（不能只放进本轮 prompt，否则追问就"忘"了）。
    const docs = [];
    for (const f of Array.isArray(files) ? files.slice(0, MAX_UPLOAD_FILES) : []) {
      const mm = /^data:([^;]*);base64,(.+)$/s.exec(String(f?.dataUrl || ""));
      if (!mm) continue;
      const buf = Buffer.from(mm[2], "base64");
      if (buf.length > MAX_UPLOAD_BYTES) {
        return reject(`文件「${String(f.name || "未命名").slice(0, 60)}」超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
      }
      const r = extractFileText({ buffer: buf, filename: f.name || "", mimeType: mm[1] || f.type || "" });
      if (!r.ok) return reject(`文件「${String(f.name || "未命名").slice(0, 60)}」无法读取：${r.error}`);
      docs.push({ name: String(f.name || "未命名文件").slice(0, 120), kind: r.kind, bytes: buf.length, text: clipFileText(r.text) });
    }
    if (docs.length > MAX_UPLOAD_FILES) return reject(`最多同时上传 ${MAX_UPLOAD_FILES} 个文件`);

    // 「重新生成」重发历史消息时附件没有 dataUrl：前端把已解析文本走 docs 通道带回来。
    // 这里做和 files 相同的上限与剪裁，逻辑保持单一入口。
    for (const d of Array.isArray(req.body?.docs) ? req.body.docs.slice(0, MAX_UPLOAD_FILES) : []) {
      if (!d || typeof d !== "object") continue;
      const text = String(d.text || "");
      if (!text) continue;
      docs.push({
        name: String(d.name || "未命名文件").slice(0, 120),
        kind: String(d.kind || "text").slice(0, 20),
        bytes: Math.min(Number(d.bytes) || text.length, 50 * 1024 * 1024),
        text: clipFileText(text),
      });
    }
    if (docs.length > MAX_UPLOAD_FILES) return reject(`最多同时上传 ${MAX_UPLOAD_FILES} 个文件`);
    if (!content && !imgs.length && !docs.length) return reject("请输入内容或添加有效附件");

    // 先原子占位、再做落库等副作用：并发提交的第二个请求会在这里直接 409，
    // 不会留下重复的用户消息或被改错的标题（原实现先落库后占位，存在这个竞态）。
    // 附件读取会让出事件循环；退出可能已在此期间开始，不能再登记新运行。
    if (isChatDraining()) return rejectDraining();
    const run = startRun(session.id, { userId: req.user.id });
    if (!run) return reject("这个会话正在生成中，请稍候或先停止", 409);
    const ctrl = new AbortController();
    const completeRun = trackChatRun(ctrl);
    run.abort = () => ctrl.abort();
    const finishBeforeStart = async () => {
      try { await quotaHold.refund(); }
      finally { finishRun(run); completeRun(); }
    };

    let history;
    let models;
    let modelCaps;
    let routeGroup;
    // usableKey **必须在 try 外声明**：它在 try 里赋值、却在 try 之后的
    // executeRun 里被读（keyName 落日志用）。之前写成 `const usableKey = ...`（在 try 内），
    // 于是 try 外那一行必然抛 `ReferenceError: usableKey is not defined` ——
    // 线上 journalctl 抓到的 `/opt/ooapi/ooapi-server/src/routes/chat.js:715`
    // 就是这个（每次站内对话都 500/中断，且影响该轮收尾与计费审计）。
    // `node --check` 查不出这类作用域错误（语法合法），必须有真实调用路径的断言。
    let usableKey;
    let userMessage;
    try {
      history = await getSessionMessages(session.id);

      // 路由分组：必须通过密钥路由（分组决定渠道/模型/倍率），没有可用密钥不开跑
      usableKey = await activeKeyOf(req.user, keyId);
      if (!usableKey) {
        await finishBeforeStart();
        return reject("请先在「令牌管理」创建可用密钥，并在对话页选择它（密钥的分组决定可用模型与倍率）", 403);
      }
      // 密钥额度在站内对话同样生效（与网关 authorize 的 insufficient_quota 同一口径）。
      //
      // 必须检查的原因：站内对话的用量按这把密钥记账（日志挂在它名下、结算时
      // 也会扣它的 remain_quota），如果不在这里拦，就会出现「Key 早就用尽了、
      // 站内却还能无限继续」——正是黑盒测试报的「密钥额度形同虚设」的另一种形态。
      if (!usableKey.unlimited_quota && Number(usableKey.remain_quota) <= 0) {
        await finishBeforeStart();
        return reject("该密钥额度已用尽，请在对话页换一把密钥（或让管理员调整额度）", 403);
      }
      // 原子预占：并发下只有一个请求能拿到这 1 个单位，其余在这里就被拒
      quotaHold = await holdTokenQuota(usableKey);
      if (!quotaHold.ok) {
        await finishBeforeStart();
        return reject("该密钥额度已用尽，请在对话页换一把密钥（或让管理员调整额度）", 403);
      }
      models = await availableModels(req.user, usableKey.id);
      // 按规范名比较：下拉已把别名去重（只留 deepseek-flash），但老会话里存的
      // 可能还是 deepseek-v4.1-flash —— 精确比较会把这些会话全部判成「模型不可用」。
      const wantCanon = canonicalModelName(model);
      const sameModel = (m) => m.id === model || canonicalModelName(m.id) === wantCanon;
      const eligible = models;
      modelCaps = eligible.find((m) => m.id === model) || eligible.find(sameModel) || null;
      routeGroup = usableKey.group_name || null;
      if (!modelCaps) {
        await finishBeforeStart();
        return reject(`模型「${model}」在当前密钥下不可用，请重新选择模型`);
      }
      // 展示按模型开发商归组；实际渠道由密钥分组与调度策略决定。
      settings.channelType = "";

      // preflight也在排空集合内：还没保存用户消息时直接拒绝，重试旧轮不会被删。
      if (ctrl.signal.aborted) {
        await finishBeforeStart();
        return isChatDraining() ? rejectDraining() : reject("生成已停止", 400, { code: "ABORTED" });
      }

      // 所有前置校验通过后才改写历史；retryFromSeq 回退与新用户消息在同一事务。
      const userParts = [{ id: `u${Date.now().toString(36)}`, type: "text", text: inputText }];
      for (const mid of imgMediaIds.filter(Boolean)) userParts.push({ id: `i${Math.random().toString(36).slice(2, 8)}`, type: "image", media_id: mid });
      for (const d of docs) userParts.push({ id: `f${Math.random().toString(36).slice(2, 8)}`, type: "file", name: d.name, kind: d.kind, bytes: d.bytes, text: d.text });
      const savedUser = await appendMessage({ sessionId: session.id, userId: req.user.id, role: "user", parts: userParts, returnMessage: true, retryFromSeq });
      userMessage = { ...savedUser, role: "user", parts: userParts, status: "success", cost: 0, tokens: { prompt: 0, completion: 0, cache: 0 }, firstTokenMs: null, elapsedMs: 0, retryCount: 0 };
      // 与GET历史消息同一渲染合同，库里仍只存media_id，签名URL不写入数据库。
      userMessage.parts = await Promise.all(userParts.map(async (p) => p.type === "image" && p.media_id ? { ...p, url: await mediaUrl(p.media_id).catch(() => "") } : p));
      if (retryFromSeq) history = history.filter((m) => m.seq < retryFromSeq);
      for (const mid of imgMediaIds.filter(Boolean)) await attachRef(mid, { userId: req.user.id, refType: "chat_message", refId: String(savedUser.id), slot: `m${mid}` }).catch((e) => console.warn(`[chat] 绑定图片引用失败：${e.message}`));
      if (session.message_count === 0 && session.title === "新对话") await updateSession(req.user.id, session.id, { title: titleFromText(content || docs[0]?.name || "图片对话") }).catch(() => {});
    } catch (e) {
      // 占位后到真正开跑前的任何异常都要释放，否则会话会永远显示"生成中"
      await finishBeforeStart();
      return reject(["NO_SESSION", "BAD_RETRY"].includes(e.code) ? e.message : "无法开始生成，请稍后重试", e.status || 500, { accepted: false, code: e.code || "START_FAILED" });
    }
    run.userMessage = userMessage;
    publish(run, { type: "start", sessionId: session.id, startedAt: run.startedAt, userMessage, retryFromSeq });

    // 后台跑：不 await，HTTP 层只负责把事件流出去
    executeRun({
      run,
      ctrl,
      user: req.user,
      session,
      agent,
      model,
      settings,
      history,
      content,
      inputText,
      userMessage,
      imgs,
      docs,
      routeGroup,
      keyId: Number(usableKey.id),
      // 密钥名也要落日志：只有 id 的话「使用记录」的密钥列会显示成「账户额度」（见 chargeUser）
      keyName: usableKey?.name || "",
      modelCaps,
      // 使用记录要展示的调用方信息（IP/设备只在本次 HTTP 请求里有，必须在这里取）
      ip: clientIp(req),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 255),
      startedAt: run.startedAt || Date.now(),
      quotaHold,
    }).catch((e) => console.error("[chat] 后台运行异常：", e?.code || "ERROR")).finally(completeRun);

    streamFromRun(req, res, run);
  })
);

/** 把某个运行的 SSE 流接到本次 HTTP 响应：先回放缓冲，再续播实时事件 */
function streamFromRun(req, res, run, extra = null) {
  const visibility = userDataVisibility(req.user);
  const auditOptions = { isAdmin: Number(req.user?.role) >= 100 };
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();

  const write = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(visibleChatAudit(obj, visibility, auditOptions))}\n\n`);
  };
  if (extra) write({ type: "resumed", ...extra });

  const unsubscribe = subscribe(run, (ev) => {
    if (ev === null) {
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }
    write(ev);
  });

  // 客户端断开（切页/刷新）只取消订阅，**不**中止运行 —— 见 /run 顶部注释
  const onClose = () => unsubscribe();
  res.on("close", onClose);
  req.on("aborted", onClose);
}

// 重新订阅进行中的运行（刷新 / 切页回来时调用，先回放已缓冲事件）
router.get(
  "/sessions/:id/stream",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    const run = getRun(session.id);
    // running检查与订阅之间可能刚好完成；缓存仍保留5分钟，subscribe会回放终态并结束流。
    if (!run) return fail(res, "没有进行中的生成", 404);
    streamFromRun(req, res, run, { startedAt: run.startedAt, events: run.events.length });
  })
);

// 显式中止：只有用户点「停止」才真的 abort 上游
router.post(
  "/sessions/:id/stop",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    const run = getRun(session.id);
    if (!run || run.settled) return fail(res, "没有进行中的生成", 404);
    run.abort?.();
    return ok(res, { stopped: true, startedAt: run.startedAt });
  })
);

router.post("/sessions/:id/approvals/:approvalId", authRequired, asyncHandler(async (req, res) => {
  const session = await getSession(req.user.id, req.params.id);
  if (!session) return fail(res, "会话不存在", 404);
  if (!decideApproval(getRun(session.id), req.user.id, req.params.approvalId, req.body?.decision)) {
    return fail(res, "此审批已处理或已过期", 409);
  }
  return ok(res, { accepted: true });
}));

/** 这个会话现在有没有在跑（前端刷新后据此决定要不要接回事件流） */
router.get(
  "/sessions/:id/running",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    return ok(res, { ...runStatus(session.id), userMessage: getRun(session.id)?.userMessage || null });
  })
);

/**
 * 真正执行一轮：跑 harness、计费、落库、发布事件。
 * 无论客户端是否还在，都必须跑到最后一步（这就是断线续传的前提）。
 */
async function executeRun({ run, ctrl, user, session, agent, model, settings, history, content, inputText = content, userMessage = null, imgs, docs = [], routeGroup, keyId = 0, keyName = "", modelCaps, ip = "", userAgent = "", startedAt = 0, quotaHold = null }) {
  const runCalls = [];
  let runParts = [];
  let runTodo = session.todo || [];
  let channelName = "";
  let settled = false;
  let billedResult = null;
  // 助手消息是否已落库：catch 分支据此避免重复写入（见下方 appendMessage 处说明）
  let saved = false;

  try {
    reasoningSelection(model, settings.reasoningEffort);
    const out = await runHarness({
      session,
      agent,
      model,
      settings,
      history,
      userText: content,
      images: imgs,
      docs,
      groupName: routeGroup,
      user,
      signal: ctrl.signal,
      modelCaps,
      authorizeTool: async (call) => {
        // 长运行中账号可能被禁用；同意审批不等于绕过实时账号权限。
        const refreshPermissions = async () => {
          const [[current]] = await pool.query("SELECT * FROM users WHERE id = ?", [user.id]);
          if (!current || Number(current.status) !== 1) throw Object.assign(new Error("账号不可用"), { code: "AUTH_FAILED" });
          user.role = current.role;
        };
        await refreshPermissions();
        if (settings.permissionMode !== "ask" || call.tool === "todowrite") return true;
        const approved = await requestApproval(run, call, { signal: ctrl.signal, emit: (ev) => publish(run, ev) });
        if (approved) await refreshPermissions();
        return approved;
      },
      emit: (ev) => {
        if (ev.type === "todo") runTodo = ev.todo;
        publish(run, ev);
      },
      onTodo: (todo) => {
        runTodo = todo;
      },
      onCall: (c) => runCalls.push(c),
    });

    runParts = [...out.parts, ...[...run.snapshots.values()].filter((p) => p.type === "approval")];
    runTodo = out.todo;
    // 最后一步刚结束时退出也可能先于结算发生；沿停止分支保存已有calls/parts。
    if (ctrl.signal.aborted) throw Object.assign(new Error("已停止"), { code: "ABORTED", parts: runParts });
    channelName = runCalls.find((c) => c.channel)?.channel || "";
    const runChannelIds = [...new Set(runCalls.map((c) => Number(c.channelId) || 0).filter(Boolean))];

    const tokens = aggregate(runCalls);
    // 首 token / 总耗时：按「本轮的第一次上游调用」算首 token，整轮总耗时从请求进入算起
    const firstCall = runCalls.find((c) => c.firstTokenAt) || null;
    const billed = await chargeUser({
      user,
      model,
      prompt: "",
      output: "",
      usage: null,
      tokens,
      // 逐次调用分别判峰谷档（整轮跨分界点时不再全部按发起时刻计价）
      calls: runCalls,
      sessionId: session.id,
      channel: channelName ? { name: channelName } : null,
      channelIds: runChannelIds,
      groupName: routeGroup,
      keyId,
      keyName,
      kind: "对话",
      ip,
      userAgent,
      startedAt,
      firstTokenAt: firstCall?.firstTokenAt || 0,
      tokenQuotaHold: quotaHold?.amount || 0,
      inputText,
      retryCount: runCalls.reduce((n, c) => n + (Number(c.retryCount) || 0), 0),
      requestId: `${session.id}:${userMessage?.seq || 0}`,
    });
    // 结算已把预占计入（加回 hold、扣掉实际用量）→ 阻止 finally 里的兜底退回
    quotaHold?.consume();
    settled = true;
    billedResult = billed;

    const message = {
      id: 0,
      seq: 0,
      role: "assistant",
      parts: runParts,
      agent: agent.id,
      model,
      cost: Number((billed.units / UNITS_PER_OD).toFixed(6)),
      tokens: { prompt: billed.promptTokens, completion: billed.completionTokens, cache: billed.cacheTokens },
      status: "success",
      firstTokenMs: firstCall?.firstTokenAt && startedAt ? firstCall.firstTokenAt - startedAt : null,
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
      retryCount: runCalls.reduce((n, c) => n + (Number(c.retryCount) || 0), 0),
      created_time: now(),
    };
    // 落库成功标记（saved 声明在 try 之外）：catch 分支据此判断
    // 「助手消息是否已经写过」。否则 appendMessage 之后的任一步骤
    // （updateSession / getSession / publish）抛错都会走到 catch 的兜底落库，
    // 同一轮回答在 chat_messages 里出现两条 —— 用户看到重复回答，
    // 下一轮模型上下文里同一答案还会再出现一次。
    const savedAssistant = await appendMessage({
      sessionId: session.id,
      userId: user.id,
      role: "assistant",
      parts: runParts,
      agent: agent.id,
      model,
      cost: message.cost,
      promptTokens: billed.promptTokens,
      completionTokens: billed.completionTokens,
      cacheTokens: billed.cacheTokens,
      status: "success",
      firstTokenMs: message.firstTokenMs,
      elapsedMs: message.elapsedMs,
      retryCount: message.retryCount,
      returnMessage: true,
    });
    message.id = savedAssistant.id;
    message.seq = savedAssistant.seq;
    message.created_time = savedAssistant.created_time;
    saved = true;
    await updateSession(user.id, session.id, { todo: runTodo }).catch((e) => console.error("[chat] 待办同步失败：", e.code || "DB_ERROR"));

    publish(run, { type: "done", message, userMessage, todo: runTodo, session: await getSession(user.id, session.id).catch(() => null) });
  } catch (err) {
    console.error("[chat] 运行失败：", err.code || "ERROR");
    if (Array.isArray(err.parts) && err.parts.length) runParts = err.parts;
    runParts = [...runParts.filter((p) => p.type !== "approval"), ...[...run.snapshots.values()].filter((p) => p.type === "approval")];
    const stopped = ctrl.signal.aborted || err.code === "ABORTED";
    const errorCode = /^[\w.:-]{1,64}$/.test(String(err.code || "")) ? String(err.code) : "ERROR";
    const errorMessage = publicRunError(err, { stopped });
    let billingKnown = !["BILLING_UNCERTAIN", "BILLING_FAILED"].includes(err.code);
    // 扣费结果不确定时不再补结算（防重复扣费）；余额不足等“确定未扣”的错误才走部分结算
    if (err?.code === "BILLING_UNCERTAIN") { settled = true; quotaHold?.consume(); billedResult = err.billingResult || null; }

    // 只有真实usage或已生成正文能证明消耗；HTTP拒绝与零输出停止不估算整段输入费。
    // 工具已经record的失败调用不会被helper再次合成。
    const failedCall = billableFailedCall(err, { prompt: err?.billingPrompt || "", output: err?.billingOutput || "", startedAt });
    const billedCalls = failedCall ? [...runCalls, failedCall] : runCalls;
    let partialBilled = billedResult || { units: 0, ...sumCallTokens(billedCalls), logId: 0 };
    const status = stopped ? "stopped" : "error";
    const retryCount = Math.max(Number(err.retryCount) || 0, billedCalls.reduce((n, c) => n + (Number(c.retryCount) || 0), 0));
    // 工具/子代理会提前记录失败消耗。统一以逐调用账单结算，既不漏收，也不把整轮正文重算。
    if (!settled && billedCalls.length && !["BILLING_UNCERTAIN", "BILLING_FAILED"].includes(err.code)) {
      try {
        partialBilled = await chargeUser({
          user,
          model,
          prompt: "",
          output: "",
          usage: null,
          tokens: sumCallTokens(billedCalls),
          // 逐次调用计费。只有失败步时也要走 calls 分支，否则 chargeUser 会用
          // 上面那个被忽略的 tokens（有 usage 的情况下它并不完整）。
          calls: billedCalls,
          sessionId: session.id,
          channel: (channelName || billedCalls.find((c) => c.channel)?.channel) ? { name: channelName || billedCalls.find((c) => c.channel)?.channel } : null,
          channelIds: [...new Set(billedCalls.map((c) => Number(c.channelId) || 0).filter(Boolean))],
          groupName: routeGroup,
          kind: stopped ? "对话（已停止）" : "对话（部分）",
          keyId,
          keyName,
          ip,
          userAgent,
          startedAt,
          firstTokenAt: (billedCalls.find((c) => c.firstTokenAt) || {}).firstTokenAt || 0,
          tokenQuotaHold: quotaHold?.amount || 0,
          inputText,
          status,
          errorCode,
          errorMessage,
          httpStatus: err.httpStatus || err.status || 0,
          retryCount,
          requestId: `${session.id}:${userMessage?.seq || 0}`,
        });
        quotaHold?.consume();
        settled = true;
      } catch (e2) {
        billingKnown = false;
        if (e2.billingDetails) partialBilled.billingDetails = { ...e2.billingDetails, charged_cost_units: null, charged_cost_od: null, adjustment_units: null };
        if (e2.code === "BILLING_UNCERTAIN") { settled = true; quotaHold?.consume(); partialBilled = e2.billingResult || partialBilled; }
        console.error("[chat] 部分计费失败：", e2.message);
      }
    }

    // 只有「尚未落库」时才补写：成功路径可能已经写过（saved=true），
    // 若此处再写一次，同一轮回答会在库里出现两条。
    if (!saved) {
      try {
        const errorPart = { id: `e${Date.now().toString(36)}`, type: "error", code: errorCode, message: errorMessage, billing_known: billingKnown };
        const finalParts = [...runParts, errorPart];
        const finalMessage = await appendMessage({
          sessionId: session.id,
          userId: user.id,
          role: "assistant",
          parts: finalParts,
          agent: agent.id,
          model,
          cost: billingKnown ? Number((partialBilled.units / UNITS_PER_OD).toFixed(6)) : null,
          promptTokens: partialBilled.promptTokens,
          completionTokens: partialBilled.completionTokens,
          cacheTokens: partialBilled.cacheTokens,
          status: stopped ? "stopped" : "error",
          firstTokenMs: (billedCalls.find((c) => c.firstTokenAt) || {}).firstTokenAt && startedAt ? (billedCalls.find((c) => c.firstTokenAt) || {}).firstTokenAt - startedAt : null,
          elapsedMs: startedAt ? Date.now() - startedAt : 0,
          retryCount,
          returnMessage: true,
        });
        runParts = finalParts;
        run.finalMessage = {
          ...finalMessage,
          role: "assistant",
          parts: finalParts,
          agent: agent.id,
          model,
          cost: billingKnown ? Number((partialBilled.units / UNITS_PER_OD).toFixed(6)) : null,
          tokens: { prompt: partialBilled.promptTokens, completion: partialBilled.completionTokens, cache: partialBilled.cacheTokens },
          status: stopped ? "stopped" : "error",
          error_code: errorCode,
          retryCount,
          firstTokenMs: (billedCalls.find((c) => c.firstTokenAt) || {}).firstTokenAt && startedAt ? (billedCalls.find((c) => c.firstTokenAt) || {}).firstTokenAt - startedAt : null,
          elapsedMs: startedAt ? Date.now() - startedAt : 0,
        };
        saved = true;
        await updateSession(user.id, session.id, { todo: runTodo });
      } catch (e2) {
        console.error("[chat] 失败消息落库异常：", e2.code || "DB_ERROR");
      }
    }

    run.error = { code: errorCode, message: errorMessage };
    // 失败也写一条错误日志：与网关同一口径（模型/渠道/耗时/设备），
    // 否则站内对话的失败在看板上完全不可见。
    // 这里没有 req（executeRun 是后台任务），ip/userAgent 由调用方在 /run 时捕获后传入。
    if (!partialBilled.logId) {
      const failedPrice = await getPrice(model);
      const failedOriginalPrice = await originalModelPrice(model);
      const failedModel = canonicalModelName(err.billModel || model) || model;
      const failedEff = effectivePrice(failedPrice, startedAt || Date.now());
      const failedQuote = finalizeChannelQuote(err.channelQuote, 0);
      const failedBill = partialBilled.billingDetails || billingDetails({
        calls: [{ price: failedEff.price, tokens: { promptTokens: 0, completionTokens: 0, cacheTokens: 0 },
          at: startedAt, phase: failedEff.phase, billable: false, requestedModel: model,
          upstreamModel: err.upstreamModel || "", pricingModel: canonicalModelName(failedPrice.model), channelQuote: failedQuote }],
        chargedUnits: billingKnown ? partialBilled.units : null, baseUnits: 0 });
      await writeLog({
        user,
        type: LOG_TYPE.ERROR,
        content: `${stopped ? "对话已停止" : "对话失败"}：${failedModel} · ${errorMessage}`,
        detail: JSON.stringify({
          code: errorCode, http_status: Number(err.httpStatus || err.status) || undefined,
          billing_known: billingKnown, requested_model: model, upstream_model: err.upstreamModel || "",
          pricing_model: canonicalModelName(failedPrice.model || model),
          requested_price: { in: failedPrice.input, out: failedPrice.output, cache: failedPrice.cache },
          original_price: failedBill.channel_quote?.price || null,
          ...(failedOriginalPrice ? { model_alias_price: failedOriginalPrice } : {}),
          billing_details: failedBill,
          source_vendors: sourceVendors([err.channelQuote?.provider, ...billedCalls.map((c) => c.channelQuote?.provider)]),
          ...logTexts({ calls: billedCalls.length ? billedCalls : [{ prompt: err.billingPrompt || "", output: err.billingOutput || "" }], inputText }),
          session_id: session.id,
        }),
        model: failedModel,
        channelId: Number(err.channelId) || 0,
        channelName: err.channelName || "",
        tokenId: keyId || 0,
        tokenName: keyName,
        groupName: routeGroup || "",
        userAgent,
        ip,
        isUsage: true,
        status,
        errorCode,
        retryCount,
        inputText,
        quota: partialBilled.units,
        promptTokens: partialBilled.promptTokens,
        completionTokens: partialBilled.completionTokens,
        cacheTokens: partialBilled.cacheTokens,
        firstTokenMs: run.finalMessage?.firstTokenMs ?? null,
        elapsedMs: run.finalMessage?.elapsedMs || (startedAt ? Date.now() - startedAt : 0),
        requestId: `${session.id}:${userMessage?.seq || 0}`,
      });
    } else if (billedResult?.logId) await pool.query("UPDATE logs SET type = ?, status = ?, error_code = ? WHERE id = ? AND user_id = ?", [LOG_TYPE.ERROR, status, errorCode, billedResult.logId, user.id]);
    publish(run, {
      type: stopped ? "stopped" : "error",
      code: errorCode,
      errorMessage,
      parts: runParts,
      message: run.finalMessage || null,
      userMessage,
      status,
      cost: billingKnown ? Number((partialBilled.units / UNITS_PER_OD).toFixed(6)) : null,
      tokens: { prompt: partialBilled.promptTokens, completion: partialBilled.completionTokens, cache: partialBilled.cacheTokens },
      firstTokenMs: run.finalMessage?.firstTokenMs ?? null,
      elapsedMs: run.finalMessage?.elapsedMs || (startedAt ? Date.now() - startedAt : 0),
      retryCount,
      session: await getSession(user.id, session.id).catch(() => null),
    });
  } finally {
    // 没走到结算（上游直接失败、无任何产出）就退回预占的 1 个单位。
    // consume() 过的（结算已计入）会在这里自动让路；refund() 幂等，重复调用无害。
    try { await quotaHold?.refund(); }
    finally { finishRun(run); }
  }
}

export default router;
