import React, { useEffect, useRef, useState } from "react";
import { Input, Button, Select, Dropdown, Tag, Tooltip } from "./arc/index";
import { Plus, ArrowUp, Square, Image, FileText, X, KeyRound } from "lucide-react";
import { Card } from "./arc/card/card";
import ComposerCompanion from "./ComposerCompanion";
import { ModelIcon } from "./VendorIcon";

// Arc 的控件承接输入与菜单；路由身份、附件和中文输入法规则由业务层维护。
export default function PromptBar({ value = "", onChange, onSend, onStop, busy = false,
  models = [], vendorGroups, channelType = "", model, onModelChange,
  reasoningLevels = [], reasoningEffort = "", onReasoningChange, settingsSaving = false,
  mascotState, onMascotAction, approvals = [], onApproval, chips = [], onRemoveChip,
  onPickImage, onPasteImage, onPickFile, fileOk = true, visionOk = false,
  keys = [], keyId = 0, onKey, placeholder = "输入你的问题，或分享一个想法…",
  disabled = false, moreDisabled = false, commands = [], textareaRef,
}) {
  const innerRef = useRef(null), taRef = textareaRef || innerRef;
  const focusAfterKey = useRef(false);
  const [hideCommands, setHideCommands] = useState(false);
  const locked = disabled || settingsSaving;
  const composerDisabled = locked || !model;
  const canSend = !busy && !composerDisabled && (value.trim().length > 0 || chips.length > 0);
  const grouped = vendorGroups?.length ? vendorGroups : [{ models, vendor: channelType }];
  const choices = grouped.flatMap(g => g.models.map(m => ({ ...m, vendor: m.vendor || g.vendor, groupName: g.vendorName })));
  // 同名模型可由多个渠道提供，value 同时包含渠道标识，不能只用 model id 去重。
  const modelKey = m => JSON.stringify([m.id, m.vendor || ""]);
  const selectedModel = choices.find(m => m.id === model && (!channelType || m.vendor === channelType));
  useEffect(() => { setHideCommands(false); }, [value]);
  useEffect(() => { if (focusAfterKey.current && !locked && !busy && model) { focusAfterKey.current = false; requestAnimationFrame(() => taRef.current?.focus()); } }, [locked, busy, model, taRef]);
  const send = () => { if (canSend) { onMascotAction?.("send"); onSend?.(); } };
  const commandMatches = !hideCommands && value.startsWith("/") && !value.includes(" ") ? commands.filter(c => c.name.toLowerCase().includes(value.slice(1).toLowerCase())) : [];
  return <div className="arc-composer" data-promptbar>
    {mascotState && <ComposerCompanion state={mascotState} approvals={approvals} onDecide={onApproval} menuOpen="" inputValue={value} inputRef={taRef}/>}
    {commandMatches.length > 0 && <Card title="命令" className="arc-composer-commands">{commandMatches.map(c => <Button key={c.key} type="text" onClick={() => { setHideCommands(true); c.run?.(); }}>/{c.name}<span>{c.desc}</span></Button>)}</Card>}
    <Card title="" className="arc-composer-card">
      {chips.length > 0 && <div className="arc-composer-attachments">{chips.map((c,i) => <Tag key={`${c.label}-${i}`} closable onClose={() => onRemoveChip?.(i)}>{c.src ? <img src={c.src} alt="" width="36" height="36"/> : <FileText size={14}/>}<span>{c.label}</span></Tag>)}</div>}
      <Input.TextArea ref={taRef} value={value} rows={2} autoSize={{ minRows: 2, maxRows: 8 }} aria-label="消息内容" disabled={composerDisabled} placeholder={busy ? "正在生成…" : placeholder}
        onChange={e => { onChange(e.target.value); onMascotAction?.("typing"); }}
        onPaste={e => { if (!onPasteImage) return; const images = Array.from(e.clipboardData?.items || []).filter(it => it.kind === "file" && it.type.startsWith("image/")).map(it => it.getAsFile()).filter(Boolean); if (images.length) { e.preventDefault(); onPasteImage(images); } }}
        onKeyDown={e => { if (e.key === "Escape") setHideCommands(true); if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); } }}/>
      <div className="arc-composer-toolbar">
        <Dropdown disabled={busy || moreDisabled} menu={{ items: [
          { key: "image", label: visionOk ? "添加图片" : "当前模型不支持图片", icon: <Image size={16}/>, disabled: !visionOk || !onPickImage || busy, onClick: onPickImage },
          { key: "file", label: "添加文档", icon: <FileText size={16}/>, disabled: !fileOk || !onPickFile || busy, onClick: onPickFile },
        ] }}><Button size="small" type="text" icon={<Plus size={16}/>} disabled={busy || moreDisabled} aria-label="添加附件" onClick={() => onMascotAction?.("attach")}/></Dropdown>
        <Select className="arc-composer-model" showSearch aria-label="选择模型" value={selectedModel ? modelKey(selectedModel) : undefined} placeholder="选择模型" disabled={busy || locked}
          options={choices.map(m => ({ value: modelKey(m), label: <span className="arc-model-option"><ModelIcon model={m.id} channelType={m.vendor} size={15}/><span>{m.label || m.id}</span>{m.deprecated && <small>即将下线</small>}<small>{m.groupName}</small></span> }))}
          onChange={key => { const m = choices.find(m => modelKey(m) === key); if (m) onModelChange?.(m.id, m.vendor); taRef.current?.focus(); }}/>
        {reasoningLevels.length > 0 && <Select aria-label="推理强度" value={reasoningEffort} disabled={busy || locked} options={[{ value: "", label: "默认推理" }, ...reasoningLevels.map(v => ({ value: v, label: v }))]} onChange={onReasoningChange}/>}
        <span className="arc-composer-spacer"/>
        {keys.length > 0 && <Select className="arc-composer-key" aria-label="选择密钥" onCloseAutoFocus={event => { event.preventDefault(); taRef.current?.focus(); }} value={Number(keyId) || (keys.length === 1 ? Number(keys[0].id) : undefined)} disabled={busy || locked} options={keys.map(k => ({ value: Number(k.id), label: <span className="arc-inline"><KeyRound size={13}/>{k.name}<small>{k.group_name || "公共池"}</small></span> }))} onChange={id => { focusAfterKey.current = true; onKey?.(id); }}/>}
        {busy ? <Button size="small" aria-label="停止生成" onClick={onStop} icon={<Square size={15}/>}/> : <Tooltip title="发送（Enter）"><Button size="small" type="primary" aria-label="发送消息" disabled={!canSend} onClick={send} icon={<ArrowUp size={17}/>}/></Tooltip>}
      </div>
    </Card>
  </div>;
}
