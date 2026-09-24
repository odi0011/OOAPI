// 现代轻量富文本 / Markdown 编辑器 (RichTextEditor)
// ---------------------------------------------------------------------------
// 核心能力：
// 1. 标准受控组件，无缝集成 Ant Design Form (value / onChange)；
// 2. 格式化工具栏：加粗、斜体、删除线、各级标题、引用、代码/代码块、列表、链接、分割线、Emoji、图片；
// 3. 多视图模式：编写 (Write)、分屏 (Split)、预览 (Preview)，预览直接使用系统 Markdown 引擎；
// 4. 强大的剪贴板与拖拽支持：在编辑框内直接 Ctrl+V 粘贴截图或拖拽图片，自动上传到媒体库并在光标处插入图片 Markdown；
// 5. 快捷键拦截：Ctrl+B / Cmd+B (加粗)、Ctrl+I / Cmd+I (斜体)、Tab 缩进等。
import React, { useCallback, useRef, useState } from "react";
import { Tooltip, Popover, Space, Dropdown, Spin, message as antMessage } from "antd";
import {
  BoldOutlined, ItalicOutlined, StrikethroughOutlined,
  CodeOutlined, LinkOutlined, PictureOutlined, SmileOutlined,
  UnorderedListOutlined, OrderedListOutlined,
  EyeOutlined, EditOutlined, ColumnWidthOutlined,
} from "@ant-design/icons";
import Markdown from "./Markdown";
import { API } from "../services/api";

const EMOJI_SUGGESTIONS = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
  "🙂", "😉", "😍", "🥰", "😘", "😎", "🥳", "🤔", "🤫", "🤗",
  "🤖", "🚀", "💡", "🔥", "👍", "👏", "🎉", "❤️", "⭐", "✨",
  "💯", "⚡", "📌", "📝", "🐛", "🔧", "💻", "☕", "🍺", "🌟",
];

export default function RichTextEditor({
  value = "",
  onChange,
  placeholder = "写下你的内容... 支持 Markdown 与富文本快捷操作，可直接粘贴截图",
  minHeight = 220,
  maxHeight = 600,
  maxLength = 20000,
  disabled = false,
  onMediaUploaded, // 可选回调：上传成功后将媒体对象 { id, url, name } 回传给表单
}) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const [mode, setMode] = useState("write"); // 'write' | 'split' | 'preview'
  const [uploading, setUploading] = useState(false);

  const text = value || "";

  // 辅助：获取光标或选区位置
  const getSelection = () => {
    const ta = textareaRef.current;
    if (!ta) return { start: text.length, end: text.length, selected: "" };
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const selected = text.slice(start, end);
    return { start, end, selected };
  };

  // 辅助：用新内容替换选区并重置光标
  const replaceSelection = useCallback((before, after = "", defaultText = "") => {
    const ta = textareaRef.current;
    const { start, end, selected } = getSelection();
    const content = selected || defaultText;
    const replacement = `${before}${content}${after}`;
    const nextText = text.slice(0, start) + replacement + text.slice(end);

    onChange?.(nextText);

    // 延时恢复光标位置
    setTimeout(() => {
      if (ta) {
        ta.focus();
        const cursor = start + before.length + content.length;
        ta.setSelectionRange(cursor, cursor);
      }
    }, 0);
  }, [text, onChange]);

  // 行前缀插入（用于标题、引用、列表等）
  const insertLinePrefix = useCallback((prefix) => {
    const ta = textareaRef.current;
    const { start, end } = getSelection();
    // 找到当前行开头
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nextText = text.slice(0, lineStart) + prefix + text.slice(lineStart);
    onChange?.(nextText);
    setTimeout(() => {
      if (ta) {
        ta.focus();
        const cursor = end + prefix.length;
        ta.setSelectionRange(cursor, cursor);
      }
    }, 0);
  }, [text, onChange]);

  // 上传图片并插入 Markdown 到当前光标
  const handleUploadFile = async (file) => {
    if (!file || !file.type.startsWith("image/")) {
      antMessage.warning("请选择图片文件");
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => reject(new Error("读取文件失败"));
        fr.readAsDataURL(file);
      });

      const res = await API.post("/media", {
        dataUrl,
        name: file.name || "image.png",
        source: "community",
      });

      // **只登记附件，不往正文插 markdown**。
      //
      // 原先这里既 replaceSelection(`![文件名](url)`) 又 onMediaUploaded，
      // 同一张图出现两次：正文里一行 `![IMG_2043.JPG](/api/media/123/raw?s=…)`，
      // 下面附件区又是那张图。而正文那行**渲染出来是纯文本** ——
      // Markdown 渲染器只认加粗/斜体/代码/列表/引用，不解析图片语法。
      //
      // 两个假人独立报了这条（各自原话）：
      //   「传完图正文里多一行 !IMG_2043.JPG，得手动删」
      //   「是 bug 还是我操作不对？」
      //
      // 修法：图片统一由**附件**承载（media_ids → 详情页按 <Image> 渲染，
      // 有缩略图、能点开大图、删除时引用计数也归它管）。
      // 「把图插到正文某一行」是 markdown 能力问题，不该由上传按钮顺手塞一行文本。
      const imgUrl = res.url || "";
      onMediaUploaded?.({ id: res.id, url: imgUrl, name: file.name });
      antMessage.success("图片已添加为附件");
    } catch (err) {
      antMessage.error(err.message || "图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  // 监听粘贴：直接粘贴截图时自动上传并插入 Markdown
  const handlePaste = async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgItem = items.find((it) => it.type.startsWith("image/"));
    if (imgItem) {
      const file = imgItem.getAsFile();
      if (file) {
        e.preventDefault();
        await handleUploadFile(file);
      }
    }
  };

  // 监听键盘快捷键
  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      replaceSelection("**", "**", "加粗文字");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
      e.preventDefault();
      replaceSelection("*", "*", "斜体文字");
    } else if (e.key === "Tab") {
      e.preventDefault();
      replaceSelection("  ", "", "");
    }
  };

  // 标题选项
  const headingItems = [
    { key: "h1", label: "一级标题 (H1)", onClick: () => insertLinePrefix("# ") },
    { key: "h2", label: "二级标题 (H2)", onClick: () => insertLinePrefix("## ") },
    { key: "h3", label: "三级标题 (H3)", onClick: () => insertLinePrefix("### ") },
    { key: "h4", label: "四级标题 (H4)", onClick: () => insertLinePrefix("#### ") },
  ];

  return (
    <div className={`oo-rich-editor ${mode === "split" ? "is-split" : ""}`}>
      {/* 1. 顶部现代化工具栏 */}
      <div className="oo-rich-toolbar">
        <Space size={2} wrap>
          <Tooltip title="加粗 (Ctrl+B)">
            <button
              type="button"
              className="oo-editor-btn"
              onClick={() => replaceSelection("**", "**", "粗体")}
              disabled={disabled}
            >
              <BoldOutlined />
            </button>
          </Tooltip>

          <Tooltip title="斜体 (Ctrl+I)">
            <button
              type="button"
              className="oo-editor-btn"
              onClick={() => replaceSelection("*", "*", "斜体")}
              disabled={disabled}
            >
              <ItalicOutlined />
            </button>
          </Tooltip>

          <Tooltip title="删除线">
            <button
              type="button"
              className="oo-editor-btn"
              onClick={() => replaceSelection("~~", "~~", "删除线")}
              disabled={disabled}
            >
              <StrikethroughOutlined />
            </button>
          </Tooltip>

          <div className="oo-editor-divider" />

          <Dropdown menu={{ items: headingItems }} trigger={["click"]}>
            <button type="button" className="oo-editor-btn oo-editor-text-btn" disabled={disabled}>
              标题 <span style={{ fontSize: 10, marginLeft: 2 }}>▼</span>
            </button>
          </Dropdown>

          <Tooltip title="引用文本">
            <button
              type="button"
              className="oo-editor-btn oo-editor-text-btn"
              onClick={() => insertLinePrefix("> ")}
              disabled={disabled}
            >
              引用
            </button>
          </Tooltip>

          <div className="oo-editor-divider" />

          <Tooltip title="行内代码">
            <button
              type="button"
              className="oo-editor-btn"
              onClick={() => replaceSelection("`", "`", "code")}
              disabled={disabled}
            >
              <CodeOutlined />
            </button>
          </Tooltip>

          <Tooltip title="代码块">
            <button
              type="button"
              className="oo-editor-btn oo-editor-text-btn"
              onClick={() => replaceSelection("\n```javascript\n", "\n```\n", "// 请输入代码")}
              disabled={disabled}
            >
              代码块
            </button>
          </Tooltip>

          <div className="oo-editor-divider" />

          <Tooltip title="无序列表">
            <button
              type="button"
              className="oo-editor-btn"
              onClick={() => insertLinePrefix("- ")}
              disabled={disabled}
            >
              <UnorderedListOutlined />
            </button>
          </Tooltip>

          <Tooltip title="有序列表">
            <button
              type="button"
              className="oo-editor-btn"
              onClick={() => insertLinePrefix("1. ")}
              disabled={disabled}
            >
              <OrderedListOutlined />
            </button>
          </Tooltip>

          <div className="oo-editor-divider" />

          <Tooltip title="插入链接">
            <button
              type="button"
              className="oo-editor-btn"
              onClick={() => replaceSelection("[", "](https://example.com)", "链接文本")}
              disabled={disabled}
            >
              <LinkOutlined />
            </button>
          </Tooltip>

          <Tooltip title="插入图片（可直接粘贴截图）">
            <button
              type="button"
              className="oo-editor-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading}
            >
              <PictureOutlined />
            </button>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUploadFile(file);
              e.target.value = "";
            }}
          />

          <Popover
            content={
              <div className="oo-emoji-picker-grid">
                {EMOJI_SUGGESTIONS.map((emo) => (
                  <span
                    key={emo}
                    className="oo-emoji-cell"
                    onClick={() => replaceSelection(emo, "", "")}
                  >
                    {emo}
                  </span>
                ))}
              </div>
            }
            trigger="click"
          >
            <button type="button" className="oo-editor-btn" disabled={disabled} title="插入表情">
              <SmileOutlined />
            </button>
          </Popover>

          <Tooltip title="分割线">
            <button
              type="button"
              className="oo-editor-btn oo-editor-text-btn"
              onClick={() => replaceSelection("\n---\n", "", "")}
              disabled={disabled}
            >
              ---
            </button>
          </Tooltip>
        </Space>

        {/* 右侧：视图模式切换 */}
        <div className="oo-rich-toolbar-right">
          {uploading && (
            <span style={{ fontSize: 12, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 4, marginRight: 8 }}>
              <Spin size="small" /> 正在上传图片...
            </span>
          )}
          <Space size={2}>
            <Tooltip title="编辑视图">
              <button
                type="button"
                className={`oo-editor-mode-btn ${mode === "write" ? "is-active" : ""}`}
                onClick={() => setMode("write")}
              >
                <EditOutlined /> 编写
              </button>
            </Tooltip>
            <Tooltip title="分屏对照预览">
              <button
                type="button"
                className={`oo-editor-mode-btn is-desktop-only ${mode === "split" ? "is-active" : ""}`}
                onClick={() => setMode("split")}
              >
                <ColumnWidthOutlined /> 分屏
              </button>
            </Tooltip>
            <Tooltip title="实时预览">
              <button
                type="button"
                className={`oo-editor-mode-btn ${mode === "preview" ? "is-active" : ""}`}
                onClick={() => setMode("preview")}
              >
                <EyeOutlined /> 预览
              </button>
            </Tooltip>
          </Space>
        </div>
      </div>

      {/* 2. 主体编辑与预览区 */}
      <div className="oo-rich-body" style={{ minHeight }}>
        {/* 编辑区 */}
        {(mode === "write" || mode === "split") && (
          <div className="oo-rich-textarea-box">
            <textarea
              ref={textareaRef}
              className="oo-rich-textarea"
              style={{ minHeight, maxHeight }}
              value={text}
              placeholder={placeholder}
              onChange={(e) => onChange?.(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              maxLength={maxLength}
            />
          </div>
        )}

        {/* 预览区 */}
        {(mode === "preview" || mode === "split") && (
          <div className="oo-rich-preview-box" style={{ minHeight, maxHeight }}>
            {text.trim() ? (
              <Markdown text={text} />
            ) : (
              <div className="oo-rich-preview-empty">暂无预览内容，输入 Markdown 语法后可在此实时查看</div>
            )}
          </div>
        )}
      </div>

      {/* 3. 底部信息提示与字数 */}
      <div className="oo-rich-footer">
        <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
          💡 支持 Markdown 语法与截图直接粘贴 (Ctrl+V)
        </div>
        <div style={{ fontSize: 11.5, color: text.length > maxLength * 0.9 ? "var(--orange)" : "var(--ink-3)" }}>
          {text.length} / {maxLength}
        </div>
      </div>
    </div>
  );
}
