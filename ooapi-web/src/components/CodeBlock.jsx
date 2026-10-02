import React, { useState } from "react";
import { App, Button } from "antd";
import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import { copyText } from "../services/format";
import "./code-block.css";

// 只产生 React 文本节点；高亮绝不执行模型返回的 HTML 或 JavaScript。
function highlight(code) {
  return code.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b(?:import|from|const|let|var|return|function|class|export|default|async|await|if|else|new|def|for|true|false|null|None)\b|\b\d+(?:\.\d+)?\b)/g).map((t, i) =>
    <span key={i} className={/^(\/\/|#)/.test(t) ? "code-comment" : /^["']/.test(t) ? "code-string" : /^\d/.test(t) ? "code-number" : /^(import|from|const|let|var|return|function|class|export|default|async|await|if|else|new|def|for|true|false|null|None)$/.test(t) ? "code-keyword" : undefined}>{t}</span>);
}

export default function CodeBlock({ lang = "text", code = "", title, className = "" }) {
  const { message } = App.useApp();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const source = String(code);
  const lines = source.split("\n");
  const long = lines.length > 24;
  const shown = long && !expanded ? lines.slice(0, 24).join("\n") : source;
  return <section className={`oo-code-block ${className}`} aria-label={title || `${lang} 代码`}>
    <header className="oo-code-head">
      <span className="oo-code-lights" aria-hidden="true"><i/><i/><i/></span>
      <span className="oo-code-lang">{title || lang || "text"}</span>
      <Button type="text" size="small" aria-label="复制代码" icon={copied ? <CheckOutlined/> : <CopyOutlined/>} onClick={async () => {
        try { await copyText(source); setCopied(true); } catch { message.error("复制失败，请手动选择代码"); }
      }}>{copied ? "已复制" : "复制"}</Button>
    </header>
    <pre tabIndex={0}><code>{source.length < 80000 ? highlight(shown) : shown}</code></pre>
    {long && <Button type="text" block className="oo-code-more" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : `展开全部 ${lines.length} 行`}</Button>}
  </section>;
}
