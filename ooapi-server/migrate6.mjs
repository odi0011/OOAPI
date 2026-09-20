// 迁移 v6：把历史消息里的内联 base64 图片转存媒体库（幂等）
// ===========================================================================
// 背景：第 36 批之前，对话里的图片是以 `data:image/...;base64,xxx` 直接写进
// chat_messages.parts 的。MEDIUMTEXT 上限 16MB，3 张大图就能让整轮对话
// 落库失败或历史静默变空。接入媒体库后新数据不再有 base64，但**老数据仍在**。
//
// 这个脚本把老 parts 里的 base64 抽出来存成媒体库文件，替换为 media_id。
//
// 幂等保证（本项目在这里栽过 —— migrate2 重复除 50 让用户余额被反复缩小）：
//   · 只处理 parts 里**确实含 base64** 的行，处理完就再也不会被选中；
//   · 每条消息独立事务式处理：存文件成功才更新 parts，失败则跳过留待下次；
//   · 用 options 表打标记录「已跑过」，但**不依赖它**做正确性判断
//     （打标只是给运维看进度，真正的幂等来自「parts 里还有没有 base64」）。
//
// 用法（在 ooapi-server 目录下）：
//   node migrate6.mjs            # 干跑：只统计，不写任何数据
//   node migrate6.mjs --apply    # 实际执行
//   node migrate6.mjs --apply --limit=200   # 分批执行（大表建议）
// ===========================================================================
import mysql from "mysql2/promise";
import "dotenv/config";

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Math.max(1, Math.min(100000, Number(limitArg.split("=")[1]) || 500)) : 500;

const pool = await mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "ooapi",
  password: process.env.DB_PASSWORD || "ooapi",
  database: process.env.DB_NAME || "ooapi",
  charset: "utf8mb4_unicode_ci",
  timezone: "Z",
});

const log = (s) => console.log(`[migrate6] ${s}`);

try {
  // 先看有多少行需要处理（LIKE 走不了索引，但只在迁移时跑一次）
  const [[cnt]] = await pool.query(
    "SELECT COUNT(*) AS c FROM chat_messages WHERE parts LIKE '%data:image%'"
  );
  log(`含内联 base64 的对话消息：${cnt.c} 条`);
  if (!cnt.c) {
    log("没有需要迁移的消息（新数据已全部走媒体库）");
    await pool.end();
    process.exit(0);
  }

  if (!APPLY) {
    // 干跑：抽样展示一条会怎么改，让人能先确认再执行
    const [sample] = await pool.query(
      "SELECT id, session_id, CHAR_LENGTH(parts) AS len, LEFT(parts, 160) AS head FROM chat_messages WHERE parts LIKE '%data:image%' ORDER BY id LIMIT 3"
    );
    for (const r of sample) {
      log(`  示例 #${r.id}（session=${r.session_id}，当前 parts ${r.len} 字符）：${String(r.head).replace(/\s+/g, " ").slice(0, 120)}…`);
    }
    log("以上为干跑结果，未修改任何数据。确认无误后加 --apply 执行。");
    await pool.end();
    process.exit(0);
  }

  // 媒体库服务：直接复用，保证与线上同一条写入路径（去重、类型嗅探、配额都一致）
  const { saveBuffer } = await import("./src/services/media.js");
  const { attachRef } = await import("./src/services/media.js");

  let done = 0;
  let files = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  let failed = 0;
  let skipped = 0;

  // 分批取：一次全取会让 Node 内存爆掉（parts 可能很大）
  for (;;) {
    const [rows] = await pool.query(
      "SELECT id, session_id, user_id, parts FROM chat_messages WHERE parts LIKE '%data:image%' ORDER BY id LIMIT ?",
      [Math.min(LIMIT, 50)]
    );
    if (!rows.length) break;

    for (const row of rows) {
      let parts;
      try {
        parts = typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts;
      } catch {
        skipped += 1;
        continue; // parts 不是合法 JSON：不是我们要处理的数据，跳过（不动它）
      }
      if (!Array.isArray(parts)) {
        skipped += 1;
        continue;
      }

      const originalLen = JSON.stringify(parts).length;
      let touched = false;
      const mediaIds = [];

      for (const p of parts) {
        if (!p || p.type !== "image") continue;
        // 情况一：已有 media_id 的（新数据）不动
        if (p.media_id) continue;
        const url = String(p.url || "");
        if (!url.startsWith("data:image/")) continue;

        const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
        if (!m) continue;

        try {
          const buf = Buffer.from(m[2], "base64");
          if (!buf.length) continue;
          // 归属原消息的作者；这保证配额与「谁能看到」的语义与线上一致
          const saved = await saveBuffer({
            buffer: buf,
            userId: Number(row.user_id) || 0,
            origName: "history-migration",
            source: "chat",
          });
          p.media_id = saved.id;
          delete p.url; // 只留 media_id：渲染时由服务端现补签名 URL
          mediaIds.push(saved.id);
          files += 1;
          touched = true;
        } catch (e) {
          // 单张失败不影响其它图片，也不影响这条消息的其它部分
          log(`  消息 #${row.id} 有一张图片迁移失败（保留原样）：${e.message}`);
          failed += 1;
        }
      }

      if (!touched) {
        skipped += 1;
        continue;
      }

      const nextParts = JSON.stringify(parts);
      // 仍然含 base64（有图片失败了）就不更新，留给下次重试 ——
      // 否则会把失败的图片直接丢掉（那是数据丢失，比不迁移严重得多）
      if (nextParts.includes("data:image")) {
        skipped += 1;
        continue;
      }

      await pool.query("UPDATE chat_messages SET parts = ? WHERE id = ?", [nextParts, row.id]);
      // 绑定引用：这样这些图片能被「删除会话时释放」的链路管到，
      // 否则它们会永远停在「被引用」状态（既回收不了、用户也删不掉）
      for (const mid of mediaIds) {
        await attachRef(mid, {
          userId: Number(row.user_id) || 0,
          refType: "chat_message",
          refId: String(row.id),
          slot: `m${mid}`,
        }).catch(() => {});
      }
      done += 1;
      bytesBefore += originalLen;
      bytesAfter += nextParts.length;

      if ((done + skipped + failed) % 20 === 0) {
        log(`  进度：已迁移 ${done} 条、跳过 ${skipped} 条、失败 ${failed} 张…`);
      }
    }
  }

  const saved = bytesBefore - bytesAfter;
  log(`完成：迁移 ${done} 条消息、转存 ${files} 个文件，跳过 ${skipped} 条、失败 ${failed} 张`);
  if (bytesBefore > 0) {
    log(`parts 体积：${(bytesBefore / 1048576).toFixed(2)}MB → ${(bytesAfter / 1048576).toFixed(2)}MB（减少 ${(saved / 1048576).toFixed(2)}MB）`);
  }
  // 打标只为运维看进度；正确性不依赖它（幂等来自「parts 里还有没有 base64」）
  try {
    await pool.query(
      "INSERT INTO options (key_str, value) VALUES ('migrate6_done', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [String(Date.now())]
    );
  } catch {
    /* options 表结构差异不影响迁移结果 */
  }
} catch (e) {
  console.error(`[migrate6] 失败：${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  // 显式退出：媒体库模块（services/media.js）会拉起定时器与连接，
  // 不主动退出的话脚本跑完仍挂在那里不返回 —— 手动执行时看着像卡死，
  // 被别的脚本 execFile 调用时更是直接超时。
  process.exit(process.exitCode || 0);
}
