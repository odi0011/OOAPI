// 候选 dist 的隔离 UI 数据；不读凭据、不连数据库、所有 API 都在 Playwright 路由内结束。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureUser = { id: 1, username: "isolated-admin", display_name: "隔离测试", role: 1000, status: 1, quota: 10000, used_quota: 0 };
export const fixtureStatus = { system_name: "OOAPI", logo: "/icons/openai.svg", favicon: "/icons/openai.svg", unit_per_od: 10000, expose_pricing_to_user: true, registration_enabled: true };
const emptyList = { items: [], total: 0, p: 1, page_size: 20 };

export async function serveCandidate() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ooapi-web/dist");
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      // 静态服务器没有 API，遗漏拦截不能意外请求真实后端。
      if (pathname.startsWith("/api/") || pathname.startsWith("/v1/")) { res.writeHead(404).end(); return; }
      // 部署时默认 Logo 来自服务端，不属于 dist；隔离环境用仓库现有标识供首帧使用。
      if (pathname === "/logo.jpg") {
        res.setHeader("Content-Type", "image/svg+xml");
        res.end(await readFile(path.join(root, "icons/openai.svg"))); return;
      }
      const requested = path.resolve(root, "." + decodeURIComponent(pathname));
      if (!requested.startsWith(root + path.sep) && requested !== root) { res.writeHead(404).end(); return; }
      const filename = path.extname(pathname) ? requested : path.join(root, "index.html");
      const data = await readFile(filename);
      res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" })[path.extname(filename)] || "application/octet-stream");
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: "http://127.0.0.1:" + server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

export function smokeFixtureData(pathname) {
  if (pathname === "/api/status") return fixtureStatus;
  if (pathname === "/api/user/self") return fixtureUser;
  if (pathname.endsWith("/unread")) return { count: 0 };
  if (pathname === "/api/catalog") return { providers: [] };
  if (["/api/channel/", "/api/channel/providers", "/api/channel/groups", "/api/channel/devices/vendors", "/api/token/", "/api/token/groups", "/api/pricing/", "/api/pricing/pending", "/api/pricing/catalog-pending", "/api/community/topics", "/api/chatroom/online", "/api/friends", "/api/friends/requests", "/api/monitor/alert/rules", "/api/monitor/alert/events"].includes(pathname)) return [];
  if (pathname === "/api/channel/stats") return { total: 0, enabled: 0, disabled: 0, byType: {} };
  if (pathname === "/api/chat/sessions") return { sessions: [], counts: { active: 0, archived: 0 } };
  if (pathname === "/api/chat/projects") return { projects: [] };
  if (pathname === "/api/chat/models") return { models: [], groups: [], tokens: [] };
  if (pathname === "/api/chatroom/rooms") return { ...emptyList, rooms: [] };
  if (pathname === "/api/pricing/public") return { models: [], vendors: [], groups: [] };
  if (pathname === "/api/pricing/capabilities") return { items: [], presets: [], reasoningParameters: [] };
  if (pathname === "/api/pricing/attribution") return { models: [], aliases: [], count: 0 };
  if (pathname === "/api/log/usage/summary") return { calls: 0, units: 0, prompt_tokens: 0, completion_tokens: 0, cache_tokens: 0, cache_rate: 0, avg_first_token: 0, avg_elapsed: 0, errors: 0, stopped: 0 };
  if (pathname === "/api/log/usage/filters") return { models: [], tokens: [], groups: [] };
  if (pathname === "/api/dashboard/filters") return { users: [], tokens: [], groups: [] };
  if (pathname.startsWith("/api/profile/u/")) return { user: fixtureUser, profile: fixtureUser, items: [], total: 0, stats: {} };
  if (pathname === "/api/option/") return {};
  if (["/api/users/", "/api/log/usage", "/api/log/operation", "/api/community/posts", "/api/community/notifications", "/api/media/"].includes(pathname)) return { ...emptyList };
  // 其余无数据仪表盘以明确的空对象降级渲染，不创造业务写入。
  return {};
}

export async function installSmokeFixtures(ctx, resolve = smokeFixtureData) {
  const rejectedWrites = [];
  await ctx.addInitScript(() => localStorage.setItem("ooapi-token", "isolated-ui-fixture"));
  await ctx.route("**/api/**", async (route) => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      rejectedWrites.push({ method: request.method(), pathname });
      await route.fulfill({ json: { success: false, message: "隔离只读 UI 冒烟拒绝 API 写入" } }); return;
    }
    await route.fulfill({ json: { success: true, data: await resolve(pathname) } });
  });
  return rejectedWrites;
}
