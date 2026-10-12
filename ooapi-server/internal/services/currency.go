package services

import (
	"strings"
)

// 货币设置：名称、图标与兑换比例。
//
// 这三项都由管理员配置、对全站生效：
//   name      显示名（默认「OD币」）
//   icon      自定义图标地址，空则用内置金币
//   rate      1 单位货币 = 多少美元（默认 1）
//
// 币种标识不再写死成 "OD"，前端展示一律走 PublicCurrency()。

// Currency 是货币配置。
type Currency struct {
	Name string `json:"currency_name"`
	Icon string `json:"currency_icon"`
	// Rate 是「1 单位货币等于多少美元」。默认 1:1。
	Rate float64 `json:"currency_rate"`
	// UnitsPerOD 保留原字段名以兼容既有数据，语义是「1 单位货币 = 多少内部额度单位」。
	UnitsPerUnit int `json:"units_per_od"`
}

// DefaultCurrencyRate 是默认兑换比例：1 单位货币 = 1 美元。
const DefaultCurrencyRate = 1.0

// GetCurrency 读取货币配置，非法值回退默认。
func GetCurrency() Currency {
	name := strings.TrimSpace(GetOption("currency_name", "OD币"))
	if name == "" {
		name = "OD币"
	}

	// 图标存在 options 里；空表示用内置图标。
	icon := strings.TrimSpace(GetOption("currency_icon", ""))

	rate := GetFloatOption("currency_rate", DefaultCurrencyRate)
	// 比例必须为正：为 0 会导致换算除零，为负会让金额符号反转。
	if rate <= 0 {
		rate = DefaultCurrencyRate
	}

	units := GetIntOption("units_per_od", DefaultUnitsPerOD)
	if units <= 0 {
		units = DefaultUnitsPerOD
	}

	return Currency{
		Name:         name,
		Icon:         icon,
		Rate:         rate,
		UnitsPerUnit: units,
	}
}

// PublicCurrency 是给前端的货币配置。
// 名称与图标要给所有人（首页要显示金额），比例用于展示换算。
func PublicCurrency() map[string]any {
	c := GetCurrency()
	return map[string]any{
		"currency_name": c.Name,
		"currency_icon": c.Icon,
		"currency_rate": c.Rate,
		"units_per_od":  c.UnitsPerUnit,
	}
}

// FormatUnitsToCurrency 把内部额度单位换算成货币数量。
// 全站金额展示统一走这里，避免各处换算口径不一致。
func FormatUnitsToCurrency(units int64, c Currency) float64 {
	if c.UnitsPerUnit <= 0 {
		return 0
	}
	return float64(units) / float64(c.UnitsPerUnit)
}
