package handlers

import (
	"encoding/json"
	"strings"
	"testing"
)

/*
回归：Anthropic 流式里每个 content block 必须有独立且递增的 index，
且上一块必须先发 content_block_stop。

线上会出的事：上游并行返回两个工具调用时，两个 content_block_start 拿到
同一个 index、中间也没有 stop —— 甲方 SDK 会把第二个工具的参数并进
第一个块，参数损坏，只识别出一个工具调用。
另一头是工具块之后再吐文本：旧代码把 index 重置回 0，同样撞车。
*/

// anthropicChatChunk 拼一行上游 chat 协议的流分块。
func anthropicChatChunk(body string) string { return "data: " + body + "\n" }

// feedAnthropic 逐行喂给翻译器，把吐出的事件解析回来。
func feedAnthropic(t *testing.T, tr *anthropicTranslator, lines ...string) []map[string]any {
	t.Helper()
	var frames [][]byte
	for _, line := range lines {
		frames = append(frames, tr.Translate([]byte(line))...)
	}
	return parseAnthropicFrames(t, frames)
}

func parseAnthropicFrames(t *testing.T, frames [][]byte) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, chunk := range frames {
		for _, frame := range strings.Split(string(chunk), "\n\n") {
			at := strings.Index(frame, "data: ")
			if at < 0 {
				continue
			}
			var obj map[string]any
			if err := json.Unmarshal([]byte(frame[at+len("data: "):]), &obj); err != nil {
				t.Fatalf("事件不是合法 JSON: %v (%q)", err, frame)
			}
			events = append(events, obj)
		}
	}
	return events
}

func blockIndices(events []map[string]any, want string) []float64 {
	var got []float64
	for _, ev := range events {
		if ev["type"] == want {
			idx, _ := ev["index"].(float64)
			got = append(got, idx)
		}
	}
	return got
}

func TestAnthropicTranslatorGivesEachBlockItsOwnIndex(t *testing.T) {
	tr := &anthropicTranslator{model: "m"}
	events := feedAnthropic(t, tr,
		anthropicChatChunk(`{"choices":[{"finish_reason":null,"delta":{"content":"先说一句"}}]}`),
		anthropicChatChunk(`{"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"alpha","arguments":"{}"}}]}}]}`),
		anthropicChatChunk(`{"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"beta","arguments":"{}"}}]}}]}`),
		anthropicChatChunk(`{"choices":[{"finish_reason":"tool_calls","delta":{}}]}`),
	)

	starts := blockIndices(events, "content_block_start")
	stops := blockIndices(events, "content_block_stop")

	// 文本 + 两个工具调用 = 三块。
	if len(starts) != 3 {
		t.Fatalf("应有 3 个 content_block_start，得到 %d 个: %v", len(starts), starts)
	}
	if starts[0] != 0 || starts[1] != 1 || starts[2] != 2 {
		t.Fatalf("块序号必须递增且互不相同，得到 %v", starts)
	}
	// 开新块之前，上一块必须已经关掉。
	for i := 1; i < len(starts); i++ {
		closed := false
		for _, c := range stops {
			if c == starts[i-1] {
				closed = true
			}
		}
		if !closed {
			t.Fatalf("块 %.0f 还没有 content_block_stop，就开了块 %.0f", starts[i-1], starts[i])
		}
	}
}

func TestAnthropicTranslatorTextAfterToolGetsNewIndex(t *testing.T) {
	tr := &anthropicTranslator{model: "m"}
	events := feedAnthropic(t, tr,
		anthropicChatChunk(`{"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"alpha","arguments":"{}"}}]}}]}`),
		anthropicChatChunk(`{"choices":[{"finish_reason":null,"delta":{"content":"工具跑完了"}}]}`),
	)

	starts := blockIndices(events, "content_block_start")
	if len(starts) != 2 {
		t.Fatalf("应有工具块与随后的文本块共 2 个，得到 %v", starts)
	}
	if starts[0] == starts[1] {
		t.Fatalf("文本块不能复用工具块的 index，得到 %v", starts)
	}
}

func TestAnthropicTranslatorReportsMaxTokensAndInputTokens(t *testing.T) {
	tr := &anthropicTranslator{model: "m"}
	feedAnthropic(t, tr,
		anthropicChatChunk(`{"choices":[{"finish_reason":null,"delta":{"content":"半截"}}]}`),
		anthropicChatChunk(`{"choices":[{"finish_reason":"length","delta":{}}]}`),
	)
	events := parseAnthropicFrames(t, tr.Finish(upstreamUsage{PromptTokens: 12, CompletionTokens: 3}))

	var delta map[string]any
	for _, ev := range events {
		if ev["type"] == "message_delta" {
			delta = ev
		}
	}
	if delta == nil {
		t.Fatal("收尾里没有 message_delta")
	}
	inner, _ := delta["delta"].(map[string]any)
	if inner["stop_reason"] != "max_tokens" {
		t.Fatalf("上游截断（finish_reason=length）应报 max_tokens，得到 %v", inner["stop_reason"])
	}
	usage, _ := delta["usage"].(map[string]any)
	if input, _ := usage["input_tokens"].(float64); input != 12 {
		t.Fatalf("message_delta 的 usage 应带上 input_tokens=12，得到 %v", usage["input_tokens"])
	}
}

// 只有 chat 客户端需要那句 [DONE]；另外两种协议各有自己的收尾事件。
func TestTranslatorTerminatorOnlyForChat(t *testing.T) {
	done := []byte("data: [DONE]\n\n")

	if got := (&chatPassthrough{}).Terminate(done); len(got) == 0 {
		t.Fatal("chat 客户端应当收到 [DONE]")
	}
	if got := (&anthropicTranslator{model: "m"}).Terminate(done); len(got) != 0 {
		t.Fatalf("Anthropic 不该收到裸 [DONE]，得到 %q", got)
	}
	if got := (&responsesTranslator{model: "m"}).Terminate(done); len(got) != 0 {
		t.Fatalf("Responses 不该收到裸 [DONE]，得到 %q", got)
	}
}
