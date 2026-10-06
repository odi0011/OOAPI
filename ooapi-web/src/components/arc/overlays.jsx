import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./controls";
import { Dialog, DialogContent } from "./dialog/dialog";
import { Drawer as ArcDrawer, DrawerContent } from "./drawer/drawer";
import { Tooltip as ArcTooltip } from "./tooltip/tooltip";
import { Popover as ArcPopover, PopoverTrigger, PopoverContent } from "./popover/popover";
import { DropdownMenu } from "./dropdown-menu/dropdown-menu";
import { ToastStackProvider, ToastStack, useToastStack } from "./toast-stack/toast-stack";

export function Tooltip({ title, children, placement, trigger, disabled = false, ...props }) { if (!title) return children; if (trigger === "click" || Array.isArray(trigger) && trigger.includes("click")) return <Popover content={title} placement={placement} trigger={trigger} disabled={disabled}>{children}</Popover>; const side = placement?.includes("left") ? "left" : placement?.includes("right") ? "right" : placement?.startsWith("bottom") ? "bottom" : "top"; return <ArcTooltip content={title} side={side} disabled={disabled}><span {...props} className="arc-tooltip-anchor" tabIndex={0}>{children}</span></ArcTooltip>; }
export function Popover({ title, content, children, open, onOpenChange, placement, trigger, overlayClassName, rootClassName, overlayStyle, disabled = false }) {
  const [local, set] = useState(false); const hover = !trigger || trigger === "hover" || Array.isArray(trigger) && trigger.includes("hover");
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (disabled) { clearTimeout(timer.current); set(false); } }, [disabled]);
  const change = v => { const next = !disabled && v; set(next); onOpenChange?.(next); };
  const enter = () => { clearTimeout(timer.current); if (hover) change(true); };
  const leave = () => { if (hover) timer.current = setTimeout(() => change(false), 180); };
  return <ArcPopover open={!disabled && (open ?? local)} onOpenChange={change}><PopoverTrigger asChild><span className="arc-tooltip-anchor" tabIndex={0} onMouseEnter={enter} onMouseLeave={leave}>{children}</span></PopoverTrigger><PopoverContent className={overlayClassName || rootClassName} style={overlayStyle} side={placement?.includes("left") ? "left" : placement?.includes("right") ? "right" : placement?.startsWith("top") ? "top" : "bottom"} onMouseEnter={enter} onMouseLeave={leave}>{title && <strong>{title}</strong>}{content}</PopoverContent></ArcPopover>;
}
export function Modal({ open, title, children, onCancel, onOk, footer, confirmLoading, okText = "确定", cancelText = "取消", width = 560, className = "", styles, style, maskClosable = true, keyboard = true, closable = true, okButtonProps, cancelButtonProps, afterClose, afterOpenChange, ...props }) {
  const callbacks = useRef({ afterClose, afterOpenChange }); callbacks.current = { afterClose, afterOpenChange };
  const mounted = useRef(false);
  useEffect(() => { if (!mounted.current && !open) { mounted.current = true; return; } mounted.current = true; const timer = setTimeout(() => { callbacks.current.afterOpenChange?.(!!open); if (!open) callbacks.current.afterClose?.(); }, 240); return () => clearTimeout(timer); }, [open]);
  return <Dialog open={!!open} onOpenChange={v => { if (!v) onCancel?.(); }}><DialogContent title={title || ""} className={`arc-modal ${className} ${!closable ? "arc-no-close" : ""}`} style={{ width, maxWidth: "calc(100vw - 32px)", ...style }} onPointerDownOutside={e => { if (!maskClosable) e.preventDefault(); }} onEscapeKeyDown={e => { if (!keyboard || e.target?.closest?.('[data-arc-select-open="true"]')) e.preventDefault(); }} aria-describedby={undefined}>
    <div className="arc-modal-body" style={styles?.body}>{children}</div>{footer !== null && <div className="arc-modal-footer" style={styles?.footer}>{footer === undefined ? <><Button {...cancelButtonProps} onClick={onCancel}>{cancelText}</Button><Button type="primary" {...okButtonProps} loading={confirmLoading} onClick={onOk}>{okText}</Button></> : footer}</div>}
  </DialogContent></Dialog>;
}
export function Drawer({ open, title, children, onClose, footer, extra, width = 560, placement = "right", className = "", styles, maskClosable = true, getContainer, closable = true, ...props }) {
  return <ArcDrawer open={!!open} onOpenChange={v => { if (!v) onClose?.(); }}><DrawerContent title={title || ""} side={placement} className={`arc-drawer ${className} ${!closable ? "arc-no-close" : ""}`} style={{ width, maxWidth: "100vw", ...props.style }} onPointerDownOutside={e => { if (!maskClosable) e.preventDefault(); }} onEscapeKeyDown={e => { if (e.target?.closest?.('[data-arc-select-open="true"]')) e.preventDefault(); }} aria-describedby={undefined}>
    {extra && <div className="arc-drawer-extra">{extra}</div>}<div className="arc-drawer-body" style={styles?.body}>{children}</div>{footer != null && <div className="arc-modal-footer" style={styles?.footer}>{footer}</div>}
  </DrawerContent></ArcDrawer>;
}
export function Dropdown({ children, menu = {}, disabled }) { let separator = false; const items = []; for (const item of menu.items || []) { if (!item) continue; if (item.type === "divider") { separator = true; continue; } items.push({ label: item.label, icon: item.icon, disabled: disabled || item.disabled, destructive: item.danger, separatorBefore: separator, onSelect: () => { item.onClick?.({ key: item.key }); menu.onClick?.({ key: item.key }); } }); separator = false; } return <DropdownMenu label="操作" trigger={children} items={items}/>; }
export function Popconfirm({ title, description, children, onConfirm, onCancel, okText = "确定", cancelText = "取消", disabled, okButtonProps }) {
  const [open, set] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (disabled) return children;
  return <ArcPopover open={open} onOpenChange={set}><PopoverTrigger asChild>{children}</PopoverTrigger><PopoverContent><strong>{title}</strong>{description && <p>{description}</p>}{error && <p role="alert" className="arc-form-error">{error}</p>}<div className="arc-modal-footer"><Button size="small" onClick={() => { set(false); onCancel?.(); }}>{cancelText}</Button><Button size="small" type="primary" {...okButtonProps} loading={busy} onClick={async () => { setBusy(true); setError(""); try { await onConfirm?.(); set(false); } catch (e) { setError(e.message || "操作失败，请重试"); } finally { setBusy(false); } }}>{okText}</Button></div></PopoverContent></ArcPopover>;
}
const AppContext = createContext(null);
function AppServices({ children }) {
  const toasts = useToastStack(); const [dialogs, setDialogs] = useState([]);
  const services = useMemo(() => {
    const message = {};
    for (const type of ["success", "error", "info", "warning", "loading"]) message[type] = (content, duration) => { const opts = typeof content === "object" && !React.isValidElement(content) ? content : { content, duration }; const id = toasts.toast({ type, title: opts.content, duration: opts.duration === 0 ? Infinity : (opts.duration || (type === "loading" ? 0 : 4)) * 1000 || Infinity, ...(opts.key != null ? { id: String(opts.key) } : {}) }); return () => toasts.dismiss(id); };
    message.destroy = id => toasts.dismiss(id == null ? undefined : String(id));
    const modal = {};
    for (const type of ["confirm", "info", "success", "warning", "error"]) modal[type] = opts => {
      const id = crypto.randomUUID(); let resolve; const promise = new Promise(done => { resolve = done; });
      const record = { id, opts: { ...opts, type }, resolve };
      const destroy = () => { setDialogs(all => all.filter(d => d.id !== id)); resolve(false); };
      promise.destroy = destroy; promise.update = patch => setDialogs(all => all.map(d => d.id === id ? { ...d, opts: { ...d.opts, ...patch } } : d));
      setDialogs(all => [...all, record]); return promise;
    }
    modal.destroyAll = () => setDialogs([]);
    const notification = { ...message, open: opts => toasts.toast({
      id: opts.key == null ? undefined : String(opts.key),
      type: opts.type || "info",
      title: opts.message || "通知",
      description: opts.description,
      duration: opts.duration === 0 ? Infinity : (opts.duration ?? 4) * 1000,
    }) };
    return { message, notification, modal };
  }, [toasts]);
  return <AppContext.Provider value={services}>{children}<ToastStack label="操作提示" className="arc-toast-stack"/>{dialogs.map(d => <ConfirmDialog key={d.id} record={d} remove={result => { setDialogs(all => all.filter(x => x.id !== d.id)); d.resolve(result); }}/>)}</AppContext.Provider>;
}
function ConfirmDialog({ record: { opts }, remove }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Modal {...opts} open title={opts.title} onCancel={() => { opts.onCancel?.(); remove(false); }} confirmLoading={busy} onOk={async () => { setBusy(true); setError(""); try { await opts.onOk?.(); remove(true); } catch (e) { setError(e?.message || "操作失败，请重试"); } finally { setBusy(false); } }}>
    {opts.content}{error && <p role="alert" className="arc-form-error">{error}</p>}
  </Modal>;
}
export function App({ children }) { return <ToastStackProvider><AppServices>{children}</AppServices></ToastStackProvider>; }
App.useApp = () => useContext(AppContext);
