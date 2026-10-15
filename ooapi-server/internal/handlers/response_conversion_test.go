package handlers

import (
	"testing"

	"ooapi/internal/services"
)

/*
回归：订阅渠道的响应不能再翻一遍。

Claude 一键登录与 Codex 的 transport 是双向转换的 —— 响应方向已经把上游
打回 chat 形状；而这两家的 model_paths 被服务端固定成 /messages、/responses
（上游真的只认那两个端点），upstreamProtocol() 因此报 "anthropic"/"responses"。

网关若照这个再翻一遍，就是把已经标准化的 chat 响应当 Anthropic 响应解析：
非流式拿不到 content、usage 归零；流式 switch 上游事件的 type 全落空、
正文与工具调用被整段丢弃。
*/
func TestShouldConvertUpstreamResponse(t *testing.T) {
	for _, tt := range []struct {
		name     string
		protocol string
		method   string
		want     bool
	}{
		{"普通账号的 chat 上游不用翻", "openai", "api", false},
		{"普通账号配了 Anthropic 兼容端点，照常翻", "anthropic", "api", true},
		{"普通账号配了 Responses 端点，照常翻", "responses", "api", true},
		{"Claude 订阅渠道已归一，不能再翻", "anthropic", services.LoginVendorClaudeOAuth, false},
		{"Codex 订阅渠道已归一，不能再翻", "responses", services.LoginVendorCodex, false},
		{"Antigravity 走 chat 主路径，协议本就是 openai", "openai", services.LoginVendorAntigravity, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ch := &services.UpstreamChannel{Method: tt.method}
			if got := shouldConvertUpstreamResponse(tt.protocol, ch); got != tt.want {
				t.Fatalf("protocol=%q method=%q 期望 %v，得到 %v", tt.protocol, tt.method, tt.want, got)
			}
		})
	}

	// 账号为 nil（理论上不会走到）时按「没归一过」处理，宁可多翻一次也不要漏计费。
	if !shouldConvertUpstreamResponse("anthropic", nil) {
		t.Fatal("ch 为 nil 时应保守地照常转换")
	}
}
