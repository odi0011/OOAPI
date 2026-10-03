import { TOOL_PRESENTATIONS } from "./tool-presentation.js";
// Harness 工具集
// ---------------------------------------------------------------------------
// 工具的共同约定：
//   · 全部只读（检索 / 读网页 / 查**自己**的账号）或只影响本会话自己的状态（待办清单），
//     不触碰服务器文件系统；读库的只有 account，且每条 SQL 都带 user_id = 当前用户 ——
//     这是网关能安全暴露工具的边界（模型再怎么被提示注入，也读不到别人的数据）；
//   · 普通失败返回 { ok, output }，把原因当成「工具结果」交回模型；
//     用户主动停止时原样抛出，避免继续调用或吞掉已产生用量；
//   · 每次工具调用的 token 都通过 ctx.record() 计入本轮账单（用户为真实消耗付费）。
import { assertPublicUrl } from "../../utils.js";
import { pool } from "../../db.js";
import { runCompletion, billableFailedCall } from "../execute.js";
import { modelForChannelMatch } from "../models.js";
import { USAGE_SQL } from "../log.js";
import { readBinanceAnalysis } from "../binance-analysis.js";
import { userDataVisibility } from "../user-data-visibility.js";
import { ERROR_CODES, errorHelp, errorInfo } from "../error-codes.js";
import { endpointList, endpointPath } from "../endpoint-audit.js";

const clip = (text, max) => {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n…（内容过长已截断）` : s;
};

const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;

// 不可见内容（脚本/样式/外链资源）先整段丢掉，否则会被当成正文喂给模型
function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 逐跳校验 SSRF 的手动重定向（与 /v1 图片外链同一套判断） */
async function readCapped(res, max) {
  // 不依赖 content-length：分块响应没有该头，必须边读边计数，超限立即取消
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      break;
    }
    text += dec.decode(value, { stream: true });
  }
  return text;
}

async function safeFetch(rawUrl, signal) {
  let target = String(rawUrl || "").trim();
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(target);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const res = await fetch(u, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "user-agent": "Mozilla/5.0 (compatible; OOAPI-Harness/1.0; +https://github.com/)",
        },
      });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel().catch(() => {});
        target = new URL(loc, u).toString(); // 下一跳继续过 assertPublicUrl
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`上游返回 HTTP ${res.status}`);
      }
      const type = String(res.headers.get("content-type") || "");
      if (!/text\/|json|xml|javascript/i.test(type)) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`不支持的内容类型：${type || "未知"}`);
      }
      const len = Number(res.headers.get("content-length") || 0);
      if (len && len > FETCH_MAX_BYTES) {
        await res.body?.cancel().catch(() => {});
        throw new Error("页面过大，已放弃读取");
      }
      const body = (await readCapped(res, FETCH_MAX_BYTES)).slice(0, FETCH_MAX_BYTES);
      return { url: u.toString(), type, body };
    } finally {
      // fetch 只保证响应头已到；超时与停止必须一直覆盖到响应体读取完。
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  throw new Error("重定向次数过多");
}

const SEARCH_SYS =
  "你是检索助手：根据用户给出的查询做一次联网检索，回报与问题直接相关的要点（3-6 条），" +
  "每条尽量附上来源链接。只输出要点本身，不要写导语与总结。";

/** 工具失败仍可交回模型，但它已经产生的上游用量必须进入本轮账单。 */
export function recordFailedCall(err, ctx, fallback = {}) {
  if (!err || err.billingRecorded || typeof ctx?.record !== "function") return false;
  const call = billableFailedCall(err, { model: ctx.model, ...fallback });
  if (!call) return false;
  ctx.record(call);
  // 停止时同一个错误会继续冒泡到路由；路由不能再合成一条相同的失败调用。
  err.billingRecorded = true;
  return true;
}

export const TOOLS = {
  binance: {
    id: "binance",
    presentation: TOOL_PRESENTATIONS.binance,
    name: "我的币安",
    desc: "只读查询当前用户自己的币安账户、权益、仓位、订单、策略、风控与回测；分析方向敞口、杠杆、保证金、强平距离和止盈止损。数据按当前登录用户隔离，不返回密钥，不执行交易。",
    args: '{"action":"accounts|overview|positions|orders|strategies|risk|backtests|analysis","account_id":"可选正整数；省略时读取本人全部启用账户，先用accounts查看编号"}',
    async run(args, ctx) {
      try { return { ok: true, output: clip(JSON.stringify(await readBinanceAnalysis(args, ctx)), 24000) }; }
      catch (e) { if (ctx.signal?.aborted) throw e; return { ok: false, output: `币安查询失败：${e.message}` }; }
    },
  },
  todowrite: {
    id: "todowrite",
    presentation: TOOL_PRESENTATIONS.todowrite,
    name: "待办清单",
    desc: "创建/更新本会话的待办清单（全量覆盖）。任务超过 3 步时用它把计划显式化，并让用户看到进度。",
    args: '{"todos":[{"content":"步骤描述","status":"pending|in_progress|completed"}]}',
    async run(args) {
      const raw = Array.isArray(args?.todos) ? args.todos : [];
      if (!raw.length) return { ok: false, output: "todos 不能为空；如需清空请提交空列表以外的做法（本工具只接受非空清单）" };
      const todos = raw.slice(0, 20).map((t) => ({
        content: String(t?.content ?? "").trim().slice(0, 200),
        status: ["pending", "in_progress", "completed"].includes(t?.status) ? t.status : "pending",
      }));
      if (todos.some((t) => !t.content)) return { ok: false, output: "每个待办都要有 content" };
      // 只允许一个进行中：多个 in_progress 会让进度展示失去意义
      let running = false;
      for (const t of todos) {
        if (t.status === "in_progress") {
          if (running) t.status = "pending";
          running = true;
        }
      }
      return { ok: true, output: `已更新待办清单（${todos.length} 项）`, todo: todos };
    },
  },

  search: {
    id: "search",
    presentation: TOOL_PRESENTATIONS.search,
    name: "联网检索",
    desc: "用搜索引擎查一次资料，返回要点与来源链接。适合时效性信息、具体数字、外部事实。",
    args: '{"query":"检索关键词"}',
    async run(args, ctx) {
      const query = String(args?.query ?? "").trim().slice(0, 300);
      if (!query) return { ok: false, output: "query 不能为空" };
      if (ctx.searchSupported === false) return { ok: false, output: "当前模型不支持联网检索，请改用 fetch 工具直接读已知网址" };
      const startedAt = Date.now();
      let firstTokenAt = 0;
      let output = "";
      const capture = (text) => {
        if (!text) return;
        if (!firstTokenAt) firstTokenAt = Date.now();
        output += text;
      };
      let r;
      try {
        r = await runCompletion({
          model: modelForChannelMatch(ctx.model) || ctx.model,
          prompt: `<｜User｜>${query}`,
          messages: [{ role: "system", content: SEARCH_SYS }, { role: "user", content: query }],
          thinking: false,
          search: true,
          images: [],
          groupName: ctx.groupName,
          channelType: ctx.channelType || "",
          user: ctx.user,
          signal: ctx.signal,
          onDelta: capture,
          onReasoning: capture,
        });
      } catch (e) {
        e.billingPrompt = `${SEARCH_SYS}\n\n${query}`;
        e.billingOutput = output || e.billingOutput || "";
        e.billingStartedAt = startedAt;
        e.billingFirstTokenAt = firstTokenAt;
        recordFailedCall(e, ctx);
        throw e;
      }
      ctx.record({
        prompt: `${SEARCH_SYS}\n\n${query}`,
        output: `${r.content || ""}${r.reasoning || ""}`,
        usage: r.usage,
        channel: r.channel?.name || "",
        channelId: Number(r.channel?.id) || 0,
        channelQuote: r.channelQuote,
        startedAt,
        firstTokenAt,
        elapsed: r.elapsed,
        retryCount: r.retryCount,
        model: r.billModel || ctx.model,
        requestedModel: ctx.model,
        upstreamModel: r.upstreamModel || "",
        upstreamEndpoints: r.upstreamEndpoints || [],
        reasoningEffort: r.reasoningEffort || "default",
        reasoningApplied: r.reasoningApplied === true,
        billModel: r.billModel || "",
      });
      const text = clip(r.content || r.reasoning || "", 6000);
      if (!text) return { ok: false, output: "检索没有返回内容" };
      return { ok: true, output: text, meta: { channel: r.channel?.name, elapsed: r.elapsed } };
    },
  },

  fetch: {
    id: "fetch",
    presentation: TOOL_PRESENTATIONS.fetch,
    name: "读取网页",
    desc: "抓取一个公网 URL 并转成纯文本（HTML 会去掉标签）。适合读已知来源的原文，不能访问内网地址。",
    args: '{"url":"https://example.com/page"}',
    async run(args, ctx) {
      const url = String(args?.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, output: "url 必须是 http(s) 绝对地址" };
      try {
        const { url: finalUrl, type, body } = await safeFetch(url, ctx.signal);
        const text = /json|xml|javascript/i.test(type) ? body : htmlToText(body);
        const out = clip(text, 8000);
        if (!out) return { ok: false, output: `${finalUrl} 没有可读文本（可能是纯前端渲染的页面）` };
        return { ok: true, output: `来源：${finalUrl}\n\n${out}` };
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return { ok: false, output: `读取失败：${e.message}` };
      }
    },
  },

  github: {
    id: "github",
    presentation: TOOL_PRESENTATIONS.github,
    name: "读 GitHub",
    desc:
      "读取 GitHub 公开仓库：列目录、读文件、搜代码。适合看开源项目的真实实现与文档。" +
      "只读公开内容（无需登录、不会写任何东西）；私有仓库/需要令牌的场景不支持。",
    args:
      '{"action":"list|file|search","repo":"owner/name","path":"可选，readme 或 src/index.js","ref":"可选分支/标签/commit","query":"action=search 时的关键词"}',
    async run(args, ctx) {
      const action = String(args?.action ?? "file").toLowerCase();
      const repo = String(args?.repo ?? "").trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, output: "repo 必须是 owner/name 形式，例如 facebook/react" };
      const ref = String(args?.ref ?? "").trim();

      // GitHub API 走 JSON，不需要 SSRF 逐跳校验（host 固定），但要设 UA 与超时
      const api = async (path) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const onAbort = () => ctrl.abort();
        if (ctx.signal) {
          if (ctx.signal.aborted) ctrl.abort();
          else ctx.signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
          const res = await fetch(`https://api.github.com${path}`, {
            signal: ctrl.signal,
            headers: {
              accept: "application/vnd.github+json",
              "user-agent": "OOAPI-Harness/1.0",
              ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
            },
          });
          if (res.status === 404) throw new Error("仓库或路径不存在（也可能是私有仓库）");
          if (res.status === 403) throw new Error("GitHub 接口限流（未登录每小时 60 次），请稍后再试");
          if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
          // JSON 解析也会继续读网络；这里读完后才解除超时与外层停止监听。
          return await res.json();
        } finally {
          clearTimeout(timer);
          if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
        }
      };

      try {
        if (action === "list") {
          const path = String(args?.path ?? "").replace(/^\/+|\/+$/g, "");
          const data = await api(`/repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
          const list = Array.isArray(data) ? data : [data];
          if (!list.length) return { ok: false, output: `目录为空：${path || "（根目录）"}` };
          const lines = list.map((f) => `${f.type === "dir" ? "📁" : "📄"} ${f.path}${f.size ? `  (${f.size}B)` : ""}`);
          return { ok: true, output: `${repo}${path ? `/${path}` : ""}${ref ? ` @${ref}` : ""}\n${lines.join("\n")}` };
        }

        if (action === "search") {
          const q = String(args?.query ?? "").trim();
          if (!q) return { ok: false, output: "action=search 时需要 query" };
          const data = await api(`/search/code?q=${encodeURIComponent(`${q} repo:${repo}`)}&per_page=20`);
          const items = data.items || [];
          if (!items.length) return { ok: false, output: `在 ${repo} 里没有搜到「${q}」` };
          const lines = items.map((i) => `${i.path}\n  ${String(i.html_url || "").replace("github.com", "github.com")}`);
          return { ok: true, output: `在 ${repo} 中匹配「${q}」的文件（${data.total_count} 个结果，取前 ${items.length}）：\n${lines.join("\n")}` };
        }

        // 默认：读文件（未指定 path 时读 README）
        let path = String(args?.path ?? "").trim().replace(/^\/+/, "");
        if (!path) {
          for (const name of ["README.md", "readme.md", "README.MD", "README"]) {
            try {
              const j = await api(`/repos/${repo}/contents/${name}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
              if (j?.content) {
                path = name;
                break;
              }
            } catch (e) {
              if (ctx.signal?.aborted) throw e;
              /* 换下一个候选名 */
            }
          }
          if (!path) return { ok: false, output: `${repo} 没有找到 README，请用 action=list 看目录或用 path 指定文件` };
        }
        const data = await api(`/repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
        if (Array.isArray(data)) {
          // 给的是目录：自动转成列表，别让模型以为读到了内容
          const lines = data.map((f) => `${f.type === "dir" ? "📁" : "📄"} ${f.path}`);
          return { ok: true, output: `${path} 是目录，内容如下（请再用 action=file 读具体文件）：\n${lines.join("\n")}` };
        }
        if (!data.content) return { ok: false, output: `${path} 没有可读内容（可能是子模块或超过 1MB）` };
        const text = Buffer.from(String(data.content).replace(/\n/g, ""), "base64").toString("utf8");
        const lang = data.name?.split(".").pop() || "";
        return {
          ok: true,
          output: `${repo}/${path}${ref ? ` @${ref}` : ""}（${data.size}B，.${lang}）\n\n${clip(text, 12000)}`,
        };
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return { ok: false, output: `读取 GitHub 失败：${e.message}` };
      }
    },
  },

  account: {
    id: "account",
    presentation: TOOL_PRESENTATIONS.account,
    name: "我的账号",
    desc:
      "查询**当前用户自己**的账号信息：余额与累计消耗、最近调用记录、API 令牌（不含密钥）、近 7 天用量与模型分布、最近的失败请求。" +
      "用户问「我还剩多少钱 / 最近调用了什么 / 哪个令牌花得多 / 为什么报错」时使用。error_help 查询系统错误码的中文含义及排查建议；不传 error_code 列出完整词典。排错先查 errors，再按码查释义，不把系统分类当成已确认根因，也不猜测上游自定义编号。只读，看不到其他用户。",
    args: '{"action":"overview|recent|tokens|usage|errors|error_help","limit":"recent/errors 可选，默认 10，最多 30","error_code":"error_help 可选，例如 CHANNEL_BAD_REQUEST；省略时列出系统错误词典"}',
    async run(args, ctx) {
      const uid = Number(ctx.user?.id) || 0;
      if (!uid) return { ok: false, output: "当前会话没有登录用户，无法查询账号" };
      const visibility = userDataVisibility(ctx.user);
      const requestedAction = String(args?.action ?? "overview").trim().toLowerCase();
      // balance 是模型常用且已在解析测试出现的写法；必须在真实执行层同样可用。
      const aliases = { balance: "overview", logs: "recent", history: "recent" };
      const action = Object.hasOwn(aliases, requestedAction) ? aliases[requestedAction] : requestedAction;
      const limit = Math.min(30, Math.max(1, Number(args?.limit) || 10));
      if (action === "error_help") {
        return { ok: true, output: args?.error_code ? errorHelp(args.error_code) : "系统错误词典（用 error_help + error_code 查询完整解释）：\n" + Object.entries(ERROR_CODES).map(([code, info]) => `${code}：${info.title}`).join("\n") };
      }
      if ((["recent", "errors"].includes(action) && !visibility.usage_records) || (action === "usage" && !visibility.usage_summary)) {
        return { ok: false, output: "管理员未开放此项数据查看权限" };
      }
      const od = (units) => `${(Number(units || 0) / 10000).toFixed(4).replace(/\.?0+$/, "") || "0"} OD币`;
      const t = (sec) => new Date(Number(sec) * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

      if (action === "overview") {
        const [[u]] = await pool.query(
          "SELECT username, display_name, quota, used_quota, request_count, group_name, created_time FROM users WHERE id = ?",
          [uid]
        );
        if (!u) return { ok: false, output: "账号不存在" };
        const since = Math.floor(Date.now() / 1000) - 86400;
        const [[d]] = visibility.usage_summary ? await pool.query(
          `SELECT COUNT(*) AS n, COALESCE(SUM(quota),0) AS cost FROM logs WHERE user_id = ? AND ${USAGE_SQL} AND created_at >= ?`,
          [uid, since]
        ) : [[{}]];
        const [[k]] = await pool.query("SELECT COUNT(*) AS n, SUM(status = 1) AS on_ FROM tokens WHERE user_id = ?", [uid]);
        return {
          ok: true,
          output: [
            `用户：${u.display_name || u.username}（@${u.username}）`,
            ...(visibility.balance ? [`余额：${od(u.quota)}`] : []),
            ...(visibility.usage_summary ? [`累计消耗：${od(u.used_quota)}，累计请求 ${Number(u.request_count) || 0} 次`,
              `近 24 小时：${Number(d.n) || 0} 次调用，消耗 ${od(d.cost)}`] : []),
            `分组：${u.group_name || "公共"}；API 令牌 ${Number(k.n) || 0} 个（启用 ${Number(k.on_) || 0} 个）`,
            `注册时间：${t(u.created_time)}`,
          ].join("\n"),
        };
      }

      if (action === "recent" || action === "errors") {
        const failureOnly = action === "errors";
        const [rows] = await pool.query(
          `SELECT created_at, type, status, error_code, request_id, model, token_name, prompt_tokens, completion_tokens, quota, elapsed_ms, content${Number(ctx.user?.role) >= 100 ? ", detail" : ""}
             FROM logs WHERE user_id = ? AND ${failureOnly ? "type = 4" : USAGE_SQL} ORDER BY id DESC LIMIT ?`,
          [uid, limit]
        );
        if (!rows.length) return { ok: true, output: action === "errors" ? "最近没有失败的请求" : "还没有调用记录" };
        const lines = rows.map((r) => {
          const summary = !failureOnly
            ? `${t(r.created_at)} · ${r.model || "?"} · 令牌「${r.token_name || "站内对话"}」 · 输入 ${r.prompt_tokens || 0} / 输出 ${r.completion_tokens || 0} tokens · ${od(r.quota)}${r.elapsed_ms ? ` · ${(r.elapsed_ms / 1000).toFixed(1)}s` : ""}${Number(r.type) === 4 ? ` · ${r.status === "stopped" ? "已停止" : "失败"}` : ""}`
            : `${t(r.created_at)} · ${r.model || "?"} · ${visibility.request_content ? String(r.content || "").replace(/\s+/g, " ").slice(0, 160) : "调用失败"}`;
          if (!r.error_code) return summary;
          const diagnosis = [summary, errorHelp(r.error_code)];
          if (r.request_id) diagnosis.push(`请求 ID：${r.request_id}`);
          if (Number(ctx.user?.role) >= 100 && r.detail) {
            let detail = {}; try { detail = JSON.parse(r.detail); } catch { /* 旧明细可能不是 JSON */ }
            if (detail && typeof detail === "object") {
              if (Number(detail.http_status)) diagnosis.push(`上游 HTTP：${Number(detail.http_status)}`);
              const upstreamCode = errorInfo(detail.upstream_error_code).code;
              if (upstreamCode) diagnosis.push(`上游自定义编号：${upstreamCode}（没有已确认映射时，不推断其含义）`);
              const paths = endpointList(detail.upstream_endpoints);
              if (paths.length) diagnosis.push(`上游端点：${paths.join(" → ")}`);
              for (const attempt of (Array.isArray(detail.endpoint_attempts) ? detail.endpoint_attempts : []).slice(0, 12)) {
                const info = errorInfo(attempt?.code);
                diagnosis.push(`端点尝试：${endpointPath(attempt?.endpoint) || "未记录"} · HTTP ${Number(attempt?.status) || "未取得"}${info.code ? ` · ${info.title}（${info.code}）` : ""}`);
              }
            }
          }
          return diagnosis.join("\n");
        });
        return { ok: true, output: `${action === "errors" ? "最近失败的请求" : "最近调用"}（${rows.length} 条，新→旧）：\n${lines.join("\n")}` };
      }

      if (action === "tokens") {
        // **绝不返回 key_str**：模型输出会进聊天记录，密钥一旦出现在对话里就等于泄露
        const [rows] = await pool.query(
          `SELECT name, status, remain_quota, unlimited_quota, used_quota, group_name, expired_time, accessed_time
             FROM tokens WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
          [uid]
        );
        if (!rows.length) return { ok: true, output: "还没有创建 API 令牌（可在「令牌管理」页新建）" };
        const st = { 1: "启用", 2: "禁用", 3: "已过期", 4: "额度用尽" };
        const lines = rows.map(
          (r) =>
            `「${r.name}」 ${st[r.status] || `状态${r.status}`}` +
            (visibility.balance ? ` · 剩余 ${Number(r.unlimited_quota) ? "不限" : od(r.remain_quota)}` : "") +
            (visibility.usage_summary ? ` · 已用 ${od(r.used_quota)}` : "") +
            `${r.group_name ? ` · 分组 ${r.group_name}` : ""}${Number(r.expired_time) > 0 ? ` · ${t(r.expired_time)} 到期` : ""}` +
            `${Number(r.accessed_time) ? ` · 最近使用 ${t(r.accessed_time)}` : ""}`
        );
        return { ok: true, output: `API 令牌（${rows.length} 个，不含密钥）：\n${lines.join("\n")}` };
      }

      if (action === "usage") {
        const since = Math.floor(Date.now() / 1000) - 7 * 86400;
        // 按天聚合用 FLOOR 秒级时间戳（不依赖会话时区）；GROUP BY 与 SELECT 同一表达式，ONLY_FULL_GROUP_BY 下合法
        const [days] = await pool.query(
          `SELECT FLOOR((created_at + 28800) / 86400) AS d, COUNT(*) AS n, COALESCE(SUM(quota),0) AS cost
             FROM logs WHERE user_id = ? AND ${USAGE_SQL} AND created_at >= ?
            GROUP BY FLOOR((created_at + 28800) / 86400) ORDER BY d`,
          [uid, since]
        );
        const [models] = await pool.query(
          `SELECT model, COUNT(*) AS n, COALESCE(SUM(quota),0) AS cost
             FROM logs WHERE user_id = ? AND ${USAGE_SQL} AND created_at >= ? AND model <> ''
            GROUP BY model ORDER BY cost DESC LIMIT 8`,
          [uid, since]
        );
        if (!days.length) return { ok: true, output: "近 7 天没有调用" };
        const dayLines = days.map((r) => {
          // d 是「北京时间的第几天」：d*86400 秒按 UTC 读出的年月日就是北京日期
          const dt = new Date(Number(r.d) * 86400 * 1000);
          return `${dt.getUTCMonth() + 1}-${dt.getUTCDate()}：${r.n} 次，${od(r.cost)}`;
        });
        const modelLines = models.map((r) => `${r.model}：${r.n} 次，${od(r.cost)}`);
        return { ok: true, output: `近 7 天按天（北京时间）：\n${dayLines.join("\n")}\n\n按模型（消耗降序）：\n${modelLines.join("\n")}` };
      }

      return { ok: false, output: `未知 action：${action}；可用 overview / recent / tokens / usage / errors / error_help` };
    },
  },

  task: {
    id: "task",
    presentation: TOOL_PRESENTATIONS.task,
    name: "派发子代理",
    desc: "把一个独立的子任务交给专职子代理（见下方清单），它会把结果整理好返回。用于并行调研、审阅成稿。",
    args: '{"agent":"子代理 id","prompt":"要交办的具体问题（自包含，子代理看不到我们的对话）"}',
    async run(args, ctx) {
      const agentId = String(args?.agent ?? "").trim();
      const prompt = String(args?.prompt ?? "").trim().slice(0, 4000);
      if (!prompt) return { ok: false, output: "prompt 不能为空" };
      if (!ctx.runAgent) return { ok: false, output: "当前上下文不支持派发子代理" };
      try {
        const r = await ctx.runAgent({ agentId, prompt });
        if (!r?.text) return { ok: false, output: "子代理没有产出内容" };
        return { ok: true, output: clip(r.text, 8000) };
      } catch (e) {
        recordFailedCall(e, ctx);
        if (ctx.signal?.aborted) throw e;
        return { ok: false, output: `子代理执行失败：${e.message}` };
      }
    },
  },
};

export function toolSpecs(ids = []) {
  return ids.map((id) => TOOLS[id]).filter(Boolean).map(({ id, name, desc, args, presentation }) => ({ id, name, desc, args, presentation }));
}

// 原生协议用真实类型描述参数，避免模型把说明文字当成参数值。
export function nativeToolSpecs(ids = []) {
  const str = (description) => ({ type: "string", description });
  const schemas = {
    account: { properties: { action: { type: "string", enum: ["overview", "recent", "tokens", "usage", "errors", "error_help"] }, limit: { type: "integer", minimum: 1, maximum: 30 }, error_code: str("系统错误码；error_help 时使用，省略可查看全部错误词典") }, required: ["action"] },
    binance: { properties: { action: { type: "string", enum: ["accounts", "overview", "positions", "orders", "strategies", "risk", "backtests", "analysis"] }, account_id: { type: "integer", minimum: 1 } }, required: ["action"] },
    search: { properties: { query: str("检索关键词") }, required: ["query"] },
    fetch: { properties: { url: str("公开网页 URL") }, required: ["url"] },
    github: { properties: { action: { type: "string", enum: ["list", "file", "search"] }, repo: str("owner/name"), path: str("文件或目录路径"), ref: str("分支、标签或 commit"), query: str("检索关键词") }, required: ["action", "repo"] },
    task: { properties: { agent: str("子代理 id"), prompt: str("自包含的任务说明") }, required: ["agent", "prompt"] },
    todowrite: { properties: { todos: { type: "array", items: { type: "object", properties: { content: str("步骤描述"), status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"], additionalProperties: false } } }, required: ["todos"] },
  };
  return toolSpecs(ids).map((t) => ({ name: t.id, description: t.desc, parameters: { type: "object", ...schemas[t.id], additionalProperties: false } }));
}

export async function runTool(id, args, ctx) {
  const tool = TOOLS[id];
  if (!tool) return { ok: false, output: `未知工具：${id}` };
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, output: "工具参数必须是 JSON 对象" };
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    // 工具自身异常（上游限流等）不终止整轮：把原因交给模型，它会换一种查法或直接作答
    return { ok: false, output: `工具执行异常：${e.message}` };
  }
}
