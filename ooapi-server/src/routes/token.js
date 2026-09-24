import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, genApiKey, tokenToResponse, randomString, idParam, safeInt } from "../utils.js";
import { authRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";

const router = Router();
router.use(authRequired);

// 可选分组列表（用户创建令牌时选）。
// 绑定值就是**分组名**（分组名全局唯一，且分组可以跨厂商）——
// 旧版是 "厂商:分组名"，现在只在读取历史绑定时做兼容（见 group-rate.parseGroupKey）。
router.get(
  "/groups",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      "SELECT vendor, name, remark, rate, models FROM channel_groups ORDER BY name"
    );
    // 成员账号的厂商集合：前端按「单厂商=单个图标 / 多厂商=折叠态图标」渲染
    const [chans] = await pool.query("SELECT type, group_list, group_name FROM channels");
    const vendorsOf = new Map();
    for (const c of chans) {
      let list = [];
      try {
        const arr = c.group_list ? JSON.parse(c.group_list) : [];
        if (Array.isArray(arr)) list = arr.map((s) => String(s)).filter(Boolean);
      } catch {
        list = c.group_name ? [String(c.group_name)] : [];
      }
      for (const g of list) {
        if (!vendorsOf.has(g)) vendorsOf.set(g, new Set());
        if (c.type) vendorsOf.get(g).add(String(c.type));
      }
    }
    return ok(
      res,
      rows.map((g) => {
        let models = [];
        try {
          const arr = g.models ? JSON.parse(g.models) : [];
          if (Array.isArray(arr)) models = arr.map((s) => String(s)).filter(Boolean);
        } catch {
          /* ignore */
        }
        return {
          // name 既是展示名也是绑定值；vendor 仅用于展示厂商筛选标签
          type: g.name,
          name: g.name,
          vendor: g.vendor || "",
          remark: g.remark || "",
          rate: Number(g.rate) || 1,
          models,
          vendors: [...(vendorsOf.get(g.name) || [])],
        };
      })
    );
  })
);

// 额度/时间上限：BIGINT 本身能存到 9e18，但应用层允许的额度远超实际意义，
// 上限校验防的是 1e20 这类会让写库直接越界 500 的值（expired_time 上限约到 2286 年）
const MAX_QUOTA = 1e15;
const MAX_EXPIRED = 9_999_999_999;

function getSetting(user) {
  return user?.setting ?? {};
}

/**
 * 分组绑定必须是**存在的分组名**：防拼错，也避免绑定到不存在的分组后计费/路由都默默失败。
 *
 * 用户要求（原话）：「我看到有的密钥咋没绑定分组？密钥必须绑定分组，我们没有那个所谓的
 * 公共，以及系统默认池，这玩意给我彻底清掉。」
 *
 * 所以这里**不再允许空值**：以前 `if (!raw) return true` 把空串当成「公共池」放行，
 * 结果是密钥没有分组 → 调度时只能匹配到「没有分组的渠道」→ 那些渠道对这类密钥可见。
 * 现在密钥必须有归属，空串与 default（历史别名）都直接拒绝，由路由层给出可读提示。
 *
 * 兼容历史 "厂商:分组名"：剥掉前缀后按名字校验。
 */
async function validGroupBinding(binding) {
  let raw = String(binding || "").trim();
  if (!raw || raw === "default") return false; // 空/default 不再合法（公共池已废弃）
  const idx = raw.indexOf(":");
  if (idx > 0 && idx < raw.length - 1) raw = raw.slice(idx + 1);
  if (!raw || raw === "default") return false; // 剥前缀后为空也要拒
  const [rows] = await pool.query("SELECT id FROM channel_groups WHERE name = ? LIMIT 1", [raw]);
  return rows.length > 0;
}

// 列表（不返回完整 key）
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM tokens WHERE user_id = ? ORDER BY id DESC", [req.user.id]);
    const items = rows.map((t) => {
      const r = tokenToResponse(t);
      // 掩码只留前缀与后 4 位，避免泄露可用密钥
      return { ...r, key: r.key.slice(0, 3) + "******************" + r.key.slice(-4) };
    });
    // 已删除密钥花掉的钱：**必须显式告诉用户**，否则对账永远差一截。
    //
    // 人格实测报的（小团队负责人）：「我删了三把用过的测试钥匙。
    //   工作台『已用额度』= 51 单位；令牌管理里所有钥匙『已用』加总 = 39 单位。
    //   差的 12 个单位，就是被我删掉那几把钥匙花掉的钱。钥匙删了，钱还留在账户上，
    //   但再也加不回来。我月底对账，一对就是差一截。」
    //
    // 根因：删令牌是**物理删除**（DELETE FROM tokens），而花费记在账户的
    // used_quota 上 —— 删掉的那把 Key 花过的钱不再属于任何现存行，
    // 于是「可见的行加总 ≠ 账户总额」。这个差不是 bug（钱确实花了），
    // 但用户看不见它，就只会当成「系统算错了」。
    // 这里把差额算出来显式返回，前端把它作为「(另有已删除密钥 N)」展示。
    // 对账差额（= 账户已用 − 现存 Key 已用之和）：**另走一个轻量接口**
    // `/token/reconcile` 返回，不塞进这里 —— 列表接口的 data 必须是数组，
    // 前端多处直接当数组用（`setItems(data)`），改形状会连带改前端与所有测试。
    return ok(res, items);
  })
);

// 获取单个令牌的完整 key
router.get(
  "/:id/key",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "令牌不存在", 404);
    const [rows] = await pool.query("SELECT * FROM tokens WHERE id = ? AND user_id = ?", [id, req.user.id]);
    if (!rows.length) return fail(res, "令牌不存在", 404);
    return ok(res, { key: rows[0].key_str });
  })
);

// 新建
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const {
      name = "",
      remain_quota = 0,
      unlimited_quota,
      expired_time = -1,
      model_limits = [],
      group_name = "",
    } = req.body || {};
    // 「无限额度」的默认值：**给了 remain_quota 就按有限额度处理**，否则无限。
    //
    // 原实现把 unlimited_quota 默认写死 true，于是 `{remain_quota: 100}` 会得到
    // 一把**无限额度**的 Key —— 你设的额度被静默忽略（实测踩到：黑盒测试建了一把
    // `remain_quota=1` 的 Key，用它在并发下跑满 20 次请求，额度一滴没扣，
    // 因为 unlimited_quota 默认为 1，`holdTokenQuota` 按设计对无限 Key 直接放行）。
    // 前端表单两个字段一起提交所以没暴露，但直连 API / 脚本会踩。
    // 语义改为：显式传了 unlimited_quota 就听它的；没传但传了 remain_quota
    // （哪怕是 0）就视为有限额度；两者都没传才是无限。
    const unlimitedGiven = unlimited_quota !== undefined;
    const remainGiven = req.body?.remain_quota !== undefined;
    const unlimitedVal = unlimitedGiven ? Boolean(unlimited_quota) : !remainGiven;
    if (String(name).length > 64) return fail(res, "名称过长");
    // 数值严格校验：NaN/Infinity/负数一律拒绝（strict 模式下写库会直接 500）
    const remainVal = Number(remain_quota);
    const expiredVal = Number(expired_time);
    if (!Number.isFinite(remainVal) || remainVal < 0 || remainVal > MAX_QUOTA) return fail(res, "额度无效");
    if (!Number.isFinite(expiredVal) || expiredVal > MAX_EXPIRED) return fail(res, "过期时间无效");
    if (!(await validGroupBinding(group_name))) {
      return fail(res, "请为该密钥选择一个分组（已取消「公共池」，密钥必须归属某个分组）");
    }
    const key = genApiKey();
    const [ins] = await pool.query(
      `INSERT INTO tokens (user_id, name, key_str, status, created_time, accessed_time, expired_time,
        remain_quota, unlimited_quota, used_quota, model_limits, group_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user.id,
        String(name).trim() || `令牌 ${randomString(4)}`,
        key,
        1,
        now(),
        0,
        Number(expiredVal),
        Number(remainVal),
        unlimitedVal ? 1 : 0,
        0,
        Array.isArray(model_limits) ? model_limits.join(",").slice(0, 2000) : "",
        String(group_name || "").slice(0, 64),
      ]
    );
    // 用 insertId 精确回查：按 user_id ORDER BY id DESC 并发时会返回别人刚建的令牌（含完整 Key）
    const [rows] = await pool.query("SELECT * FROM tokens WHERE id = ?", [ins.insertId]);
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `新建令牌「${rows[0].name}」` });
    return ok(res, tokenToResponse(rows[0]), "令牌创建成功");
  })
);

// 更新
router.put(
  "/",
  asyncHandler(async (req, res) => {
    const { id, name, status, remain_quota, unlimited_quota, expired_time, model_limits, group_name } =
      req.body || {};
    // Infinity/NaN 会被 mysql2 原样拼进 SQL；这里必须是安全整数
    const token = safeInt(id, { min: 1 });
    if (!token) return fail(res, "缺少令牌 id");
    const [rows] = await pool.query("SELECT * FROM tokens WHERE id = ? AND user_id = ?", [token, req.user.id]);
    if (!rows.length) return fail(res, "令牌不存在", 404);
    const cur = rows[0];
    // status 只能 1(启用)/2(禁用)/3(过期)；额度与过期时间必须为有限数字
    let statusVal = cur.status;
    if (status !== undefined) {
      statusVal = Number(status);
      if (![1, 2, 3].includes(statusVal)) return fail(res, "状态无效");
    }
    let remainVal = cur.remain_quota;
    if (remain_quota !== undefined) {
      remainVal = Number(remain_quota);
      if (!Number.isFinite(remainVal) || remainVal < 0 || remainVal > MAX_QUOTA) return fail(res, "额度无效");
    }
    let expiredVal = cur.expired_time;
    if (expired_time !== undefined) {
      expiredVal = Number(expired_time);
      if (!Number.isFinite(expiredVal) || expiredVal > MAX_EXPIRED) return fail(res, "过期时间无效");
    }
    if (group_name !== undefined && !(await validGroupBinding(group_name))) {
      return fail(res, "请为该密钥选择一个分组（已取消「公共池」，密钥必须归属某个分组）");
    }
    // 与新建同一口径：没显式传 unlimited_quota 却传了 remain_quota，
    // 视为「想改额度」而不是「保持无限」—— 否则改额度会被静默忽略（见新建处的说明）。
    // 注意只在**当前是无限**并且用户给了有限额度时才自动切换，避免把
    // 「无限 Key 上只想改额度数值」这类意图意外的调用改成有限额度。
    let unlimitedVal = unlimited_quota !== undefined ? (unlimited_quota ? 1 : 0) : cur.unlimited_quota;
    if (unlimited_quota === undefined && remain_quota !== undefined && remainVal > 0 && Number(cur.unlimited_quota) === 1) {
      unlimitedVal = 0;
    }
    const sets = ["name = ?", "status = ?", "unlimited_quota = ?", "expired_time = ?", "model_limits = ?", "group_name = ?"];
    const vals = [
      name !== undefined ? String(name).trim().slice(0, 64) : cur.name,
      statusVal,
      unlimitedVal,
      expiredVal,
      Array.isArray(model_limits) ? model_limits.join(",").slice(0, 2000) : cur.model_limits,
      group_name !== undefined ? String(group_name).slice(0, 64) : cur.group_name,
    ];
    // remain_quota 只有显式提交时才写：整行快照回写会覆盖并发扣费（丢更新）
    if (remain_quota !== undefined) {
      sets.push("remain_quota = ?");
      vals.push(remainVal);
    }
    vals.push(token, req.user.id);
    await pool.query(`UPDATE tokens SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, vals);
    const [fresh] = await pool.query("SELECT * FROM tokens WHERE id = ?", [token]);
    return ok(res, tokenToResponse(fresh[0]), "令牌已更新");
  })
);

// 令牌对账：账户已用额度 vs 现存密钥已用之和
// ---------------------------------------------------------------------------
// 为什么需要它（人格实测报的，小团队负责人）：
//   「我删了三把用过的测试钥匙。工作台『已用额度』= 51 单位；
//     令牌管理里所有钥匙『已用』加总 = 39 单位。差的 12 个单位，
//     就是被我删掉那几把钥匙花掉的钱。钥匙删了，钱还留在账户上，
//     但再也加不回来。我月底对账，一对就是差一截。」
//
// 根因：删令牌是**物理删除**，而花费记在账户的 used_quota 上 ——
// 被删那把 Key 花过的钱不再属于任何现存行，于是「可见行之和 ≠ 账户总额」。
// 钱确实花了，这个差不是账算错，但用户看不见它就只会当成系统出错。
// 这个接口把差额显式报出来，前端在令牌页顶部提示
// 「另有已删除密钥花掉 X」——对得上账，才不会怀疑平台。
//
// 注意放在 `/:id` 之前：Express 按声明顺序匹配，否则 "/reconcile" 会被
// `/:id` 吞掉（idParam 解析失败 → 404「令牌不存在」），这是很典型的路由顺序坑。
router.get(
  "/reconcile",
  authRequired,
  asyncHandler(async (req, res) => {
    const [[u]] = await pool.query("SELECT used_quota FROM users WHERE id = ? LIMIT 1", [req.user.id]);
    const accountUsed = Number(u?.used_quota) || 0;
    const [[k]] = await pool.query(
      "SELECT COALESCE(SUM(used_quota), 0) AS s FROM tokens WHERE user_id = ?",
      [req.user.id]
    );
    const keysUsed = Number(k?.s) || 0;
    return ok(res, {
      account_used_quota: accountUsed,
      keys_used_quota: keysUsed,
      // 差额（正数 = 有已删除密钥花掉的量；负数说明有其他入账来源，同样如实报）
      deleted_used_quota: accountUsed - keysUsed,
    });
  })
);

// 删除
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const token = idParam(req);
    if (!token) return fail(res, "令牌不存在", 404);
    const [ret] = await pool.query("DELETE FROM tokens WHERE id = ? AND user_id = ?", [token, req.user.id]);
    if (!ret.affectedRows) return fail(res, "令牌不存在", 404);
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `删除令牌 #${token}` });
    return ok(res, null, "令牌已删除");
  })
);

export default router;
