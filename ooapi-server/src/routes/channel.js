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
import { getProvider, getMethod, providerKeys, publicProviders, isOAuthMethod } from "../services/channel-types.js";
import { buildLoginUrl, exchangeCodeForCredential, interactiveLoginInfo, supportsInteractiveLogin, supportsInteractiveLoginMethod, supportsDeviceLogin, startDeviceLogin, pollDeviceLogin } from "../services/upstream/oauth-login.js";
import { getAdapter, resetChannelState, forgetChannel, invalidateChannelCache, channelRuntimeState, channelRecent, rowToChannel, recordChannelCall } from "../services/router.js";
import { clearGroupConfigCache } from "../services/group-rate.js";
import {
  isReady as browserReady,
  removeProfile,
  copyProfile,
  screenshot as browserShot,
  currentUrl as browserUrl,
  getSession as browserSession,
  act as browserAct,
  credentials as browserCreds,
  apiFetch as browserApiFetch,
  closeSession as browserClose,
} from "../services/upstream/browser-driver.js";
import { invalidateModelRegistry } from "../services/models.js";
import { parseCredentialFile } from "../services/upstream/auth-import.js";
import { probeChannel } from "../services/channel-probe.js";
import { fetchQuota, quotaSupportFor, clampQuotaPayload } from "../services/upstream/quota.js";
import { randomBytes } from "node:crypto";

const router = Router();
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

/** 分组列表行 → 前端结构 */
function groupResp(g, memberMap) {
  const ids = memberMap.get(`${g.type}:${g.name}`) || [];
  return {
    id: g.id,
    type: g.type,
    name: g.name,
    typeName: getProvider(g.type)?.name || g.type,
    remark: g.remark || "",
    rate: Number(g.rate) || 1,
    models: parseGroupModels(g.models),
    channel_ids: ids,
    count: ids.length,
  };
}

async function groupMemberMap() {
  const [chans] = await pool.query("SELECT id, type, group_list, group_name FROM channels");
  const memberMap = new Map();
  for (const c of chans) {
    for (const g of parseGroups(c)) {
      const key = `${c.type}:${g}`;
      if (!memberMap.has(key)) memberMap.set(key, []);
      memberMap.get(key).push(Number(c.id));
    }
  }
  return memberMap;
}

/** 双向同步「分组包含哪些账号」：勾选的渠道加入分组，未勾选的从分组移除 */
async function syncGroupMembers(type, name, channelIds) {
  const want = new Set(
    (Array.isArray(channelIds) ? channelIds : []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
  );
  const [chans] = await pool.query("SELECT id, group_list, group_name FROM channels WHERE type = ?", [type]);
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
    const [rows] = await pool.query("SELECT * FROM channel_groups ORDER BY type, name");
    const memberMap = await groupMemberMap();
    return ok(res, rows.map((g) => groupResp(g, memberMap)));
  })
);

// ---------- 新建分组（管理员选择包含哪些账号 + 支持哪些模型 + 倍率）----------
router.post(
  "/groups",
  asyncHandler(async (req, res) => {
    const { type, name, remark, rate, models, channel_ids } = req.body || {};
    const provider = getProvider(type);
    if (!provider) return fail(res, "未知厂商");
    const gname = String(name || "").trim().slice(0, 32);
    if (!gname) return fail(res, "请填写分组名");
    const [exist] = await pool.query("SELECT id FROM channel_groups WHERE type = ? AND name = ?", [type, gname]);
    if (exist.length) return fail(res, "该厂商下已存在同名分组");
    await pool.query(
      "INSERT INTO channel_groups (type, name, remark, rate, models, created_time) VALUES (?,?,?,?,?,?)",
      [type, gname, String(remark || "").slice(0, 255), normalizeRate(rate), JSON.stringify(normalizeModels(models)), now()]
    );
    await syncGroupMembers(type, gname, channel_ids);
    clearGroupConfigCache();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `新建分组「${provider.name} / ${gname}」` });
    const memberMap = await groupMemberMap();
    const [created] = await pool.query("SELECT * FROM channel_groups WHERE type = ? AND name = ?", [type, gname]);
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
    const { name, remark, rate, models, channel_ids } = req.body || {};
    const gname = name === undefined ? group.name : String(name || "").trim().slice(0, 32);
    if (!gname) return fail(res, "请填写分组名");
    if (gname !== group.name) {
      const [dup] = await pool.query("SELECT id FROM channel_groups WHERE type = ? AND name = ? AND id != ?", [
        group.type,
        gname,
        gid,
      ]);
      if (dup.length) return fail(res, "该厂商下已存在同名分组");
      // 改名传播：渠道 group_list 与已绑定 Key 都跟着换，避免改名后绑定失效
      const [chans] = await pool.query("SELECT id, group_list, group_name FROM channels WHERE type = ?", [group.type]);
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
        .query("UPDATE tokens SET group_name = ? WHERE group_name = ?", [
          `${group.type}:${gname}`,
          `${group.type}:${group.name}`,
        ])
        .catch(() => {});
    }
    await pool.query("UPDATE channel_groups SET name = ?, remark = ?, rate = ?, models = ? WHERE id = ?", [
      gname,
      remark === undefined ? group.remark || "" : String(remark || "").slice(0, 255),
      rate === undefined ? group.rate : normalizeRate(rate),
      models === undefined ? group.models : JSON.stringify(normalizeModels(models)),
      gid,
    ]);
    if (channel_ids !== undefined) await syncGroupMembers(group.type, gname, channel_ids);
    clearGroupConfigCache();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `编辑分组「${group.type} / ${gname}」` });
    const memberMap = await groupMemberMap();
    const [updated] = await pool.query("SELECT * FROM channel_groups WHERE id = ?", [gid]);
    return ok(res, updated.length ? groupResp(updated[0], memberMap) : null, "分组已更新");
  })
);

// ---------- 删除分组（同时从该厂商渠道的 groups 里摘掉、解绑 Key）----------
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
      const [chans] = await conn.query("SELECT id, group_list, group_name FROM channels WHERE type = ?", [group.type]);
      for (const c of chans) {
        const next = parseGroups(c).filter((g) => g !== group.name);
        await conn.query("UPDATE channels SET group_list = ?, group_name = ? WHERE id = ?", [
          JSON.stringify(next),
          next[0] || "",
          c.id,
        ]);
      }
      // 解绑 Key：置空后回落到公共池，而不是留下永远 503 的死绑定
      const [un] = await conn.query("UPDATE tokens SET group_name = '' WHERE group_name = ?", [
        `${group.type}:${group.name}`,
      ]);
      unbound = un.affectedRows || 0;
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
      content: `删除分组「${group.type} / ${group.name}」（解绑 ${unbound} 个密钥）`,
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
  // 接入方式：relay（反代）/ api（官方 Key）/ 订阅 OAuth（codex、claude-oauth、antigravity）
  return m === "api" || isOAuthMethod(m) ? m : "relay";
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
  const isApi = method === "api";

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
    canRecover: method !== "api",
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
    status_label: r.status === 2 ? "已禁用" : cooling ? "冷却中" : r.status === 1 ? "已启用" : "自动禁用",
    auto_ban: r.auto_ban === 0 ? false : true,
      cooling,
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
    // 账号额度快照（订阅/网页版账号）：只在管理员查过之后才有值
    quota: safeJson(r.quota),
    quota_time: Number(r.quota_time) || 0,
    quota_supported: quotaSupportFor({ type: r.type, method, base_url: r.base_url }).supported,
    // 统计
    used_count: Number(r.used_count) || 0,
    last_used_time: Number(r.last_used_time) || 0,
    response_time: Number(r.response_time) || 0,
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
  if (!method) return rows;
  // 接入方式存在 other JSON 里，SQL 层不好过滤，取回后再筛
  return rows.filter((r) => methodOf(r) === method);
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
async function applyCredentialToChannel({ id, type, method, credential }) {
  const [rows] = await pool.query("SELECT id, type, api_key, other FROM channels WHERE id = ?", [id]);
  if (!rows.length) throw Object.assign(new Error("渠道不存在"), { code: "LOGIN_BAD_PARAMS" });
  const methodKey = method || methodOf(rows[0]);
  const adapter = await adapterOf(type || rows[0].type, methodKey);
  if (!adapter) throw Object.assign(new Error("该接入方式不支持凭据写回"), { code: "LOGIN_BAD_PARAMS" });
  const raw = typeof credential === "string" ? credential : JSON.stringify(credential || {});
  // 上限兜底：HTTP 层允许 1MB，凭据不该有这么大的；顺带防住畸形输入
  if (raw.length > 200_000) throw Object.assign(new Error("凭据内容过大"), { code: "LOGIN_BAD_PARAMS" });

  let parsed;
  if (adapter.importAuth) {
    parsed = await adapter.importAuth({ token: raw, mode: "paste" });
  } else if (methodKey === "relay") {
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
  return { accountLabel: parsed.accountLabel || merged.account || merged.email || "", credEpoch: merged.cred_epoch };
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
        modes.push({
          key: "oauth-browser",
          label: "浏览器登录（推荐）",
          desc: "在服务器浏览器里打开官方登录页，验证码/接码人工完成，授权后自动写回凭据",
        });
        modes.push({
          key: "oauth-callback",
          label: "打开授权页 + 粘贴回调",
          desc: "在自己电脑的浏览器里登录，把回调地址粘回来换令牌",
        });
      } else if (mCfg.captureApi) {
        modes.push({
          key: "session-capture",
          label: "浏览器登录抓取（推荐）",
          desc: "在服务器浏览器里登录官网，登录后自动读取会话凭据",
        });
      }
      if (isOAuthMethod(method) && supportsDeviceLogin(r.type)) {
        modes.push({ key: "device", label: "设备码登录", desc: "打开授权页输入设备码，适合无法回调的场景" });
      }
      if (mCfg.needsBrowser) {
        modes.push({ key: "browser-ready", label: "浏览器登录", desc: "打开上游页面完成扫码/验证码登录" });
      }
      if (mCfg.entryUrl && !mCfg.captureApi && !mCfg.needsBrowser) {
        modes.push({ key: "capture", label: "抓取登录态", desc: "在服务器浏览器里登录后自动抓取 cookies / token" });
      }
      if ((mCfg.loginModes || []).includes("password")) {
        modes.push({ key: "password", label: "账号密码登录", desc: "用上游账号密码重新登录" });
      }
      modes.push({ key: "paste", label: "粘贴凭据", desc: "手工粘贴官方凭据文件或登录态" });
    } else {
      modes.push({ key: "api-key", label: "更新 API Key", desc: "到渠道编辑里换一个可用的 Key" });
    }

    const lastError = rt.last_error || r.last_error || "";
    // 「需要人工重新登录」的判定：认证类错误 + 冷却中，或本来就缺凭据
    const needsRelogin =
      /AUTH|401|403|失效|过期|未配置|无效|重新登录|验证/i.test(String(lastError)) ||
      (!r.api_key && !other.profile && method !== "api");

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
    });
  })
);

// ---------- 凭据找回：在服务器浏览器里重新登录 ----------
// 为什么必须有这条：订阅渠道掉登录态时，上游往往要求「再验证一次」（邮箱/短信验证码、
// 甚至人机校验），纯粘贴凭据无法完成这一步 —— 用户手上已经没有可用的凭据文件了。
// 这里把官方登录页搬到服务器浏览器，验证码那一步由人工在实时画面/截图里完成，
// 授权回调/会话读取代理由服务端完成，成功后直接写回该渠道。
router.post(
  "/:id/recover/start",
  asyncHandler(async (req, res) => {
    sweepCaptures();
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    const r = rows[0];
    const provider = getProvider(r.type);
    if (!provider) return fail(res, "未知厂商");
    const method = methodOf(r);
    if (method === "api") return fail(res, "API Key 渠道请直接编辑渠道更换 Key");

    const mCfg = getMethod(r.type, method) || {};
    const sid = randomBytes(8).toString("hex");
    const channelId = `recover-${sid}`;

    // 订阅 OAuth：走官方授权页（浏览器里完成登录 + 可能出现的验证码），回调后自动换令牌
    if (isOAuthMethod(method) && supportsInteractiveLoginMethod(r.type, method)) {
      let login;
      try {
        login = buildLoginUrl(r.type);
      } catch (e) {
        return fail(res, e.message, e.code === "CHANNEL_CONFIG_ERROR" ? 400 : 500);
      }
      try {
        await browserSession({ vendor: r.type, channelId, entryUrl: login.url, profile: {}, visible: true });
      } catch (e) {
        await removeProfile(r.type, channelId).catch(() => {});
        return fail(res, `授权页打开失败：${e.message}`);
      }
      let shot = null;
      try {
        shot = await browserShot(r.type, channelId);
      } catch {
        shot = null;
      }
      if (!shot) {
        await browserClose(r.type, channelId).catch(() => {});
        await removeProfile(r.type, channelId).catch(() => {});
        return fail(res, "浏览器会话未就绪，请重试");
      }
      CAPTURES.set(sid, {
        type: r.type,
        channelId,
        at: Date.now(),
        kind: "oauth",
        targetId: id,
        oauthState: login.state,
        redirectUri: login.redirectUri,
      });
      return ok(res, {
        sid,
        ...shot,
        kind: "oauth",
        redirectUri: login.redirectUri,
        hint: "在实时画面/截图里完成登录（含验证码）；页面跳到 "
          + login.redirectUri
          + " 后会自动换令牌并写回该渠道",
      });
    }

    // 网页版渠道：打开官网登录页，登录后读取会话接口拿凭据
    if (mCfg.captureApi && mCfg.entryUrl) {
      try {
        await browserSession({ vendor: r.type, channelId, entryUrl: mCfg.entryUrl, profile: {}, visible: true });
      } catch (e) {
        await removeProfile(r.type, channelId).catch(() => {});
        return fail(res, `登录页打开失败：${e.message}`);
      }
      let shot = null;
      try {
        shot = await browserShot(r.type, channelId);
      } catch {
        shot = null;
      }
      if (!shot) {
        await browserClose(r.type, channelId).catch(() => {});
        await removeProfile(r.type, channelId).catch(() => {});
        return fail(res, "浏览器会话未就绪，请重试");
      }
      CAPTURES.set(sid, {
        type: r.type,
        channelId,
        at: Date.now(),
        kind: "session",
        targetId: id,
        captureApi: mCfg.captureApi,
      });
      return ok(res, { sid, ...shot, kind: "session", hint: mCfg.captureHint || "登录完成后点「抓取登录态」" });
    }

    // 其余反代（扫码/验证码型）：登录态在 profile 里，完成登录后把 profile 覆盖给该渠道
    if (mCfg.needsBrowser && mCfg.entryUrl) {
      try {
        await browserSession({ vendor: r.type, channelId, entryUrl: mCfg.entryUrl, profile: {}, visible: true });
      } catch (e) {
        await removeProfile(r.type, channelId).catch(() => {});
        return fail(res, `登录页打开失败：${e.message}`);
      }
      let shot = null;
      try {
        shot = await browserShot(r.type, channelId);
      } catch {
        shot = null;
      }
      if (!shot) {
        await browserClose(r.type, channelId).catch(() => {});
        await removeProfile(r.type, channelId).catch(() => {});
        return fail(res, "浏览器会话未就绪，请重试");
      }
      CAPTURES.set(sid, { type: r.type, channelId, at: Date.now(), kind: "browser", targetId: id });
      return ok(res, { sid, ...shot, kind: "browser", hint: mCfg.captureHint || "登录完成后点「抓取登录态」" });
    }

    // 抓取型（DeepSeek / Kimi 等粘贴登录态）：抓完直接写回渠道
    if (mCfg.entryUrl) {
      try {
        await browserSession({ vendor: r.type, channelId, entryUrl: mCfg.entryUrl, profile: {}, visible: true });
      } catch (e) {
        await removeProfile(r.type, channelId).catch(() => {});
        return fail(res, `登录页打开失败：${e.message}`);
      }
      let shot = null;
      try {
        shot = await browserShot(r.type, channelId);
      } catch {
        shot = null;
      }
      if (!shot) {
        await browserClose(r.type, channelId).catch(() => {});
        await removeProfile(r.type, channelId).catch(() => {});
        return fail(res, "浏览器会话未就绪，请重试");
      }
      CAPTURES.set(sid, { type: r.type, channelId, at: Date.now(), kind: "paste", targetId: id });
      return ok(res, { sid, ...shot, kind: "paste", hint: mCfg.captureHint || "登录完成后点「抓取登录态」" });
    }

    return fail(res, `${provider.name} 该接入方式不支持浏览器重新登录，请用「粘贴凭据」`);
  })
);

// ---------- 账号额度查询（显式触发）----------
// 为什么不放进定时全量轮询：额度接口是各厂商的「额外请求」，高频轮询等于把账号
// 标成脚本；而且额度变化以小时计，没必要秒级刷新。管理员点一次查一次，结果落库供列表展示。
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

    return ok(res, {
      models: [...new Set(models)].sort(),
      source,
      upstreamError: upstreamError || undefined,
      // 渠道已声明的范围，前端据此预选
      declared: String(r.models || "").split(",").map((s) => s.trim()).filter(Boolean),
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

// ---------- 浏览器登录辅助（远程人工介入）----------
// 服务器无桌面，登录往往需要扫码/输验证码。这两个接口让管理员在后台里
// 看到上游页面的实时截图，完成登录后再确认。
router.post(
  "/:id/browser/open",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    if (methodOf(rows[0]) !== "relay") return fail(res, "只有网页版反代渠道需要浏览器登录");
    const mCfg = getMethod(rows[0].type, "relay");
    if (!mCfg?.needsBrowser) return fail(res, `${getProvider(rows[0].type)?.name || rows[0].type} 不需要浏览器登录`);
    const adapter = await adapterOf(rows[0].type, "relay");
    if (!adapter?.verify) return fail(res, "该渠道未实现浏览器登录");

    // 先开一次会话（verify 会导航并等待页面就绪），失败也继续截图，
    // 便于管理员看到「卡在哪一步」
    let lastError = null;
    try {
      await adapter.verify(rowToChannel(rows[0]));
    } catch (e) {
      lastError = e.message;
    }

    const shot = await browserShot(rows[0].type, id);
    if (!shot) return fail(res, lastError || "浏览器会话未启动");
    return ok(res, { ...shot, ready: browserReady(rows[0].type, id), error: lastError });
  })
);

router.post(
  "/:id/browser/check",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    if (methodOf(rows[0]) !== "relay") return fail(res, "只有网页版反代渠道需要浏览器登录");
    const providerName = getProvider(rows[0].type)?.name || rows[0].type;
    const adapter = await adapterOf(rows[0].type, "relay");

    try {
      const ms = await adapter.verify(rowToChannel(rows[0]));
      // 不写 status：status 是管理员开关，运行期/检查流程不得复活手动禁用的渠道
      await pool.query("UPDATE channels SET response_time = ?, tested_time = ?, last_error = '' WHERE id = ?", [
        ms,
        now(),
        id,
      ]);
      resetChannelState(id);
      await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `${providerName} 渠道「${rows[0].name}」浏览器登录就绪` });
      return ok(res, { success: true, time: ms }, "登录已就绪，渠道可用");
    } catch (e) {
      await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), id]);
      return ok(res, { success: false, message: e.message, code: e.code }, `尚未就绪：${e.message}`);
    }
  })
);

// ---------- 远程登录抓取（添加渠道的快捷入口）----------
// 场景：DeepSeek / Kimi 这类「粘贴登录态」的接入方式，以前要管理员自己在浏览器
// 打开控制台翻 localStorage / Cookie。这里把登录页搬到服务器端截图上：
//   start   → 打开厂商登录页并返回截图
//   act     → 管理员在截图上点击 / 输入验证码（远程操作真实页面）
//   capture → 读取 cookies 与 localStorage 登录态候选，回填表单
//   close   → 放弃登录，关闭会话
// 会话使用临时 profile（capture-<sid>），抓取/关闭后立即删除目录，不占用磁盘。
const CAPTURES = new Map(); // sid -> { type, channelId, at }
const CAPTURE_TTL_MS = 15 * 60 * 1000;

// 浏览器 onboarding 完成后的临时 profile（登录态在目录里，提交渠道时复制过去）。
// 注意：必须声明在模块顶层 —— sweeper/close/login 都要访问，声明在处理函数里会直接 ReferenceError。
const PENDING_PROFILES = new Map(); // channelId -> { vendor, at }
const PENDING_PROFILE_TTL_MS = 30 * 60 * 1000;

function sweepCaptures() {
  const cutoff = Date.now() - CAPTURE_TTL_MS;
  for (const [sid, c] of CAPTURES) {
    if (c.at < cutoff) {
      CAPTURES.delete(sid);
      browserClose(c.type, c.channelId).catch(() => {});
      // onboarding 现在也是每会话独立的临时 profile：过期即清，避免目录泄漏
      removeProfile(c.type, c.channelId).catch(() => {});
    }
  }
}
// 会话过期回收不能只靠「下一次 start 时才扫」：没有任何后续请求时浏览器会一直挂着
const captureSweeper = setInterval(() => {
  sweepCaptures();
  // onboarding 临时 profile 兜底清理：提交成功会立即删，放弃/失败也不会永久残留
  const cutoff = Date.now() - PENDING_PROFILE_TTL_MS;
  for (const [channelId, info] of PENDING_PROFILES) {
    if (info.at < cutoff) {
      PENDING_PROFILES.delete(channelId);
      removeProfile(info.vendor, channelId).catch(() => {});
    }
  }
}, 5 * 60 * 1000);
captureSweeper.unref?.();

function captureOf(req) {
  const c = CAPTURES.get(String(req.params.sid || ""));
  if (!c) return null;
  c.at = Date.now();
  return c;
}

router.post(
  "/capture/start",
  asyncHandler(async (req, res) => {
    sweepCaptures();
    const { type, method } = req.body || {};
    const provider = getProvider(type);
    if (!provider) return fail(res, "未知厂商");

    // 订阅 OAuth（gemini / openai / anthropic）：打开官方授权页，
    // 在服务器浏览器里登录（截图操作），页面跳到 localhost 回调后由 /capture 换 token 回填表单。
    // 注意必须同时看**接入方式**：openai 厂商下既有 codex（可交互登录）也有 openai-web（走网页登录），
    // 只看厂商会把网页版渠道错送到 Codex 授权页。
    if (isOAuthMethod(method) && supportsInteractiveLoginMethod(type, method)) {
      let login;
      try {
        login = buildLoginUrl(type);
      } catch (e) {
        return fail(res, e.message, e.code === "CHANNEL_CONFIG_ERROR" ? 400 : 500);
      }
      const sid = randomBytes(8).toString("hex");
      const channelId = `capture-${sid}`;
      try {
        await browserSession({ vendor: type, channelId, entryUrl: login.url, profile: {}, visible: true });
      } catch (e) {
        await removeProfile(type, channelId).catch(() => {});
        return fail(res, `授权页打开失败：${e.message}`);
      }
      let shot = null;
      try {
        shot = await browserShot(type, channelId);
      } catch {
        shot = null;
      }
      if (!shot) {
        // 截图拿不到说明会话没起来：立即回收，别留下拿不到 sid 的僵尸会话
        await browserClose(type, channelId).catch(() => {});
        await removeProfile(type, channelId).catch(() => {});
        return fail(res, "浏览器会话未就绪，请重试");
      }
      CAPTURES.set(sid, {
        type,
        method: String(method || ""),
        channelId,
        at: Date.now(),
        kind: "oauth",
        oauthState: login.state,
        redirectUri: login.redirectUri,
      });
      return ok(res, {
        sid,
        ...shot,
        kind: "oauth",
        redirectUri: login.redirectUri,
        hint: `在实时画面/截图里完成登录；页面跳到 ${login.redirectUri} 后会自动抓取凭据（也可以手动点按钮）`,
      });
    }

    const mCfg = getMethod(type, String(method || "relay")) || getMethod(type, "relay");
    if (!mCfg?.entryUrl) return fail(res, `${provider.name} 不支持远程登录抓取，请按提示手动填写登录态`);
    // 浏览器登录类（GLM/豆包/通义）：每次会话独立 onboarding profile
    // （共享同一个目录会让并发/后续登录互相覆盖，甚至把别人的账号复制进渠道）。
    // 登录完成后由 /capture 保留 profile，提交渠道时复制过去。
    const onboard = Boolean(mCfg.needsBrowser);
    const sid = randomBytes(8).toString("hex");
    const channelId = onboard ? `onboarding-${sid}` : `capture-${sid}`;
    try {
      await browserSession({ vendor: type, channelId, entryUrl: mCfg.entryUrl, profile: {}, visible: true });
    } catch (e) {
      if (!onboard) await removeProfile(type, channelId).catch(() => {});
      return fail(res, `登录页打开失败：${e.message}`);
    }
    let shot = null;
    try {
      shot = await browserShot(type, channelId);
    } catch {
      shot = null;
    }
    if (!shot) {
      await browserClose(type, channelId).catch(() => {});
      await removeProfile(type, channelId).catch(() => {});
      return fail(res, "浏览器会话未就绪，请重试");
    }
    CAPTURES.set(sid, {
      type,
      channelId,
      at: Date.now(),
      // session = 凭据要从站点会话接口取（网页版渠道），不读 localStorage/cookie
      kind: onboard ? "browser" : mCfg.captureApi ? "session" : "paste",
      captureApi: mCfg.captureApi || "",
    });
    return ok(res, {
      sid,
      ...shot,
      kind: onboard ? "browser" : mCfg.captureApi ? "session" : "paste",
      profileId: onboard ? channelId : "",
      hint: mCfg.captureHint || "请在登录页完成登录，然后点「抓取登录态」",
    });
  })
);

router.get(
  "/capture/:sid/shot",
  asyncHandler(async (req, res) => {
    const c = captureOf(req);
    if (!c) return fail(res, "会话已过期，请重新打开登录页", 404);
    const shot = await browserShot(c.type, c.channelId);
    if (!shot) return fail(res, "会话已结束，请重新打开登录页", 404);
    return ok(res, shot);
  })
);

// 轻量轮询：只回当前 URL（OAuth 回调检测用；截图接口太重，不适合每 2 秒调）
router.get(
  "/capture/:sid/url",
  asyncHandler(async (req, res) => {
    const c = captureOf(req);
    if (!c) return fail(res, "会话已过期，请重新打开登录页", 404);
    return ok(res, { url: browserUrl(c.type, c.channelId) });
  })
);

router.post(
  "/capture/:sid/act",
  asyncHandler(async (req, res) => {
    const c = captureOf(req);
    if (!c) return fail(res, "会话已过期，请重新打开登录页", 404);
    try {
      const shot = await browserAct(c.type, c.channelId, req.body || {});
      if (!shot) return fail(res, "会话已结束，请重新打开登录页", 404);
      return ok(res, shot);
    } catch (e) {
      return fail(res, `远程操作失败：${e.message}`);
    }
  })
);

router.post(
  "/capture/:sid/capture",
  asyncHandler(async (req, res) => {
    const c = captureOf(req);
    if (!c) return fail(res, "会话已过期，请重新打开登录页", 404);
    const sid = String(req.params.sid);

    // OAuth：读当前页面 URL，捕获 localhost 回调地址后换 token，凭据直接回填表单
    if (c.kind === "oauth") {
      const shot = await browserShot(c.type, c.channelId);
      const url = String(shot?.url || "");
      if (!url.startsWith(c.redirectUri) || !/[?&]code=/.test(url)) {
        return fail(
          res,
          `还没检测到授权回调：请在截图里完成登录，页面跳到 ${c.redirectUri}（打不开正常）后再点一次「抓取凭据」`
        );
      }
      let result;
      try {
        result = await exchangeCodeForCredential(c.type, url, c.oauthState);
      } catch (e) {
        return fail(res, e.message, 400);
      }
      const token = JSON.stringify(result.credential, null, 2);
      let accountLabel = result.accountLabel || "";
      // 顺手交给适配器解析一次：能拿到更友好的账号标签；解析失败不影响提交（login 时会再解析）
      try {
        const provider = getProvider(c.type);
        const mCfg = (provider?.methods || []).find((m) => isOAuthMethod(m.key)) || null;
        const adapter = mCfg ? await getAdapter(mCfg.adapter || mCfg.key) : null;
        if (adapter?.importAuth) {
          const r = await adapter.importAuth(result.credential);
          accountLabel = r.accountLabel || accountLabel;
        }
      } catch {
        /* ignore */
      }
      CAPTURES.delete(sid);
      await browserClose(c.type, c.channelId).catch(() => {});
      await removeProfile(c.type, c.channelId).catch(() => {});
      // 找回流程（从某条渠道发起）：直接写回该渠道，不用再经过表单
      if (c.targetId) {
        try {
          const applied = await applyCredentialToChannel({ id: c.targetId, type: c.type, credential: result.credential });
          await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `${c.type} 渠道 #${c.targetId} 浏览器重新登录成功` });
          return ok(res, { updated: true, accountLabel: applied.accountLabel }, "授权成功，凭据已写回该渠道");
        } catch (e) {
          return fail(res, `授权成功但写回失败：${e.message}`, 400);
        }
      }
      return ok(
        res,
        { oauth: true, accountLabel, cookies: "", tokens: [{ key: "凭据 JSON", value: token, score: 100 }] },
        "已抓到登录凭据，请确认回填"
      );
    }

    // 浏览器 onboarding：登录态就在 profile 目录里，保留它，等提交时复制给渠道。
// 抓取完成后 CAPTURES 条目会被删（sid 生命周期结束），这里把 profile 登记进
    if (c.kind === "browser") {
      CAPTURES.delete(sid);
      await browserClose(c.type, c.channelId).catch(() => {});
      // 找回流程：把这份已登录 profile 直接覆盖给目标渠道（不再走「添加渠道」）
      if (c.targetId) {
        const copied = await copyProfile(c.type, c.channelId, String(c.targetId));
        await removeProfile(c.type, c.channelId).catch(() => {});
        if (!copied) return fail(res, "登录态写回失败，请重新打开登录页再试");
        resetChannelState(c.targetId);
        let ms = 0;
        try {
          const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [c.targetId]);
          // 适配器按「该渠道真实的接入方式」取，不要猜 relay（openai-web / kiro 都挂在非 relay 上）
          const adapter = await adapterOf(fresh[0].type, methodOf(fresh[0]));
          if (!adapter?.verify) return ok(res, { updated: true }, "登录态已写回（该接入方式无健康检查）");
          ms = await adapter.verify(rowToChannel(fresh[0]));
          await pool.query("UPDATE channels SET response_time = ?, tested_time = ?, last_error = '' WHERE id = ?", [ms, now(), c.targetId]);
        } catch (e) {
          await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), c.targetId]);
          return fail(res, `登录态已写回，但渠道未就绪：${e.message}`, 400);
        }
        await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `${c.type} 渠道 #${c.targetId} 浏览器重新登录成功（${ms}ms）` });
        return ok(res, { updated: true }, "登录成功，渠道已恢复可用");
      }
      PENDING_PROFILES.set(c.channelId, { vendor: c.type, at: Date.now() });
      return ok(res, { browserReady: true, cookies: "", tokens: [] }, "已记录浏览器登录状态，请点「添加」保存渠道");
    }

    // 网页版渠道：凭据只能问站点自己的会话接口（chatgpt.com/api/auth/session），
    // 在已登录页面里 fetch 一次即可拿到 accessToken/refreshToken。
    if (c.kind === "session") {
      const r = await browserApiFetch(c.type, c.channelId, c.captureApi);
      CAPTURES.delete(sid);
      await browserClose(c.type, c.channelId).catch(() => {});
      await removeProfile(c.type, c.channelId).catch(() => {});
      if (!r?.ok) {
        return fail(
          res,
          `还没登录：读取 ${c.captureApi} 失败（HTTP ${r?.status || 0}）。请在实时画面里完成登录后再点一次「抓取登录态」`
        );
      }
      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch {
        return fail(res, `${c.captureApi} 返回的不是 JSON，请重试`);
      }
      const accessToken = String(j?.accessToken || j?.access_token || "");
      if (!accessToken) {
        return fail(res, "会话接口里没有 accessToken：说明还没登录成功，请在实时画面里完成登录后再抓取");
      }
      const credential = {
        accessToken,
        ...(j?.refreshToken || j?.refresh_token ? { refreshToken: String(j.refreshToken || j.refresh_token) } : {}),
        ...(j?.user?.email ? { email: String(j.user.email) } : {}),
        ...(j?.expires ? { expires: String(j.expires) } : {}),
      };
      // 找回流程（从某条渠道发起）：直接写回该渠道并探一次，不用再经过「添加渠道」表单
      if (c.targetId) {
        try {
          const applied = await applyCredentialToChannel({ id: c.targetId, type: c.type, credential });
          await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `${c.type} 渠道 #${c.targetId} 网页版重新登录成功` });
          return ok(res, { updated: true, accountLabel: applied.accountLabel }, "凭据已写回该渠道");
        } catch (e) {
          return fail(res, `抓取成功但写回失败：${e.message}`, 400);
        }
      }
      return ok(
        res,
        {
          oauth: true,
          accountLabel: credential.email || "",
          cookies: "",
          tokens: [{ key: "凭据 JSON", value: JSON.stringify(credential, null, 2), score: 100 }],
        },
        "已抓到登录凭据，请确认回填"
      );
    }

    const data = await browserCreds(c.type, c.channelId);
    // 抓取完成即回收：关闭浏览器 + 删除临时 profile
    CAPTURES.delete(sid);
    await browserClose(c.type, c.channelId).catch(() => {});
    await removeProfile(c.type, c.channelId).catch(() => {});
    if (!data) return fail(res, "会话已结束，请重新打开登录页", 404);
    if (!data.tokens?.length && !data.cookies) {
      return fail(res, "没有抓到任何登录态，请确认已成功登录后再试");
    }
    // 找回流程（kind=paste：DeepSeek / Kimi 这类「抓取登录态」的 relay 渠道）：
    // 直接写回目标渠道，否则抓到的 token 只会回填「添加渠道」表单 —— 渠道永远恢复不了。
    // 取评分最高的候选 token（browser-driver 按 key 名打分，userToken / kimi-auth 会排最前）。
    if (c.targetId) {
      const best = (data.tokens || [])[0];
      if (!best?.value) {
        return fail(res, "没有抓到可用的登录态（只有 cookies），请确认登录成功后再试");
      }
      try {
        const [row] = await pool.query("SELECT * FROM channels WHERE id = ?", [c.targetId]);
        if (!row.length) return fail(res, "渠道不存在", 404);
        const applied = await applyCredentialToChannel({
          id: c.targetId,
          type: c.type,
          credential: JSON.stringify({
            token: best.value,
            cookies: data.cookies || "",
          }),
        });
        // 写回后探一次，让管理员立刻知道恢复是否真的成功
        const adapter = await adapterOf(row[0].type, methodOf(row[0]));
        let ms = 0;
        if (adapter?.verify) {
          try {
            const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [c.targetId]);
            ms = await adapter.verify(rowToChannel(fresh[0]));
            await pool.query("UPDATE channels SET response_time = ?, tested_time = ?, last_error = '' WHERE id = ?", [
              ms,
              now(),
              c.targetId,
            ]);
          } catch (e) {
            await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), c.targetId]);
            return fail(res, `登录态已写回，但渠道未就绪：${e.message}`, 400);
          }
        }
        await writeLog({
          req,
          user: req.user,
          type: LOG_TYPE.MANAGE,
          content: `${c.type} 渠道 #${c.targetId} 抓取登录态成功（${ms}ms）`,
        });
        return ok(res, { updated: true, accountLabel: applied.accountLabel }, "登录态已写回，渠道已恢复");
      } catch (e) {
        return fail(res, `抓取成功但写回失败：${e.message}`, 400);
      }
    }
    return ok(res, data, "已抓取登录态，请确认要填入的字段");
  })
);

router.post(
  "/capture/:sid/close",
  asyncHandler(async (req, res) => {
    const sid = String(req.params.sid || "");
    const c = CAPTURES.get(sid);
    if (c) {
      CAPTURES.delete(sid);
      PENDING_PROFILES.delete(c.channelId);
      await browserClose(c.type, c.channelId).catch(() => {});
      // 放弃登录：profile 直接清掉（完成登录后的提交走 /capture，不在清理范围）
      await removeProfile(c.type, c.channelId).catch(() => {});
    }
    return ok(res, null, "已关闭");
  })
);

// ---------- 订阅 OAuth：交互式登录（点一下跳官方页面，回来粘贴回调地址）----------
// 为什么不做自动回调：官方客户端的 redirect_uri 固定指向用户本机 localhost，
// 服务器收不到；所以采用「复制地址栏 URL 回来」的方式（与 gcloud --no-launch-browser 同理）。
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

// noVNC 实时浏览器：把服务器浏览器画面嵌到管理端弹窗里，管理员直接操作（登录态仍留服务器）。
// 路径带随机令牌且由 nginx 反代（见服务器部署说明）；未配置时前端退回截图模式。
router.get(
  "/vnc/info",
  asyncHandler(async (req, res) => {
    const p = String(process.env.VNC_PUBLIC_PATH || "").trim();
    if (!/^\/[A-Za-z0-9/_-]+\/$/.test(p)) return ok(res, { enabled: false });
    // path 必须给绝对路径：vnc.html 在「带前缀的 location」下会把它当相对路径解析成根路径 /websockify
    const url = `${p}vnc_lite.html?path=${encodeURIComponent(`${p}websockify`)}&autoconnect=1&resize=scale&reconnect=1`;
    return ok(res, { enabled: true, path: p, url });
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
      if (isOAuthMethod(methodKey)) {
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
        });
        token = r.token;
        other = {
          method: "relay",
          profile: r.profile || null,
          ...(r.cookies?.length ? { cookies: r.cookies } : {}),
          account: isEmail ? account : `${account.slice(0, 3)}****${account.slice(-4)}`,
        };
        accountLabel = other.account;
      } else if (mode === "paste") {
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
        `INSERT INTO channels (name, type, base_url, api_key, models, group_name, group_list, status, priority, weight, auto_ban, other, created_time)
         VALUES (?,?,?,?,?,?,?, 1, ?, ?, ?, ?, ?)`,
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

    // 订阅 OAuth：入池前做一次凭据健康检查（失败禁用而不是带着坏凭据参与调度）
    if (isOAuthMethod(methodKey) && adapter.verify) {
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
    if (!models.trim()) return fail(res, "请至少选择一个模型");
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
      await pool.query("UPDATE channels SET response_time = ?, tested_time = ?, last_error = '' WHERE id = ?", [
        probe.ms,
        now(),
        id,
      ]);
      // 测试结果计入「最近调用」小绿条（tip 里带提示词、AI 回复与降智状态）
      await recordChannelCall(id, true, probe.ms, "", {
        prompt,
        reply: probe.reply,
        degraded: probe.degraded,
        state: probe.state,
        kind: "test",
      });
      resetChannelState(id);
      await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `测试渠道「${row.name}」通过（${probe.ms}ms）` });
      return ok(res, { success: true, time: probe.ms, reply: probe.reply, prompt }, `渠道可用（${probe.ms}ms）`);
    } catch (e) {
      await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), id]);
      // 测试失败计入「最近调用」小绿条（失败 → 红色；tip 里带失败原因）
      await recordChannelCall(id, false, Date.now() - startedAt, e.message, { prompt, reply: e.message, kind: "test" });
      await writeLog({ req, user: req.user, type: LOG_TYPE.ERROR, content: `测试渠道「${row.name}」失败：${e.message}` });
      return ok(res, { success: false, message: e.message, code: e.code }, `测试失败：${e.message}`);
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
      return ok(res, list);
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

// ---------- 分组列表（供筛选）----------
// 注意：管理员分组列表在文件前部的 GET /channel/groups（channel_groups 表）；
// 这里不再返回 group_name 去重列表，避免与前者同名路由互相遮蔽。

export default router;
