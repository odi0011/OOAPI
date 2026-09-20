// 轻量 Markdown 渲染（对话与智能体输出用）
// 仅覆盖模型常用输出：代码块、行内代码、标题、粗体、列表、引用、链接。
// 输出为 React 节点，避免 dangerouslySetInnerHTML 带来的注入风险。
//
// 性能约定：本组件被 React.memo 包裹，且解析结果按 text 做 useMemo 缓存。
// 流式对话里每个 token 都会携带新的 text，只有当前这条消息会重新解析；
// 其余消息因 props 未变而整棵跳过重渲染（长会话不掉帧的关键）。
import React, { useMemo, useState } from "react";
import { ArtifactPreview, canPreviewArtifact } from "./ArtifactPreview";

/**
 * 代码块（带一键复制 + 超长自动折叠）
 *
 * 为什么开发者场景必须要这两个功能：
 *   · cURL / JSON payload / 堆栈报错基本都是「复制走用」，让用户手选很容易漏行；
 *   · 一条几百行的日志会把整段对话刷屏，折叠后默认只露 18 行，需要时再展开。
 */
function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lines = String(code || "").split("\n");
  // 折叠阈值：超过 18 行即折叠（约等于一屏能读的量），避免长日志刷屏
  const COLLAPSE_AT = 18;
  const long = lines.length > COLLAPSE_AT;
  const shown = long && !expanded ? lines.slice(0, COLLAPSE_AT).join("\n") : code;

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else {
        // 非安全上下文（http 局域网访问）没有 clipboard API，用 textarea 兜底
        const ta = document.createElement("textarea");
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 复制失败不弹错：用户可手动选择 */
    }
  };

  return (
    <div className="oo-code-block" data-lang={lang || undefined}>
      <div className="oo-code-head">
        <span className="oo-code-lang">{lang || "text"}</span>
        <button type="button" className="oo-code-btn" onClick={copy} title="复制代码">
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code>{shown}</code>
      </pre>
      {long ? (
        <button type="button" className="oo-code-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : `展开全部 ${lines.length} 行`}
        </button>
      ) : null}
    </div>
  );
}

// 只允许安全协议的链接，避免模型输出 javascript:/data: 等危险 href
// （HomePage 的 docs_link 等管理员可写字段也复用此函数）
export function safeHref(href) {
  const v = String(href || "").trim();
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (/^(\/|#)/.test(v)) return v;
  return null;
}

// 行内标记：`code` **bold** [text](url)
function renderInline(text, keyPrefix) {
  const nodes = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-c${i++}`}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      const href = safeHref(mm[2]);
      nodes.push(
        href ? (
          <a key={`${keyPrefix}-a${i++}`} href={href} target="_blank" rel="noreferrer">
            {mm[1]}
          </a>
        ) : (
          <span key={`${keyPrefix}-a${i++}`}>{mm[1]}</span>
        )
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// 表格：| a | b |  /  | --- | --- |  /  | 1 | 2 |
// 模型很爱用表格做对比，之前会原样把竖线吐给用户，这里补上（样式见 styles.css 的 .md-table）
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableSep = (line) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line);
const splitRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
const alignOf = (cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined);

function parseMarkdown(src) {
  const lines = src.split("\n");
  const blocks = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 表格（必须在段落之前判断，否则表头会被当成普通段落）
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <table className="md-table" key={`p${k++}`}>
          <thead>
            <tr>
              {head.map((c, idx) => (
                <th key={idx} style={{ textAlign: aligns[idx] }}>
                  {renderInline(c, `p${k}-h${idx}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {head.map((_, idx) => (
                  <td key={idx} style={{ textAlign: aligns[idx] }}>
                    {renderInline(row[idx] || "", `p${k}-${r}-${idx}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    // 代码块
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      const body = buf.join("\n");
      // 可运行的产出物（网页 / SVG / React）给「代码 | 预览」双视图，一键在线跑
      blocks.push(
        canPreviewArtifact(lang) ? (
          <ArtifactPreview key={`p${k++}`} lang={lang} code={body} />
        ) : (
          <CodeBlock key={`p${k++}`} lang={lang} code={body} />
        )
      );
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = level <= 2 ? "h3" : "h4";
      blocks.push(<Tag key={`p${k++}`}>{renderInline(h[2], `p${k}`)}</Tag>);
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(<blockquote key={`p${k++}`}>{renderInline(buf.join(" "), `p${k}`)}</blockquote>);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={`p${k++}`}>
          {items.map((t, idx) => (
            <li key={idx}>{renderInline(t, `p${k}-${idx}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={`p${k++}`}>
          {items.map((t, idx) => (
            <li key={idx}>{renderInline(t, `p${k}-${idx}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 段落（合并连续行）
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(<p key={`p${k++}`}>{renderInline(buf.join("\n"), `p${k}`)}</p>);
  }

  return <div className="bui-prose">{blocks}</div>;
}

// memo + useMemo 双层缓存：
//   · memo：text 未变时整个组件不重渲染（父级因输入框等状态刷新时大量命中）
//   · useMemo：组件确实重渲染（流式中）时，仍复用同一 text 的解析结果
function MarkdownView({ text }) {
  const src = String(text || "");
  const nodes = useMemo(() => (src ? parseMarkdown(src) : null), [src]);
  if (!nodes) return null;
  return nodes;
}

export default React.memo(MarkdownView);
