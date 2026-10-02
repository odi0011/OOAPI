import React, { useEffect, useState } from "react";
import { Alert, App as AntApp, Button, ColorPicker, Input, Segmented, Select, Skeleton, Switch, Tag } from "antd";
import { CheckOutlined, SaveOutlined, UndoOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import { useTheme } from "../theme/ThemeContext";
import { BACKGROUNDS, DENSITY_PRESETS, FONT_FAMILIES, FONT_SIZES, PRIMARY_PRESETS, RADIUS_PRESETS, DEFAULT_PRIMARY } from "../theme/presets";
import { OdCoin } from "./OdCoin";
import { HOME_WALLPAPERS, homeWallpaperUrl } from "../services/home-wallpaper";
import "./appearance-settings.css";

const bool = (v) => v === true || v === "true";
function fromOptions(o) {
  return {
    default_theme: o.default_theme || "system",
    theme_accent: o.theme_accent || PRIMARY_PRESETS.find((p) => p.key === o.default_primary)?.color || DEFAULT_PRIMARY,
    theme_background: o.theme_background || "pure", theme_radius: o.theme_radius || "default",
    theme_density: o.theme_density || "compact", theme_font_size: Number(o.theme_font_size) || 13,
    theme_font_family: o.theme_font_family || "playful",
    default_collapse_sidebar: bool(o.default_collapse_sidebar),
    home_show_models: bool(o.home_show_models), home_show_pricing: bool(o.home_show_pricing),
    home_background_light: o.home_background_light || "", home_background_dark: o.home_background_dark || "",
  };
}
function Row({ label, children }) {
  return <div className="oo-site-appearance-row"><div className="oo-site-appearance-label">{label}</div><div>{children}</div></div>;
}

function WallpaperField({ mode, value, disabled, onChange }) {
  const label = mode === "dark" ? "暗色主题背景" : "亮色主题背景";
  const source = homeWallpaperUrl(value, mode);
  const [failedSource, setFailedSource] = useState("");
  const invalid = !!value.trim() && source === HOME_WALLPAPERS[mode] && value.trim() !== source;
  const failed = failedSource === source;
  return <div className="oo-wallpaper-field">
    <div className="oo-wallpaper-field-heading"><label htmlFor={`wallpaper-${mode}`}>{label}</label><span>{mode === "dark" ? "NIGHT" : "DAY"}</span></div>
    <div className="oo-wallpaper-preview" data-mode={mode}>
      <img key={source} src={source} alt={`${label}预览`} referrerPolicy="no-referrer" onLoad={() => setFailedSource("")} onError={() => setFailedSource(source)} hidden={failed} />
      {failed && <span>图片无法加载，请检查地址</span>}
    </div>
    <Input id={`wallpaper-${mode}`} aria-label={label} value={value} disabled={disabled} status={invalid || failed ? "error" : undefined} placeholder="留空使用默认背景" onChange={(e) => onChange(e.target.value)} allowClear />
    <div className="oo-wallpaper-field-footer"><span>{invalid ? "请填写 http(s) 地址或站内图片路径" : value.trim() ? "自定义图片" : "使用内置背景"}</span><Button type="link" size="small" disabled={disabled || !value} onClick={() => onChange("")}>恢复默认</Button></div>
  </div>;
}

export default function AppearanceSettings() {
  const { refreshStatus, user } = useApp();
  const { message } = AntApp.useApp();
  const { previewAppearance, setSiteAppearance } = useTheme();
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    API.get("/option/").then((o) => { if (live) { const next = fromOptions(o); setSaved(next); setDraft(next); setError(""); } })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [reload]);
  useEffect(() => {
    if (!draft || Number(user?.role) < 100) return;
    previewAppearance({ mode: draft.default_theme, accent: draft.theme_accent, background: draft.theme_background,
      radius: draft.theme_radius, density: draft.theme_density, fontSize: draft.theme_font_size, fontFamily: draft.theme_font_family });
    return () => previewAppearance(null);
  }, [draft, user?.role, previewAppearance]);
  const change = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => {
    setBusy(true); setError("");
    try {
      await API.put("/option/", draft);
      setSaved(draft);
      setSiteAppearance({ mode: draft.default_theme, accent: draft.theme_accent, background: draft.theme_background,
        radius: draft.theme_radius, density: draft.theme_density, font_size: draft.theme_font_size, font_family: draft.theme_font_family }, true);
      await refreshStatus();
      message.success("外观已保存，全站生效");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  if (!draft) return error ? <Alert type="error" showIcon message={error} action={<Button onClick={() => setReload((n) => n + 1)}>重试</Button>} /> : <Skeleton active />;
  return <div className="oo-site-appearance">
    <div className="oo-site-appearance-heading"><div><h2>全站外观</h2><span>站点默认外观，保存后生效</span></div><Tag>{dirty ? "预览中 · 未保存" : "已保存"}</Tag></div>
    {error && <Alert type="error" showIcon message={error} />}
    <div className="oo-site-appearance-grid">
      <div className="oo-site-appearance-controls" aria-busy={busy}>
        <section className="oo-site-appearance-section"><h3>主题与配色</h3>
          <Row label="默认明暗模式"><Segmented aria-label="站点明暗模式" disabled={busy} value={draft.default_theme} onChange={(v) => change("default_theme", v)} options={[{ label: "浅色", value: "light" }, { label: "深色", value: "dark" }, { label: "跟随系统", value: "system" }]} /></Row>
          <Row label="主题色"><div className="oo-site-appearance-colors">{PRIMARY_PRESETS.map((p) => <Button key={p.key} disabled={busy} aria-label={p.label} aria-pressed={draft.theme_accent.toLowerCase() === p.color.toLowerCase()} title={p.label} className="oo-site-appearance-swatch" style={{ background: p.color }} onClick={() => change("theme_accent", p.color)} icon={draft.theme_accent.toLowerCase() === p.color.toLowerCase() ? <CheckOutlined /> : undefined} />)}<ColorPicker disabled={busy} value={draft.theme_accent} disabledAlpha onChangeComplete={(color) => change("theme_accent", color.toHexString())} /></div></Row>
          <Row label="页面背景"><div className="oo-site-appearance-backgrounds">{BACKGROUNDS.map((p) => <Button disabled={busy} key={p.key} aria-pressed={draft.theme_background === p.key} className={draft.theme_background === p.key ? "is-selected" : ""} onClick={() => change("theme_background", p.key)}><i data-pattern={p.key} /><span>{p.label}</span></Button>)}</div></Row>
        </section>
        <section className="oo-site-appearance-section"><h3>文字与布局</h3>
          <Row label="界面字体"><Select aria-label="界面字体" disabled={busy} value={draft.theme_font_family} onChange={(v) => change("theme_font_family", v)} options={FONT_FAMILIES.map((p) => ({ value: p.key, label: p.label }))} /></Row>
          <Row label="文字大小"><Segmented disabled={busy} value={draft.theme_font_size} onChange={(v) => change("theme_font_size", v)} options={FONT_SIZES.map((v) => ({ value: v, label: `${v} px` }))} /></Row>
          <Row label="圆角"><Segmented disabled={busy} value={draft.theme_radius} onChange={(v) => change("theme_radius", v)} options={RADIUS_PRESETS.map((p) => ({ value: p.key, label: p.label }))} /></Row>
          <Row label="间距密度"><Segmented disabled={busy} value={draft.theme_density} onChange={(v) => change("theme_density", v)} options={DENSITY_PRESETS.map((p) => ({ value: p.key, label: p.label }))} /></Row>
          <Row label="默认收起侧边栏"><Switch disabled={busy} aria-label="默认收起侧边栏" checked={draft.default_collapse_sidebar} onChange={(v) => change("default_collapse_sidebar", v)} /></Row>
        </section>
        <section className="oo-site-appearance-section"><h3>首页展示</h3>
          <Row label="模型列表"><Switch disabled={busy} aria-label="首页模型列表" checked={draft.home_show_models} onChange={(v) => change("home_show_models", v)} /></Row>
          <Row label="定价入口"><Switch disabled={busy} aria-label="首页定价入口" checked={draft.home_show_pricing} onChange={(v) => change("home_show_pricing", v)} /></Row>
        </section>
        <section className="oo-site-appearance-section"><h3>首页背景</h3>
          <p className="oo-wallpaper-description">分别设置亮色与暗色主题的背景，首页会随明暗模式自动切换。填写图片地址，留空使用默认背景。</p>
          <div className="oo-wallpaper-fields">{["light", "dark"].map((mode) => <WallpaperField key={mode} mode={mode} value={draft[`home_background_${mode}`]} disabled={busy} onChange={(v) => change(`home_background_${mode}`, v)} />)}</div>
        </section>
      </div>
      <aside className="oo-site-appearance-preview" aria-label="外观预览"><div className="oo-site-appearance-preview-title">实时预览</div><div className="oo-site-appearance-preview-window"><div className="oo-site-appearance-preview-bar"><i /><i /><i /></div><div className="oo-site-appearance-preview-content"><h3>工作台</h3><div className="oo-site-appearance-sample-card"><span>可用余额</span><strong><OdCoin /> 128.50</strong><Tag color="success">运行正常</Tag></div><Input placeholder="搜索模型" aria-label="预览搜索模型" /><div className="oo-site-appearance-preview-buttons"><Button type="primary">主要按钮</Button><Button>次要按钮</Button></div><div className="oo-site-appearance-sample-message">帮我整理今天的使用情况</div><p>可以，我会先查询你的调用记录。</p></div></div></aside>
    </div>
    <div className="oo-site-appearance-save"><span>{dirty ? "有未保存的外观调整" : "当前为站点已保存的外观"}</span><Button icon={<UndoOutlined />} disabled={!dirty || busy} onClick={() => { setDraft(saved); setError(""); }}>撤销修改</Button><Button type="primary" icon={<SaveOutlined />} disabled={!dirty} loading={busy} onClick={save}>保存外观</Button></div>
  </div>;
}
