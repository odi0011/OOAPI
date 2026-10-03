import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Input } from "antd";
import ComposerCompanion from "./ComposerCompanion";
import { ModelIcon, VendorIcon } from "./VendorIcon";


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
const KeyIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.7 12.3L21 2M17 6l3 3M14 9l2 2" />
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
  channelType = "",
  model,
  onModelChange,
  reasoningLevels = [],
  reasoningEffort = "",
  onReasoningChange,
  settingsSaving = false,
  mascotState,
  onMascotAction,
  approvals = [],
  onApproval,
  chips = [],
  onRemoveChip,
  onPickImage,
  // 粘贴图片回调（可选）。有它才接管 Ctrl+V 里的图片 ——
  // 没传就保持浏览器默认粘贴行为（不吞用户的文本粘贴）。
  onPasteImage,
  onPickFile,
  fileOk = true,
  visionOk = false,
  // 可用密钥（>1 把时在工具行显示切换器；只有 1 把就不打扰）
  keys = [],
  keyId = 0,
  onKey,
  placeholder = "输入你的问题，或分享一个想法…",
  disabled = false,
  moreDisabled = false,
  commands = [],
  textareaRef,
}) {
  const innerRef = useRef(null);
  const taRef = textareaRef || innerRef;
  // 上层的粘贴、发送后聚焦仍需要真实文本节点；AntD 的 ref 是控件实例。
  const setTextareaRef = useCallback((instance) => {
    taRef.current = instance?.resizableTextArea?.textArea || null;
  }, [taRef]);
  const modelWrapRef = useRef(null);
  const cmdWrapRef = useRef(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const menuOpen = modelOpen ? "model" : reasoningOpen ? "reasoning" : keyOpen ? "key" : attachOpen ? "attach" : cmdOpen ? "command" : "";

  const composerDisabled = disabled || settingsSaving || !model;
  const canSend = !composerDisabled && (value.trim().length > 0 || chips.length > 0);

  // 输入框自增高：使用 auto 准确度量，限制在 36px~200px 之间，超出平滑滚动
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const minH = 36;
    const maxH = 200;
    ta.style.height = "auto";
    const h = ta.scrollHeight;
    ta.style.height = `${Math.min(Math.max(h, minH), maxH)}px`;
    ta.style.overflowY = h > maxH ? "auto" : "hidden";
  }, [value, taRef]);

  // 点外面关菜单
  useEffect(() => {
    if (!modelOpen && !cmdOpen && !attachOpen && !keyOpen && !reasoningOpen) return undefined;
    const close = (e) => {
      // 点菜单本身或它的触发按钮都不关（触发按钮自己会切换开关，否则会「关了又开」）
      if (!e.target.closest?.("[data-promptbar-menu], .bui-attachwrap, .bui-modelwrap")) {
        setModelOpen(false);
        setCmdOpen(false);
        setAttachOpen(false);
        setKeyOpen(false); setReasoningOpen(false);
      }
    };
    const esc = (e) => {
      if (e.key === "Escape") {
        setModelOpen(false);
        setAttachOpen(false);
        setKeyOpen(false); setReasoningOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [modelOpen, cmdOpen, attachOpen, keyOpen, reasoningOpen]);

  // 输入 / 开头即打开命令菜单（官方用法）
  useEffect(() => {
    if (commands.length && value.startsWith("/") && !value.includes(" ")) setCmdOpen(true);
    else if (!value.startsWith("/")) setCmdOpen(false);
  }, [value, commands.length]);

  // 元信息的 vendor 是可调用渠道来源；同名模型不能按模型名称猜开发厂商。
  const sourceForModel = (id) => {
    const vendor = models.find((m) => m.id === id)?.vendor;
    if (vendor) return vendor;
    for (const g of vendorGroups || []) {
      const hit = g.models.find((m) => m.id === id);
      if (hit?.vendor) return hit.vendor;
    }
  };
  const modelChannelType = channelType || sourceForModel(model);

  // 按钮上显示友好名称（label），没有 label 才退回 id
  const currentLabel = (() => {
    for (const g of vendorGroups || []) {
      const hit = g.models.find((m) => m.id === model && (!channelType || m.vendor === channelType));
      if (hit) return hit.label || hit.id;
    }
    const hit = models.find((m) => m.id === model && (!channelType || m.vendor === channelType));
    return hit ? hit.label || hit.id : model || "选择模型";
  })();

  const groups = vendorGroups?.length
    ? vendorGroups
    : models.length
      ? [{ vendor: "all", vendorName: "", models }]
      : [];

  const closeAll = () => {
    setModelOpen(false);
    setCmdOpen(false);
    setAttachOpen(false);
    setKeyOpen(false); setReasoningOpen(false);
  };
  const curKey = keys.find((k) => k.id === keyId);

  return (
    <div className="bui-promptbar" data-promptbar onKeyDown={e => {
      const menu = e.target.closest?.("[data-promptbar-menu]");
      if (!menu) return;
      if (e.key === "Escape") menu.parentElement.querySelector("button")?.focus();
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      if (!items.length) return;
      e.preventDefault();
      const current = items.indexOf(document.activeElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }}>
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

      {mascotState && <ComposerCompanion state={mascotState} approvals={approvals} onDecide={onApproval} menuOpen={menuOpen}/>}
      <div className={`bui-composer${disabled ? " is-disabled" : ""}`}>
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

        {/* 第一行：输入框独占整行（原先与 5 个按钮挤在一行：按钮底对齐、文字顶对齐，
            单行时上下错位；多行时右侧一串按钮悬在最底部） */}
            <Input.TextArea
          ref={setTextareaRef}
          variant="borderless"
          rows={1}
          value={value}
          aria-label="消息内容"
          disabled={composerDisabled}
          placeholder={busy ? "正在生成…" : placeholder}
              onChange={(e) => { onChange(e.target.value); onMascotAction?.("typing"); }}
          // Ctrl+V 贴截图 → 交给上层走图片上传链路。
          // 原先这里**完全没有 onPaste 处理**，于是"往输入框粘截图"什么都不发生
          // （人格实测：「Ctrl+V 没有任何反应……而且是静默的」）。
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
              if (canSend) { onMascotAction?.("send"); onSend?.(); }
            }
          }}
          className="bui-composer-input"
        />

        {/* 第二行：模型紧跟附件，推理模式跟随模型；发送固定在最右侧 */}
        <div className="bui-composer-bar">
          <div className="bui-attachwrap">
            <button
              type="button"
              aria-label="添加附件"
              title="添加图片或文档（PDF / Word / Excel / 文本）"
              aria-expanded={attachOpen}
              disabled={busy || (!onPickImage && !onPickFile)}
              onClick={() => { const v = !attachOpen; closeAll(); setAttachOpen(v); onMascotAction?.("attach"); }}
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
                  {ImageIcon}
                  <span className="nm">图片</span>
                  <span className="ds">{visionOk ? "截图、照片，也可直接粘贴" : "当前模型不支持图片"}</span>
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
                  {FileIcon}
                  <span className="nm">文档</span>
                  <span className="ds">PDF / Word / Excel / 文本与代码</span>
                </button>
              </div>
            ) : null}
          </div>

          {/* 模型选择：锚点绑在这个按钮的容器上，输入框长高也不会漂 */}
          <div className="bui-modelwrap is-model-select" ref={modelWrapRef}>
            <button
              type="button"
              aria-label="选择模型"
              aria-expanded={modelOpen}
              disabled={busy || disabled || settingsSaving}
              onClick={() => { const v = !modelOpen; closeAll(); setModelOpen(v); }}
              className="bui-selbtn"
            >
              <ModelIcon model={model} channelType={modelChannelType} size={14} />
              <span className="nm2">{currentLabel}</span>
              <span className="caret">{ChevronIcon}</span>
            </button>

            {modelOpen ? (
              <div className="bui-upmenu is-model" data-promptbar-menu>
                {groups.map((g) => (
                  <div key={g.vendor} className="bui-modelgroup">
                    {g.vendorName ? (
                      <div className="bui-modelgroup-head">
                        <VendorIcon type={g.vendor} size={13} />
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
                        disabled={busy || disabled || settingsSaving}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          onModelChange?.(m.id, m.vendor);
                          setModelOpen(false);
                          taRef.current?.focus();
                        }}
                      >
                        <ModelIcon model={m.id} channelType={m.vendor || g.vendor} size={14} />
                        <span className="nm2">{m.label || m.id}</span>
                        {m.deprecated ? <span className="badge">即将下线</span> : null}
                        <span className={`tick ${m.id === model && (!channelType || m.vendor === channelType) ? "" : "is-off"}`}>{TickIcon}</span>
                      </button>
                    ))}
                  </div>
                ))}
                {!groups.length ? <div className="bui-upmenu-empty">没有可用模型</div> : null}
              </div>
            ) : null}
          </div>

          {reasoningLevels.length > 0 && <div className="bui-modelwrap is-reasoning">
            <button type="button" className="bui-selbtn" aria-label="推理强度" aria-expanded={reasoningOpen} disabled={busy || disabled || settingsSaving} onClick={() => { const v = !reasoningOpen; closeAll(); setReasoningOpen(v); }}>
              <span className="nm2">{reasoningEffort || "默认"}</span><span className="caret">{ChevronIcon}</span>
            </button>
            {reasoningOpen && <div className="bui-upmenu is-reasoning" data-promptbar-menu role="menu" aria-label="选择推理强度">
              {["", ...reasoningLevels.filter(v => v !== "")].map(level => <button key={level} type="button" className="bui-upmenu-row" role="menuitemradio" aria-checked={level === reasoningEffort} disabled={busy || disabled || settingsSaving} onClick={() => { closeAll(); onReasoningChange?.(level); taRef.current?.focus(); }}>
                <span className="nm2">{level || "模型默认"}</span><span className={`tick ${level === reasoningEffort ? "" : "is-off"}`}>{TickIcon}</span>
              </button>)}
            </div>}
          </div>}
          <span className="bui-composer-spacer" />
          {/* 密钥：只有一把可用密钥时不显示（没得选就不打扰） */}
          {keys.length > 1 ? (
            <div className="bui-modelwrap is-key is-right">
              <button
                type="button"
                className="bui-selbtn"
                aria-label="选择密钥"
                aria-expanded={keyOpen}
                disabled={busy || disabled || settingsSaving}
                title="密钥决定可用模型与计费分组"
                onClick={() => { const v = !keyOpen; closeAll(); setKeyOpen(v); }}
              >
                {KeyIcon}
                <span className="nm2">{curKey?.name || "选择密钥"}</span>
                <span className="caret">{ChevronIcon}</span>
              </button>
              {keyOpen ? (
                <div className="bui-upmenu is-model" data-promptbar-menu>
                  {keys.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      className="bui-upmenu-row is-model"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setKeyOpen(false); setReasoningOpen(false);
                        onKey?.(k.id);
                      }}
                    >
                      <span className="nm2">{k.name}</span>
                      <span className="ds" style={{ flex: "0 1 auto" }}>{k.group_name || "公共池"}</span>
                      <span className={`tick ${k.id === keyId ? "" : "is-off"}`}>{TickIcon}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}



          {busy ? (
            <button type="button" aria-label="停止生成" title="停止生成" onClick={onStop} className="bui-cbtn is-stop">
              {StopIcon}
            </button>
          ) : (
            <button type="button" aria-label="发送消息" title="发送（Enter）" disabled={!canSend} onClick={() => { onMascotAction?.("send"); onSend?.(); }} className="bui-cbtn is-send">
              {SendIcon}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
