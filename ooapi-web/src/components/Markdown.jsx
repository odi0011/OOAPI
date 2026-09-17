// 轻量 Markdown 渲染（对话与智能体输出用）
// 仅覆盖模型常用输出：代码块、行内代码、标题、粗体、列表、引用、链接。
// 输出为 React 节点，避免 dangerouslySetInnerHTML 带来的注入风险。
//
// 性能约定：本组件被 React.memo 包裹，且解析结果按 text 做 useMemo 缓存。
// 流式对话里每个 token 都会携带新的 text，只有当前这条消息会重新解析；
// 其余消息因 props 未变而整棵跳过重渲染（长会话不掉帧的关键）。
import React, { useMemo } from "react";

// 只允许安全协议的链接，避免模型输出 javascript:/data: 等危险 href
function safeHref(href) {
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

function parseMarkdown(src) {
  const lines = src.split("\n");
  const blocks = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

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
      blocks.push(
        <pre key={`p${k++}`} data-lang={lang || undefined}>
          <code>{buf.join("\n")}</code>
        </pre>
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
