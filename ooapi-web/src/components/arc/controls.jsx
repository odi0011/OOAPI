// 将平台的字段值/事件与 Arc 官方控件连接；控件样式与交互来自 Arc registry。
import React, { forwardRef, useContext, useEffect, useRef, useState } from "react";
import dayjs from "dayjs";
import { Search, X } from "lucide-react";
import { Button as ArcButton } from "./button/button";
import { Input as ArcInput } from "./input/input";
import { Textarea } from "./textarea/textarea";
import { PasswordField } from "./password-field/password-field";
import { Select as ArcSelect } from "./select/select";
import { Combobox } from "./combobox/combobox";
import { MultiSelect } from "./multi-select/multi-select";
import { Checkbox as ArcCheckbox } from "./checkbox/checkbox";
import { Switch as ArcSwitch } from "./switch/switch";
import SegmentedControl from "./segmented-control/segmented-control";
import { RadioGroup } from "./radio-group/radio-group";
import { Slider as ArcSlider } from "./slider/slider";
import { ColorPicker as ArcColorPicker } from "./color-picker/color-picker";
import { DatePicker as ArcDatePicker } from "./date-picker/date-picker";
import { FieldContext } from "./forms";

export const textOf = node => node == null || typeof node === "boolean" ? "" : typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(textOf).join(" ") : React.isValidElement(node) ? textOf(node.props.children) || node.props.title || node.props.name || "" : "";
const sizeOf = size => ({ small: "sm", large: "lg" }[size] || "md");
export const Button = forwardRef(function Button({ type, htmlType = "button", size, icon, danger, block, shape, children, href, target, loading, ...props }, ref) {
  return <ArcButton {...props} ref={ref} type={htmlType} size={sizeOf(size)} variant={danger ? "danger" : type === "primary" ? "primary" : ["text", "link"].includes(type) ? "ghost" : "secondary"} loading={!!loading} style={{ ...(block ? { width: "100%" } : {}), ...props.style }} onClick={href ? e => { props.onClick?.(e); if (!e.defaultPrevented) { if (target === "_blank") window.open(href, "_blank", "noopener,noreferrer"); else window.location.assign(href); } } : props.onClick}>{icon}{children}</ArcButton>;
});
function useValue(value, initial, onChange) { const [internal, set] = useState(initial); return [value !== undefined ? value : internal, next => { set(next); onChange?.(next); }]; }
export const Input = forwardRef(function Input({ prefix, suffix, addonAfter, addonBefore, allowClear, size, status, bordered, variant, onPressEnter, onChange, value, defaultValue, className = "", style, ...props }, ref) {
  const field = useContext(FieldContext); const [current, update] = useValue(value, defaultValue ?? "", v => onChange?.({ target: { value: v } }));
  return <div className={`arc-input-wrap ${className}`} style={style} data-size={sizeOf(size)}>{addonBefore || prefix ? <span className="arc-input-prefix">{addonBefore || prefix}</span> : null}<ArcInput {...props} label="" ref={ref} value={current ?? ""} aria-label={props["aria-label"] || textOf(field.label) || props.placeholder} onChange={e => { update(e.target.value); }} onKeyDown={e => { props.onKeyDown?.(e); if (e.key === "Enter") onPressEnter?.(e); }} />{allowClear && current ? <button type="button" className="arc-input-clear" aria-label="清空" disabled={props.disabled} onClick={() => update("")}><X size={14}/></button> : null}{suffix || addonAfter ? <span className="arc-input-suffix">{suffix || addonAfter}</span> : null}</div>;
});
Input.TextArea = forwardRef(function TextArea({ autoSize, showCount, onPressEnter, onChange, value, className = "", style, ...props }, ref) {
  const field = useContext(FieldContext); const inner = useRef(null);
  useEffect(() => { if (autoSize && inner.current) { const node = inner.current; node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, (autoSize.maxRows || 20) * 22 + 20)}px`; } }, [value, autoSize]);
  return <div className={`arc-textarea-wrap ${className}`} style={style}><Textarea {...props} label="" value={value ?? ""} aria-label={props["aria-label"] || textOf(field.label) || props.placeholder} rows={props.rows || autoSize?.minRows || 3} onChange={onChange} ref={node => { inner.current = node; if (typeof ref === "function") ref(node); else if (ref) ref.current = node; }} onKeyDown={e => { props.onKeyDown?.(e); if (e.key === "Enter") onPressEnter?.(e); }}/>{showCount && <small>{String(value || "").length}{props.maxLength ? ` / ${props.maxLength}` : ""}</small>}</div>;
});
Input.Password = forwardRef(function Password({ prefix, suffix, size, className = "", style, visibilityToggle, ...props }, ref) { const field = useContext(FieldContext); return <div className={`arc-input-wrap ${className}`} style={style}><PasswordField {...props} label="" aria-label={textOf(field.label) || props.placeholder} ref={ref}/></div>; });
Input.Search = function SearchInput({ onSearch, enterButton, loading, ...props }) { const [value, update] = useValue(props.value, props.defaultValue || "", v => props.onChange?.({ target: { value: v } })); return <Input {...props} value={value} onChange={e => update(e.target.value)} onPressEnter={() => onSearch?.(value)} prefix={<Search size={15}/>} suffix={enterButton ? <Button loading={loading} onClick={() => onSearch?.(value)}>{typeof enterButton === "string" ? enterButton : "搜索"}</Button> : null}/>; };
Input.Group = ({ children, style }) => <div className="arc-inline" style={style}>{children}</div>;

// 金额与限额字段必须保留空值，不得被 NumberField 的默认 0 静默改写。
export const InputNumber = forwardRef(function InputNumber({ onChange, value, defaultValue, min, max, precision, step = 1, formatter, parser, controls, keyboard, stringMode, ...props }, ref) {
  const [current, update] = useValue(value, defaultValue ?? null, onChange);
  return <Input {...props} ref={ref} type="number" min={min} max={max} step={precision != null ? 10 ** -precision : step} value={current ?? ""} onChange={e => { const raw = e.target.value; update(raw === "" ? null : stringMode ? raw : Number(raw)); }}/>;
});
export const Select = forwardRef(function Select({ options, children, mode, onChange, value, defaultValue, showSearch, allowClear, placeholder = "请选择", style, className = "", disabled, loading, onSearch, onClear, labelInValue, optionFilterProp, filterOption, maxTagCount, popupRender, dropdownRender, onDropdownVisibleChange, onOpenChange, ...props }, ref) {
  const field = useContext(FieldContext);
  const flat = (options || React.Children.toArray(children).map(c => ({ ...c.props, label: c.props.children }))).flatMap(o => o.options || o);
  const optionsWithValues = flat.map(o => ({ ...o, originalOption: o, rawValue: o.value, value: o.value === "" ? "__arc_empty__" : String(o.value), label: o.label ?? String(o.value), searchText: o.searchText ?? textOf(o.label) }));
  // 自定义过滤接收业务原始字段（例如 search）；远程搜索不得再按显示名称二次筛掉服务端结果。
  const matchOption = filterOption === false ? false : typeof filterOption === "function" ? (query, option) => filterOption(query, option.originalOption || option) : optionFilterProp ? (query, option) => textOf((option.originalOption || option)[optionFilterProp]).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) : undefined;
  const [current, update] = useValue(value, defaultValue, v => onChange?.(v, Array.isArray(v) ? v.map(x => flat.find(o => o.value === x)) : flat.find(o => o.value === v)));
  const encode = v => v == null ? "" : v === "" ? "__arc_empty__" : String(labelInValue ? v.value : v);
  const decode = v => { const o = optionsWithValues.find(o => o.value === v); return labelInValue ? { value: o?.rawValue ?? v, label: o?.label ?? v } : o?.rawValue ?? v; };
  const multi = mode === "multiple" || mode === "tags";
  const opts = [...optionsWithValues];
  for (const v of multi ? current || [] : current == null ? [] : [current]) if (!opts.some(o => o.value === encode(v))) opts.push({ value: encode(v), label: labelInValue ? v.label : String(v) });
  const common = { label: "", disabled, placeholder: loading ? "加载中…" : placeholder, options: opts, value: multi ? (current || []).map(encode) : encode(current), onValueChange: next => update(multi ? next.map(decode) : decode(next)), "aria-label": props["aria-label"] || textOf(field.label) || placeholder, id: props.id, onCloseAutoFocus: props.onCloseAutoFocus };
  return <div className={`arc-select-wrap ${className}`} style={style}>{multi ? <MultiSelect {...common} onSearch={onSearch} filterOption={matchOption} maxVisible={typeof maxTagCount === "number" ? maxTagCount : 3} searchable allowCreate={mode === "tags"}/> : showSearch ? <Combobox {...common} onSearch={onSearch} filterOption={matchOption} ref={ref} options={opts.map(o => ({ ...o, displayLabel: o.label, label: textOf(o.label), keywords: [...(o.keywords || []), String(o.rawValue)] }))} emptyMessage="没有匹配项"/> : <ArcSelect {...common} ref={ref}/>} {allowClear && (multi ? current?.length : current != null) ? <button type="button" className="arc-select-clear" aria-label="清空选择" disabled={disabled} onClick={() => { update(multi ? [] : undefined); onClear?.(); }}><X size={13}/></button> : null}</div>;
});
Select.Option = () => null; Select.OptGroup = () => null;
export const Checkbox = forwardRef(function Checkbox({ children, checked, defaultChecked, onChange, indeterminate, ...props }, ref) { return <ArcCheckbox {...props} ref={ref} label={children} checked={indeterminate ? "indeterminate" : checked} defaultChecked={defaultChecked} onCheckedChange={v => onChange?.({ target: { checked: v === true } })}/>; });
Checkbox.Group = function CheckboxGroup({ options = [], value = [], onChange, children, ...props }) { return <div className="arc-inline" {...props}>{options.map(o => { const item = typeof o === "string" ? { label: o, value: o } : o; return <Checkbox key={item.value} checked={value.includes(item.value)} disabled={item.disabled} onChange={e => onChange?.(e.target.checked ? [...value, item.value] : value.filter(v => v !== item.value))}>{item.label}</Checkbox>; })}{children}</div>; };
export const Switch = forwardRef(function Switch({ onChange, loading, size, checkedChildren, unCheckedChildren, ...props }, ref) { return <ArcSwitch {...props} ref={ref} disabled={props.disabled || loading} onCheckedChange={v => onChange?.(v)}/>; });
export function Segmented({ options = [], value, defaultValue, onChange, disabled, block, size, ...props }) { const [v, set] = useValue(value, defaultValue ?? options[0]?.value ?? options[0], onChange); const opts = options.map(o => typeof o === "object" ? o : { value: o, label: o }); return <fieldset className="arc-control-fieldset" disabled={disabled}><SegmentedControl {...props} options={opts.map(o => ({ ...o, value: String(o.value) }))} value={String(v)} onValueChange={next => set(opts.find(o => String(o.value) === next)?.value ?? next)}/></fieldset>; }
export function Radio() { return null; }
Radio.Button = Radio;
Radio.Group = function RadioControls({ options, children, value, defaultValue, onChange, optionType, buttonStyle, disabled, ...props }) {
  const opts = (options || React.Children.toArray(children).map(c => ({ value: c.props.value, label: c.props.children, disabled: c.props.disabled }))).map(o => typeof o === "string" || typeof o === "number" ? { value: o, label: o } : o);
  const [current, update] = useValue(value, defaultValue, next => onChange?.({ target: { value: next } }));
  return <RadioGroup {...props} label="" disabled={disabled} options={opts.map(o => ({ ...o, value: String(o.value) }))} value={String(current ?? "")} onValueChange={v => update(opts.find(o => String(o.value) === v)?.value ?? v)}/>;
};
export function Slider({ onChange, tooltip, marks, ...props }) { return <ArcSlider {...props} label="" marks={marks ? Object.entries(marks).map(([value, label]) => ({ value: Number(value), label })) : undefined} onValueChange={onChange}/>; }
export function ColorPicker({ onChange, onChangeComplete, value, disabled, ...props }) { return <fieldset className="arc-control-fieldset" disabled={disabled}><ArcColorPicker value={typeof value === "string" ? value : value?.toHexString?.()} label="颜色" onValueChange={hex => { const color = { toHexString: () => hex }; onChange?.(color, hex); onChangeComplete?.(color); }}/></fieldset>; }
export function DatePicker({ value, defaultValue, onChange, showTime, style, className = "", disabled, placeholder = "选择日期", ...props }) {
  const field = useContext(FieldContext);
  const [current, update] = useValue(value, defaultValue, onChange);
  const date = current ? dayjs(current).toDate() : undefined;
  return <div className={`arc-inline ${className}`} style={style}><ArcDatePicker {...props} label="" locale="zh-CN" disabled={disabled} aria-label={props["aria-label"] || textOf(field.label) || placeholder} value={date} onChange={v => update(v ? dayjs(v) : null)} placeholder={placeholder}/>{showTime && <Input type="time" aria-label="时间" disabled={disabled} value={date ? dayjs(date).format("HH:mm") : "00:00"} onChange={e => { const [h, m] = e.target.value.split(":").map(Number); update(dayjs(date || new Date()).hour(h).minute(m)); }}/>}</div>;
}
