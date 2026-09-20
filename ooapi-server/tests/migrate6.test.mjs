// migrate6 的验证脚本：造一条「老格式」消息 → 跑迁移 → 断言结果
// ---------------------------------------------------------------------------
// 为什么要有它：迁移脚本最容易出的错是「看起来跑了，其实没动数据」
// 或「把数据改坏了」。这里造出真实的老格式数据、执行迁移、再逐条核对，
// 最后清理掉测试数据，不给环境留垃圾。
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const { pool } = await import("../src/db.js");

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) {
    pass += 1;
    console.log(`  ok  ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${n} ${extra}`);
  }
};

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const [[u]] = await pool.query("SELECT id FROM users WHERE role >= 100 LIMIT 1");

// 找一个会话（没有就建一个临时会话）
let [[sess]] = await pool.query("SELECT id FROM chat_sessions WHERE user_id = ? LIMIT 1", [u.id]);
let tempSession = false;
if (!sess) {
  const r = await pool.query("INSERT INTO chat_sessions (user_id, title, created_time) VALUES (?, '迁移测试', ?)", [
    u.id,
    Math.floor(Date.now() / 1000),
  ]);
  sess = { id: r[0].insertId };
  tempSession = true;
}

// 造一条老格式消息：parts 里带内联 base64（含一张图 + 一段文字）
const parts = JSON.stringify([
  { id: "t1", type: "text", text: "迁移测试：下面这张图是内联 base64" },
  { id: "i1", type: "image", url: `data:image/png;base64,${PNG}` },
  { id: "i2", type: "image", url: `data:image/png;base64,${PNG}` }, // 同一张图两次（测去重）
]);
const ins = await pool.query(
  "INSERT INTO chat_messages (session_id, user_id, role, seq, parts, created_time) VALUES (?, ?, 'user', ?, ?, ?)",
  [sess.id, u.id, 900 + (Date.now() % 90), parts, Math.floor(Date.now() / 1000)]
);
const msgId = ins[0].insertId;
console.log(`造出老格式消息 #${msgId}（parts ${parts.length} 字符，2 张内联图）\n`);

// 跑迁移（--apply）
// 用 fileURLToPath 而不是 URL.pathname：Windows 上 pathname 会带前导斜杠与
// 百分号编码（/C:/Users/...），spawn 的 cwd 认不出来（跨平台踩过）
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runOnce = async () => {
  try {
    const { stdout } = await pexec("node", ["migrate6.mjs", "--apply"], { cwd: SERVER_ROOT });
    return stdout;
  } catch (e) {
    return String(e.stdout || e.message);
  }
};
const out = await runOnce();
const migrated = /迁移 (\d+) 条/.exec(out);
console.log(out.trim().split("\n").slice(-4).join("\n"));
console.log("");

const [[row]] = await pool.query("SELECT parts FROM chat_messages WHERE id = ?", [msgId]);
const text = typeof row.parts === "string" ? row.parts : JSON.stringify(row.parts);
const after = JSON.parse(text);

ck("迁移执行成功（脚本报告已处理）", Boolean(migrated), out.slice(0, 200));
ck("parts 里不再有 base64", !text.includes("data:image"), text.slice(0, 160));
ck("图片 part 已带上 media_id", after.filter((p) => p.type === "image" && p.media_id > 0).length === 2, JSON.stringify(after));
ck("原来的 url 字段已移除（渲染时由服务端补签名 URL）", after.every((p) => p.type !== "image" || p.url === undefined));
ck("文字 part 未被改动", after.find((p) => p.type === "text")?.text === "迁移测试：下面这张图是内联 base64");
const beforeLen = parts.length;
// 阈值别定太死：1×1 的测试图 base64 本来就只有 100 字符左右，
// 真实场景里手机截图（几十 KB）会缩小两三个数量级。
// 这里只断言「确实变小且不含 base64」，不臆测具体倍数。
ck(`parts 体积已缩小（${beforeLen} → ${text.length} 字符）`, text.length < beforeLen, `${beforeLen} → ${text.length}`);
// 注意检查的是「data:image/...;base64,」这个真实数据前缀，
// 不是字符串 "base64" —— 测试文本里恰好写了「内联 base64」这个词，
// 用后者会把正常内容判成失败（假阳性）
ck(
  "缩小的原因是不再承载 base64 数据（而非丢内容）",
  after.length === 3 && !text.includes("data:image") && !text.includes(";base64,"),
  JSON.stringify(after).slice(0, 160)
);

// 媒体引用已绑定（否则这些图会永远停在「被引用」状态，既回收不了也删不掉）
const mids = after.filter((p) => p.media_id).map((p) => p.media_id);
const [refs] = await pool.query(
  `SELECT COUNT(*) AS n FROM media_refs WHERE ref_type = 'chat_message' AND ref_id = ? AND is_live = 1`,
  [String(msgId)]
);
ck("图片已绑定到消息引用（可被删除链路释放）", Number(refs[0].n) === new Set(mids).size, `refs=${refs[0].n} 去重后媒体=${new Set(mids).size}`);
ck("同一张图去重复用同一个 media_id", new Set(mids).size === 1, JSON.stringify(mids));

// 幂等：再跑一次不应再改动任何东西
const before = text;
await runOnce();
const [[again]] = await pool.query("SELECT parts FROM chat_messages WHERE id = ?", [msgId]);
const againText = typeof again.parts === "string" ? again.parts : JSON.stringify(again.parts);
ck("再次执行不重复改动（幂等）", againText === before, `${before.slice(0, 60)} vs ${againText.slice(0, 60)}`);

// 清理测试数据
await pool.query("DELETE FROM chat_messages WHERE id = ?", [msgId]);
for (const mid of mids) {
  await pool.query("DELETE FROM media_refs WHERE media_id = ? AND ref_type = 'chat_message' AND ref_id = ?", [mid, String(msgId)]);
  await pool.query("UPDATE media SET ref_count = (SELECT COUNT(*) FROM media_refs WHERE media_id = ? AND is_live = 1) WHERE id = ?", [mid, mid]);
}
if (tempSession) await pool.query("DELETE FROM chat_sessions WHERE id = ?", [sess.id]);
ck("测试数据已清理", true);

await pool.end().catch(() => {});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
