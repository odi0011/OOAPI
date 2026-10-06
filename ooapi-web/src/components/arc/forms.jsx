// 业务表单状态与校验；视觉和输入控件由 Arc 提供，不依赖旧 UI 库。
import React, { createContext, useContext, useEffect, useId, useRef, useSyncExternalStore } from "react";

const Context = createContext(null);
export const FieldContext = createContext({});
const pathOf = name => Array.isArray(name) ? name : [name];
const keyOf = name => pathOf(name).join(".");
const get = (object, name) => pathOf(name).reduce((o, k) => o?.[k], object);
const set = (object, name, value) => {
  const keys = pathOf(name); let o = object;
  keys.slice(0, -1).forEach((key, i) => { o[key] = { ...(o[key] || {}) }; o = o[key]; });
  o[keys.at(-1)] = value;
};
function createForm() {
  let values = {}, initial = {}, version = 0;
  const listeners = new Set(), fields = new Map(), errors = new Map();
  const emit = () => { version++; listeners.forEach(fn => fn()); };
  const form = {
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot: () => version,
    getFieldValue: name => get(values, name),
    getFieldsValue: names => !Array.isArray(names) ? { ...values } : Object.fromEntries(names.map(n => [n, get(values, n)])),
    setFieldsValue: patch => { values = { ...values, ...patch }; errors.clear(); emit(); },
    setFieldValue: (name, value) => { values = { ...values }; set(values, name, value); errors.delete(keyOf(name)); emit(); },
    resetFields: names => { if (names) names.forEach(n => set(values, n, get(initial, n))); else values = { ...initial }; errors.clear(); emit(); },
    setFields: list => { list.forEach(f => { if ("value" in f) set(values, f.name, f.value); if (f.errors?.length) errors.set(keyOf(f.name), f.errors[0]); }); emit(); },
    getFieldError: name => errors.has(keyOf(name)) ? [errors.get(keyOf(name))] : [],
    initialize: data => { initial = data || {}; values = { ...initial, ...values }; },
    register: (name, field) => { const key = keyOf(name); fields.set(key, field); if (field.initialValue !== undefined && get(initial, name) === undefined) set(initial, name, field.initialValue); if (get(values, name) === undefined && field.initialValue !== undefined) { set(values, name, field.initialValue); emit(); } return () => fields.delete(key); },
    async validateFields(names) {
      errors.clear(); const failures = [];
      for (const [key, field] of fields) {
        if (names && !names.some(n => keyOf(n) === key)) continue;
        const value = get(values, field.name);
        for (let rule of field.rules || []) {
          if (typeof rule === "function") rule = rule(form);
          if (!rule) continue;
          const empty = value == null || value === "" || (Array.isArray(value) && !value.length);
          let msg;
          if ((rule.required && empty) || (rule.whitespace && typeof value === "string" && !value.trim())) msg = rule.message || "请填写此项";
          if (!empty) {
            if (rule.pattern && !rule.pattern.test(String(value))) msg = rule.message || "格式不正确";
            if (rule.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) msg = rule.message || "请输入有效邮箱";
            const size = typeof value === "number" ? value : value?.length;
            if (rule.min != null && size < rule.min) msg = rule.message || `最少 ${rule.min}`;
            if (rule.max != null && size > rule.max) msg = rule.message || `最多 ${rule.max}`;
            if (rule.len != null && size !== rule.len) msg = rule.message || `长度应为 ${rule.len}`;
          }
          if (!msg && rule.validator) { try { await rule.validator(rule, value); } catch (e) { msg = e?.message || rule.message || "请检查此项"; } }
          if (msg) { errors.set(key, msg); failures.push({ name: pathOf(field.name), errors: [msg] }); break; }
        }
      }
      emit();
      if (failures.length) { const error = new Error(failures[0].errors[0]); error.errorFields = failures; throw error; }
      return { ...values };
    },
    async submit() { try { const v = await form.validateFields(); await form.onFinish?.(v); } catch (e) { form.onFinishFailed?.(e); } },
    change(name, value) { form.setFieldValue(name, value); form.onValuesChange?.({ [name]: value }, { ...values }); },
  };
  return form;
}
function useForm(provided) { const ref = useRef(null); if (!ref.current) ref.current = provided || createForm(); return [ref.current]; }
function useWatch(name, provided) { const ctx = useContext(Context); const form = provided || ctx?.form; useSyncExternalStore(form?.subscribe || (() => () => {}), form?.snapshot || (() => 0)); return form?.getFieldValue(name); }

export function Form({ form: supplied, initialValues, onFinish, onFinishFailed, onValuesChange, disabled, children, className = "", style, name, id, layout, preserve, labelCol, wrapperCol, requiredMark, ...props }) {
  const [form] = useForm(supplied); const initialized = useRef(false);
  if (!initialized.current) { form.initialize(initialValues); initialized.current = true; }
  form.onFinish = onFinish; form.onFinishFailed = onFinishFailed; form.onValuesChange = onValuesChange;
  return <Context.Provider value={{ form, disabled }}><form {...props} id={id || name} style={style} className={`arc-form ${className}`} onSubmit={e => { e.preventDefault(); form.submit(); }} noValidate>{children}</form></Context.Provider>;
}
function Item({ name, label, rules, children, valuePropName = "value", getValueFromEvent, normalize, initialValue, extra, help, validateStatus, tooltip, noStyle, shouldUpdate, dependencies, className = "", style, hidden, required, ...props }) {
  const { form, disabled } = useContext(Context) || {};
  const uid = useId(); const id = `field-${uid}`;
  useSyncExternalStore(form?.subscribe || (() => () => {}), form?.snapshot || (() => 0));
  const field = useRef({}); field.current = { name, rules, initialValue };
  useEffect(() => name == null || !form ? undefined : form.register(name, { name, get rules() { return field.current.rules; }, initialValue }), [form, keyOf(name)]);
  const error = form?.getFieldError(name)[0] || (validateStatus === "error" ? help : null);
  let content = typeof children === "function" ? children(form) : children;
  if (name != null && React.isValidElement(content)) {
    const change = content.props.onChange;
    const emptyValue = valuePropName === "checked" ? false : ["multiple", "tags"].includes(content.props.mode) ? [] : "";
    content = React.cloneElement(content, { id: content.props.id || id, disabled: content.props.disabled ?? disabled, [valuePropName]: form.getFieldValue(name) ?? emptyValue, "aria-invalid": error ? true : undefined, "aria-describedby": error ? `${id}-error` : undefined, onChange: (...args) => {
      const value = getValueFromEvent ? getValueFromEvent(...args) : args[0]?.target ? args[0].target[valuePropName] : args[0];
      form.change(name, normalize ? normalize(value, form.getFieldValue(name), form.getFieldsValue()) : value); change?.(...args);
    } });
  }
  content = <FieldContext.Provider value={{ label, id, error }}>{content}</FieldContext.Provider>;
  // noStyle 只省略字段布局，校验失败仍要给用户反馈；凭据等嵌套字段
  // 若直接返回输入框，会出现点击提交没有任何可见响应的情况。
  if (noStyle) return <>{content}{error && <div id={`${id}-error`} className="arc-form-error" role="alert">{error}</div>}</>;
  return <div className={`arc-form-item ${className}`} style={style} hidden={hidden}>
    {label != null && <label htmlFor={id} className="arc-form-label">{label}{(required || rules?.some(r => r.required)) && <span aria-hidden="true"> *</span>}{tooltip && <span title={typeof tooltip === "string" ? tooltip : undefined}> ⓘ</span>}</label>}
    {content}{(error || help) && <div id={`${id}-error`} className={error ? "arc-form-error" : "arc-form-hint"} role={error ? "alert" : undefined}>{error || help}</div>}{extra && <div className="arc-form-hint">{extra}</div>}
  </div>;
}
Form.useForm = useForm; Form.useWatch = useWatch; Form.Item = Item;
