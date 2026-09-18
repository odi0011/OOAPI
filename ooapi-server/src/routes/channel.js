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
import { getAdapter, resetChannelState, forgetChannel, channelRuntimeState, rowToChannel, recordChannelCall } from "../services/router.js";
import {
  isReady as browserReady,
  removeProfile,
  screenshot as browserShot,
  getSession as browserSession,
  act as browserAct,
  credentials as browserCreds,
  closeSession as browserClose,
} from "../services/upstream/browser-driver.js";
import { invalidateModelRegistry } from "../services/models.js";
import { parseCredentialFile } from "../services/upstream/auth-import.js";
import { probeChannel } from "../services/channel-probe.js";
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
    // 配置
    base_url: r.base_url || mCfg?.baseUrl || "",
    models: String(r.models || "").split(",").map((s) => s.trim()).filter(Boolean),
    group_name: r.group_name || "default",
    priority: Number(r.priority) || 0,
    weight: Number(r.weight) || 0,
    // 状态
    status: r.status,
    status_label: r.status === 2 ? "已禁用" : cooling ? "冷却中" : r.status === 1 ? "已启用" : "自动禁用",
    auto_ban: r.auto_ban === 0 ? false : true,
      cooling,
      recent: rt.recent,
      test_model: r.test_model || "",
      test_prompt: r.test_prompt || "hi",
      auto_test: Number(r.auto_test) === 1,
      auto_test_interval: Number(r.auto_test_interval) || 3600,
      cooldown_text: rt.cooldown_until
      ? new Date(rt.cooldown_until).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      : "",
    last_error: rt.last_error || r.last_error || "",
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
    conds.push("status = ?");
    args.push(Number(status));
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
    const [[usage]] = await pool.query(
      "SELECT COUNT(*) AS calls, COALESCE(SUM(quota),0) AS quota FROM logs WHERE type = 2"
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

// ---------- 查看完整 Key ----------
router.get(
  "/:id/key",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "渠道不存在", 404);
    const [rows] = await pool.query("SELECT api_key, name FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "渠道不存在", 404);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `查看渠道「${rows[0].name}」的凭据` });
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
      await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `${providerName} 渠道「${rows[0].name}」浏览器登录就绪` });
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

function sweepCaptures() {
  const cutoff = Date.now() - CAPTURE_TTL_MS;
  for (const [sid, c] of CAPTURES) {
    if (c.at < cutoff) {
      CAPTURES.delete(sid);
      browserClose(c.type, c.channelId).catch(() => {});
      removeProfile(c.type, c.channelId).catch(() => {});
    }
  }
}

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
    const { type } = req.body || {};
    const provider = getProvider(type);
    if (!provider) return fail(res, "未知厂商");
    const mCfg = getMethod(type, "relay");
    if (!mCfg?.entryUrl) return fail(res, `${provider.name} 不支持远程登录抓取，请按提示手动填写登录态`);

    const sid = randomBytes(8).toString("hex");
    const channelId = `capture-${sid}`;
    try {
      await browserSession({ vendor: type, channelId, entryUrl: mCfg.entryUrl, profile: {} });
    } catch (e) {
      await removeProfile(type, channelId).catch(() => {});
      return fail(res, `登录页打开失败：${e.message}`);
    }
    CAPTURES.set(sid, { type, channelId, at: Date.now() });
    const shot = await browserShot(type, channelId);
    if (!shot) return fail(res, "浏览器会话未就绪，请重试");
    return ok(res, { sid, ...shot, hint: mCfg.captureHint || "请在登录页完成登录，然后点「抓取登录态」" });
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
    const data = await browserCreds(c.type, c.channelId);
    // 抓取完成即回收：关闭浏览器 + 删除临时 profile
    CAPTURES.delete(String(req.params.sid));
    await browserClose(c.type, c.channelId).catch(() => {});
    await removeProfile(c.type, c.channelId).catch(() => {});
    if (!data) return fail(res, "会话已结束，请重新打开登录页", 404);
    if (!data.tokens?.length && !data.cookies) {
      return fail(res, "没有抓到任何登录态，请确认已成功登录后再试");
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
      await browserClose(c.type, c.channelId).catch(() => {});
      await removeProfile(c.type, c.channelId).catch(() => {});
    }
    return ok(res, null, "已关闭");
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
    const defaultModels = (mCfg.defaultModels || []).map((m) => m.id).join(",");
    const models = (
      Array.isArray(modelsInput)
        ? modelsInput.map((s) => String(s).trim()).filter(Boolean).join(",") || defaultModels
        : String(modelsInput || "").trim() || defaultModels
    ).slice(0, 20_000);
    const groupName = String(group_name || "default").trim().slice(0, 64) || "default";
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
        const r = await adapter.importAuth({ ...rest, mode: "paste" });
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
            try {
              const p = JSON.parse(String(rest.cookies));
              list = Array.isArray(p) ? p : [];
            } catch {
              return fail(res, 'Cookies 需为 JSON 数组，例如 [{"name":"kimi-auth","value":"..."}]');
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
      await writeLog({ user: req.user, type: LOG_TYPE.ERROR, content: `${provider.name} 登录失败：${e.message}` });
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
           models = COALESCE(?, models), group_name = COALESCE(?, group_name),
           weight = COALESCE(?, weight), auto_ban = COALESCE(?, auto_ban),
           priority = COALESCE(?, priority)
         WHERE id = ?`,
        [
          String(name || provider.name).slice(0, 64),
          token || "",
          JSON.stringify(merged),
          modelsInput !== undefined ? models : null,
          group_name !== undefined ? groupName : null,
          weight !== undefined ? weightVal : null,
          auto_ban !== undefined ? autoBanVal : null,
          priorityProvided ? priorityVal : null,
          targetId,
        ]
      );
      resetChannelState(targetId);

      if (mode === "browser") {
        const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [targetId]);
        try {
          const ms = await adapter.verify(rowToChannel(fresh[0]));
          await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `浏览器登录 ${provider.name} 成功（${ms}ms）` });
        } catch (e) {
          await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), targetId]);
          return fail(res, `渠道已创建但未就绪：${e.message}。请在渠道列表点「浏览器登录」完成人工登录`, 400);
        }
      }
      await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `${provider.name} 渠道 #${targetId} 登录成功` });
      const all = await listRows();
      return ok(res, rowToResp(all.find((r) => r.id === targetId)), "登录成功");
    }

    // 新建
    let insertId;
    if (mode === "browser") {
      // 列与值必须严格一一对应（11 列 / 参数：name,type,base_url,models,group,priority,weight,auto_ban,other,created_time）
      const [ret] = await pool.query(
        `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, auto_ban, other, created_time)
         VALUES (?,?,?, '', ?, ?, 1, ?, ?, ?, ?, ?)`,
        [
          String(name || `${provider.name} 渠道`).slice(0, 64),
          type,
          mCfg.baseUrl || "",
          models,
          groupName,
          priorityVal,
          weightVal,
          autoBanVal,
          JSON.stringify(other),
          now(),
        ]
      );
      insertId = ret.insertId;
      const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [insertId]);
      try {
        const ms = await adapter.verify(rowToChannel(fresh[0]));
        await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `浏览器登录 ${provider.name} 成功（${ms}ms）` });
      } catch (e) {
        await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), insertId]);
        return fail(res, `渠道已创建但未就绪：${e.message}。请在渠道列表点「浏览器登录」完成人工登录`, 400);
      }
    } else {
      if (isOAuthMethod(methodKey)) {
        // OAuth 渠道按稳定账号标识去重：access_token 会轮换，不能拿它当唯一键，
        // 否则同一账号二次导入检不出重复，两条渠道共享 refresh_token 会互相刷废
        const stableKey = other.account_id || other.account_uuid || other.email || other.project_id || "";
        if (stableKey) {
          const [rows] = await pool.query("SELECT id, other FROM channels WHERE type = ?", [type]);
          const dup = rows.find((r) => {
            try {
              const o = JSON.parse(r.other || "{}");
              return (o.account_id || o.account_uuid || o.email || o.project_id) === stableKey;
            } catch {
              return false;
            }
          });
          if (dup) return fail(res, "该账号已存在（凭据重复）");
        }
      } else {
        const [dup] = await pool.query("SELECT id FROM channels WHERE type = ? AND api_key = ? LIMIT 1", [type, token]);
        if (dup.length) return fail(res, "该账号已存在（登录态重复）");
      }
      const [ret] = await pool.query(
        `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, auto_ban, other, created_time)
         VALUES (?,?,?,?,?,?, 1, ?, ?, ?, ?, ?)`,
        [
          String(name || accountLabel || `${provider.name} 渠道`).slice(0, 64),
          type,
          mCfg.baseUrl || "",
          token,
          models,
          groupName,
          priorityVal,
          weightVal,
          autoBanVal,
          JSON.stringify(other),
          now(),
        ]
      );
      insertId = ret.insertId;
    }

    // 订阅 OAuth：入池前做一次凭据健康检查（失败禁用而不是带着坏凭据参与调度）
    if (isOAuthMethod(methodKey) && adapter.verify) {
      try {
        const [fresh] = await pool.query("SELECT * FROM channels WHERE id = ?", [insertId]);
        const ms = await adapter.verify(rowToChannel(fresh[0]));
        await writeLog({
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

    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `新增 ${provider.name} 渠道「${name || ""}」` });
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

    const models = (mCfg.defaultModels || []).map((m) => m.id).join(",").slice(0, 20_000);
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
          `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, other, created_time)
           VALUES (?,?,?,?,?, 'default', 1, ?, 1, ?, ?)`,
          [account, type, mCfg.baseUrl || "", r.token, models, priorityVal, JSON.stringify(other), now()]
        );
        results.push({ account, ok: true });
      } catch (e) {
        results.push({ account, ok: false, message: e.message });
      }
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }

    const okCount = results.filter((r) => r.ok).length;
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `批量导入 ${provider.name}：成功 ${okCount} / ${results.length}` });
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
    if (!baseUrl) return fail(res, "请填写接口地址（Base URL）");
    // 数值字段显式校验：Number("Infinity") || 0 仍是 Infinity，会拼出非法 SQL（500）
    const priority = safeInt(b.priority ?? 0, { min: 0, max: 1_000_000 });
    if (priority === null) return fail(res, "优先级无效");
    const weight = safeInt(b.weight ?? 0, { min: 0, max: 10_000 });
    if (weight === null) return fail(res, "权重无效");

    const other = { method: "api" };
    const [ret] = await pool.query(
      `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, remark, auto_ban, other, created_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name.slice(0, 64),
        type,
        baseUrl,
        apiKey.slice(0, 60_000),
        models.slice(0, 20_000),
        String(b.group_name || "default").trim().slice(0, 64) || "default",
        Number(b.status) === 2 ? 2 : 1,
        priority,
        weight,
        String(b.remark || "").slice(0, 255),
        b.auto_ban === false ? 0 : 1,
        JSON.stringify(other),
        now(),
      ]
    );
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `新增 ${provider.name} 渠道「${name}」（官方 API）` });
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
    setIf("base_url", b.base_url !== undefined ? String(b.base_url).trim().slice(0, 255) : undefined);
    if (b.api_key !== undefined && String(b.api_key).trim()) setIf("api_key", String(b.api_key).trim().slice(0, 60_000));
    if (b.models !== undefined) {
      const m = Array.isArray(b.models) ? b.models.join(",") : String(b.models);
      if (m.trim()) setIf("models", m.slice(0, 20_000));
    }
    setIf("group_name", b.group_name !== undefined ? String(b.group_name).trim().slice(0, 64) || "default" : undefined);
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

    if (!fields.length) return fail(res, "没有需要更新的字段");
    args.push(id);
    await pool.query(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`, args);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `编辑渠道「${cur.name}」` });
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
      await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `测试渠道「${row.name}」通过（${probe.ms}ms）` });
      return ok(res, { success: true, time: probe.ms, reply: probe.reply, prompt }, `渠道可用（${probe.ms}ms）`);
    } catch (e) {
      await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), id]);
      // 测试失败计入「最近调用」小绿条（失败 → 红色；tip 里带失败原因）
      await recordChannelCall(id, false, Date.now() - startedAt, e.message, { prompt, reply: e.message, kind: "test" });
      await writeLog({ user: req.user, type: LOG_TYPE.ERROR, content: `测试渠道「${row.name}」失败：${e.message}` });
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
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `删除渠道「${rows[0].name}」` });
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
      const g = String(payload?.group_name || "default").trim().slice(0, 64) || "default";
      await pool.query(`UPDATE channels SET group_name = ? WHERE id IN (${ph})`, [g, ...list]);
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

    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `批量操作渠道 ${list.join(",")}：${action}` });
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
        const defaultModels = (mCfg.defaultModels || []).map((m) => m.id).join(",");
        const oauth = isOAuthMethod(a.method);
        const stable = oauth
          ? a.other.account_id || a.other.account_uuid || a.other.email || a.other.sub || a.other.project_id || ""
          : "";
        const rows = await loadExisting(a.type);
        const dup = rows.find((r) => {
          if (oauth) {
            if (!stable) return false;
            try {
              const o = JSON.parse(r.other || "{}");
              return (o.account_id || o.account_uuid || o.email || o.sub || o.project_id) === stable;
            } catch {
              return false;
            }
          }
          return r.api_key === a.token;
        });
        if (dup) {
          skipped++;
          results.push({ name: a.name, ok: false, skipped: true, reason: "账号已存在（跳过）" });
          continue;
        }
        const baseUrl = String(a.base_url || mCfg.baseUrl || "").slice(0, 255);
        const [ret] = await pool.query(
          `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, auto_ban, other, created_time)
           VALUES (?,?,?,?,?, 'default', 1, ?, 1, 1, ?, ?)`,
          [
            String(a.name || `${a.type} 渠道`).slice(0, 64),
            a.type,
            baseUrl,
            a.token,
            defaultModels.slice(0, 20_000),
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
    await writeLog({
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
router.get(
  "/groups",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query("SELECT DISTINCT group_name FROM channels WHERE group_name != ''");
    const groups = rows.map((r) => r.group_name).filter(Boolean);
    if (!groups.includes("default")) groups.unshift("default");
    return ok(res, groups);
  })
);

export default router;
