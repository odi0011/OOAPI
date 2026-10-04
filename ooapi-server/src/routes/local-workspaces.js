import { Router, json } from "express";
import { authRequired } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { localWorkspaces } from "../services/harness/local-workspaces.js";
import { ok, fail, asyncHandler } from "../utils.js";
import { companionArchive } from "../services/harness/local-companion-download.js";

export function localWorkspaceRouter(service = localWorkspaces) {
  const router = Router();
  router.use(json({ limit: "4mb" }));
  router.get("/download", asyncHandler(async (_req, res) => { const archive = await companionArchive(); res.set("Content-Type", "application/zip").set("Content-Disposition", 'attachment; filename="ooapi-companion.zip"').send(archive); }));
  const pairingLimit = rateLimit({ windowMs: 60000, max: 10, keyPrefix: "local-pair" });
  router.post("/pair/start", pairingLimit, asyncHandler(async (_req, res) => ok(res, await service.startPairing())));
  router.post("/pair/confirm", authRequired, pairingLimit, asyncHandler(async (req, res) => ok(res, await service.confirmPairing(req.user.id, req.body?.code))));
  router.get("/workspaces", authRequired, asyncHandler(async (req, res) => ok(res, { workspaces: await service.list(req.user.id) })));
  router.get("/sessions/:id", authRequired, asyncHandler(async (req, res) => ok(res, await service.get(req.user.id, req.params.id))));
  router.put("/sessions/:id", authRequired, asyncHandler(async (req, res) => ok(res, await service.bind(req.user.id, req.params.id, req.body?.workspaceId ?? null))));
  router.delete("/devices/:id", authRequired, asyncHandler(async (req, res) => { await service.revoke(req.user.id, req.params.id); return ok(res); }));
  router.use("/runner", asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization || "";
    req.localDevice = await service.deviceFromBearer(header.startsWith("Bearer ") ? header.slice(7) : "", req.path === "/status");
    next();
  }));
  router.post("/runner/status", (_req, res) => ok(res, { paired: Boolean(_req.localDevice), userId: _req.localDevice?.user_id || null }));
  router.post("/runner/register", asyncHandler(async (req, res) => ok(res, await service.register(req.localDevice, req.body?.workspaces))));
  router.post("/runner/poll", asyncHandler(async (req, res) => {
    const ctrl = new AbortController();
    const close = () => { if (!res.writableEnded) ctrl.abort(); };
    res.on("close", close);
    try { const value = await service.poll(req.localDevice, Array.isArray(req.body?.active) ? req.body.active : [], ctrl.signal); if (!ctrl.signal.aborted) ok(res, value); }
    finally { res.off("close", close); }
  }));
  router.post("/runner/results", asyncHandler(async (req, res) => ok(res, service.result(req.localDevice, req.body))));
  // 不把参数/终端输出写进通用错误日志，也不返回原始数据库错误。
  router.use((err, _req, res, _next) => fail(res, err.code?.startsWith("LOCAL_") ? err.message : "本地工作区请求失败。", err.status || 500));
  return router;
}
export default localWorkspaceRouter();
