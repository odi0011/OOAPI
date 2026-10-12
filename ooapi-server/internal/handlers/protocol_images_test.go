package handlers

import (
	"encoding/json"
	"strings"
	"testing"
)

// 复现线上回归：chat 协议分支必须原样保留 image_url。
func TestChatBranchPreservesImage(t *testing.T) {
	payload := `{"model":"deepseek-flash","max_tokens":300,"messages":[{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAB"}}]}]}`
	out, err := buildUpstreamBody("openai", []byte(payload), "deepseek-v4.1-flash")
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, "data:image/png;base64,AAAB") {
		t.Fatalf("图片被丢弃! out=%s", s)
	}
	if !strings.Contains(s, `"deepseek-v4.1-flash"`) {
		t.Fatalf("模型名未重写: %s", s)
	}
}
const tinyPNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

func chatBodyWithImage() []byte {
	payload := map[string]any{
		"model": "deepseek-flash",
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "看图"},
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": tinyPNG}},
			}},
		},
		"max_tokens": 100,
	}
	b, _ := json.Marshal(payload)
	return b
}

// 出站 chat → Anthropic：图片必须变成 image/source 块，不能被压成文本。
func TestChatToAnthropicKeepsImage(t *testing.T) {
	out, err := chatToAnthropicBody(chatBodyWithImage(), "deepseek-v4.1-flash")
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `"type":"image"`) || !strings.Contains(s, `"type":"base64"`) {
		t.Fatalf("图片块丢失: %s", s)
	}
	if !strings.Contains(s, strings.SplitN(tinyPNG, ",", 2)[1]) {
		t.Fatalf("base64 数据丢失: %s", s)
	}
	if !strings.Contains(s, "看图") {
		t.Fatalf("文本丢失: %s", s)
	}
}

// 出站 chat → Responses：图片必须变成 input_image。
func TestChatToResponsesKeepsImage(t *testing.T) {
	out, err := chatToResponsesBody(chatBodyWithImage(), "deepseek-v4.1-flash")
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `"type":"input_image"`) {
		t.Fatalf("图片丢失: %s", s)
	}
	if !strings.Contains(s, strings.SplitN(tinyPNG, ",", 2)[1]) {
		t.Fatalf("base64 数据丢失: %s", s)
	}
}

// 入站 Anthropic → chat：image 块必须变成 image_url 分段，不能只留 [图片]。
func TestAnthropicInboundKeepsImage(t *testing.T) {
	req := &anthropicRequest{
		Model:     "deepseek-flash",
		MaxTokens: 100,
		Messages:  json.RawMessage(`[{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}]`),
	}
	_, chatBody, err := buildChatBodyFromAnthropic(req)
	if err != nil {
		t.Fatal(err)
	}
	s := string(chatBody)
	if !strings.Contains(s, `"image_url"`) || !strings.Contains(s, "data:image/png;base64,AAAA") {
		t.Fatalf("图片未保留: %s", s)
	}
}
