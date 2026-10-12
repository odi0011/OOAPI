package handlers

import (
	"encoding/json"
	"strings"
	"testing"
)

/*
回归：图片必须真的发给上游，不能被压成 "[图片]" 文本。

线上问题（Codex 桌面端实测）：贴图后模型回复「图片一片空白/无法解析」。
根因是 Responses → chat 的转换把 content 一律压平，
`input_image` 变成 `"[图片]"` 三个字 —— 图片数据整条丢失。
客户端以为发了图，模型只收到占位文本。

对话正文压平是可接受的取舍（多数上游对分段数组兼容不一），
**把图片丢掉不是**：那是视觉能力静默失效，且客户端完全看不出原因。
*/
func TestContentForChatKeepsImages(t *testing.T) {
	raw := json.RawMessage(`[
		{"type":"input_text","text":"这张图里是什么？"},
		{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgo="}
	]`)
	content, err := contentForChat(raw)
	if err != nil {
		t.Fatal(err)
	}
	parts, okParts := content.([]any)
	if !okParts {
		t.Fatalf("content with image must stay a parts array, got %T (%#v)", content, content)
	}
	if len(parts) != 2 {
		t.Fatalf("parts = %#v", parts)
	}
	// 第一段是文字。
	first, _ := parts[0].(map[string]any)
	if first["type"] != "text" || first["text"] != "这张图里是什么？" {
		t.Fatalf("text part wrong: %#v", first)
	}
	// 第二段是图片，且 URL 完整（不能只剩占位符）。
	second, _ := parts[1].(map[string]any)
	if second["type"] != "image_url" {
		t.Fatalf("image part type wrong: %#v", second)
	}
	img, _ := second["image_url"].(map[string]any)
	if !strings.HasPrefix(img["url"].(string), "data:image/png;base64,") {
		t.Fatalf("image data lost: %#v", img)
	}
}

// TestContentForChatFlattensPlainText 纯文本仍压平成字符串（兼容性最好）。
func TestContentForChatFlattensPlainText(t *testing.T) {
	raw := json.RawMessage(`[{"type":"input_text","text":"你好"},{"type":"input_text","text":"世界"}]`)
	content, err := contentForChat(raw)
	if err != nil {
		t.Fatal(err)
	}
	if text, okText := content.(string); !okText || text != "你好世界" {
		t.Fatalf("plain text must flatten to a string, got %T (%#v)", content, content)
	}
	// 字符串形态直接透传。
	plain, err := contentForChat(json.RawMessage(`"直接一问"`))
	if err != nil {
		t.Fatal(err)
	}
	if text, okText := plain.(string); !okText || text != "直接一问" {
		t.Fatalf("string content = %#v", plain)
	}
}

// TestContentForChatImageOnlyGetsPrompt 纯图片消息要有可读内容，
// 不能变成空 content（上游会因空内容报错）。
func TestContentForChatImageOnlyGetsPrompt(t *testing.T) {
	raw := json.RawMessage(`[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]`)
	content, err := contentForChat(raw)
	if err != nil {
		t.Fatal(err)
	}
	parts, okParts := content.([]any)
	if !okParts || len(parts) != 1 {
		t.Fatalf("image-only content = %#v", content)
	}
	only, _ := parts[0].(map[string]any)
	if only["type"] != "image_url" {
		t.Fatalf("image-only should keep just the image: %#v", only)
	}
}

// TestBuildChatBodyKeepsImageInMessage 端到端：构造出的 chat 请求体里图片还在。
func TestBuildChatBodyKeepsImageInMessage(t *testing.T) {
	req := &responsesRequest{
		Model:  "deepseek-flash",
		Stream: false,
		Input: json.RawMessage(`[
			{"type":"message","role":"user","content":[
				{"type":"input_text","text":"看这张图"},
				{"type":"input_image","image_url":"data:image/jpeg;base64,/9j/4AAQ"}
			]}
		]`),
	}
	body, _, err := buildChatBodyFromResponsesDetailed(req)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Messages) != 1 {
		t.Fatalf("messages = %#v", parsed.Messages)
	}
	raw := string(parsed.Messages[0].Content)
	if !strings.Contains(raw, "data:image/jpeg;base64,") {
		t.Fatalf("image data missing from chat body: %s", raw)
	}
	if strings.Contains(raw, "[图片]") {
		t.Fatalf("placeholder must not appear, got: %s", raw)
	}
}

/*
回归：请求体里的 model 必须换成上游认的名字。

线上事故：客户端按官方名（deepseek-flash）调用，账号 14 里存的是
上游叫法（deepseek-v4.1-flash）。`UpstreamModelFor` 算出了正确的上游名，
但它只被用于**选路径**；chat 分支的 `buildUpstreamBody` 原样透传请求体，
于是上游收到 `deepseek-flash` → 11102「model not found」。
协议转换分支（anthropic / responses）本来就带 model 参数会重写，
偏偏最常用的 chat 分支漏了。

表现极具误导性：后台看到的是「上游说模型不存在」，而账号里明明声明了该模型，
管理员会去反复核对账号配置，查不到根因。
*/
func TestRewriteBodyModelForChatProtocol(t *testing.T) {
	body := []byte(`{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":9}`)
	out, err := buildUpstreamBody("openai", body, "deepseek-v4.1-flash")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["model"] != "deepseek-v4.1-flash" {
		t.Fatalf("model not rewritten: %v", parsed["model"])
	}
	// 其它字段必须原样保留（只改 model 一个）。
	if parsed["max_tokens"] != float64(9) {
		t.Fatalf("other fields lost: %#v", parsed)
	}
	if msgs, _ := parsed["messages"].([]any); len(msgs) != 1 {
		t.Fatalf("messages lost: %#v", parsed)
	}
}

// TestRewriteBodyModelNoop 名字相同时不做任何序列化往返（省一次开销，也避免键顺序变化）。
func TestRewriteBodyModelNoop(t *testing.T) {
	body := []byte(`{"model":"same","messages":[]}`)
	if got := string(rewriteBodyModel(body, "same")); got != string(body) {
		t.Fatalf("unchanged body was rewritten: %s", got)
	}
	// 空目标名 / 非法 JSON 一律原样返回。
	if got := string(rewriteBodyModel(body, "")); got != string(body) {
		t.Fatalf("empty model changed body: %s", got)
	}
	invalid := []byte("not-json")
	if got := string(rewriteBodyModel(invalid, "x")); got != string(invalid) {
		t.Fatalf("invalid body changed: %s", got)
	}
}
