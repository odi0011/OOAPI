// Harness 工具集
// ---------------------------------------------------------------------------
// 工具的共同约定：
//   · 全部只读（检索 / 读网页）或只影响本会话自己的状态（待办清单），
//     不触碰服务器文件系统与数据库其他表 —— 这是网关能安全暴露工具的边界；
//   · run() 永远返回 { ok, output }，失败也把原因当成「工具结果」交回模型，
//     让模型自己决定换一种查法，而不是让整轮对话崩掉；
//   · 每次工具调用的 token 都通过 ctx.record() 计入本轮账单（用户为真实消耗付费）。
import { assertPublicUrl } from "../../utils.js";
import { runCompletion } from "../execute.js";
import { modelForChannelMatch } from "../models.js";

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
    let res;
    try {
      res = await fetch(u, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "user-agent": "Mozilla/5.0 (compatible; OOAPI-Harness/1.0; +https://github.com/)",
        },
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      target = new URL(loc, u).toString(); // 下一跳继续过 assertPublicUrl
      continue;
    }
    if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
    const type = String(res.headers.get("content-type") || "");
    if (!/text\/|json|xml|javascript/i.test(type)) throw new Error(`不支持的内容类型：${type || "未知"}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > FETCH_MAX_BYTES) throw new Error("页面过大，已放弃读取");
    const body = (await res.text()).slice(0, FETCH_MAX_BYTES);
    return { url: u.toString(), type, body };
  }
  throw new Error("重定向次数过多");
}

const SEARCH_SYS =
  "你是检索助手：根据用户给出的查询做一次联网检索，回报与问题直接相关的要点（3-6 条），" +
  "每条尽量附上来源链接。只输出要点本身，不要写导语与总结。";

export const TOOLS = {
  todowrite: {
    id: "todowrite",
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
    name: "联网检索",
    desc: "用搜索引擎查一次资料，返回要点与来源链接。适合时效性信息、具体数字、外部事实。",
    args: '{"query":"检索关键词"}',
    async run(args, ctx) {
      const query = String(args?.query ?? "").trim().slice(0, 300);
      if (!query) return { ok: false, output: "query 不能为空" };
      if (ctx.searchSupported === false) return { ok: false, output: "当前模型不支持联网检索，请改用 fetch 工具直接读已知网址" };
      const r = await runCompletion({
        model: modelForChannelMatch(ctx.model) || ctx.model,
        prompt: `<｜User｜>${query}`,
        messages: [{ role: "system", content: SEARCH_SYS }, { role: "user", content: query }],
        thinking: false,
        search: true,
        images: [],
        groupName: ctx.groupName,
        signal: ctx.signal,
      });
      ctx.record({ prompt: `${SEARCH_SYS}\n\n${query}`, output: `${r.content || ""}${r.reasoning || ""}`, usage: r.usage });
      const text = clip(r.content || r.reasoning || "", 6000);
      if (!text) return { ok: false, output: "检索没有返回内容" };
      return { ok: true, output: text, meta: { channel: r.channel?.name, elapsed: r.elapsed } };
    },
  },

  fetch: {
    id: "fetch",
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
        return { ok: false, output: `读取失败：${e.message}` };
      }
    },
  },

  task: {
    id: "task",
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
        return { ok: false, output: `子代理执行失败：${e.message}` };
      }
    },
  },
};

export function toolSpecs(ids = []) {
  return ids.map((id) => TOOLS[id]).filter(Boolean).map(({ id, name, desc, args }) => ({ id, name, desc, args }));
}

export async function runTool(id, args, ctx) {
  const tool = TOOLS[id];
  if (!tool) return { ok: false, output: `未知工具：${id}` };
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    // 工具自身异常（上游限流等）不终止整轮：把原因交给模型，它会换一种查法或直接作答
    return { ok: false, output: `工具执行异常：${e.message}` };
  }
}
