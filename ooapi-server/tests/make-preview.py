# -*- coding: utf-8 -*-
"""生成额度条预览 HTML：用 styles.css 里真实的变量值 + 组件真实的 DOM 结构/内联样式。
因为组件样式全在内联 + CSS 变量上，这个预览与线上渲染是一致的。"""
import io, json, sys

data = json.loads(io.open("pillvars.json", encoding="utf-8").read())

def theme_css(name, v):
    # pillvars.json 里的 pill-* 键没有 `--` 前缀（提取脚本按 {色}-{角色} 存的），
    # 这里统一补上 —— 否则整批 pill 变量会被过滤掉，预览就成了「无色」的样子
    # （第一版正是这么错的，看起来像变量没定义）。
    lines = []
    for k, val in v.items():
        name_ = k if k.startswith("--") else f"--{k}"
        lines.append(f"  {name_}: {val};")
    return "\n".join(lines)

# 与 ChannelQuota.jsx 的 WindowRow 完全同构
def window_row(tag, pct, pill, reset, has_pct=True):
    p = pct
    if has_pct:
        fill = (
            f'<span style="display:block;width:{p}%;height:100%;'
            f'background:var(--{pill}-bar);border-radius:2px"></span>'
        )
        right = (
            f'<span style="color:var({pill}-ink);font-weight:600;flex-shrink:0;font-size:11.5px;'
            f'font-variant-numeric:tabular-nums">{100 if p>=99.95 else round(p)}%</span>'
            f'<span style="color:var(--ink-3);font-size:11px;flex-shrink:0">{reset}</span>'
        )
        mid = f'<span style="flex:1;min-width:32px;height:4px;border-radius:2px;background:var(--pill-track);overflow:hidden;display:inline-block">{fill}</span>'
    else:
        right = '<span style="color:var(--ink-3);flex-shrink:0">—</span>'
        mid = ""
    return (
        '<div style="display:flex;align-items:center;gap:7px;font-size:12px;min-width:0">'
        f'<span style="min-width:34px;text-align:center;font-family:var(--font-mono);font-size:11px;'
        f'font-weight:600;color:var(--{pill}-ink);background:var(--{pill}-tint);border-radius:5px;'
        f'padding:2px 5px;flex-shrink:0;line-height:1.35">{tag}</span>'
        f'{mid}{right}</div>'
    )

def info_pill(text, tone="gray"):
    return (
        f'<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1.5;'
        f'color:var(--{tone}-pill-ink)"/></span>'
    ).replace(f'var(--{tone}-pill-ink)', f'var(--pill-{tone}-ink)').replace(
        '"/></span>', f'">{text}</span>'
    ).replace(f'background:var', f'background:var').replace(
        f'>{text}</span>', f'background:var(--pill-{tone}-tint);border-radius:5px;padding:1px 6px;'
        f'white-space:nowrap">{text}</span>'
    )

CASES = [
    ("OpenAI 免费号（单窗口 30d，用量 0%）", [
        window_row("30d", 0, "pill-indigo", "现在"),
    ], [("套餐 free", "indigo")]),
    ("OpenAI 付费号（5h + 7d 双窗口，用量 12% / 45%）", [
        window_row("5h", 12, "pill-indigo", "3h"),
        window_row("7d", 45, "pill-emerald", "2d"),
    ], [("套餐 plus", "indigo"), ("账号 user@example.com", "gray")]),
    ("接近用满（72% → 琥珀档，93% → 红档）", [
        window_row("5h", 72, "pill-amber", "1h"),
        window_row("7d", 93, "pill-red", "6h"),
    ], [("已达限额", "red")]),
    ("第三窗口起用天蓝/灰（超出两窗口时）", [
        window_row("5h", 5, "pill-indigo", "4h"),
        window_row("7d", 30, "pill-emerald", "5d"),
        window_row("30d", 60, "pill-sky", "18d"),
        window_row("90d", 88, "pill-gray", "60d"),
    ], []),
    ("无百分比、只有余额（DeepSeek / Grok 类）", [
        window_row("额度", 0, "pill-indigo", "", has_pct=False),
    ], [("余额 128.50", "gray"), ("预付费 $12.00", "gray")]),
]

def render(theme):
    blocks = []
    for i, (title, rows, pills) in enumerate(CASES):
        pill_html = "".join(
            f'<span style="display:inline-flex;align-items:center;font-size:11px;line-height:1.5;'
            f'color:var(--pill-{tone}-ink);background:var(--pill-{tone}-tint);border-radius:5px;'
            f'padding:1px 6px;white-space:nowrap">{t}</span>' for t, tone in pills
        )
        blocks.append(f"""
    <div style="margin-bottom:22px">
      <div style="font-size:12px;color:var(--ink-3);margin-bottom:7px">{i+1}. {title}</div>
      <div style="display:flex;flex-direction:column;gap:5px;max-width:430px">{''.join(rows)}</div>
      {f'<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:7px">{pill_html}</div>' if pill_html else ''}
    </div>""")
    return f"""<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8"><style>
html[data-theme="light"] {{
{theme_css('light', data['light'])}
}}
html[data-theme="dark"] {{
{theme_css('dark', data['dark'])}
}}
  html {{ background: var(--surface); }}
  body {{ margin:0; padding:26px; font-family: system-ui, "Noto Sans SC", sans-serif; color: var(--ink); }}
  h2 {{ font-size:14px; margin:0 0 18px; }}
</style></head><body>
  <h2>额度条形态预览 · {theme} 主题</h2>
  {''.join(blocks)}
</body></html>"""

for t in ("light", "dark"):
    io.open(f"preview-{t}.html", "w", encoding="utf-8", newline="\n").write(render(t))
    print("wrote", f"preview-{t}.html")
