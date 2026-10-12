package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/middleware"
	"ooapi/internal/models"
	"ooapi/internal/services"
)

// mustEncryptCodex 造一份格式合法的 Codex 凭据密文（走与生产同一条加密路径）。
func mustEncryptCodex(t *testing.T) string {
	t.Helper()
	raw := `{"access_token":"at","refresh_token":"rt","account_id":"acc","expires_at":4102444800}`
	encrypted, err := cryptoutil.Encrypt(services.JWTSecret(), raw)
	if err != nil {
		t.Fatal(err)
	}
	return encrypted
}

// newLoginTestContext 构造一个带管理员身份与 JSON body 的测试上下文。
func newLoginTestContext(t *testing.T, body string) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set(middleware.CtxUserKey, &models.User{ID: 7, Username: "tester"})
	c.Request = httptest.NewRequest("POST", "/api/admin/channels/devices/login/start", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	return c, w
}

// TestAdminUpstreamLoginStartRejectsUnsupportedVendor 覆盖「必须用粘贴凭据」的厂商。
func TestAdminUpstreamLoginStartRejectsUnsupportedVendor(t *testing.T) {
	services.SetJWTSecret("handler-login-test")
	t.Cleanup(func() { services.SetJWTSecret("") })

	/*
		Google 订阅登录（Antigravity）的客户端凭据来自环境变量，
		测试环境必须自己提供 —— 这正是「凭据不写进源码」的代价与验证点：
		没有配置时应当给出可操作的错误，而不是拿一对内置凭据蒙混过关。
	*/
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id.apps.googleusercontent.com")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret")

	for _, vendor := range []string{"qoder", "kiro", "api", ""} {
		c, w := newLoginTestContext(t, `{"vendor":"`+vendor+`"}`)
		AdminUpstreamLoginStart(c)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "unsupported_vendor") {
			t.Fatalf("vendor %q accepted: %d %s", vendor, w.Code, w.Body.String())
		}
	}
	// 支持的厂商必须拿到授权地址。
	for _, vendor := range services.UpstreamLoginMethods() {
		c, w := newLoginTestContext(t, `{"vendor":"`+vendor+`"}`)
		AdminUpstreamLoginStart(c)
		if w.Code != http.StatusOK {
			t.Fatalf("vendor %q rejected: %d %s", vendor, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "auth_url") || !strings.Contains(w.Body.String(), "state") {
			t.Fatalf("vendor %q response missing auth url: %s", vendor, w.Body.String())
		}
	}
}

// TestAntigravityLoginWithoutCredsGivesActionableError 未配置凭据时要有明确提示。
//
// 这一条比「能启动登录」更重要：内置凭据被移除后，缺配置的部署会走到这里。
// 报错必须说清「缺哪个环境变量」，否则管理员只能对着一个失败的授权干瞪眼。
func TestAntigravityLoginWithoutCredsGivesActionableError(t *testing.T) {
	services.SetJWTSecret("handler-login-test")
	t.Cleanup(func() { services.SetJWTSecret("") })

	// 显式清空（t.Setenv 无法真正删除，用空串等价于未配置）
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "")

	c, w := newLoginTestContext(t, `{"vendor":"antigravity"}`)
	AdminUpstreamLoginStart(c)
	body := w.Body.String()
	if w.Code == http.StatusOK {
		t.Fatalf("未配置凭据时不应返回成功：%s", body)
	}
	if !strings.Contains(body, "GOOGLE_OAUTH_CLIENT_ID") {
		t.Fatalf("报错必须点名缺失的环境变量：%s", body)
	}
}

// TestAdminUpstreamLoginExchangeRejectsEmptyInput 空输入必须给可操作的提示。
func TestAdminUpstreamLoginExchangeRejectsEmptyInput(t *testing.T) {
	services.SetJWTSecret("handler-login-test")
	t.Cleanup(func() { services.SetJWTSecret("") })
	c, w := newLoginTestContext(t, `{"vendor":"codex","input":"   "}`)
	AdminUpstreamLoginExchange(c)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "empty_input") {
		t.Fatalf("empty input accepted: %d %s", w.Code, w.Body.String())
	}
}

// TestAdminUpstreamLoginExchangeRejectsForgedState 伪造/缺失 state 必须被拒。
func TestAdminUpstreamLoginExchangeRejectsForgedState(t *testing.T) {
	services.SetJWTSecret("handler-login-test")
	t.Cleanup(func() { services.SetJWTSecret("") })
	for _, input := range []string{"state=zzz&code=abc", "just-a-code"} {
		c, w := newLoginTestContext(t, `{"vendor":"codex","input":"`+input+`"}`)
		AdminUpstreamLoginExchange(c)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("forged input %q accepted: %d %s", input, w.Code, w.Body.String())
		}
	}
}

// TestAdminUpstreamLoginModelsRequiresValidTicket 句柄无效时必须明确报错，不能空手拉模型。
func TestAdminUpstreamLoginModelsRequiresValidTicket(t *testing.T) {
	c, w := newLoginTestContext(t, `{}`)
	AdminUpstreamLoginModels(c)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "bad_request") {
		t.Fatalf("missing ticket accepted: %d %s", w.Code, w.Body.String())
	}
	c, w = newLoginTestContext(t, `{"ticket":"nope"}`)
	AdminUpstreamLoginModels(c)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "ticket_expired") {
		t.Fatalf("unknown ticket accepted: %d %s", w.Code, w.Body.String())
	}
}

/*
TestCreateLoginChannelGuards 覆盖订阅渠道创建时的校验。

每条都对应一个真实的错配风险：

	· 没有句柄 → 不能凭空建一个没有凭据的订阅账号；
	· 厂商与接入方式不匹配 → 会把 A 厂商的凭据发到 B 厂商的主机上；
	· 自定义地址 / 自定义协议路径 / 填 API Key → 让服务端推导的地址与凭据脱节。
*/
func TestCreateLoginChannelGuards(t *testing.T) {
	services.SetJWTSecret("handler-login-test")
	t.Cleanup(func() { services.SetJWTSecret("") })

	invoke := func(body string) *httptest.ResponseRecorder {
		c, w := newLoginTestContext(t, body)
		req := channelRequestVendorForTest(body)
		createLoginChannel(c, &req)
		return w
	}
	t.Logf("NOTE: if this panics on a nil DB, the case reached INSERT (no guard caught it)")

	// 没有授权句柄。
	w := invoke(`{"name":"c","vendor":"openai","method":"codex","models":["gpt-5"]}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_credential") {
		t.Fatalf("ticketless subscription channel accepted: %d %s", w.Code, w.Body.String())
	}

	// 句柄无效（伪造）。
	w = invoke(`{"name":"c","vendor":"openai","method":"codex","ticket":"forged","models":["gpt-5"]}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "credential_expired") {
		t.Fatalf("forged credential handle accepted: %d %s", w.Code, w.Body.String())
	}

	// 有有效句柄但厂商错配（codex 必须配 openai）。
	// 凭据必须是真加密的：服务端在写入前会先解一次确认格式没坏。
	handle := services.StoreLoginCredential(7, services.UpstreamLoginCredential{
		Vendor: services.LoginVendorCodex, Encrypted: mustEncryptCodex(t), AccountLabel: "a@b.c",
	})
	w = invoke(`{"name":"c","vendor":"anthropic","method":"codex","ticket":"` + handle + `","models":["gpt-5"]}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "vendor_mismatch") {
		t.Fatalf("vendor mismatch accepted: %d %s", w.Code, w.Body.String())
	}

	// 自定义协议路径。
	w = invoke(`{"name":"c","vendor":"openai","method":"codex","ticket":"` + handle + `","models":["gpt-5"],"model_paths":"messages: *"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_input") {
		t.Fatalf("custom model_paths accepted: %d %s", w.Code, w.Body.String())
	}

	// 自定义地址。
	w = invoke(`{"name":"c","vendor":"openai","method":"codex","ticket":"` + handle + `","models":["gpt-5"],"base_url":"https://evil.example/v1"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_url") {
		t.Fatalf("custom base url accepted: %d %s", w.Code, w.Body.String())
	}

	// 填了 API Key。
	w = invoke(`{"name":"c","vendor":"openai","method":"codex","ticket":"` + handle + `","models":["gpt-5"],"api_key":"sk-x"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("api key accepted for subscription channel: %d %s", w.Code, w.Body.String())
	}

	// 没有模型：创建必须被拒（至少一个模型是硬性要求）。
	w = invoke(`{"name":"c","vendor":"openai","method":"codex","ticket":"` + handle + `"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "至少添加一个") {
		t.Fatalf("empty models accepted: %d %s", w.Code, w.Body.String())
	}
}

// TestLoginChannelBaseIsFixedPerMethod 地址表必须与传输层的官方主机一致。
func TestLoginChannelBaseIsFixedPerMethod(t *testing.T) {
	cases := map[string]string{
		services.LoginVendorCodex:       "https://chatgpt.com/backend-api/codex",
		services.LoginVendorClaudeOAuth: "https://api.anthropic.com/v1",
		services.LoginVendorAntigravity: "https://daily-cloudcode-pa.googleapis.com/v1internal",
	}
	for method, want := range cases {
		if got := services.LoginChannelBase(method); got != want {
			t.Fatalf("%s base = %q, want %q", method, got, want)
		}
	}
	if services.LoginChannelBase("api") != "" {
		t.Fatal("api method must not have a fixed subscription base")
	}
}

// TestProbePathForMethod 连通性测试必须打到各协议真正的端点上。
func TestProbePathForMethod(t *testing.T) {
	cases := map[string]string{
		services.LoginVendorCodex:       "/responses",
		services.LoginVendorClaudeOAuth: "/messages",
		services.LoginVendorAntigravity: "/chat/completions",
		"api":                           "/chat/completions",
		"kiro":                          "/chat/completions",
	}
	for method, want := range cases {
		if got := probePathForMethod(method); got != want {
			t.Fatalf("probe path for %s = %q, want %q", method, got, want)
		}
	}
}

// TestDeviceProbeModelCoversSubscription 订阅渠道必须有自己的探测模型，
// 否则空模型列表的账号会拿通用兜底值去探测，得到「模型不存在」的假故障。
func TestDeviceProbeModelCoversSubscription(t *testing.T) {
	for _, method := range services.UpstreamLoginMethods() {
		if deviceProbeModel(method) == "" {
			t.Fatalf("no probe model for %s", method)
		}
	}
}
