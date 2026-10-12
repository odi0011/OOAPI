package handlers

import (
	"strings"
	"testing"
)

/*
rewriteResponseModel 的回归测试。

背景（hold_test 逮出来的线上问题）：流式的每一行都是 `data: {...}`，
而 rewriteResponseModel 最初直接拿**整行**去 json.Unmarshal —— 必然失败，
函数又按「改不动就原样返回」的约定静默放过。后果是：

	渠道声明上游叫法（deepseek-v4.1-flash）、客户端请求官方名
	（deepseek-flash）时，响应里每个 chunk 的 model 字段都是上游叫法。

多数客户端不校验这个字段，所以问题可以潜伏很久；但部分 SDK / Agent
会校验「返回的 model 与请求的一致」，不一致就报错 ——
用户看到的是「模型不可用」，而网关日志一切正常。

（非流式路径当时是好的：那里拿到的是纯 JSON 体，没有 data: 前缀。）
*/

func TestRewriteResponseModelOnSSELine(t *testing.T) {
	line := []byte(`data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"hi"}}]}` + "\n")

	got := string(rewriteResponseModel(line, "deepseek-flash"))

	if !strings.Contains(got, `"model":"deepseek-flash"`) {
		t.Fatalf("SSE 行里的 model 未被改写: %q", got)
	}
	if strings.Contains(got, "deepseek-v4.1-flash") {
		t.Fatalf("上游模型名仍然存在: %q", got)
	}
	// 前缀与结尾的换行必须原样保留，否则 SSE 分帧会坏。
	if !strings.HasPrefix(got, "data: ") {
		t.Fatalf("data: 前缀丢失: %q", got)
	}
	if !strings.HasSuffix(got, "\n") {
		t.Fatalf("行尾换行丢失: %q", got)
	}
}

func TestRewriteResponseModelKeepsOtherFields(t *testing.T) {
	line := []byte(`data: {"id":"c1","model":"old","choices":[{"delta":{"content":"正文"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}` + "\n\n")

	got := string(rewriteResponseModel(line, "new-model"))

	// 只动 model，其余字段与分帧必须原样保留（含结尾空行）。
	for _, want := range []string{`"id":"c1"`, `"正文"`, `"prompt_tokens":5`, `"total_tokens":7`, `"model":"new-model"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("字段 %s 丢失或未改写: %q", want, got)
		}
	}
	if !strings.HasSuffix(got, "\n\n") {
		t.Fatalf("结尾空行（SSE 分帧）丢失: %q", got)
	}
}

func TestRewriteResponseModelIgnoresNonJSONAndDone(t *testing.T) {
	cases := []string{
		"data: [DONE]\n",
		": keep-alive\n\n",
		"\n",
		`data: {"model":"already-the-same"}` + "\n",
	}
	for _, line := range cases {
		want := line
		model := "other-model"
		if strings.Contains(line, "already-the-same") {
			model = "already-the-same"
		}
		if got := string(rewriteResponseModel([]byte(line), model)); got != want {
			t.Fatalf("不该改动的内容被改了：\n  输入 %q\n  输出 %q", line, got)
		}
	}
}

func TestRewriteResponseModelOnPlainJSON(t *testing.T) {
	// 非流式路径：纯 JSON 体（没有 data: 前缀）也必须照常工作。
	body := []byte(`{"id":"x","model":"upstream-name","choices":[]}`)
	got := string(rewriteResponseModel(body, "official-name"))
	if !strings.Contains(got, `"model":"official-name"`) {
		t.Fatalf("非流式 model 未改写: %q", got)
	}
}
