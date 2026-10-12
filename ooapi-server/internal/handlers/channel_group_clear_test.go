package handlers

import (
	"encoding/json"
	"testing"
)

/*
回归：账号分组必须能被改回「所有分组」。

背景：GroupName 原来是值类型 string，更新路径用 `if v != ""` 判断，
于是「传空串」与「没传」无法区分 —— 账号一旦设过分组，
管理员就再也改不回「所有分组」（前端清空会返回 400 nothing_to_update）。
这直接影响可用性：账号被锁在某个分组里时，
其他分组的密钥永远调度不到它，而界面上看不出原因。

修法：字段改成 *string，传空串 = 显式清空。
*/
func TestChannelGroupNameUsesPointerSemantics(t *testing.T) {
	// 没传（JSON 里没有该键）→ nil，表示「不改」。
	var absent channelRequest
	if err := json.Unmarshal([]byte(`{"name":"x"}`), &absent); err != nil {
		t.Fatal(err)
	}
	if absent.GroupName != nil {
		t.Fatalf("missing group_name must decode to nil, got %#v", absent.GroupName)
	}
	if got := optionalGroupName(absent.GroupName); got != "" {
		t.Fatalf("nil group decodes to %q", got)
	}

	// 传空串 → 非 nil 指针指向空串，表示「改回所有分组」。
	var cleared channelRequest
	if err := json.Unmarshal([]byte(`{"name":"x","group_name":""}`), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.GroupName == nil {
		t.Fatal("explicit empty group_name must not decode to nil")
	}
	if got := optionalGroupName(cleared.GroupName); got != "" {
		t.Fatalf("empty group decodes to %q", got)
	}

	// 传具体分组 → 保留（去空白）。
	var named channelRequest
	if err := json.Unmarshal([]byte(`{"name":"x","group_name":" ds-flash "}`), &named); err != nil {
		t.Fatal(err)
	}
	if got := optionalGroupName(named.GroupName); got != "ds-flash" {
		t.Fatalf("named group = %q", got)
	}
}
