package handlers

import (
	"testing"

	"ooapi/internal/services"
)

/*
回归：模型目录不能把上游账号身份泄露给普通用户。

/api/admin/models/catalog 只要求 pricing:view，而 authz 把该能力点也授予了
RoleUser。目录里每个模型带着「被哪些账号支持」的列表，含账号 id / 名称 /
厂商 / 接入方式 / 状态 —— 这些属于基础设施信息，别处（统计的 presentChannels、
日志查询）都只对有 channel:view 的人展示，这里必须同一口径。
*/
func TestRedactCatalogChannelsHidesIdentityWithoutPermission(t *testing.T) {
	build := func() []services.ModelCatalogEntry {
		return []services.ModelCatalogEntry{{
			Model: "gpt-4",
			Channels: []services.ModelCatalogChannel{
				{ID: 7, Name: "OpenCode Zen", Vendor: "opencode", Method: "api", Status: 1},
				{ID: 9, Name: "Cline", Vendor: "cline", Method: "device", Status: 0},
			},
		}}
	}

	// 有 channel:view：原样返回，不能误删。
	kept := redactCatalogChannels(build(), true)
	if kept[0].Channels[0].Name != "OpenCode Zen" || kept[0].Channels[0].Vendor != "opencode" {
		t.Fatalf("有权限时不该脱敏: %+v", kept[0].Channels[0])
	}

	// 没有 channel:view：只剩「有几个账号支持」，身份字段全部抹掉。
	redacted := redactCatalogChannels(build(), false)
	if len(redacted[0].Channels) != 2 {
		t.Fatalf("账号数量应保留，得到 %d", len(redacted[0].Channels))
	}
	for i, ch := range redacted[0].Channels {
		if ch.Name != "账号" || ch.Vendor != "" || ch.Method != "" || ch.Status != 0 {
			t.Fatalf("第 %d 个账号身份没抹干净: %+v", i, ch)
		}
		// id 仍要唯一，前端用它做 key。
		if ch.ID != int64(i+1) {
			t.Fatalf("第 %d 个账号 id 应重编号为 %d，得到 %d", i, i+1, ch.ID)
		}
	}
	// 模型名本身不脱敏 —— 那正是这个页面要给用户看的东西。
	if redacted[0].Model != "gpt-4" {
		t.Fatalf("模型名被误改: %q", redacted[0].Model)
	}
}
