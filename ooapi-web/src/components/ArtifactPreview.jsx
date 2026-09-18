// 产出物预览（Artifact）
// ---------------------------------------------------------------------------
// 模型经常回一坨 HTML/CSS/JS/SVG 或 React 组件代码。纯文本贴出来用户还得自己复制去跑，
// 这里直接给一个「在线跑」的沙盒预览：点一下就在对话里看到渲染结果。
//
// 安全边界（重要，改这里务必守住）：
//   · iframe 用 sandbox="allow-scripts"**且不加** allow-same-origin —— 不加同源，
//     脚本就拿不到本站的 localStorage / cookie / DOM，无法读取用户令牌；
//   · 用 srcdoc 注入，不产生可导航的真实地址；
//   · 默认不加载，用户点了预览才渲染（避免每条消息都跑一遍未知脚本）；
//   · 不允许 allow-top-navigation / allow-popups / allow-modals，防止被弹窗或跳转劫持。
import React, { useMemo, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeContext";

// 哪些语言可以「跑起来」：标记类直接渲染，React 走内联 Babel
const PREVIEWABLE = new Set(["html", "htm", "svg", "xhtml", "react", "jsx", "tsx"]);
const LABELS = { html: "网页", htm: "网页", svg: "SVG 图形", react: "React 组件", jsx: "React 组件", tsx: "React 组件", xhtml: "网页" };

export function canPreviewArtifact(lang) {
  return PREVIEWABLE.has(String(lang || "").toLowerCase());
}

/**
 * 把模型的代码包成一份可直接在 iframe 里运行的 HTML。
 * React 代码用内联 Babel 转译（需要 CDN），并注入最小挂载壳；HTML/SVG 原样使用。
 */
// 预览文档的 CSP（纵深防御）：
//   · connect-src 'none'  —— 就算脚本想往外发数据（fetch/XHR/WebSocket）也发不出去；
//   · 沙盒本身已无 allow-same-origin，脚本读不到本站 localStorage/cookie，
//     这条 CSP 是第二道闸，避免「模型生成的代码顺手把内容 POST 到外部」；
//   · 允许 https 的图片/样式/字体，是为了不打断常见演示（图标、字体、CDN 样式）；
//   · React 模式需要 unpkg 的 UMD 包与内联脚本，所以 script-src 放开这两项。
const CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' https://unpkg.com; " +
  "style-src 'unsafe-inline' https:; " +
  "img-src data: blob: https:; font-src data: https:; " +
  "connect-src 'none'; base-uri 'none'; form-action 'none'";

function buildDoc(lang, code, theme) {
  const dark = theme === "dark";
  const css = `:root{color-scheme:${dark ? "dark" : "light"}}
body{margin:0;padding:14px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
background:${dark ? "#16181d" : "#fff"};color:${dark ? "#e8e9ec" : "#1f2229"}}`;

  const l = String(lang || "").toLowerCase();
  if (l === "react" || l === "jsx" || l === "tsx") {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head><body><div id="root"></div>
<script type="text/babel" data-presets="react,typescript">${
      // 组件代码常见 `export default function App()` / `function App()`：
      // 统一改写后由下面的挂载壳渲染，避免模型写了 export 就整段报错
      String(code)
        .replace(/^\s*export\s+default\s+/m, "const __Default = ")
        .replace(/^\s*export\s+(function|const|class)\s+/gm, "$1 ")
    }\n
try {
  const __C = (typeof __Default !== "undefined" && __Default) || (typeof App !== "undefined" && App) || null;
  if (__C) ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(__C));
  else document.getElementById("root").textContent = "没有找到组件（请定义 App 或 export default）";
} catch (e) {
  document.getElementById("root").innerHTML = '<pre style="color:#d33;white-space:pre-wrap">' + e.message + "</pre>";
}
</script></body></html>`;
  }

  // SVG：补上根标签与自适应样式，让它自己居中
  if (l === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${css}
body{display:flex;align-items:center;justify-content:center;min-height:60vh}
svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`;
  }

  // HTML：模型可能只给了片段（没有 <html>），补全外壳；已有完整文档就原样
  const body = String(code);
  // 完整文档：补一条 CSP meta（尽量插到 head 最前面，越早生效越好）
  if (/<html[\s>]/i.test(body)) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
    if (/<head[^>]*>/i.test(body)) return body.replace(/<head[^>]*>/i, (m) => m + meta);
    return body.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`;
}

export function ArtifactPreview({ lang, code }) {
  const { resolved } = useTheme();
  const [mode, setMode] = useState("code"); // code | preview
  const [full, setFull] = useState(false);
  const frameRef = useRef(null);

  const doc = useMemo(() => (mode === "preview" ? buildDoc(lang, code, resolved) : ""), [mode, lang, code, resolved]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(code || ""));
    } catch {
      /* 复制失败静默：下方仍有可手选的源码 */
    }
  };

  return (
    <div className={`bui-artifact ${mode === "preview" ? "is-preview" : ""}`}>
      <div className="bui-artifact-bar">
        <span className="tag">{LABELS[String(lang || "").toLowerCase()] || "代码"}</span>
        <div className="tabs">
          <button type="button" className={mode === "code" ? "is-on" : ""} onClick={() => setMode("code")}>
            代码
          </button>
          <button type="button" className={mode === "preview" ? "is-on" : ""} onClick={() => setMode("preview")}>
            预览
          </button>
        </div>
        <div className="acts">
          {mode === "preview" ? (
            <button type="button" onClick={() => setFull(true)} title="放大预览">
              放大
            </button>
          ) : null}
          <button type="button" onClick={copy} title="复制代码">
            复制
          </button>
        </div>
      </div>

      {mode === "preview" ? (
        <iframe
          ref={frameRef}
          className="bui-artifact-frame"
          title="产出物预览"
          // 只给 allow-scripts：不给 allow-same-origin，脚本无法触碰本站数据
          sandbox="allow-scripts"
          srcDoc={doc}
          referrerPolicy="no-referrer"
        />
      ) : (
        <pre className="bui-artifact-code" data-lang={lang || undefined}>
          <code>{code}</code>
        </pre>
      )}

      {full ? (
        <div className="bui-artifact-full" role="dialog" aria-label="产出物全屏预览" onMouseDown={() => setFull(false)}>
          <div className="box" onMouseDown={(e) => e.stopPropagation()}>
            <div className="head">
              <span>{LABELS[String(lang || "").toLowerCase()] || "预览"}</span>
              <button type="button" onClick={() => setFull(false)} aria-label="关闭">
                ✕
              </button>
            </div>
            <iframe title="产出物全屏预览" sandbox="allow-scripts" srcDoc={doc} referrerPolicy="no-referrer" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
