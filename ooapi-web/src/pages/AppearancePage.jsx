// 外观设置（即时热注入，不需要「保存并刷新」）
// ---------------------------------------------------------------------------
// 所有控件直接改 ThemeContext 里的外观状态：CSS 变量与 AntD token 同时更新，
// 右侧预览区与整站立刻变化。偏好存本地（localStorage）；管理员可另存为站点默认。
//
// 状态的唯一来源是 ThemeContext（见其文件头注释）。原先本页自己维护一份 state、
// 初值写死为默认值 —— 普通用户读不到 /api/option，刷新后页面显示的档位与实际生效的
// 不一致；AntD 组件也不跟随圆角/密度。这两处都已在 ThemeContext 修正。
//
// 「背景」为什么只有 4 个受控预设、不做图片上传/全色域调色盘：
//   自由壁纸必然让文字对比度失控（深色照片 + 深色文字直接不可读）。
//   这里只给矢量几何底纹，颜色绑定 var(--line)，透明度锁死 0.03~0.06，
//   且卡片/表格/表单内部都是不透明 var(--surface) 实色 ——
//   无论底纹怎么换，正文对比度都稳定满足 WCAG AA。
//   主题色开放自定义，但只接受 #RRGGBB（服务端同样校验），明暗两套由 primaryVars 派生。
import React, { useState } from "react";
import { Segmented, Button, App as AntApp, Tag, Tooltip, Alert, ColorPicker, Switch, Input } from "antd";
import {
  CheckOutlined, BgColorsOutlined, FontSizeOutlined, BorderOutlined, ExpandOutlined, SunOutlined,
  MoonOutlined, DesktopOutlined, UndoOutlined, CloudUploadOutlined, LockOutlined, AppstoreOutlined, SearchOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import { useTheme } from "../theme/ThemeContext";
import {
  PRIMARY_PRESETS, DEFAULT_PRIMARY, BACKGROUNDS, RADIUS_PRESETS, DENSITY_PRESETS, FONT_SIZES, THEME_SCHEMES, isHexColor,
} from "../theme/presets";
import PageHeader from "../components/PageHeader";
// 预览区用到消息气泡（.oo-im-bubble），样式跟着消息中心的样式表走
import "../components/im/im.css";

/** 设置区块：标题 + 说明 + 控件 */
function Section({ title, desc, icon, extra, children }) {
  return (
    <section className="oo-panel oo-appear-section">
      <div className="oo-appear-section-head">
        <div style={{ minWidth: 0 }}>
          <div className="oo-panel-title">
            {icon ? <span className="oo-appear-icon">{icon}</span> : null}
            {title}
          </div>
          {desc ? <div className="oo-appear-desc">{desc}</div> : null}
        </div>
        {extra}
      </div>
      <div className="oo-appear-section-body">{children}</div>
    </section>
  );
}

/** 背景预设的迷你预览：用 CSS 画出与真实底纹一致的缩略图 */
function BgPreview({ bgKey }) {
  const style = { background: "var(--page)" };
  if (bgKey === "blueprint") {
    style.backgroundImage =
      "linear-gradient(to right, var(--line-strong) 1px, transparent 1px), linear-gradient(to bottom, var(--line-strong) 1px, transparent 1px)";
    style.backgroundSize = "12px 12px";
  } else if (bgKey === "dots") {
    style.backgroundImage = "radial-gradient(var(--line-strong) 1px, transparent 1px)";
    style.backgroundSize = "8px 8px";
  } else if (bgKey === "grain") {
    style.backgroundImage =
      "repeating-linear-gradient(45deg, var(--line-strong) 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, var(--line-strong) 0 1px, transparent 1px 5px)";
    style.backgroundSize = "3px 3px, 5px 5px";
  }
  return <div className="oo-appear-bg-thumb" style={style} />;
}

/** 明暗模式卡片里的小窗示意（固定配色，不随当前主题变 —— 它要展示的就是「另一种」长什么样） */
function ModeThumb({ kind }) {
  const light = { bg: "#f6f7f9", side: "#eceef1", card: "#ffffff", line: "#e3e5e8", ink: "#c9ccd1" };
  const dark = { bg: "#1b1c1f", side: "#222326", card: "#2a2b2f", line: "#34363a", ink: "#4a4c52" };
  const one = (c) => (
    <div className="oo-mode-thumb-win" style={{ background: c.bg, borderColor: c.line }}>
      <div style={{ background: c.side }} />
      <div>
        <i style={{ background: c.card, borderColor: c.line }} />
        <i style={{ background: c.ink }} />
        <i style={{ background: c.ink, width: "60%" }} />
      </div>
    </div>
  );
  if (kind === "system") {
    return (
      <div className="oo-mode-thumb oo-mode-thumb--split">
        {one(light)}
        {one(dark)}
      </div>
    );
  }
  return <div className="oo-mode-thumb">{one(kind === "dark" ? dark : light)}</div>;
}

/** 右侧实时预览：用真实组件 + 真实 token，所见即所得 */
function LivePreview() {
  return (
    <div className="oo-appear-preview" aria-label="外观预览">
      <div className="oo-appear-preview-bar">
        <span /><span /><span />
        <em>预览</em>
      </div>
      <div className="oo-appear-preview-body">
        <div className="oo-appear-preview-nav">
          <div className="oo-nav-item is-active"><AppstoreOutlined /><span>工作台</span></div>
          <div className="oo-nav-item"><BgColorsOutlined /><span>外观设置</span></div>
        </div>
        <div className="oo-appear-preview-main">
          <div className="oo-panel" style={{ padding: "var(--sp-3) var(--sp-4)" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>令牌用量</div>
            <div className="oo-desc" style={{ marginBottom: 10 }}>本月已使用 62%，距离上限还有 3,800 次调用。</div>
            <div className="oo-appear-preview-meter"><span style={{ width: "62%" }} /></div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
              <Tag color="blue">GPT</Tag>
              <Tag color="green">正常</Tag>
              <Tag>默认分组</Tag>
            </div>
          </div>
          <Input prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />} placeholder="搜索……" />
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="primary">主要按钮</Button>
            <Button>次要</Button>
          </div>
          <div className="oo-appear-preview-chat">
            <div className="oo-im-bubble">在吗？帮我看下这个报错</div>
            <div className="oo-im-bubble is-mine">好的，发来看看</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AppearancePage() {
  const { message, modal } = AntApp.useApp();
  const { user, refreshStatus } = useApp();
  const {
    mode, setMode, resolved, primary, setPrimary, primaryOverride,
    appearance, overrides, setAppearance, resetAppearance, site, siteLocked,
  } = useTheme();
  const isAdmin = Number(user?.role) >= 100;
  const locked = siteLocked && !isAdmin;
  const [saving, setSaving] = useState(false);
  const [allowCustom, setAllowCustom] = useState(site.user_custom !== false);

  const customized = Object.keys(overrides).length > 0 || Boolean(primaryOverride);
  const isPreset = PRIMARY_PRESETS.some((p) => p.color.toLowerCase() === primary.toLowerCase());
  const activeScheme = THEME_SCHEMES.find(
    (s) =>
      s.primary.toLowerCase() === primary.toLowerCase() &&
      s.radius === appearance.radius &&
      s.density === appearance.density &&
      s.background === appearance.background &&
      s.fontSize === appearance.fontSize
  )?.key;

  const applyScheme = (s) => {
    setPrimary(s.primary);
    setAppearance({ radius: s.radius, density: s.density, background: s.background, fontSize: s.fontSize });
  };

  const saveStationDefault = () => {
    modal.confirm({
      title: "保存为站点默认外观？",
      content: "当前的主题色、底纹、圆角、密度与字号会成为所有「没有自己调过外观」的用户与新访客的初始外观。明暗模式不受影响（仍由每个人自己决定）。",
      okText: "保存",
      onOk: async () => {
        setSaving(true);
        try {
          await API.put("/option/", {
            theme_background: appearance.background,
            theme_radius: appearance.radius,
            theme_density: appearance.density,
            theme_font_size: String(appearance.fontSize),
            theme_accent: primary === DEFAULT_PRIMARY ? "" : primary,
            theme_user_custom: allowCustom ? "true" : "false",
          });
          await refreshStatus();
          message.success("已保存为站点默认外观");
        } catch (e) {
          message.error(e.message);
        } finally {
          setSaving(false);
        }
      },
    });
  };

  return (
    <div className="oo-page">
      <PageHeader
        title="外观设置"
        tags={<Tag color="blue">改动即时生效</Tag>}
        extra={
          <Tooltip title={customized ? "清除本机的外观偏好，回到站点默认" : "当前就是站点默认外观"}>
            <Button icon={<UndoOutlined />} onClick={resetAppearance} disabled={!customized || locked}>
              恢复站点默认
            </Button>
          </Tooltip>
        }
      />

      {locked ? (
        <Alert
          type="info"
          showIcon
          icon={<LockOutlined />}
          message="管理员已统一站点外观"
          description="主题色、底纹、圆角、密度与字号由管理员设定；明暗模式仍可按自己的习惯切换。"
        />
      ) : null}

      <div className="oo-appear-shell">
        <div className="oo-appear-main">
          <Section title="一键方案" desc="主题色、圆角、密度、底纹、字号的推荐组合；选完仍可逐项微调" icon={<AppstoreOutlined />}>
            <div className="oo-scheme-grid">
              {THEME_SCHEMES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`oo-scheme-card${activeScheme === s.key ? " is-active" : ""}`}
                  onClick={() => applyScheme(s)}
                  disabled={locked}
                  aria-pressed={activeScheme === s.key}
                >
                  <span className="oo-scheme-swatch" style={{ background: s.primary, borderRadius: s.radius === "sharp" ? 3 : s.radius === "round" ? 10 : 6 }} />
                  <span style={{ minWidth: 0 }}>
                    <span className="oo-scheme-name">{s.label}</span>
                    <span className="oo-scheme-desc">{s.desc}</span>
                  </span>
                  {activeScheme === s.key ? <CheckOutlined className="oo-scheme-check" /> : null}
                </button>
              ))}
            </div>
          </Section>

          <Section title="明暗模式" desc={`跟随系统时会随操作系统自动切换；当前生效：${resolved === "dark" ? "深色" : "浅色"}`} icon={<SunOutlined />}>
            <div className="oo-mode-grid" role="radiogroup" aria-label="明暗模式">
              {[
                { value: "light", label: "浅色", icon: <SunOutlined /> },
                { value: "dark", label: "深色", icon: <MoonOutlined /> },
                { value: "system", label: "跟随系统", icon: <DesktopOutlined /> },
              ].map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  className={`oo-mode-card${mode === m.value ? " is-active" : ""}`}
                  onClick={() => setMode(m.value)}
                >
                  <ModeThumb kind={m.value} />
                  <span className="oo-mode-label">{m.icon} {m.label}</span>
                </button>
              ))}
            </div>
          </Section>

          <Section title="主题色" desc="影响按钮、链接、选中态、消息气泡与图表首色；深色模式下会自动提亮保证对比度" icon={<BgColorsOutlined />}>
            <div className="oo-swatch-row">
              {PRIMARY_PRESETS.map((p) => {
                const on = primary.toLowerCase() === p.color.toLowerCase();
                return (
                  <Tooltip key={p.key} title={p.label}>
                    <button
                      type="button"
                      className={`oo-swatch${on ? " is-active" : ""}`}
                      style={{ background: p.color }}
                      onClick={() => setPrimary(p.color)}
                      aria-label={p.label}
                      aria-pressed={on}
                      disabled={locked}
                    >
                      {on ? <CheckOutlined /> : null}
                    </button>
                  </Tooltip>
                );
              })}
              <ColorPicker
                value={primary}
                disabledAlpha
                format="hex"
                disabled={locked}
                onChangeComplete={(c) => {
                  const hex = c.toHexString();
                  if (isHexColor(hex)) setPrimary(hex);
                }}
              >
                <button
                  type="button"
                  className={`oo-swatch oo-swatch--custom${!isPreset ? " is-active" : ""}`}
                  style={!isPreset ? { background: primary } : undefined}
                  aria-label="自定义颜色"
                  disabled={locked}
                >
                  {!isPreset ? <CheckOutlined /> : <BgColorsOutlined />}
                </button>
              </ColorPicker>
              <span className="oo-appear-desc oo-num" style={{ marginLeft: 4 }}>{primary.toUpperCase()}</span>
            </div>
          </Section>

          <Section
            title="背景底纹"
            desc="只提供受控的几何底纹：颜色绑定主题线条色、透明度锁死在 3%~6%，卡片与表格始终是不透明实色，因此不影响正文可读性"
            icon={<BorderOutlined />}
          >
            <div className="oo-bg-grid">
              {BACKGROUNDS.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  className={`oo-bg-card${appearance.background === b.key ? " is-active" : ""}`}
                  onClick={() => setAppearance({ background: b.key })}
                  aria-pressed={appearance.background === b.key}
                  disabled={locked}
                >
                  <BgPreview bgKey={b.key} />
                  <span className="oo-bg-name">{b.label}</span>
                  <span className="oo-appear-desc">{b.desc}</span>
                </button>
              ))}
            </div>
          </Section>

          <Section title="布局与文字" desc="圆角、间距密度与正文字号；按钮、输入框、表格、弹窗会一起变化" icon={<ExpandOutlined />}>
            <div className="oo-appear-rows">
              <div className="oo-appear-row">
                <span><BorderOutlined /> 圆角</span>
                <Segmented
                  value={appearance.radius}
                  onChange={(v) => setAppearance({ radius: v })}
                  options={RADIUS_PRESETS.map((r) => ({ value: r.key, label: r.label }))}
                  disabled={locked}
                />
              </div>
              <div className="oo-appear-row">
                <span><ExpandOutlined /> 密度</span>
                <Segmented
                  value={appearance.density}
                  onChange={(v) => setAppearance({ density: v })}
                  options={DENSITY_PRESETS.map((d) => ({ value: d.key, label: d.label }))}
                  disabled={locked}
                />
              </div>
              <div className="oo-appear-row">
                <span><FontSizeOutlined /> 正文字号</span>
                <Segmented
                  value={appearance.fontSize}
                  onChange={(v) => setAppearance({ fontSize: v })}
                  options={FONT_SIZES.map((n) => ({ value: n, label: `${n}px` }))}
                  disabled={locked}
                />
              </div>
            </div>
          </Section>

          {isAdmin ? (
            <Section
              title="站点默认（管理员）"
              desc="把当前外观保存为全站默认：对没有自己调过外观的用户与新访客生效。关闭「允许个性化」后，所有非管理员都固定使用站点默认（明暗模式除外）。"
              icon={<CloudUploadOutlined />}
            >
              <div className="oo-appear-rows">
                <div className="oo-appear-row">
                  <span>允许用户个性化外观</span>
                  <Switch checked={allowCustom} onChange={setAllowCustom} />
                </div>
                <div className="oo-appear-row">
                  <span className="oo-appear-desc">
                    当前站点默认：{BACKGROUNDS.find((b) => b.key === site.background)?.label} ·{" "}
                    {RADIUS_PRESETS.find((r) => r.key === site.radius)?.label}圆角 ·{" "}
                    {DENSITY_PRESETS.find((d) => d.key === site.density)?.label} · {site.fontSize}px ·{" "}
                    {site.accent ? site.accent.toUpperCase() : "内置主色"}
                  </span>
                  <Button type="primary" icon={<CloudUploadOutlined />} loading={saving} onClick={saveStationDefault}>
                    保存为站点默认
                  </Button>
                </div>
              </div>
            </Section>
          ) : null}

          <div className="oo-appear-desc" style={{ padding: "0 2px 24px" }}>
            外观偏好保存在本浏览器；换设备或清除站点数据后会回到站点默认。
          </div>
        </div>

        <aside className="oo-appear-aside">
          <div className="oo-appear-sticky">
            <div className="oo-section-title" style={{ marginBottom: 8 }}>实时预览</div>
            <LivePreview />
          </div>
        </aside>
      </div>
    </div>
  );
}
