// 媒体库接口
// ---------------------------------------------------------------------------
// 权限口径：普通用户只能操作自己的；管理员可管理全部。
// 读取走「签名 URL」：聊天消息里的 <img> 带不了 Authorization 头，
// 所以 /:id/raw 允许用 query 签名访问（签名由服务端现签、不落库）。
import express from "express";
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, pageParams } from "../utils.js";
import { authRequired, adminRequired, optionalAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import {
  saveBuffer, getMedia, readBlob, verifyMediaSign, mediaUrl, stats, usedBytes,
  quotaBytes, maxFileBytes, runGc, mediaEnabled, attachRef, releaseRefs, blobPath,
} from "../services/media.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { getNumberOption } from "../config.js";

const router = Router();

// 请求体解析（大包）。
//
// 注意：这里**不能**用全局 preAuthJwt —— 它会先把匿名请求挡掉，
// 而 raw 流与公开头像必须允许匿名访问（<img> 带不了 Authorization，走签名 query）。
// 与 /v1、/api/chat 的差别：那两条路由没有「匿名可达」的端点，所以能全局预鉴权。
// 防大包 DoS 的目的由「各端点自己按需鉴权 + 32MB 上限」满足：
// 上传端点在解析前就有 rateLimit 与 32MB 限制，且上传必须登录（见下方 authRequired）。
router.use(express.json({ limit: "32mb" }));

// 鉴权按端点分开挂，**不能**全局挂 authRequired：
//   · GET /:id/raw        —— 聊天里的 <img> 带不了 Authorization，走签名 query
//   · GET /avatar/:userId —— 头像要在任意页面展示（含未登录的公开页）
// 这两条用 optionalAuth（带令牌就认身份、不带按匿名继续），处理器内部再校验签名/归属。
// 曾经全局挂 authRequired：带合法签名也 401、头像永远显示不出来。
// 其余端点（上传/列表/删除等）一律要求登录。
//
// 路由顺序也很关键：具名子路径必须写在 /:id 之前，
// 否则 DELETE /avatar 会被 DELETE /:id 匹配（id 变成字符串 "avatar"）→ 头像永远删不掉。

// ---------------------------------------------------------------------------
// 公开端点（匿名可达，靠签名或归属校验）
// ---------------------------------------------------------------------------

// 原始文件流
router.get(
  "/:id/raw",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await getMedia(id);
    if (!row) return fail(res, "文件不存在", 404);
    // 三种放行方式：签名有效 / 本人 / 管理员
    const signed = await verifyMediaSign(id, req.query.s);
    const authed = req.user && (Number(row.user_id) === req.user.id || req.user.role >= 100);
    if (!signed && !authed) return fail(res, "无权访问", 403);
    if (Number(row.status) === 2) return fail(res, "文件已删除", 410);
    if (Number(row.status) === 3) return fail(res, "文件已被封禁", 451);

    const buf = await readBlob(row);
    if (!buf) return fail(res, "文件内容缺失（可能已被清理）", 404);

    // 更新最近访问时间（用于识别冷数据；失败不影响下载）
    pool.query("UPDATE media SET last_access_time = ? WHERE id = ?", [now(), id]).catch(() => {});

    const mime = row.mime || "application/octet-stream";
    res.setHeader("content-type", mime);
    // 内容寻址 → 内容永不改变，可以长期强缓存
    res.setHeader("cache-control", "private, max-age=31536000, immutable");
    res.setHeader("x-content-type-options", "nosniff");
    // 只有图片允许内联渲染；其余一律附件下载（防 HTML/脚本被当页面执行）
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(mime);
    if (!inline || String(req.query.download || "") === "1") {
      const name = String(row.orig_name || `${row.sha256.slice(0, 8)}.${row.ext || "bin"}`);
      res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    return res.end(buf);
  })
);

// 公开头像流（无头像 → 404，前端回退首字母色块）
router.get(
  "/avatar/:userId",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const uid = Number(req.params.userId) || 0;
    const [[u]] = await pool.query("SELECT avatar_media_id FROM users WHERE id = ?", [uid]);
    const mid = Number(u?.avatar_media_id) || 0;
    if (!mid) return fail(res, "无头像", 404);
    const row = await getMedia(mid);
    if (!row || Number(row.status) !== 1) return fail(res, "无头像", 404);
    const buf = await readBlob(row);
    if (!buf) return fail(res, "无头像", 404);
    res.setHeader("content-type", row.mime || "image/jpeg");
    // URL 里带 ?v=<mediaId>，换头像即换 URL，所以可以长期强缓存
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.setHeader("x-content-type-options", "nosniff");
    return res.end(buf);
  })
);

// ---------------------------------------------------------------------------
// 以下全部需要登录
// ---------------------------------------------------------------------------
router.use(authRequired);
// 上传
// ---------------------------------------------------------------------------
router.post(
  "/",
  rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.user?.id || req.ip }),
  asyncHandler(async (req, res) => {
    if (!mediaEnabled()) return fail(res, "媒体库功能已关闭", 403);
    const { base64, dataUrl, name, source } = req.body || {};
    // 兼容两种入参：裸 base64 与 dataURL（前端 FileReader 直接产出后者）
    let raw = String(base64 || "");
    let mimeHint = "";
    if (!raw && dataUrl) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl));
      if (m) {
        mimeHint = m[1];
        raw = m[2];
      }
    }
    if (!raw) return fail(res, "缺少文件内容");
    // base64 长度 ≈ 字节数 × 4/3，先按长度挡掉超大文件再解码（避免白解码几百 MB）
    const maxBytes = maxFileBytes();
    if (raw.length > maxBytes * 1.4) {
      return fail(res, `文件过大：上限 ${(maxBytes / 1048576).toFixed(0)}MB`, 413);
    }
    let buf;
    try {
      buf = Buffer.from(raw, "base64");
    } catch {
      return fail(res, "文件内容不是合法的 base64");
    }
    let saved;
    try {
      saved = await saveBuffer({ buffer: buf, userId: req.user.id, origName: name || "", source: source || "" });
    } catch (e) {
      // 业务错误码 → 对应的 HTTP 状态（前端据此提示，而不是笼统 500）
      const code = e.code || "";
      const status = code === "MEDIA_TOO_LARGE" || code === "MEDIA_QUOTA" ? 413 : code === "MEDIA_TYPE" ? 415 : 400;
      return fail(res, e.message, status);
    }
    const st = await stats(req.user.id);
    return ok(res, {
      id: saved.id,
      sha256: saved.sha256,
      size: saved.size,
      mime: saved.mime,
      kind: saved.kind,
      ext: saved.ext,
      width: saved.width,
      height: saved.height,
      orig_name: name || "",
      source: source || "",
      ref_count: 0,
      deduped: saved.deduped,
      url: await mediaUrl(saved.id),
      quota: { used_bytes: st.bytes, quota_bytes: st.quotaBytes },
    }, saved.deduped ? "文件已存在，复用原有记录" : "上传成功");
  })
);

// ---------------------------------------------------------------------------
// 列表 / 详情
// ---------------------------------------------------------------------------
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { p, size, offset } = pageParams(req.query, 24);
    const where = [];
    const params = [];
    // 普通用户强制限定本人；管理员可指定 user_id 或看全部
    if (req.user.role < 100) {
      where.push("user_id = ?");
      params.push(req.user.id);
    } else if (req.query.user_id) {
      where.push("user_id = ?");
      params.push(Number(req.query.user_id));
    }
    if (req.query.kind) {
      where.push("kind = ?");
      params.push(String(req.query.kind).slice(0, 16));
    }
    if (req.query.q) {
      where.push("orig_name LIKE ?");
      params.push(`%${String(req.query.q).slice(0, 64)}%`);
    }
    // 默认只看正常文件；管理员可显式查已删/封禁
    const status = req.query.status !== undefined ? Number(req.query.status) : 1;
    where.push("status = ?");
    params.push(Number.isInteger(status) ? status : 1);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM media ${clause}`, params);
    const [rows] = await pool.query(
      `SELECT id, user_id, size, mime, kind, ext, orig_name, source, width, height, ref_count, status, created_time
         FROM media ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );
    const items = [];
    for (const r of rows) {
      items.push({
        id: Number(r.id),
        user_id: Number(r.user_id),
        size: Number(r.size),
        mime: r.mime,
        kind: r.kind,
        ext: r.ext,
        orig_name: r.orig_name,
        source: r.source,
        width: Number(r.width) || 0,
        height: Number(r.height) || 0,
        ref_count: Number(r.ref_count) || 0,
        status: Number(r.status),
        created_time: Number(r.created_time),
        url: await mediaUrl(r.id),
      });
    }
    return ok(res, { items, total: Number(cnt.n) || 0, page: p, page_size: size });
  })
);

router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    // 普通用户只能看自己；管理员可带 user_id 看指定用户，不带则看全站
    let uid = req.user.id;
    let scope = "self";
    if (req.user.role >= 100) {
      if (req.query.user_id) {
        uid = Number(req.query.user_id);
        scope = "user";
      } else {
        scope = "all";
      }
    }
    if (scope === "all") {
      const [[agg]] = await pool.query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(size),0) AS bytes FROM media WHERE status <> 2"
      );
      const [byKind] = await pool.query(
        "SELECT kind, COUNT(*) AS cnt, COALESCE(SUM(size),0) AS bytes FROM media WHERE status <> 2 GROUP BY kind"
      );
      return ok(res, {
        scope: "all",
        count: Number(agg.cnt) || 0,
        bytes: Number(agg.bytes) || 0,
        quotaBytes: 0,
        maxFileBytes: maxFileBytes(),
        orphanHours: getNumberOption("media_orphan_hours"),
        retentionDays: getNumberOption("media_retention_days"),
        byKind: byKind.map((r) => ({ kind: r.kind, count: Number(r.cnt) || 0, bytes: Number(r.bytes) || 0 })),
      });
    }
    const st = await stats(uid);
    return ok(res, {
      scope,
      ...st,
      maxFileBytes: maxFileBytes(),
      enabled: mediaEnabled(),
    });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await getMedia(req.params.id);
    if (!row) return fail(res, "文件不存在", 404);
    if (Number(row.user_id) !== req.user.id && req.user.role < 100) return fail(res, "无权访问", 403);
    return ok(res, {
      id: Number(row.id),
      user_id: Number(row.user_id),
      sha256: row.sha256,
      size: Number(row.size),
      mime: row.mime,
      kind: row.kind,
      ext: row.ext,
      orig_name: row.orig_name,
      source: row.source,
      width: Number(row.width) || 0,
      height: Number(row.height) || 0,
      ref_count: Number(row.ref_count) || 0,
      status: Number(row.status),
      created_time: Number(row.created_time),
      last_access_time: Number(row.last_access_time) || 0,
      url: await mediaUrl(row.id),
    });
  })
);

// ---------------------------------------------------------------------------
// 改名 / 删除
// ---------------------------------------------------------------------------
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await getMedia(req.params.id);
    if (!row) return fail(res, "文件不存在", 404);
    if (Number(row.user_id) !== req.user.id && req.user.role < 100) return fail(res, "无权操作", 403);
    const name = String(req.body?.orig_name ?? "").trim().slice(0, 255);
    await pool.query("UPDATE media SET orig_name = ?, updated_time = ? WHERE id = ?", [name, now(), row.id]);
    return ok(res, null, "已更新");
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await getMedia(req.params.id);
    if (!row) return fail(res, "文件不存在", 404);
    if (Number(row.user_id) !== req.user.id && req.user.role < 100) return fail(res, "无权操作", 403);
    // 仍被引用时拒绝直接删（除非管理员 force）：否则会话/帖子里的图会变成死链
    const refCount = Number(row.ref_count) || 0;
    const force = req.user.role >= 100 && String(req.query.force || "") === "1";
    if (refCount > 0 && !force) {
      const [refs] = await pool.query(
        "SELECT ref_type, ref_id FROM media_refs WHERE media_id = ? AND is_live = 1 LIMIT 10",
        [row.id]
      );
      return fail(res, `该文件仍被 ${refCount} 处引用，请先删除对应内容（或由管理员强制删除）`, 409, {
        refs: refs.map((r) => ({ ref_type: r.ref_type, ref_id: r.ref_id })),
      });
    }
    if (force) {
      // 管理员强制删除：把活引用一并解绑（否则那些内容会留下死链），
      // 引用记录软删保留，便于事后追溯「这个文件曾被谁引用过」
      const [live] = await pool.query("SELECT DISTINCT ref_type FROM media_refs WHERE media_id = ? AND is_live = 1", [row.id]);
      for (const r of live) {
        const [ids] = await pool.query(
          "SELECT ref_id FROM media_refs WHERE media_id = ? AND ref_type = ? AND is_live = 1",
          [row.id, r.ref_type]
        );
        await releaseRefs(r.ref_type, ids.map((x) => x.ref_id));
      }
    }
    await pool.query("UPDATE media SET status = 2, deleted_time = ?, updated_time = ? WHERE id = ?", [
      now(),
      now(),
      row.id,
    ]);
    return ok(res, { id: row.id, status: 2 }, "已删除（保留期后可回收）");
  })
);

// ---------------------------------------------------------------------------
// 头像
// ---------------------------------------------------------------------------
router.post(
  "/avatar",
  asyncHandler(async (req, res) => {
    if (!mediaEnabled()) return fail(res, "媒体库功能已关闭", 403);
    const { base64, dataUrl, media_id: mediaId } = req.body || {};
    let id = Number(mediaId) || 0;

    if (!id) {
      // 直接传 base64：前端 Canvas 裁剪后的结果
      let raw = String(base64 || "");
      if (!raw && dataUrl) {
        const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl));
        if (m) raw = m[2];
      }
      if (!raw) return fail(res, "缺少头像内容");
      const avatarMax = (getNumberOption("media_avatar_max_kb") > 0 ? getNumberOption("media_avatar_max_kb") : 512) * 1024;
      if (raw.length > avatarMax * 1.4) {
        return fail(res, `头像过大：上限 ${(avatarMax / 1024).toFixed(0)}KB（前端应先裁剪压缩）`, 413);
      }
      try {
        const saved = await saveBuffer({
          buffer: Buffer.from(raw, "base64"),
          userId: req.user.id,
          origName: "avatar",
          source: "avatar",
        });
        id = saved.id;
      } catch (e) {
        return fail(res, e.message, 400);
      }
    }

    const row = await getMedia(id);
    if (!row) return fail(res, "文件不存在", 404);
    if (Number(row.user_id) !== req.user.id) return fail(res, "只能使用自己上传的文件作为头像", 403);
    if (!String(row.kind).startsWith("image")) return fail(res, "头像必须是图片");

    const [[u]] = await pool.query("SELECT avatar_media_id FROM users WHERE id = ?", [req.user.id]);
    const oldId = Number(u?.avatar_media_id) || 0;
    if (oldId && oldId !== id) {
      await releaseRefs("avatar", [String(req.user.id)]).catch(() => {});
    }
    await attachRef(id, { userId: req.user.id, refType: "avatar", refId: String(req.user.id), slot: "avatar" });
    await pool.query("UPDATE users SET avatar_media_id = ? WHERE id = ?", [id, req.user.id]);
    return ok(res, { avatar_url: `/api/media/avatar/${req.user.id}?v=${id}` }, "头像已更新");
  })
);

router.delete(
  "/avatar",
  asyncHandler(async (req, res) => {
    await releaseRefs("avatar", [String(req.user.id)]).catch(() => {});
    await pool.query("UPDATE users SET avatar_media_id = 0 WHERE id = ?", [req.user.id]);
    return ok(res, null, "头像已移除");
  })
);

// 公开的头像流已上移到文件顶部（必须匿名可达，见那里的注释）

// ---------------------------------------------------------------------------
// 回收（管理员）
// ---------------------------------------------------------------------------
router.post(
  "/gc",
  adminRequired,
  asyncHandler(async (req, res) => {
    const r = await runGc({ limit: Math.min(1000, Math.max(1, Number(req.body?.limit) || 200)) });
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `媒体库回收：标记待删 ${r.softDeleted} 个、物理清理 ${r.purged} 个`,
    });
    return ok(res, r, `已标记 ${r.softDeleted} 个、清理 ${r.purged} 个`);
  })
);

export default router;
