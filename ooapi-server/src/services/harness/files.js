// 附件文本提取（对话页上传文档时用）
// ---------------------------------------------------------------------------
// 为什么放在服务端做：浏览器端只负责读成文本/base64，真正的解析（PDF 解压、
// DOCX 解 zip）要在这里完成，前端才好统一按「文本 + 文件名」渲染成消息的一部分。
//
// 不引第三方依赖（项目规范）：PDF 用 Node 内置 zlib 解 FlateDecode 流后按文本算子抽取；
// DOCX/XLSX 是 zip 容器，这里手写最小 zip 解析（只取需要的几个条目）。
// 解析失败的退路一律是「明确告诉用户这个文件读不了」，绝不静默塞进空内容。
import zlib from "node:zlib";

export const MAX_UPLOAD_FILES = 5;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 单个文件上限（解析后的文本另有限制）

// 纯文本类：直接按 utf8 读，覆盖代码/配置/表格/标记语言
export const TEXT_FILE_EXTS = [
  "txt", "md", "markdown", "mdx", "json", "jsonl", "csv", "tsv", "yaml", "yml",
  "xml", "html", "htm", "css", "scss", "less", "js", "jsx", "ts", "tsx", "vue", "svelte",
  "py", "java", "kt", "go", "rs", "rb", "php", "c", "h", "cpp", "hpp", "cs", "swift",
  "sh", "bash", "zsh", "ps1", "bat", "sql", "graphql", "proto", "toml", "ini", "conf", "env",
  "log", "gitignore", "dockerfile", "makefile", "tex", "r", "lua", "dart", "scala", "pl",
];

const extOf = (name) => String(name || "").toLowerCase().split(".").pop() || "";

export function isTextFile(name = "", mime = "") {
  if (/^text\//i.test(mime)) return true;
  if (/^application\/(json|xml|javascript|x-yaml|x-sh)/i.test(mime)) return true;
  const ext = extOf(name);
  return TEXT_FILE_EXTS.includes(ext) || ["dockerfile", "makefile"].includes(String(name).toLowerCase());
}

/* ------------------------------------------------------------------ *
 * PDF：解 FlateDecode 流 → 抽文本算子
 * 只处理「文本型 PDF」（Word/LaTeX 导出的居多）；扫描件没有文本层，如实报错。
 * ------------------------------------------------------------------ */
function pdfStreams(buf) {
  const out = [];
  // 逐个 stream...endstream 切片；PDF 的流内容本身不含 "endstream" 字面量（除非未压缩的巧合）
  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  let pos = 0;
  while (pos < buf.length) {
    const s = buf.indexOf(marker, pos);
    if (s < 0) break;
    let dataStart = s + marker.length;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const e = buf.indexOf(endMarker, dataStart);
    if (e < 0) break;
    let dataEnd = e;
    if (dataEnd > dataStart && buf[dataEnd - 1] === 0x0a) dataEnd--;
    if (dataEnd > dataStart && buf[dataEnd - 1] === 0x0d) dataEnd--;
    out.push(buf.subarray(dataStart, dataEnd));
    pos = e + endMarker.length;
  }
  return out;
}

function inflateMaybe(chunk) {
  try {
    return zlib.inflateSync(chunk);
  } catch {
    try {
      return zlib.inflateRawSync(chunk);
    } catch {
      return null; // 未压缩的流（少见）交给调用方按原文处理
    }
  }
}

// PDF 字符串里的转义与八进制：\( \) \\ \n \ooo
function unescapePdfString(s) {
  return s
    .replace(/\\([nrtbf])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[c] || c))
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/** 从一段 PDF 内容流里抽文本：Tj / TJ / ' / " 四类算子 */
function textFromContent(content) {
  const text = content.toString("latin1");
  const parts = [];
  // TJ 数组：(...) 与 <...> 交替，数字是字距（负值大表示空格）
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bTj\b|\bTJ\b|\bTD\b|\bTd\b|\bT\*\b|\bET\b|\bBT\b|\[|\]/g;
  let m;
  let line = "";
  const flush = () => {
    const t = line.replace(/[ \t]+$/g, "");
    if (t.trim()) parts.push(t);
    line = "";
  };
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (tok.startsWith("(")) {
      const raw = tok.slice(1, -1);
      line += unescapePdfString(raw);
    } else if (tok.startsWith("<") && tok.endsWith(">")) {
      // UTF-16BE 十六进制串（常见于中文 PDF）
      const hex = tok.slice(1, -1).replace(/\s+/g, "");
      if (hex.length % 4 === 0 && /^(feff|fffe)/i.test(hex)) {
        let s = "";
        for (let i = 0; i < hex.length; i += 4) {
          const code = parseInt(hex.slice(i, i + 4), 16);
          if (code !== 0xfeff && code !== 0xfffe) s += String.fromCharCode(code);
        }
        line += s;
      } else {
        let s = "";
        for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        line += s;
      }
    } else if (/^-?\d+(\.\d+)?$/.test(tok)) {
      // TJ 数组里的数字是字距：负得较多（约 -100 以下）通常表示一个空格
      if (Number(tok) <= -100) line += " ";
    } else if (tok === "TD" || tok === "Td" || tok === "T*" || tok === "ET" || tok === "BT") {
      flush();
    }
  }
  flush();
  return parts.join("\n");
}

function extractPdf(buf) {
  const chunks = [];
  for (const raw of pdfStreams(buf)) {
    const data = inflateMaybe(raw) || raw;
    // 只解析看起来像内容流的（含文本算子），避免把图片/字体流当文本
    const s = data.toString("latin1");
    if (!/\bT[jJ]\b/.test(s)) continue;
    const t = textFromContent(data);
    if (t.trim()) chunks.push(t);
  }
  return chunks.join("\n\n");
}

/* ------------------------------------------------------------------ *
 * ZIP 容器（DOCX / XLSX）：手写最小解析，只取需要的条目
 * ------------------------------------------------------------------ */
function readZipEntries(buf) {
  // 从尾部找 End of Central Directory（EOCD 签名 0x06054b50）
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.compare(eocdSig, 0, 4, i, i + 4) === 0) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central directory 签名
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipFile(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateMaybe(data) || inflateRawFallback(data);
  return null;
}

function inflateRawFallback(data) {
  try {
    return zlib.inflateRawSync(data);
  } catch {
    return null;
  }
}

const xmlToText = (xml) =>
  String(xml)
    .replace(/<w:p[ >][^>]*>/g, "\n") // Word 段落
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function extractDocx(buf) {
  const entries = readZipEntries(buf);
  if (!entries) return "";
  const doc = entries.get("word/document.xml");
  if (!doc) return "";
  const xml = readZipFile(buf, doc);
  if (!xml) return "";
  return xmlToText(xml.toString("utf8"));
}

function extractXlsx(buf) {
  const entries = readZipEntries(buf);
  if (!entries) return "";
  // 共享字符串表：单元格里是索引，文本都在这里
  const shared = [];
  const ss = entries.get("xl/sharedStrings.xml");
  if (ss) {
    const xml = readZipFile(buf, ss);
    if (xml) {
      const s = xml.toString("utf8");
      const re = /<si[ >][\s\S]*?<\/si>/g;
      let m;
      while ((m = re.exec(s)) !== null) {
        shared.push(m[0].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim());
      }
    }
  }
  const out = [];
  for (const [name, entry] of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = readZipFile(buf, entry);
    if (!xml) continue;
    const s = xml.toString("utf8");
    out.push(`--- ${name.replace("xl/worksheets/", "")} ---`);
    const rowRe = /<row[ >][\s\S]*?<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(s)) !== null) {
      const cells = [];
      const cellRe = /<c[^>]*?(?:\st="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cellRe.exec(rm[0])) !== null) {
        const type = cm[1];
        const inner = cm[2];
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        let val = "";
        if (type === "s" && v) val = shared[Number(v[1])] ?? "";
        else if (inline) val = inline[1];
        else if (v) val = v[1];
        cells.push(String(val).replace(/&amp;/g, "&").trim());
      }
      if (cells.some((c) => c)) out.push(cells.join("\t"));
    }
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */
/**
 * 从附件里提取可读文本。
 * @param {object} p { buffer, filename, mimeType }
 * @returns {{ ok: boolean, text?: string, kind?: string, error?: string }}
 */
export function extractFileText({ buffer, filename = "", mimeType = "" }) {
  const ext = extOf(filename);
  const name = String(filename).toLowerCase();
  try {
    if (ext === "pdf" || /application\/pdf/i.test(mimeType)) {
      const text = extractPdf(buffer);
      return text.trim()
        ? { ok: true, text, kind: "pdf" }
        : { ok: false, error: "这个 PDF 没有可提取的文字层（可能是扫描件/纯图片），请贴出关键页的文字或改用图片上传" };
    }
    if (ext === "docx" || /officedocument\.wordprocessingml/i.test(mimeType)) {
      const text = extractDocx(buffer);
      return text.trim() ? { ok: true, text, kind: "docx" } : { ok: false, error: "没能从这份 Word 文档里提取到文字" };
    }
    if (ext === "xlsx" || /officedocument\.spreadsheetml/i.test(mimeType)) {
      const text = extractXlsx(buffer);
      return text.trim() ? { ok: true, text, kind: "xlsx" } : { ok: false, error: "没能从这份表格里提取到内容" };
    }
    if (ext === "doc" || ext === "xls" || ext === "ppt") {
      return { ok: false, error: `旧版 .${ext} 格式暂不支持，请另存为 .${ext}x 或 PDF 后再上传` };
    }
    if (isTextFile(filename, mimeType)) {
      // 去掉 BOM，避免首个字符异常
      const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
      return { ok: true, text, kind: "text" };
    }
    return { ok: false, error: `不支持的文件类型（.${ext || mimeType || "未知"}），可上传文本/代码/PDF/Word/Excel` };
  } catch (e) {
    return { ok: false, error: `解析失败：${e.message}` };
  }
}
