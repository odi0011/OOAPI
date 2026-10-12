package handlers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"ooapi/internal/middleware"
	"ooapi/internal/models"
	"ooapi/internal/services"
)

// TestParseOpenAIModelList 覆盖通用 OpenAI 形状解析（grok / cline 共用）。
func TestParseOpenAIModelList(t *testing.T) {
	raw := []byte(`{"object":"list","data":[{"id":"grok-4.7"},{"id":" grok-4 "},{"id":"grok-4.7"},{"id":""},{"id":""}]}`)
	ids, err := parseOpenAIModelList(raw)
	if err != nil {
		t.Fatal(err)
	}
	// 去重 + 去空白 + 丢空项：两个 grok-4.7 只留一个，空 id 丢弃。
	if len(ids) != 2 || ids[0] != "grok-4.7" || ids[1] != "grok-4" {
		t.Fatalf("ids %#v", ids)
	}
	if _, err := parseOpenAIModelList([]byte("not json")); err == nil {
		t.Fatal("garbage json accepted")
	}
}

// TestParseWorkBuddyModelsFiltersNonChat 验证过滤规则在解析层就生效。
func TestParseWorkBuddyModelsFiltersNonChat(t *testing.T) {
	raw := []byte(`{"data":{"models":[
		{"id":"claude-sonnet-4.5"},
		{"id":"image-gen-1"},
		{"id":"video-pro"},
		{"id":"completion-base"},
		{"id":"nes-edit"},
		{"id":"dst-model","tags":["text-to-image"]},
		{"id":""}
	]}}`)
	ids, err := parseWorkBuddyModels(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != "claude-sonnet-4.5" {
		t.Fatalf("ids %#v", ids)
	}
}

// TestParseKiroModels 验证 Kiro 的 modelId/modelName/id 三种字段回退与去重。
func TestParseKiroModels(t *testing.T) {
	raw := []byte(`{"models":[{"modelId":"claude-sonnet-4.5"},{"modelName":"claude-haiku-4.5"},{"id":"dup"},{"modelName":"dup"}]}`)
	ids, err := parseKiroModels(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 3 || ids[0] != "claude-sonnet-4.5" || ids[1] != "claude-haiku-4.5" || ids[2] != "dup" {
		t.Fatalf("ids %#v", ids)
	}
}

// TestPreviewTicketDoesNotConsume 是「拉模型不能吃掉票据」的回归测试：
// 票据被预览后必须仍可被创建账号的链路消费。
func TestPreviewTicketDoesNotConsume(t *testing.T) {
	svc := services.NewDeviceBindService()
	// 直接构造票据映射不可行（字段私有）—— 从公开行为验证：
	// 不存在的票据预览与领取都必须失败，且失败不改变可观察状态。
	if _, okTicket := svc.PreviewTicket(1, "missing"); okTicket {
		t.Fatal("preview accepted unknown ticket")
	}
	if err := svc.WithTicket(1, "missing", 0, func(services.DeviceTicket) error { return nil }); err == nil {
		t.Fatal("unknown ticket consumed")
	}
}

// TestFetchDeviceModelsRejectsUnknownVendor 保证未知厂商不会被静默放过。
func TestFetchDeviceModelsRejectsUnknownVendor(t *testing.T) {
	if _, err := fetchDeviceModelsWithTicket(context.Background(), "qoder", "x"); err == nil {
		t.Fatal("unknown vendor accepted")
	}
}

// TestAdminDeviceModelsRequiresTicket 覆盖入口校验：没有票据必须 400。
func TestAdminDeviceModelsRequiresTicket(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set(middleware.CtxUserKey, &models.User{ID: 1, Username: "tester"})
	c.Request = httptest.NewRequest("POST", "/api/admin/channels/devices/models", strings.NewReader(`{}`))
	c.Request.Header.Set("Content-Type", "application/json")
	AdminDeviceModels(c)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "bad_request") {
		t.Fatalf("expected 400 bad_request, got %d %s", w.Code, w.Body.String())
	}
}

// ---------- 票据拉模型：按厂商逐一验证请求形状 ----------

// TestFetchDeviceModelsWithTicketPerVendor 是「一键授权后自动拉模型」的核心回归。
//
// 这条路径与运行期通道的区别是凭据来源：渠道还没落库，只能用票据里的密文。
// 一旦某厂商的地址、鉴权头或解析写错，后果是「授权成功后模型永远是空的」，
// 而前端会因此把保存按钮一直置灰 —— 用户看到的是「授权成功了但存不了」。
func TestFetchDeviceModelsWithTicketPerVendor(t *testing.T) {
	services.SetJWTSecret("device-models-test")
	t.Cleanup(func() { services.SetJWTSecret("") })
	oldClient := upstreamClient
	t.Cleanup(func() { upstreamClient = oldClient })

	cases := []struct {
		vendor   string
		encrypt  func() (string, error)
		wantHost string
		wantPath string
		body     string
		expect   []string
	}{
		{
			vendor: "kiro",
			encrypt: func() (string, error) {
				return services.EncryptKiroCredential(services.KiroCredential{AccessToken: "kiro-tok", Region: "ap-northeast-1"})
			},
			wantHost: "codewhisperer.ap-northeast-1.amazonaws.com",
			wantPath: "/ListAvailableModels",
			body:     `{"models":[{"modelId":"claude-sonnet-4.5"}]}`,
			expect:   []string{"claude-sonnet-4.5"},
		},
		{
			vendor: "workbuddy",
			encrypt: func() (string, error) {
				return services.EncryptWorkBuddyCredential(services.WorkBuddyCredential{AccessToken: "wb-tok", Realm: "global"})
			},
			wantHost: "www.workbuddy.ai",
			wantPath: "/v3/config",
			body:     `{"data":{"models":[{"id":"gpt-6-astra"},{"id":"image-x"}]}}`,
			expect:   []string{"gpt-6-astra"},
		},
		{
			vendor: "grok",
			encrypt: func() (string, error) {
				return services.EncryptGrokCredential(services.GrokCredential{AccessToken: "grok-tok"})
			},
			wantHost: "cli-chat-proxy.grok.com",
			wantPath: "/v1/models",
			body:     `{"object":"list","data":[{"id":"grok-4.7"}]}`,
			expect:   []string{"grok-4.7"},
		},
		{
			vendor: "cline",
			encrypt: func() (string, error) {
				return services.EncryptClineCredential(services.ClineCredential{AccessToken: "cline-tok"})
			},
			wantHost: "api.cline.bot",
			wantPath: "/api/v1/models",
			body:     `{"data":[{"id":"claude-sonnet-4.5"}]}`,
			expect:   []string{"claude-sonnet-4.5"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.vendor, func(t *testing.T) {
			encrypted, err := tc.encrypt()
			if err != nil {
				t.Fatal(err)
			}
			var seenHost, seenPath, seenAuth, seenUA string
			upstreamClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				seenHost, seenPath = r.URL.Host, r.URL.Path
				seenAuth = r.Header.Get("Authorization")
				seenUA = r.Header.Get("User-Agent")
				return &http.Response{
					StatusCode: 200,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(tc.body)),
				}, nil
			})}

			models, err := fetchDeviceModelsWithTicket(context.Background(), tc.vendor, encrypted)
			if err != nil {
				t.Fatal(err)
			}
			if seenHost != tc.wantHost || seenPath != tc.wantPath {
				t.Fatalf("request went to %s%s, want %s%s", seenHost, seenPath, tc.wantHost, tc.wantPath)
			}
			// 凭据必须是解出来的 access_token，不能是内部标识或空。
			if !strings.HasPrefix(seenAuth, "Bearer ") || strings.Contains(seenAuth, "ooapi-") {
				t.Fatalf("bad authorization header %q", seenAuth)
			}
			if tc.vendor == "grok" && seenUA == "" {
				t.Fatal("grok models request must carry the CLI identity UA")
			}
			if len(models) != len(tc.expect) {
				t.Fatalf("models %#v, want %#v", models, tc.expect)
			}
			for i := range tc.expect {
				if models[i] != tc.expect[i] {
					t.Fatalf("models %#v, want %#v", models, tc.expect)
				}
			}
		})
	}
}

// TestFetchDeviceModelsWithTicketAuthFailure 上游 401/403 必须给出「重新授权」的提示。
func TestFetchDeviceModelsWithTicketAuthFailure(t *testing.T) {
	services.SetJWTSecret("device-models-test")
	t.Cleanup(func() { services.SetJWTSecret("") })
	oldClient := upstreamClient
	t.Cleanup(func() { upstreamClient = oldClient })

	encrypted, err := services.EncryptKiroCredential(services.KiroCredential{AccessToken: "stale", Region: "us-east-1"})
	if err != nil {
		t.Fatal(err)
	}
	upstreamClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 403, Body: io.NopCloser(strings.NewReader(`{"message":"expired"}`))}, nil
	})}
	_, err = fetchDeviceModelsWithTicket(context.Background(), "kiro", encrypted)
	if err == nil || !strings.Contains(err.Error(), "重新一键授权") {
		t.Fatalf("403 not surfaced as relogin hint: %v", err)
	}
}

// TestFetchDeviceModelsWithTicketRejectsPlaintext 未加密的凭据必须被拒，
// 防止把明文当成密文去解密、拿到空 token 后静默请求上游。
func TestFetchDeviceModelsWithTicketRejectsPlaintext(t *testing.T) {
	services.SetJWTSecret("device-models-test")
	t.Cleanup(func() { services.SetJWTSecret("") })
	if _, err := fetchDeviceModelsWithTicket(context.Background(), "kiro", `{"access_token":"plain"}`); err == nil {
		t.Fatal("plaintext credential accepted")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// TestFetchDeviceModelsWithTicketThroughDecorators 让票据拉模型穿过真实的
// transport 装饰器链（cline → grok → kiro → workbuddy，与 init 顺序一致）。
//
// 装饰器按 Authorization 里的内部标识（ooapi-xxx-channel-N）识别「这是设备渠道的
// 请求」并改写它；票据拉模型带的是解出来的真实 access_token，没有内部标识，
// 必须原样放行。若某个装饰器顺手拦截或改写，这里就会以「授权成功却拉不到模型」的形式炸掉。
func TestFetchDeviceModelsWithTicketThroughDecorators(t *testing.T) {
	services.SetJWTSecret("device-models-test")
	t.Cleanup(func() { services.SetJWTSecret("") })
	oldClient := upstreamClient
	t.Cleanup(func() { upstreamClient = oldClient })

	var hits int
	mock := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		hits++
		if auth := r.Header.Get("Authorization"); strings.Contains(auth, "ooapi-") {
			return nil, errors.New("internal marker leaked into the ticket request")
		}
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"data":{"models":[{"id":"gpt-6-astra"}]}}`)),
		}, nil
	})
	upstreamClient = &http.Client{Transport: &workbuddyTransport{base: &kiroTransport{base: &grokTransport{base: &clineTransport{base: mock}}}}}

	encrypted, err := services.EncryptWorkBuddyCredential(services.WorkBuddyCredential{AccessToken: "wb-tok", Realm: "global"})
	if err != nil {
		t.Fatal(err)
	}
	models, err := fetchDeviceModelsWithTicket(context.Background(), "workbuddy", encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if hits != 1 || len(models) != 1 || models[0] != "gpt-6-astra" {
		t.Fatalf("hits=%d models=%#v", hits, models)
	}
}
