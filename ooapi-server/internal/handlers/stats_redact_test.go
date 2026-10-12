package handlers

import "testing"

func TestPresentChannelsHidesUpstreamIdentity(t *testing.T) {
	rows := []statsChannelRow{
		{ID: 7, Name: "openai-prod", Vendor: "openai", Status: 1, Priority: 3, Requests: 4, LastError: "dial 10.0.0.1"},
		{ID: 8, Name: "unused", Vendor: "anthropic", Status: 1},
	}

	hidden := presentChannels(rows, false)
	if len(hidden) != 1 {
		t.Fatalf("unused channel leaked: %#v", hidden)
	}
	got := hidden[0]
	if got.ID == 7 || got.Name != "账号" || got.Vendor != "" || got.Status != 0 || got.LastError != "" || got.Priority != 0 {
		t.Fatalf("identity leaked: %#v", got)
	}
	if got.Requests != 4 {
		t.Fatalf("usage dropped: %#v", got)
	}

	visible := presentChannels(rows, true)
	if len(visible) != 2 || visible[0].Name != "openai-prod" || visible[0].Vendor != "openai" {
		t.Fatalf("admin view changed: %#v", visible)
	}
}
