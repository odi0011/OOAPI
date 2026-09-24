import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { VendorIcon } from "./VendorIcon";


/* ---------- 图标（与官方同为 15-16px 线性图标） ---------- */
const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const SendIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const StopIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);
const ImageIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
);
const FileIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M9 13h6M9 17h4" />
  </svg>
);
const ChevronIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const TickIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/**
 * 输入栏（PromptBar）—— 严格按 beautifului.dev 官方实现的结构与尺寸重写（MIT, Shane Levine）
 * ---------------------------------------------------------------------------
 * 官方实测值（从组件库站点逐个量出来的，不是猜的）：
 *   · 容器 rounded-[14px] border border-line bg-surface p-[6px] shadow-card
 *     focus-within 时只有边框变 line-strong —— 不再加重阴影
 *   · 控制行 grid-cols-[28px_minmax(0,1fr)_auto_28px_28px] gap-x-1 gap-y-[6px] items-end
 *   · textarea 透明底、min-h-7、px-1 py-[5px]、text-[13px] leading-[18px]、自增高
 *   · 所有按钮 28×28 rounded-lg，图标色 ink-3，hover 才上 bg-hover
 *   · 菜单 absolute bottom-full mb-2 rounded-[10px] bg-surface p-1，行高 36px + 滑动高亮
 *
 * 与官方的差异（有意为之，因为我们要接真实数据）：
 *   · 模型菜单按**厂商分组**并带厂商图标（官方是单层列表）
 *   · 菜单锚定在**触发按钮**上而不是整个输入框，避免输入框自增高时菜单漂移
 *   · 支持 chips（附件）、toggles（思考/联网）、commands（/ 命令）
 */
export default function PromptBar({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  models = [],
  vendorGroups = null,
  model,
  onModelChange,
  chips = [],
  onRemoveChip,
  onPickImage,
  // 粘贴图片回调（可选）。有它才接管 Ctrl+V 里的图片 ——
  // 没传就保持浏览器默认粘贴行为（不吞用户的文本粘贴）。
  onPasteImage,
  onPickFile,
  fileOk = true,
  visionOk = false,
  toggles = [],
  placeholder = "输入你的问题，或分享一个想法…",
  disabled = false,
  moreDisabled = false,
  commands = [],
  textareaRef,
}) {
  const innerRef = useRef(null);
  const taRef = textareaRef || innerRef;
  const modelWrapRef = useRef(null);
  const cmdWrapRef = useRef(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);

  const canSend = !disabled && (value.trim().length > 0 || chips.length > 0);

  // 输入框自增高：使用 auto 准确度量，限制在 36px~160px 之间，超出平滑滚动
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const minH = 36;
    const maxH = 160;
    ta.style.height = "auto";
    const h = ta.scrollHeight;
    ta.style.height = `${Math.min(Math.max(h, minH), maxH)}px`;
    ta.style.overflowY = h > maxH ? "auto" : "hidden";
  }, [value, taRef]);

  // 点外面关菜单
  useEffect(() => {
    if (!modelOpen && !cmdOpen && !attachOpen) return undefined;
    const close = (e) => {
      if (!e.target.closest?.("[data-promptbar-menu]")) {
        setModelOpen(false);
        setCmdOpen(false);
        setAttachOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelOpen, cmdOpen, attachOpen]);

  // 输入 / 开头即打开命令菜单（官方用法）
  useEffect(() => {
    if (commands.length && value.startsWith("/") && !value.includes(" ")) setCmdOpen(true);
    else if (!value.startsWith("/")) setCmdOpen(false);
  }, [value, commands.length]);

  // 当前模型的厂商（图标用）：优先从厂商分组里找，其次从平铺列表
  const modelVendor = (() => {
    for (const g of vendorGroups || []) {
      if (g.models.some((m) => m.id === model)) return g.vendor;
    }
    return models.find((m) => m.id === model)?.vendor;
  })();

  // 按钮上显示友好名称（label），没有 label 才退回 id
  const currentLabel = (() => {
    for (const g of vendorGroups || []) {
      const hit = g.models.find((m) => m.id === model);
      if (hit) return hit.label || hit.id;
    }
    const hit = models.find((m) => m.id === model);
    return hit ? hit.label || hit.id : model || "选择模型";
  })();

  const groups = vendorGroups?.length
    ? vendorGroups
    : models.length
      ? [{ vendor: "all", vendorName: "", models }]
      : [];

  return (
    <div className="bui-promptbar" data-promptbar>
      {/* ---------- 命令菜单（/ 唤起，锚定在输入框上方） ---------- */}
      {cmdOpen && commands.length > 0 ? (
        <div className="bui-upmenu" data-promptbar-menu ref={cmdWrapRef}>
          {commands
            .filter((c) => c.name.toLowerCase().includes(value.slice(1).toLowerCase()))
            .map((c) => (
              <button
                key={c.key}
                type="button"
                className="bui-upmenu-row"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setCmdOpen(false);
                  c.run?.();
                }}
              >
                <span className="nm">/{c.name}</span>
                <span className="ds">{c.desc}</span>
              </button>
            ))}
          <div className="bui-upmenu-foot">输入以筛选命令</div>
        </div>
      ) : null}

      <div className="bui-composer">
        {chips.length > 0 ? (
          <div className="bui-chips">
            {chips.map((c, i) => (
              <span key={`${c.label}-${i}`} className="bui-chip-file">
                {c.src ? <img src={c.src} alt="" /> : c.kind === "file" ? <span className="fi">{FileIcon}</span> : null}
                <span className="nm">{c.label}</span>
                <button type="button" aria-label={`移除 ${c.label}`} onClick={() => onRemoveChip?.(i)}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="bui-composer-row">
          <div className="bui-attachwrap">
            <button
              type="button"
              aria-label="添加附件"
              title="添加图片或文档（PDF / Word / Excel / 文本）"
              aria-expanded={attachOpen}
              disabled={busy || (!onPickImage && !onPickFile)}
              onClick={() => setAttachOpen((v) => !v)}
              className="bui-cbtn"
            >
              {PlusIcon}
            </button>
            {attachOpen ? (
              <div className="bui-upmenu is-attach" data-promptbar-menu>
                <button
                  type="button"
                  className="bui-upmenu-row"
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={!visionOk}
                  onClick={() => {
                    setAttachOpen(false);
                    if (visionOk) onPickImage?.();
                  }}
                >
                  <span className="nm">图片</span>
                  <span className="ds">{visionOk ? "截图、照片，最多 30 张" : "当前模型不支持图片"}</span>
                </button>
                <button
                  type="button"
                  className="bui-upmenu-row"
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={!fileOk}
                  onClick={() => {
                    setAttachOpen(false);
                    onPickFile?.();
                  }}
                >
                  <span className="nm">文档</span>
                  <span className="ds">PDF / Word / Excel / 文本与代码</span>
                </button>
              </div>
            ) : null}
          </div>

          <textarea
            ref={taRef}
            rows={1}
            value={value}
            aria-label="消息内容"
            disabled={disabled}
            placeholder={busy ? "正在生成…" : placeholder}
            onChange={(e) => onChange(e.target.value)}
            // Ctrl+V 贴截图 → 交给上层走图片上传链路。
            //
            // 原先这里**完全没有 onPaste 处理**，于是"往输入框粘截图"什么都不发生：
            // 没缩略图、没 toast、没报错、输入框也没变化（人格实测原话：
            // 「Ctrl+V 和直接派发 paste 事件都试了，没有任何反应……而且是静默的，
            //   连失败都不告诉你。评论框在同一时期是支持粘贴的，对比之下更像漏了。」）
            //
            // 只拦「剪贴板里有图片文件」的情况，其余（纯文本粘贴）不干预 ——
            // 否则会把用户正常贴代码/贴文字也吃掉。
            onPaste={(e) => {
              if (!onPasteImage) return;
              const items = Array.from(e.clipboardData?.items || []);
              const imgs = items
                .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
                .map((it) => it.getAsFile())
                .filter(Boolean);
              if (!imgs.length) return; // 没图就走默认行为
              e.preventDefault();
              onPasteImage(imgs);
            }}
            onKeyDown={(e) => {
              if (cmdOpen && (e.key === "Escape" || e.key === "ArrowDown")) {
                e.preventDefault();
                setCmdOpen(false);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                if (canSend) onSend?.();
              }
            }}
            className="bui-composer-input"
          />

          {/* 模型选择：锚点绑在这个按钮的容器上，输入框长高也不会漂 */}
          <div className="bui-modelwrap" ref={modelWrapRef}>
            <button
              type="button"
              aria-label="选择模型"
              aria-expanded={modelOpen}
              disabled={busy}
              onClick={() => {
                setCmdOpen(false);
                setModelOpen((c) => !c);
              }}
              className="bui-modelbtn"
            >
              <VendorIcon type={modelVendor} size={14} />
              <span className="nm2">{currentLabel}</span>
              <span className="caret">{ChevronIcon}</span>
            </button>

            {modelOpen ? (
              <div className="bui-upmenu is-model" data-promptbar-menu>
                {groups.map((g) => (
                  <div key={g.vendor} className="bui-modelgroup">
                    {g.vendorName ? (
                      <div className="bui-modelgroup-head">
                        <VendorIcon type={g.models[0]?.vendor} size={13} />
                        <span>{g.vendorName}</span>
                        <span className="ct">{g.models.length}</span>
                      </div>
                    ) : null}
                    {g.models.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="bui-upmenu-row is-model"
                        title={m.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          onModelChange?.(m.id);
                          setModelOpen(false);
                          taRef.current?.focus();
                        }}
                      >
                        <VendorIcon type={m.vendor} size={14} />
                        <span className="nm2">{m.label || m.id}</span>
                        {m.deprecated ? <span className="badge">即将下线</span> : null}
                        <span className={`tick ${m.id === model ? "" : "is-off"}`}>{TickIcon}</span>
                      </button>
                    ))}
                  </div>
                ))}
                {!groups.length ? <div className="bui-upmenu-empty">没有可用模型</div> : null}
              </div>
            ) : null}
          </div>

          {toggles.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-label={t.title || t.label}
              title={t.title || t.label}
              aria-pressed={t.on}
              disabled={busy}
              onClick={t.onClick}
              className={`bui-cbtn ${t.on ? "is-accent" : ""}`}
            >
              {t.icon}
            </button>
          ))}

          {busy ? (
            <button type="button" aria-label="停止生成" onClick={onStop} className="bui-cbtn is-stop">
              {StopIcon}
            </button>
          ) : (
            <button type="button" aria-label="发送消息" disabled={!canSend} onClick={() => onSend?.()} className="bui-cbtn is-send">
              {SendIcon}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
