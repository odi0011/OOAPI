import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(value);
export async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("本地状态目录不能是符号链接。");
  await fs.chmod(directory, 0o700);
  return fs.realpath(directory);
}
export async function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export async function createJournal(directory) {
  const root = await privateDirectory(directory);
  function file(callId) { if (!validId(callId)) throw new Error("无效的本地调用编号。"); return path.join(root, `${callId}.json`); }
  const get = async callId => { try { return JSON.parse(await fs.readFile(file(callId), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  async function begin(callId, fingerprint) {
    let handle;
    try { handle = await fs.open(file(callId), "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") return { created: false, record: await get(callId) }; throw error; }
    const record = { callId, fingerprint, state: "running", startedAt: Date.now() };
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    return { created: true, record };
  }
  async function finish(record, result) { const value = { ...record, state: "completed", endedAt: Date.now(), result }; await atomicJson(file(record.callId), value); return value; }
  return { get, begin, finish };
}
