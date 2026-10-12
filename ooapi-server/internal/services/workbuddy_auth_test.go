package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// overrideWorkBuddyBase 把两个 realm 的 API 基址都指到 mock 服务器。
func overrideWorkBuddyBase(t *testing.T, server *httptest.Server) {
	t.Helper()
	old := workBuddyAPIBase
	workBuddyAPIBase = func(string) string { return server.URL }
	t.Cleanup(func() { workBuddyAPIBase = old })
}

func TestWorkBuddyDeviceStartPollPendingThenSuccess(t *testing.T) {
	useTestSecret(t)
	var tokenPolls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/plugin/auth/state":
			// 来源头是上游的硬校验：缺失会被直接拒。
			if r.Header.Get("x-requested-with") != "XMLHttpRequest" {
				t.Errorf("missing x-requested-with: %v", r.Header)
			}
			if r.Method != http.MethodPost || r.URL.Query().Get("platform") != "CLI" {
				t.Errorf("wrong start request %s %s", r.Method, r.URL)
			}
			body, _ := io.ReadAll(r.Body)
			if len(body) == 0 || strings.TrimSpace(string(body)) == "null" {
				t.Errorf("start body not JSON: %q", body)
			}
			if r.Header.Get("origin") != "https://www.codebuddy.cn" || r.Header.Get("referer") != "https://www.codebuddy.cn/" {
				t.Errorf("cn origin headers wrong: %v", r.Header)
			}
			if r.Header.Get("user-agent") != "CLI/2.63.2 CodeBuddy/2.63.2" {
				t.Errorf("start UA %q", r.Header.Get("user-agent"))
			}
			io.WriteString(w, `{"code":0,"data":{"state":"state-1","authUrl":"https://www.codebuddy.cn/login?state=state-1"}}`)
		case "/v2/plugin/auth/token":
			if r.Header.Get("x-requested-with") != "XMLHttpRequest" {
				t.Errorf("missing poll x-requested-with: %v", r.Header)
			}
			if r.URL.Query().Get("state") != "state-1" {
				t.Errorf("state not passed: %s", r.URL)
			}
			if tokenPolls.Add(1) == 1 {
				// 待授权：HTTP 200 + 业务 code != 0 —— 绝不能当失败。
				io.WriteString(w, `{"code":1001,"msg":"waiting for user"}`)
				return
			}
			io.WriteString(w, `{"code":0,"data":{"accessToken":"wb-token","refreshToken":"wb-refresh","expiresIn":7200}}`)
		case "/v2/plugin/login/account":
			if r.Header.Get("authorization") != "Bearer wb-token" {
				t.Errorf("account auth %q", r.Header.Get("authorization"))
			}
			io.WriteString(w, `{"code":0,"data":{"uid":"u9","enterpriseId":"e9"}}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	overrideWorkBuddyBase(t, server)

	start, err := WorkBuddyStartDevice(context.Background(), "cn")
	if err != nil {
		t.Fatal(err)
	}
	if start.Realm != "cn" || start.State != "state-1" || start.VerifyURL == "" || start.Interval != 3 {
		t.Fatalf("start %#v", start)
	}
	out, cred, err := WorkBuddyPollDevice(context.Background(), start)
	if err != nil || out.Status != "pending" || cred.AccessToken != "" {
		t.Fatalf("pending judged wrong: %#v %#v %v", out, cred, err)
	}
	out, cred, err = WorkBuddyPollDevice(context.Background(), start)
	if err != nil || out.Status != "success" {
		t.Fatalf("success judged wrong: %#v %v", out, err)
	}
	if cred.AccessToken != "wb-token" || cred.RefreshToken != "wb-refresh" || cred.Realm != "cn" || cred.UserID != "u9" || cred.EnterpriseID != "e9" {
		t.Fatalf("credential %#v", cred)
	}
	if cred.Endpoint != server.URL {
		t.Fatalf("endpoint %q", cred.Endpoint)
	}
	if cred.ExpiresAt < time.Now().Unix()+7000 {
		t.Fatalf("expiry not from expiresIn: %d", cred.ExpiresAt)
	}
}

// testWorkBuddyJWT 拼一个 header.payload.signature 形态的测试 JWT（payload 为 base64url）。
func testWorkBuddyJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

func TestWorkBuddyDecodeJWTPayload(t *testing.T) {
	enc := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	valid := "eyJhbGciOiJub25lIn0." + enc(`{"iss":"https://copilot.tencent.com","exp":1893456000}`) + ".sig"
	cases := []struct {
		name  string
		token string
		ok    bool
	}{
		{"well-formed", valid, true},
		{"empty", "", false},
		{"no dots", "not-a-jwt", false},
		{"two segments", "a." + enc(`{"exp":1}`), false},
		{"four segments (JWE)", "a.b.c.d", false},
		{"empty payload segment", "a..c", false},
		{"bad base64", "a.!!!.c", false},
		{"non json", "a." + enc("not json") + ".c", false},
		{"json array", "a." + enc("[1,2]") + ".c", false},
		{"json null", "a." + enc("null") + ".c", false},
	}
	for _, tt := range cases {
		payload, ok := decodeJWTPayload(tt.token)
		if ok != tt.ok {
			t.Fatalf("%s: ok=%v want %v", tt.name, ok, tt.ok)
		}
		if tt.name == "well-formed" {
			if payload["iss"] != "https://copilot.tencent.com" {
				t.Fatalf("iss %#v", payload["iss"])
			}
			if exp, ok := payload["exp"].(float64); !ok || exp != 1893456000 {
				t.Fatalf("exp %#v", payload["exp"])
			}
		}
	}
	// 个别实现会给 base64url 段带 "=" 填充；也要能解开。
	padded := "a." + base64.URLEncoding.EncodeToString([]byte(`{"exp":1893456000}`)) + ".c"
	if _, ok := decodeJWTPayload(padded); !ok {
		t.Fatal("padded base64url payload rejected")
	}
	// 任何畸形输入都不得 panic。
	for _, s := range []string{"", ".", "...", "a.b.c.d.e", "\x00.\xff.c", "\n\t"} {
		if _, ok := decodeJWTPayload(s); ok {
			t.Fatalf("malformed token accepted: %q", s)
		}
	}
}

func TestWorkBuddyJudgeTokenUsesJWTExpAsAuthoritativeExpiry(t *testing.T) {
	now := time.Now().Unix()
	token := testWorkBuddyJWT(t, map[string]any{"iss": "https://copilot.tencent.com", "exp": now + 7200})
	out, cred := WorkBuddyJudgeToken(200, map[string]any{"data": map[string]any{
		"accessToken": token, "refreshToken": "r", "expiresIn": float64(600),
	}}, "cn")
	if out.Status != "success" {
		t.Fatalf("status %s", out.Status)
	}
	if cred.ExpiresAt != now+7200 {
		t.Fatalf("JWT exp not preferred over expiresIn: got %d want %d", cred.ExpiresAt, now+7200)
	}
}

func TestWorkBuddyJudgeTokenExpiryFallback(t *testing.T) {
	now := time.Now().Unix()
	cases := []struct {
		name      string
		token     string
		expiresIn float64 // 0 表示响应里没有该字段
		want      int64
	}{
		{"no exp claim", testWorkBuddyJWT(t, map[string]any{"iss": "x"}), 600, now + 600},
		{"exp not numeric", testWorkBuddyJWT(t, map[string]any{"exp": "abc"}), 600, now + 600},
		{"exp already past", testWorkBuddyJWT(t, map[string]any{"exp": now - 3600}), 600, now + 600},
		// 上限 400 天：真实 token 的 exp 约为签发后 1 年，不能被判成不可信
		{"exp absurdly far", testWorkBuddyJWT(t, map[string]any{"exp": now + 500*24*3600}), 600, now + 600},
		{"exp about a year out", testWorkBuddyJWT(t, map[string]any{"exp": now + 365*24*3600}), 600, now + 365*24*3600},
		{"not a jwt", "wb-token", 600, now + 600},
		{"no exp and no expiresIn", testWorkBuddyJWT(t, map[string]any{"iss": "x"}), 0, now + 3600},
	}
	for _, tt := range cases {
		data := map[string]any{"accessToken": tt.token}
		if tt.expiresIn > 0 {
			data["expiresIn"] = tt.expiresIn
		}
		out, cred := WorkBuddyJudgeToken(200, map[string]any{"data": data}, "cn")
		if out.Status != "success" {
			t.Fatalf("%s: status %s", tt.name, out.Status)
		}
		if diff := cred.ExpiresAt - tt.want; diff < -5 || diff > 5 {
			t.Fatalf("%s: expiry %d want about %d", tt.name, cred.ExpiresAt, tt.want)
		}
	}
}

func TestWorkBuddyRealmFromJWTIssuer(t *testing.T) {
	for _, tt := range []struct {
		iss  string
		want string
	}{
		{"https://www.workbuddy.ai", "global"},
		{"https://www.codebuddy.ai", "global"},
		{"https://copilot.tencent.com", "cn"},
		{"https://www.codebuddy.cn", "cn"},
	} {
		out, cred := WorkBuddyJudgeToken(200, map[string]any{"data": map[string]any{
			"accessToken": testWorkBuddyJWT(t, map[string]any{"iss": tt.iss}),
		}}, "global")
		if out.Status != "success" || cred.Realm != tt.want {
			t.Fatalf("iss %s: realm %q want %q", tt.iss, cred.Realm, tt.want)
		}
	}
	// iss 判不出来时保留请求时选择的 realm（非 JWT / 陌生 iss）。
	for _, token := range []string{"plain-token", testWorkBuddyJWT(t, map[string]any{"iss": "https://other.example"})} {
		_, cred := WorkBuddyJudgeToken(200, map[string]any{"data": map[string]any{"accessToken": token}}, "cn")
		if cred.Realm != "cn" {
			t.Fatalf("realm not preserved: %q", cred.Realm)
		}
	}
}

func TestWorkBuddyDecryptReconcilesExpiryFromJWT(t *testing.T) {
	useTestSecret(t)
	now := time.Now().Unix()
	// 旧凭据：落库的 ExpiresAt 是历史「1 小时」估算，JWT 才是真实有效期。
	token := testWorkBuddyJWT(t, map[string]any{"exp": now + 86400})
	stored, err := EncryptWorkBuddyCredential(WorkBuddyCredential{AccessToken: token, Realm: "global", ExpiresAt: now + 60})
	if err != nil {
		t.Fatal(err)
	}
	back, err := DecryptWorkBuddyCredential(stored)
	if err != nil || back.ExpiresAt != now+86400 {
		t.Fatalf("stored expiry not reconciled: %#v %v", back, err)
	}
	// 非 JWT 凭据：存储值保持原样。
	plain, err := EncryptWorkBuddyCredential(WorkBuddyCredential{AccessToken: "plain-token", Realm: "global", ExpiresAt: now + 60})
	if err != nil {
		t.Fatal(err)
	}
	back, err = DecryptWorkBuddyCredential(plain)
	if err != nil || back.ExpiresAt != now+60 {
		t.Fatalf("non-JWT expiry changed: %#v %v", back, err)
	}
}

func TestWorkBuddyJudgeTokenNeverTreatsBusinessCodeAsSuccess(t *testing.T) {
	for _, tt := range []struct {
		status int
		body   string
		want   string
	}{
		{200, `{"code":1001,"msg":"waiting"}`, "pending"},
		{200, `{"code":0,"data":{}}`, "pending"},
		{500, `{"code":500,"msg":"boom"}`, "pending"},
		{200, `{"code":0,"data":{"accessToken":"t"}}`, "success"},
		{200, `{"data":{"access_token":"t"}}`, "success"},
	} {
		var j map[string]any
		json.Unmarshal([]byte(tt.body), &j)
		out, cred := WorkBuddyJudgeToken(tt.status, j, "global")
		if out.Status != tt.want {
			t.Fatalf("body %s: got %s want %s", tt.body, out.Status, tt.want)
		}
		if tt.want == "success" && cred.Realm != "global" {
			t.Fatalf("realm %q", cred.Realm)
		}
	}
}

func TestWorkBuddyCredentialEncryptionAndRealmRules(t *testing.T) {
	useTestSecret(t)
	cred := WorkBuddyCredential{AccessToken: "at", RefreshToken: "rt", Realm: "", Endpoint: "", UserID: "u", ExpiresAt: time.Now().Unix() + 3600}
	stored, err := EncryptWorkBuddyCredential(cred)
	if err != nil || !strings.HasPrefix(stored, "enc:v1:") || strings.Contains(stored, "access_token") {
		t.Fatalf("encrypt %q %v", stored, err)
	}
	back, err := DecryptWorkBuddyCredential(stored)
	if err != nil || back.AccessToken != "at" || back.Realm != "global" || back.Endpoint != WorkBuddyGlobalBase {
		t.Fatalf("decrypt %#v %v", back, err)
	}
	for realm, base := range map[string]string{"global": WorkBuddyGlobalBase, "cn": WorkBuddyCNBase, "": WorkBuddyGlobalBase} {
		if got := WorkBuddyBaseURL(realm); got != base {
			t.Fatalf("base(%q)=%s", realm, got)
		}
	}
	if WorkBuddyChannelBaseURL("cn") != WorkBuddyCNBase+"/v2" {
		t.Fatal("channel base wrong")
	}
	if got, ok := WorkBuddyRealmOfBase("https://copilot.tencent.com"); !ok || got != "cn" {
		t.Fatal("cn realm not recognized")
	}
	if _, ok := WorkBuddyRealmOfBase("https://copilot.tencent.com.evil.example"); ok {
		t.Fatal("spoofed host accepted")
	}
	if _, ok := WorkBuddyRealmOfBase("http://www.workbuddy.ai"); ok {
		t.Fatal("http accepted")
	}
}
