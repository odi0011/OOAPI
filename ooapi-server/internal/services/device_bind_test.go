package services

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type clineMockTransport func(*http.Request) (*http.Response, error)

func (f clineMockTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func mockCline(t *testing.T, f clineMockTransport) {
	t.Helper()
	old := clineAuthClient
	clineAuthClient = &http.Client{Transport: f}
	SetJWTSecret("device-test-master")
	t.Cleanup(func() { clineAuthClient = old; SetJWTSecret("") })
}
func clineResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}
func TestClineDeviceJudgment(t *testing.T) {
	for _, tt := range []struct {
		status int
		body   string
		want   string
		slow   bool
	}{
		{400, `{"error":"authorization_pending"}`, "pending", false},
		{400, `{"error":"slow_down"}`, "pending", true},
		{400, `{"error":"access_denied"}`, "denied", false},
		{400, `{"error":"expired_token"}`, "expired", false},
		{410, `{}`, "expired", false},
		{500, `{"error":"internal_error"}`, "error", false},
		{400, `{"access_token":"must-not-count"}`, "error", false},
		{200, `{"access_token":"access","refresh_token":"refresh"}`, "success", false},
		{200, `{"accessToken":"access","refreshToken":"refresh"}`, "success", false},
		{200, `{}`, "error", false},
	} {
		t.Run(tt.body, func(t *testing.T) {
			var j map[string]any
			json.Unmarshal([]byte(tt.body), &j)
			out, cred := judgeClineDevice(tt.status, j)
			if out.Status != tt.want || out.SlowDown != tt.slow {
				t.Fatalf("got %#v", out)
			}
			if out.Status != "success" && cred.AccessToken != "" {
				t.Fatal("unexpected credential")
			}
		})
	}
}
func TestDeviceProviderSemantics(t *testing.T) {
	for _, tt := range []struct{ vendor, method string }{
		{"cline", "cli"}, {"cli", "cli"}, {"CLI", "cli"},
		{"kiro", ""}, {"kiro", "kiro"},
		{"workbuddy", ""}, {"workbuddy", "workbuddy"},
	} {
		if err := ValidateDeviceVendor(tt.vendor, tt.method); err != nil {
			t.Fatalf("%s/%s rejected: %v", tt.vendor, tt.method, err)
		}
	}
	for _, tt := range []struct{ vendor, method string }{
		{"qoder", ""}, {"api", ""}, {"unknown", ""},
		{"cline", "api"}, {"kiro", "api"}, {"workbuddy", "cli"},
	} {
		if ValidateDeviceVendor(tt.vendor, tt.method) == nil {
			t.Fatalf("unsupported %s/%s accepted", tt.vendor, tt.method)
		}
	}
	if DeviceUnavailable("kiro") != "" || DeviceUnavailable("workbuddy") != "" || DeviceUnavailable("cline") != "" {
		t.Fatal("supported vendor reported unavailable")
	}
	if DeviceUnavailable("qoder") == "" {
		t.Fatal("qoder should stay unavailable")
	}
	for method, want := range map[string]string{
		"cli": "ooapi-cline-channel-7", "kiro": "ooapi-kiro-channel-7", "workbuddy": "ooapi-workbuddy-channel-7", "api": "",
	} {
		if got := DeviceCredentialMarker(method, 7); got != want {
			t.Fatalf("marker(%s)=%q want %q", method, got, want)
		}
	}
	if !IsDeviceCredentialMarker("ooapi-kiro-channel-1") || !IsDeviceCredentialMarker("ooapi-workbuddy-channel-1") || IsDeviceCredentialMarker("sk-real-key") {
		t.Fatal("marker detection wrong")
	}
}
func TestDeviceFlowRequestsOwnershipAndOneUse(t *testing.T) {
	var polls atomic.Int32
	mockCline(t, func(r *http.Request) (*http.Response, error) {
		if r.Method != "POST" || r.Header.Get("User-Agent") != "OOAPI-Gateway/1.0" {
			t.Fatal("wrong method or UA")
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if r.URL.String() != clineRefreshURL && body["client_id"] != clineClientID {
			t.Fatal("wrong client")
		}
		switch r.URL.String() {
		case clineDeviceURL:
			return clineResponse(200, `{"device_code":"secret-device","user_code":"USER-CODE","verification_uri_complete":"https://authkit.cline.bot/device?user_code=USER-CODE","expires_in":300,"interval":5}`), nil
		case clineRefreshURL:
			if body["refreshToken"] != "secret-refresh" || body["grantType"] != "refresh_token" {
				t.Fatal("wrong initial refresh validation")
			}
			return clineResponse(200, `{"accessToken":"secret-access","refreshToken":"rotated-refresh","expiresIn":3600}`), nil
		case clineAuthenticateURL:
			if body["device_code"] != "secret-device" || body["grant_type"] != "urn:ietf:params:oauth:grant-type:device_code" {
				t.Fatal("wrong polling request")
			}
			polls.Add(1)
			return clineResponse(200, `{"access_token":"secret-access","refresh_token":"secret-refresh","expires_in":3600}`), nil
		default:
			t.Fatal("unexpected auth URL", r.URL)
			return nil, errors.New("unexpected")
		}
	})
	service := NewDeviceBindService()
	start, err := service.Start(context.Background(), 7, 13, DeviceStartRequest{Vendor: "cline", Method: "cli"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(start)
	if strings.Contains(string(raw), "secret-device") || start.Method != "cli" || start.ExpiresIn != 300 || start.IntervalMs != 5000 {
		t.Fatalf("bad public start %s", raw)
	}
	out, err := service.Poll(context.Background(), 8, start.SessionID, 13)
	if err != nil || out.Status != "expired" || polls.Load() != 0 {
		t.Fatal("cross-user poll reached upstream")
	}
	if _, err = service.Poll(context.Background(), 7, start.SessionID, 14); err == nil {
		t.Fatal("target changed")
	}
	out, err = service.Poll(context.Background(), 7, start.SessionID, 13)
	if err != nil || out.Status != "success" || out.Ticket == "" {
		t.Fatalf("poll %v %v", out, err)
	}
	raw, _ = json.Marshal(out)
	if strings.Contains(string(raw), "secret-") {
		t.Fatal("credential exposed")
	}
	again, _ := service.Poll(context.Background(), 7, start.SessionID, 13)
	if again.Ticket != out.Ticket || polls.Load() != 1 {
		t.Fatal("success replay polled upstream")
	}
	if service.WithTicket(8, out.Ticket, 13, func(DeviceTicket) error { return nil }) == nil {
		t.Fatal("cross-user claim")
	}
	if service.WithTicket(7, out.Ticket, 14, func(DeviceTicket) error { return nil }) == nil {
		t.Fatal("cross-target claim")
	}
	failed := errors.New("DB commit failed")
	if service.WithTicket(7, out.Ticket, 13, func(DeviceTicket) error { return failed }) != failed {
		t.Fatal("failure not preserved")
	}
	var wins atomic.Int32
	var wg sync.WaitGroup
	for n := 0; n < 10; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = service.WithTicket(7, out.Ticket, 13, func(ticket DeviceTicket) error {
				if ticket.Vendor != "cline" || ticket.Method != "cli" {
					t.Error("ticket vendor lost")
				}
				if strings.Contains(ticket.Encrypted, "secret-") || !strings.HasPrefix(ticket.Encrypted, "enc:v1:") {
					t.Error("not encrypted")
				}
				cred, err := decryptClineCredential(ticket.Encrypted)
				if err != nil || cred.AccessToken != "secret-access" || ticket.ExpiresAt <= time.Now().Unix() {
					t.Error("bad credential")
				}
				wins.Add(1)
				return nil
			})
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatal("not one use", wins.Load())
	}
	replay, _ := service.Poll(context.Background(), 7, start.SessionID, 13)
	if replay.ChannelID != 13 || replay.Ticket != "" {
		t.Fatal("claim replay incorrect")
	}
}
func TestDevicePollingIntervalCancelAndExpiration(t *testing.T) {
	var calls atomic.Int32
	mockCline(t, func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return clineResponse(400, `{"error":"slow_down"}`), nil
	})
	s := NewDeviceBindService()
	s.sessions["session"] = &deviceSession{owner: 3, code: "device", expires: time.Now().Add(time.Minute), interval: 5 * time.Second}
	first, err := s.Poll(context.Background(), 3, "session", 0)
	if err != nil || !first.SlowDown || first.IntervalMs != 10000 {
		t.Fatalf("%#v %v", first, err)
	}
	s.Poll(context.Background(), 3, "session", 0)
	if calls.Load() != 1 {
		t.Fatal("poll interval ignored")
	}
	if s.Cancel(4, "session") {
		t.Fatal("cross-user cancel")
	}
	if !s.Cancel(3, "session") {
		t.Fatal("cancel failed")
	}
	out, _ := s.Poll(context.Background(), 3, "session", 0)
	if out.Status != "expired" {
		t.Fatal("cancelled session usable")
	}
	s.sessions["expired"] = &deviceSession{owner: 3, expires: time.Now().Add(-time.Second)}
	out, _ = s.Poll(context.Background(), 3, "expired", 0)
	if out.Status != "expired" || calls.Load() != 1 {
		t.Fatal("expired session polled")
	}
	s.tickets["expired"] = &DeviceTicket{owner: 3, expires: time.Now().Add(-time.Second)}
	if s.WithTicket(3, "expired", 0, func(DeviceTicket) error { return nil }) == nil {
		t.Fatal("expired ticket accepted")
	}
}
func TestDeviceConcurrentPollSingleRequest(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	mockCline(t, func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		close(entered)
		<-release
		return clineResponse(400, `{"error":"authorization_pending"}`), nil
	})
	s := NewDeviceBindService()
	s.sessions["session"] = &deviceSession{owner: 3, code: "device", expires: time.Now().Add(time.Minute), interval: 5 * time.Second}
	done := make(chan struct{})
	go func() { defer close(done); s.Poll(context.Background(), 3, "session", 0) }()
	<-entered
	second, err := s.Poll(context.Background(), 3, "session", 0)
	if err != nil || second.Status != "pending" || calls.Load() != 1 {
		t.Fatal("concurrent poll was not skipped")
	}
	s.Cancel(3, "session")
	close(release)
	<-done
	if len(s.tickets) != 0 {
		t.Fatal("cancelled in-flight poll issued ticket")
	}
}
func TestClineRefreshRotatesCredentialsAndDoesNotExposeErrors(t *testing.T) {
	mockCline(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != clineRefreshURL {
			t.Fatal("wrong refresh endpoint")
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["refreshToken"] != "old-refresh" || body["grantType"] != "refresh_token" {
			t.Fatal("wrong refresh contract")
		}
		return clineResponse(200, `{"success":true,"data":{"accessToken":"new-access","refreshToken":"rotated-refresh","expiresIn":3600}}`), nil
	})
	fresh, err := refreshClineCredential(context.Background(), ClineCredential{RefreshToken: "old-refresh"})
	if err != nil || fresh.AccessToken != "new-access" || fresh.RefreshToken != "rotated-refresh" {
		t.Fatal(fresh, err)
	}
}
func TestClineEnvelope(t *testing.T) {
	raw := UnwrapClineEnvelope([]byte(`{"success":true,"usage":{"prompt_tokens":4},"data":{"choices":[{"index":0}]}}`))
	var j map[string]any
	json.Unmarshal(raw, &j)
	if j["choices"] == nil || j["usage"] == nil || j["success"] != nil {
		t.Fatalf("envelope %s", raw)
	}
	for _, s := range []string{`{"choices":[],"data":{"choices":[1]}}`, `{"error":{"message":"denied"}}`, `not-json`} {
		if string(UnwrapClineEnvelope([]byte(s))) != s {
			t.Fatal("changed non-envelope")
		}
	}
}

func TestDeviceDoesNotSucceedWhenClineRefreshValidationFails(t *testing.T) {
	mockCline(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() == clineAuthenticateURL {
			return clineResponse(200, `{"access_token":"workos-access","refresh_token":"bad-refresh"}`), nil
		}
		if r.URL.String() == clineRefreshURL {
			return clineResponse(400, `{"error":"failed to refresh token: invalid_grant"}`), nil
		}
		t.Fatal("unexpected endpoint")
		return nil, nil
	})
	s := NewDeviceBindService()
	s.sessions["session"] = &deviceSession{owner: 3, code: "device", expires: time.Now().Add(time.Minute), interval: 5 * time.Second}
	out, err := s.Poll(context.Background(), 3, "session", 0)
	if err != nil || out.Status != "error" || out.Ticket != "" || len(s.tickets) != 0 {
		t.Fatalf("unusable credential accepted %#v %v", out, err)
	}
}
func TestDeviceStartRejectsOtherVerificationHosts(t *testing.T) {
	mockCline(t, func(*http.Request) (*http.Response, error) {
		return clineResponse(200, `{"device_code":"device","verification_uri":"https://other.example/device"}`), nil
	})
	s := NewDeviceBindService()
	if _, err := s.Start(context.Background(), 3, 0, DeviceStartRequest{Vendor: "cline", Method: "cli"}); err == nil || len(s.sessions) != 0 {
		t.Fatal("unsafe verify URL accepted")
	}
}

// ---------- 统一会话引擎：Kiro / WorkBuddy 端到端（mock 上游） ----------

func TestDeviceFlowKiroStartPollTicket(t *testing.T) {
	useTestSecret(t)
	var tokenPolls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/client/register":
			io.WriteString(w, `{"clientId":"cid","clientSecret":"csecret"}`)
		case "/device_authorization":
			io.WriteString(w, `{"deviceCode":"dcode","userCode":"KIRO-CODE","verificationUriComplete":"https://view.awsapps.com/start/#/device?user_code=KIRO-CODE","interval":3,"expiresIn":600}`)
		case "/token":
			tokenPolls.Add(1)
			io.WriteString(w, `{"accessToken":"kiro-access","refreshToken":"kiro-refresh","expiresIn":1800}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	overrideKiroEndpoints(t, server)

	s := NewDeviceBindService()
	start, err := s.Start(context.Background(), 7, 0, DeviceStartRequest{Vendor: "kiro", Region: "us-west-2"})
	if err != nil {
		t.Fatal(err)
	}
	if start.Vendor != "kiro" || start.Method != "kiro" || start.UserCode != "KIRO-CODE" || start.IntervalMs != 3000 || start.ExpiresIn != 600 || start.SessionID == "" {
		t.Fatalf("start %#v", start)
	}
	out, err := s.Poll(context.Background(), 7, start.SessionID, 0)
	if err != nil || out.Status != "success" || out.Ticket == "" || out.Vendor != "kiro" {
		t.Fatalf("poll %#v %v", out, err)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "kiro-access") || strings.Contains(string(raw), "csecret") {
		t.Fatal("credential leaked to caller")
	}
	replay, _ := s.Poll(context.Background(), 7, start.SessionID, 0)
	if replay.Ticket != out.Ticket || tokenPolls.Load() != 1 {
		t.Fatal("success replay re-polled upstream")
	}
	if s.WithTicket(8, out.Ticket, 0, func(DeviceTicket) error { return nil }) == nil {
		t.Fatal("cross-user ticket claim")
	}
	var applied DeviceTicket
	if err := s.WithTicket(7, out.Ticket, 0, func(tp DeviceTicket) error { applied = tp; return nil }); err != nil {
		t.Fatal(err)
	}
	if applied.Vendor != "kiro" || applied.Method != "kiro" {
		t.Fatalf("ticket %#v", applied)
	}
	cred, err := DecryptKiroCredential(applied.Encrypted)
	if err != nil || cred.AccessToken != "kiro-access" || cred.Region != "us-west-2" {
		t.Fatalf("stored credential %#v %v", cred, err)
	}
	base, err := DeviceChannelBase(applied)
	if err != nil || base != "https://codewhisperer.us-west-2.amazonaws.com" {
		t.Fatalf("base %q %v", base, err)
	}
	// 票据一次性。
	if s.WithTicket(7, out.Ticket, 0, func(DeviceTicket) error { return nil }) == nil {
		t.Fatal("ticket reused")
	}
	done, _ := s.Poll(context.Background(), 7, start.SessionID, 0)
	if done.Ticket != "" {
		t.Fatal("claimed ticket still replayable")
	}
}

func TestDeviceFlowWorkBuddyStartPollTicket(t *testing.T) {
	useTestSecret(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/plugin/auth/state":
			io.WriteString(w, `{"code":0,"data":{"state":"st","authUrl":"https://www.codebuddy.cn/login?state=st"}}`)
		case "/v2/plugin/auth/token":
			io.WriteString(w, `{"code":0,"data":{"accessToken":"wb-access","refreshToken":"wb-refresh","expiresIn":3600}}`)
		case "/v2/plugin/login/account":
			io.WriteString(w, `{"code":0,"data":{"uid":"u1","enterpriseId":"e1"}}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	overrideWorkBuddyBase(t, server)

	s := NewDeviceBindService()
	start, err := s.Start(context.Background(), 7, 0, DeviceStartRequest{Vendor: "workbuddy", Realm: "cn"})
	if err != nil {
		t.Fatal(err)
	}
	if start.Vendor != "workbuddy" || start.Method != "workbuddy" || start.VerifyURL == "" || start.UserCode != "" {
		t.Fatalf("start %#v", start)
	}
	// 目标渠道不一致要拒绝。
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
	var applied DeviceTicket
	if err := s.WithTicket(7, out.Ticket, 0, func(tp DeviceTicket) error { applied = tp; return nil }); err != nil {
		t.Fatal(err)
	}
	cred, err := DecryptWorkBuddyCredential(applied.Encrypted)
	if err != nil || cred.AccessToken != "wb-access" || cred.Realm != "cn" || cred.UserID != "u1" || cred.EnterpriseID != "e1" {
		t.Fatalf("stored credential %#v %v", cred, err)
	}
	// 测试时两个 realm 的基址都被指到 mock 服务器，因此 base 由 mock 地址派生。
	base, err := DeviceChannelBase(applied)
	if err != nil || base != server.URL+"/v2" {
		t.Fatalf("base %q %v", base, err)
	}
}

// TestPreviewTicketKeepsTicketUsable 是「授权后自动拉模型」的关键回归：
//
// 拉模型用的是票据预览（只读），随后创建账号还得能消费同一张票据。
// 若预览顺手删掉了票据，一键登录后的保存就会失败，而且只在真实流程里才暴露。
func TestPreviewTicketKeepsTicketUsable(t *testing.T) {
	service := NewDeviceBindService()
	service.tickets["tkt"] = &DeviceTicket{Vendor: "kiro", Method: "kiro", Encrypted: "cipher", owner: 7, expires: time.Now().Add(time.Minute)}

	got, okTicket := service.PreviewTicket(7, "tkt")
	if !okTicket || got.Vendor != "kiro" || got.Encrypted != "cipher" {
		t.Fatalf("preview %+v ok=%v", got, okTicket)
	}
	// 预览是只读的：同张票据可以预览多次。
	if _, again := service.PreviewTicket(7, "tkt"); !again {
		t.Fatal("preview consumed the ticket")
	}
	// 别人预览不到。
	if _, foreign := service.PreviewTicket(8, "tkt"); foreign {
		t.Fatal("preview leaked across owners")
	}
	// 预览之后消费必须仍然成功。
	var applied int
	if err := service.WithTicket(7, "tkt", 13, func(DeviceTicket) error { applied++; return nil }); err != nil || applied != 1 {
		t.Fatalf("consume after preview: applied=%d err=%v", applied, err)
	}
	// 消费之后预览不到（票据已用掉）。
	if _, after := service.PreviewTicket(7, "tkt"); after {
		t.Fatal("consumed ticket still previewable")
	}
}

// TestPreviewTicketSkipsExpired 过期票据不能被预览拿去请求上游。
func TestPreviewTicketSkipsExpired(t *testing.T) {
	service := NewDeviceBindService()
	service.tickets["old"] = &DeviceTicket{Vendor: "grok", owner: 7, expires: time.Now().Add(-time.Second)}
	if _, okTicket := service.PreviewTicket(7, "old"); okTicket {
		t.Fatal("expired ticket previewed")
	}
}
