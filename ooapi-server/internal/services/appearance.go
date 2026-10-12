package services

// 站点外观设置。
//
// 这些值由管理员统一配置，对全站所有用户生效 ——
// 不是浏览器本地偏好，因此存在服务端 options 表里。
//
// 取值直接对应 Arc UI 的主题机制：
//   theme  → :root[data-theme="dark"]
//   accent → :root[data-accent="violet"]
// 因此前端只需把这两个值写到 <html> 的属性上，整套组件库的颜色会自动切换。

// 明暗模式的可选值。system 表示跟随访问者的系统偏好。
var themeModes = map[string]struct{}{
	"light":  {},
	"dark":   {},
	"system": {},
}

// 主题色的可选值，与 foundation.css 里定义 data-accent 的选择器一一对应。
var accentColors = map[string]struct{}{
	"neutral": {},
	"violet":  {},
	"blue":    {},
	"green":   {},
	"amber":   {},
	"orange":  {},
	"coral":   {},
	"rose":    {},
}

// Appearance 是站点外观配置。
type Appearance struct {
	Theme  string `json:"theme"`
	Accent string `json:"accent"`
	// Font 是站点字体 id，取值见下面的 fontValues。
	Font string `json:"font"`
	// Density 留作将来扩展（comfortable / compact）。
	Density string `json:"density"`
}

// fontValues 是可选字体的白名单，与前端 lib/fonts.ts 的 FONTS 一一对应。
// 全部为公开可商用字体。新增字体时两边必须同步。
var fontValues = map[string]struct{}{
	"zcool-kuaile":            {},
	"noto-sans-sc":            {},
	"noto-serif-sc":           {},
	"zcool-qingke-huangyou":   {},
	"zcool-xiaowei":           {},
	"ma-shan-zheng":           {},
	"long-cang":               {},
	"zhi-mang-xing":           {},
	"liu-jian-mao-cao":        {},
	"zpix":                    {},
}

// DefaultFontID 是默认字体：站酷快乐体。
const DefaultFontID = "zcool-kuaile"

// ValidFont 供写入前校验。
func ValidFont(v string) bool {
	_, ok := fontValues[v]
	return ok
}

// GetAppearance 读取外观设置，非法值时回退到默认。
// 校验放在这里而不是只在写入时：数据库可能被手工改过，
// 也可能存在旧版本写入的值。
func GetAppearance() Appearance {
	theme := GetOption("appearance_theme", "system")
	if _, ok := themeModes[theme]; !ok {
		theme = "system"
	}

	accent := GetOption("appearance_accent", "neutral")
	if _, ok := accentColors[accent]; !ok {
		accent = "neutral"
	}

	density := GetOption("appearance_density", "comfortable")
	if density != "comfortable" && density != "compact" {
		density = "comfortable"
	}

	font := GetOption("appearance_font", DefaultFontID)
	if _, ok := fontValues[font]; !ok {
		font = DefaultFontID
	}

	return Appearance{Theme: theme, Accent: accent, Font: font, Density: density}
}

// ValidTheme 供写入前校验。
func ValidTheme(v string) bool {
	_, ok := themeModes[v]
	return ok
}

// ValidAccent 供写入前校验。
func ValidAccent(v string) bool {
	_, ok := accentColors[v]
	return ok
}

// AccentOptions 返回可选主题色及其显示名，供设置页渲染选择器。
// 与 foundation.css 的选择器保持同步 —— 新增颜色时必须两边都改。
func AccentOptions() []map[string]string {
	return []map[string]string{
		{"value": "neutral", "label": "中性灰"},
		{"value": "violet", "label": "紫罗兰"},
		{"value": "blue", "label": "蓝"},
		{"value": "green", "label": "绿"},
		{"value": "amber", "label": "琥珀"},
		{"value": "orange", "label": "橙"},
		{"value": "coral", "label": "珊瑚"},
		{"value": "rose", "label": "玫红"},
	}
}

// PublicAppearance 是给匿名访客的外观设置。
// 首页也要跟着管理员选的主题走，所以这个必须放在公开接口里。
func PublicAppearance() map[string]any {
	a := GetAppearance()
	return map[string]any{
		"theme":  a.Theme,
		"accent": a.Accent,
		"font":   a.Font,
	}
}
