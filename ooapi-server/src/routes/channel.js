// 渠道管理 API（统一入口）
// ===========================================================================
// 设计：**厂商是唯一维度**，不再分「API 渠道 / 反代渠道」。
//   一个渠道 = 一个厂商 + 一种接入方式（relay 网页版反代 / api 官方接口）
//   channel.type   存厂商（deepseek / glm / openai ...）
//   channel.other.method 存接入方式（relay / api），缺省视为 relay（兼容老数据）
//
// 路由：
//   GET    /api/channel/providers      厂商列表（含各自的接入方式、默认模型）
//   GET    /api/channel/               渠道列表
//   POST   /api/channel/               新增渠道（API 接入方式）
//   PUT    /api/channel/               编辑渠道
//   DELETE /api/channel/:id            删除
//   POST   /api/channel/login          反代接入方式：账号登录（账密/粘贴/浏览器）
//   POST   /api/channel/login/batch    反代接入方式：批量导入
//   POST   /api/channel/:id/test       连通性测试
//   POST   /api/channel/:id/browser/*  浏览器登录辅助（截图 / 检测）
//   POST   /api/channel/fetch-models   从上游拉模型列表
//   POST   /api/channel/batch          批量操作
//   POST   /api/channel/:id/keys       多 Key 管理
//   GET    /api/channel/:id/key        查看完整 Key
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, assertPublicUrl, idParam, safeInt } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { getProvider, getMethod, providerKeys, publicProviders, isOAuthMethod, isApiKeyMethod, localLoginGuide } from "../services/channel-types.js";
import { buildLoginUrl, exchangeCodeForCredential, interactiveLoginInfo, supportsInteractiveLogin, supportsInteractiveLoginMethod, supportsDeviceLogin, startDeviceLogin, pollDeviceLogin } from "../services/upstream/oauth-login.js";
import { getAdapter, resetChannelState, forgetChannel, invalidateChannelCache, channelRuntimeState, channelRecent, rowToChannel, recordChannelCall, AUTO_PAUSE_CODES, isRateLimitedCode, setChannelRateLimit, rateLimitPauseSec } from "../services/router.js";
import { clearGroupConfigCache } from "../services/group-rate.js";
// 只留这两个：浏览器登录相关的辅助（截图/远程操作/读凭据）随「服务器浏览器登录」
// 一起删除后已无调用点；这两个仍需（删渠道时清 profile、订阅渠道复制 profile）。
import { isReady as browserReady, removeProfile, copyProfile } from "../services/upstream/browser-driver.js";
import { invalidateModelRegistry } from "../services/models.js";
import { parseCredentialFile } from "../services/upstream/auth-import.js";
import { clineModelGroups } from "../services/cline-prices.js";
import { probeChannel } from "../services/channel-probe.js";
import { fetchQuota, quotaSupportFor, clampQuotaPayload } from "../services/upstream/quota.js";
import { rateLimit } from "../middleware/ratelimit.js";
import {
  supportsDeviceBind,
  deviceBindVendors,
  deviceBindMethodKeys,
  vendorOfMethod,
  startDeviceBind,
  pollDeviceBind,
  cancelDeviceBind,
} from "../services/device-bind.js";
import { randomBytes } from "node:crypto";

const router = Router();

// 待领取的绑定凭据（一次性 ticket → 凭据）。
// 为什么不让凭据经过前端：设备授权拿到的是完整账号凭据，
// 直接回给浏览器等于让 token 走一遍 HTTP 响应体（会进访问日志、浏览器缓存）。
// 这里暂存在服务端，前端只拿 ticket，建完渠道再换。
// 存进程内（单机单实例），TTL 5 分钟 —— 只在「绑定成功→建渠道」这几秒内需要。
const pendingCredentials = new Map();
const PENDING_CRED_TTL_MS = 5 * 60 * 1000;
function sweepPendingCredentials() {
  const nowMs = Date.now();
  for (const [k, v] of pendingCredentials.entries()) {
    if (nowMs - v.at > PENDING_CRED_TTL_MS) pendingCredentials.delete(k);
  }
}

/**
 * 设备授权（一键绑定）是**厂商专属**流程：Kiro 的授权流只会产出 Kiro 凭据，
 * WorkBuddy 的只会产出 WorkBuddy 凭据。而 `/devices/poll`、`/devices/claim` 的
 * 目标渠道由调用方传 `channel_id` 决定 —— 两者原本没有任何校验，等于允许
 * 「拿 A 厂商的授权结果覆盖 B 厂商渠道的凭据」：目标渠道原有账号会被冲掉，
 * 新凭据又必然解析不出 token，渠道从此静默不可用。
 *
 * 因此写回前强制「会话归属厂商 === 目标渠道类型」。厂商键与渠道类型键是同一套
 * （kiro / workbuddy / qoder），直接等值比较即可；vendor 一律取服务端会话里
 * 记录的那个，不信请求体（体里的只能用于展示）。
 */
function assertBindVendorFits(channelType, vendor) {
  const v = String(vendor || "").trim();
  const t = String(channelType || "").trim();
  if (!v) {
    throw Object.assign(new Error("绑定会话缺少厂商信息，请重新发起一键绑定"), { code: "BIND_VENDOR_MISMATCH" });
  }
  if (t !== v) {
    throw Object.assign(new Error(`绑定会话属于「${v}」，不能写入「${t}」渠道；请对该渠道发起对应的绑定`), {
      code: "BIND_VENDOR_MISMATCH",
    });
  }
}
router.use(adminRequired);

// 渠道写操作会改变「平台已注册模型」集合（models 字段），写成功后让登记表缓存失效，
// 避免紧接着的定价导入/校验还按 60 秒前的旧集合判断。
router.use((req, res, next) => {
  if (req.method !== "GET") {
    res.on("finish", () => {
      if (res.statusCode < 400) invalidateModelRegistry();
    });
  }
  next();
});

const VALID_PROVIDERS = providerKeys();

/**
 * 该渠道的模型是否要做「按档位 / 按厂商」分组。
 *
 * 判据是**模型名结构**而不是渠道类型：Cline 返回的是 `vendor/model` 形式的目录
 * （实测 454 个，`~openai/...`、`:free`、`:batch` 各种变体），这种清单平铺没法用。
 * 用结构判定还有个好处：将来接入别的聚合型渠道（同样返回 `vendor/model`）时
 * 自动就有分组，不需要再改这里。
 */
function clineGroupsFor(type, models) {
  const list = Array.isArray(models) ? models : [];
  if (list.length < 20) return null; // 小清单平铺更好用，分组反而多一层点击
  const prefixed = list.filter((m) => /^~?[a-z0-9.-]+\//i.test(String(m))).length;
  if (prefixed / list.length < 0.8) return null; // 多数模型没有 `vendor/` 前缀 → 不分组
  try {
    return clineModelGroups(list);
  } catch {
    return null; // 分组只是展示层的便利：算不出来就让前端退回平铺，不能让接口报错
  }
}

// ---------- 工具 ----------
function parseOther(row) {
  try {
    return row.other ? JSON.parse(row.other) : {};
  } catch {
    return {};
  }
}

/** 宽松解析 JSON 列（额度快照等外部写入的字段，坏数据不能 500） */
function safeJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 账号稳定标识判重：强标识按同字段比较；project_id 是弱标识（同项目多账号常见），
// 只有双方都没有强标识时才认为同一账号 —— 否则不同邮箱会被误判成重复并覆盖凭据。
const STRONG_ID_KEYS = ["account_id", "account_uuid", "email", "sub"];
function isSameAccount(a, b) {  const strongOf = (o = {}) => {
    const set = new Set();
    for (const k of STRONG_ID_KEYS) {
      const v = String(o?.[k] || "").trim().toLowerCase();
      if (v) set.add(`${k}:${v}`);
    }
    return set;
  };
  const xa = strongOf(a);
  const xb = strongOf(b);
  for (const k of xa) if (xb.has(k)) return true;
  if (xa.size || xb.size) return false;
  const pa = String(a?.project_id || "").trim().toLowerCase();
  const pb = String(b?.project_id || "").trim().toLowerCase();
  return Boolean(pa) && pa === pb;
}

// 渠道 base_url 是出站目标：写入前做公网校验（与图片/工具/拉模型同一套），
// 防止填内网地址后在调用/测试时被用来探测内网。默认官方地址不用校验。
async function assertSafeBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return;
  await assertPublicUrl(s);
}

function mask(s, head = 8, tail = 4) {
  const v = String(s || "");
  if (v.length <= head + tail) return v ? "****" : "";
  return v.slice(0, head) + "****" + v.slice(-tail);
}

/** 渠道的 key 可能是多行（多 Key），拆分展示 */
function splitKeys(apiKey) {
  return String(apiKey || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 该渠道的接入方式（缺省 relay，兼容没有 other.method 的老数据） */
// ---------- 分组工具（sub2api 风格：分组由管理员创建、绑定厂商；账号可属多个分组） ----------
/** 归一化分组数组：去空、去重、限长；空数组 = 公共池（default 是历史值，直接剔除） */
function normalizeGroups(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string" && input.trim()) list = input.split(",");
  return [...new Set(list.map((s) => String(s).trim().slice(0, 32)).filter((s) => s && s !== "default"))];
}

/** 分组模型的 JSON 解析 / 归一化 */
function parseGroupModels(raw) {
  try {
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) return arr.map((s) => String(s).trim()).filter(Boolean);
  } catch {
    /* ignore */
  }
  return [];
}

function normalizeModels(input) {
  const list = Array.isArray(input)
    ? input
    : typeof input === "string" && input.trim()
      ? input.split(",")
      : [];
  return [...new Set(list.map((s) => String(s).trim().slice(0, 128)).filter(Boolean))].slice(0, 100);
}

function normalizeRate(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(1000, Math.max(0.0001, Math.round(n * 10000) / 10000));
}

/** 渠道行的分组解析：空数组 = 公共池（不再回退 default） */
function parseGroups(row) {
  try {
    const arr = row?.group_list ? JSON.parse(row.group_list) : [];
    if (Array.isArray(arr)) return arr.map((s) => String(s)).filter((s) => s && s !== "default");
  } catch {
    /* ignore */
  }
  return [];
}

/** 分组列表行 → 前端结构（vendors = 成员账号的厂商集合，供折叠态图标展示） */
function groupResp(g, memberMap) {
  // 成员关系按**分组名**聚合：分组名全局唯一，且分组可以跨厂商
  // （成员映射原来按 `vendor:name` 聚合，跨厂商分组会散成多个 key、前端拿不到成员）
  const m = memberMap.get(g.name) || { ids: [], vendors: new Set() };
  const vendor = String(g.vendor || "");
  return {
    id: g.id,
    // vendor 保留原名 type 以兼容前端历史字段；语义已改为「可选的厂商筛选」
    type: vendor,
    vendor,
    name: g.name,
    typeName: vendor ? getProvider(vendor)?.name || vendor : "",
    remark: g.remark || "",
    rate: Number(g.rate) || 1,
    models: parseGroupModels(g.models),
    // 成员账号的厂商（去重）：前端按「单厂商=单个图标 / 多厂商=折叠态图标」渲染
    vendors: [...m.vendors],
    channel_ids: m.ids,
    count: m.ids.length,
  };
}

async function groupMemberMap() {
  const [chans] = await pool.query("SELECT id, type, group_list, group_name FROM channels");
  const memberMap = new Map(); // 分组名 -> { ids: [], vendors: Set }
  for (const c of chans) {
    for (const g of parseGroups(c)) {
      if (!memberMap.has(g)) memberMap.set(g, { ids: [], vendors: new Set() });
      const m = memberMap.get(g);
      m.ids.push(Number(c.id));
      if (c.type) m.vendors.add(String(c.type));
    }
  }
  return memberMap;
}

/**
 * 双向同步「分组包含哪些账号」：勾选的渠道加入分组，未勾选的从分组移除。
 * 不再按厂商过滤 —— 分组可以包含任意厂商的账号（厂商只是建组时的可选筛选）。
 */
async function syncGroupMembers(name, channelIds) {
  const want = new Set(
    (Array.isArray(channelIds) ? channelIds : []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
  );
  // 全量渠道：跨厂商分组需要能勾到别的厂商的账号
  const [chans] = await pool.query("SELECT id, group_list, group_name FROM channels");
  for (const c of chans) {
    const cur = parseGroups(c);
    const has = cur.includes(name);
    const should = want.has(Number(c.id));
    let next = null;
    if (should && !has) next = [...cur, name];
    else if (!should && has) next = cur.filter((g) => g !== name);
    if (!next) continue;
    await pool.query("UPDATE channels SET group_list = ?, group_name = ? WHERE id = ?", [
      JSON.stringify(next),
      next[0] || "",
      c.id,
    ]);
  }
}

// ---------- 分组列表（前端分组下拉/管理用）----------
router.get(
  "/groups",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM channel_groups ORDER BY name");
    const memberMap = await groupMemberMap();
    return ok(res, rows.map((g) => groupResp(g, memberMap)));
  })
);

// ---------- 新建分组（管理员选择包含哪些账号 + 支持哪些模型 + 倍率）----------
// vendor 是可选的「建组筛选」：填了就只是把这个厂商的账号预勾上，
// 分组本身可以跨厂商（成员由 channel_ids 决定，不再受厂商限制）。
router.post(
  "/groups",
  asyncHandler(async (req, res) => {
    const { type, vendor: vendorRaw, name, remark, rate, models, channel_ids } = req.body || {};
    const vendor = String(vendorRaw ?? type ?? "").trim();
    // 允许为空（不限厂商）；填了就必须是已知厂商，避免写进脏值
    if (vendor && !getProvider(vendor)) return fail(res, "未知厂商");
    const gname = String(name || "").trim().slice(0, 32);
    if (!gname) return fail(res, "请填写分组名");
    // 分组名不能含冒号：历史绑定格式是 "厂商:分组名"，含冒号的名字会被
    // 解析逻辑误剥前缀（"a:b" 被当成厂商 a + 分组 b），导致绑定到别的分组或校验失败。
    if (gname.includes(":")) return fail(res, "分组名不能包含冒号（:）");
    // 分组名全局唯一（跨厂商也不能重名）：否则绑定 Key 时无法区分走哪个组
    const [exist] = await pool.query("SELECT id FROM channel_groups WHERE name = ?", [gname]);
    if (exist.length) return fail(res, "已存在同名分组");
    await pool.query(
      "INSERT INTO channel_groups (vendor, name, remark, rate, models, created_time) VALUES (?,?,?,?,?,?)",
      [vendor, gname, String(remark || "").slice(0, 255), normalizeRate(rate), JSON.stringify(normalizeModels(models)), now()]
    );
    await syncGroupMembers(gname, channel_ids);
    clearGroupConfigCache();
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `新建分组「${gname}」${vendor ? `（厂商筛选：${getProvider(vendor)?.name || vendor}）` : "（不限厂商）"}`,
    });
    const memberMap = await groupMemberMap();
    const [created] = await pool.query("SELECT * FROM channel_groups WHERE name = ?", [gname]);
    return ok(res, created.length ? groupResp(created[0], memberMap) : null, "分组已创建");
  })
);

// ---------- 编辑分组（名称 / 备注 / 倍率 / 模型 / 成员账号）----------
router.put(
  "/groups/:id",
  asyncHandler(async (req, res) => {
    const gid = idParam(req);
    if (!gid) return fail(res, "分组不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channel_groups WHERE id = ?", [gid]);
    if (!rows.length) return fail(res, "分组不存在", 404);
    const group = rows[0];
    const { name, remark, rate, models, channel_ids, vendor: vendorRaw } = req.body || {};
    const gname = name === undefined ? group.name : String(name || "").trim().slice(0, 32);
    if (!gname) return fail(res, "请填写分组名");
    if (gname.includes(":")) return fail(res, "分组名不能包含冒号（:）");
    const vendor = vendorRaw === undefined ? String(group.vendor || "") : String(vendorRaw || "").trim();
    if (vendor && !getProvider(vendor)) return fail(res, "未知厂商");
    if (gname !== group.name) {
      const [dup] = await pool.query("SELECT id FROM channel_groups WHERE name = ? AND id != ?", [gname, gid]);
      if (dup.length) return fail(res, "已存在同名分组");
      // 改名传播：渠道 group_list 与已绑定 Key 都跟着换，避免改名后绑定失效
      const [chans] = await pool.query("SELECT id, group_list, group_name FROM channels");
      for (const c of chans) {
        const cur = parseGroups(c);
        if (!cur.includes(group.name)) continue;
        const next = [...new Set(cur.map((g) => (g === group.name ? gname : g)))];
        await pool.query("UPDATE channels SET group_list = ?, group_name = ? WHERE id = ?", [
          JSON.stringify(next),
          next[0],
          c.id,
        ]);
      }
      await pool
        .query("UPDATE tokens SET group_name = ? WHERE group_name = ?", [gname, group.name])
        .catch(() => {});
      // 旧版 Key 绑定带厂商前缀（"openai:分组名"）。这里**不能**用 group.vendor 反推前缀：
      // vendor 现在是可清空/可改的「厂商筛选」，改成空后再拼就是 ":分组名"，匹配不到。
      // 用 LIKE 按后缀匹配，一次覆盖所有前缀形态。
      await pool
        .query("UPDATE tokens SET group_name = ? WHERE group_name LIKE ?", [gname, `%:${group.name}`])
        .catch(() => {});
    }
    await pool.query("UPDATE channel_groups SET name = ?, vendor = ?, remark = ?, rate = ?, models = ? WHERE id = ?", [
      gname,
      vendor,
      remark === undefined ? group.remark || "" : String(remark || "").slice(0, 255),
      rate === undefined ? group.rate : normalizeRate(rate),
      models === undefined ? group.models : JSON.stringify(normalizeModels(models)),
      gid,
    ]);
    if (channel_ids !== undefined) await syncGroupMembers(gname, channel_ids);
    clearGroupConfigCache();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `编辑分组「${gname}」` });
    const memberMap = await groupMemberMap();
    const [updated] = await pool.query("SELECT * FROM channel_groups WHERE id = ?", [gid]);
    return ok(res, updated.length ? groupResp(updated[0], memberMap) : null, "分组已更新");
  })
);

// ---------- 删除分组（同时从渠道的 groups 里摘掉、解绑 Key）----------
router.delete(
  "/groups/:id",
  asyncHandler(async (req, res) => {
    const gid = idParam(req);
    if (!gid) return fail(res, "分组不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channel_groups WHERE id = ?", [gid]);
    if (!rows.length) return fail(res, "分组不存在", 404);
    const group = rows[0];
    // 删组 + 渠道摘除 + Key 解绑必须在同一事务里：任何一步失败都回滚，
    // 否则会留下「Key 绑定已删分组」的死绑定（该 Key 永远匹配不到渠道、持续 503）
    let unbound = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("DELETE FROM channel_groups WHERE id = ?", [gid]);
      // 成员摘除要扫全表：分组可以跨厂商
      const [chans] = await conn.query("SELECT id, group_list, group_name FROM channels");
      for (const c of chans) {
        const next = parseGroups(c).filter((g) => g !== group.name);
        await conn.query("UPDATE channels SET group_list = ?, group_name = ? WHERE id = ?", [
          JSON.stringify(next),
          next[0] || "",
          c.id,
        ]);
      }
      // 解绑 Key：置空后回落到公共池，而不是留下永远 503 的死绑定
      const [un] = await conn.query("UPDATE tokens SET group_name = '' WHERE group_name = ?", [group.name]);
      unbound = un.affectedRows || 0;
      // 旧版带厂商前缀的绑定一并清理。用 LIKE 按后缀匹配而不是用 group.vendor 拼前缀 ——
      // vendor 是可改的筛选值，改了之后拼出来的前缀就匹配不到历史绑定了。
      const [un2] = await conn.query("UPDATE tokens SET group_name = '' WHERE group_name LIKE ?", [
        `%:${group.name}`,
      ]);
      unbound += un2.affectedRows || 0;
      await conn.commit();
    } catch (e) {
      await conn.rollback().catch(() => {});
      return fail(res, `删除分组失败（已回滚）：${e.message}`, 500);
    } finally {
      conn.release();
    }
    clearGroupConfigCache();
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `删除分组「${group.vendor ? `${group.vendor} / ` : ""}${group.name}」（解绑 ${unbound} 个密钥）`,
    });
    return ok(res, null, "分组已删除");
  })
);

// ---------- 渠道用量统计（弹窗图表用）----------
// 数据来自消费日志 detail（新日志带 channel_id/channel_ids + model + token 明细）；
// 老日志没有这些字段，统计从本功能上线后开始累计。
router.get(
  "/:id/stats",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    const channel = rows[0];
    const days = safeInt(req.query.days, { min: 1, max: 366, fallback: 30 }) || 30;
    const since = now() - days * 86400;

    let logs = [];
    try {
      // 走 channel_id 列而不是解 detail JSON：列有索引，日志量上来后差距是数量级的；
      // detail 里的 channel_ids 只用于「历史记录」（列是后来加的，老数据没有列值）。
      const [ls] = await pool.query(
        // 一并取 detail：老记录（列已写但 detail 里也有 model 的历史数据）要靠它回落，
        // 只在回填查询里取会让「列存在但为空」的行显示成 "-"
        `SELECT created_at, quota, model, prompt_tokens, completion_tokens, cache_tokens, detail
           FROM logs
          WHERE type = ? AND created_at >= ? AND channel_id = ?`,
        [LOG_TYPE.CONSUME, since, id]
      );
      logs = ls;
      // 老记录（列还没写）回填：只查一次，量小
      const [old] = await pool.query(
        `SELECT created_at, quota, model, prompt_tokens, completion_tokens, cache_tokens, detail
           FROM logs
          WHERE type = ? AND created_at >= ? AND channel_id = 0
            AND JSON_VALID(detail)
            AND (JSON_UNQUOTE(JSON_EXTRACT(detail, '$.channel_id')) = ?
                 OR JSON_CONTAINS(JSON_EXTRACT(detail, '$.channel_ids'), ?))`,
        [LOG_TYPE.CONSUME, since, String(id), String(id)]
      );
      logs = logs.concat(old);
    } catch (e) {
      // 老库不支持 JSON 函数时退化为「仅基础信息 + 最近调用」，不让整个弹窗报错
      console.warn("[channel] 用量统计查询失败：", e.message);
    }

    const totals = { calls: logs.length, units: 0, promptTokens: 0, completionTokens: 0, cacheTokens: 0 };
    const byModel = new Map();
    const byDay = new Map();
    // 模型 × 天 的 Token 矩阵（趋势图多线序列用）
    const modelDay = new Map();
    for (const l of logs) {
      let d = {};
      try {
        d = JSON.parse(l.detail || "{}");
      } catch {
        d = {};
      }
      // 新列优先，老记录回落到 detail。
      // 必须用 || 而不是 ??：新列是 NOT NULL DEFAULT 0，老记录读出来是 0（不是 null），
      // ?? 永远不会回落到 detail，导致老行的 token 全部算 0，与「累计」口径（走 JSON_EXTRACT）矛盾。
      const pt = Number(l.prompt_tokens) || Number(d.prompt_tokens) || 0;
      const ct = Number(l.completion_tokens) || Number(d.completion_tokens) || 0;
      const cat = Number(l.cache_tokens) || Number(d.cache_tokens) || 0;
      const units = Number(l.quota) || 0;
      totals.units += units;
      totals.promptTokens += pt;
      totals.completionTokens += ct;
      totals.cacheTokens += cat;
      const model = String(l.model || d.model || "-");
      const m = byModel.get(model) || { model, calls: 0, units: 0, promptTokens: 0, completionTokens: 0 };
      m.calls += 1;
      m.units += units;
      m.promptTokens += pt;
      m.completionTokens += ct;
      byModel.set(model, m);
      const day = new Date(l.created_at * 1000).toISOString().slice(0, 10);
      const dd = byDay.get(day) || { day, calls: 0, units: 0, tokens: 0 };
      dd.calls += 1;
      dd.units += units;
      dd.tokens += pt + ct;
      byDay.set(day, dd);
      const md = modelDay.get(model) || new Map();
      md.set(day, (md.get(day) || 0) + pt + ct);
      modelDay.set(model, md);
    }
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date((now() - i * 86400) * 1000).toISOString().slice(0, 10);
      dayList.push(byDay.get(d) || { day: d, calls: 0, units: 0, tokens: 0 });
    }

    // 累计（不限窗口）：卡片区展示「累计 Token / 累计调用 / 累计消费」
    // 必须与窗口统计同口径：老记录（channel_id=0）的渠道归属只存在 detail JSON 里，
    // 只查列会让「累计」小于「近 30 天」——管理员一眼就能看出自相矛盾。
    let allTime = { calls: 0, units: 0, promptTokens: 0, completionTokens: 0 };
    try {
      const [[at]] = await pool.query(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(quota), 0) AS units,
                COALESCE(SUM(prompt_tokens), 0) AS pt,
                COALESCE(SUM(completion_tokens), 0) AS ct
           FROM logs
          WHERE type = ? AND channel_id = ?`,
        [LOG_TYPE.CONSUME, id]
      );
      allTime = {
        calls: Number(at.calls) || 0,
        units: Number(at.units) || 0,
        promptTokens: Number(at.pt) || 0,
        completionTokens: Number(at.ct) || 0,
      };
      // 老记录（列还没写）补齐：只统计 channel_id = 0 的行，与上面的谓词互斥，不会双算
      const [[oldAt]] = await pool.query(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(quota), 0) AS units,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.prompt_tokens')) AS UNSIGNED)), 0) AS pt,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.completion_tokens')) AS UNSIGNED)), 0) AS ct
           FROM logs
          WHERE type = ? AND channel_id = 0
            AND JSON_VALID(detail)
            AND (JSON_UNQUOTE(JSON_EXTRACT(detail, '$.channel_id')) = ?
                 OR JSON_CONTAINS(JSON_EXTRACT(detail, '$.channel_ids'), ?))`,
        [LOG_TYPE.CONSUME, String(id), String(id)]
      );
      allTime = {
        calls: allTime.calls + (Number(oldAt.calls) || 0),
        units: allTime.units + (Number(oldAt.units) || 0),
        promptTokens: allTime.promptTokens + (Number(oldAt.pt) || 0),
        completionTokens: allTime.completionTokens + (Number(oldAt.ct) || 0),
      };
    } catch (e) {
      console.warn("[channel] 累计用量查询失败：", e.message);
    }

    // 趋势图序列：Token 量 Top 8 模型 + 其他（values 与 byDay 一一对应）
    const dayKeys = dayList.map((d) => d.day);
    const tokenRanked = [...byModel.values()].sort(
      (a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)
    );
    const series = tokenRanked.slice(0, 8).map((m) => ({
      model: m.model,
      values: dayKeys.map((k) => modelDay.get(m.model)?.get(k) || 0),
    }));
    if (tokenRanked.length > 8) {
      const rest = tokenRanked.slice(8);
      series.push({
        model: "其他",
        values: dayKeys.map((k) => rest.reduce((s, m) => s + (modelDay.get(m.model)?.get(k) || 0), 0)),
      });
    }

    return ok(res, {
      channel: {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        used_count: Number(channel.used_count) || 0,
        created_time: Number(channel.created_time) || 0,
        groups: parseGroups(channel),
      },
      days,
      totals: {
        ...totals,
        od: Number((totals.units / 10000).toFixed(6)),
        tokens: totals.promptTokens + totals.completionTokens,
      },
      allTime: {
        ...allTime,
        tokens: allTime.promptTokens + allTime.completionTokens,
        od: Number((allTime.units / 10000).toFixed(6)),
      },
      byModel: [...byModel.values()].sort((a, b) => b.units - a.units).slice(0, 20),
      byDay: dayList,
      series,
      recent: channelRecent(id, channel.recent_calls),
    });
  })
);

function methodOf(row) {
  const other = parseOther(row);
  const m = String(other.method || "relay");
  // 接入方式：relay（反代）/ api（官方 Key）/ 订阅 OAuth（codex…）/ 具名反代（openai-web-ui…）
  //
  // 关键：**不能把未知 method 一律归一成 "relay"**。
  // provider 下可能挂多个反代方式（openai 下同时有 openai-web 与 openai-web-ui），
  // 它们的 adapter 是分开注册的；归一成 relay 后 adapterKeyFor 会去解析
  // 「厂商名」这个 key（openai），而它没有适配器 ——
  // 表现是渠道能建、能测登录，但一测试就报「适配器未实现测试」。
  // 判定顺序：api / 订阅 OAuth 保持原值；其余若在注册表里存在同名 method 就保留，
  // 只有**确实不存在**的（历史脏数据）才退回 relay 兜底。
  if (isApiKeyMethod(row?.type, m) || isOAuthMethod(m)) return m;
  return getMethod(row?.type, m) ? m : "relay";
}

function rowToResp(r, { withKey = false } = {}) {
  const other = parseOther(r);
  const rt = channelRuntimeState(r.id);
  const keys = splitKeys(r.api_key);
  const provider = getProvider(r.type);
  const method = methodOf(r);
  const mCfg = getMethod(r.type, method);
  const cooling = rt.cooldown_until > Date.now();
  // 浏览器驱动渠道：登录态在 profile 目录里，用标记文件判断是否已登录，
  // 不能只看 other.profile（它在首次打开页面时就会被写入）
  const brReady = mCfg?.needsBrowser ? browserReady(r.type, r.id) : false;
  // 是否 API Key 型接入方式：前端据此渲染「API Key / Base URL」表单与隐藏找回入口。
  // 不能让它自己判 method === "api" —— 同一厂商可能有第二个 API Key 型方式
  // （OpenCode 的 GO 套餐、自定义厂商的 Anthropic 兼容），那些的 method key 不是 "api"。
  const isApi = isApiKeyMethod(r.type, method);
  // 该渠道是不是因为上游 429 被停用的（前端在额度行下方显示橙黄色恢复时间）。
  // 判据用错误码而不是 last_error 文案：文案会随适配器改写而漂移。
  const rateLimited =
    Number(r.rate_limit_until) > 0 || isRateLimitedCode(String(r.last_error_code || ""));

  return {
    id: r.id,
    name: r.name,
    type: r.type,
    typeName: provider?.name || r.type,
    provider: r.type,
    method,
    methodLabel: mCfg?.label || (isApi ? "API Key" : "登录账号"),
    // 凭据：API 方式看 Key，反代方式看登录态
    api_key: withKey ? r.api_key : mask(r.api_key),
    key_count: keys.length,
    has_credential: mCfg?.needsBrowser ? brReady : keys.length > 0 || Boolean(other.profile),
    account: other.account || null,
    needsBrowser: Boolean(mCfg?.needsBrowser),
    browserReady: brReady,
    // 是否订阅 OAuth 接入 + 是否支持「找回凭据」（前端据此显示重新登录入口，不再写死方式清单）
    oauth: isOAuthMethod(method),
    isApiKey: isApi,
    canRecover: !isApi,
    canCaptureSession: Boolean(mCfg?.captureApi),
    // 认证类错误 → 前端把找回按钮标红并按「需要重新登录」提示
    needsRelogin: /AUTH|401|403|失效|过期|无效|重新登录|验证/i.test(String(rt.last_error || r.last_error || "")),
    // 配置
    base_url: r.base_url || mCfg?.baseUrl || "",
    models: String(r.models || "").split(",").map((s) => s.trim()).filter(Boolean),
      group_name: r.group_name || "",
      groups: parseGroups(r),
    priority: Number(r.priority) || 0,
    weight: Number(r.weight) || 0,
    // 状态
    status: r.status,
    // 状态文案要区分「为什么停」：管理员禁用（status=2）与系统自动停用（status=3）
    // 是两回事，而 429 停用更特殊 —— 它到点会自己恢复，所以文案要说清是临时的。
    status_label:
      r.status === 2
        ? "已禁用"
        : cooling
          ? "冷却中"
          : r.status === 1
            ? "已启用"
            : rateLimited
              ? "限流停用"
              : "自动禁用",
    auto_ban: r.auto_ban === 0 ? false : true,
      cooling,
      // 上游 429 的恢复时刻（epoch 秒，0 = 未限流）。
      // 前端在额度行的余额 tag 下面新起一行、橙黄色显示「上游 429，预计恢复 HH:MM:SS」。
      // 以 DB 列为准（重启后内存态会丢，而停用是持久的）。
      rate_limit_until: Number(r.rate_limit_until) || Number(rt.rate_limit_until) || 0,
      last_error_code: String(r.last_error_code || ""),
      recent: channelRecent(r.id, r.recent_calls),
      test_model: r.test_model || "",
      test_prompt: r.test_prompt || "hi",
      auto_test: Number(r.auto_test) === 1,
      auto_test_interval: Number(r.auto_test_interval) || 3600,
      cooldown_text: rt.cooldown_until
      ? new Date(rt.cooldown_until).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      : "",
    last_error: rt.last_error || r.last_error || "",
    // 账号级运行参数（存 other）：编辑弹窗回填用；Default 值与 router/适配器保持一致
    concurrency: Number(other.concurrency) || 1,
    min_gap_ms: Number(other.min_gap_ms) || 0,
    max_per_min: Number(other.max_per_min) || 0,
    fingerprint_mode: String(other.fingerprint_mode || "stable"),
    context_billing: String(other.context_billing || "auto"),
    namespace: String(other.namespace || ""),
    // 检测超时预算（秒，0 = 用默认）：给响应本来就慢的模型单独放宽
    probe_timeout_sec: Math.round((Number(other.probe_timeout_ms) || 0) / 1000),
    // 账号额度快照（订阅/网页版账号）：只在管理员查过之后才有值
    quota: safeJson(r.quota),
    quota_time: Number(r.quota_time) || 0,
    quota_supported: quotaSupportFor({ type: r.type, method, base_url: r.base_url }).supported,
    // 统计
    used_count: Number(r.used_count) || 0,
    // 该渠道累计（额度列要显示：次数 / token / 消费）
    totals: r._totals || null,
    last_used_time: Number(r.last_used_time) || 0,
    // 两个耗时都给前端：ttft_ms 是展示与慢判定口径（首 Token），
    // response_time 是总耗时（含生成）。老数据没有 ttft_ms 时退化为总耗时，
    // 前端不必区分「有没有这个字段」。
    response_time: Number(r.response_time) || 0,
    ttft_ms: Number(r.ttft_ms) || Number(r.response_time) || 0,
    tested_time: Number(r.tested_time) || 0,
    remark: r.remark || "",
    created_time: Number(r.created_time) || 0,
  };
}

async function listRows({ type, keyword, status, method } = {}) {
  const conds = [];
  const args = [];
  if (type) {
    conds.push("type = ?");
    args.push(type);
  }
  if (status) {
    // 非法状态（如 "Infinity"）直接忽略，不能拼进 SQL
    const statusVal = safeInt(status, { min: 1, max: 3 });
    if (statusVal) {
      conds.push("status = ?");
      args.push(statusVal);
    }
  }
  if (keyword) {
    conds.push("(name LIKE ? OR base_url LIKE ? OR models LIKE ?)");
    const like = `%${keyword}%`;
    args.push(like, like, like);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const [rows] = await pool.query(`SELECT * FROM channels ${where} ORDER BY priority DESC, id ASC`, args);
  const filtered = method ? rows.filter((r) => methodOf(r) === method) : rows;
  // 批量挂上「该渠道累计」三个数（列表页额度列要显示：调用次数 / token / 消费）。
  // **一次聚合查询算全部渠道**，不逐行查 —— 逐行是 N+1，几十个渠道就是几十次往返。
  await attachChannelTotals(filtered);
  return filtered;
}

/**
 * 给渠道行批量挂 `_totals`：{ calls, units, tokens }（该渠道的累计口径）。
 *
 * 为什么要批量：渠道列表页每行都要显示这三个数，逐行查会变成 N+1。
 * 口径与 `/:id/stats` 的全量统计一致（logs 表 + 老记录回落 detail JSON），
 * 只是把 WHERE channel_id = ? 换成 GROUP BY channel_id。
 */
async function attachChannelTotals(rows) {
  if (!rows.length) return;
  const ids = rows.map((r) => Number(r.id)).filter(Boolean);
  if (!ids.length) return;
  const map = new Map();
  const add = (id, o) => {
    const cur = map.get(id) || { calls: 0, units: 0, tokens: 0 };
    cur.calls += Number(o.calls) || 0;
    cur.units += Number(o.units) || 0;
    cur.tokens += Number(o.tokens) || 0;
    map.set(id, cur);
  };
  try {
    const [list] = await pool.query(
      `SELECT channel_id AS cid, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0) AS tokens
         FROM logs
        WHERE type = ? AND channel_id IN (?)
        GROUP BY channel_id`,
      [LOG_TYPE.CONSUME, ids]
    );
    for (const x of list) add(Number(x.cid), x);
    // 老记录（channel_id 列还没写）回落到 detail JSON：只处理 channel_id = 0 的行，
    // 与上面互斥不会双算（与 /:id/stats 同一口径，否则列表与详情会对不上）。
    const [old] = await pool.query(
      `SELECT COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.channel_id')) AS UNSIGNED), 0) AS cid,
              COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.prompt_tokens')) AS UNSIGNED)),0)
            + COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.completion_tokens')) AS UNSIGNED)),0) AS tokens
         FROM logs
        WHERE type = ? AND channel_id = 0 AND JSON_VALID(detail)
          AND JSON_EXTRACT(detail, '$.channel_id') IS NOT NULL
        GROUP BY cid`,
      [LOG_TYPE.CONSUME]
    );
    for (const x of old) {
      if (ids.includes(Number(x.cid))) add(Number(x.cid), x);
    }
  } catch (e) {
    // 老库不支持 JSON 函数时退化为「无统计」，不让整个列表报错
    console.warn("[channel] 批量统计查询失败：", e.message);
  }
  for (const r of rows) r._totals = map.get(Number(r.id)) || { calls: 0, units: 0, tokens: 0 };
}

/** 取该渠道的适配器（仅反代方式有本地适配器；API 方式走 openai-compat） */
async function adapterOf(providerKey, methodKey) {
  try {
    return await getAdapter({ type: providerKey, other: { method: methodKey } });
  } catch {
    return null;
  }
}

// ---------- 厂商列表（前端「添加渠道」按此渲染）----------
router.get(
  "/providers",
  asyncHandler(async (req, res) => {
    return ok(res, publicProviders());
  })
);

// ---------- 列表 ----------
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await listRows({
      type: req.query.type ? String(req.query.type) : null,
      keyword: req.query.keyword ? String(req.query.keyword) : null,
      status: req.query.status ? Number(req.query.status) : null,
      method: req.query.method ? String(req.query.method) : null,
    });
    return ok(res, rows.map((r) => rowToResp(r)));
  })
);

// 汇总统计
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const rows = await listRows();
    const items = rows.map((r) => rowToResp(r));
    // 站点累计用量直接取 users 累计列：logs 全表 SUM 会随日志量线性变慢，口径相同
    const [[usage]] = await pool.query(
      "SELECT COALESCE(SUM(request_count),0) AS calls, COALESCE(SUM(used_quota),0) AS quota FROM users"
    );
    return ok(res, {
      total: items.length,
      enabled: items.filter((x) => x.status === 1 && !x.cooling).length,
      cooling: items.filter((x) => x.cooling).length,
      disabled: items.filter((x) => x.status === 2).length,
      relay: items.filter((x) => x.method === "relay").length,
      api: items.filter((x) => x.method === "api").length,
      total_calls: Number(usage.calls) || 0,
      total_quota: Number(usage.quota) || 0,
    });
  })
);

// ---------- 凭据找回：该渠道实际支持哪些恢复方式 ----------
// 「401 找回」不是只有「粘贴凭据文件」一条路。每种接入方式能用的恢复手段不同：
//   · 订阅 OAuth：官方授权页换令牌（可在服务器浏览器里做，含邮箱/短信验证码那一步）、设备码、粘贴官方凭据
//   · 网页版反代：在服务器浏览器里登录一次后抓取（扫码/验证码在同一画面里人工完成）
//   · 账密型反代：直接重登
// 这里把能力算清楚交给前端渲染，避免前端写死接入方式清单（历史上 kiro / openai-web 就没有入口）。
// ---------- 凭据找回：把新凭据写回已有渠道 ----------
// 找回流程的公共落点：解析凭据 → 必要时由适配器补齐/刷新 → 覆盖该渠道凭据 → 清冷却。
// 与 /channel/login 的更新分支口径一致（合并 other，不丢 profile/cookies 等旧字段）。
//
// 并发注意：写回必须**生效在刷新之后**。适配器的 refreshAuth 走 withRefreshLock，
// 其 persistOtherPatch 是「重读 latest → 合并 patch → 整列 UPDATE」；
// 如果它在我们写回之后才落库，会把旧 access/refresh_token 覆盖回来（管理员看到
// 「凭据已更新」但库里其实是旧账号）。这里用 other.cred_epoch 代次解决：
// 写回时 +1，刷新写回带上发起时的代次，不一致就丢弃本次刷新（见 auth-store.js）。
async function applyCredentialToChannel({ id, type, method, credential, vendor }) {
  const [rows] = await pool.query("SELECT id, type, api_key, other FROM channels WHERE id = ?", [id]);
  if (!rows.length) throw Object.assign(new Error("渠道不存在"), { code: "LOGIN_BAD_PARAMS" });
  const targetType = String(type || rows[0].type);
  // 设备授权路径必须带 vendor（服务端会话里的归属厂商），此处强校验；
  // 手工粘贴路径（/recover 等）不传 vendor，不受影响。
  if (vendor) assertBindVendorFits(targetType, vendor);
  const methodKey = method || methodOf(rows[0]);
  const adapter = await adapterOf(targetType, methodKey);
  if (!adapter) throw Object.assign(new Error("该接入方式不支持凭据写回"), { code: "LOGIN_BAD_PARAMS" });
  const raw = typeof credential === "string" ? credential : JSON.stringify(credential || {});
  // 上限兜底：HTTP 层允许 1MB，凭据不该有这么大的；顺带防住畸形输入
  if (raw.length > 200_000) throw Object.assign(new Error("凭据内容过大"), { code: "LOGIN_BAD_PARAMS" });

  let parsed;
  if (adapter.importAuth) {
    // **优先交适配器解析**，不要因为 methodKey 被归一成 "relay" 就绕过它。
    //
    // 真实事故（用户实测，MiMo）：「我添加了渠道，为什么要登录态是啥玩意？
    // 我这边拿到了 cookie 填写进去保存之后测试链接显示未实现测试？」
    // 链路：渠道的 method 存的是通用值 "relay"，而 MiMo 的方法名是 "mimo-web" ——
    // 于是这里既不满足 `methodKey === "relay"`（methodKey 由 methodOf 归一，
    // 在「能查到方法」时会保留原值，但历史渠道存的是 relay），
    // 又因为分支判断用的是归一化前的值而**跳过了 importAuth**，
    // 结果凭据按「裸 token + cookies 数组」落库（other.cookies），
    // 而 mimo-web 适配器读的是 other.service_token / user_id / ph →
    // 凭据字段名对不上 → 永远 401「登录态已失效」，管理员反复重抓也修不好。
    //
    // 适配器自带 importAuth 时它最懂自己的凭据形态（parseAuth 已兼容 cookies 数组、
    // 各种别名与裸串），所以只要 adapter.importAuth 存在就一定用它。
    parsed = await adapter.importAuth({ token: raw, mode: "paste", ...(rest || {}) });
  } else if (methodKey === "relay" || /-web(-ui)?$/.test(methodKey) || adapter === null) {
    // 网页版反代（DeepSeek / Kimi / GLM / 豆包 / 通义）没有 importAuth：
    // 它们的凭据形态就是「登录态 token（api_key）+ 可选 cookies（other.cookies）」，
    // 这里按同一契约直接落库，让「抓取登录态」也能走统一找回入口。
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch {
      /* 裸 token 串：整体当作登录态 */
    }
    const token = String((obj && (obj.token ?? obj.access_token)) ?? raw).trim().slice(0, 60_000);
    if (!token) throw Object.assign(new Error("没有可用的登录态"), { code: "LOGIN_BAD_PARAMS" });
    let cookies;
    const rawCookies = obj?.cookies;
    if (Array.isArray(rawCookies) && rawCookies.length) cookies = rawCookies;
    else if (typeof rawCookies === "string" && rawCookies.trim()) {
      cookies = rawCookies
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => {
          const i = pair.indexOf("=");
          return i > 0 ? { name: pair.slice(0, i), value: pair.slice(i + 1) } : null;
        })
        .filter(Boolean);
    }
    parsed = { token, other: cookies?.length ? { cookies } : {}, accountLabel: "" };
  } else {
    throw Object.assign(new Error("该接入方式不支持凭据写回"), { code: "LOGIN_BAD_PARAMS" });
  }

  // 旧字段以「写回前重读」为准：importAuth 期间渠道可能被其它流程改过（如刷新令牌）
  const [freshRows] = await pool.query("SELECT api_key, other FROM channels WHERE id = ?", [id]);
  const base = freshRows.length ? freshRows[0] : rows[0];
  const merged = { ...parseOther(base), ...(parsed.other || {}) };
  // 解析后拿不到 token 时保留原 api_key：部分接入方式（例如只给 refreshToken 的网页版）
  // 的 importAuth 只产出 other，用空串覆盖会让渠道连原有凭据都丢掉。
  const nextToken = String(parsed.token || "").slice(0, 60_000) || String(base.api_key || "");
  // 打「凭据代次」标记：适配器刷新写回时若发现代次已变，说明凭据被人工替换过，不再覆盖 token 字段
  merged.cred_epoch = (Number(merged.cred_epoch) || 0) + 1;
  merged.cred_updated_at = now();
  await pool.query("UPDATE channels SET api_key = ?, other = ?, last_error = '' WHERE id = ?", [
    nextToken,
    JSON.stringify(merged),
    id,
  ]);
  resetChannelState(id);
  invalidateChannelCache();

  // 凭据刚写回成功 → **顺手把这个账号实际能用的模型拉回来**。
  //
  // 用户反馈（原话）：「qoder 点击一键绑定登录成功后这边也没回填凭证或者正确回显
  // 自动获取模型啊？怎么还要用户填东西？」—— 一键绑定的意义就是「点一下就完事」，
  // 而绑完后渠道的 models 仍是空的：管理员还得自己点「从上游获取模型」再全选保存。
  // 那一步完全多余 —— 凭据都在手上了，问一次上游是免费的（只读接口）。
  //
  // 只在**模型为空**时填：已有声明的渠道不覆盖（管理员可能特意只放开几个模型，
  // 自动填满会把他的限制冲掉）。失败也不抛错：拉不到模型不该让绑定本身报失败。
  let autoModels = 0;
  try {
    const [cur] = await pool.query("SELECT models FROM channels WHERE id = ?", [id]);
    const hasModels = String(cur[0]?.models || "").trim().length > 0;
    if (!hasModels) {
      const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
      const channel = rowToChannel(fresh[0]);
      const adapter = await getAdapter(channel);
      if (typeof adapter?.fetchUpstreamModels === "function") {
        const list = await adapter.fetchUpstreamModels(channel);
        const ids = (Array.isArray(list) ? list : [])
          .map((m) => String(m?.id || m || "").trim())
          .filter((m) => m && m !== "*");
        if (ids.length) {
          await pool.query("UPDATE channels SET models = ? WHERE id = ?", [ids.join(",").slice(0, 4000), id]);
          autoModels = ids.length;
          console.log(`[channel] #${id} 绑定成功后自动填入 ${ids.length} 个上游模型`);
        }
      }
    }
  } catch (e) {
    console.warn(`[channel] #${id} 绑定后自动拉模型失败（不影响绑定）：${e.message}`);
  }

  return {
    accountLabel: parsed.accountLabel || merged.account || merged.email || "",
    credEpoch: merged.cred_epoch,
    // 自动填入的模型数：调用方回给前端，让「绑定成功」这句提示带上实际结果，
    // 而不是让管理员自己去渠道详情里找（用户要的就是「正确回显自动获取模型」）
    autoModels,
  };
}

router.get(
  "/:id/recovery",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    const r = rows[0];
    const provider = getProvider(r.type);
    const method = methodOf(r);
    const mCfg = getMethod(r.type, method) || {};
    const rt = channelRuntimeState(id);
    const other = parseOther(r);

    const modes = [];
    if (method !== "api") {
      // 服务器浏览器里的官方授权页：能覆盖「账号掉验证要接码」这一步（人工在实时画面里输验证码）
      if (isOAuthMethod(method) && supportsInteractiveLoginMethod(r.type, method)) {
        // 服务器浏览器那条路已整体删除（用户实测「卡的不行、吃服务器内存」且没必要）。
        // 现在是本机浏览器小窗登录 + 粘回调 —— 唯一能真正全自动拿到凭据的路径
        //（授权码交给我们自己的回调地址）。
        modes.push({
          key: "oauth-callback",
          label: "本机浏览器登录 + 粘贴回调",
          desc: "在弹出的小窗里登录，把回调地址粘回来换令牌；不占服务器资源",
        });
      }
      if (isOAuthMethod(method) && supportsDeviceLogin(r.type)) {
        modes.push({ key: "device", label: "设备码登录", desc: "打开授权页输入设备码，适合无法回调的场景" });
      }
      // 一键绑定（设备授权）：Kiro / WorkBuddy / Qoder。
      // 放在最前是因为它是这三个渠道**唯一不需要用户手工找凭据文件**的方式。
      if (supportsDeviceBind(r.type)) {
        modes.unshift({ key: "device-bind", label: "一键绑定（推荐）", desc: "打开授权页确认一次即可自动完成绑定，无需手工找凭据文件" });
      }
      // needsBrowser 的方式（GLM/豆包/通义等）也只剩本机浏览器路径。
      // 注意：这些渠道的**对话**仍在服务器浏览器里跑（页面签名无法服务端伪造，
      // 见 services/upstream/glm.js 的说明）—— 删的只是「登录用的浏览器」，
      // 它不是服务器压力的来源，对话驱动那部分另有空闲回收控制。
      if (mCfg.needsBrowser) {
        modes.push({
          key: "paste",
          label: "本机浏览器登录",
          desc: "在弹出的小窗里登录上游，把登录态复制过来",
        });
      }
      // 注：这里曾有独立的 "capture" 项，与 "paste" 并列。
      // 两者是同一条流程（抓取面板里自带粘贴兜底），并列会让用户以为是两种登录方式，
      // 而前端对 "capture" 没有渲染分支 → 点进去是空白表单。已移除，由 paste 的抓取按钮承担。
      if ((mCfg.loginModes || []).includes("password")) {
        modes.push({ key: "password", label: "账号密码登录", desc: "用上游账号密码重新登录" });
      }
      // 去重：上面几条分支可能已经加过 paste（本机浏览器路径）。
      // 不去重的话下拉里会出现两个「粘贴」，用户分不清该点哪个。
      if (!modes.some((m) => m.key === "paste")) {
        modes.push({ key: "paste", label: "粘贴凭据", desc: "手工粘贴官方凭据文件或登录态" });
      }
    } else {
      modes.push({ key: "api-key", label: "更新 API Key", desc: "到渠道编辑里换一个可用的 Key" });
    }

    const lastError = rt.last_error || r.last_error || "";
    // 「需要人工重新登录」的判定：认证类错误 + 冷却中，或本来就缺凭据。
    //
    // 例外（2026-09-26）：CHANNEL_NOT_APPROVED（上游把账号标记为未批准/风控拦截，
    // WorkBuddy 11128/11140 实测）**不是凭据问题** —— 它的报错里带 HTTP 403 字样，
    // 会命中下面的正则，把管理员引进「重新绑定」的死胡同（实测同一账号连绑 4 次、
    // 每次都 403，凭据明明是好的）。有该 code 时明确判定为不需要重登。
    const notApproved = String(r.last_error_code || "") === "CHANNEL_NOT_APPROVED";
    const needsRelogin =
      !notApproved &&
      (/AUTH|401|403|失效|过期|未配置|无效|重新登录|验证/i.test(String(lastError)) ||
        (!r.api_key && !other.profile && method !== "api"));

    return ok(res, {
      id: r.id,
      name: r.name,
      type: r.type,
      typeName: provider?.name || r.type,
      method,
      methodLabel: mCfg.label || (method === "api" ? "API Key" : "登录账号"),
      account: other.account || other.email || "",
      // 订阅渠道的订阅档位（导入凭据时从 id_token 解析，用于展示）
      planType: other.plan_type || "",
      lastError,
      cooling: rt.cooldown_until > Date.now(),
      cooldownText: rt.cooldown_until ? new Date(rt.cooldown_until).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "",
      needsRelogin,
      // 凭据时间线（展示「用了多久 / 什么时候续期」）
      expiresAt: Number(other.expires_at) || 0,
      refreshedAt: Number(other.refreshed_at) || 0,
      // 能否「只检测当前凭据」：反代/订阅渠道各自有 verify（API 渠道走 /test）
      canVerify: method === "api" || Boolean(mCfg.adapter) || Boolean(mCfg.loginModes?.length) || Boolean(mCfg.entryUrl),
      modes,
      // 本机浏览器登录指引（凭据在自己浏览器里的位置 + 可选的取码一行）。
      // 放在这里是为了让「重新登录」弹窗也能给分步说明 —— 否则它只能丢一句
      // 「粘贴登录态」，用户不知道该从哪抄（新增渠道面板用的是同一份数据）。
      localLogin: (() => {
        const guide = { ...(localLoginGuide(r.type, method) || {}), entryUrl: mCfg.entryUrl || "" };
        // WorkBuddy 的登录页按账号 realm 分域（域错了会被网关 401，见 workbuddy.js 的说明）：
        // 渠道凭据里存了 realm，找回时按它给出对的登录入口。
        if (r.type === "workbuddy" && String(other.realm || "") === "cn") {
          guide.entryUrl = "https://www.codebuddy.cn/";
        }
        return guide;
      })(),
    });
  })
);

router.post(
  "/:id/quota",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    const channel = rowToChannel(rows[0]);
    const support = quotaSupportFor(channel);
    if (!support.supported) {
      return fail(res, "该接入方式上游没有可用的额度查询接口（网页版账号只能在用量统计里看平台侧统计）", 400);
    }
    try {
      const quota = await fetchQuota(channel);
      await pool.query("UPDATE channels SET quota = ?, quota_time = ? WHERE id = ?", [
        // 统一走 clampQuotaPayload：channels.quota 是 TEXT，上游返回几百个额度桶时会超限
        clampQuotaPayload(quota),
        now(),
        id,
      ]);
      return ok(res, quota, "已获取账号额度");
    } catch (e) {
      // 额度查询失败不代表渠道不可用：只回错误，不写 last_error、不冷却
      return fail(res, `额度查询失败：${e.message}`, 400);
    }
  })
);

// ---------- 从上游拉取该渠道实际可用的模型 ----------
// 为什么要这条：渠道的 models 字段是「管理员限定的范围」，而管理员并不知道
// 这个账号到底能用哪些模型（尤其订阅/网页版账号，档位决定可见模型，且会变）。
// 这里直接问上游要一份真实清单，供渠道编辑的「模型范围」全选/多选，
// 以及渠道列表里展示「这个号实际能用什么」。
//
// 兜底策略：适配器没实现 / 上游接口失败时，回退到平台按该厂商注册的模型
// （至少管理员能选，而不是报错卡死）。响应里用 source 字段说明数据来源。
router.post(
  "/:id/upstream-models",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    const r = rows[0];
    const channel = rowToChannel(r);
    const adapter = await adapterOf(r.type, methodOf(r));

    let models = [];
    let source = "upstream";
    let upstreamError = "";
    if (typeof adapter?.fetchUpstreamModels === "function") {
      try {
        models = await adapter.fetchUpstreamModels(channel);
      } catch (e) {
        upstreamError = e.message;
      }
    } else {
      upstreamError = "该接入方式没有实现上游模型接口";
    }

    if (!models.length) {
      // 回退到平台注册表（该厂商已注册的模型）—— 让管理员至少有一个可选的清单
      const { allPublicModels } = await import("../services/models.js");
      try {
        const all = await allPublicModels([r.type]);
        models = all.map((m) => m.id);
        source = all.length ? "registry" : "none";
      } catch {
        source = "none";
      }
    }

    // 该厂商自己的**模型单价**（与平台定价无关）：WorkBuddy 之类是积分制，
    // 每个模型的 credits 倍率就在上游 config 里。适配器没实现就为空对象。
    let prices = {};
    if (typeof adapter?.fetchUpstreamPrices === "function") {
      try {
        prices = await adapter.fetchUpstreamPrices(channel);
      } catch {
        /* 拿不到价格不影响模型清单返回 */
      }
    }

    // Cline 专属：454 个模型平铺没法选，附上「按档位 / 按厂商」的分组供前端做分组选择器。
    // 只对带厂商前缀的目录型渠道启用（目前就是 Cline；其它厂商的模型名没有 `vendor/model`
    // 结构，套上分组只会得到一堆无意义的单元素分组）。
    const groups = clineGroupsFor(r.type, [...new Set(models)]);

    return ok(res, {
      models: [...new Set(models)].sort(),
      source,
      // { "<model-id>": { text: "x0.79 credits", unit: "credits"|"money" } }
      prices,
      upstreamError: upstreamError || undefined,
      // 渠道已声明的范围，前端据此预选
      declared: String(r.models || "").split(",").map((s) => s.trim()).filter(Boolean),
      // { groups:[{key,label,count,models}], tiers:[{key,label,count,models}], total, freeCount }
      ...(groups ? { clineGroups: groups } : {}),
    });
  })
);

// ---------- 凭据找回：直接写入该渠道的凭据 ----------
// 粘贴凭据 / 设备码挂机 / 上游回调，最终都落到这里：解析 → 覆盖 → 清冷却 → 健康检查。
router.post(
  "/:id/credential",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const credential = req.body?.credential ?? req.body?.token ?? "";
    if (!String(credential).trim()) return fail(res, "请提供凭据");
    const [rows] = await pool.query("SELECT type, name FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    let applied;
    try {
      applied = await applyCredentialToChannel({ id, type: rows[0].type, credential });
    } catch (e) {
      return fail(res, e.message, 400);
    }
    // 写回后立刻探一次，让管理员马上知道「找回是否真的可用」（失败只记 last_error，不影响写入结果）
    let healthy = null;
    try {
      const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
      const adapter = await adapterOf(fresh[0].type, methodOf(fresh[0]));
      if (adapter?.verify) {
        const ms = await adapter.verify(rowToChannel(fresh[0]));
        await pool.query("UPDATE channels SET response_time = ?, tested_time = ?, last_error = '' WHERE id = ?", [ms, now(), id]);
        healthy = true;
      }
    } catch (e) {
      healthy = false;
      await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), id]);
    }
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `渠道「${rows[0].name}」凭据已更新${applied.accountLabel ? `（${applied.accountLabel}）` : ""}`,
    });
    const all = await listRows();
    return ok(
      res,
      { ...rowToResp(all.find((r) => r.id === id)), account: applied.accountLabel, healthy },
      healthy === false ? "凭据已写入，但上游校验未通过，请检查凭据是否有效" : "凭据已更新，渠道已恢复"
    );
  })
);

// ---------- 查看完整 Key ----------
router.get(
  "/:id/key",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT api_key, name FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `查看渠道「${rows[0].name}」的凭据` });
    return ok(res, { api_key: rows[0].api_key });
  })
);

// ---------- 多 Key 管理 ----------
router.post(
  "/:id/keys",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const { action, keys, keyIndex } = req.body || {};
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    const cur = splitKeys(rows[0].api_key);

    let next = [...cur];
    if (action === "add") {
      const add = (Array.isArray(keys) ? keys : String(keys || "").split("\n")).map((s) => String(s).trim()).filter(Boolean);
      if (!add.length) return fail(res, "请提供要添加的 Key");
      next.push(...add);
    } else if (action === "delete") {
      const idx = Number(keyIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return fail(res, "Key 下标无效");
      next.splice(idx, 1);
    } else if (action === "replace") {
      next = (Array.isArray(keys) ? keys : String(keys || "").split("\n")).map((s) => String(s).trim()).filter(Boolean);
    } else {
      return fail(res, "不支持的操作（add / delete / replace）");
    }

    // api_key 列是 TEXT（64KB）：多 Key 拼接后必须有上限，否则 MySQL 报错 500
    const joined = next.join("\n");
    if (joined.length > 60_000) return fail(res, "Key 总长度超出上限，请减少 Key 数量");
    await pool.query("UPDATE channels SET api_key = ? WHERE id = ?", [joined, id]);
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `渠道「${rows[0].name}」Key 管理：${action}（现有 ${next.length} 个）`,
    });
    const fresh = await listRows();
    return ok(res, rowToResp(fresh.find((r) => r.id === id)), "已更新");
  })
);

router.post(
  "/oauth/start",
  asyncHandler(async (req, res) => {
    const { type } = req.body || {};
    const provider = getProvider(type);
    if (!provider) return fail(res, "未知厂商");
    try {
      const r = buildLoginUrl(type);
      return ok(res, { url: r.url, state: r.state, redirect_uri: r.redirectUri });
    } catch (e) {
      return fail(res, e.message, e.code === "CHANNEL_CONFIG_ERROR" ? 400 : 500);
    }
  })
);

// 用粘贴回来的回调地址换 token，并直接创建/更新渠道（一步到位，管理员不用再手抄凭据）
router.post(
  "/oauth/exchange",
  asyncHandler(async (req, res) => {
    const { type, name, priority, state, callback, id, method } = req.body || {};
    const provider = getProvider(type);
    if (!provider) return fail(res, "未知厂商");
    // 按请求里的 method 找该厂商的订阅方式（不写死 antigravity，gemini/openai/anthropic 都走这里）
    const methodCfg =
      (method && getMethod(type, String(method))) || (provider.methods || []).find((m) => isOAuthMethod(m.key));
    // 注意：raw 配置上没有 oauth 字段（那是 publicProviders 下发时才生成的），这里要按方法名判断
    if (!methodCfg || !isOAuthMethod(methodCfg.key)) return fail(res, `${provider.name} 不支持订阅登录`);
    const adapterKey = methodCfg.adapter || methodCfg.key;
    let adapter;
    try {
      adapter = await getAdapter(adapterKey);
    } catch {
      return fail(res, `适配器 ${adapterKey} 不可用`);
    }
    if (!adapter?.importAuth) return fail(res, `${provider.name} 适配器未实现凭据导入`);

    let credential;
    let accountLabel = "";
    try {
      const r = await exchangeCodeForCredential(type, callback, String(state || ""));
      credential = r.credential;
      accountLabel = r.accountLabel;
    } catch (e) {
      return fail(res, e.message, 400);
    }

    // 交给适配器解析成它自己的凭据结构（各适配器的字段命名不同）
    let token = "";
    let other = {};
    try {
      const r = await adapter.importAuth(credential);
      token = String(r.token || "").slice(0, 60_000);
      other = { method: adapterKey, ...(r.other || {}) };
      accountLabel = r.accountLabel || accountLabel;
    } catch (e) {
      return fail(res, `凭据解析失败：${e.message}`, 400);
    }

    // 创建或更新渠道（与 /login 保持同一套落库逻辑）
    const targetId = id === undefined ? null : safeInt(id, { min: 1 });
    const priorityVal = safeInt(priority, { min: 0, max: 1_000_000, fallback: 0 });
    const displayName = String(name || accountLabel || `${provider.name} 订阅`).slice(0, 64);

    if (targetId) {
      const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [targetId]);
      if (!rows.length) return fail(res, "渠道不存在", 404);
      // 与 /login 同语义：合并旧 other（保留 state_kit 等适配器不产出的字段），不整列覆盖
      const merged = { ...parseOther(rows[0]), ...other };
      await pool.query("UPDATE channels SET name = ?, api_key = ?, other = ?, priority = ?, status = 1 WHERE id = ?", [
        displayName,
        token,
        JSON.stringify(merged),
        priorityVal,
        targetId,
      ]);
      await resetChannelState(targetId);
      return ok(res, { id: targetId, name: displayName, account: accountLabel }, "登录成功，凭据已更新");
    }

    // 去重与 /login 同口径：按账号标识集合判重（access_token 每次登录都变，拿它当键会漏检重复）
    let existId = 0;
    const [rows] = await pool.query("SELECT id, other FROM channels WHERE type = ?", [type]);
    const dup = rows.find((r) => isSameAccount(parseOther(r), other));
    if (dup) existId = dup.id;
    else {
      const [exist] = await pool.query("SELECT id FROM channels WHERE type = ? AND api_key = ?", [type, token]);
      if (exist.length) existId = exist[0].id;
    }
    if (existId) {
      const merged = { ...parseOther(rows.find((r) => r.id === existId) || {}), ...other };
      await pool.query("UPDATE channels SET other = ?, api_key = ?, status = 1 WHERE id = ?", [
        JSON.stringify(merged),
        token,
        existId,
      ]);
      await resetChannelState(existId);
      return ok(res, { id: existId, name: displayName, account: accountLabel }, "该账号已存在，凭据已更新");
    }

    const [ret] = await pool.query(
      "INSERT INTO channels (name, type, base_url, api_key, models, group_name, group_list, status, priority, other, created_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        displayName,
        type,
        "",
        token,
        // 留空 = 该厂商全部模型（模型归厂商，不归账号）
        "",
        "",
        "[]",
        1,
        priorityVal,
        JSON.stringify(other),
        now(),
      ]
    );
    await resetChannelState(ret.insertId);
    return ok(res, { id: ret.insertId, name: displayName, account: accountLabel }, "登录成功，渠道已创建");
  })
);

// 该厂商是否支持交互式登录（前端据此决定显示「登录账号」还是只能「粘贴凭据」）
router.get(
  "/oauth/info",
  asyncHandler(async (req, res) => {
    const type = String(req.query.type || "");
    if (!getProvider(type)) return fail(res, "未知厂商");
    return ok(res, interactiveLoginInfo(type));
  })
);

// 设备码登录（Grok/xAI）：服务端发起后返回 user_code，用户在任意浏览器完成授权，
// 前端按 interval 轮询 poll 拿凭据（不需要回调地址，也不需要服务器浏览器）。
router.post(
  "/oauth/device/start",
  asyncHandler(async (req, res) => {
    const { type } = req.body || {};
    if (!getProvider(type)) return fail(res, "未知厂商");
    try {
      return ok(res, await startDeviceLogin(type));
    } catch (e) {
      return fail(res, e.message, 400);
    }
  })
);

router.post(
  "/oauth/device/poll",
  asyncHandler(async (req, res) => {
    const { type, device_code } = req.body || {};
    if (!getProvider(type)) return fail(res, "未知厂商");
    try {
      const r = await pollDeviceLogin(type, device_code);
      if (r.pending) return ok(res, { pending: true });
      return ok(res, { pending: false, credential: JSON.stringify(r.credential, null, 2), accountLabel: r.accountLabel });
    } catch (e) {
      return fail(res, e.message, 400);
    }
  })
);

// ---------- 反代接入方式：账号登录 ----------
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const {
      type,
      name,
      priority,
      id,
      mode = "password",
      method: methodInput,
      models: modelsInput,
      group_name,
      groups: groupsInput,
      weight,
      auto_ban,
      ...rest
    } = req.body || {};
    const provider = getProvider(type);
    if (!provider) return fail(res, "未知厂商");
    const methodKey = String(methodInput || "relay");
    const priorityProvided = priority !== undefined;
    const mCfg = getMethod(type, methodKey);
    if (!mCfg) return fail(res, `${provider.name} 不支持该接入方式（${methodKey}）`);
    if (methodKey === "api") return fail(res, "API 接入方式请使用渠道创建表单（POST /api/channel/）");
    // 订阅 OAuth 用粘贴凭据；relay 按 loginModes 校验
    if (!isOAuthMethod(methodKey) && !mCfg.loginModes.includes(mode)) {
      return fail(res, `${provider.name} 不支持该登录方式（支持：${mCfg.loginModes.join("/")}）`);
    }

    const adapter = await adapterOf(type, methodKey);
    if (!adapter) return fail(res, `${provider.name} 适配器不可用`);

    // 一键绑定：提交的 ticket 必须属于本厂商。这一步放在建渠道之前 —— 否则会先
    // 建出一条类型不符的渠道，等 /devices/claim 才发现不匹配再删掉（用户看到渠道
    // 闪一下就没了）。这里直接给出明确报错，什么都不写库。
    const bindTicket = String(rest.bindTicket || "").trim();
    if (bindTicket) {
      sweepPendingCredentials();
      const rec = pendingCredentials.get(bindTicket);
      if (!rec) return fail(res, "绑定凭据已过期或不存在，请重新发起一键绑定", 410);
      try {
        assertBindVendorFits(type, rec.vendor);
      } catch (e) {
        return fail(res, e.message, 400);
      }
    }

    // 表单里的模型/分组/优先级/权重/自动禁用必须真正落库（此前 relay 提交被全部丢弃，
    // 用户改了等于没改）；未提交的字段在更新时保持原值
    // 模型范围：留空 = 该厂商全部模型（模型归厂商，不归账号），
    // 只有管理员显式指定时才落库限制范围。不再自动填该接入方式的默认模型列表 ——
    // 那些默认值只是「推荐模型」，写成范围会把新模型（如新发布的档位）挡在调度之外。
    const models = (
      Array.isArray(modelsInput)
        ? modelsInput.map((s) => String(s).trim()).filter(Boolean).join(",")
        : String(modelsInput || "").trim()
    ).slice(0, 20_000);
    const groupName = String(group_name || "").trim().slice(0, 64);
    // 分组（可多选）：优先 groups 数组，否则沿用 group_name；空数组 = 公共池
    const groupsList = normalizeGroups(groupsInput !== undefined ? groupsInput : group_name);
    const weightVal =
      Number.isFinite(Number(weight)) && Number(weight) > 0 ? Math.min(10000, Math.floor(Number(weight))) : 1;
    const autoBanVal = auto_ban === undefined ? 1 : auto_ban ? 1 : 0;
    const priorityVal = safeInt(priority, { min: 0, max: 1_000_000, fallback: 0 });
    const targetId = id === undefined ? null : safeInt(id, { min: 1 });
    if (id !== undefined && !targetId) return fail(res, "渠道 id 无效");
    let token = "";
    let other = { method: "relay" };
    let accountLabel = null;

    try {
      if (isOAuthMethod(methodKey) && rest.bindTicket) {
        // 一键绑定路径：凭据已由设备授权回调存进 pendingCredentials，
        // 前端提交时只带 ticket。此处**跳过凭据导入**（用户手里没有 JSON，
        // 也不该被要求去弄一份）；真实凭据由随后的 /devices/claim 写入。
        other = { method: methodKey };
      } else if (isOAuthMethod(methodKey)) {
        // 订阅型 OAuth：粘贴官方 CLI 的凭据 JSON，由适配器解析并落库
        if (!adapter.importAuth) return fail(res, `${provider.name} 适配器未实现凭据导入`);
        let authInput = String(rest.token || "");
        // 只填了 refresh_token（在别处登录过、手上只有 RT）：先用适配器刷出 access_token 再解析。
        // 刷新函数需要 channel 形状：用 id=0 的临时对象，持久化写不到任何行（不会污染数据）。
        let credObj = null;
        try {
          credObj = JSON.parse(authInput);
        } catch {
          /* 不是 JSON：原样交给 importAuth 报错 */
        }
        if (credObj && typeof credObj === "object") {
          const at = String(credObj.access_token || credObj.accessToken || "").trim();
          const rt = String(credObj.refresh_token || credObj.refreshToken || "").trim();
          if (!at && rt && adapter.refreshAuth) {
            // 适配器只认 snake_case：先归一化，否则会「刷新失败 → 报缺少 access_token」误导管理员
            const normalized = { ...credObj, access_token: "", refresh_token: rt };
            let fresh;
            try {
              // 临时渠道 id 必须唯一：withRefreshLock 按 id 加锁，共用一个 id 会把不同账号的
              // 并发导入刷新合并成同一次请求（access_token 串号）。负数 id 落库时不命中任何行。
              const tempId = -Date.now() - Math.floor(Math.random() * 1000) - 1;
              fresh = await adapter.refreshAuth({ id: tempId, name: "import", type, other: normalized }, { force: true });
            } catch (e) {
              return fail(res, `刷新令牌失败：${e.message}`, 400);
            }
            if (!fresh?.access_token) return fail(res, "刷新令牌没有返回 access_token，请重新登录获取完整凭据", 400);
            // 刷新可能轮换 refresh_token：结果要覆盖旧的 camelCase 字段，
            // 否则 claude 之类「camelCase 优先」的解析器会拿旧值覆盖新 RT，下次刷新直接失效
            const merged = {
              ...normalized,
              ...fresh,
              access_token: fresh.access_token,
              refresh_token: fresh.refresh_token || rt,
            };
            delete merged.accessToken;
            delete merged.refreshToken;
            authInput = JSON.stringify(merged);
          }
        }
        const r = await adapter.importAuth({ ...rest, token: authInput, mode: "paste" });
        token = String(r.token || "").slice(0, 60_000);
        other = { method: methodKey, ...(r.other || {}) };
        accountLabel = r.accountLabel || null;
      } else if (mode === "password") {
        if (!adapter.loginWithPassword) return fail(res, `${provider.name} 未实现账号密码登录`);
        const account = String(rest.account || "").trim();
        if (!account) return fail(res, "请填写手机号或邮箱");
        if (!String(rest.password || "")) return fail(res, "请填写密码");
        const isEmail = account.includes("@");
        const r = await adapter.loginWithPassword({
          email: isEmail ? account : "",
          mobile: isEmail ? "" : account.replace(/[^\d]/g, ""),
          password: rest.password,
          areaCode: rest.areaCode || "+86",
          profileSeed: account,
          // 2FA 密钥：带两步验证的厂商（ChatGPT 网页版）靠它算动态码。
          // 它是密钥不是验证码 —— 验证码 30 秒一变，没法存下来复用。
          totpSecret: rest.totpSecret || "",
        });
        token = r.token;
        other = {
          // method 必须用**请求里的真实接入方式**，不能写死 "relay"。
          // 写死的后果：adapterKeyFor 解析出的适配器 key 变成厂商名（openai），
          // 而 openai 没有适配器 —— 渠道能建出来、凭据也存对了，
          // 但一测试就报「适配器未实现测试」，对话直接不可用。
          // （历史上前端只提交 relay，所以写死没暴露；现在有 openai-web-ui 这类
          //   挂在同一厂商下的多种接入方式，写死就会串。）
          method: methodKey,
          profile: r.profile || null,
          ...(r.cookies?.length ? { cookies: r.cookies } : {}),
          // 适配器返回的 other 必须一并保留：浏览器驱动型适配器把登录态
          // （cookies / device_id / 套餐 / 过期时间）放在这里，
          // 上面的硬编码只认 cookies，会把其余字段丢掉 ——
          // 丢掉 device_id 的后果是网页版把每次请求当成"换设备"，直接风控。
          ...(r.other || {}),
          account: isEmail ? account : `${account.slice(0, 3)}****${account.slice(-4)}`,
        };
        accountLabel = other.account;
      } else if (mode === "paste") {
        // **有 importAuth 就交给适配器** —— 它最懂自己的凭据形态。
        //
        // 为什么必须放在这里（用户实测的 MiMo 事故）：
        // 这条 relay 分支是按「裸 token（api_key）+ 可选 cookies 数组（other.cookies）」
        // 的旧契约写的，服务于 DeepSeek / Kimi / GLM / 豆包这类适配器。
        // 但新一批「具名反代」适配器（mimo-web / minimax-web / stepfun-web）
        // 的凭据形态是 `other.service_token / user_id / ph` 这类**具名字段**，
        // 由它们自己的 importAuth 解析（parseAuth 已兼容 cookies 数组与各种别名）。
        // 走旧契约的后果：整个 JSON 被当成裸 token 塞进 api_key，
        // other 里只有 method —— 适配器读 service_token 读到空 →
        // 永远 401「登录态已失效」，管理员反复重抓也修不好。
        // （实测：建完渠道后 other_keys 只有 ["method"]，api_key 是本该被解析的 JSON 串。）
        if (adapter.importAuth) {
          const r = await adapter.importAuth({ ...rest, token: String(rest.token || ""), mode: "paste" });
          token = String(r.token || "").slice(0, 60_000);
          other = { method: methodKey, ...(r.other || {}) };
          accountLabel = r.accountLabel || null;
        } else {
        const t = String(rest.token || "").trim().slice(0, 60_000);
        if (!t) return fail(res, "请填写登录态");
        if (adapter.verifyPastedToken) {
          const v = await adapter.verifyPastedToken({ token: t, cookies: rest.cookies });
          other = { method: "relay", ...(v.profile ? { profile: v.profile } : {}), ...(v.account ? { account: v.account } : {}) };
          accountLabel = v.account;
        }
        token = t;
        if (rest.cookies) {
          let list = [];
          if (Array.isArray(rest.cookies)) list = rest.cookies;
          else {
            const raw = String(rest.cookies).trim();
            try {
              const p = JSON.parse(raw);
              list = Array.isArray(p) ? p : [];
            } catch {
              // 兼容浏览器抓取回的 `name=value; name2=value2` 串（前端直接回填的就是这种）
              list = raw
                .split(";")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((pair) => {
                  const i = pair.indexOf("=");
                  return i > 0 ? { name: pair.slice(0, i), value: pair.slice(i + 1) } : null;
                })
                .filter(Boolean);
            }
            if (!list.length) {
              return fail(res, 'Cookies 需为 JSON 数组或 name=value; ... 串，例如 [{"name":"kimi-auth","value":"..."}]');
            }
          }
          if (list.length) other.cookies = list;
        }
        }
      } else if (mode === "browser") {
        // 浏览器登录：账号先落库，再由浏览器验证/建立会话
        if (!adapter.verify) return fail(res, `${provider.name} 适配器未实现浏览器登录`);
      } else {
        return fail(res, "不支持的登录方式");
      }
    } catch (e) {
      await writeLog({ req, user: req.user, type: LOG_TYPE.ERROR, content: `${provider.name} 登录失败：${e.message}` });
      return fail(res, e.message, 400);
    }

    // 写入或更新
    if (targetId) {
      const [exists] = await pool.query("SELECT id, other FROM channels WHERE id = ?", [targetId]);
      if (!exists.length) return fail(res, "渠道不存在", 404);
      const prevOther = parseOther(exists[0]);
      const merged = { ...prevOther, ...other };
      await pool.query(
        `UPDATE channels SET name = ?, api_key = ?, other = ?, last_error = '',
           models = COALESCE(?, models),
           group_name = COALESCE(?, group_name), group_list = COALESCE(?, group_list),
           weight = COALESCE(?, weight), auto_ban = COALESCE(?, auto_ban),
           priority = COALESCE(?, priority)
         WHERE id = ?`,
        [
          String(name || provider.name).slice(0, 64),
          token || "",
          JSON.stringify(merged),
          modelsInput !== undefined ? models : null,
          groupsInput !== undefined || group_name !== undefined ? groupsList[0] || "" : null,
          groupsInput !== undefined || group_name !== undefined ? JSON.stringify(groupsList) : null,
          weight !== undefined ? weightVal : null,
          auto_ban !== undefined ? autoBanVal : null,
          priorityProvided ? priorityVal : null,
          targetId,
        ]
      );
      resetChannelState(targetId);

      // 表单里已完成「浏览器登录」（onboarding）：把那份已登录 profile 复制给渠道，
      // 复制成功后清掉临时 profile（每会话独立，不复用）
      if (mode === "browser" && String(rest.profileFrom || "").startsWith("onboarding")) {
        const src = String(rest.profileFrom || "");
        if (!/^onboarding-[0-9a-f]{16}$/.test(src)) return fail(res, "浏览器登录态标识无效，请重新登录后再提交", 400);
        const copied = await copyProfile(type, src, String(targetId));
        if (!copied) return fail(res, "浏览器登录态已失效，请重新打开登录页登录后再提交", 400);
        PENDING_PROFILES.delete(src);
        await removeProfile(type, src).catch(() => {});
      }

      if (mode === "browser") {
        const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [targetId]);
        try {
          const ms = await adapter.verify(rowToChannel(fresh[0]));
          await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `浏览器登录 ${provider.name} 成功（${ms}ms）` });
        } catch (e) {
          await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), targetId]);
          return fail(res, `渠道已创建但未就绪：${e.message}。请在渠道列表点「浏览器登录」完成人工登录`, 400);
        }
      }
      await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `${provider.name} 渠道 #${targetId} 登录成功` });
      const all = await listRows();
      return ok(res, rowToResp(all.find((r) => r.id === targetId)), "登录成功");
    }

    // 订阅 OAuth：入池前做一次凭据健康检查（失败禁用而不是带着坏凭据参与调度）
    //
    // **但一键绑定路径必须跳过**：那条路此刻 `other` 里还没有凭据
    // （凭据在服务端 pendingCredentials，要等前端随后的 /devices/claim 写入）。
    // 不跳过就会「校验失败 → 接口返回 400」，而渠道**已经 INSERT 成功**，
    // 于是用户看到「渠道出现在表格里 + 点添加报错」，且前端因报错走不到 claim 那一步
    // —— 凭据永远写不进去，渠道永远不可用。实测踩到（WorkBuddy 绑定）。
    const pendingBind = Boolean(String(rest.bindTicket || "").trim());

    // 新建
    let insertId;
    if (mode === "browser") {
      // 列与值必须严格一一对应（name,type,base_url,models,group_name,groups,priority,weight,auto_ban,other,created_time）
      const [ret] = await pool.query(
        `INSERT INTO channels (name, type, base_url, api_key, models, group_name, group_list, status, priority, weight, auto_ban, other, created_time)
         VALUES (?,?,?, '', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [
          String(name || `${provider.name} 渠道`).slice(0, 64),
          type,
          mCfg.baseUrl || "",
          models,
          groupsList[0],
          JSON.stringify(groupsList),
          priorityVal,
          weightVal,
          autoBanVal,
          JSON.stringify(other),
          now(),
        ]
      );
      insertId = ret.insertId;
      invalidateChannelCache();
      if (mode === "browser" && String(rest.profileFrom || "").startsWith("onboarding")) {
        const src = String(rest.profileFrom || "");
        if (!/^onboarding-[0-9a-f]{16}$/.test(src)) {
          await pool.query("DELETE FROM channels WHERE id = ?", [insertId]).catch(() => {});
          return fail(res, "浏览器登录态标识无效，请重新登录后再提交", 400);
        }
        const copied = await copyProfile(type, src, String(insertId));
        if (!copied) {
          await pool.query("DELETE FROM channels WHERE id = ?", [insertId]).catch(() => {});
          return fail(res, "浏览器登录态已失效：请重新点「登录」完成登录后再提交", 400);
        }
        PENDING_PROFILES.delete(src);
        await removeProfile(type, src).catch(() => {});
      }
      const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [insertId]);
      try {
        const ms = await adapter.verify(rowToChannel(fresh[0]));
        await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `浏览器登录 ${provider.name} 成功（${ms}ms）` });
      } catch (e) {
        await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), insertId]);
        return fail(res, `渠道已创建但未就绪：${e.message}。请在渠道列表点「浏览器登录」完成人工登录`, 400);
      }
    } else {
      if (isOAuthMethod(methodKey)) {
        // OAuth 渠道按稳定账号标识去重：access_token 会轮换，不能拿它当唯一键，
        // 否则同一账号二次导入检不出重复，两条渠道共享 refresh_token 会互相刷废
        const [rows] = await pool.query("SELECT id, other FROM channels WHERE type = ?", [type]);
        const dup = rows.find((r) => isSameAccount(parseOther(r), other));
        if (dup) return fail(res, "该账号已存在（凭据重复）");
      } else {
        const [dup] = await pool.query("SELECT id FROM channels WHERE type = ? AND api_key = ? LIMIT 1", [type, token]);
        if (dup.length) return fail(res, "该账号已存在（登录态重复）");
      }
      const [ret] = await pool.query(
        // status：一键绑定路径先建为**禁用**（2），等 claim 写入凭据后再启用。
        // 否则会出现一段「渠道已在池中但没有任何凭据」的窗口期，
        // 被调度到就会连续失败，进而被自动禁用规则打上 last_error
        // （用户随后看到「渠道明明是刚绑定的却报错」）。
        `INSERT INTO channels (name, type, base_url, api_key, models, group_name, group_list, status, priority, weight, auto_ban, other, created_time)
         VALUES (?,?,?,?,?,?,?, ${pendingBind ? 2 : 1}, ?, ?, ?, ?, ?)`,
        [
          String(name || accountLabel || `${provider.name} 渠道`).slice(0, 64),
          type,
          mCfg.baseUrl || "",
          token,
          models,
          groupsList[0] || "",
          JSON.stringify(groupsList),
          priorityVal,
          weightVal,
          autoBanVal,
          JSON.stringify(other),
          now(),
        ]
      );
      insertId = ret.insertId;
      invalidateChannelCache();
    }

    if (isOAuthMethod(methodKey) && adapter.verify && !pendingBind) {
      try {
        const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [insertId]);
        const ms = await adapter.verify(rowToChannel(fresh[0]));
        await writeLog({
          req,
          user: req.user,
          type: LOG_TYPE.MANAGE,
          content: `订阅渠道 ${provider.name} 凭据校验通过（${ms}ms）`,
        });
      } catch (e) {
        await pool.query("UPDATE channels SET status = 2, last_error = ? WHERE id = ?", [
          String(e.message).slice(0, 480),
          insertId,
        ]);
        return fail(res, `渠道已创建但凭据校验失败（已禁用，可修复后手动启用）：${e.message}`, 400);
      }
    }

    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `新增 ${provider.name} 渠道「${name || ""}」` });
    const all = await listRows();
    return ok(res, rowToResp(all.find((r) => r.id === insertId)), "渠道已添加");
  })
);

// ---------- 批量登录（支持 batch 的反代厂商）----------
router.post(
  "/login/batch",
  asyncHandler(async (req, res) => {
    const { type, text, priority = 0 } = req.body || {};
    const provider = getProvider(type);
    if (!provider) return fail(res, "未知厂商");
    const mCfg = getMethod(type, "relay");
    if (!mCfg) return fail(res, `${provider.name} 不支持网页版反代`);
    const adapter = await adapterOf(type, "relay");
    if (!adapter?.loginWithPassword) return fail(res, `${provider.name} 未实现账号密码登录`);

    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return fail(res, "请粘贴账号列表，每行一个：账号----密码");
    if (lines.length > 50) return fail(res, "单次最多 50 个");

    // 留空 = 该厂商全部模型（与单条添加口径一致，避免批量建的号拿不到新模型）
    const models = "";
    const priorityVal = safeInt(priority, { min: 0, max: 1_000_000, fallback: 0 });
    const results = [];

    for (const line of lines) {
      const parts = line.split(/----|---|\||\t|,/).map((s) => s.trim());
      const account = parts[0];
      const password = parts[1] || "";
      if (!account || !password) {
        results.push({ account, ok: false, message: "格式错误，需为「账号----密码」" });
        continue;
      }
      const isEmail = account.includes("@");
      try {
        const r = await adapter.loginWithPassword({
          email: isEmail ? account : "",
          mobile: isEmail ? "" : account.replace(/[^\d]/g, ""),
          password,
          areaCode: "+86",
          profileSeed: account,
        });
        const other = {
          method: "relay",
          profile: r.profile || null,
          ...(r.cookies?.length ? { cookies: r.cookies } : {}),
          account: isEmail ? account : `${account.slice(0, 3)}****${account.slice(-4)}`,
        };
        const [dup] = await pool.query("SELECT id FROM channels WHERE type = ? AND api_key = ? LIMIT 1", [type, r.token]);
        if (dup.length) {
          results.push({ account, ok: false, message: "账号已存在" });
          continue;
        }
        await pool.query(
          `INSERT INTO channels (name, type, base_url, api_key, models, group_name, group_list, status, priority, weight, other, created_time)
           VALUES (?,?,?,?,?, 'default', '["default"]', 1, ?, 1, ?, ?)`,
          [account, type, mCfg.baseUrl || "", r.token, models, priorityVal, JSON.stringify(other), now()]
        );
        results.push({ account, ok: true });
      } catch (e) {
        results.push({ account, ok: false, message: e.message });
      }
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }

    const okCount = results.filter((r) => r.ok).length;
    if (okCount) invalidateChannelCache();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `批量导入 ${provider.name}：成功 ${okCount} / ${results.length}` });
    return ok(res, { results, ok: okCount, total: results.length }, `成功 ${okCount} 个，失败 ${results.length - okCount} 个`);
  })
);

// ---------- 新增（API 接入方式）----------
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const type = VALID_PROVIDERS.includes(b.type) ? b.type : "custom";
    const provider = getProvider(type);
    // 本接口只处理 API 方式；relay/订阅 OAuth 都必须走 /channel/login（有登录/校验流程）
    const methodInput = String(b.method || "api");
    if (methodInput !== "api") {
      return fail(
        res,
        isOAuthMethod(methodInput)
          ? `${provider.name} 的订阅接入请使用「粘贴凭据」方式创建（/api/channel/login）`
          : `${provider.name} 的网页版反代请使用账号登录方式添加`
      );
    }
    const method = "api";
    const mCfg = getMethod(type, "api");
    if (!mCfg) return fail(res, `${provider.name} 不支持官方 API 接入`);

    const name = String(b.name || "").trim();
    if (!name) return fail(res, "请填写渠道名称");
    const apiKey = String(b.api_key || "").trim();
    if (!apiKey) return fail(res, "请填写 API Key");
    const models = Array.isArray(b.models) ? b.models.join(",") : String(b.models || "");
    // 模型范围留空 = 该厂商全部已注册模型（与反代/订阅路径、与 router.parseModels
    // 的口径一致，见 services/router.js 的注释）。早先这里硬性要求至少一个模型，
    // 造成死锁：**新建渠道时拿不到模型清单**（fetch-models 需要先有渠道，
    // 而保存又要求有模型），管理员被卡在中间动不了 —— 实测反馈的原话是
    // 「输入 key 之后就应该能根据 key 获取模型啊」。
    // 真正的保护不在这一行，而在「模型必须有归属厂商」：空值走厂商全量，
    // 显式声明才收窄范围，两者都比「必须填一个」更贴近实际可用性。
    const baseUrl = String(b.base_url || mCfg.baseUrl || "").trim().slice(0, 255);
    if (b.base_url) {
      try {
        await assertSafeBaseUrl(baseUrl);
      } catch (e) {
        return fail(res, `接口地址不可用：${e.message}`);
      }
    }
    if (!baseUrl) return fail(res, "请填写接口地址（Base URL）");
    // 数值字段显式校验：Number("Infinity") || 0 仍是 Infinity，会拼出非法 SQL（500）
    const priority = safeInt(b.priority ?? 0, { min: 0, max: 1_000_000 });
    if (priority === null) return fail(res, "优先级无效");
    const weight = safeInt(b.weight ?? 0, { min: 0, max: 10_000 });
    if (weight === null) return fail(res, "权重无效");

    const other = { method: "api" };
    // 分组（可多选）：优先 groups 数组，否则沿用 group_name；空数组 = 公共池
    const groups = normalizeGroups(b.groups !== undefined ? b.groups : b.group_name);
    const [ret] = await pool.query(
      `INSERT INTO channels (name, type, base_url, api_key, models, group_name, group_list, status, priority, weight, remark, auto_ban, other, created_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name.slice(0, 64),
        type,
        baseUrl,
        apiKey.slice(0, 60_000),
        models.slice(0, 20_000),
        groups[0] || "",
        JSON.stringify(groups),
        Number(b.status) === 2 ? 2 : 1,
        priority,
        weight,
        String(b.remark || "").slice(0, 255),
        b.auto_ban === false ? 0 : 1,
        JSON.stringify(other),
        now(),
      ]
    );
    invalidateChannelCache();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `新增 ${provider.name} 渠道「${name}」（官方 API）` });
    const all = await listRows();
    return ok(res, rowToResp(all.find((r) => r.id === ret.insertId)), "渠道已创建");
  })
);

// ---------- 编辑 ----------
router.put(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const id = safeInt(b.id, { min: 1 });
    if (!id) return fail(res, "缺少渠道 id");
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    const cur = rows[0];
    if (!cur) return fail(res, "渠道不存在", 404);

    const fields = [];
    const args = [];
    const setIf = (col, val) => {
      if (val === undefined) return;
      fields.push(`${col} = ?`);
      args.push(val);
    };

    setIf("name", b.name !== undefined ? String(b.name).trim().slice(0, 64) : undefined);
    if (b.base_url !== undefined && String(b.base_url).trim()) {
      try {
        await assertSafeBaseUrl(String(b.base_url).trim());
      } catch (e) {
        return fail(res, `接口地址不可用：${e.message}`);
      }
    }
    setIf("base_url", b.base_url !== undefined ? String(b.base_url).trim().slice(0, 255) : undefined);
    if (b.api_key !== undefined && String(b.api_key).trim()) setIf("api_key", String(b.api_key).trim().slice(0, 60_000));
    if (b.models !== undefined) {
      const m = Array.isArray(b.models) ? b.models.join(",") : String(b.models);
      // 允许清空：反代/订阅渠道留空表示「该厂商全部模型」（模型归厂商不归账号）。
      // 但 API 兼容渠道必须显式声明（custom 端点没有厂商模型表，留空会无法调度）。
      const method = methodOf(cur);
      if (!m.trim() && method === "api") return fail(res, "该接入方式需要指定模型（请至少填写一个）");
      setIf("models", m.trim().slice(0, 20_000));
    }
    // 分组（可多选）：提交 groups 或 group_name 都接受；同步 group_name=第一个（兼容旧逻辑）
    if (b.groups !== undefined || b.group_name !== undefined) {
      const groups = normalizeGroups(b.groups !== undefined ? b.groups : b.group_name);
      setIf("group_list", JSON.stringify(groups));
      setIf("group_name", groups[0] || "");
    }
    if (b.status !== undefined) {
      const s = Number(b.status) === 2 ? 2 : 1;
      setIf("status", s);
      if (s === 1) resetChannelState(id);
    }
    if (b.priority !== undefined) {
      const p = safeInt(b.priority, { min: 0, max: 1_000_000 });
      if (p === null) return fail(res, "优先级无效");
      setIf("priority", p);
    }
    if (b.weight !== undefined) {
      const w = safeInt(b.weight, { min: 0, max: 10_000 });
      if (w === null) return fail(res, "权重无效");
      setIf("weight", w);
    }
    setIf("remark", b.remark !== undefined ? String(b.remark).slice(0, 255) : undefined);
    setIf("auto_ban", b.auto_ban !== undefined ? (b.auto_ban ? 1 : 0) : undefined);
    // 定时检测与检测提示词（编辑弹窗里挨着启用开关）
    if (b.auto_test !== undefined) setIf("auto_test", b.auto_test ? 1 : 0);
    if (b.auto_test_interval !== undefined) {
      const iv = safeInt(b.auto_test_interval, { min: 60, max: 86400 });
      if (iv === null) return fail(res, "检测间隔需在 60~86400 秒之间");
      setIf("auto_test_interval", iv);
    }
    if (b.test_prompt !== undefined) {
      const tp = String(b.test_prompt).trim().slice(0, 255);
      if (!tp) return fail(res, "检测提示词不能为空");
      setIf("test_prompt", tp);
    }
    if (b.test_model !== undefined) setIf("test_model", String(b.test_model).trim().slice(0, 128));

    // 账号级运行参数（存进 other，供 router/适配器读取）：
    //   并发 / 最小间隔 / 每分钟上限 —— 按账号实际额度配置，保护上游不被我们自己打爆；
    //   指纹模式 / 上下文计费 / namespace —— 反代与订阅渠道的兼容性开关。
    const otherPatch = {};
    if (b.concurrency !== undefined) {
      const n = safeInt(b.concurrency, { min: 0, max: 64 });
      if (n === null) return fail(res, "并发数需在 0~64 之间");
      otherPatch.concurrency = n || 1;
    }
    if (b.min_gap_ms !== undefined) {
      const n = safeInt(b.min_gap_ms, { min: 0, max: 600_000 });
      if (n === null) return fail(res, "最小间隔无效");
      otherPatch.min_gap_ms = n;
    }
    if (b.max_per_min !== undefined) {
      const n = safeInt(b.max_per_min, { min: 0, max: 100_000 });
      if (n === null) return fail(res, "每分钟上限无效");
      otherPatch.max_per_min = n || 20;
    }
    if (b.fingerprint_mode !== undefined) {
      const m = String(b.fingerprint_mode);
      if (!["stable", "converge", "random"].includes(m)) return fail(res, "指纹模式无效");
      otherPatch.fingerprint_mode = m;
    }
    if (b.context_billing !== undefined) {
      const m = String(b.context_billing);
      if (!["auto", "full", "input_only"].includes(m)) return fail(res, "上下文计费口径无效");
      otherPatch.context_billing = m;
    }
    if (b.namespace !== undefined) otherPatch.namespace = String(b.namespace).trim().slice(0, 64);
    // 检测超时预算（秒 → 存毫秒）：给「响应本来就慢」的模型单独放宽。
    // 用户实测反馈：「如果这个渠道这个厂商本身响应就很慢的话则可以根据具体的模型
    // 进行这个响应时间的配置，有的模型好像响应时间就是很慢」—— 实测确实如此，
    // gpt-5.6 / glm-5.3 这类大档位光思考就可能几分钟，统一 90s 预算下每次都报超时。
    // 上限 30 分钟（channel-probe.probeBudgetMs 里同样有钳制）。
    if (b.probe_timeout_sec !== undefined) {
      const n = safeInt(b.probe_timeout_sec, { min: 0, max: 1800 });
      if (n === null) return fail(res, "检测超时需在 0~1800 秒之间（0 = 用默认值）");
      otherPatch.probe_timeout_ms = n * 1000; // 0 表示回落默认
    }
    if (Object.keys(otherPatch).length) {
      // 与其它写 other 的路径一致：先解析当前 other 再合并，不整列覆盖
      const [cur2] = await pool.query("SELECT other FROM channels WHERE id = ?", [id]);
      let o = {};
      try {
        o = cur2[0]?.other ? JSON.parse(cur2[0].other) : {};
      } catch {
        o = {};
      }
      setIf("other", JSON.stringify({ ...o, ...otherPatch }));
    }

    if (!fields.length) return fail(res, "没有需要更新的字段");
    args.push(id);
    await pool.query(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`, args);
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `编辑渠道「${cur.name}」` });
    const all = await listRows();
    return ok(res, rowToResp(all.find((r) => r.id === id)), "已更新");
  })
);

// ---------- 测试 ----------
router.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    const row = rows[0];
    const providerName = getProvider(row.type)?.name || row.type;
    const method = methodOf(row);
    const channel = rowToChannel(row);
    const adapter = await adapterOf(row.type, method);
    const startedAt = Date.now();
    const prompt = String(row.test_prompt || "hi").trim() || "hi";

    try {
      if (!adapter?.verify && !adapter?.probe && !adapter?.chat) return fail(res, `${providerName} 适配器未实现测试`);
      // 通用探针：真实发送检测提示词（默认 hi），API / 反代 / 订阅渠道都适用
      const probe = await probeChannel(adapter, channel, prompt);
      // 只写运行指标，绝不写 status：status 是管理员开关，
      // 测试成功不能把管理员手动禁用的渠道复活（与 markChannelOk 约定一致）
      //
      // 同时落 ttft_ms：**慢渠道判定与前端展示都用首 Token 耗时**（用户实测反馈）。
      // 总耗时把「思考 + 生成全文」都算进去，思考型模型（GLM / o 系列）与长回答
      // 会被判成坏渠道；用户体感是「多久开始出字」。两个数都存，各司其职。
      await pool.query("UPDATE channels SET response_time = ?, ttft_ms = ?, tested_time = ?, last_error = '' WHERE id = ?", [
        probe.ms,
        probe.ttftMs || probe.ms,
        now(),
        id,
      ]);
      // 小竖条用 ttft 着色：它表达的是「这次调用快不快」，与上面的口径保持一致
      await recordChannelCall(id, true, probe.ttftMs || probe.ms, "", {
        prompt,
        reply: probe.reply,
        degraded: probe.degraded,
        state: probe.state,
        kind: "test",
      });
      resetChannelState(id);
      await writeLog({
        req,
        user: req.user,
        type: LOG_TYPE.MANAGE,
        content: `测试渠道「${row.name}」通过（首Token ${probe.ttftMs || probe.ms}ms / 总 ${probe.ms}ms）`,
      });
      return ok(
        res,
        { success: true, time: probe.ttftMs || probe.ms, total: probe.ms, ttft: probe.ttftMs || probe.ms, reply: probe.reply, prompt },
        `渠道可用（首Token ${probe.ttftMs || probe.ms}ms / 总 ${probe.ms}ms）`
      );
    } catch (e) {
      // 手动测试失败：记错误 + 决定要不要**自动暂停**。
      // 用户要求「手动检测出错了则自动暂停」，但同样按错误性质区分：
      //   · 凭据失效/被封/配置错 → 停用（status=3，人工处理）；
      //   · 上游 429 限流 → 也停用，但带 `rate_limit_until`，到点自动恢复
      //     （用户要求「如果哪个渠道报错 429，直接停止渠道状态」）；
      //   · 网络/超时 → 只记错误（一次抖动不该把好渠道停掉）。
      const ec = String(e.code || "");
      const fatal = AUTO_PAUSE_CODES.has(ec);
      const rateLimited = isRateLimitedCode(ec);
      const pause = (fatal || rateLimited) && row.auto_ban !== 0 && Number(row.status) === 1;
      // 限流时长与 markChannelError 共用 rateLimitPauseSec（同一口径，不会漂移）
      const until = rateLimited ? now() + rateLimitPauseSec(e.cooldownSec) : 0;
      // 429 不计入「最近调用」：那条环形记录回答的是「渠道干活干得怎么样」，
      // 而被限流挡回的请求根本没被处理（与 router.markChannelError 同一口径）。
      if (pause) {
        await pool.query(
          "UPDATE channels SET last_error = ?, last_error_code = ?, status = 3, rate_limit_until = ? WHERE id = ? AND status = 1",
          [String(e.message).slice(0, 480), ec, rateLimited ? until : 0, id]
        );
      } else {
        await pool.query("UPDATE channels SET last_error = ?, last_error_code = ? WHERE id = ?", [
          String(e.message).slice(0, 480),
          ec,
          id,
        ]);
      }
      // 测试失败计入「最近调用」小绿条（失败 → 红色；tip 里带失败原因）。
      // 429 例外：见上方注释。
      if (!rateLimited) {
        await recordChannelCall(id, false, Date.now() - startedAt, e.message, { prompt, reply: e.message, kind: "test" });
      }
      await writeLog({ req, user: req.user, type: LOG_TYPE.ERROR, content: `测试渠道「${row.name}」失败：${e.message}` });
      // 内存态：resetChannelState 会清掉冷却与限流标记，限流那条要在之后补回来
      if (pause) resetChannelState(id);
      if (rateLimited && pause) setChannelRateLimit(id, until);
      return ok(
        res,
        { success: false, message: e.message, code: e.code, autoPaused: pause, rateLimitUntil: until },
        rateLimited && pause
          ? `测试失败，渠道已因限流停用：${e.message}`
          : pause
            ? `测试失败，渠道已自动暂停：${e.message}`
            : `测试失败：${e.message}`
      );
    }
  })
);

// ---------- 拉取上游模型（API 接入方式）----------
router.post(
  "/fetch-models",
  asyncHandler(async (req, res) => {
    const { base_url, api_key, id, type } = req.body || {};
    // 订阅 OAuth 渠道有各自的模型接口（如 Antigravity fetchAvailableModels），优先走适配器
    if (id) {
      const cid = safeInt(id, { min: 1 });
      if (!cid) return fail(res, "渠道 id 无效");
      const [crows] = await pool.query("SELECT * FROM channels WHERE id = ?", [cid]);
      if (crows.length && isOAuthMethod(methodOf(crows[0]))) {
        const method = methodOf(crows[0]);
        const adapter = await adapterOf(crows[0].type, method);
        if (adapter?.fetchUpstreamModels) {
          try {
            return ok(res, await adapter.fetchUpstreamModels(rowToChannel(crows[0])));
          } catch (e) {
            return fail(res, e.message);
          }
        }
        // 没有模型接口的订阅方式：返回该接入方式的默认模型列表（不要拿 OAuth token 去撞 API 端点）
        const mCfg = getMethod(crows[0].type, method);
        return ok(res, (mCfg?.defaultModels || []).map((m) => m.id));
      }
    }
    let key = String(api_key || "").trim();
    let base = String(base_url || "").trim();
    // 只补「请求里缺失的部分」：同时传 id+key 但没传 base_url 时，
    // 之前会落到厂商默认地址，可能把该渠道的 Key 发给错误的上游
    if (id && (!key || !base)) {
      const cid = safeInt(id, { min: 1 });
      if (!cid) return fail(res, "渠道 id 无效");
      const [rows] = await pool.query("SELECT api_key, base_url FROM channels WHERE id = ?", [cid]);
      if (rows.length) {
        if (!key) key = splitKeys(rows[0].api_key)[0] || "";
        if (!base) base = rows[0].base_url || "";
      }
    }
    if (!key) return fail(res, "请先填写 API Key");
    if (!base) base = getMethod(type, "api")?.baseUrl || "";
    // 管理员可填任意地址，这里必须做 SSRF 校验，避免借「拉取模型」探测内网/云元数据
    try {
      await assertPublicUrl(base);
    } catch (e) {
      return fail(res, `接口地址不可用：${e.message}`);
    }
    const mod = await import("../services/upstream/openai-compat.js");
    try {
      const list = await mod.fetchUpstreamModels({ base_url: base, api_key: key });
      const models = [...new Set(Array.isArray(list) ? list : [])].sort();
      // **必须带上 clineGroups**（与 /:id/upstream-models 同一个形状）。
      //
      // 这里踩过一个让新管理员直接踩坑的缺陷（黑盒测试实测）：添加渠道时前端走的是
      // 本接口，而它原先 `return ok(res, list)` —— **一个裸数组**，没有 clineGroups；
      // 而编辑渠道走 /:id/upstream-models，那边是带 clineGroups 的对象。
      // 前端 ModelPicker 靠 `r.clineGroups` 判断「这是目录型渠道，别自动全选」
      // （见该组件的注释：454 个模型全选会把旗舰档也放开）。
      // 结果：**编辑路径有保护、添加路径没有** —— 新建 Cline 渠道点了「从上游获取模型」
      // 就 toast「已成功自动填入 455 个模型」，连 $600/M 的 o1-pro 一起放开，
      // 同时把定价页的「在用模型」从 30 个冲到 485 个。
      // 现在两条路径返回同一形状，前端那层保护才真正生效。
      const groups = clineGroupsFor(type, models);
      // 兼容旧前端：同时给出一个数组形状的 models 字段（老版本直接当数组用）
      return ok(res, {
        models,
        source: "upstream",
        ...(groups ? { clineGroups: groups } : {}),
      });
    } catch (e) {
      return fail(res, e.message);
    }
  })
);

// ---------- 删除 ----------
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT name, type, other FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);

    // 反代渠道：关闭浏览器会话并清掉 profile 目录（避免残留占磁盘）
    const method = methodOf(rows[0]);
    const adapter = await adapterOf(rows[0].type, method);
    if (adapter?.release) await adapter.release(id).catch(() => {});
    if (getMethod(rows[0].type, "relay")?.needsBrowser) await removeProfile(rows[0].type, id).catch(() => {});

    await pool.query("DELETE FROM channels WHERE id = ?", [id]);
    forgetChannel(id);
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `删除渠道「${rows[0].name}」` });
    return ok(res, null, "渠道已删除");
  })
);

// ---------- 批量操作 ----------
router.post(
  "/batch",
  asyncHandler(async (req, res) => {
    const { ids, action, payload } = req.body || {};
    // 显式整数校验：Infinity/NaN 会被 mysql2 原样拼进 IN 列表导致 500
    const list = [...new Set((Array.isArray(ids) ? ids : []).map((v) => safeInt(v, { min: 1 })).filter(Boolean))];
    if (!list.length) return fail(res, "请先选择渠道");
    if (list.length > 500) return fail(res, "单次最多操作 500 个渠道");
    const ph = list.map(() => "?").join(",");

    if (action === "enable") {
      await pool.query(`UPDATE channels SET status = 1, last_error = '' WHERE id IN (${ph})`, list);
      list.forEach((id) => resetChannelState(id));
    } else if (action === "disable") {
      await pool.query(`UPDATE channels SET status = 2 WHERE id IN (${ph})`, list);
    } else if (action === "delete") {
      for (const id of list) {
        const [r] = await pool.query("SELECT type, other FROM channels WHERE id = ?", [id]);
        if (r.length) {
          const ad = await adapterOf(r[0].type, "relay");
          if (ad?.release) await ad.release(id).catch(() => {});
          if (getMethod(r[0].type, "relay")?.needsBrowser) await removeProfile(r[0].type, id).catch(() => {});
        }
      }
      await pool.query(`DELETE FROM channels WHERE id IN (${ph})`, list);
      list.forEach((id) => forgetChannel(id));
    } else if (action === "set_priority") {
      const p = safeInt(payload?.priority, { min: 0, max: 1_000_000 });
      if (p === null) return fail(res, "优先级无效");
      await pool.query(`UPDATE channels SET priority = ? WHERE id IN (${ph})`, [p, ...list]);
    } else if (action === "set_group") {
      // 批量设置分组：只接受管理员创建的分组名；default/空 = 移出所有分组（公共池）
      const raw = String(payload?.group_name || "").trim();
      const single = normalizeGroups(raw ? [raw] : []);
      await pool.query(`UPDATE channels SET group_name = ?, group_list = ? WHERE id IN (${ph})`, [
        single[0] || "",
        JSON.stringify(single),
        ...list,
      ]);
    } else if (action === "add_models") {
      const add = (Array.isArray(payload?.models) ? payload.models : String(payload?.models || "").split(","))
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 500);
      if (!add.length) return fail(res, "请提供要添加的模型");
      const [rows] = await pool.query(`SELECT id, models FROM channels WHERE id IN (${ph})`, list);
      for (const r of rows) {
        const cur = String(r.models || "").split(",").map((s) => s.trim()).filter(Boolean);
        const merged = [...new Set([...cur, ...add])];
        await pool.query("UPDATE channels SET models = ? WHERE id = ?", [merged.join(",").slice(0, 20_000), r.id]);
      }
    } else {
      return fail(res, "不支持的操作");
    }

    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `批量操作渠道 ${list.join(",")}：${action}` });
    return ok(res, null, "操作成功");
  })
);

// ---------- 批量导入凭据（兼容 CPA / sub2api 导出文件）----------
router.post(
  "/import",
  asyncHandler(async (req, res) => {
    const text = String(req.body?.text || "");
    if (!text.trim()) return fail(res, "请粘贴要导入的文件内容");
    if (text.length > 2_000_000) return fail(res, "文件过大（上限 2MB）");
    const { accounts, errors } = await parseCredentialFile(text);
    if (!accounts.length && !errors.length) return fail(res, "没有可导入的账号");

    // 去重：OAuth 用稳定账号指纹（account_id/email/sub/project_id），API Key 用 key。
    // 按 type 缓存现有渠道，避免每个账号都查一次库。
    const existingByType = new Map();
    const loadExisting = async (type) => {
      if (!existingByType.has(type)) {
        const [rows] = await pool.query("SELECT id, api_key, other FROM channels WHERE type = ?", [type]);
        existingByType.set(type, rows);
      }
      return existingByType.get(type);
    };

    const results = [];
    let created = 0;
    let skipped = 0;
    for (const a of accounts) {
      try {
        const mCfg = getMethod(a.type, a.method) || {};
        const oauth = isOAuthMethod(a.method);
        const rows = await loadExisting(a.type);
        const dup = rows.find((r) => (oauth && isSameAccount(parseOther(r), a.other)) || r.api_key === a.token);
        if (dup) {
          skipped++;
          results.push({ name: a.name, ok: false, skipped: true, reason: "账号已存在（跳过）" });
          continue;
        }
        const baseUrl = String(a.base_url || mCfg.baseUrl || "").slice(0, 255);
        if (a.base_url) {
          try {
            await assertSafeBaseUrl(baseUrl);
          } catch (e) {
            results.push({ name: a.name, ok: false, reason: `接口地址不可用：${e.message}` });
            continue;
          }
        }
          const [ret] = await pool.query(
            `INSERT INTO channels (name, type, base_url, api_key, models, group_name, group_list, status, priority, weight, auto_ban, other, created_time)
             VALUES (?,?,?,?,?, '', '[]', 1, ?, 1, 1, ?, ?)`,
          [
            String(a.name || `${a.type} 渠道`).slice(0, 64),
            a.type,
            baseUrl,
            a.token,
            // 留空 = 该厂商全部模型（与单条添加口径一致）
            "",
            Number(a.priority) || 0,
            JSON.stringify(a.other),
            now(),
          ]
        );
        rows.push({ id: ret.insertId, api_key: a.token, other: JSON.stringify(a.other) });
        created++;
        results.push({ name: a.name, ok: true, id: ret.insertId, type: a.type, method: a.method });
      } catch (e) {
        results.push({ name: a.name, ok: false, reason: e.message });
      }
    }
    if (created) invalidateChannelCache();
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `批量导入凭据：成功 ${created} / 跳过 ${skipped} / 解析失败 ${errors.length}`,
    });
    return ok(
      res,
      { created, skipped, results, parseErrors: errors },
      `导入完成：成功 ${created}，跳过 ${skipped}，失败 ${results.length - created - skipped + errors.length}`
    );
  })
);

// ---------- 一键绑定（设备授权）----------
// ---------------------------------------------------------------------------
// 为什么要有它：Kiro / WorkBuddy / Qoder 原先只能「手工粘贴凭据」——
// 用户得自己找到桌面端登录文件、从里面挑出 token 字段。对多数用户不可完成。
// 设备授权（device authorization）能把这段变成：服务端发起 → 用户看到
// 「用户码 + 链接」→ 在浏览器确认一次 → 服务端轮询到凭据自动入库。
//
// 三种绑定场景共用一套流程，差异只在「绑到哪」：
//   · 已有渠道 → 刷新凭据（管理员在渠道列表点「重新绑定」）
//   · 新建渠道 → 先建渠道再绑（前端走 /devices/start?channel_id= 之后回调）
// 所以接口设计成：start 记下目标渠道（可空），成功后由前端调 /devices/apply。
router.get(
  "/devices/vendors",
  adminRequired,
  asyncHandler(async (req, res) =>
      // 同时下发两套键：methods = 方法键（前端按它匹配「一键绑定」按钮，权威），
      // vendors = 厂商键（旧前端与 /devices/start 的历史口径，保留兼容）
      ok(res, { vendors: deviceBindVendors(), methods: deviceBindMethodKeys() }))
);

router.post(
  "/devices/start",
  adminRequired,
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "device-bind", keyFn: (r) => r.user?.id || r.ip }),
  asyncHandler(async (req, res) => {
    // 前端传的可能是**方法键**（cli）也可能是**厂商键**（cline）—— 两套命名都接受。
    // 曾经只认厂商键，而前端传的是 pickMethod.key（Cline 就是 "cli"），
    // 于是点「一键绑定」报「该渠道不支持一键绑定：cli」（黑盒测试实测）。
    const rawVendor = String(req.body?.vendor || "").trim();
    const vendor = vendorOfMethod(rawVendor);
    if (!vendor || !supportsDeviceBind(vendor)) return fail(res, `该渠道不支持一键绑定：${rawVendor}`);
    try {
      const out = await startDeviceBind(vendor, {
        startUrl: req.body?.start_url,
        regionHint: req.body?.region,
        realm: req.body?.realm,
      });
      await writeLog({
        req,
        user: req.user,
        type: LOG_TYPE.MANAGE,
        content: `发起 ${vendor} 设备授权绑定（会话 ${out.sessionId.slice(0, 8)}）`,
      });
      return ok(res, out, "已生成授权信息，请在浏览器中确认");
    } catch (e) {
      return fail(res, e.message, 400);
    }
  })
);

router.post(
  "/devices/poll",
  adminRequired,
  asyncHandler(async (req, res) => {
    const sessionId = String(req.body?.session_id || "");
    if (!sessionId) return fail(res, "缺少会话标识");
    try {
      const out = await pollDeviceBind(sessionId);
      // 凭据**不直接返回给前端**：先落库再回状态，避免 token 经过浏览器/日志
      if (out.status === "success" && out.credential) {
        // vendor 取服务端会话记录的归属厂商（pollDeviceBind 回传），
        // 不用请求体的值 —— 后者是前端传的，用来校验等于自证。
        const vendor = String(out.vendor || "");
        const channelId = Number(req.body?.channel_id) || 0;
        if (!channelId) {
          // 前端还没建渠道：把凭据暂存在服务端（会话已删，这里用一次性凭据表）。
          // ticket 里带上 vendor，claim 时用它校验目标渠道的厂商。
          const ticket = randomBytes(16).toString("hex");
          pendingCredentials.set(ticket, { credential: out.credential, vendor, at: Date.now() });
          return ok(res, { status: "success", ticket, vendor }, "授权成功");
        }
        const [[ch]] = await pool.query("SELECT id, type FROM channels WHERE id = ?", [channelId]);
        if (!ch) return fail(res, "目标渠道不存在", 404);
        assertBindVendorFits(ch.type, vendor);
        const r = await applyCredentialToChannel({ id: channelId, type: ch.type, credential: out.credential, vendor });
        await writeLog({
          req,
          user: req.user,
          type: LOG_TYPE.MANAGE,
          content: `设备授权绑定成功，已写入渠道 #${channelId}${r.accountLabel ? `（${r.accountLabel}）` : ""}${
            r.autoModels ? `，自动填入 ${r.autoModels} 个模型` : ""
          }`,
        });
        return ok(
          res,
          { status: "success", channel_id: channelId, account: r.accountLabel, autoModels: r.autoModels || 0 },
          "绑定成功，凭据已写入"
        );
      }
      return ok(res, {
        status: out.status,
        message: out.message || "",
        slowDown: Boolean(out.slowDown),
        vendor: out.vendor || "",
      });
    } catch (e) {
      // 轮询失败不该让前端无限等：明确告诉它这次出错，前端会重试或提示
      return fail(res, e.message, 502);
    }
  })
);

router.post(
  "/devices/cancel",
  adminRequired,
  asyncHandler(async (req, res) => {
    const okFlag = cancelDeviceBind(String(req.body?.session_id || ""));
    return ok(res, { cancelled: okFlag });
  })
);

// 取出暂存的凭据（前端建完渠道后再调，凭据只经服务端内部传递）
router.post(
  "/devices/claim",
  adminRequired,
  asyncHandler(async (req, res) => {
    const ticket = String(req.body?.ticket || "");
    const rec = pendingCredentials.get(ticket);
    if (!rec) return fail(res, "凭据已过期或不存在，请重新绑定", 410);
    pendingCredentials.delete(ticket); // 一次性
    const channelId = Number(req.body?.channel_id) || 0;
    if (!channelId) return fail(res, "缺少目标渠道");
    const [[ch]] = await pool.query("SELECT id, type FROM channels WHERE id = ?", [channelId]);
    if (!ch) return fail(res, "目标渠道不存在", 404);
    // 跨厂商防护：ticket 里记的是发起绑定时的厂商，必须与目标渠道类型一致。
    // 放在写库之前，避免「拿 Kiro 的授权结果去覆盖 WorkBuddy 渠道」。
    try {
      assertBindVendorFits(ch.type, rec.vendor);
    } catch (e) {
      return fail(res, e.message, 400);
    }
    let r;
    try {
      r = await applyCredentialToChannel({ id: channelId, type: ch.type, credential: rec.credential, vendor: rec.vendor });
    } catch (e) {
      // 写回失败时**删掉刚建的空渠道**，否则留下一条永远没凭据、永远不可用的记录
      // （用户会以为绑定成功了，因为它在表格里）。仅当该渠道确实是「等绑定」建出来的
      // （status=2 且无凭据）才删，避免误删已有渠道。
      const [[cur]] = await pool.query("SELECT status, api_key, other FROM channels WHERE id = ?", [channelId]);
      const curOther = cur?.other ? JSON.parse(cur.other) : {};
      const looksUnbound = Number(cur?.status) === 2 && !curOther?.access_token;
      if (looksUnbound) {
        await pool.query("DELETE FROM channels WHERE id = ?", [channelId]).catch(() => {});
        invalidateChannelCache();
        return fail(res, `绑定失败，已撤销该渠道：${e.message}。请重新发起一键绑定`, 400);
      }
      return fail(res, `凭据写入失败：${e.message}`, 400);
    }
    // 凭据就位后启用渠道：它是以 status=2（禁用）建出来的，等这一步才入池
    await pool.query("UPDATE channels SET status = 1, last_error = '' WHERE id = ?", [channelId]);
    resetChannelState(channelId);
    invalidateChannelCache();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `设备授权凭据已写入新建渠道 #${channelId} 并启用` });
    return ok(res, { channel_id: channelId, account: r.accountLabel }, "绑定成功");
  })
);

// ---------- 分组列表（供筛选）----------
// 注意：管理员分组列表在文件前部的 GET /channel/groups（channel_groups 表）；
// 这里不再返回 group_name 去重列表，避免与前者同名路由互相遮蔽。

export default router;
