package handlers

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/middleware"
	"ooapi/internal/models"
	"ooapi/internal/services"
)

func TestCallerClientFromUserAgent(t *testing.T) {
	cases := []struct{ ua, want string }{
		{"codex_cli_rs/0.42.0 (Windows 11; x64)", "codex"},
		{"Codex Desktop/1.0.0", "codex"},
		{"codex-tui/0.4", "codex"},
		{"codex/0.4 codex_cli_rs/0.4", "codex"},
		{"claude-cli/2.0.10 (external, cli)", "claude-code"},
		{"Claude-Code/2.1", "claude-code"},
		{"claude/2.1", "claude-code"},
		{"opencode/1.2.3", "opencode"},
		{"SUB2API/1.0", "sub2api"},
		{"newapi/1.2", "new-api"},
		{"New-API/1.2", "new-api"},
		{"New API v1.2", "new-api"},
		{"one-api/0.6.7", "one-api"},
		{"oneapi", "one-api"},
		{"CPA/6.2", "cpa"},
		{"CLIProxyAPI/6.2.1", "cpa"},
		{"CLIProxyAPIPlus/6.2.1", "cpa"},
		{"CLIProxyAPI-Plus/6.2.1", "cpa"},
		{"LiteLLM/1.0", "litellm"},
		{"one-hub/1.0", "one-hub"},
		{"ZCode/1.0", "zcode"},
		{"GeminiCLI/0.2", "gemini-cli"},
		{"RooCode/3.0", "roo-code"},
		{"GitHubCopilotChat/0.1", "copilot"},
		{"new-api/1.0 codex_cli_rs/0.5", "new-api"},
		{"CPA/1.0 claude-cli/2.0", "cpa"},
		{"new-api/1.0 one-api/1.0", ""},
		{"codex/1.0 claude-cli/2.0", ""},
		{"Go-http-client/1.1", ""},
		{"OpenAI/Python 1.99", ""},
		{"Anthropic/Python 0.50", ""},
		{"Mozilla/5.0 (Windows NT 10.0)", ""},
		{"", ""},
		{"my-oneapi-client/1.0", ""},
		{"notcodex/1.0", ""},
		{"codex-helper/1.0", ""},
		{"https://example.com/new-api/1.0", ""},
		{"Go-http-client/1.1 (one-api-compatible)", ""},
	}
	for _, tc := range cases {
		t.Run(tc.ua, func(t *testing.T) {
			if got := callerClientFromUserAgent(tc.ua); got != tc.want {
				t.Fatalf("UA %q: got %q, want %q", tc.ua, got, tc.want)
			}
		})
	}
}

func TestSanitizeCallerUserAgent(t *testing.T) {
	if got := sanitizeCallerUserAgent("  codex/1.0 (Windows; x64)  "); got != "codex/1.0 (Windows; x64)" {
		t.Fatalf("normal UA was not preserved: %q", got)
	}
	got := sanitizeCallerUserAgent("codex/1.0\r\n\t\x00\x7f\u202e" + string([]byte{0xff}))
	if !utf8.ValidString(got) {
		t.Fatal("invalid UTF-8 survived sanitization")
	}
	for _, r := range got {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == utf8.RuneError {
			t.Fatalf("unsafe rune survived sanitization: %U", r)
		}
	}
	for _, raw := range []string{strings.Repeat("a", 1024), strings.Repeat("中文", 200)} {
		got := sanitizeCallerUserAgent(raw)
		if len(got) > maxCallerUserAgentBytes || !utf8.ValidString(got) {
			t.Fatalf("unsafe truncation: len=%d, valid=%v", len(got), utf8.ValidString(got))
		}
		if !strings.HasPrefix(raw, got) {
			t.Fatal("truncation changed the original UA prefix")
		}
	}
	if got := callerClientFromUserAgent(strings.Repeat("x", 512) + " codex/1.0"); got != "" {
		t.Fatalf("matched a product outside the stored safe UA: %q", got)
	}
}

// A small in-memory SQL driver keeps these tests hermetic: no dependency
// downloads, local MySQL service or production database is required.
type callerTestDriver struct {
	execs []callerTestExec
	query func(string, []driver.NamedValue) (driver.Rows, error)
}
type callerTestExec struct {
	query string
	args  []driver.NamedValue
}
type callerTestConn struct{ d *callerTestDriver }
type callerTestRows struct {
	columns []string
	values  [][]driver.Value
}

func (d *callerTestDriver) Open(string) (driver.Conn, error) { return &callerTestConn{d}, nil }
func (c *callerTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("unexpected Prepare")
}
func (c *callerTestConn) Close() error { return nil }
func (c *callerTestConn) Begin() (driver.Tx, error) {
	return nil, fmt.Errorf("unexpected Begin")
}
func (c *callerTestConn) ExecContext(_ context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	c.d.execs = append(c.d.execs, callerTestExec{q, append([]driver.NamedValue(nil), args...)})
	return driver.RowsAffected(1), nil
}
func (c *callerTestConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	if c.d.query != nil {
		return c.d.query(q, args)
	}
	return &callerTestRows{columns: []string{"model", "input_price", "output_price", "cached_price", "context_tiers"}}, nil
}
func (r *callerTestRows) Columns() []string { return r.columns }
func (r *callerTestRows) Close() error      { return nil }
func (r *callerTestRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}

var callerDriverSequence atomic.Uint64

func useCallerTestDB(t *testing.T, d *callerTestDriver) {
	t.Helper()
	name := fmt.Sprintf("caller-test-%d", callerDriverSequence.Add(1))
	sql.Register(name, d)
	conn, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	original := db.DB
	db.DB = conn
	t.Cleanup(func() {
		db.DB = original
		conn.Close()
	})
}

func TestCallerMetadataCapturedFromIncomingUAOnly(t *testing.T) {
	d := &callerTestDriver{}
	d.query = func(q string, _ []driver.NamedValue) (driver.Rows, error) {
		if !strings.Contains(q, "WHERE t.api_key = ?") {
			t.Fatalf("unexpected authentication query: %s", q)
		}
		columns := make([]string, 13)
		for i := range columns {
			columns[i] = fmt.Sprintf("col%d", i)
		}
		return &callerTestRows{columns, [][]driver.Value{{
			int64(2), int64(3), "sk-" + strings.Repeat("a", 48), int64(1), int64(100), true,
			int64(0), "default", "[]", nil, int64(100), int64(0), int64(1),
		}}}, nil
	}
	useCallerTestDB(t, d)
	for _, tc := range []struct{ ua, want string }{
		{"opencode/1.0 (Windows; x64)", "opencode"},
		{"Go-http-client/1.1", ""},
	} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
		c.Request.Header.Set("Authorization", "Bearer sk-"+strings.Repeat("a", 48))
		c.Request.Header.Set("User-Agent", tc.ua)
		// These arbitrary caller claims must not override the UA, authenticated
		// user ID or permissions. The implementation reads no client headers.
		c.Request.Header.Set("X-OOAPI-Agent", "one-api")
		c.Request.Header.Set("X-OOAPI-Client-Agent", "codex")
		c.Request.Header.Set("X-User-ID", "999")
		token, err := authenticateAPIKey(c)
		if err != nil {
			t.Fatal(err)
		}
		if token.UserID != 3 || token.UserAgent != tc.ua || token.CallerClient != tc.want {
			t.Fatalf("wrong request metadata: %+v", token)
		}
		token.UserStatus = 0
		if err := checkTokenUsable(token); err == nil {
			t.Fatal("caller product bypassed disabled-user check")
		}
	}
}

func TestCallerMetadataOnAllUsageLogTypes(t *testing.T) {
	d := &callerTestDriver{}
	useCallerTestDB(t, d)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	// The channel/model differ deliberately: caller origin must not follow them.
	token := &apiToken{ID: 2, UserID: 3, UserAgent: "sub2api/1.0", CallerClient: "sub2api"}
	ch := &services.UpstreamChannel{ID: 4, Name: "Anthropic upstream"}
	start := time.Now()
	settle(c, token, &services.Group{Rate: 1}, ch, "gpt-test", upstreamUsage{}, start, 120, LogTypeCall, "")
	settle(c, token, &services.Group{Rate: 1}, ch, "gpt-test", upstreamUsage{}, start, 0, LogTypeChannelFail, "stream interrupted")
	logChannelAttemptFailure(token, ch, "gpt-test", time.Second, "retry failed")
	logAllChannelsFailed(c, token, "gpt-test", start, "all failed")

	count := 0
	for _, ex := range d.execs {
		if !strings.Contains(ex.query, "INSERT INTO logs") {
			continue
		}
		count++
		if !strings.Contains(ex.query, "user_agent, caller_client") {
			t.Fatalf("caller columns missing: %s", ex.query)
		}
		if strings.Count(ex.query, "?") != len(ex.args) {
			t.Fatalf("placeholder mismatch: %s (%d args)", ex.query, len(ex.args))
		}
		if ex.args[len(ex.args)-2].Value != token.UserAgent || ex.args[len(ex.args)-1].Value != token.CallerClient {
			t.Fatalf("lost caller metadata on a log write: %+v", ex.args)
		}
	}
	if count != 4 {
		t.Fatalf("got %d usage log inserts, want 4", count)
	}
}

func TestCallerLogSerializationAndRawUAPrivacy(t *testing.T) {
	for _, admin := range []bool{true, false} {
		t.Run(fmt.Sprintf("admin=%v", admin), func(t *testing.T) {
			d := &callerTestDriver{}
			d.query = func(q string, _ []driver.NamedValue) (driver.Rows, error) {
				if strings.Contains(q, "COUNT(*)") {
					return &callerTestRows{[]string{"count"}, [][]driver.Value{{int64(1)}}}, nil
				}
				// 无关查询（货币设置等 options 读取）返回空结果，
				// 避免驱动替 handler 决定它该查什么。
				if !strings.Contains(q, "FROM logs l") {
					return &callerTestRows{columns: []string{"value"}}, nil
				}
				if !strings.Contains(q, "l.user_agent") && !strings.Contains(q, "COALESCE(l.caller_client") {
					t.Fatalf("metadata columns missing from SELECT: %s", q)
				}
				// The handler selects the raw UA column only for admins and a
				// literal '' otherwise; mirror that in the fake row so the
				// assertion below tests the handler, not the driver.
				rawUA := ""
				if strings.Contains(q, "COALESCE(l.user_agent") {
					rawUA = "one-api/1.0"
				}
				values := []driver.Value{
					int64(1), int64(2), "alice", "Alice", "",
					int64(3), "my key", int64(4), "OpenCode Go",
					int64(2), "claude-model",
					// 计费快照三列模型名（请求 / 上游 / 计价）
					"claude-sonnet-4-5", "claude-haiku-5-5", "claude-haiku-5-5",
					int64(5), int64(6), int64(0),
					// 单价、分组倍率、倍率前额度、未取整成本
					float64(2), float64(4), float64(0.25), float64(1.5), int64(10), float64(9.5),
					int64(10), int64(9), int64(3), "127.0.0.1",
					rawUA, "", "detail", "2026-10-08 10:00:00",
				}
				columns := make([]string, len(values))
				for i := range columns {
					columns[i] = fmt.Sprintf("col%d", i)
				}
				return &callerTestRows{columns, [][]driver.Value{values}}, nil
			}
			useCallerTestDB(t, d)

			// 权限由中间件写入 context；这里直接模拟两种角色的 context 值，
			// 检验 handler 自己是否按 log:view_all 收口。
			r := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(r)
			c.Request = httptest.NewRequest("GET", "/logs/usage", nil)
			c.Set(middleware.CtxUserKey, &models.User{ID: 2})
			if admin {
				c.Set(middleware.CtxRoleKey, authz.RoleAdmin)
			} else {
				c.Set(middleware.CtxRoleKey, authz.RoleUser)
			}
			UsageLogs(c)

			var response struct {
				Success bool `json:"success"`
				Data    struct {
					Items []map[string]any `json:"items"`
				} `json:"data"`
			}
			if err := json.Unmarshal(r.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if !response.Success || len(response.Data.Items) != 1 {
				t.Fatalf("bad log response: %s", r.Body.String())
			}
			item := response.Data.Items[0]
			if item["caller_client"] != "one-api" {
				t.Fatalf("lost inferred caller: %+v", item)
			}
			ua, present := item["user_agent"]
			if present != admin || (admin && ua != "one-api/1.0") {
				t.Fatalf("wrong raw-UA visibility (admin=%v): %+v", admin, item)
			}
			// 非管理员不得看到账号名（基础设施信息）。
			if name, _ := item["channel_name"].(string); !admin && name != "" {
				t.Fatalf("non-admin leaked channel name: %+v", item)
			}
		})
	}
}
