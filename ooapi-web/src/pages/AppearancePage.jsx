// 系统设置 · 外观（即时热注入，不需要「保存并刷新」）
// ---------------------------------------------------------------------------
// 依据 Gemini 第 10 点：既然有完整的 CSS 变量体系，调控件就该**立刻看到效果**。
// 这里所有 onChange 都直接调 applyAppearance(...) → setProperty 到根样式，
// 保存只是把偏好持久化（写 localStorage + 可选写服务端默认值）。
//
// 「背景」为什么只有 4 个受控预设、不做图片上传/全色域调色盘：
//   自由壁纸必然让文字对比度失控（深色照片 + 深色文字直接不可读）。
//   这里只给矢量几何底纹，颜色绑定 var(--line)，透明度锁死 0.03~0.06，
//   且卡片/表格/表单内部都是不透明 var(--surface) 实色 ——
//   无论底纹怎么换，正文对比度都稳定满足 WCAG AA。
import React, { useEffect, useState } from "react";
import { Segmented, Button, Space, App as AntApp, Tag, Tooltip, Divider, Alert } from "antd";
import { CheckOutlined, BgColorsOutlined, FontSizeOutlined, BorderOutlined, ExpandOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import { useTheme } from "../theme/ThemeContext";
import {
  PRIMARY_PRESETS, DEFAULT_PRIMARY, BACKGROUNDS, RADIUS_PRESETS, DENSITY_PRESETS, applyAppearance,
} from "../theme/presets";
import PageHeader from "../components/PageHeader";

const FONT_SIZES = [
  { value: 13, label: "13（紧凑）" },
  { value: 14, label: "14（标准）" },
  { value: 15, label: "15（宽松）" },
];

/** 设置区块：标题 + 说明 + 控件 */
function Section({ title, desc, icon, children }) {
  return (
    <div className="oo-panel" style={{ marginBottom: 12 }}>
      <div className="oo-panel-head" style={{ paddingBottom: 0 }}>
        <div>
          <div className="oo-panel-title">
            {icon ? <span style={{ marginRight: 6 }}>{icon}</span> : null}
            {title}
          </div>
          {desc ? <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{desc}</div> : null}
        </div>
      </div>
      <div className="oo-panel-body">{children}</div>
    </div>
  );
}

/** 背景预设的迷你预览：用 CSS 画出与真实底纹一致的缩略图 */
function BgPreview({ bgKey }) {
  const style = {
    width: "100%",
    height: 44,
    borderRadius: "var(--r-sm)",
    border: "1px solid var(--line)",
    background: "var(--page)",
    backgroundRepeat: "repeat",
  };
  if (bgKey === "blueprint") {
    style.backgroundImage =
      "linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px)";
    style.backgroundSize = "12px 12px";
  } else if (bgKey === "dots") {
    style.backgroundImage = "radial-gradient(var(--line) 1px, transparent 1px)";
    style.backgroundSize = "8px 8px";
  } else if (bgKey === "grain") {
    style.backgroundImage =
      "repeating-linear-gradient(45deg, var(--line) 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, var(--line) 0 1px, transparent 1px 5px)";
    style.backgroundSize = "3px 3px, 5px 5px";
  }
  return <div style={style} />;
}

export default function AppearancePage() {
  const { message } = AntApp.useApp();
  const { status } = useApp();
  const { mode, setMode, primary, setPrimary, resolved } = useTheme();

  const [bg, setBg] = useState("pure");
  const [radius, setRadius] = useState("default");
  const [density, setDensity] = useState("compact");
  const [fontSize, setFontSize] = useState(13);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [superOnly, setSuperOnly] = useState([]);
  const [isSuper, setIsSuper] = useState(false);

  // 读站点默认外观（管理员配的），作为未个性化用户的初始值
  useEffect(() => {
    (async () => {
      try {
        const d = await API.get("/option/");
        setBg(String(d?.theme_background || "pure"));
        setRadius(String(d?.theme_radius || "default"));
        setDensity(String(d?.theme_density || "compact"));
        setFontSize(Number(d?.theme_font_size) || 13);
      } catch {
        /* 普通用户读不到 options（需要管理员）：用默认值，仍可本地个性化 */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 站点默认值 + 本地偏好的合并：
  // 本地有偏好时优先（用户自己调过的不能被站点默认覆盖回去）
  const apply = (patch) => {
    applyAppearance({ ...patch, resolved });
    // 持久化到 localStorage：main.jsx 启动时会读，否则刷新就丢
    try {
      if (patch.background !== undefined) localStorage.setItem("ooapi-bg", String(patch.background));
      if (patch.radius !== undefined) localStorage.setItem("ooapi-radius", String(patch.radius));
      if (patch.density !== undefined) localStorage.setItem("ooapi-density", String(patch.density));
      if (patch.fontSize !== undefined) localStorage.setItem("ooapi-fontsize", String(patch.fontSize));
    } catch {
      /* 隐私模式下写不了 localStorage：本次会话仍生效 */
    }
  };

  const saveStationDefault = async () => {
    setSaving(true);
    try {
      await API.put("/option/", {
        theme_background: bg,
        theme_radius: radius,
        theme_density: density,
        theme_font_size: String(fontSize),
      });
      message.success("已保存为站点默认外观（对所有未个性化用户生效）");
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="oo-page">
      <PageHeader
        title="外观设置"
        tags={<Tag color="blue">改动即时生效，无需刷新</Tag>}
        extra={
          <Button onClick={saveStationDefault} loading={saving} type="primary">
            保存为站点默认
          </Button>
        }
      />

      <Alert
        type="info"
        showIcon
        message="所有调整都是即时预览"
        description="下面的改动会立刻应用到你当前浏览器（存在本地）；点「保存为站点默认」则同时写入站点配置，作为其它用户/新访客的初始外观。"
        style={{ marginBottom: 12 }}
      />

      <Section title="主题模式" desc="跟随系统时会随操作系统的深浅色自动切换" icon={<BgColorsOutlined />}>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "light", label: "浅色" },
            { value: "dark", label: "深色" },
            { value: "system", label: "跟随系统" },
          ]}
        />
        <span style={{ marginLeft: 12, fontSize: 12, color: "var(--ink-3)" }}>
          当前生效：{resolved === "dark" ? "深色" : "浅色"}
        </span>
      </Section>

      <Section title="主题色" desc="影响按钮、链接、选中态与图表首色" icon={<BgColorsOutlined />}>
        <Space size={[8, 8]} wrap>
          {PRIMARY_PRESETS.map((p) => (
            <Tooltip key={p.key} title={p.label}>
              <button
                type="button"
                onClick={() => setPrimary(p.color)}
                aria-label={p.label}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "var(--r-btn)",
                  background: p.color,
                  border: primary === p.color ? "2px solid var(--ink)" : "1px solid var(--line)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                }}
              >
                {primary === p.color ? <CheckOutlined style={{ fontSize: 13 }} /> : null}
              </button>
            </Tooltip>
          ))}
          <Button size="small" onClick={() => setPrimary(DEFAULT_PRIMARY)}>恢复默认</Button>
        </Space>
      </Section>

      <Section
        title="背景底纹"
        desc="只提供受控的几何底纹：底纹颜色绑定主题线条色，透明度锁死在 3%~6%，且卡片/表格/表单始终是不透明实色 —— 因此无论选哪种，正文对比度都稳定可读"
        icon={<BorderOutlined />}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          {BACKGROUNDS.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => {
                setBg(b.key);
                apply({ background: b.key });
              }}
              style={{
                textAlign: "left",
                padding: 8,
                borderRadius: "var(--r-card)",
                border: bg === b.key ? "1px solid var(--accent)" : "1px solid var(--line)",
                background: bg === b.key ? "var(--accent-tint)" : "var(--surface)",
                cursor: "pointer",
              }}
            >
              <BgPreview bgKey={b.key} />
              <div style={{ fontSize: 12.5, fontWeight: 550, marginTop: 6 }}>{b.label}</div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{b.desc}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="圆角" desc="直角更「工具感」，圆润更柔和" icon={<BorderOutlined />}>
        <Segmented
          value={radius}
          onChange={(v) => {
            setRadius(v);
            apply({ radius: v });
          }}
          options={RADIUS_PRESETS.map((r) => ({ value: r.key, label: r.label }))}
        />
      </Section>

      <Section title="布局密度" desc="控制全站间距（表格行高、卡片内边距、表单间距都跟着变）" icon={<ExpandOutlined />}>
        <Segmented
          value={density}
          onChange={(v) => {
            setDensity(v);
            apply({ density: v });
          }}
          options={DENSITY_PRESETS.map((d) => ({ value: d.key, label: d.label }))}
        />
      </Section>

      <Section title="正文字号" desc="标题会按比例跟随，不需要逐个调整" icon={<FontSizeOutlined />}>
        <Segmented
          value={fontSize}
          onChange={(v) => {
            setFontSize(v);
            apply({ fontSize: v });
          }}
          options={FONT_SIZES}
        />
      </Section>

      <Divider style={{ margin: "4px 0 12px" }} />
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 24 }}>
        提示：外观偏好保存在本浏览器；换设备或清除站点数据后会回到站点默认。
      </div>
    </div>
  );
}
