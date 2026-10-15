package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// rejectDecisionOnChat 拦住把决策模型塞进对话接口的请求。
//
// 返回 true 表示已经写了错误响应，调用方直接 return。
func rejectDecisionOnChat(c *gin.Context, model string, writeErr errWriterFunc) bool {
	if services.ModelKind(model) != "decision" {
		return false
	}
	writeErr(c, http.StatusBadRequest,
		"模型「"+model+"」是决策模型，请改调 POST /v1/systemone（请求体要有 state 和 questions）。",
		"decision_model")
	return true
}

// SystemOne 是决策模型的对外入口（TypeSafe / OpenCode 的 /systemone）。
//
// 鉴权、选账号、计费与 /v1/chat/completions 同一条链路。
// 差别只在请求形状：这里原样转发 state 和 questions，不改写成对话。
func SystemOne(c *gin.Context) {
	start := time.Now()

	token, err := authenticateAPIKey(c)
	if err != nil {
		writeOpenAIError(c, http.StatusUnauthorized, err.Error(), "invalid_api_key")
		return
	}

	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 1<<20))
	if err != nil {
		writeOpenAIError(c, http.StatusBadRequest, "读取请求体失败", "invalid_request_error")
		return
	}

	var req struct {
		Model     string         `json:"model"`
		State     any            `json:"state"`
		Questions map[string]any `json:"questions"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeOpenAIError(c, http.StatusBadRequest, "请求体不是合法 JSON", "invalid_request_error")
		return
	}
	if strings.TrimSpace(req.Model) == "" {
		writeOpenAIError(c, http.StatusBadRequest, "缺少 model 参数", "invalid_request_error")
		return
	}
	if !decisionStatePresent(req.State) || len(req.Questions) == 0 {
		writeOpenAIError(c, http.StatusBadRequest, "决策请求需要 state 和至少一道 questions", "invalid_request_error")
		return
	}
	if services.ModelKind(req.Model) != "decision" {
		writeOpenAIError(c, http.StatusBadRequest,
			"模型「"+req.Model+"」不是决策模型。对话模型请改调 /v1/chat/completions。",
			"not_decision_model")
		return
	}

	group, okAccess := checkAccess(c, token, req.Model, writeOpenAIError)
	if !okAccess {
		return
	}

	call, okCall := callUpstream(c.Request.Context(), c, token, group, req.Model, body, start, writeOpenAIError)
	if !okCall {
		return
	}
	c.Data(http.StatusOK, "application/json", call.Body)
}

func decisionStatePresent(state any) bool {
	if state == nil {
		return false
	}
	text, ok := state.(string)
	if ok {
		return strings.TrimSpace(text) != ""
	}
	return true
}
