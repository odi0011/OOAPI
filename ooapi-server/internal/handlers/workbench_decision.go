package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

/*
工作台只跑一个决策角色。

优先走中转上的 Jev（System One）。OpenCode 的免费档能答时用它；
免费档没有可用账号，或上游拒绝时，改用 Cline 上实测能答的免费对话模型，
让它返回 allow / deny。不编造成功，也不编数字。
*/

const workbenchProbeTimeout = 40 * time.Second

type workbenchDecision struct {
	Model    string `json:"model"`
	Kind     string `json:"kind"`
	Allow    *bool  `json:"allow"`
	Decision string `json:"decision"`
	Detail   string `json:"detail,omitempty"`
	Error    string `json:"error,omitempty"`
}

// PostWorkbenchDecision 经网关调度跑一次测试决策。
func PostWorkbenchDecision(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), workbenchProbeTimeout)
	defer cancel()

	result := runWorkbenchDecision(ctx)
	ok(c, result)
}

func runWorkbenchDecision(ctx context.Context) workbenchDecision {
	var failures []string
	note := func(model string, err error) {
		if err == nil {
			return
		}
		failures = append(failures, model+": "+err.Error())
	}

	jevBody, _ := json.Marshal(map[string]any{
		"model": "jev-1.13-free",
		"state": "Relay health check. No customer, no payment, and no trade.",
		"questions": map[string]any{
			"allow": map[string]any{
				"type":         "noul",
				"instructions": "Is this health-check request allowed to proceed?",
			},
		},
	})
	if raw, err := probeUpstream(ctx, "jev-1.13-free", jevBody); err == nil {
		parsed := interpretDecisionBody(raw)
		parsed.Model = "jev-1.13-free"
		parsed.Kind = "decision"
		if parsed.Error == "" && (parsed.Allow != nil || parsed.Decision != "") {
			return parsed
		}
		if parsed.Error != "" {
			note("jev-1.13-free", fmt.Errorf("%s", parsed.Error))
		}
	} else {
		note("jev-1.13-free", err)
		if ctx.Err() != nil {
			return workbenchDecision{Model: "jev-1.13-free", Kind: "decision", Error: strings.Join(failures, "；")}
		}
	}

	// Jev 不可用时，用实测能答的 Cline 免费模型做同一次允许/拒绝判断。
	for _, model := range []string{"lfm-2.5-2.6b", "minimax-m2.5"} {
		if ctx.Err() != nil {
			failures = append(failures, model+": 决策请求超时")
			break
		}
		body, _ := json.Marshal(map[string]any{
			"model": model,
			"messages": []map[string]string{
				{"role": "system", "content": "Reply with JSON only: {\"allow\":true} or {\"allow\":false}."},
				{"role": "user", "content": "Health check with no trade and no personal data. Is it allowed to proceed?"},
			},
			"max_tokens":  80,
			"temperature": 0,
		})
		raw, err := probeUpstream(ctx, model, body)
		if err != nil {
			note(model, err)
			continue
		}
		parsed := interpretDecisionBody(raw)
		parsed.Model = model
		parsed.Kind = "chat"
		if parsed.Error == "" && (parsed.Allow != nil || parsed.Decision != "") {
			return parsed
		}
		if parsed.Error != "" {
			note(model, fmt.Errorf("%s", parsed.Error))
		}
	}
	if len(failures) == 0 {
		failures = append(failures, "Jev 免费档和 Cline 免费模型都没有返回可用的决策")
	}
	return workbenchDecision{
		Model: "jev-1.13-free",
		Kind:  "decision",
		Error: strings.Join(failures, "；"),
	}
}

func probeUpstream(ctx context.Context, model string, body []byte) ([]byte, error) {
	channels, err := services.SelectChannels(model, "", "", nil)
	if err != nil || len(channels) == 0 {
		return nil, fmt.Errorf("没有可用账号承接 %s", model)
	}
	var last error
	limit := len(channels)
	if limit > 3 {
		limit = 3
	}
	for _, ch := range channels[:limit] {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !services.RateLimitAcquire(ch) {
			last = fmt.Errorf("账号「%s」已达速率上限", ch.Name)
			continue
		}
		raw, _, callErr := func() ([]byte, upstreamUsage, error) {
			defer services.RateLimitRelease(ch)
			return forwardJSON(ctx, ch, body, model)
		}()
		if callErr != nil {
			last = callErr
			services.MarkChannelFailureWithCooldown(ch.ID, callErr.Error(), upstreamErrorCooldown(callErr))
			if isClientError(callErr) {
				return nil, callErr
			}
			continue
		}
		services.MarkChannelSuccess(ch.ID)
		return rewriteResponseModel(raw, model), nil
	}
	if last == nil {
		last = fmt.Errorf("没有可用账号承接 %s", model)
	}
	return nil, last
}

func interpretDecisionBody(raw []byte) workbenchDecision {
	var body struct {
		Answers map[string]struct {
			Type string   `json:"type"`
			Noul *float64 `json:"noul"`
		} `json:"answers"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return workbenchDecision{Error: "上游响应不是 JSON"}
	}
	if body.Error != nil && body.Error.Message != "" {
		return workbenchDecision{Error: body.Error.Message}
	}
	if answer, ok := body.Answers["allow"]; ok && answer.Noul != nil {
		allow := *answer.Noul >= 0.5
		decision := "deny"
		if allow {
			decision = "allow"
		}
		return workbenchDecision{
			Allow:    &allow,
			Decision: decision,
			Detail:   fmt.Sprintf("noul %.2f", *answer.Noul),
		}
	}
	content := ""
	if len(body.Choices) > 0 {
		content = strings.TrimSpace(body.Choices[0].Message.Content)
	}
	if content == "" {
		return workbenchDecision{Error: "上游没有返回决策内容"}
	}
	allow, decision := allowFromText(content)
	return workbenchDecision{Allow: allow, Decision: decision, Detail: content}
}

func allowFromText(content string) (*bool, string) {
	var parsed struct {
		Allow    *bool  `json:"allow"`
		Decision string `json:"decision"`
	}
	if json.Unmarshal([]byte(content), &parsed) == nil && parsed.Allow != nil {
		decision := "deny"
		if *parsed.Allow {
			decision = "allow"
		}
		if strings.TrimSpace(parsed.Decision) != "" {
			decision = strings.TrimSpace(parsed.Decision)
		}
		return parsed.Allow, decision
	}
	lower := strings.ToLower(strings.TrimSpace(content))
	switch {
	case lower == "allow" || strings.HasPrefix(lower, "allow"):
		allow := true
		return &allow, "allow"
	case lower == "deny" || strings.HasPrefix(lower, "deny") || strings.Contains(lower, "拒绝"):
		allow := false
		return &allow, "deny"
	default:
		return nil, content
	}
}
