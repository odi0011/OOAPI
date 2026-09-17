// 管理端：上游账号（渠道）的登录与运维 —— 多厂商通用
// ---------------------------------------------------------------------------
// 各厂商账号都是 channels 表的一行（type 区分厂商），这里提供统一运维入口：
//   GET    /api/deepseek/vendors          厂商列表（前端弹窗按此渲染）
//   GET    /api/deepseek/status           汇总状态
//   GET    /api/deepseek/accounts         账号列表
//   POST   /api/deepseek/login            账号密码登录（支持 password 的厂商）
//   POST   /api/deepseek/paste            粘贴登录态（支持 paste 的厂商）
//   POST   /api/deepseek/login/batch      批量导入（支持 batch 的厂商）
//   POST   /api/deepseek/browser-login    打开浏览器登录（浏览器驱动厂商）
//   PUT    /api/deepseek/accounts         编辑
//   POST   /api/deepseek/accounts/:id/test    连通性测试
//   POST   /api/deepseek/accounts/:id/reset   清除异常状态
//   DELETE /api/deepseek/accounts/:id
//   POST   /api/deepseek/accounts/batch   批量操作
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { VENDORS, activeVendors, getVendor } from "../services/vendors.js";
import { channelRuntimeState, resetChannelState, rowToChannel, getAdapter } from "../services/router.js";

const router = Router();
router.use(adminRequired);

// 允许的渠道类型（来自注册表）
const VENDOR_TYPES = VENDORS.map((v) => v.channelType);

// ---------- 通用工具 ----------
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

function toResp(row) {
  const other = parseOther(row);
  const rt = channelRuntimeState(row.id);
  const cooling = rt.cooldown_until > Date.now();
  const vendor = getVendor(row.type);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    vendorName: vendor?.name || row.type,
    status: row.status,
    status_label:
      row.status === 2 ? "已禁用" : cooling ? "异常冷却中" : row.status === 1 ? "正常" : "异常",
    models: String(row.models || "").split(",").filter(Boolean),
    priority: Number(row.priority) || 0,
    token_preview: mask(row.api_key, 10, 6),
    has_token: Boolean(row.api_key) || Boolean(other.profile),
    account: other.account || null,
    cookie_count: Array.isArray(other.cookies) ? other.cookies.length : 0,
    loginMode: vendor?.loginModes?.[0] || "paste",
    profile: other.profile
      ? {
          platform: other.profile.platform,
          chromeVersion: other.profile.chromeVersion,
          locale: other.profile.locale,
          deviceId: mask(other.profile.deviceId || other.profile.mshDeviceId, 6, 4),
          createdAt: other.profile.createdAt,
        }
      : null,
    used_count: Number(row.used_count ?? 0),
    last_used_time: Number(row.last_used_time ?? 0),
    response_time: Number(row.response_time) || 0,
    tested_time: Number(row.tested_time) || 0,
    last_error: rt.last_error || row.last_error || "",
    cooldown_until: rt.cooldown_until || 0,
    cooldown_text: rt.cooldown_until
      ? new Date(rt.cooldown_until).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      : "",
    created_time: Number(row.created_time) || 0,
  };
}

async function listRows(type) {
  if (type) {
    const [rows] = await pool.query(
      "SELECT * FROM channels WHERE type = ? ORDER BY priority DESC, id ASC",
      [type]
    );
    return rows;
  }
  const ph = VENDOR_TYPES.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT * FROM channels WHERE type IN (${ph}) ORDER BY priority DESC, id ASC`,
    VENDOR_TYPES
  );
  return rows;
}

/** 从适配器拿「登录后应写入 other 的内容」与登录校验能力 */
async function adapterOf(type) {
  try {
    return await getAdapter(type);
  } catch {
    return null;
  }
}

// ---------- 厂商列表 ----------
router.get(
  "/vendors",
  asyncHandler(async (req, res) => {
    return ok(
      res,
      activeVendors().map((v) => ({
        key: v.key,
        name: v.name,
        channelType: v.channelType,
        desc: v.desc,
        loginModes: v.loginModes,
        fields: v.fields,
        models: v.models,
        baseUrl: v.baseUrl,
        supportsBatch: v.supportsBatch,
        supportsVision: v.supportsVision,
        hint: v.hint || "",
      }))
    );
  })
);

// ---------- 汇总状态 ----------
router.get(
  "/status",
  asyncHandler(async (req, res) => {
    const rows = await listRows();
    const items = rows.map(toResp);
    const [[usage]] = await pool.query(
      "SELECT COUNT(*) AS calls, COALESCE(SUM(quota),0) AS quota FROM logs WHERE type = 2"
    );
    return ok(res, {
      total: items.length,
      available: items.filter((x) => x.status === 1 && !x.cooldown_until).length,
      cooling: items.filter((x) => x.cooldown_until).length,
      disabled: items.filter((x) => x.status === 2).length,
      total_calls: Number(usage.calls) || 0,
      total_quota: Number(usage.quota) || 0,
      by_vendor: VENDOR_TYPES.map((t) => ({
        type: t,
        total: items.filter((x) => x.type === t).length,
        available: items.filter((x) => x.type === t && x.status === 1 && !x.cooldown_until).length,
      })),
      vendors: activeVendors().map((v) => ({ key: v.key, name: v.name, channelType: v.channelType })),
    });
  })
);

// ---------- 账号列表 ----------
router.get(
  "/accounts",
  asyncHandler(async (req, res) => {
    const type = req.query.type ? String(req.query.type) : null;
    if (type && !VENDOR_TYPES.includes(type)) return fail(res, "未知厂商类型");
    const rows = await listRows(type);
    return ok(res, rows.map(toResp));
  })
);

// ---------- 账号密码登录 ----------
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { vendor = "deepseek", name, account, password, areaCode = "+86", priority = 0, id } = req.body || {};
    const v = getVendor(vendor);
    if (!v) return fail(res, "未知厂商");
    if (!v.loginModes.includes("password")) return fail(res, `${v.name} 不支持账号密码登录，请使用其它方式`);

    const acc = String(account || "").trim();
    if (!acc) return fail(res, "请填写手机号或邮箱");
    if (!String(password || "")) return fail(res, "请填写密码");

    const adapter = await adapterOf(v.channelType);
    if (!adapter?.loginWithPassword) return fail(res, `${v.name} 未实现账号密码登录`);

    const isEmail = acc.includes("@");
    let result;
    try {
      result = await adapter.loginWithPassword({
        email: isEmail ? acc : "",
        mobile: isEmail ? "" : acc.replace(/[^\d]/g, ""),
        password,
        areaCode,
        profileSeed: acc,
      });
    } catch (e) {
      await writeLog({ user: req.user, type: LOG_TYPE.ERROR, content: `${v.name} 登录失败（${acc}）：${e.message}` });
      return fail(res, e.message, 400);
    }

    const other = {
      profile: result.profile || null,
      ...(result.cookies?.length ? { cookies: result.cookies } : {}),
      account: isEmail ? acc : `${areaCode} ${acc.slice(0, 3)}****${acc.slice(-4)}`,
    };
    const models = (v.models || []).join(",");

    const targetId = Number(id);
    if (targetId) {
      const [exists] = await pool.query("SELECT id FROM channels WHERE id = ? AND type = ?", [targetId, v.channelType]);
      if (!exists.length) return fail(res, "账号不存在", 404);
      await pool.query(
        "UPDATE channels SET name = ?, api_key = ?, other = ?, status = 1, last_error = '' WHERE id = ?",
        [String(name || acc).slice(0, 64), result.token, JSON.stringify(other), targetId]
      );
      resetChannelState(targetId);
      await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `重新登录 ${v.name} 账号「${name || acc}」` });
      const rows = await listRows();
      return ok(res, toResp(rows.find((r) => r.id === targetId)), "登录成功");
    }

    const [dup] = await pool.query(
      "SELECT id FROM channels WHERE type = ? AND api_key = ? LIMIT 1",
      [v.channelType, result.token]
    );
    if (dup.length) return fail(res, "该账号已存在（登录态重复）");

    const [ret] = await pool.query(
      `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, other, created_time)
       VALUES (?,?,?,?,?, 'default', 1, ?, 1, ?, ?)`,
      [
        String(name || acc).slice(0, 64),
        v.channelType,
        v.baseUrl,
        result.token,
        models,
        Number(priority) || 0,
        JSON.stringify(other),
        now(),
      ]
    );
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `新增 ${v.name} 账号「${name || acc}」` });
    const rows = await listRows();
    return ok(res, toResp(rows.find((r) => r.id === ret.insertId)), "账号已添加");
  })
);

// ---------- 粘贴登录态 ----------
router.post(
  "/paste",
  asyncHandler(async (req, res) => {
    const { vendor = "deepseek", name, token, cookies, priority = 0, id } = req.body || {};
    const v = getVendor(vendor);
    if (!v) return fail(res, "未知厂商");
    if (!v.loginModes.includes("paste")) return fail(res, `${v.name} 不支持粘贴登录态`);

    const t = String(token || "").trim();
    if (!t) return fail(res, "请填写登录态 token");

    const adapter = await adapterOf(v.channelType);
    let verified = null;
    // 若适配器提供校验则先校验（避免存进无效账号）
    if (adapter?.verifyPastedToken) {
      try {
        verified = await adapter.verifyPastedToken({ token: t, cookies });
      } catch (e) {
        return fail(res, e.message, 400);
      }
    }

    let cookieList = [];
    if (cookies) {
      if (Array.isArray(cookies)) cookieList = cookies;
      else {
        try {
          const parsed = JSON.parse(String(cookies));
          cookieList = Array.isArray(parsed) ? parsed : [];
        } catch {
          return fail(res, 'cookies 需要是 JSON 数组，例如 [{"name":"kimi-auth","value":"..."}]');
        }
      }
    }

    const other = {
      ...(verified?.profile ? { profile: verified.profile } : {}),
      ...(cookieList.length ? { cookies: cookieList } : {}),
      ...(verified?.account ? { account: verified.account } : {}),
    };
    const models = (v.models || []).join(",");

    const targetId = Number(id);
    if (targetId) {
      const [exists] = await pool.query("SELECT id FROM channels WHERE id = ? AND type = ?", [targetId, v.channelType]);
      if (!exists.length) return fail(res, "账号不存在", 404);
      await pool.query(
        "UPDATE channels SET name = ?, api_key = ?, other = ?, status = 1, last_error = '' WHERE id = ?",
        [String(name || `账号${targetId}`).slice(0, 64), t, JSON.stringify(other), targetId]
      );
      resetChannelState(targetId);
      await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `更新 ${v.name} 账号 #${targetId} 登录态` });
      const rows = await listRows();
      return ok(res, toResp(rows.find((r) => r.id === targetId)), "登录态已更新");
    }

    const [ret] = await pool.query(
      `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, other, created_time)
       VALUES (?,?,?,?,?, 'default', 1, ?, 1, ?, ?)`,
      [
        String(name || `${v.name} 账号`).slice(0, 64),
        v.channelType,
        v.baseUrl,
        t,
        models,
        Number(priority) || 0,
        JSON.stringify(other),
        now(),
      ]
    );
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `新增 ${v.name} 账号「${name || "未命名"}」` });
    const rows = await listRows();
    return ok(res, toResp(rows.find((r) => r.id === ret.insertId)), "账号已添加");
  })
);

// ---------- 批量导入（仅支持 password 的厂商）----------
router.post(
  "/login/batch",
  asyncHandler(async (req, res) => {
    const { vendor = "deepseek", text = "", priority = 0 } = req.body || {};
    const v = getVendor(vendor);
    if (!v) return fail(res, "未知厂商");
    if (!v.supportsBatch) return fail(res, `${v.name} 不支持批量导入`);
    if (!v.loginModes.includes("password")) return fail(res, `${v.name} 不支持账号密码登录`);

    const adapter = await adapterOf(v.channelType);
    if (!adapter?.loginWithPassword) return fail(res, `${v.name} 未实现账号密码登录`);

    const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return fail(res, "请粘贴账号列表，每行一个，格式：账号----密码");
    if (lines.length > 50) return fail(res, "单次最多 50 个账号");

    const models = (v.models || []).join(",");
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
          profile: r.profile || null,
          ...(r.cookies?.length ? { cookies: r.cookies } : {}),
          account: isEmail ? account : `${account.slice(0, 3)}****${account.slice(-4)}`,
        };
        const [dup] = await pool.query(
          "SELECT id FROM channels WHERE type = ? AND api_key = ? LIMIT 1",
          [v.channelType, r.token]
        );
        if (dup.length) {
          results.push({ account, ok: false, message: "账号已存在" });
          continue;
        }
        const [ret] = await pool.query(
          `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, other, created_time)
           VALUES (?,?,?,?,?, 'default', 1, ?, 1, ?, ?)`,
          [account, v.channelType, v.baseUrl, r.token, models, Number(priority) || 0, JSON.stringify(other), now()]
        );
        results.push({ account, ok: true, id: ret.insertId });
      } catch (e) {
        results.push({ account, ok: false, message: e.message });
      }
      // 间隔，避免触发风控
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }

    const okCount = results.filter((r) => r.ok).length;
    await writeLog({
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `批量登录 ${v.name} 账号：成功 ${okCount} / ${results.length}`,
    });
    return ok(res, { results, ok: okCount, total: results.length }, `成功 ${okCount} 个，失败 ${results.length - okCount} 个`);
  })
);

// ---------- 浏览器登录（浏览器驱动厂商）----------
// 对需要过验证码的厂商，创建账号记录后由页面承载登录；
// 首次可在服务器上跑一次带界面的浏览器完成登录（profile 持久化后长期有效）。
router.post(
  "/browser-login",
  asyncHandler(async (req, res) => {
    const { vendor = "glm", name, priority = 0 } = req.body || {};
    const v = getVendor(vendor);
    if (!v) return fail(res, "未知厂商");
    if (!v.loginModes.includes("browser")) return fail(res, `${v.name} 不需要浏览器登录`);

    const adapter = await adapterOf(v.channelType);
    if (!adapter?.verify) return fail(res, `${v.name} 适配器未就绪`);

    // 先建账号（无 token），再用浏览器验证/登录
    const models = (v.models || []).join(",");
    const [ret] = await pool.query(
      `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, other, created_time)
       VALUES (?,?,?, '', ?, 'default', 1, ?, 1, '{}', ?)`,
      [String(name || `${v.name} 账号`).slice(0, 64), v.channelType, v.baseUrl, models, Number(priority) || 0, now()]
    );

    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [ret.insertId]);
    const channel = rowToChannel(rows[0]);

    try {
      const ms = await adapter.verify(channel);
      // 浏览器就绪，记录指纹
      const st = await pool.query("SELECT other FROM channels WHERE id = ?", [ret.insertId]);
      await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `浏览器登录 ${v.name} 账号成功（${ms}ms）` });
      const fresh = await listRows();
      return ok(res, toResp(fresh.find((r) => r.id === ret.insertId)), `浏览器会话已就绪（${ms}ms）`);
    } catch (e) {
      await pool.query("UPDATE channels SET status = 2, last_error = ? WHERE id = ?", [
        String(e.message).slice(0, 480),
        ret.insertId,
      ]);
      await writeLog({ user: req.user, type: LOG_TYPE.ERROR, content: `${v.name} 浏览器登录失败：${e.message}` });
      return fail(res, `${e.message}（账号已创建但未就绪，可在服务器上手动登录一次）`, 400);
    }
  })
);

// ---------- 编辑 ----------
router.put(
  "/accounts",
  asyncHandler(async (req, res) => {
    const { id, name, priority, status, models } = req.body || {};
    const aid = Number(id);
    if (!aid) return fail(res, "缺少账号 id");
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [aid]);
    if (!rows.length) return fail(res, "账号不存在", 404);

    const fields = [];
    const args = [];
    if (name !== undefined) {
      fields.push("name = ?");
      args.push(String(name).slice(0, 64));
    }
    if (priority !== undefined) {
      fields.push("priority = ?");
      args.push(Number(priority) || 0);
    }
    if (status !== undefined) {
      const s = [1, 2].includes(Number(status)) ? Number(status) : 1;
      fields.push("status = ?");
      args.push(s);
      if (s === 1) resetChannelState(aid);
    }
    if (models !== undefined) {
      const m = Array.isArray(models) ? models.join(",") : String(models);
      if (m.trim()) {
        fields.push("models = ?");
        args.push(m);
      }
    }
    if (!fields.length) return fail(res, "没有需要更新的字段");
    args.push(aid);
    await pool.query(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`, args);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `编辑账号 #${aid}` });
    const fresh = await listRows();
    return ok(res, toResp(fresh.find((r) => r.id === aid)), "已更新");
  })
);

// ---------- 连通性测试 ----------
router.post(
  "/accounts/:id/test",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "账号不存在", 404);
    const channel = rowToChannel(rows[0]);
    const adapter = await adapterOf(channel.type);
    if (!adapter?.verify) return fail(res, "该厂商适配器未就绪");

    try {
      const ms = await adapter.verify(channel);
      await pool.query(
        "UPDATE channels SET response_time = ?, tested_time = ?, status = 1, last_error = '' WHERE id = ?",
        [ms, now(), id]
      );
      resetChannelState(id);
      await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `测试账号「${channel.name}」通过（${ms}ms）` });
      return ok(res, { success: true, time: ms }, `账号可用（${ms}ms）`);
    } catch (e) {
      await pool.query("UPDATE channels SET last_error = ? WHERE id = ?", [String(e.message).slice(0, 480), id]);
      await writeLog({ user: req.user, type: LOG_TYPE.ERROR, content: `测试账号「${channel.name}」失败：${e.message}` });
      return ok(res, { success: false, message: e.message, code: e.code }, `测试失败：${e.message}`);
    }
  })
);

// ---------- 清除异常状态 ----------
router.post(
  "/accounts/:id/reset",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    resetChannelState(id);
    await pool.query("UPDATE channels SET status = 1, last_error = '' WHERE id = ?", [id]);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `重置账号 #${id} 的异常状态` });
    return ok(res, null, "已恢复正常");
  })
);

// ---------- 删除 ----------
router.delete(
  "/accounts/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT name, type FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "账号不存在", 404);

    // 浏览器驱动厂商：顺带关闭其浏览器会话
    const adapter = await adapterOf(rows[0].type);
    if (adapter?.release) await adapter.release(id).catch(() => {});

    await pool.query("DELETE FROM channels WHERE id = ?", [id]);
    resetChannelState(id);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `删除账号「${rows[0].name}」` });
    return ok(res, null, "账号已删除");
  })
);

// ---------- 批量操作 ----------
router.post(
  "/accounts/batch",
  asyncHandler(async (req, res) => {
    const { ids, action } = req.body || {};
    const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
    if (!list.length) return fail(res, "请选择账号");
    const ph = list.map(() => "?").join(",");

    if (action === "enable") {
      await pool.query(`UPDATE channels SET status = 1, last_error = '' WHERE id IN (${ph})`, list);
      list.forEach((id) => resetChannelState(id));
    } else if (action === "disable") {
      await pool.query(`UPDATE channels SET status = 2 WHERE id IN (${ph})`, list);
    } else if (action === "delete") {
      for (const id of list) {
        const [r] = await pool.query("SELECT type FROM channels WHERE id = ?", [id]);
        if (r.length) {
          const ad = await adapterOf(r[0].type);
          if (ad?.release) await ad.release(id).catch(() => {});
        }
      }
      await pool.query(`DELETE FROM channels WHERE id IN (${ph})`, list);
      list.forEach((id) => resetChannelState(id));
    } else if (action === "reset") {
      await pool.query(`UPDATE channels SET status = 1, last_error = '' WHERE id IN (${ph})`, list);
      list.forEach((id) => resetChannelState(id));
    } else {
      return fail(res, "不支持的操作");
    }
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `批量操作账号 ${list.join(",")}：${action}` });
    return ok(res, null, "操作成功");
  })
);

// ---------- 指纹查看 / 重置 ----------
router.get(
  "/accounts/:id/profile",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "账号不存在", 404);
    const other = parseOther(rows[0]);
    return ok(res, { profile: other.profile || null, cookie_count: (other.cookies || []).length });
  })
);

router.post(
  "/accounts/:id/profile/regenerate",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (!rows.length) return fail(res, "账号不存在", 404);
    const other = parseOther(rows[0]);
    // 更换指纹本身是一次"设备变更"，谨慎使用
    const { generateProfile } = await import("./../services/upstream/shared-profile.js");
    other.profile = generateProfile(`${id}:${Date.now()}:${Math.random()}`);
    await pool.query("UPDATE channels SET other = ? WHERE id = ?", [JSON.stringify(other), id]);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `重置账号 #${id} 的设备指纹` });
    return ok(res, { profile: other.profile }, "指纹已重置（下次请求生效）");
  })
);

export default router;
