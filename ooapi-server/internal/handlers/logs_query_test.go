package handlers

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/middleware"
	"ooapi/internal/models"
)

// logs_query_test.go 覆盖新的使用记录详情接口（GET /api/logs/usage/:id）：
//   · 归属校验：不是自己的记录一律 404（不泄露「记录存在」）
//   · 字段裁剪：普通用户看不到 prompt_text / 原始 UA / 账号名，管理员全见
//   · billing 辅助对象与快照字段照常回传

// usageDetailTestRow 是详情查询返回的一行（列顺序与 handler 的 SELECT 一致）。
func usageDetailTestRow(userID int64, rawUA string) []driver.Value {
	return []driver.Value{
		int64(7), userID, "alice", "Alice", "https://cdn.example.com/a.png", // id, user_id, username, display_name, avatar
		int64(3), "my key", int64(4), "OpenCode Go", // token, channel
		int64(2), "claude-model", "claude-sonnet-4-5", "claude-haiku-5-5", "claude-haiku-5-5",
		int64(120), int64(40), int64(20),
		float64(2), float64(4), float64(0.5), float64(1.5), int64(11), float64(10.5),
		int64(17), int64(900), int64(120), "127.0.0.1",
		rawUA, "codex", "账号=up", // user_agent, caller_client, detail
		"用户问题", "[user] 用户问题\n", "模型回答", int64(1),
		"2026-10-08 10:00:00",
	}
}

func runUsageLogDetail(t *testing.T, d *callerTestDriver, role authz.Role, viewerID int64) *httptest.ResponseRecorder {
	t.Helper()
	useCallerTestDB(t, d)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/logs/usage/7", nil)
	c.Params = gin.Params{{Key: "id", Value: "7"}}
	c.Set(middleware.CtxUserKey, &models.User{ID: viewerID})
	c.Set(middleware.CtxRoleKey, role)
	UsageLogDetail(c)
	return recorder
}

func decodeDetailResponse(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var resp struct {
		Success bool           `json:"success"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad response: %v (%s)", err, recorder.Body.String())
	}
	if !resp.Success {
		t.Fatalf("expected success, got %s", recorder.Body.String())
	}
	return resp.Data
}

func TestUsageLogDetailOwnerSeesInputAndOutputOnly(t *testing.T) {
	d := &callerTestDriver{}
	d.query = func(q string, _ []driver.NamedValue) (driver.Rows, error) {
		if !strings.Contains(q, "WHERE l.id = ? AND type IN (2, 3, 4)") {
			t.Fatalf("unexpected query: %s", q)
		}
		return &callerTestRows{
			columns: make([]string, 35),
			values:  [][]driver.Value{usageDetailTestRow(2, "codex/1.0 (Windows)")},
		}, nil
	}

	recorder := runUsageLogDetail(t, d, authz.RoleUser, 2)
	if recorder.Code != http.StatusOK {
		t.Fatalf("owner status = %d: %s", recorder.Code, recorder.Body.String())
	}
	data := decodeDetailResponse(t, recorder)

	if data["input_text"] != "用户问题" || data["output_text"] != "模型回答" {
		t.Fatalf("owner must see input/output text: %+v", data)
	}
	// prompt_text 是网关拼装的完整上游上下文：普通用户不可见。
	if data["prompt_text"] != "" {
		t.Fatalf("non-admin leaked prompt_text: %+v", data)
	}
	if _, present := data["user_agent"]; present {
		t.Fatalf("non-admin leaked raw user_agent: %+v", data)
	}
	if data["channel_name"] != "" {
		t.Fatalf("non-admin leaked channel name: %+v", data)
	}
	if data["text_truncated"] != true {
		t.Fatalf("text_truncated = %v, want true", data["text_truncated"])
	}

	// 快照字段与 billing 辅助对象照常回传。
	for _, key := range []string{"requested_model", "upstream_model", "pricing_model",
		"input_price", "output_price", "cached_price", "group_rate", "base_quota", "raw_cost"} {
		if _, ok := data[key]; !ok {
			t.Fatalf("detail missing snapshot field %s: %+v", key, data)
		}
	}
	billing, ok := data["billing"].(map[string]any)
	if !ok {
		t.Fatalf("detail missing billing object: %+v", data)
	}
	for _, key := range []string{"input_price", "output_price", "cached_price",
		"raw_cost", "base_quota", "group_rate", "quota", "units_per_unit"} {
		if _, ok := billing[key]; !ok {
			t.Fatalf("billing missing %s: %+v", key, billing)
		}
	}
	if billing["units_per_unit"] != float64(10000) {
		t.Fatalf("billing.units_per_unit = %v, want 10000", billing["units_per_unit"])
	}
	if data["cached_tokens"] != float64(20) || data["prompt_tokens"] != float64(120) {
		t.Fatalf("token fields wrong (prompt includes cache): %+v", data)
	}
}

func TestUsageLogDetailDeniesOtherUserWithNotFound(t *testing.T) {
	d := &callerTestDriver{}
	d.query = func(string, []driver.NamedValue) (driver.Rows, error) {
		return &callerTestRows{
			columns: make([]string, 35),
			values:  [][]driver.Value{usageDetailTestRow(99, "codex/1.0")},
		}, nil
	}

	recorder := runUsageLogDetail(t, d, authz.RoleUser, 2)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("non-owner status = %d, want 404: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"success":false`) {
		t.Fatalf("non-owner got unexpected body: %s", recorder.Body.String())
	}
}

func TestUsageLogDetailAdminSeesPromptTextAndRawUA(t *testing.T) {
	d := &callerTestDriver{}
	d.query = func(string, []driver.NamedValue) (driver.Rows, error) {
		return &callerTestRows{
			columns: make([]string, 35),
			values:  [][]driver.Value{usageDetailTestRow(99, "codex/1.0 (Windows; x64)")},
		}, nil
	}

	recorder := runUsageLogDetail(t, d, authz.RoleAdmin, 2)
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin status = %d: %s", recorder.Code, recorder.Body.String())
	}
	data := decodeDetailResponse(t, recorder)
	if data["prompt_text"] != "[user] 用户问题\n" {
		t.Fatalf("admin must see prompt_text: %+v", data)
	}
	if data["user_agent"] != "codex/1.0 (Windows; x64)" {
		t.Fatalf("admin must see raw user_agent: %+v", data)
	}
	if data["channel_name"] != "OpenCode Go" {
		t.Fatalf("admin must see channel name: %+v", data)
	}
}

func TestUsageLogDetailMissingRowIs404(t *testing.T) {
	d := &callerTestDriver{}
	d.query = func(string, []driver.NamedValue) (driver.Rows, error) {
		return &callerTestRows{columns: make([]string, 35)}, nil
	}
	recorder := runUsageLogDetail(t, d, authz.RoleAdmin, 2)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing row status = %d, want 404", recorder.Code)
	}
}

func TestUsageLogDetailRejectsBadID(t *testing.T) {
	d := &callerTestDriver{}
	useCallerTestDB(t, d)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/logs/usage/abc", nil)
	c.Params = gin.Params{{Key: "id", Value: "abc"}}
	c.Set(middleware.CtxUserKey, &models.User{ID: 2})
	c.Set(middleware.CtxRoleKey, authz.RoleAdmin)
	UsageLogDetail(c)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("bad id status = %d, want 404", recorder.Code)
	}
}

// 列表接口同样要带计费快照（不含原文），且每行附 billing 辅助对象。
func TestUsageLogsListCarriesBillingSnapshot(t *testing.T) {
	d := &callerTestDriver{}
	d.query = func(q string, _ []driver.NamedValue) (driver.Rows, error) {
		if strings.Contains(q, "COUNT(*)") {
			return &callerTestRows{columns: []string{"count"}, values: [][]driver.Value{{int64(1)}}}, nil
		}
		if !strings.Contains(q, "l.requested_model") || !strings.Contains(q, "l.raw_cost") {
			t.Fatalf("list query missing snapshot columns: %s", q)
		}
		values := []driver.Value{
			int64(1), int64(2), "alice", "Alice", "",
			int64(3), "my key", int64(4), "OpenCode Go",
			int64(2), "claude-model", "claude-sonnet-4-5", "claude-haiku-5-5", "claude-haiku-5-5",
			int64(120), int64(40), int64(20),
			float64(2), float64(4), float64(0.5), float64(1.5), int64(11), float64(10.5),
			int64(17), int64(900), int64(120), "127.0.0.1",
			"", "", "detail", "2026-10-08 10:00:00",
		}
		columns := make([]string, len(values))
		for i := range columns {
			columns[i] = fmt.Sprintf("col%d", i)
		}
		return &callerTestRows{columns, [][]driver.Value{values}}, nil
	}
	useCallerTestDB(t, d)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/logs/usage", nil)
	c.Set(middleware.CtxUserKey, &models.User{ID: 2})
	c.Set(middleware.CtxRoleKey, authz.RoleAdmin)
	UsageLogs(c)

	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Items []map[string]any `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Success || len(resp.Data.Items) != 1 {
		t.Fatalf("bad list response: %s", recorder.Body.String())
	}
	item := resp.Data.Items[0]
	for _, key := range []string{"requested_model", "upstream_model", "pricing_model",
		"input_price", "output_price", "cached_price", "group_rate", "base_quota", "raw_cost", "billing"} {
		if _, ok := item[key]; !ok {
			t.Fatalf("list item missing %s: %+v", key, item)
		}
	}
	for _, hidden := range []string{"input_text", "prompt_text", "output_text"} {
		if _, ok := item[hidden]; ok {
			t.Fatalf("list must stay lean, leaked %s: %+v", hidden, item)
		}
	}
}
