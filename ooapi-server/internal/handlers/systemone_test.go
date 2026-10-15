package handlers

import (
	"strings"
	"testing"

	"ooapi/internal/services"
)

func TestSystemOnePathStaysOffChat(t *testing.T) {
	ch := &services.UpstreamChannel{
		ModelPaths: services.ParseModelPaths("chat: *\nsystemone: jev-*"),
	}
	if got := upstreamPathForModel(ch, "jev-1.13-free"); got != "/systemone" {
		t.Fatalf("jev path = %s", got)
	}
	if got := upstreamPathForModel(ch, "big-pickle"); got != "/chat/completions" {
		t.Fatalf("chat path = %s", got)
	}
	// chat: * 写在前面时，决策模型仍然不能被吞进补全接口。
	swallowed := &services.UpstreamChannel{
		ModelPaths: services.ParseModelPaths("chat: *"),
	}
	if got := upstreamPathForModel(swallowed, "jev-1.13"); got != "/systemone" {
		t.Fatalf("wildcard swallowed jev onto %s", got)
	}
}

func TestSystemOneBodyKeepsQuestions(t *testing.T) {
	raw := []byte(`{"model":"alias","state":"health check","questions":{"allow":{"type":"noul","instructions":"ok?"}}}`)
	out, err := buildUpstreamBody("systemone", raw, "jev-1.13-free")
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.Contains(text, `"model":"jev-1.13-free"`) || !strings.Contains(text, `"questions"`) || strings.Contains(text, "reasoning_effort") {
		t.Fatalf("rewritten body = %s", text)
	}
}

func TestDecisionUsageUsesInputTokens(t *testing.T) {
	raw := []byte(`{"model":"jev-1.13-free","answers":{"allow":{"type":"noul","noul":0.84}},"usage":{"input_tokens":289,"output_tokens":20}}`)
	usage, message, ok := usageFromUpstreamBody(raw)
	if !ok || message != "" {
		t.Fatalf("ok=%v message=%s", ok, message)
	}
	if usage.PromptTokens != 289 || usage.CompletionTokens != 20 {
		t.Fatalf("usage = %+v", usage)
	}
	parsed := interpretDecisionBody(raw)
	if parsed.Allow == nil || !*parsed.Allow || parsed.Decision != "allow" || !strings.Contains(parsed.Detail, "0.84") {
		t.Fatalf("decision = %+v", parsed)
	}
}

func TestSystemOneCandidatesDoNotFallBackToChat(t *testing.T) {
	paths := endpointCandidatesFor(90421, "jev-1.13-free", "/systemone")
	if len(paths) != 1 || paths[0] != "/systemone" {
		t.Fatalf("candidates = %#v", paths)
	}
}
