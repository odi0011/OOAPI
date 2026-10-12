package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

/*
订阅登录服务的测试。

重点在**安全性**而不是「能跑通」：
  · state 必须一次性、绑定发起人、校验厂商匹配（否则别人的授权码能被塞进本平台）；
  · 凭据句柄必须一次性且绑定 owner；
  · 凭证交换必须真的发出正确的请求参数（client_id / code_verifier / redirect_uri）。
*/

// loginTestServer 捕获交换请求并按给定的响应体作答。
type loginTestServer struct {
	mu       sync.Mutex
	lastForm map[string]string
	lastJSON map[string]any
	status   int
	body     string
	server   *httptest.Server
}

func newLoginTestServer(t *testing.T, status int, body string) *loginTestServer {
	t.Helper()
	harness := &loginTestServer{status: status, body: body}
	harness.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		harness.mu.Lock()
		if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
			var parsed map[string]any
			_ = json.NewDecoder(r.Body).Decode(&parsed)
			harness.lastJSON = parsed
		} else {
			_ = r.ParseForm()
			form := map[string]string{}
			for key := range r.PostForm {
				form[key] = r.PostForm.Get(key)
			}
			harness.lastForm = form
		}
		harness.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(harness.status)
		_, _ = w.Write([]byte(harness.body))
	}))
	t.Cleanup(harness.server.Close)
	return harness
}

// swapLoginEndpoints 把三家的 token 端点点到测试服务器上。
func swapLoginEndpoints(t *testing.T, endpoint string) {
	t.Helper()
	codexOld, claudeOld := "", ""
	// 用可替换的包级变量（见 upstream_login_testhooks.go）。
	codexOld = codexTokenURLForTest
	claudeOld = claudeTokenURLForTest
	codexTokenURLForTest = endpoint
	claudeTokenURLForTest = endpoint
	t.Cleanup(func() {
		codexTokenURLForTest = codexOld
		claudeTokenURLForTest = claudeOld
	})
}

func TestLoginStartGeneratesSecureAuthorizationURL(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	// Google 订阅登录的凭据来自环境变量（源码里不再内置任何凭据）。
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id.apps.googleusercontent.com")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret")

	service := NewUpstreamLoginService()
	for _, vendor := range UpstreamLoginMethods() {
		start, err := service.Start(vendor, 7)
		if err != nil {
			t.Fatalf("%s start: %v", vendor, err)
		}
		if start.State == "" || len(start.State) < 20 {
			t.Fatalf("%s state too short: %q", vendor, start.State)
		}
		if !strings.HasPrefix(start.AuthURL, "https://") {
			t.Fatalf("%s auth url not https: %s", vendor, start.AuthURL)
		}
		if !strings.Contains(start.AuthURL, "state="+start.State) {
			t.Fatalf("%s auth url missing state", vendor)
		}
		if !strings.Contains(start.AuthURL, "redirect_uri=") {
			t.Fatalf("%s auth url missing redirect_uri", vendor)
		}
		switch vendor {
		case LoginVendorCodex:
			if !strings.Contains(start.AuthURL, "code_challenge=") || !strings.Contains(start.AuthURL, "code_challenge_method=S256") {
				t.Fatal("codex must use PKCE S256")
			}
			if !strings.Contains(start.AuthURL, "auth.openai.com") {
				t.Fatal("codex must authorize on auth.openai.com")
			}
		case LoginVendorClaudeOAuth:
			if !strings.Contains(start.AuthURL, "code_challenge=") {
				t.Fatal("claude must use PKCE")
			}
		case LoginVendorAntigravity:
			// Google 必须带这两项才会下发 refresh_token —— 少任何一个账号只能活一小时。
			if !strings.Contains(start.AuthURL, "access_type=offline") || !strings.Contains(start.AuthURL, "prompt=consent") {
				t.Fatal("google must request offline access with consent prompt")
			}
		}
	}
}

func TestLoginStartRejectsUnknownVendor(t *testing.T) {
	service := NewUpstreamLoginService()
	if _, err := service.Start("qoder", 7); err == nil {
		t.Fatal("unknown vendor accepted")
	}
}

func TestLoginExchangeRejectsMissingState(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	service := NewUpstreamLoginService()
	// 只粘贴了 code，没有 state：必须拒绝（无法确认这次登录是本平台发起的）。
	_, err := service.Exchange(context.Background(), LoginVendorCodex, 7, "just-a-code")
	if err == nil || !strings.Contains(err.Error(), "state") {
		t.Fatalf("code without state accepted: %v", err)
	}
}

func TestLoginExchangeRejectsForgedState(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	service := NewUpstreamLoginService()
	_, err := service.Exchange(context.Background(), LoginVendorCodex, 7, "http://localhost:1455/auth/callback?code=abc&state=forged")
	if err == nil {
		t.Fatal("forged state accepted")
	}
}

func TestLoginExchangeRejectsAnotherAdminsSession(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	service := NewUpstreamLoginService()
	start, err := service.Start(LoginVendorCodex, 7)
	if err != nil {
		t.Fatal(err)
	}
	// 换个管理员带同一个 state：必须拒绝，且不能把会话吃掉
	//（否则攻击者能靠反复尝试打断真正的登录）。
	_, err = service.Exchange(context.Background(), LoginVendorCodex, 8, "http://localhost:1455/auth/callback?code=abc&state="+start.State)
	if err == nil || !strings.Contains(err.Error(), "不属于") {
		t.Fatalf("cross-admin exchange accepted: %v", err)
	}
	// 真正的发起人仍然可以用（会话没被偷走）。
	if _, err := service.takeSession(start.State, 7); err != nil {
		t.Fatalf("session was consumed by the failed attempt: %v", err)
	}
}

func TestLoginExchangeRejectsVendorMismatch(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	service := NewUpstreamLoginService()
	start, err := service.Start(LoginVendorCodex, 7)
	if err != nil {
		t.Fatal(err)
	}
	// 拿 codex 的会话去换 claude 的凭据：必须拒绝。
	_, err = service.Exchange(context.Background(), LoginVendorClaudeOAuth, 7, "http://localhost:54545/callback?code=abc&state="+start.State)
	if err == nil || !strings.Contains(err.Error(), "不匹配") {
		t.Fatalf("vendor mismatch accepted: %v", err)
	}
}

func TestLoginExchangeIsOneShot(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	service := NewUpstreamLoginService()
	start, err := service.Start(LoginVendorCodex, 7)
	if err != nil {
		t.Fatal(err)
	}
	// 第一次消费成功。
	if _, err := service.takeSession(start.State, 7); err != nil {
		t.Fatal(err)
	}
	// 第二次必须失败（同一 state 不能重复使用）。
	if _, err := service.takeSession(start.State, 7); err == nil {
		t.Fatal("state reused")
	}
}

func TestLoginExchangeCodexSendsPKCEAndStoresCredential(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	harness := newLoginTestServer(t, 200, `{"access_token":"at","refresh_token":"rt","expires_in":3600,"id_token":"e30.eyJlbWFpbCI6ImFAYi5jIiwiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjIn0."}`)
	swapLoginEndpoints(t, harness.server.URL)

	service := NewUpstreamLoginService()
	start, err := service.Start(LoginVendorCodex, 7)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := service.Exchange(context.Background(), LoginVendorCodex, 7,
		"http://localhost:1455/auth/callback?code=the-code&state="+start.State)
	if err != nil {
		t.Fatal(err)
	}
	harness.mu.Lock()
	form := harness.lastForm
	harness.mu.Unlock()
	if form["code"] != "the-code" || form["grant_type"] != "authorization_code" || form["client_id"] != codexClientID {
		t.Fatalf("bad exchange form: %#v", form)
	}
	if form["code_verifier"] == "" || form["redirect_uri"] != codexRedirectURI {
		t.Fatalf("missing pkce verifier or redirect: %#v", form)
	}
	if credential.AccountLabel != "a@b.c" {
		t.Fatalf("account label %q", credential.AccountLabel)
	}
	// 存下来的必须是密文，而不是明文 JSON。
	if !strings.Contains(credential.Encrypted, ":") || strings.Contains(credential.Encrypted, "refresh_token") {
		t.Fatalf("credential is not encrypted: %q", credential.Encrypted)
	}
	decrypted, err := DecryptCodexCredential(credential.Encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if decrypted.AccessToken != "at" || decrypted.RefreshToken != "rt" || decrypted.AccountID != "acc" {
		t.Fatalf("decrypted credential mismatch: %+v", decrypted)
	}
}

func TestLoginExchangeRejectsMissingRefreshToken(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	// 没有 refresh_token = 一小时后必然失效的废号，必须当场拒绝。
	harness := newLoginTestServer(t, 200, `{"access_token":"at","expires_in":3600}`)
	swapLoginEndpoints(t, harness.server.URL)

	service := NewUpstreamLoginService()
	start, err := service.Start(LoginVendorCodex, 7)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Exchange(context.Background(), LoginVendorCodex, 7,
		"http://localhost:1455/auth/callback?code=c&state="+start.State)
	if err == nil || !strings.Contains(err.Error(), "refresh_token") {
		t.Fatalf("credential without refresh token accepted: %v", err)
	}
}

func TestLoginExchangeSurfacesUpstreamError(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	harness := newLoginTestServer(t, 400, `{"error":"invalid_grant"}`)
	swapLoginEndpoints(t, harness.server.URL)

	service := NewUpstreamLoginService()
	start, err := service.Start(LoginVendorCodex, 7)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Exchange(context.Background(), LoginVendorCodex, 7,
		"http://localhost:1455/auth/callback?code=c&state="+start.State)
	if err == nil || !strings.Contains(err.Error(), "授权码无效") {
		t.Fatalf("invalid_grant not translated: %v", err)
	}
}

func TestExtractAuthCode(t *testing.T) {
	cases := []struct {
		input     string
		wantCode  string
		wantState string
	}{
		{"http://localhost:1455/auth/callback?code=abc&state=xyz", "abc", "xyz"},
		{"http://localhost:51121/oauth-callback?state=xyz&code=abc", "abc", "xyz"},
		{"abc", "abc", ""},
		{"abc%2Fdef", "abc/def", ""},
		{"  ", "", ""},
		{"http://localhost/callback?error=access_denied", "", ""},
		{"http://localhost:1455/auth/callback?code=a%2Bb&state=s", "a+b", "s"},
	}
	for _, tc := range cases {
		code, state := ExtractAuthCode(tc.input)
		if code != tc.wantCode || state != tc.wantState {
			t.Fatalf("ExtractAuthCode(%q) = (%q,%q), want (%q,%q)", tc.input, code, state, tc.wantCode, tc.wantState)
		}
	}
}

func TestLoginCredentialStoreIsOneShotAndOwnerBound(t *testing.T) {
	credential := UpstreamLoginCredential{Vendor: LoginVendorCodex, Encrypted: "v1:abc", AccountLabel: "a@b.c"}
	handle := StoreLoginCredential(7, credential)
	if handle == "" {
		t.Fatal("empty handle")
	}
	// 别人取不到。
	if _, okTicket := TakeLoginCredential(8, handle); okTicket {
		t.Fatal("credential leaked to another owner")
	}
	// 本人可以取，且只能取一次。
	got, okTicket := TakeLoginCredential(7, handle)
	if !okTicket || got.Encrypted != "v1:abc" || got.AccountLabel != "a@b.c" {
		t.Fatalf("take mismatch: %+v ok=%v", got, okTicket)
	}
	if _, again := TakeLoginCredential(7, handle); again {
		t.Fatal("handle reused")
	}
}

func TestLoginCredentialRestoreKeepsHandleUsable(t *testing.T) {
	// 拉模型失败时凭据要还回去：否则用户「授权成功但保存不了」，
	// 只能重新走一遍登录（凭据句柄已经在拉模型那一步被消费掉了）。
	credential := UpstreamLoginCredential{Vendor: LoginVendorClaudeOAuth, Encrypted: "v1:xyz"}
	handle := StoreLoginCredential(7, credential)
	if _, okTicket := TakeLoginCredential(7, handle); !okTicket {
		t.Fatal("setup take failed")
	}
	RestoreLoginCredential(7, handle, credential)
	if _, okTicket := TakeLoginCredential(7, handle); !okTicket {
		t.Fatal("restored handle not usable")
	}
}

func TestLoginCredentialPeekDoesNotConsume(t *testing.T) {
	credential := UpstreamLoginCredential{Vendor: LoginVendorAntigravity, Encrypted: "v1:peek"}
	handle := StoreLoginCredential(7, credential)
	for i := 0; i < 3; i++ {
		got, okTicket := TakeLoginCredentialForChannel(7, handle, false)
		if !okTicket || got.Encrypted != "v1:peek" {
			t.Fatalf("peek %d failed: %+v ok=%v", i, got, okTicket)
		}
	}
	if _, okTicket := TakeLoginCredential(7, handle); !okTicket {
		t.Fatal("peek consumed the credential")
	}
}

func TestLoginMarkerFormatAndDetection(t *testing.T) {
	if got := LoginCredentialMarker(LoginVendorCodex, 13); got != "ooapi-codex-channel-13" {
		t.Fatalf("marker %q", got)
	}
	if got := LoginCredentialMarker("api", 13); got != "" {
		t.Fatalf("api method must not produce a marker: %q", got)
	}
	if !IsLoginCredentialMarker("ooapi-claude-oauth-channel-7") || !IsLoginCredentialMarker("ooapi-antigravity-channel-1") {
		t.Fatal("marker not detected")
	}
	if IsLoginCredentialMarker("sk-real-key") || IsLoginCredentialMarker("") {
		t.Fatal("false positive marker detection")
	}
	// 与设备标识共用同一套「这是内部凭据」判断，避免管理员把标识粘进密钥框。
	if !IsDeviceCredentialMarker("ooapi-codex-channel-3") {
		t.Fatal("subscription marker must count as an internal marker")
	}
}

func TestLoginMethodVendorMapping(t *testing.T) {
	// 错配的后果是把 A 厂商的凭据发到 B 厂商的主机上，所以映射必须固定。
	pairs := map[string]string{
		LoginVendorCodex:       "openai",
		LoginVendorClaudeOAuth: "anthropic",
		LoginVendorAntigravity: "gemini",
	}
	for method, vendor := range pairs {
		if got := UpstreamVendorForLoginMethod(method); got != vendor {
			t.Fatalf("%s -> %s, want %s", method, got, vendor)
		}
	}
	if UpstreamVendorForLoginMethod("api") != "" {
		t.Fatal("api method must not map to a vendor")
	}
}

func TestLoginSessionExpires(t *testing.T) {
	SetJWTSecret("login-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	service := NewUpstreamLoginService()
	start, err := service.Start(LoginVendorCodex, 7)
	if err != nil {
		t.Fatal(err)
	}
	// 手动把会话改成过期，验证 sweep 会清掉它。
	service.mu.Lock()
	service.sessions[start.State].createdAt = time.Now().Add(-2 * upstreamLoginTTL)
	service.mu.Unlock()
	if _, err := service.takeSession(start.State, 7); err == nil {
		t.Fatal("expired session accepted")
	}
}

/* ---------- 凭据导入 ---------- */

// TestImportLoginCredentialPerVendor 覆盖官方 CLI / CPA / sub2api 的常见包装形态。
func TestImportLoginCredentialPerVendor(t *testing.T) {
	SetJWTSecret("import-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	cases := []struct {
		name   string
		vendor string
		raw    string
		label  string
		check  func(t *testing.T, credential UpstreamLoginCredential)
	}{
		{
			name:   "codex 官方 auth.json",
			vendor: LoginVendorCodex,
			raw:    `{"tokens":{"access_token":"at","refresh_token":"rt","id_token":"e30.eyJlbWFpbCI6ImNAZC5lIn0."},"last_refresh":"2026-01-01"}`,
			label:  "c@d.e",
			check: func(t *testing.T, credential UpstreamLoginCredential) {
				cred, err := DecryptCodexCredential(credential.Encrypted)
				if err != nil {
					t.Fatal(err)
				}
				if cred.AccessToken != "at" || cred.RefreshToken != "rt" || cred.Email != "c@d.e" {
					t.Fatalf("parsed %+v", cred)
				}
			},
		},
		{
			name:   "codex 裸对象",
			vendor: LoginVendorCodex,
			raw:    `{"access_token":"at2","refresh_token":"rt2","account_id":"acc-9"}`,
			label:  "acc-9",
			check: func(t *testing.T, credential UpstreamLoginCredential) {
				cred, _ := DecryptCodexCredential(credential.Encrypted)
				if cred.AccountID != "acc-9" {
					t.Fatalf("account id %q", cred.AccountID)
				}
			},
		},
		{
			name:   "claude 官方 .credentials.json（camelCase）",
			vendor: LoginVendorClaudeOAuth,
			raw:    `{"claudeAiOauth":{"accessToken":"c-at","refreshToken":"c-rt","expiresAt":4102444800000,"accountUuid":"uuid-1"}}`,
			label:  "uuid-1",
			check: func(t *testing.T, credential UpstreamLoginCredential) {
				cred, err := DecryptClaudeOAuthCredential(credential.Encrypted)
				if err != nil {
					t.Fatal(err)
				}
				// 毫秒要归一到秒。
				if cred.AccessToken != "c-at" || cred.ExpiresAt != 4102444800 {
					t.Fatalf("parsed %+v", cred)
				}
			},
		},
		{
			name:   "google 带 expiry_date（毫秒）",
			vendor: LoginVendorAntigravity,
			raw:    `{"access_token":"g-at","refresh_token":"g-rt","expiry_date":4102444800000,"project_id":"proj-1","email":"g@h.i"}`,
			label:  "g@h.i",
			check: func(t *testing.T, credential UpstreamLoginCredential) {
				cred, err := DecryptAntigravityCredential(credential.Encrypted)
				if err != nil {
					t.Fatal(err)
				}
				if cred.ProjectID != "proj-1" || cred.ExpiresAt != 4102444800 || cred.Email != "g@h.i" {
					t.Fatalf("parsed %+v", cred)
				}
			},
		},
		{
			name:   "google 用 RFC3339 的 expired",
			vendor: LoginVendorAntigravity,
			raw:    `{"closed":{"access_token":"x"},"access_token":"g2","refresh_token":"g2r","expired":"2030-01-01T00:00:00Z"}`,
			label:  "",
			check: func(t *testing.T, credential UpstreamLoginCredential) {
				cred, _ := DecryptAntigravityCredential(credential.Encrypted)
				if cred.ExpiresAt != 1893456000 {
					t.Fatalf("rfc3339 expiry wrong: %d", cred.ExpiresAt)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			credential, err := ImportLoginCredential(tc.vendor, tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if tc.label != "" && credential.AccountLabel != tc.label {
				t.Fatalf("label %q, want %q", credential.AccountLabel, tc.label)
			}
			if !strings.Contains(credential.Encrypted, ":") {
				t.Fatalf("credential not encrypted: %q", credential.Encrypted)
			}
			tc.check(t, credential)
		})
	}
}

// TestImportLoginCredentialRejections 每种拒绝都要给得出「怎么办」。
func TestImportLoginCredentialRejections(t *testing.T) {
	SetJWTSecret("import-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	cases := []struct {
		name    string
		vendor  string
		raw     string
		wantSub string
	}{
		{"空内容", LoginVendorCodex, "   ", "请粘贴"},
		{"非 JSON", LoginVendorCodex, "not json at all", "不是合法 JSON"},
		{"缺 access_token", LoginVendorCodex, `{"refresh_token":"rt"}`, "access_token"},
		{"缺 refresh_token", LoginVendorCodex, `{"access_token":"at"}`, "refresh_token"},
		{"claude 缺 refresh", LoginVendorClaudeOAuth, `{"claudeAiOauth":{"accessToken":"a"}}`, "refresh_token"},
		{"google 缺 refresh", LoginVendorAntigravity, `{"access_token":"a"}`, "refresh_token"},
		{"不支持的厂商", "api", `{"access_token":"a","refresh_token":"b"}`, "不支持"},
		{"过大", LoginVendorCodex, `{"access_token":"` + strings.Repeat("x", maxImportedCredentialBytes+10) + `"}`, "过大"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ImportLoginCredential(tc.vendor, tc.raw)
			if err == nil || !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("error %v, want substring %q", err, tc.wantSub)
			}
		})
	}
}

// TestImportAcceptsCodeFence 用户从聊天窗口复制时常见的 ```json 围栏要能剥掉。
func TestImportAcceptsCodeFence(t *testing.T) {
	SetJWTSecret("import-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })
	raw := "```json\n{\"access_token\":\"at\",\"refresh_token\":\"rt\"}\n```"
	credential, err := ImportLoginCredential(LoginVendorCodex, raw)
	if err != nil {
		t.Fatal(err)
	}
	cred, _ := DecryptCodexCredential(credential.Encrypted)
	if cred.AccessToken != "at" {
		t.Fatalf("fenced credential not parsed: %+v", cred)
	}
}
