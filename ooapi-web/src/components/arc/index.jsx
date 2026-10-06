import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { Alert as ArcAlert } from "./alert/alert";
import { Badge as ArcBadge } from "./badge/badge";
import { Avatar as ArcAvatar } from "./avatar/avatar";
import { EmptyState } from "./empty-state/empty-state";
import { Skeleton as ArcSkeleton } from "./skeleton/skeleton";
import { Progress as ArcProgress } from "./progress/progress";
import { Button } from "./controls";
import { Modal } from "./overlays";
export * from "./controls";
export * from "./forms";
export * from "./overlays";
export * from "./data";

export function Alert({ type = "info", message, description, action, closable, onClose, showIcon, banner, icon, ...props }) { return <ArcAlert {...props} tone={type === "error" ? "danger" : type} title={message || ""} onDismiss={closable ? onClose || (() => {}) : undefined}>{description}{action && <div className="arc-alert-actions">{action}</div>}</ArcAlert>; }
export function Tag({ children, color, closable, onClose, icon, bordered, ...props }) { const tone = ["red", "error", "danger", "volcano"].includes(color) ? "danger" : ["green", "success", "cyan"].includes(color) ? "success" : ["orange", "warning", "gold"].includes(color) ? "warning" : ["blue", "processing", "purple", "geekblue"].includes(color) ? "info" : "neutral"; return <ArcBadge {...props} tone={tone} size="sm" icon={icon}>{children}{closable && <button type="button" className="arc-tag-close" aria-label="移除" onClick={onClose}><X size={11}/></button>}</ArcBadge>; }
export function Badge({ status, color, text, count, dot, children, ...props }) { if (children) return <span className="arc-badge-wrap">{children}{!!count && <ArcBadge tone="danger" size="sm">{count}</ArcBadge>}{dot && <i className="arc-status-dot"/>}</span>; return <ArcBadge {...props} tone={status === "error" ? "danger" : status === "success" ? "success" : "neutral"}>{text || count || ""}</ArcBadge>; }
export { Card } from "./card/card";
export function Avatar({ src, children, icon, size = 32, shape, ...props }) { return <ArcAvatar {...props} src={src} name={typeof children === "string" ? children : "用户"} style={{ width: typeof size === "number" ? size : undefined, height: typeof size === "number" ? size : undefined, ...props.style }}/>; }
export function Empty({ description = "暂无数据", children, image, ...props }) { return <EmptyState {...props} title={description || ""} description="" action={children}/>; }
Empty.PRESENTED_IMAGE_SIMPLE = null;
export function Result({ title, subTitle, extra, status, icon }) { return <EmptyState title={title || ""} description={subTitle || ""} action={extra} icon={icon}/>; }
export function Spin({ children, spinning = true, tip, size, style, ...props }) { return <div {...props} className={`arc-busy ${props.className || ""}`} style={style} aria-busy={spinning}>{spinning && <div className="arc-spinner" role="status"><LoaderCircle aria-label="加载中"/>{tip}</div>}{children}</div>; }
export function Skeleton({ paragraph, title, active, ...props }) { return <ArcSkeleton label="加载中" lines={paragraph?.rows || 3} {...props}/>; }
Skeleton.Input = props => <ArcSkeleton lines={1}/>; Skeleton.Button = Skeleton.Input; Skeleton.Avatar = props => <ArcSkeleton avatar lines={1}/>; Skeleton.Image = Skeleton.Avatar;
export function Progress({ percent, showInfo, status, strokeColor, size, ...props }) { return <ArcProgress value={percent || 0} max={100} showValue={showInfo !== false}/>; }
export function Space({ children, size = 8, direction, wrap, align, style, ...props }) { const gap = Array.isArray(size) ? size.join("px ") + "px" : typeof size === "number" ? size : { small: 6, middle: 12, large: 20 }[size] || 8; return <div {...props} className={`arc-inline ${props.className || ""}`} style={{ gap, flexDirection: direction === "vertical" ? "column" : undefined, alignItems: align === "start" ? "flex-start" : align || "center", flexWrap: wrap ? "wrap" : undefined, ...style }}>{children}</div>; }
Space.Compact = Space;
export function Row({ children, gutter = 16, style, ...props }) { return <div {...props} className={`arc-row ${props.className || ""}`} style={{ "--row-column-gap": `${Array.isArray(gutter) ? gutter[0] : gutter}px`, "--row-row-gap": `${Array.isArray(gutter) ? gutter[1] : gutter}px`, ...style }}>{children}</div>; }
export function Col({ children, span = 24, xs, sm, md, lg, xl, style, ...props }) { return <div {...props} className={`arc-col ${props.className || ""}`} style={{ "--col-xs": xs ?? 24, "--col-sm": sm ?? span, "--col-md": md ?? sm ?? span, "--col-lg": lg ?? md ?? sm ?? span, "--col-xl": xl ?? lg ?? md ?? sm ?? span, ...style }}>{children}</div>; }
export function Divider({ children, type }) { return type === "vertical" ? <span className="arc-divider-vertical"/> : <div className="arc-divider">{children && <span>{children}</span>}</div>; }
function useBreakpoint() { const read = () => Object.fromEntries(Object.entries({ xs: 0, sm: 576, md: 768, lg: 992, xl: 1200, xxl: 1600 }).map(([k, n]) => [k, window.innerWidth >= n])); const [state, set] = useState(read); useEffect(() => { const update = () => set(read()); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update); }, []); return state; }
export const Grid = { useBreakpoint };
export function Layout({ children, className = "", ...props }) { return <div {...props} className={`arc-layout ${className}`}>{children}</div>; }
Layout.Header = ({ children, ...props }) => <header {...props}>{children}</header>;
Layout.Content = ({ children, ...props }) => <main {...props}>{children}</main>;
Layout.Sider = ({ width = 232, collapsed, collapsedWidth = 64, children, className = "", style, theme, trigger, collapsible, ...props }) => <aside {...props} className={`arc-sider ${className}`} style={{ width: collapsed ? collapsedWidth : width, flex: `0 0 ${collapsed ? collapsedWidth : width}px`, ...style }}>{children}</aside>;
function Text({ children, type, strong, code, copyable, ellipsis, style, ...props }) { const Tag = code ? "code" : strong ? "strong" : "span"; return <Tag {...props} className={`${ellipsis ? "arc-cell-ellipsis" : ""} ${props.className || ""}`} style={{ color: type === "secondary" ? "var(--text-muted)" : type === "danger" ? "var(--danger)" : undefined, ...style }}>{children}{copyable && <Button size="small" type="text" onClick={() => navigator.clipboard.writeText(copyable.text || String(children))}>复制</Button>}</Tag>; }
export const Typography = { Text, Paragraph: props => <p><Text {...props}/></p>, Title: ({ level = 2, ...props }) => React.createElement(`h${level}`, props), Link: props => <a {...props}/> };
function descriptionItems(children) { return React.Children.toArray(children).flatMap(child => !React.isValidElement(child) ? [] : child.type === React.Fragment ? descriptionItems(child.props.children) : [{ key: child.key, label: child.props.label, children: child.props.children }]); }
export function Descriptions({ items, children, column, bordered, size, className = "", ...props }) { const list = items || descriptionItems(children); return <dl {...props} className={`arc-descriptions ${className}`}>{list.map((i, n) => <div key={i.key || n}><dt>{i.label}</dt><dd>{i.children}</dd></div>)}</dl>; }
Descriptions.Item = () => null;
export function Image({ src, alt = "", preview = true, fallback, ...props }) { const [open, set] = useState(false), [failed, setFailed] = useState(false); return <><img {...props} src={failed && fallback ? fallback : src} alt={alt} onError={() => setFailed(true)} onClick={e => { props.onClick?.(e); if (preview) set(true); }}/>{preview && <Modal title={alt || "图片"} open={open} onCancel={() => set(false)} footer={null} width="min(1000px, 90vw)"><img src={src} alt={alt} style={{ maxWidth: "100%", maxHeight: "75vh", objectFit: "contain" }}/></Modal>}</>; }
Image.PreviewGroup = ({ children }) => children;
export function Upload({ children, beforeUpload, customRequest, accept, multiple, disabled, onChange, ...props }) {
  const input = useRef(null);
  return <span className="arc-upload" onClick={event => { if (!disabled && !event.defaultPrevented && event.target !== input.current) input.current?.click(); }}><input ref={input} type="file" accept={accept} multiple={multiple} disabled={disabled} hidden onChange={async e => { const files = Array.from(e.target.files || []); e.target.value = ""; for (const file of files) { try { const accepted = await beforeUpload?.(file, files); if (accepted === false || accepted === Upload.LIST_IGNORE) continue; const next = accepted instanceof Blob ? accepted : file; await customRequest?.({ file: next, onSuccess: response => onChange?.({ file: { name: file.name, status: "done", response } }), onError: error => onChange?.({ file: { name: file.name, status: "error", error } }) }); } catch (error) { onChange?.({ file: { name: file.name, status: "error", error } }); } } }}/>{children || <Button disabled={disabled}>选择文件</Button>}</span>;
}
Upload.LIST_IGNORE = Symbol("ignore"); Upload.Dragger = Upload;
