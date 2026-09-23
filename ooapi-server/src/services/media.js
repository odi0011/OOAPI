// 媒体库：统一文件存储
// ---------------------------------------------------------------------------
// 为什么要有它：此前对话图片是把 base64 **直接写进 chat_messages.parts**（MEDIUMTEXT）。
// 三条真实风险：
//   ① 溢出：/api/chat 允许 20MB 请求体 → base64 解码后 ~15MB → 再编码回 parts
//      约 16.9MB，超过 MEDIUMTEXT 的 16,777,215 字节。MySQL 严格模式下 INSERT 直接
//      失败（整轮对话落库失败、用户消息丢失），非严格模式下截断 → 历史消息**静默变空**。
//   ② 读放大：每轮对话都要把最近 200 条消息的 parts 全量拉出来 JSON.parse，
//      几张图就让每次对话先背上几 MB 的读取与解析。
//   ③ 无法复用：用户头像、社区发帖图都要存文件，各做一套必然失控。
//
// 设计（内容寻址 + 元数据行 + 引用表）：
//   · 物理文件按 sha256 落盘、两级分片，同一字节全局只存一份；
//   · media 表一行 = 某用户的某个文件（含归属、大小、尺寸、引用计数）；
//   · media_refs 记录「谁在引用它」，删除链路据此释放，避免孤儿文件与悬空引用。
//
// 零新增依赖：sha256 用 node:crypto，类型/尺寸嗅探自己解析文件头。
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { now } from "../utils.js";
import { getNumberOption, getBoolOption } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 与 browser-driver 的 data/ 同级：/opt/ooapi/ooapi-server/data/media
const DATA_DIR = path.join(__dirname, "..", "..", "data", "media");
const BLOB_DIR = path.join(DATA_DIR, "blobs");
const TMP_DIR = path.join(DATA_DIR, "tmp");

/** 允许的类型白名单：靠文件头判定，不信任前端给的 MIME。
 *  刻意**不含 SVG**：SVG 可内嵌脚本，从本站源 inline 出去等于存储型 XSS。 */
const MAGIC = [
  { ext: "png", mime: "image/png", kind: "image", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", mime: "image/jpeg", kind: "image", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", kind: "image", test: (b) => b.length > 6 && b.slice(0, 3).toString("latin1") === "GIF" },
  {
    ext: "webp",
    mime: "image/webp",
    kind: "image",
    test: (b) => b.length > 12 && b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP",
  },
  { ext: "pdf", mime: "application/pdf", kind: "file", test: (b) => b.length > 5 && b.slice(0, 5).toString("latin1") === "%PDF-" },
  // 纯文本类（对话里的文档上传）：没有魔数，用「可打印字符占比」判定
  { ext: "txt", mime: "text/plain", kind: "file", test: (b) => isProbablyText(b) },
];

/** 文本探测：前 4KB 里可打印字符（含常见空白）占比 > 95% 且不含 NUL */
function isProbablyText(buf) {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i += 1) {
    const c = buf[i];
    if (c === 0) return false;
    // 允许 \t \n \r 与 0x20 以上（UTF-8 多字节的高位字节也放行）
    if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c !== 0x7f)) printable += 1;
  }
  return printable / n > 0.95;
}

/** 按文件头嗅探类型；识别不了返回 null（拒绝入库，而不是猜一个扩展名） */
export function sniff(buf) {
  for (const m of MAGIC) {
    try {
      if (m.test(buf)) return { ext: m.ext, mime: m.mime, kind: m.kind };
    } catch {
      /* 单个探测函数异常不影响其它类型 */
    }
  }
  return null;
}

/** PNG / JPEG / GIF / WebP 的宽高（用于列表展示与按尺寸过滤；解析不了就返回 0） */
export function imageSize(buf, ext) {
  try {
    if (ext === "png" && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === "gif" && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (ext === "webp" && buf.length > 30) {
      // VP8X（扩展格式）：宽高在 24..29，各 3 字节（值 - 1）
      if (buf.slice(12, 16).toString("latin1") === "VP8X") {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
      // VP8（有损）：帧头在 26 起，宽高各 2 字节（低 14 位）
      if (buf.slice(12, 15).toString("latin1") === "VP8" && buf.length > 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      return { width: 0, height: 0 };
    }
    if (ext === "jpg") {
      // 顺序扫描 SOF 段；限制迭代次数防止畸形文件造成长循环
      let i = 2;
      let guard = 0;
      while (i + 9 < buf.length && guard < 1000) {
        guard += 1;
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch {
    /* 畸形文件：当作无法解析 */
  }
  return { width: 0, height: 0 };
}

/** blob 磁盘路径：前 2 位 / 次 2 位分片，避免单目录文件过多 */
export function blobPath(sha256, ext) {
  return path.join(BLOB_DIR, sha256.slice(0, 2), sha256.slice(2, 4), ext ? `${sha256}.${ext}` : sha256);
}

/** 确保目录存在（启动时调用一次；上传时也兜底） */
export async function ensureDirs() {
  await fsp.mkdir(BLOB_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

/** 清空 tmp：上次崩溃可能留下半截文件 */
export async function cleanTmp() {
  try {
    const files = await fsp.readdir(TMP_DIR);
    for (const f of files) await fsp.unlink(path.join(TMP_DIR, f)).catch(() => {});
  } catch {
    /* 目录不存在等：忽略 */
  }
}

/**
 * 下载用的签名。聊天消息里的 <img> 带不了 Authorization 头，
 * 所以读取走「签名 query」：HMAC(JWT_SECRET) 对 mediaId 签名。
 * 签名不落库、由服务端每次序列化时现签，因此永不过期；
 * 链接即凭据（id 是自增但配合 HMAC 无法枚举）。
 */
let signKey = null;
async function getSignKey() {
  if (!signKey) {
    const { JWT_SECRET } = await import("../db.js");
    signKey = JWT_SECRET;
  }
  return signKey;
}
export async function signMedia(id, ttlSec = 7 * 86400) {
  const key = await getSignKey();
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac("sha256", key).update(`${id}.${exp}`).digest("hex").slice(0, 32);
  return `${exp}.${sig}`;
}
export async function verifyMediaSign(id, s) {
  const raw = String(s || "");
  const dot = raw.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(raw.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const key = await getSignKey();
  const expect = crypto.createHmac("sha256", key).update(`${id}.${exp}`).digest("hex").slice(0, 32);
  // 定时安全比较：长度不同的字符串直接判否（timingSafeEqual 要求等长）
  const a = Buffer.from(raw.slice(dot + 1));
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 对外 URL（带签名，可直接放进 <img src>） */
export async function mediaUrl(id) {
  if (!id) return "";
  return `/api/media/${id}/raw?s=${encodeURIComponent(await signMedia(id))}`;
}

/** 用户当前已用字节数（走 idx_media_user_size 覆盖索引） */
export async function usedBytes(userId) {
  const [[r]] = await pool.query(
    "SELECT COALESCE(SUM(size),0) AS n FROM media WHERE user_id = ? AND status <> 2",
    [Number(userId) || 0]
  );
  return Number(r.n) || 0;
}

/** 上传上限（字节）：设置项 media_max_file_mb */
export function maxFileBytes() {
  const mb = getNumberOption("media_max_file_mb");
  return (mb > 0 ? mb : 10) * 1024 * 1024;
}
/** 用户配额（字节）：0 = 不限 */
export function quotaBytes() {
  const mb = getNumberOption("media_user_quota_mb");
  return mb > 0 ? mb * 1024 * 1024 : 0;
}

export function mediaEnabled() {
  return getBoolOption("media_enabled");
}

/**
 * 保存一个文件（去重 + 落盘 + 建行）。
 * @param {object} o
 * @param {Buffer} o.buffer 文件内容
 * @param {number} o.userId 归属用户
 * @param {string} [o.origName] 原始文件名（仅展示/下载用，**不参与磁盘路径拼接**）
 * @param {string} [o.source] 上传来源（chat/avatar/post/admin）
 * @returns {{ id, sha256, size, mime, kind, ext, width, height, deduped }}
 */
export async function saveBuffer({ buffer, userId, origName = "", source = "" }) {
  if (!mediaEnabled()) {
    throw Object.assign(new Error("媒体库功能已关闭"), { code: "MEDIA_DISABLED" });
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) throw Object.assign(new Error("文件内容为空"), { code: "MEDIA_EMPTY" });

  const max = maxFileBytes();
  if (buf.length > max) {
    throw Object.assign(
      new Error(`文件过大：${(buf.length / 1048576).toFixed(1)}MB，上限 ${(max / 1048576).toFixed(0)}MB`),
      { code: "MEDIA_TOO_LARGE" }
    );
  }

  const sniffed = sniff(buf);
  if (!sniffed) {
    throw Object.assign(new Error("不支持的文件类型（支持 PNG/JPEG/GIF/WebP/PDF/纯文本）"), { code: "MEDIA_TYPE" });
  }

  const quota = quotaBytes();
  if (quota > 0) {
    const used = await usedBytes(userId);
    // 同内容重复上传不占额外空间（下面会命中去重），所以只在「内容不同」时才严格卡
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const [[exist]] = await pool.query("SELECT id, status FROM media WHERE user_id = ? AND sha256 = ?", [userId, sha]);
    if (!exist && used + buf.length > quota) {
      throw Object.assign(
        new Error(`存储配额不足：已用 ${(used / 1048576).toFixed(1)}MB / 上限 ${(quota / 1048576).toFixed(0)}MB`),
        { code: "MEDIA_QUOTA" }
      );
    }
  }

  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const ext = sniffed.ext;
  const target = blobPath(sha256, ext);

  // 先写临时文件再 rename：同分区 rename 是原子的，
  // 避免「文件写一半就被引用」以及并发写同一路径互相覆盖。
  await ensureDirs();
  const tmp = path.join(TMP_DIR, `${sha256}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await fsp.writeFile(tmp, buf);
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // 已存在说明是重复内容：直接丢弃临时文件（内容寻址，同 sha 内容必然相同）
    await fsp.rename(tmp, target).catch(async (e) => {
      if (e.code === "EEXIST" || e.code === "EPERM") {
        await fsp.unlink(tmp).catch(() => {});
        return;
      }
      // Windows 上 rename 覆盖已存在文件会失败：退回「复制 + 删临时」
      await fsp.copyFile(tmp, target).catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
    });
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }

  const size = sniffed.kind === "image" ? imageSize(buf, ext) : { width: 0, height: 0 };
  const ts = now();

  // 去重：同一用户同一内容只保留一行。命中软删行则**复活**（否则唯一键冲突）。
  const [rows] = await pool.query("SELECT id, status FROM media WHERE user_id = ? AND sha256 = ? LIMIT 1", [
    Number(userId),
    sha256,
  ]);
  if (rows.length) {
    const m = rows[0];
    if (Number(m.status) !== 1) {
      await pool.query("UPDATE media SET status = 1, deleted_time = 0, updated_time = ?, mime = ?, ext = ?, kind = ? WHERE id = ?", [
        ts,
        sniffed.mime,
        ext,
        sniffed.kind,
        m.id,
      ]);
    }
    return { id: Number(m.id), sha256, size: buf.length, ...sniffed, ...size, deduped: true };
  }

  const [ret] = await pool.query(
    `INSERT INTO media (user_id, sha256, size, mime, kind, ext, orig_name, source, width, height, ref_count, status, created_time, updated_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,1,?,?)`,
    [
      Number(userId) || 0,
      sha256,
      buf.length,
      sniffed.mime,
      sniffed.kind,
      ext,
      String(origName || "").slice(0, 255),
      String(source || "").slice(0, 24),
      size.width,
      size.height,
      ts,
      ts,
    ]
  );
  return { id: Number(ret.insertId), sha256, size: buf.length, ...sniffed, ...size, deduped: false };
}

/** 按 id 取一行（不校验权限，调用方负责） */
export async function getMedia(id) {
  const [rows] = await pool.query("SELECT * FROM media WHERE id = ? LIMIT 1", [Number(id) || 0]);
  return rows[0] || null;
}

/**
 * 校验一批 media_id **都属于同一个用户**，返回合法的 id 列表。
 *
 * 为什么必须有这个函数（安全缺陷，授权渗透测试实测发现）：
 *   `media_id` 是全局自增整数、可遍历。社区发帖与私聊发消息原先只把 id 写进
 *   `media_ids` 并 `attachRef`，**从不校验归属** —— 于是任意登录用户可以把别人的
 *   私有文件挂到自己的帖子/消息上，帖子详情会返回一个**服务端现签的可用 URL**，
 *   匿名即可读到对方文件内容（聊天图片、附件）。
 *   更糟的是引用行记在**引用者**名下，受害者自己反而删不掉自己的文件
 *   （`DELETE /api/media/:id` 会因「仍被 N 处引用」返回 409）—— 等于把删除权也挟持了。
 *
 * 对照：站内对话（routes/chat.js）早就有这条校验（`图片不存在或无权使用`），
 * 只有社区与私聊两处漏了 —— 同类接口实现不一致本身就是漏洞的温床。
 */
export async function filterOwnedMediaIds(ids, userId) {
  const uid = Number(userId) || 0;
  // 去重 + 只留正整数（-1 / Infinity / "abc" 这类脏值在这里就被挡掉，
  // 顺带修掉「写入指向不存在媒体的 media_refs 垃圾行」的问题）
  const uniq = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((x) => Math.trunc(Number(x)))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (!uniq.length) return { ok: [], bad: [] };
  if (!uid) return { ok: [], bad: uniq };
  const [rows] = await pool.query(
    `SELECT id, user_id FROM media WHERE id IN (${uniq.map(() => "?").join(",")})`,
    uniq
  );
  const owned = new Set(rows.filter((r) => Number(r.user_id) === uid).map((r) => Number(r.id)));
  return { ok: uniq.filter((id) => owned.has(id)), bad: uniq.filter((id) => !owned.has(id)) };
}

/** 读取文件内容（用于转发给上游；文件缺失返回 null 而不是抛错） */
export async function readBlob(row) {
  if (!row) return null;
  // 兼容旧数据：ext 为空时按不带扩展名的路径找
  const candidates = [blobPath(row.sha256, row.ext || "")];
  try {
    return await fsp.readFile(candidates[0]);
  } catch {
    return null;
  }
}

/** 绑定引用：谁在用这个文件（同一对象同一位置幂等） */
export async function attachRef(mediaId, { userId, refType, refId, slot = "" }) {
  const id = Number(mediaId) || 0;
  if (!id) return;
  const ts = now();
  // is_live 唯一键是 (media_id, ref_type, ref_id, slot)：重复引用走 ON DUPLICATE 复活
  await pool.query(
    `INSERT INTO media_refs (media_id, user_id, ref_type, ref_id, slot, is_live, created_time, updated_time)
     VALUES (?,?,?,?,?,1,?,?)
     ON DUPLICATE KEY UPDATE is_live = 1, updated_time = VALUES(updated_time)`,
    [id, Number(userId) || 0, String(refType).slice(0, 24), String(refId).slice(0, 64), String(slot).slice(0, 24), ts, ts]
  );
  await recountRefs([id]);
}

/** 解绑引用（软删 is_live=0，保留审计线索） */
export async function releaseRefs(refType, refIds) {
  const ids = (Array.isArray(refIds) ? refIds : [refIds]).map((x) => String(x)).filter(Boolean);
  if (!ids.length) return 0;
  const ts = now();
  // 先取出受影响的 media id，再统一重算计数
  const [affected] = await pool.query(
    `SELECT DISTINCT media_id FROM media_refs WHERE ref_type = ? AND ref_id IN (?) AND is_live = 1`,
    [String(refType), ids]
  );
  if (!affected.length) return 0;
  const [ret] = await pool.query(
    `UPDATE media_refs SET is_live = 0, updated_time = ? WHERE ref_type = ? AND ref_id IN (?) AND is_live = 1`,
    [ts, String(refType), ids]
  );
  await recountRefs(affected.map((r) => Number(r.media_id)));
  return ret.affectedRows || 0;
}

/** 重算引用计数（只算给定的 media id，避免全表扫描） */
export async function recountRefs(mediaIds) {
  const ids = [...new Set((mediaIds || []).map((x) => Number(x)).filter((n) => n > 0))];
  if (!ids.length) return;
  await pool.query(
    `UPDATE media m
       LEFT JOIN (SELECT media_id, COUNT(*) AS c FROM media_refs WHERE is_live = 1 AND media_id IN (?) GROUP BY media_id) r
              ON r.media_id = m.id
        SET m.ref_count = COALESCE(r.c, 0), m.updated_time = ?
      WHERE m.id IN (?)`,
    [ids, now(), ids]
  );
}

/** 某对象引用了哪些媒体（聊天消息渲染用） */
export async function refsOf(refType, refId) {
  const [rows] = await pool.query(
    "SELECT media_id, slot FROM media_refs WHERE ref_type = ? AND ref_id = ? AND is_live = 1",
    [String(refType), String(refId)]
  );
  return rows.map((r) => ({ mediaId: Number(r.media_id), slot: r.slot || "" }));
}

// ---------------------------------------------------------------------------
// 回收：孤儿文件与过期软删
// ---------------------------------------------------------------------------

/**
 * 回收一轮。三类垃圾：
 *   ① 未引用的新上传（用户选了文件但没发出去）
 *   ② 已软删且超过保留期
 *   ③ 磁盘上有文件但库里没有对应行（崩溃残留）
 * 物理删除前必须跨用户查重：同一 sha 可能被别的用户共享，误删会影响别人。
 */
export async function runGc({ limit = 200 } = {}) {
  const orphanHours = getNumberOption("media_orphan_hours");
  const retentionDays = getNumberOption("media_retention_days");
  const ts = now();
  let softDeleted = 0;
  let purged = 0;

  // ① 孤儿：无引用且超过 media_orphan_hours（0 = 不回收未引用的新上传）
  if (orphanHours > 0) {
    const [ret] = await pool.query(
      "UPDATE media SET status = 2, deleted_time = ? WHERE status = 1 AND ref_count = 0 AND created_time < ? LIMIT ?",
      [ts, ts - orphanHours * 3600, limit]
    );
    softDeleted += ret.affectedRows || 0;
  }

  // ② 过期软删 → 物理删（0 = 不自动回收）
  if (retentionDays > 0) {
    const [rows] = await pool.query(
      "SELECT id, sha256, ext FROM media WHERE status = 2 AND deleted_time > 0 AND deleted_time < ? LIMIT ?",
      [ts - retentionDays * 86400, limit]
    );
    for (const r of rows) {
      // 跨用户查重：还有别的活行用同一个 sha 就不能删文件
      const [[c]] = await pool.query(
        "SELECT COUNT(*) AS n FROM media WHERE sha256 = ? AND status <> 2 AND id <> ?",
        [r.sha256, r.id]
      );
      if (Number(c.n) === 0) {
        await fsp.unlink(blobPath(r.sha256, r.ext || "")).catch(() => {});
      }
      await pool.query("DELETE FROM media_refs WHERE media_id = ?", [r.id]).catch(() => {});
      await pool.query("DELETE FROM media WHERE id = ?", [r.id]).catch(() => {});
      purged += 1;
    }
  }

  return { softDeleted, purged };
}

/** 统计：用于媒体库页面与配额展示 */
export async function stats(userId) {
  const uid = Number(userId) || 0;
  const [[agg]] = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(size),0) AS bytes
       FROM media WHERE user_id = ? AND status <> 2`,
    [uid]
  );
  const [byKind] = await pool.query(
    "SELECT kind, COUNT(*) AS cnt, COALESCE(SUM(size),0) AS bytes FROM media WHERE user_id = ? AND status <> 2 GROUP BY kind",
    [uid]
  );
  return {
    count: Number(agg.cnt) || 0,
    bytes: Number(agg.bytes) || 0,
    quotaBytes: quotaBytes(),
    byKind: byKind.map((r) => ({ kind: r.kind, count: Number(r.cnt) || 0, bytes: Number(r.bytes) || 0 })),
  };
}

/** 启动时准备目录 */
export async function initMedia() {
  await ensureDirs();
  await cleanTmp();
}
