package handlers

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

/*
回归：上游每个 chunk 都重复带 delta.role 时，必须只保留第一块。

线上问题：OpenCode 的流式响应每个分块都是
`delta: {"role":"assistant","content":"..."}`，而 OpenAI 标准只在第一块带 role。
很多客户端把「delta 里出现 role」当作**新消息开始**的信号 ——
于是每个 token 都开一条新消息，前面收到的内容被反复丢弃，最终一条消息都没有。
客户端报「模型没有返回内容」（No response received from model），
而网关日志记的是拼接后的正常文本，两边完全对不上。
*/
func TestStripRepeatedRoleKeepsFirstOnly(t *testing.T) {
	seen := false
	chunk := func(content string) string {
		return `data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"finish_reason":null,"delta":{"role":"assistant","content":"` + content + `"}}]}` + "\n"
	}
	// 第一块：role 保留。
	first := string(stripRepeatedRole([]byte(chunk("你")), &seen))
	if !strings.Contains(first, `"role":"assistant"`) {
		t.Fatalf("first chunk must keep role: %s", first)
	}
	if !seen {
		t.Fatal("roleSeen not set after first chunk")
	}
	// 后续块：role 去掉，内容保留。
	second := string(stripRepeatedRole([]byte(chunk("好")), &seen))
	if strings.Contains(second, `"role"`) {
		t.Fatalf("later chunk must drop role: %s", second)
	}
	if !strings.Contains(second, `"content":"好"`) {
		t.Fatalf("later chunk lost content: %s", second)
	}
	// 结果仍是合法 JSON，且 data: 前缀与换行都在。
	trimmed := strings.TrimSpace(strings.TrimPrefix(second, "data:"))
	var parsed map[string]any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		t.Fatalf("normalised chunk is not valid JSON: %v (%s)", err, trimmed)
	}
	if !strings.HasPrefix(second, "data: ") || !strings.HasSuffix(second, "\n") {
		t.Fatalf("SSE framing broken: %q", second)
	}
}

// TestStripRepeatedRoleIgnoresOtherLines 非 data 行与不含 role 的块必须原样返回。
func TestStripRepeatedRoleIgnoresOtherLines(t *testing.T) {
	seen := false
	cases := []string{
		"\n",
		"data: [DONE]\n",
		`data: {"choices":[{"delta":{"content":"x"}}]}` + "\n",
		`data: {"choices":[{"delta":{}}]}` + "\n",
		"event: ping\n",
		"data: not-json\n",
	}
	for _, raw := range cases {
		if got := string(stripRepeatedRole([]byte(raw), &seen)); got != raw {
			t.Fatalf("input %q changed to %q", raw, got)
		}
	}
	if seen {
		t.Fatal("roleSeen must not be set by chunks without role")
	}
}

// TestStripRepeatedRolePreservesUsageChunk usage 尾包（choices 为空）不受影响。
func TestStripRepeatedRolePreservesUsageChunk(t *testing.T) {
	seen := true
	raw := `data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}` + "\n"
	if got := string(stripRepeatedRole([]byte(raw), &seen)); got != raw {
		t.Fatalf("usage chunk changed: %q", got)
	}
}

/*
回归：SSE 事件必须以**空行**结束。

线上事故：读上游的循环不转发空行（多数翻译器自己补空行），
但 chatPassthrough 是原样透传、不补 —— 整条流里一个空行都没有。
按 SSE 规范，没有空行 = 所有 data 行属于**同一个事件**，
客户端把它们拼成 `{...}\n{...}` 这种非法 JSON，解析必然失败，
报「模型没有返回内容」，而网关日志与 nginx 全是 200。

手工 curl 测试发现不了（人和脚本习惯按行解析），所以这里断言**字节格式**：
按空行切分必须得到与 data 行数相同的事件数。
*/
func TestChatPassthroughEmitsFramedEvents(t *testing.T) {
	translator := &chatPassthrough{}
	var stream []byte
	for _, chunk := range []string{
		`data: {"choices":[{"delta":{"role":"assistant"}}]}` + "\n",
		`data: {"choices":[{"delta":{"content":"你"}}]}` + "\n",
		`data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}` + "\n",
		"data: [DONE]\n",
	} {
		for _, out := range translator.Translate([]byte(chunk)) {
			stream = append(stream, out...)
		}
	}

	// 1) 每个事件之间必须有空行。
	if !bytes.Contains(stream, []byte("\n\n")) {
		t.Fatalf("no blank-line frame separator in stream: %q", stream)
	}
	// 2) 按空行切分：事件数与 data 行数一致（否则客户端会把多行并成一个事件）。
	events := bytes.Split(bytes.TrimRight(stream, "\n"), []byte("\n\n"))
	dataLines := bytes.Count(stream, []byte("data:"))
	if len(events) != dataLines {
		t.Fatalf("framing broken: %d events vs %d data lines\n%q", len(events), dataLines, stream)
	}
	// 3) 每个事件必须恰好一行 data（SSE 里 data 可以多行，但我们必须是单行 JSON）。
	for i, event := range events {
		if got := bytes.Count(event, []byte("\n")); got != 0 {
			t.Fatalf("event %d contains %d extra newlines (would merge events): %q", i, got, event)
		}
		if !bytes.HasPrefix(event, []byte("data: ")) {
			t.Fatalf("event %d is not a data line: %q", i, event)
		}
		// JSON 必须能单独解析（这是客户端真正会做的事）。
		payload := bytes.TrimSpace(bytes.TrimPrefix(event, []byte("data: ")))
		if bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal(payload, &parsed); err != nil {
			t.Fatalf("event %d payload is not valid JSON: %v (%q)", i, err, payload)
		}
	}
	// 4) 不允许出现两个连续空行（会把事件读坏成「空事件」）。
	if bytes.Contains(stream, []byte("\n\n\n")) {
		t.Fatalf("triple newline in stream: %q", stream)
	}
}

// TestEnsureSSEFrameIdempotent 已经分帧的输入不能被二次追加空行。
//
// 上游经转换器出来的行本来就带 `\n\n`（chatChunk 的输出），
// 再走一次 ensureSSEFrame 不能变成三连换行 —— 那会让严格的解析器读到空事件。
func TestEnsureSSEFrameIdempotent(t *testing.T) {
	framed := []byte(`data: {"x":1}` + "\n\n")
	if got := string(ensureSSEFrame(framed)); got != string(framed) {
		t.Fatalf("already framed input changed: %q -> %q", framed, got)
	}
	// 单换行要补成空行。
	unframed := []byte(`data: {"x":1}` + "\n")
	if got := string(ensureSSEFrame(unframed)); got != `data: {"x":1}`+"\n\n" {
		t.Fatalf("unframed input not fixed: %q", got)
	}
	// CRLF 归一成 LF。
	crlf := []byte("data: {\"x\":1}\r\n")
	if got := string(ensureSSEFrame(crlf)); got != `data: {"x":1}`+"\n\n" {
		t.Fatalf("CRLF not normalised: %q", got)
	}
}
