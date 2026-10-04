import fs from "node:fs/promises";
import { deflateRawSync } from "node:zlib";

// 固定源码文件打包，无外部归档程序、任意路径或凭据文件。ZIP 可直接由 Windows 解压。
const files = ["package.json", "start.mjs", "cli.mjs", "runner.mjs", "workspace.mjs", "journal.mjs", "README.md"];
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
export async function companionArchive() {
  const entries = [], directory = []; let offset = 0;
  for (const filename of files) {
    const content = await fs.readFile(new URL(`../../../../ooapi-companion/${filename}`, import.meta.url));
    const compressed = deflateRawSync(content), name = Buffer.from(`ooapi-companion/${filename}`), crc = crc32(content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    entries.push(header, name, compressed); directory.push(central, name); offset += header.length + name.length + compressed.length;
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, dir, end]);
}
