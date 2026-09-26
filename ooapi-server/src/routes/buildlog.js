// 平台修复进度公示（公开只读，给社区页右侧「修复进度」小盒子用）。
//
// 用户要求（2026-09-26 原话）：「直接做一个窗口……显示实时进度，待办清单，
// 每次有api调用，就实时显示那条记录出来，给用户展示的」—— 即把「我们正在修什么、
// 修到哪了、维护流量长什么样」直接亮给所有用户看（透明运营）。
//
// 数据有两个来源，刻意都不需要管理员身份：
// ① 待办/进度：options 表的 buildlog_state（监工脚本在每轮巡检/每次任务状态变化时
//    直接 UPDATE 这一行 JSON）。这里**不走 config.js 的启动缓存**（loadOptions 只在
//    启动时读一次），而是现查 —— 否则脚本改了数据要等重启才能看见，「实时」就没了。
// ② 维护调用流：logs 表里令牌名以 fb4（测试人群）/ cc（修复进程）开头的最近调用。
//
// 隐私红线（与 T11 同一条规则）：只出模型名/tokens/耗时/花费这类聚合可见字段，
// **绝不出** channel_*（渠道=上游供应商身份）、username、user_agent、ip。
// 模型名全站公开（价格页），花费是平台自己维护令牌的花费，均无泄露面。
import { Router } from "express";
import fsp from "node:fs/promises";
import { pool } from "../db.js";
import { ok, asyncHandler, safeJSONParse } from "../utils.js";

const router = Router();

// 维护侧令牌的白名单前缀。写死前缀而不是拉全表：这个接口是公开的，
// 匹配面越窄越安全 —— 以后新增维护令牌必须用这两个前缀命名。
const MAINT_WHERE = "(token_name LIKE 'fb4%' OR token_name LIKE 'cc%')";

// ---------------------------------------------------------------------------
// 修复进程（Claude Code）的实时对话回显。
// 用户要求（2026-09-26 原话）：「需要实时流式的回显Claude code的对话消息，所有」。
// 实现不走进程内通道，直接 tail CC 的运行日志（/root/cc-tasks/latest.log 是指向
// 本次 run-*.log 的软链）：前端带 since_bytes 游标轮询，这里只回增量。
//
// 隐私处理：日志是逐字回显，必须在出口打码 ——
//   · sk- 开头的平台密钥（探针/CC 都用 sk- 令牌，日志里可能出现）
//   · password= / password: 后面的值（SQL、curl 示例里可能带）
// 渠道名可能出现在 CC 读的代码里 —— 那是「它正在处理的内容」本身，
// 用户要求展示全部对话，这里照实回显（渠道表本身对普通用户不可读，读日志≠给接口）。
const CC_LOG = "/root/cc-tasks/latest.log";
const CC_CHUNK_MAX = 8192; // 单次最多回 8KB，防止一次拉爆
const CC_REDACT = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***"],
  [/(password\s*[=:]\s*)["']?[^"'\s]+/gi, "$1***"],
];

function ccTail(since) {
  return fsp
    .readFile(CC_LOG) // 跟随软链；文件不存在/无权限都走 catch
    .then(async (buf) => {
      const size = buf.length;
      const start = Math.min(since, size);
      let chunk = buf.subarray(start, Math.min(start + CC_CHUNK_MAX, size)).toString("utf8");
      for (const [re, rep] of CC_REDACT) chunk = chunk.replace(re, rep);
      // mtime 给前端判断「进程是否空闲」：15 分钟没动静就不该装作还在直播
      let mtime = 0;
      try { mtime = Math.floor((await fsp.stat(CC_LOG)).mtimeMs / 1000); } catch { /* ignore */ }
      return { cursor: start + Buffer.byteLength(chunk, "utf8"), chunk, size, mtime, alive: true };
    })
    .catch(() => ({ cursor: since, chunk: "", size: 0, mtime: 0, alive: false }));
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const since = Math.max(0, Number(req.query.cc_since) || 0);
    const [[opt]] = await pool.query("SELECT value FROM options WHERE key_str = 'buildlog_state'");
    const state = safeJSONParse(opt?.value, {}) || {};

    const [calls, cc] = await Promise.all([
      pool.query(
        `SELECT model, type, prompt_tokens, completion_tokens, cache_tokens,
              quota AS cost_units, elapsed_ms, first_token_ms, created_at
         FROM logs
        WHERE ${MAINT_WHERE}
        ORDER BY id DESC
        LIMIT 10`
      ),
      ccTail(since),
    ]);

    return ok(res, {
      updated_at: Number(state.updated_at) || 0,
      // 修复线程的一句话状态（如「当前被网关 tools 缺陷阻塞」），由监工脚本维护
      thread: String(state.thread || ""),
      tasks: Array.isArray(state.tasks) ? state.tasks : [],
      calls: calls[0].map((r) => ({
        model: r.model || "",
        // type=4 是错误记录：也照实展示（真实含失败，才像「实时」）
        ok: Number(r.type) !== 4,
        prompt_tokens: Number(r.prompt_tokens) || 0,
        completion_tokens: Number(r.completion_tokens) || 0,
        cache_tokens: Number(r.cache_tokens) || 0,
        // 10,000 单位 = 1 OD币（全站唯一币制规则，见 AGENTS.md）。
        // 列名注意：logs 表的消耗列线上叫 quota（历史命名），本地 CREATE TABLE 里的
        // cost_units 是注释性别名 —— 上面 SELECT 里已用 `quota AS cost_units` 对齐。
        od: Number(r.cost_units || 0) / 10000,
        elapsed_ms: Number(r.elapsed_ms) || 0,
        first_token_ms: Number(r.first_token_ms) || 0,
        created_at: Number(r.created_at) || 0,
      })),
      // Claude Code 实时对话增量（since_bytes 游标协议：前端回传上次 cursor）
      cc: cc.alive ? cc : null,
    });
  })
);

export default router;
