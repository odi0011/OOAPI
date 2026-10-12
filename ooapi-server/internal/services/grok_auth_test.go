package services

// Grok/xAI 设备授权与订阅凭据的单元测试。
// 全部使用 httptest mock 服务器 + 假 DB 驱动，不依赖真实 xAI 账号与数据库。

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ooapi/internal/db"
)

// overrideGrokEndpoints 把设备码与 token 端点指到 mock 服务器。
func overrideGrokEndpoints(t *testing.T, server *httptest.Server) {
	t.Helper()
	device, token := grokDeviceURL, grokTokenURL
	grokDeviceURL = server.URL + "/oauth2/device/code"
	grokTokenURL = server.URL + "/oauth2/token"
	t.Cleanup(func() { grokDeviceURL, grokTokenURL = device, token })
}

// testGrokJWT 拼一个 header.payload.signature 形态的测试 JWT。
func testGrokJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

// ---------- 设备码流程 ----------

func TestGrokDeviceStartAndPollSuccess(t *testing.T) {
	var tokenCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Errorf("wrong request %s %s", r.Method, r.Header.Get("Content-Type"))
		}
		body, _ := io.ReadAll(r.Body)
		form, _ := parseFormBody(string(body))
		switch r.URL.Path {
		case "/oauth2/device/code":
			if form["client_id"] != GrokClientID || form["scope"] != GrokScopes {
				t.Errorf("bad device body %v", form)
			}
			io.WriteString(w, `{"device_code":"dcode","user_code":"ABCD-EFGH","verification_uri":"https://accounts.x.ai/device","verification_uri_complete":"https://accounts.x.ai/device?user_code=ABCD-EFGH","interval":4,"expires_in":600}`)
		case "/oauth2/token":
			tokenCalls.Add(1)
			if form["grant_type"] != grokDeviceGrant || form["client_id"] != GrokClientID || form["device_code"] != "dcode" {
				t.Errorf("bad token body %v", form)
			}
			io.WriteString(w, `{"access_token":"grok-access","refresh_token":"grok-refresh","token_type":"Bearer","scope":"openid","expires_in":3600}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)

	start, err := GrokStartDevice(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if start.DeviceCode != "dcode" || start.UserCode != "ABCD-EFGH" || start.Interval != 4 || start.ExpiresIn != 600 {
		t.Fatalf("start %#v", start)
	}
	if !strings.Contains(start.VerifyURL, "user_code=ABCD-EFGH") {
		t.Fatalf("verification_uri_complete not preferred: %q", start.VerifyURL)
	}
	out, cred, err := GrokPollDevice(context.Background(), start)
	if err != nil || out.Status != "success" || out.Vendor != "grok" || out.Method != "grok" {
		t.Fatalf("poll %#v %#v %v", out, cred, err)
	}
	if cred.AccessToken != "grok-access" || cred.RefreshToken != "grok-refresh" || cred.TokenType != "Bearer" {
		t.Fatalf("credential %#v", cred)
	}
	if cred.ExpiresAt < time.Now().Unix()+3500 || cred.ExpiresAt > time.Now().Unix()+3700 {
		t.Fatalf("expiry not from expires_in: %d", cred.ExpiresAt)
	}
	if tokenCalls.Load() != 1 {
		t.Fatal("token polled too often")
	}
}

// parseFormBody 把 x-www-form-urlencoded 请求体解析成 map（测试用）。
func parseFormBody(raw string) (map[string]string, error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for k, vs := range values {
		if len(vs) > 0 {
			out[k] = vs[0]
		}
	}
	return out, nil
}

func TestGrokDeviceStartRejectsUnsafeVerificationURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"device_code":"dcode","user_code":"U","verification_uri_complete":"https://evil.example/device"}`)
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)
	if _, err := GrokStartDevice(context.Background()); err == nil {
		t.Fatal("unsafe verification URL accepted")
	}
	// accounts.x.ai 也必须被接受（verification_uri_complete 的真实形态）。
	server2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"device_code":"d","user_code":"U","verification_uri":"https://accounts.x.ai/device","interval":5,"expires_in":900}`)
	}))
	defer server2.Close()
	overrideGrokEndpoints(t, server2)
	if _, err := GrokStartDevice(context.Background()); err != nil {
		t.Fatalf("official verification URL rejected: %v", err)
	}
}

func TestGrokJudgeTokenSemantics(t *testing.T) {
	for _, tt := range []struct {
		status int
		body   string
		want   string
		slow   bool
		msgHas string
	}{
		{400, `{"error":"authorization_pending"}`, "pending", false, ""},
		{400, `{"error":"slow_down"}`, "pending", true, ""},
		{400, `{"error":"expired_token"}`, "expired", false, ""},
		{400, `{"error":"access_denied"}`, "denied", false, ""},
		{400, `{"error":"invalid_grant","error_description":"token is not valid"}`, "error", false, "token is not valid"},
		{500, `{"message":"boom"}`, "error", false, "boom"},
		{500, `not-json`, "error", false, "not-json"},
		{200, `{"access_token":"access","refresh_token":"refresh","expires_in":3600}`, "success", false, ""},
	} {
		t.Run(tt.body, func(t *testing.T) {
			var j map[string]any
			json.Unmarshal([]byte(tt.body), &j)
			out, cred := GrokJudgeToken(tt.status, j, tt.body)
			if out.Status != tt.want || out.SlowDown != tt.slow {
				t.Fatalf("got %#v", out)
			}
			if tt.msgHas != "" && !strings.Contains(out.Message, tt.msgHas) {
				t.Fatalf("message %q missing %q", out.Message, tt.msgHas)
			}
			if out.Status == "success" {
				if cred.AccessToken != "access" || cred.RefreshToken != "refresh" || cred.ExpiresAt <= time.Now().Unix() {
					t.Fatalf("credential %#v", cred)
				}
			} else if cred.AccessToken != "" {
				t.Fatal("unexpected credential")
			}
		})
	}
}

// ---------- JWT 过期时间 ----------

func TestGrokJWTExpiryPreferredAndSafetyWindow(t *testing.T) {
	now := time.Now()
	// exp 优先于 expires_in。
	token := testGrokJWT(t, map[string]any{"exp": now.Unix() + 7200, "email": "a@b.c"})
	out, cred := GrokJudgeToken(200, map[string]any{"access_token": token, "refresh_token": "r", "expires_in": float64(600)}, "")
	if out.Status != "success" || cred.ExpiresAt != now.Unix()+7200 {
		t.Fatalf("JWT exp not preferred: %#v", cred)
	}
	if cred.Email != "a@b.c" {
		t.Fatalf("email not extracted: %#v", cred)
	}
	// 各类畸形/不合理输入必须安全回退到 expires_in（且绝不 panic）。
	for _, tt := range []struct {
		name  string
		token string
	}{
		{"not a jwt", "plain-token"},
		{"empty payload", "a..c"},
		{"four segments", "a.b.c.d"},
		{"bad base64", "a.!!!.c"},
		{"non json payload", "a." + base64.RawURLEncoding.EncodeToString([]byte("nope")) + ".c"},
		{"exp not numeric", testGrokJWT(t, map[string]any{"exp": "abc"})},
		{"exp already past", testGrokJWT(t, map[string]any{"exp": now.Unix() - 3600})},
		{"exp absurdly far", testGrokJWT(t, map[string]any{"exp": now.Unix() + 500*24*3600})},
		{"binary garbage", "\x00.\xff.c"},
	} {
		out, cred := GrokJudgeToken(200, map[string]any{"access_token": tt.token, "expires_in": float64(600)}, "")
		if out.Status != "success" {
			t.Fatalf("%s: status %s", tt.name, out.Status)
		}
		if diff := cred.ExpiresAt - (now.Unix() + 600); diff < -5 || diff > 5 {
			t.Fatalf("%s: expiry %d want about %d", tt.name, cred.ExpiresAt, now.Unix()+600)
		}
	}
	// 无 exp 也无 expires_in：3600 秒保守回退。
	out, cred = GrokJudgeToken(200, map[string]any{"access_token": "plain"}, "")
	if out.Status != "success" {
		t.Fatalf("status %s", out.Status)
	}
	if diff := cred.ExpiresAt - (now.Unix() + 3600); diff < -5 || diff > 5 {
		t.Fatalf("fallback expiry %d", cred.ExpiresAt)
	}
	// exp 恰好落在窗口边界内的可信值必须保留。
	for _, tt := range []struct {
		name string
		exp  int64
		want int64
	}{
		{"about a year", now.Unix() + 365*24*3600, now.Unix() + 365*24*3600},
		{"four minutes past", now.Unix() - 240, now.Unix() - 240},
	} {
		if got := grokJWTExpiry(testGrokJWT(t, map[string]any{"exp": tt.exp}), now); got != tt.want {
			t.Fatalf("%s: got %d want %d", tt.name, got, tt.want)
		}
	}
}

// ---------- 统一会话引擎：Start → Poll → Ticket ----------

func TestDeviceFlowGrokStartPollTicket(t *testing.T) {
	useTestSecret(t)
	now := time.Now().Unix()
	token := testGrokJWT(t, map[string]any{"exp": now + 7200, "email": "grok@example.com"})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth2/device/code":
			io.WriteString(w, `{"device_code":"grok-device","user_code":"GROK-CODE","verification_uri_complete":"https://accounts.x.ai/device?user_code=GROK-CODE","interval":3,"expires_in":600}`)
		case "/oauth2/token":
			io.WriteString(w, `{"access_token":"`+token+`","refresh_token":"grok-refresh","expires_in":600}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)

	s := NewDeviceBindService()
	start, err := s.Start(context.Background(), 7, 0, DeviceStartRequest{Vendor: "grok"})
	if err != nil {
		t.Fatal(err)
	}
	if start.Vendor != "grok" || start.Method != "grok" || start.UserCode != "GROK-CODE" || start.IntervalMs != 3000 || start.ExpiresIn != 600 || start.SessionID == "" {
		t.Fatalf("start %#v", start)
	}
	// 目标渠道不一致要拒绝；跨用户要拿到 expired。
	if _, err := s.Poll(context.Background(), 7, start.SessionID, 9); err == nil {
		t.Fatal("target mismatch accepted")
	}
	if out, _ := s.Poll(context.Background(), 8, start.SessionID, 0); out.Status != "expired" {
		t.Fatal("cross-user poll accepted")
	}
	out, err := s.Poll(context.Background(), 7, start.SessionID, 0)
	if err != nil || out.Status != "success" || out.Ticket == "" {
		t.Fatalf("poll %#v %v", out, err)
	}
	if !strings.Contains(out.Account, "Grok 订阅") || !strings.Contains(out.Account, "grok@example.com") {
		t.Fatalf("account label %q", out.Account)
	}
	if out.ExpiresIn <= 0 {
		t.Fatalf("expires_in missing: %#v", out)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), token) || strings.Contains(string(raw), "grok-refresh") {
		t.Fatal("credential leaked to caller")
	}
	var applied DeviceTicket
	if err := s.WithTicket(7, out.Ticket, 0, func(tp DeviceTicket) error { applied = tp; return nil }); err != nil {
		t.Fatal(err)
	}
	cred, err := DecryptGrokCredential(applied.Encrypted)
	if err != nil || cred.AccessToken != token || cred.RefreshToken != "grok-refresh" || cred.Email != "grok@example.com" {
		t.Fatalf("stored credential %#v %v", cred, err)
	}
	// JWT exp 是权威过期时间（600 秒的 expires_in 只是兜底）。
	if cred.ExpiresAt != now+7200 {
		t.Fatalf("stored expiry %d want %d", cred.ExpiresAt, now+7200)
	}
	base, err := DeviceChannelBase(applied)
	if err != nil || base != GrokCLIBase {
		t.Fatalf("base %q %v", base, err)
	}
	// 票据一次性。
	if s.WithTicket(7, out.Ticket, 0, func(DeviceTicket) error { return nil }) == nil {
		t.Fatal("ticket reused")
	}
}

// RFC 8628 完整循环：start → 第一次 poll pending → 第二次 poll success → 一次性票据。
func TestDeviceFlowGrokPendingThenSuccess(t *testing.T) {
	useTestSecret(t)
	var tokenCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth2/device/code":
			io.WriteString(w, `{"device_code":"dev","user_code":"GROK-PEND","verification_uri":"https://accounts.x.ai/device","interval":5,"expires_in":600}`)
		case "/oauth2/token":
			if tokenCalls.Add(1) == 1 {
				w.WriteHeader(400)
				io.WriteString(w, `{"error":"authorization_pending"}`)
				return
			}
			io.WriteString(w, `{"access_token":"grok-access","refresh_token":"grok-refresh","expires_in":3600}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)

	s := NewDeviceBindService()
	start, err := s.Start(context.Background(), 11, 0, DeviceStartRequest{Vendor: "grok", Method: "grok"})
	if err != nil {
		t.Fatal(err)
	}
	if start.UserCode != "GROK-PEND" || start.VerifyURL != "https://accounts.x.ai/device" {
		t.Fatalf("start %#v", start)
	}
	first, err := s.Poll(context.Background(), 11, start.SessionID, 0)
	if err != nil || first.Status != "pending" || first.IntervalMs != 5000 {
		t.Fatalf("pending poll %#v %v", first, err)
	}
	// 跳过轮询节流窗口（引擎的 in-flight 互斥仍然生效）。
	s.mu.Lock()
	s.sessions[start.SessionID].next = time.Now().Add(-time.Second)
	s.mu.Unlock()
	second, err := s.Poll(context.Background(), 11, start.SessionID, 0)
	if err != nil || second.Status != "success" || second.Ticket == "" || second.ExpiresIn <= 0 {
		t.Fatalf("success poll %#v %v", second, err)
	}
	if tokenCalls.Load() != 2 {
		t.Fatalf("token endpoint called %d times", tokenCalls.Load())
	}
	if err := s.WithTicket(11, second.Ticket, 0, func(DeviceTicket) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if s.WithTicket(11, second.Ticket, 0, func(DeviceTicket) error { return nil }) == nil {
		t.Fatal("ticket reused after pending-then-success flow")
	}
}

func TestDeviceFlowGrokSlowDownRaisesInterval(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		io.WriteString(w, `{"error":"slow_down"}`)
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)
	s := NewDeviceBindService()
	s.sessions["session"] = &deviceSession{
		owner: 3, vendor: "grok", method: "grok",
		expires: time.Now().Add(time.Minute), interval: 5 * time.Second,
		grok: GrokDeviceStart{DeviceCode: "device"},
	}
	first, err := s.Poll(context.Background(), 3, "session", 0)
	if err != nil || !first.SlowDown || first.Status != "pending" || first.IntervalMs != 10000 {
		t.Fatalf("%#v %v", first, err)
	}
}

// ---------- 刷新链路（单飞 + CAS + 失败回退） ----------

type grokCredentialDB struct {
	mu                   sync.Mutex
	encrypted            string
	version              int64
	vendor, method, base string
	writes               int
}

var grokTestDB *grokCredentialDB
var registerGrokDB sync.Once

type grokDBDriver struct{}
type grokDBConn struct{}

func (grokDBDriver) Open(string) (driver.Conn, error) { return grokDBConn{}, nil }
func (grokDBConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare not used")
}
func (grokDBConn) Close() error              { return nil }
func (grokDBConn) Begin() (driver.Tx, error) { return nil, errors.New("transaction not used") }
func (grokDBConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if !strings.HasPrefix(query, "SELECT vendor, method, base_url") {
		return nil, errors.New("unexpected query")
	}
	grokTestDB.mu.Lock()
	defer grokTestDB.mu.Unlock()
	return &grokDBRows{values: []driver.Value{grokTestDB.vendor, grokTestDB.method, grokTestDB.base, grokTestDB.encrypted, grokTestDB.version}}, nil
}
func (grokDBConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if !strings.Contains(query, "auth_version = auth_version + 1") {
		return nil, errors.New("unexpected update")
	}
	grokTestDB.mu.Lock()
	defer grokTestDB.mu.Unlock()
	if args[3].Value.(int64) != grokTestDB.version {
		return driver.RowsAffected(0), nil
	}
	grokTestDB.encrypted = args[0].Value.(string)
	grokTestDB.version++
	grokTestDB.writes++
	return driver.RowsAffected(1), nil
}

type grokDBRows struct {
	values []driver.Value
	done   bool
}

func (*grokDBRows) Columns() []string {
	return []string{"vendor", "method", "base_url", "auth_credential", "auth_version"}
}
func (*grokDBRows) Close() error { return nil }
func (r *grokDBRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	copy(dest, r.values)
	r.done = true
	return nil
}

func setupGrokDB(t *testing.T, cred GrokCredential) {
	t.Helper()
	registerGrokDB.Do(func() { sql.Register("grok-auth-test", grokDBDriver{}) })
	stored, err := EncryptGrokCredential(cred)
	if err != nil {
		t.Fatal(err)
	}
	grokTestDB = &grokCredentialDB{encrypted: stored, version: 1, vendor: "grok", method: "grok", base: GrokCLIBase}
	conn, err := sql.Open("grok-auth-test", "")
	if err != nil {
		t.Fatal(err)
	}
	old := db.DB
	db.DB = conn
	t.Cleanup(func() { db.DB = old; conn.Close(); grokTestDB = nil })
}

func TestGrokCredentialRefreshSingleFlightAndCAS(t *testing.T) {
	useTestSecret(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body, _ := io.ReadAll(r.Body)
		form, _ := parseFormBody(string(body))
		if form["grant_type"] != "refresh_token" || form["client_id"] != GrokClientID || form["refresh_token"] != "old-refresh" {
			t.Errorf("bad refresh body %v", form)
		}
		calls.Add(1)
		io.WriteString(w, `{"access_token":"fresh-access","refresh_token":"rotated-refresh","expires_in":3600}`)
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)
	setupGrokDB(t, GrokCredential{AccessToken: "expired-access", RefreshToken: "old-refresh", ExpiresAt: time.Now().Unix() - 60})

	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cred, err := ResolveGrokCredential(context.Background(), 23)
			if err != nil || cred.AccessToken != "fresh-access" {
				t.Errorf("resolve %#v %v", cred, err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 || grokTestDB.writes != 1 {
		t.Fatalf("duplicate refresh calls=%d writes=%d", calls.Load(), grokTestDB.writes)
	}
	cred, err := DecryptGrokCredential(grokTestDB.encrypted)
	if err != nil || cred.RefreshToken != "rotated-refresh" || strings.Contains(grokTestDB.encrypted, "fresh-access") {
		t.Fatal("refresh persisted incorrectly")
	}
}

func TestGrokCredentialRebindCASDoesNotOverwriteNewAccount(t *testing.T) {
	useTestSecret(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 刷新进行中：管理员重新绑定了账号（版本 +1）。
		stored, _ := EncryptGrokCredential(GrokCredential{AccessToken: "rebound-account", RefreshToken: "rebound-refresh", ExpiresAt: time.Now().Unix() + 3600})
		grokTestDB.mu.Lock()
		grokTestDB.encrypted = stored
		grokTestDB.version++
		grokTestDB.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"access_token":"stale-refreshed-account","expires_in":3600}`)
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)
	setupGrokDB(t, GrokCredential{AccessToken: "old-account", RefreshToken: "old-refresh", ExpiresAt: time.Now().Unix() - 1})
	cred, err := ResolveGrokCredential(context.Background(), 24)
	if err != nil || cred.AccessToken != "rebound-account" || grokTestDB.writes != 0 {
		t.Fatalf("CAS failed: %#v %v writes=%d", cred, err, grokTestDB.writes)
	}
}

// 刷新失败但手里还有 access_token：不得本地拦截，原样返回给传输层，
// 由上游 401/403 决定是否真的失效（与 WorkBuddy 的线上修复同策略）。
func TestGrokRefreshFailureDoesNotBlockExistingToken(t *testing.T) {
	useTestSecret(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, `{"error":"server_error"}`)
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)
	setupGrokDB(t, GrokCredential{AccessToken: "still-valid-token", RefreshToken: "r", ExpiresAt: time.Now().Unix() - 60})
	cred, err := ResolveGrokCredential(context.Background(), 25)
	if err != nil || cred.AccessToken != "still-valid-token" {
		t.Fatalf("existing token blocked by failed refresh: %#v %v", cred, err)
	}
	if _, err := ForceRefreshGrokCredential(context.Background(), 25); err == nil {
		t.Fatal("forced refresh should report upstream failure")
	}
}

func TestGrokResolverRejectsForeignChannelAndBase(t *testing.T) {
	useTestSecret(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("invalid channel reached refresh upstream")
	}))
	defer server.Close()
	overrideGrokEndpoints(t, server)
	setupGrokDB(t, GrokCredential{AccessToken: "access", RefreshToken: "rt", ExpiresAt: time.Now().Unix() + 3600})
	grokTestDB.method = "api"
	if _, err := ResolveGrokCredential(context.Background(), 26); err == nil {
		t.Fatal("API key channel treated as device channel")
	}
	grokTestDB.method = "grok"
	grokTestDB.base = "https://cli-chat-proxy.grok.com.evil.example/v1"
	if _, err := ResolveGrokCredential(context.Background(), 26); err == nil {
		t.Fatal("credential sent to non-official host")
	}
	grokTestDB.base = GrokCLIBase
	if _, err := ResolveGrokCredential(context.Background(), 26); err != nil {
		t.Fatalf("valid credential rejected: %v", err)
	}
}

// ---------- 厂商注册 / 校验辅助 ----------

func TestGrokVendorRegistrationAndMarkers(t *testing.T) {
	if NormalizeDeviceVendor("GROK") != "grok" || DeviceVendorOfMethod("grok") != "grok" {
		t.Fatal("vendor normalization wrong")
	}
	if !DeviceMethodSupported("grok") {
		t.Fatal("grok method not supported")
	}
	if DeviceUnavailable("grok") != "" {
		t.Fatal("grok reported unavailable")
	}
	for _, method := range []string{"", "grok"} {
		if err := ValidateDeviceVendor("grok", method); err != nil {
			t.Fatalf("grok/%s rejected: %v", method, err)
		}
	}
	if err := ValidateDeviceVendor("grok", "api"); err == nil {
		t.Fatal("grok/api accepted")
	}
	if got := DeviceCredentialMarker("grok", 7); got != "ooapi-grok-channel-7" {
		t.Fatalf("marker %q", got)
	}
	if !IsDeviceCredentialMarker("ooapi-grok-channel-1") || IsDeviceCredentialMarker("sk-real-key") {
		t.Fatal("marker detection wrong")
	}
	// 设备授权渠道的 base 必须固定为官方订阅地址。
	if !IsGrokSubscriptionBase("https://cli-chat-proxy.grok.com/v1") || !IsGrokSubscriptionBase("https://cli-chat-proxy.grok.com/v1/") {
		t.Fatal("official subscription base rejected")
	}
	for _, raw := range []string{
		"https://cli-chat-proxy.grok.com.evil.example/v1", "http://cli-chat-proxy.grok.com/v1",
		"https://api.x.ai/v1", "https://cli-chat-proxy.grok.com", "",
	} {
		if IsGrokSubscriptionBase(raw) {
			t.Fatalf("unsafe base accepted: %q", raw)
		}
	}
	if GrokChannelBaseURL() != GrokCLIBase {
		t.Fatal("channel base wrong")
	}
}

func TestGrokSessionIDDeterministicUUID(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	id := GrokSessionID(13)
	if !pattern.MatchString(id) {
		t.Fatalf("session id %q is not a v4-shaped uuid", id)
	}
	if GrokSessionID(13) != id {
		t.Fatal("session id not stable")
	}
	if GrokSessionID(14) == id {
		t.Fatal("session id must depend on channel")
	}
}
